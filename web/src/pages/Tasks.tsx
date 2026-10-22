import { useMemo, useState } from 'react';
import { ID, Task, addDays, fmtDate, fromInputDate, iso, newTask, startOfDay, toInputDate, uid, PRIORITIES } from '../model';
import { Avatar, Avatars, Empty, Flag, Markdown, PrioritySelect, Seg, StatusPill, Tag, isClosed, member, statusOf, useApp } from '../ui';
import type { SyncEngine } from '../sync';
import { Attachments } from './Procurement';

// ---------------------------------------------------------------- task helpers (mirror Store.swift)

export function statusesFor(engine: SyncEngine, t: Task) {
  return engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.statuses ?? [];
}

export function updateTask(engine: SyncEngine, id: ID, fn: (t: Task) => void) {
  const before = engine.get('tasks', id);
  if (!before) return;
  const me = member(engine, engine.me)?.name ?? 'Someone';
  engine.update('tasks', id, (t) => {
    fn(t);
    const log = (text: string) => t.activity.push({ id: uid(), date: iso(), text });
    if (t.statusId !== before.statusId) {
      const st = statusesFor(engine, t).find((s) => s.id === t.statusId);
      log(`${me} changed status to ${st?.name ?? '?'}`);
      const closed = st?.kind === 'done' || st?.kind === 'closed';
      if (closed) t.completedAt = iso(); else delete t.completedAt;
      if (closed && t.recurrence !== 'none') spawnRecurrence(engine, t);
    }
    if (t.priority !== before.priority) log(`${me} set priority to ${PRIORITIES.find((p) => p.value === t.priority)?.label}`);
    for (const a of t.assigneeIds) if (!before.assigneeIds.includes(a)) log(`${me} assigned ${member(engine, a)?.name ?? 'someone'}`);
    if (t.dueDate !== before.dueDate) log(t.dueDate ? `${me} set due date to ${new Date(t.dueDate).toLocaleDateString()}` : `${me} removed the due date`);
    if (t.listId !== before.listId) log(`${me} moved this task to ${engine.get('lists', t.listId)?.name ?? '?'}`);
  });
}

function spawnRecurrence(engine: SyncEngine, t: Task) {
  const step = (d?: string) => {
    if (!d) return undefined;
    const x = new Date(d);
    if (t.recurrence === 'daily') x.setDate(x.getDate() + 1);
    if (t.recurrence === 'weekly') x.setDate(x.getDate() + 7);
    if (t.recurrence === 'monthly') x.setMonth(x.getMonth() + 1);
    if (t.recurrence === 'yearly') x.setFullYear(x.getFullYear() + 1);
    return iso(x);
  };
  const n: Task = structuredClone(t);
  n.id = uid();
  n.statusId = statusesFor(engine, t)[0]?.id ?? t.statusId;
  n.dueDate = step(t.dueDate);
  n.startDate = step(t.startDate);
  delete n.completedAt;
  n.comments = [];
  n.created = iso();
  n.checklists = t.checklists.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, done: false })) }));
  n.activity = [{ id: uid(), date: iso(), text: 'Created from recurring task' }];
  if (!n.dueDate) delete n.dueDate;
  if (!n.startDate) delete n.startDate;
  engine.put('tasks', n);
}

export function toggleDone(engine: SyncEngine, t: Task) {
  const st = statusesFor(engine, t);
  const target = isClosed(engine, t) ? st[0] : st.find((s) => s.kind === 'done');
  if (target) updateTask(engine, t.id, (x) => { x.statusId = target.id; });
}

/** Removes a list with every task in it (mirrors Store.deleteList on the Mac). */
export function deleteList(engine: SyncEngine, id: ID) {
  for (const t of engine.list('tasks').filter((t) => t.listId === id)) engine.remove('tasks', t.id);
  engine.remove('lists', id);
}

export function deleteFolder(engine: SyncEngine, id: ID) {
  for (const l of engine.list('lists').filter((l) => l.folderId === id)) deleteList(engine, l.id);
  engine.remove('folders', id);
}

export function deleteSpace(engine: SyncEngine, id: ID) {
  for (const l of engine.list('lists').filter((l) => l.spaceId === id)) deleteList(engine, l.id);
  for (const f of engine.list('folders').filter((f) => f.spaceId === id)) engine.remove('folders', f.id);
  engine.remove('spaces', id);
}

export function trashTask(engine: SyncEngine, id: ID) {
  const now = iso();
  for (const c of engine.list('tasks').filter((x) => x.parentId === id)) trashTask(engine, c.id);
  engine.update('tasks', id, (t) => { t.archived = true; t.trashedAt = now; });
}

const isOverdue = (engine: SyncEngine, t: Task) => !!t.dueDate && new Date(t.dueDate) < startOfDay() && !isClosed(engine, t);

// ---------------------------------------------------------------- Home

