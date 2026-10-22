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
