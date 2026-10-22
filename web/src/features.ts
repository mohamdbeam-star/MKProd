// Computed features shared by the task views: custom field values, formulas, project health,
// resource capacity and the Gantt critical path. Mirrors Sources/MKProd/AdvancedFeatures.swift,
// so a formula or a capacity setting gives the same answer on the Mac and on the website.

import { FieldDef, ID, Resource, Space, Task, addDays, startOfDay } from './model';
import type { SyncEngine } from './sync';

// ---------------------------------------------------------------- custom fields

export const FIELD_TYPES: { value: string; label: string }[] = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'money', label: 'Money' },
  { value: 'dropdown', label: 'Dropdown' }, { value: 'checkbox', label: 'Checkbox' }, { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' }, { value: 'email', label: 'Email' }, { value: 'rating', label: 'Rating' },
  { value: 'people', label: 'People' }, { value: 'phone', label: 'Phone' }, { value: 'location', label: 'Location' },
  { value: 'progress', label: 'Progress (automatic)' }, { value: 'formula', label: 'Formula' },
];

/** Fields whose value is computed rather than typed in. */
export const isComputedField = (f: FieldDef) => f.type === 'formula' || f.type === 'progress';

/** Swift encodes `[UUID: String]` as a flat [key, value, …] array. */
export function customValue(t: Task, fieldId: ID): string | undefined {
  for (let i = 0; i + 1 < t.customValues.length; i += 2) if (t.customValues[i] === fieldId) return t.customValues[i + 1];
  return undefined;
}

export function setCustomValue(t: Task, fieldId: ID, value: string | undefined) {
  const out: string[] = [];
  for (let i = 0; i + 1 < t.customValues.length; i += 2) if (t.customValues[i] !== fieldId) out.push(t.customValues[i], t.customValues[i + 1]);
  if (value !== undefined && value !== '') out.push(fieldId, value);
  t.customValues = out;
}

export function spaceOf(engine: SyncEngine, t: Task): Space | undefined {
  return engine.get('spaces', engine.get('lists', t.listId)?.spaceId);
}

const closedKind = (engine: SyncEngine, t: Task) => {
  const k = spaceOf(engine, t)?.statuses.find((s) => s.id === t.statusId)?.kind;
  return k === 'done' || k === 'closed';
};

/** Share of the work done, 0…100: subtasks and checklist items together; a task with neither is 0 or 100. */
export function taskProgress(engine: SyncEngine, t: Task): number {
  const subs = engine.list('tasks').filter((x) => x.parentId === t.id && !x.archived);
  const items = t.checklists.flatMap((c) => c.items);
  const total = subs.length + items.length;
  if (!total) return closedKind(engine, t) ? 100 : 0;
  const done = subs.filter((s) => closedKind(engine, s)).length + items.filter((i) => i.done).length;
  return Math.round((done / total) * 100);
}

const DAY = 86400_000;
const dayNumber = (s?: string) => (s ? Math.round(startOfDay(new Date(s)).getTime() / DAY) : undefined);

/** The value a field shows: stored text, or the computed result for formula and progress fields. */
export function fieldDisplay(engine: SyncEngine, t: Task, f: FieldDef): string {
  if (f.type === 'progress') return `${taskProgress(engine, t)}%`;
  if (f.type === 'formula') {
    const r = evaluateFormula(f.options[0] ?? '', formulaScope(engine, t));
    return typeof r === 'number' ? fmtNumber(r) : r;
  }
  const v = customValue(t, f.id) ?? '';
  if (f.type === 'checkbox') return v === 'true' ? '✓' : '';
  if (f.type === 'people') return v.split(',').map((id) => engine.members.find((m) => m.id === id)?.name).filter(Boolean).join(', ');
  if (f.type === 'rating') return v ? '★'.repeat(Number(v) || 0) : '';
  if (f.type === 'date') return v ? new Date(v).toLocaleDateString() : '';
  return v;
}

export const fmtNumber = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

// ---------------------------------------------------------------- formulas