export function HomePage() {
  const { engine, openTask, go, fin } = useApp();
  const mine = engine.list('tasks').filter((t) => !t.archived && t.assigneeIds.includes(engine.me) && !isClosed(engine, t));
  const today = startOfDay();
  const buckets: [string, Task[]][] = [
    ['Overdue', mine.filter((t) => isOverdue(engine, t))],
    ['Today', mine.filter((t) => t.dueDate && startOfDay(new Date(t.dueDate)).getTime() === today.getTime())],
    ['Next', mine.filter((t) => t.dueDate && new Date(t.dueDate) >= addDays(today, 1)).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))],
    ['Unscheduled', mine.filter((t) => !t.dueDate)],
  ];
  const approvals = engine.list('orders').filter((o) => fin.canApprove(o));
  const name = member(engine, engine.me)?.name.split(' ')[0] ?? '';
  const h = new Date().getHours();
  return (
    <div className="col" style={{ gap: 16 }}>
      <div><h1>{h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, {name}</h1><div className="muted">{new Date().toLocaleDateString(undefined, { dateStyle: 'full' })}</div></div>
      <div className="grid g4">
        <Stat label="Overdue" n={buckets[0][1].length} color="var(--red)" />
        <Stat label="Due today" n={buckets[1][1].length} color="var(--orange)" />
        <Stat label="Assigned to me" n={mine.length} color="var(--blue)" />
        <Stat label="Approvals waiting" n={approvals.length} color="var(--accent)" onClick={() => go('approvals')} />
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>My work</h3>
          {mine.length === 0 && <p className="muted">Nothing assigned to you 🎉</p>}
          {buckets.map(([label, ts]) => ts.length > 0 && (
            <div key={label}>
              <div className="small" style={{ fontWeight: 700, marginTop: 10, color: label === 'Overdue' ? 'var(--red)' : 'var(--muted)' }}>{label.toUpperCase()}</div>
              {ts.slice(0, 6).map((t) => <MiniRow key={t.id} t={t} onClick={() => openTask(t.id)} />)}
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Recently updated</h3>
          {engine.list('tasks').filter((t) => !t.archived).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 10).map((t) => <MiniRow key={t.id} t={t} onClick={() => openTask(t.id)} />)}
        </div>
        <RemindersCard />
      </div>
    </div>
  );
}

/** Personal reminders: synced to every device of the person, encrypted with their own key. */
function RemindersCard() {
  const { engine, openTask } = useApp();
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(() => { const d = new Date(Date.now() + 3600_000); d.setMinutes(0, 0, 0); return toLocalInput(d); });
  const [showDone, setShowDone] = useState(false);
  const items = engine.reminders.filter((r) => showDone || !r.done);
  const add = () => {
    if (!title.trim() || !when) return;
    engine.addReminder(title.trim(), iso(new Date(when)));
    setTitle('');
  };
  return (
    <div className="card col">
      <div className="row"><h3 className="grow">⏰ Reminders</h3><label className="row small muted"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show done</label></div>
      {items.length === 0 && <p className="muted small">No reminders. They pop up in your Inbox and on your desktop at the chosen time, on whichever device you're using.</p>}
      {items.map((r) => (
        <div key={r.id} className="row" style={{ padding: '3px 0' }}>
          <input type="checkbox" checked={r.done} onChange={() => engine.update('reminders', r.id, (x) => { x.done = !x.done; })} />
          <span className="grow" style={{ textDecoration: r.done ? 'line-through' : undefined, cursor: r.taskId ? 'pointer' : undefined }} onClick={() => r.taskId && openTask(r.taskId)}>{r.title}</span>
          <span className={`small ${!r.done && new Date(r.date) < new Date() ? 'red' : 'muted'}`}>{new Date(r.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
          <button className="btn ghost sm" onClick={() => engine.remove('reminders', r.id)}>✕</button>
        </div>
      ))}
      <div className="row wrap">
        <input className="input grow" placeholder="Remind me to…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <button className="btn primary" disabled={!title.trim() || !when} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Stat({ label, n, color, onClick }: { label: string; n: number; color: string; onClick?: () => void }) {
  return (
    <div className="kpi" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, cursor: onClick ? 'pointer' : undefined }} onClick={onClick}>
      <div><div className="v" style={{ fontSize: 24 }}>{n}</div><div className="l">{label}</div></div>
    </div>
  );
}

function MiniRow({ t, onClick }: { t: Task; onClick: () => void }) {
  const { engine } = useApp();
  return (
    <div className="row" style={{ padding: '5px 0', cursor: 'pointer' }} onClick={onClick}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: statusOf(engine, t)?.colorHex ?? '#888' }} />
      <span className="grow ellipsis">{t.title}</span>
      <Flag p={t.priority} />
      <span className={`small ${isOverdue(engine, t) ? 'red' : 'muted'}`}>{fmtDate(t.dueDate)}</span>
    </div>
  );
}

// ---------------------------------------------------------------- Inbox

export function InboxPage() {
  const { engine, openTask, go } = useApp();
  return (
    <div className="card">
      <div className="row"><h2 className="grow">Inbox</h2><button className="btn" onClick={() => engine.markInboxRead()}>Mark all read</button><button className="btn" onClick={() => confirm('Clear all inbox items?') && engine.clearInbox()}>Clear all</button></div>
      <p className="small muted">Synced to all your devices, and private to you: encrypted with your own key, not the workspace key.</p>
      {engine.inbox.length === 0 && <Empty icon="📭" title="Inbox zero" sub="Assignments, mentions, approvals and reminders appear here." />}
      {engine.inbox.map((n) => (
        <div key={n.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer', fontWeight: n.read ? 400 : 600 }}
          onClick={() => {
            engine.markInboxRead(n.id);
            const target = n.target ?? (n.taskId ? `task:${n.taskId}` : undefined);
            if (target?.startsWith('task:')) openTask(target.slice(5));
            else if (target?.startsWith('order:')) go('orders/' + target.slice(6));
            else if (target?.startsWith('chat:')) go('chat/' + target.slice(5));
          }}>
          {!n.read && <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent)' }} />}
          <span className="grow">{n.text}</span>
          <span className="small muted">{new Date(n.date).toLocaleString()}</span>
          <button className="btn ghost sm" title="Clear" onClick={(e) => { e.stopPropagation(); engine.clearInbox(n.id); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- task container

type View = 'list' | 'board' | 'calendar' | 'table' | 'gantt' | 'workload' | 'mindmap' | 'form';
type Scope = { kind: 'everything' } | { kind: 'mine' } | { kind: 'space' | 'folder' | 'list'; id: ID };

export function TasksPage({ scope }: { scope: Scope }) {
  const { engine, openTask } = useApp();
  const [view, setView] = useState<View>(() => (localStorage.getItem('view') as View) || 'list');
  const [search, setSearch] = useState('');
  const [assignee, setAssignee] = useState('');
  const [showClosed, setShowClosed] = useState(true);
  const [quick, setQuick] = useState('');
  const setV = (v: View) => { setView(v); localStorage.setItem('view', v); };

  const listIds = useMemo(() => {
    const lists = engine.list('lists').filter((l) => !l.archived);
    if (scope.kind === 'list') return [scope.id];
    if (scope.kind === 'folder') return lists.filter((l) => l.folderId === scope.id).map((l) => l.id);
    if (scope.kind === 'space') return lists.filter((l) => l.spaceId === scope.id).map((l) => l.id);
    return lists.map((l) => l.id);
  }, [engine.version, scope]);

  // "My Tasks" includes subtasks assigned to you; the other views show top-level tasks (subtasks live inside their parent).
  let tasks = engine.list('tasks').filter((t) => !t.archived && (scope.kind === 'mine' || !t.parentId) && listIds.includes(t.listId));
  if (scope.kind === 'mine') tasks = tasks.filter((t) => t.assigneeIds.includes(engine.me));
  if (search) tasks = tasks.filter((t) => (t.title + ' ' + t.tags.join(' ')).toLowerCase().includes(search.toLowerCase()));
  if (assignee) tasks = tasks.filter((t) => t.assigneeIds.includes(assignee));
  if (!showClosed) tasks = tasks.filter((t) => !isClosed(engine, t));
  tasks.sort((a, b) => a.order - b.order);

  const defaultList = listIds[0];
  const addQuick = () => {
    const title = quick.trim();
    if (!title || !defaultList) return;
    const list = engine.get('lists', defaultList)!;
    const st = engine.get('spaces', list.spaceId)?.statuses[0];
    if (!st) return;
    const t = newTask(defaultList, title, st.id, member(engine, engine.me));
    if (scope.kind === 'mine') t.assigneeIds = [engine.me];
    engine.put('tasks', t);
    setQuick('');
  };

  // Group by status name so multi-space views still line up.
  const spaces = scope.kind === 'list' || scope.kind === 'folder' || scope.kind === 'space'
    ? [engine.get('spaces', engine.get('lists', listIds[0])?.spaceId ?? (scope.kind === 'space' ? scope.id : ''))].filter(Boolean)
    : engine.list('spaces');
  const statusNames: { name: string; color: string; ids: ID[] }[] = [];
  for (const s of spaces.flatMap((x) => x!.statuses)) {
    const g = statusNames.find((x) => x.name === s.name);
    if (g) g.ids.push(s.id); else statusNames.push({ name: s.name, color: s.colorHex, ids: [s.id] });
  }
  const groups = statusNames.map((g) => ({ ...g, tasks: tasks.filter((t) => g.ids.includes(t.statusId)) }))
    .filter((g) => g.tasks.length || spaces.length === 1);

  return (
    <div>
      <div className="toolbar">
        <Seg value={view} onChange={setV} options={[{ value: 'list', label: '☰ List' }, { value: 'board', label: '▦ Board' }, { value: 'calendar', label: '📅 Calendar' }, { value: 'table', label: '▤ Table' }, { value: 'gantt', label: '▬ Gantt' }, { value: 'workload', label: '👥 Workload' }, { value: 'mindmap', label: '🧠 Mind Map' }, { value: 'form', label: '📋 Form' }]} />
        <input className="input" placeholder="+ Add a task and press Enter" value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addQuick()} style={{ width: 260 }} disabled={!defaultList} />
        <span className="right" />
        <input className="input" placeholder="Filter" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 140 }} />
        <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Anyone</option>
          {engine.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <label className="row small"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed</label>
      </div>
      {!defaultList && <Empty icon="📋" title="No lists yet" sub="Create a space and a list from the sidebar." />}
      {defaultList && view === 'list' && <ListView groups={groups} onOpen={openTask} />}
      {defaultList && view === 'board' && <BoardView groups={groups} onOpen={openTask} />}
      {defaultList && view === 'calendar' && <CalendarView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'table' && <TableView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'gantt' && <GanttView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'workload' && <WorkloadView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'mindmap' && <MindMapView title={scopeTitle(engine, scope)} tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'form' && <FormView defaultList={defaultList} lists={listIds} />}
    </div>
  );
}

type Group = { name: string; color: string; ids: ID[]; tasks: Task[] };

function scopeTitle(engine: SyncEngine, scope: Scope) {
  if (scope.kind === 'mine') return 'My Tasks';
  if (scope.kind === 'everything') return 'Everything';
  const o = scope.kind === 'list' ? engine.get('lists', scope.id) : scope.kind === 'folder' ? engine.get('folders', scope.id) : engine.get('spaces', scope.id);
  return o?.name ?? 'Tasks';
}

// ---------------------------------------------------------------- workload (mirrors WorkloadView.swift)

/** Hours of estimated work per person per day, spreading each estimate across its start→due range. */
function WorkloadView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [start, setStart] = useState(() => startOfDay());
  const [capacity, setCapacity] = useState(8);
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
  const load = (memberId: ID, day: Date) => {
    let hours = 0; const list: Task[] = [];
    for (const t of tasks) {
      if (!t.assigneeIds.includes(memberId) || isClosed(engine, t) || !t.dueDate) continue;
      const due = startOfDay(new Date(t.dueDate)); const s = startOfDay(new Date(t.startDate ?? t.dueDate));
      if (day < s || day > due) continue;
      const span = Math.max(Math.round((due.getTime() - s.getTime()) / 86400_000) + 1, 1);
      hours += (t.estimateMinutes ?? 60) / 60 / span; list.push(t);
    }
    return { hours, list };
  };
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
        <button className="btn sm" onClick={() => setStart(addDays(start, -7))}>‹</button>
        <button className="btn sm" onClick={() => setStart(startOfDay())}>This week</button>
        <button className="btn sm" onClick={() => setStart(addDays(start, 7))}>›</button>
        <span className="grow" />
        <span className="small muted">Capacity per day</span>
        <input className="input" type="number" min={1} max={16} value={capacity} onChange={(e) => setCapacity(Math.max(1, Number(e.target.value) || 8))} style={{ width: 64 }} />
        <span className="small muted">h</span>
      </div>
      <div style={{ overflow: 'auto' }}>
        <table className="t" style={{ minWidth: 160 + days.length * 66 }}>
          <thead><tr><th style={{ minWidth: 160 }}>Member</th>{days.map((d) => <th key={d.toISOString()} style={{ textAlign: 'center', width: 64 }}>{d.toLocaleDateString(undefined, { weekday: 'short' })}<br />{d.getDate()}</th>)}</tr></thead>
          <tbody>{engine.members.map((m) => (
            <tr key={m.id}><td><span className="row"><Avatar m={m} size={20} />{m.name}</span></td>
              {days.map((d) => {
                const { hours, list } = load(m.id, d);
                const r = hours / capacity;
                const bg = r > 1 ? 'var(--red)' : r > 0.7 ? 'var(--orange)' : r > 0 ? 'var(--green)' : 'transparent';
                return <td key={d.toISOString()} title={list.map((t) => t.title).join('\n')} onClick={() => list[0] && onOpen(list[0].id)} style={{ textAlign: 'center', cursor: list.length ? 'pointer' : undefined, background: `color-mix(in srgb, ${bg} 22%, transparent)` }}>
                  {hours > 0 && <div className="small" style={{ fontWeight: 700 }}>{hours.toFixed(1)}h</div>}{list.length > 0 && <div style={{ fontSize: 10 }} className="muted">{list.length} task{list.length === 1 ? '' : 's'}</div>}
                </td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- mind map (mirrors MindMapView.swift)

function MindMapView({ title, tasks, onOpen }: { title: string; tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const Branch = ({ t }: { t: Task }) => {
    const subs = engine.list('tasks').filter((x) => x.parentId === t.id && !x.archived);
    const c = statusOf(engine, t)?.colorHex ?? '#87909E';
    return (
      <div className="mm-branch">
        <span className="mm-node" style={{ borderColor: c, background: c + '26' }} onClick={() => onOpen(t.id)}>{t.title}</span>
        {subs.length > 0 && <div className="mm-children">{subs.map((s) => <Branch key={s.id} t={s} />)}</div>}
      </div>
    );
  };
  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <div className="mm-root">
        <span className="mm-node mm-title">{title}</span>
        <div className="mm-children">{tasks.map((t) => <Branch key={t.id} t={t} />)}{!tasks.length && <span className="muted small">No tasks</span>}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- form (mirrors TaskFormView.swift)

/** Request form: submissions become tasks in the chosen list, the same as in the Mac app. */
function FormView({ defaultList, lists }: { defaultList: ID; lists: ID[] }) {
  const { engine, toast } = useApp();
  const [f, setF] = useState({ listId: defaultList, title: '', email: '', priority: 2, due: '', details: '' });
  const options = engine.list('lists').filter((l) => !l.archived && lists.includes(l.id));
  const submit = () => {
    const list = engine.get('lists', f.listId); const st = engine.get('spaces', list?.spaceId ?? '')?.statuses[0];
    if (!list || !st || !f.title.trim()) return;
    const t = newTask(f.listId, f.title.trim(), st.id, member(engine, engine.me));
    t.details = f.details.trim(); t.priority = f.priority;
    if (f.due) t.dueDate = fromInputDate(f.due);
    t.activity.push({ id: uid(), date: iso(), text: `Submitted via form${f.email ? ` by ${f.email}` : ''}` });
    engine.put('tasks', t);
    setF({ ...f, title: '', details: '', due: '' });
    toast('Submitted: a task was created');
  };
  return (
    <div className="card col" style={{ maxWidth: 640 }}>
      <h2>Request form</h2>
      <p className="small muted">Submissions become tasks in the selected list.</p>
      <label className="field">Submit to list<select className="input" value={f.listId} onChange={(e) => setF({ ...f, listId: e.target.value })}>{options.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <label className="field">Request title *<input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field">Your email<input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <div className="grid g2">
        <label className="field">Priority<select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
        <label className="field">Needed by<input className="input" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label>
      </div>
      <label className="field">Details<textarea className="input" rows={4} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></label>
      <button className="btn primary" disabled={!f.title.trim()} onClick={submit} style={{ alignSelf: 'flex-end' }}>Submit</button>
    </div>
  );
}

function ListView({ groups, onOpen }: { groups: Group[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return (
    <div className="card" style={{ padding: 8 }}>
      {groups.map((g) => (
        <div key={g.name}>
          <div className="group-h">
            <button className="btn ghost sm" onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(g.name) ? n.delete(g.name) : n.add(g.name); return n; })}>{collapsed.has(g.name) ? '▸' : '▾'}</button>
            <span className="label" style={{ background: g.color }}>{g.name}</span>
            <span className="small muted">{g.tasks.length}</span>
          </div>
          {!collapsed.has(g.name) && g.tasks.map((t) => <TaskRow key={t.id} t={t} onOpen={onOpen} />)}
          {!collapsed.has(g.name) && g.tasks.length === 0 && <div className="small faint" style={{ padding: '4px 36px' }}>No tasks</div>}
        </div>
      ))}
      {groups.length === 0 && <Empty icon="✅" title="No tasks" />}
      <span hidden>{engine.version}</span>
    </div>
  );
}

function TaskRow({ t, onOpen }: { t: Task; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const st = statusOf(engine, t);
  const closed = isClosed(engine, t);
  const subs = engine.list('tasks').filter((x) => x.parentId === t.id && !x.archived);
  const items = t.checklists.flatMap((c) => c.items);
  return (
    <div className="trow" onClick={() => onOpen(t.id)}>
      <span className="check" style={{ color: st?.colorHex, background: closed ? st?.colorHex : 'transparent' }} onClick={(e) => { e.stopPropagation(); toggleDone(engine, t); }} title="Mark complete">{closed ? <span style={{ color: '#fff' }}>✓</span> : ''}</span>
      <span className="row grow" style={{ minWidth: 0 }}>
        <span className="ellipsis" style={{ textDecoration: closed ? 'line-through' : undefined, color: closed ? 'var(--muted)' : undefined }}>{t.title}</span>
        {subs.length > 0 && <span className="small muted">↳ {subs.length}</span>}
        {items.length > 0 && <span className="small muted">☑ {items.filter((i) => i.done).length}/{items.length}</span>}
        {t.comments.length > 0 && <span className="small muted">💬 {t.comments.length}</span>}
        {t.tags.slice(0, 3).map((x) => <Tag key={x} t={x} />)}
      </span>
      <span className="hide-sm"><Avatars ids={t.assigneeIds} /></span>
      <span className={`small ${isOverdue(engine, t) ? 'red' : 'muted'}`}>{fmtDate(t.dueDate)}</span>
      <span className="hide-sm"><Flag p={t.priority} /></span>
    </div>
  );
}

function BoardView({ groups, onOpen }: { groups: Group[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [over, setOver] = useState('');
  const drop = (g: Group, id: ID) => {
    const t = engine.get('tasks', id);
    if (!t) return;
    const st = statusesFor(engine, t).find((s) => s.name === g.name);
    if (st) updateTask(engine, id, (x) => { x.statusId = st.id; });
  };
  return (
    <div className="board">
      {groups.map((g) => (
        <div key={g.name} className="col-b" style={{ background: `color-mix(in srgb, ${g.color} ${over === g.name ? 18 : 7}%, transparent)`, borderTop: `3px solid ${g.color}` }}
          onDragOver={(e) => { e.preventDefault(); setOver(g.name); }} onDragLeave={() => setOver('')}
          onDrop={(e) => { e.preventDefault(); setOver(''); drop(g, e.dataTransfer.getData('text/plain')); }}>
          <div className="row"><strong className="small">{g.name.toUpperCase()}</strong><span className="small muted">{g.tasks.length}</span></div>
          {g.tasks.map((t) => (
            <div key={t.id} className="tcard" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)} onClick={() => onOpen(t.id)}>
              <div className="small faint">{engine.get('lists', t.listId)?.name}</div>
              <div style={{ fontWeight: 500, margin: '4px 0' }}>{t.title}</div>
              <div className="row wrap">{t.tags.slice(0, 3).map((x) => <Tag key={x} t={x} />)}</div>
              <div className="row" style={{ marginTop: 6 }}>
                <Avatars ids={t.assigneeIds} size={20} />
                <span className={`small ${isOverdue(engine, t) ? 'red' : 'muted'}`}>{fmtDate(t.dueDate)}</span>
                <span className="right"><Flag p={t.priority} /></span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function CalendarView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); return startOfDay(d); });
  const first = new Date(month);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const todayT = startOfDay().getTime();
  return (
    <div>
      <div className="toolbar">
        <button className="btn" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
        <button className="btn" onClick={() => { const d = new Date(); d.setDate(1); setMonth(startOfDay(d)); }}>Today</button>
        <button className="btn" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
        <h2>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      </div>
      <div className="cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="d small muted" style={{ minHeight: 0, textAlign: 'center' }}>{d}</div>)}
        {days.map((d) => {
          const items = tasks.filter((t) => t.dueDate && startOfDay(new Date(t.dueDate)).getTime() === d.getTime());
          return (
            <div key={d.toISOString()} className={`d ${d.getMonth() !== month.getMonth() ? 'out' : ''} ${d.getTime() === todayT ? 'today' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { const id = e.dataTransfer.getData('text/plain'); updateTask(engine, id, (t) => { t.dueDate = iso(d); }); }}>
              <span className="n">{d.getDate()}</span>
              {items.map((t) => {
                const c = statusOf(engine, t)?.colorHex ?? '#888';
                return <div key={t.id} className="ev" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)} style={{ background: c + '26' }} onClick={() => onOpen(t.id)}>{t.title}</div>;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [sort, setSort] = useState<'title' | 'due' | 'priority'>('due');
  const sorted = [...tasks].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'priority' ? b.priority - a.priority : (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      <table className="t">
        <thead><tr>
          <th onClick={() => setSort('title')} style={{ cursor: 'pointer' }}>Name</th><th>Status</th><th>Assignees</th>
          <th onClick={() => setSort('priority')} style={{ cursor: 'pointer' }}>Priority</th><th>Start</th>
          <th onClick={() => setSort('due')} style={{ cursor: 'pointer' }}>Due</th><th className="num">Estimate</th><th>Tags</th><th>List</th>
        </tr></thead>
        <tbody>{sorted.map((t) => (
          <tr key={t.id} className="click" onClick={() => onOpen(t.id)}>
            <td>{t.title}</td><td><StatusPill s={statusOf(engine, t)} /></td><td><Avatars ids={t.assigneeIds} size={18} /></td>
            <td><Flag p={t.priority} /> {PRIORITIES.find((p) => p.value === t.priority)?.label}</td>
            <td>{fmtDate(t.startDate)}</td><td className={isOverdue(engine, t) ? 'red' : ''}>{fmtDate(t.dueDate)}</td>
            <td className="num">{t.estimateMinutes ? `${Math.round(t.estimateMinutes / 6) / 10}h` : ''}</td>
            <td>{t.tags.map((x) => <Tag key={x} t={x} />)}</td><td className="muted">{engine.get('lists', t.listId)?.name}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function GanttView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const dated = tasks.filter((t) => t.startDate || t.dueDate);
  const dates = dated.flatMap((t) => [t.startDate, t.dueDate].filter(Boolean).map((d) => new Date(d!).getTime()));
  const start = addDays(startOfDay(new Date(Math.min(Date.now(), ...dates))), -3);
  const end = addDays(startOfDay(new Date(Math.max(Date.now(), ...dates))), 10);
  const dayW = 30, rowH = 30;
  const days = Math.max(21, Math.round((end.getTime() - start.getTime()) / 86400000));
  const x = (d: string) => Math.round((startOfDay(new Date(d)).getTime() - start.getTime()) / 86400000) * dayW;
  if (!dated.length) return <Empty icon="📊" title="No dated tasks" sub="Give tasks start or due dates to see them on the timeline." />;
  return (
    <div className="gantt" style={{ height: 40 + dated.length * rowH }}>
      <div style={{ position: 'relative', width: days * dayW + 220, height: '100%' }}>
        {Array.from({ length: days }, (_, i) => {
          const d = addDays(start, i);
          return <div key={i} className="small faint" style={{ position: 'absolute', left: 220 + i * dayW, top: 0, width: dayW, height: '100%', borderLeft: '1px solid var(--line)', textAlign: 'center', background: d.getDay() % 6 === 0 ? 'var(--hover)' : undefined }}>{d.getDate()}</div>;
        })}
        <div style={{ position: 'absolute', left: 220 + x(iso()) + dayW / 2, top: 20, bottom: 0, width: 2, background: 'var(--red)' }} />
        {dated.map((t, i) => {
          const s = t.startDate ?? t.dueDate!, e = t.dueDate ?? t.startDate!;
          const c = statusOf(engine, t)?.colorHex ?? '#7B68EE';
          return (
            <div key={t.id}>
              <div className="ellipsis small" style={{ position: 'absolute', left: 8, width: 205, top: 30 + i * rowH }}>{t.title}</div>
              <div className="bar" style={{ left: 220 + x(s), top: 28 + i * rowH, width: Math.max(dayW, x(e) - x(s) + dayW), background: c }} onClick={() => onOpen(t.id)}>{t.title}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- task drawer

export function TaskDrawer({ id, onClose }: { id: ID; onClose: () => void }) {
  const { engine, openTask } = useApp();
  const t = engine.get('tasks', id);
  const [comment, setComment] = useState('');
  const [sub, setSub] = useState('');
  const [tag, setTag] = useState('');
  const [edit, setEdit] = useState(false);
  if (!t) return null;
  const up = (fn: (x: Task) => void) => updateTask(engine, id, fn);
  const statuses = statusesFor(engine, t);
  const subs = engine.list('tasks').filter((x) => x.parentId === id && !x.archived);
  const viewers = engine.presence.filter((p) => p.viewing === `task:${id}` && p.user_id !== engine.me);
  const list = engine.get('lists', t.listId);
  const space = engine.get('spaces', list?.spaceId);
  const entries = engine.list('timeEntries').filter((e) => e.taskId === id);
  const tracked = entries.reduce((a, e) => a + ((e.end ? new Date(e.end).getTime() : Date.now()) - new Date(e.start).getTime()), 0) / 3600000;
  const running = entries.find((e) => !e.end && e.memberId === engine.me);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="row" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
          <span className="small muted grow ellipsis">{space?.name} › {list?.name}</span>
          {viewers.length > 0 && <span className="row small muted"><Avatars ids={viewers.map((v) => v.user_id)} size={18} /> viewing</span>}
          <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(`mkprod://task/${id}`); }}>Copy link</button>
          <button className="btn sm danger" onClick={() => { trashTask(engine, id); onClose(); }}>Delete</button>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="body">
          {t.parentId && <a href="#" onClick={(e) => { e.preventDefault(); openTask(t.parentId); }} className="small">↖ {engine.get('tasks', t.parentId)?.title}</a>}
          <textarea className="plain" rows={1} style={{ fontSize: 22, fontWeight: 700, width: '100%', resize: 'none' }} value={t.title} onChange={(e) => up((x) => { x.title = e.target.value; })} />
          <div className="props" style={{ marginTop: 10 }}>
            <span className="k">Status</span>
            <select className="input" value={t.statusId} onChange={(e) => up((x) => { x.statusId = e.target.value; })}>{statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <span className="k">Assignees</span>
            <div className="row wrap">
              {engine.members.map((m) => (
                <label key={m.id} className="row small" style={{ gap: 4 }}>
                  <input type="checkbox" checked={t.assigneeIds.includes(m.id)} onChange={(e) => up((x) => { x.assigneeIds = e.target.checked ? [...x.assigneeIds, m.id] : x.assigneeIds.filter((a) => a !== m.id); })} />
                  <Avatar m={m} size={18} />{m.name.split(' ')[0]}
                </label>
              ))}
            </div>
            <span className="k">Priority</span><PrioritySelect value={t.priority} onChange={(v) => up((x) => { x.priority = v; })} />
            <span className="k">Dates</span>
            <div className="row">
              <input type="date" className="input" value={toInputDate(t.startDate)} onChange={(e) => up((x) => { const v = fromInputDate(e.target.value); if (v) x.startDate = v; else delete x.startDate; })} />→
              <input type="date" className="input" value={toInputDate(t.dueDate)} onChange={(e) => up((x) => { const v = fromInputDate(e.target.value); if (v) x.dueDate = v; else delete x.dueDate; })} />
            </div>
            <span className="k">Estimate (min)</span>
            <input className="input" type="number" value={t.estimateMinutes ?? ''} onChange={(e) => up((x) => { if (e.target.value) x.estimateMinutes = Number(e.target.value); else delete x.estimateMinutes; })} />
            <span className="k">Repeat</span>
            <select className="input" value={t.recurrence} onChange={(e) => up((x) => { x.recurrence = e.target.value; })}>{['none', 'daily', 'weekly', 'monthly', 'yearly'].map((r) => <option key={r} value={r}>{r === 'none' ? 'Never' : r}</option>)}</select>
            <span className="k">Tags</span>
            <div className="row wrap">
              {t.tags.map((x) => <span key={x} onClick={() => up((y) => { y.tags = y.tags.filter((z) => z !== x); })} style={{ cursor: 'pointer' }} title="Remove"><Tag t={x} /></span>)}
              <input className="input" placeholder="Add tag" value={tag} style={{ width: 110 }} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tag.trim()) { const v = tag.trim().toLowerCase(); up((x) => { if (!x.tags.includes(v)) x.tags.push(v); }); setTag(''); } }} />
            </div>
            <span className="k">Time</span>
            <div className="row">
              <span className="mono">{tracked.toFixed(1)}h tracked</span>
              {running
                ? <button className="btn sm danger" onClick={() => engine.update('timeEntries', running.id, (x) => { x.end = iso(); })}>■ Stop</button>
                : <button className="btn sm" onClick={() => engine.put('timeEntries', { id: uid(), taskId: id, memberId: engine.me, note: '', start: iso(), billable: false })}>▶ Start timer</button>}
            </div>
          </div>

          <div className="section">
            <div className="row"><h3 className="grow">Description</h3><button className="btn sm ghost" onClick={() => setEdit(!edit)}>{edit ? 'Done' : 'Edit'}</button></div>
            {edit || !t.details
              ? <textarea className="input" style={{ width: '100%', minHeight: 120, marginTop: 6 }} value={t.details} placeholder="Markdown supported" onChange={(e) => up((x) => { x.details = e.target.value; })} />
              : <Markdown text={t.details} />}
          </div>

          <div className="section">
            <h3>Subtasks {subs.length > 0 && <span className="muted small">{subs.filter((s) => isClosed(engine, s)).length}/{subs.length}</span>}</h3>
            {subs.map((s) => (
              <div key={s.id} className="row" style={{ padding: '4px 0' }}>
                <span className="check" style={{ color: statusOf(engine, s)?.colorHex }} onClick={() => toggleDone(engine, s)}>{isClosed(engine, s) ? '✓' : ''}</span>
                <a href="#" className="grow" onClick={(e) => { e.preventDefault(); openTask(s.id); }} style={{ color: 'var(--text)', textDecoration: isClosed(engine, s) ? 'line-through' : undefined }}>{s.title}</a>
                <Avatars ids={s.assigneeIds} size={18} />
              </div>
            ))}
            <input className="input" style={{ width: '100%', marginTop: 4 }} placeholder="+ Add subtask" value={sub} onChange={(e) => setSub(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && sub.trim()) { const n = newTask(t.listId, sub.trim(), statuses[0]?.id ?? t.statusId, member(engine, engine.me)); n.parentId = id; engine.put('tasks', n); setSub(''); } }} />
          </div>

          <div className="section">
            <div className="row"><h3 className="grow">Checklists</h3><button className="btn sm" onClick={() => up((x) => { x.checklists.push({ id: uid(), name: 'Checklist', items: [] }); })}>+ Checklist</button></div>
            {t.checklists.map((c, ci) => (
              <div key={c.id} className="card" style={{ padding: 10, marginTop: 8 }}>
                <div className="row"><input className="plain grow" style={{ fontWeight: 600 }} value={c.name} onChange={(e) => up((x) => { x.checklists[ci].name = e.target.value; })} />
                  <button className="btn sm ghost" onClick={() => up((x) => { x.checklists.splice(ci, 1); })}>🗑</button></div>
                {c.items.map((it, ii) => (
                  <label key={it.id} className="row" style={{ padding: '2px 0' }}>
                    <input type="checkbox" checked={it.done} onChange={() => up((x) => { x.checklists[ci].items[ii].done = !it.done; })} />
                    <span className="grow" style={{ textDecoration: it.done ? 'line-through' : undefined }}>{it.text}</span>
                    <button className="btn sm ghost" onClick={(e) => { e.preventDefault(); up((x) => { x.checklists[ci].items.splice(ii, 1); }); }}>✕</button>
                  </label>
                ))}
                <input className="input" style={{ width: '100%' }} placeholder="Add item" onKeyDown={(e) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (e.key === 'Enter' && v) { up((x) => { x.checklists[ci].items.push({ id: uid(), text: v, done: false }); }); (e.target as HTMLInputElement).value = ''; }
                }} />
              </div>
            ))}
          </div>

          <Attachments items={t.attachments} onChange={(fn) => up((x) => { fn(x.attachments); })} />

          <div className="section">
            <h3>Comments</h3>
            {t.comments.map((c, i) => (
              <div key={c.id} className="row" style={{ alignItems: 'flex-start', padding: '8px 0', opacity: c.resolved ? 0.55 : 1 }}>
                <Avatar m={member(engine, c.authorId)} size={26} />
                <div className="grow">
                  <div className="row"><strong>{member(engine, c.authorId)?.name ?? 'Unknown'}</strong><span className="small muted">{new Date(c.date).toLocaleString()}</span>
                    {c.assigneeId && <span className="small">→ <Avatar m={member(engine, c.assigneeId)} size={16} /></span>}
                    <span className="right" />
                    <select className="input" style={{ fontSize: 11, padding: '1px 4px' }} value={c.assigneeId ?? ''} title="Assign comment" onChange={(e) => up((x) => { if (e.target.value) x.comments[i].assigneeId = e.target.value; else delete x.comments[i].assigneeId; })}>
                      <option value="">Assign…</option>{engine.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <button className="btn sm ghost" onClick={() => up((x) => { x.comments[i].resolved = !c.resolved; })}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
                  </div>
                  <Markdown text={c.text} />
                </div>
              </div>
            ))}
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <textarea className="input grow" rows={2} placeholder="Comment… use @name to mention" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="btn primary" disabled={!comment.trim()} onClick={() => {
                const text = comment.trim();
                up((x) => { x.comments.push({ id: uid(), authorId: engine.me, text, date: iso(), resolved: false }); x.activity.push({ id: uid(), date: iso(), text: `${member(engine, engine.me)?.name} commented` }); });
                setComment('');
              }}>Send</button>
            </div>
          </div>

          <div className="section">
            <h3>Activity</h3>
            {[...t.activity].reverse().slice(0, 30).map((a) => <div key={a.id} className="row small" style={{ padding: '2px 0' }}><span className="grow">{a.text}</span><span className="muted">{new Date(a.date).toLocaleString()}</span></div>)}
          </div>
        </div>
      </aside>
    </>
  );
}
