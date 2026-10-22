// Email notices for teammates, composed from this browser's own edits (the server can't read
// encrypted data, so the client that made a change describes it). The Worker applies each
// recipient's preferences, de-duplicates by `dedupe` and sends. Mirrors EmailNotices.swift.
import type { Contract, ID, Order, Task } from './model';
import { addDays, priorityOf, startOfDay } from './model';
import type { SyncEngine } from './sync';

export interface Notice { to: ID; type: string; subject: string; lines: string[]; generic: string; dedupe: string }

const UPDATE_WINDOW = 15 * 60_000;
const CONTRACT_THRESHOLDS = [60, 30, 14, 7, 1];
const bucket = () => Math.floor(Date.now() / UPDATE_WINDOW);
const day = (s?: string) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const firstName = (n: string) => n.split(' ')[0] ?? n;

export function taskNotices(e: SyncEngine, before: Task | undefined, t: Task): Notice[] {
  if (t.trashedAt) return [];
  const me = e.me;
  const actor = e.session.user.name || e.session.user.email;
  const list = e.get('lists', t.listId);
  const place = list?.name ?? 'a list';
  const out: Notice[] = [];

  const added = t.assigneeIds.filter((a) => a !== me && !(before?.assigneeIds ?? []).includes(a));
  for (const a of added) {
    const lines = [`${actor} assigned you "${t.title}" in ${place}.`];
    if (t.dueDate) lines.push(`Due ${day(t.dueDate)}.`);
    if (t.priority) lines.push(`Priority: ${priorityOf(t.priority).label}.`);
    if (t.details) lines.push(t.details.slice(0, 300));
    out.push({ to: a, type: 'taskAssigned', subject: `You were assigned: ${t.title}`, lines, generic: 'A task was assigned to you.', dedupe: `${t.id}:${a}:${bucket()}` });
  }

  const old = new Set(before?.comments.map((c) => c.id) ?? []);
  const fresh = t.comments.filter((c) => !old.has(c.id) && c.authorId === me);
  const mentioned = new Set<ID>();
  for (const c of fresh) {
    for (const m of e.members) {
      if (m.id === me) continue;
      const f = firstName(m.name);
      if (!(c.assigneeId === m.id || (f && c.text.toLowerCase().includes('@' + f.toLowerCase())))) continue;
      mentioned.add(m.id);
      out.push({ to: m.id, type: 'mentions', subject: `${actor} mentioned you on ${t.title}`, lines: [`${actor} wrote on "${t.title}":`, c.text.slice(0, 500)],
        generic: 'Someone mentioned you on a task.', dedupe: `comment:${c.id}:${m.id}` });
    }
  }

  if (!before) return out;
  const changes: string[] = [];
  if (before.title !== t.title) changes.push(`Renamed from "${before.title}".`);
  if (before.statusId !== t.statusId) {
    const space = e.get('spaces', list?.spaceId);
    changes.push(`Status: ${space?.statuses.find((s) => s.id === t.statusId)?.name ?? 'changed'}.`);
  }
  if (before.dueDate !== t.dueDate) changes.push(`Due date: ${t.dueDate ? day(t.dueDate) : 'removed'}.`);
  if (before.priority !== t.priority) changes.push(`Priority: ${priorityOf(t.priority).label}.`);
  if (before.details !== t.details) changes.push('Description edited.');
  if (JSON.stringify(before.checklists) !== JSON.stringify(t.checklists)) changes.push('Checklist updated.');
  if (fresh.length) changes.push(`New comment: ${fresh[fresh.length - 1].text.slice(0, 300)}`);
  if (before.attachments.length !== t.attachments.length) changes.push('Attachments changed.');
  if (!added.length && [...before.assigneeIds].sort().join() !== [...t.assigneeIds].sort().join()) changes.push('Assignees changed.');
  if (!changes.length) return out;
  const followers = new Set([...t.assigneeIds, ...t.watcherIds]);
  for (const f of followers) {
    if (f === me || added.includes(f) || mentioned.has(f)) continue;
    out.push({ to: f, type: 'taskUpdated', subject: `Updated: ${t.title}`, lines: [`${actor} updated "${t.title}" in ${place}:`, ...changes],
      generic: 'A task you follow was updated.', dedupe: `${t.id}:${bucket()}` });
  }
  return out;
}

export function orderNotices(e: SyncEngine, before: Order | undefined, o: Order, canApprove: (o: Order, member: ID) => boolean): Notice[] {
  if (before?.status === o.status) return [];
  const entity = e.get('entities', o.entityId)?.name ?? 'an entity';
  const out: Notice[] = [];
  for (const m of e.members) {
    if (m.id === e.me || !canApprove(o, m.id)) continue;
    out.push({ to: m.id, type: 'approvals', subject: `Approval needed: #${o.number} ${o.title}`,
      lines: [`Order #${o.number} "${o.title}" for ${entity} is waiting for your approval.`, `Status: ${o.status}.`],
      generic: 'An order is waiting for your approval.', dedupe: `order:${o.id}:${o.status}:${m.id}` });
  }
  if (before && o.requestedBy !== e.me) {
    out.push({ to: o.requestedBy, type: 'approvals', subject: `Order #${o.number} is now ${o.status}`,
      lines: [`Your order #${o.number} "${o.title}" for ${entity} is now ${o.status}.`],
      generic: 'One of your orders changed status.', dedupe: `order:${o.id}:${o.status}:requester` });
  }
  return out;
}