export type FormulaValue = number | string;

/** Names a formula can use in {braces}: the space's fields plus built-in task properties. */
export function formulaScope(engine: SyncEngine, t: Task, depth = 0): Map<string, () => FormulaValue> {
  const scope = new Map<string, () => FormulaValue>();
  const tracked = () => engine.list('timeEntries').filter((e) => e.taskId === t.id)
    .reduce((a, e) => a + ((e.end ? new Date(e.end).getTime() : Date.now()) - new Date(e.start).getTime()), 0) / 3600_000;
  const builtins: [string, () => FormulaValue][] = [
    ['estimate hours', () => (t.estimateMinutes ?? 0) / 60],
    ['points', () => t.points ?? 0],
    ['progress', () => taskProgress(engine, t)],
    ['tracked hours', tracked],
    ['priority', () => t.priority],
    ['subtasks', () => engine.list('tasks').filter((x) => x.parentId === t.id && !x.archived).length],
    ['start', () => dayNumber(t.startDate) ?? 0],
    ['due', () => dayNumber(t.dueDate) ?? 0],
    ['days left', () => (t.dueDate ? dayNumber(t.dueDate)! - dayNumber(new Date().toISOString())! : 0)],
    ['title', () => t.title],
  ];
  for (const [k, v] of builtins) scope.set(k, v);
  for (const f of spaceOf(engine, t)?.fields ?? []) {
    scope.set(f.name.trim().toLowerCase(), () => {
      if (f.type === 'formula') return depth > 5 ? 0 : evaluateFormula(f.options[0] ?? '', formulaScope(engine, t, depth + 1));
      if (f.type === 'progress') return taskProgress(engine, t);
      const v = customValue(t, f.id) ?? '';
      if (f.type === 'number' || f.type === 'money' || f.type === 'rating') return Number(v) || 0;
      if (f.type === 'checkbox') return v === 'true' ? 1 : 0;
      if (f.type === 'date') return dayNumber(v) ?? 0;
      return v;
    });
  }
  return scope;
}

/**
 * Evaluates a spreadsheet-style formula: numbers, "text", {Field name}, + - * / %, comparisons
 * (= != < > <= >=), & to join text, and IF, ROUND, MIN, MAX, SUM, AVG, ABS, TODAY.
 * Errors come back as a short "#…" string rather than throwing.
 */
export function evaluateFormula(src: string, scope: Map<string, () => FormulaValue>): FormulaValue {
  if (!src.trim()) return '';
  let i = 0;
  const err = (m: string): never => { throw new Error(m); };
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const peek = (s: string) => { ws(); return src.startsWith(s, i); };
  const eat = (s: string) => { if (peek(s)) { i += s.length; return true; } return false; };
  const num = (v: FormulaValue) => (typeof v === 'number' ? v : Number(v) || 0);

  const primary = (): FormulaValue => {
    ws();
    if (eat('(')) { const v = comparison(); if (!eat(')')) err('#PAREN'); return v; }
    if (eat('-')) return -num(primary());
    if (src[i] === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) err('#TEXT');
      const s = src.slice(i + 1, end); i = end + 1; return s;
    }
    if (src[i] === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) err('#REF');
      const name = src.slice(i + 1, end).trim().toLowerCase(); i = end + 1;
      const get = scope.get(name);
      if (!get) err(`#REF ${name}`);
      return get!();
    }
    const n = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (n) { i += n[0].length; return Number(n[0]); }
    const fn = /^[A-Za-z]+/.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const name = fn[0].toUpperCase();
      if (!eat('(')) err('#NAME');
      const args: FormulaValue[] = [];
      if (!eat(')')) { do args.push(comparison()); while (eat(',')); if (!eat(')')) err('#PAREN'); }
      const ns = args.map(num);
      switch (name) {
        case 'IF': return num(args[0]) !== 0 && args[0] !== '' ? (args[1] ?? '') : (args[2] ?? '');
        case 'ROUND': { const p = 10 ** (ns[1] ?? 0); return Math.round(ns[0] * p) / p; }
        case 'MIN': return ns.length ? Math.min(...ns) : 0;
        case 'MAX': return ns.length ? Math.max(...ns) : 0;
        case 'SUM': return ns.reduce((a, b) => a + b, 0);
        case 'AVG': return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
        case 'ABS': return Math.abs(ns[0] ?? 0);
        case 'TODAY': return Math.round(startOfDay().getTime() / DAY);
        default: return err('#NAME');
      }
    }
    return err('#SYNTAX');
  };
  const term = (): FormulaValue => {
    let v = primary();
    for (;;) {
      if (eat('*')) v = num(v) * num(primary());
      else if (eat('/')) { const d = num(primary()); v = d === 0 ? err('#DIV/0') : num(v) / d; }
      else if (eat('%')) { const d = num(primary()); v = d === 0 ? err('#DIV/0') : num(v) % d; }
      else return v;
    }
  };
  const sum = (): FormulaValue => {
    let v = term();
    for (;;) {
      if (eat('+')) v = num(v) + num(term());
      else if (eat('-')) v = num(v) - num(term());
      else if (eat('&')) v = `${typeof v === 'number' ? fmtNumber(v) : v}${(() => { const r = term(); return typeof r === 'number' ? fmtNumber(r) : r; })()}`;
      else return v;
    }
  };
  const comparison = (): FormulaValue => {
    const a = sum();
    const ops = ['<=', '>=', '!=', '=', '<', '>'];
    for (const op of ops) {
      if (eat(op)) {
        const b = sum();
        const [x, y] = typeof a === 'string' || typeof b === 'string' ? [String(a), String(b)] : [a, b];
        const r = op === '=' ? x === y : op === '!=' ? x !== y : op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
        return r ? 1 : 0;
      }
    }
    return a;
  };
  try {
    const v = comparison();
    ws();
    if (i < src.length) err('#SYNTAX');
    return typeof v === 'number' && !Number.isFinite(v) ? '#NUM' : v;
  } catch (e) {
    return (e as Error).message;
  }
}

// ---------------------------------------------------------------- portfolio

export type Health = 'done' | 'on track' | 'at risk' | 'off track' | 'not started';
export const HEALTH_COLORS: Record<Health, string> = { done: '#3DBE7A', 'on track': '#5B8DEF', 'at risk': '#F0A33A', 'off track': '#E5484D', 'not started': '#87909E' };

export interface ProjectSummary {
  listId: ID; name: string; spaceId: ID; total: number; done: number; overdue: number; progress: number
  start?: Date; end?: Date; expected: number; health: Health; owners: ID[]
}

/**
 * One row per list: progress against the time elapsed between its first start and last due date.
 * Behind schedule by 15+ points or anything overdue is "at risk"; 30+ points or past the end is "off track".
 */
export function projectSummary(engine: SyncEngine, listId: ID): ProjectSummary {
  const list = engine.get('lists', listId)!;
  const tasks = engine.list('tasks').filter((t) => t.listId === listId && !t.archived && !t.parentId);
  const done = tasks.filter((t) => closedKind(engine, t)).length;
  const today = startOfDay();
  const overdue = tasks.filter((t) => t.dueDate && new Date(t.dueDate) < today && !closedKind(engine, t)).length;
  const starts = tasks.map((t) => t.startDate ?? t.dueDate).filter(Boolean).map((d) => new Date(d!).getTime());
  const ends = tasks.map((t) => t.dueDate ?? t.startDate).filter(Boolean).map((d) => new Date(d!).getTime());
  const start = list.sprintStart ? new Date(list.sprintStart) : starts.length ? new Date(Math.min(...starts)) : undefined;
  const end = list.sprintEnd ? new Date(list.sprintEnd) : ends.length ? new Date(Math.max(...ends)) : undefined;
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const expected = start && end ? Math.max(0, Math.min(100, Math.round(((today.getTime() - start.getTime()) / Math.max(end.getTime() - start.getTime(), DAY)) * 100))) : 0;
  const gap = expected - progress;
  const health: Health = tasks.length && done === tasks.length ? 'done'
    : !tasks.length || (progress === 0 && expected === 0) ? 'not started'
    : (end && end < today) || gap >= 30 ? 'off track'
    : gap >= 15 || overdue > 0 ? 'at risk' : 'on track';
  const counts = new Map<ID, number>();
  for (const t of tasks) for (const a of t.assigneeIds) counts.set(a, (counts.get(a) ?? 0) + 1);
  const owners = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
  return { listId, name: list.name, spaceId: list.spaceId, total: tasks.length, done, overdue, progress, start, end, expected, health, owners };
}