/** Reminders to the people assigned to a contract's entity (admins when it has none). */
export function contractNotices(e: SyncEngine, today = new Date()): Notice[] {
  const admins = e.team.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.id);
  const out: Notice[] = [];
  for (const c of e.list('contracts') as Contract[]) {
    if (c.terminated) continue;
    const end = startOfDay(new Date(c.endDate));
    const days = Math.round((end.getTime() - startOfDay(today).getTime()) / 86400_000);
    const threshold = [...CONTRACT_THRESHOLDS].reverse().find((t) => days <= t);
    if (days < 0 || threshold === undefined || end > addDays(today, 61)) continue;
    const entity = c.entityId ? e.get('entities', c.entityId) : undefined;
    const people = entity ? [...new Set(entity.roles.map((r) => r.memberId))] : admins;
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    const lines = [`The contract "${c.title}" with ${c.supplier}${entity ? ` (${entity.name})` : ''} ends ${when}, on ${day(c.endDate)}.`];
    if (c.autoRenew) lines.push('It is set to renew automatically.');
    if (c.value > 0) lines.push(`Value: ${c.value.toLocaleString()}`);
    const contact = [c.contact, c.email, c.phone].filter(Boolean).join(' · ');
    if (contact) lines.push(`Supplier contact: ${contact}`);
    const ymd = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    for (const p of people) {
      if (!e.members.some((m) => m.id === p)) continue;
      out.push({ to: p, type: 'contractExpiring', subject: `Contract ending ${when}: ${c.title}`, lines,
        generic: 'A contract for your entity is ending soon.', dedupe: `contract:${c.id}:${ymd}:${threshold}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- weekly digest

/** ISO week label, e.g. "2026-W43"; used for de-duplication so each person gets one digest per week. */
export function isoWeek(d = new Date()): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((x.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * One summary per member: approvals waiting for them, overdue and due-this-week tasks, their
 * orders in progress, contracts ending within 30 days. Any client can compose it for everyone
 * (the data is the same everywhere); the server sends each person's copy once per week.
 */
export function digestNotices(e: SyncEngine, canApprove: (o: Order, member: ID) => boolean, today = new Date()): Notice[] {
  const week = isoWeek(today);
  const start = startOfDay(today);
  const weekEnd = addDays(start, 7);
  const out: Notice[] = [];
  const tasks = (e.list('tasks') as Task[]).filter((t) => !t.archived && !t.trashedAt && !t.completedAt);
  const orders = e.list('orders') as Order[];
  const contracts = (e.list('contracts') as Contract[]).filter((c) => !c.terminated);
  const admins = e.team.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.id);
  for (const m of e.members) {
    const lines: string[] = [];
    const approvals = orders.filter((o) => o.status.startsWith('Pending') && canApprove(o, m.id));
    if (approvals.length) {
      lines.push(`⏳ ${approvals.length} order(s) waiting for your approval:`);
      approvals.slice(0, 8).forEach((o) => lines.push(`   • #${o.number} ${o.title} — ${o.supplier || 'no supplier'} — ${o.currency} ${o.items.reduce((a, i) => a + i.qty * i.unitPrice, 0).toLocaleString()}`));
    }
    const mine = tasks.filter((t) => t.assigneeIds.includes(m.id) && t.dueDate);
    const overdue = mine.filter((t) => new Date(t.dueDate!) < start);
    const dueSoon = mine.filter((t) => { const d = new Date(t.dueDate!); return d >= start && d < weekEnd; });
    if (overdue.length) {
      lines.push(`🔴 ${overdue.length} overdue task(s):`);
      overdue.slice(0, 8).forEach((t) => lines.push(`   • ${t.title} (due ${day(t.dueDate)})`));
    }
    if (dueSoon.length) {
      lines.push(`📅 ${dueSoon.length} task(s) due this week:`);
      dueSoon.slice(0, 8).forEach((t) => lines.push(`   • ${t.title} (${day(t.dueDate)})`));
    }
    const inProgress = orders.filter((o) => o.requestedBy === m.id && ['Approved', 'Ordered', 'Shipped'].includes(o.status));
    if (inProgress.length) {
      lines.push(`📦 ${inProgress.length} of your orders in progress:`);
      inProgress.slice(0, 6).forEach((o) => lines.push(`   • #${o.number} ${o.title} — ${o.status}${o.expectedDelivery ? `, expected ${day(o.expectedDelivery)}` : ''}`));
    }
    const ending = contracts.filter((c) => {
      const d = new Date(c.endDate);
      if (d < start || d > addDays(start, 30)) return false;
      const entity = c.entityId ? e.get('entities', c.entityId) : undefined;
      return entity ? entity.roles.some((r) => r.memberId === m.id) : admins.includes(m.id);
    });
    if (ending.length) {
      lines.push(`📄 ${ending.length} contract(s) ending within 30 days:`);
      ending.slice(0, 6).forEach((c) => lines.push(`   • ${c.title} with ${c.supplier} — ends ${day(c.endDate)}`));
    }
    if (!lines.length) continue;
    out.push({ to: m.id, type: 'weeklyDigest', subject: `Your week ahead · ${approvals.length} approval(s), ${overdue.length + dueSoon.length} task(s)`, lines,
      generic: 'Your weekly MK Prod summary is ready; open the app to see it.', dedupe: `digest:${week}:${m.id}` });
  }
  return out;
}