// ---------------------------------------------------------------- resource management

export const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];

export function resourceFor(engine: SyncEngine, memberId: ID): Resource {
  return engine.get('resources', memberId) ?? { id: memberId, hoursPerDay: 8, workDays: DEFAULT_WORK_DAYS, timeOff: [] };
}

export function isWorkingDay(r: Resource, day: Date) {
  if (!r.workDays.includes(day.getDay())) return false;
  const t = startOfDay(day).getTime();
  return !r.timeOff.some((o) => t >= startOfDay(new Date(o.start)).getTime() && t <= startOfDay(new Date(o.end)).getTime());
}

/** Hours of open, estimated work a person has on a day: each estimate spread over the working days from start to due. */
export function allocatedHours(engine: SyncEngine, r: Resource, day: Date, tasks: Task[]): { hours: number; tasks: Task[] } {
  if (!isWorkingDay(r, day)) return { hours: 0, tasks: [] };
  let hours = 0; const hit: Task[] = [];
  const d = startOfDay(day).getTime();
  for (const t of tasks) {
    if (!t.assigneeIds.includes(r.id) || !t.dueDate || closedKind(engine, t)) continue;
    const s = startOfDay(new Date(t.startDate ?? t.dueDate)), e = startOfDay(new Date(t.dueDate));
    if (d < s.getTime() || d > e.getTime()) continue;
    let working = 0;
    for (let x = s; x <= e; x = addDays(x, 1)) if (isWorkingDay(r, x)) working++;
    hours += (t.estimateMinutes ?? 60) / 60 / Math.max(working, 1) / Math.max(t.assigneeIds.length, 1);
    hit.push(t);
  }
  return { hours, tasks: hit };
}

// ---------------------------------------------------------------- Gantt critical path

/**
 * Longest chain of dependent tasks (by `blockedBy`), measured in days from the earliest start to
 * the latest due date. Returns the ids on that chain; any delay to them delays the whole set.
 */
export function criticalPath(tasks: Task[]): Set<ID> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const len = (t: Task) => {
    const s = t.startDate ?? t.dueDate, e = t.dueDate ?? t.startDate;
    return s && e ? Math.max(1, Math.round((startOfDay(new Date(e)).getTime() - startOfDay(new Date(s)).getTime()) / DAY) + 1) : 1;
  };
  const memo = new Map<ID, { total: number; prev?: ID }>();
  const visiting = new Set<ID>();
  const best = (t: Task): { total: number; prev?: ID } => {
    const hit = memo.get(t.id);
    if (hit) return hit;
    if (visiting.has(t.id)) return { total: 0 }; // dependency cycle: stop here
    visiting.add(t.id);
    let r: { total: number; prev?: ID } = { total: len(t) };
    for (const p of t.blockedBy) {
      const pt = byId.get(p);
      if (!pt) continue;
      const b = best(pt);
      if (b.total + len(t) > r.total) r = { total: b.total + len(t), prev: p };
    }
    visiting.delete(t.id);
    memo.set(t.id, r);
    return r;
  };
  let end: Task | undefined; let top = 0;
  for (const t of tasks) { const b = best(t); if (b.prev && b.total > top) { top = b.total; end = t; } }
  const out = new Set<ID>();
  for (let cur: ID | undefined = end?.id; cur; cur = memo.get(cur)?.prev) out.add(cur);
  return out;
}
