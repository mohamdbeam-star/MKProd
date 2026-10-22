import { ReactElement, useEffect, useRef, useState } from 'react';
import { ID, addDays, iso, newDoc, startOfDay, toInputDate, fromInputDate, uid, Goal, GoalTarget } from '../model';
import { Avatar, Empty, Markdown, Modal, Seg, isClosed, member, useApp } from '../ui';
import { fingerprint, newRecoveryCode, passwordKeys, randomPassword, recoveryKeys, sealScalar, unlockKeyPair } from '../crypto';
import { api } from '../sync';

// ---------------------------------------------------------------- Docs

export function DocsPage({ id }: { id?: ID }) {
  const { engine, go } = useApp();
  const docs = engine.list('docs').sort((a, b) => b.updated.localeCompare(a.updated));
  const doc = engine.get('docs', id);
  const [mode, setMode] = useState<'edit' | 'split' | 'view'>('split');
  const create = (parentId?: ID) => {
    const d = newDoc('Untitled');
    if (parentId) d.parentId = parentId;
    engine.put('docs', d);
    go('docs/' + d.id);
  };
  const children = (pid?: ID): ReactElement[] => docs.filter((d) => d.parentId === pid).map((d) => (
    <div key={d.id} style={{ paddingLeft: pid ? 12 : 0 }}>
      <div className={`nav ${d.id === id ? 'on' : ''}`} onClick={() => go('docs/' + d.id)}><span className="ic">📄</span><span className="ellipsis">{d.title || 'Untitled'}</span></div>
      {children(d.id)}
    </div>
  ));
  return (
    <div className="row" style={{ alignItems: 'stretch', gap: 14, height: '100%' }}>
      <div className="card" style={{ width: 230, flex: 'none', padding: 8 }}>
        <button className="btn primary" style={{ width: '100%', marginBottom: 8 }} onClick={() => create()}>+ New doc</button>
        {children(undefined)}
        {docs.length === 0 && <p className="muted small">No docs yet.</p>}
      </div>
      <div className="card grow col" style={{ minHeight: 400 }}>
        {!doc ? <Empty icon="📝" title="Pick or create a doc" sub="Specs, wikis and meeting notes, shared with the Mac app." /> : (
          <>
            <div className="row">
              <input className="plain grow" style={{ fontSize: 24, fontWeight: 700 }} value={doc.title} onChange={(e) => engine.update('docs', doc.id, (d) => { d.title = e.target.value; })} />
              <Seg value={mode} onChange={setMode} options={[{ value: 'edit', label: 'Edit' }, { value: 'split', label: 'Split' }, { value: 'view', label: 'Preview' }]} />
              <button className="btn" onClick={() => create(doc.id)}>+ Sub-page</button>
              <button className="btn danger" onClick={() => { engine.remove('docs', doc.id); go('docs'); }}>Delete</button>
            </div>
            <div className="row grow" style={{ alignItems: 'stretch', gap: 12 }}>
              {mode !== 'view' && <textarea className="input grow" style={{ fontFamily: 'ui-monospace, monospace', minHeight: 420 }} value={doc.body} onChange={(e) => engine.update('docs', doc.id, (d) => { d.body = e.target.value; })} />}
              {mode !== 'edit' && <div className="grow" style={{ overflow: 'auto' }}><Markdown text={doc.body} /></div>}
            </div>
            <div className="small muted">Edited {new Date(doc.updated).toLocaleString()}</div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Chat

export function ChatPage({ id }: { id?: ID }) {
  const { engine, go } = useApp();
  const channels = engine.list('channels');
  const channel = engine.get('channels', id) ?? channels[0];
  const msgs = engine.list('messages').filter((m) => m.channelId === channel?.id).sort((a, b) => a.date.localeCompare(b.date));
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView(); }, [msgs.length]);
  const send = () => {
    if (!text.trim() || !channel) return;
    engine.put('messages', { id: uid(), channelId: channel.id, authorId: engine.me, text: text.trim(), date: iso() });
    setText('');
  };
  return (
    <div className="row" style={{ alignItems: 'stretch', gap: 14, height: '100%' }}>
      <div className="card" style={{ width: 200, flex: 'none', padding: 8 }}>
        {channels.map((c) => <div key={c.id} className={`nav ${c.id === channel?.id ? 'on' : ''}`} onClick={() => go('chat/' + c.id)}># {c.name}</div>)}
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => { const n = prompt('Channel name'); if (n) { const c = { id: uid(), name: n.toLowerCase().replace(/\s+/g, '-') }; engine.put('channels', c); go('chat/' + c.id); } }}>+ Channel</button>
      </div>
      <div className="card grow col" style={{ minHeight: 400 }}>
        <h2># {channel?.name ?? 'No channel'}</h2>
        <div className="grow" style={{ overflow: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
          {msgs.map((m) => (
            <div key={m.id} className="row" style={{ alignItems: 'flex-start', padding: '6px 0' }}>
              <Avatar m={member(engine, m.authorId)} size={30} />
              <div><div className="row"><strong>{member(engine, m.authorId)?.name ?? 'Unknown'}</strong><span className="small muted">{new Date(m.date).toLocaleString()}</span></div><Markdown text={m.text} /></div>
            </div>
          ))}
          <div ref={end} />
        </div>
        <div className="row"><input className="input grow" value={text} placeholder={`Message #${channel?.name ?? ''}`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} /><button className="btn primary" onClick={send}>Send</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Goals

export function GoalsPage() {
  const { engine } = useApp();
  const progress = (t: GoalTarget) => {
    if (t.kind === 'boolean') return t.current >= 1 ? 1 : 0;
    if (t.kind === 'tasks') {
      const ts = t.taskIds.map((i) => engine.get('tasks', i)).filter(Boolean);
      return ts.length ? ts.filter((x) => isClosed(engine, x!)).length / ts.length : 0;
    }
    const span = t.target - t.start;
    return span ? Math.min(Math.max((t.current - t.start) / span, 0), 1) : 0;
  };
  const goalProgress = (g: Goal) => (g.targets.length ? g.targets.map(progress).reduce((a, b) => a + b, 0) / g.targets.length : 0);
  return (
    <div className="col">
      <div className="row"><h1 className="grow">Goals</h1>
        <button className="btn primary" onClick={() => engine.put('goals', { id: uid(), name: 'New goal', details: '', colorHex: '#7B68EE', folder: 'General', targets: [{ id: uid(), name: 'Target', kind: 'number', start: 0, target: 100, current: 0, taskIds: [] }] })}>+ New goal</button>
      </div>
      {engine.list('goals').map((g) => (
        <div key={g.id} className="card col">
          <div className="row">
            <strong style={{ fontSize: 20, color: g.colorHex }}>{Math.round(goalProgress(g) * 100)}%</strong>
            <input className="plain grow" style={{ fontSize: 17, fontWeight: 700 }} value={g.name} onChange={(e) => engine.update('goals', g.id, (x) => { x.name = e.target.value; })} />
            <span className="small muted">{g.folder}</span>
            <input type="date" className="input" value={toInputDate(g.dueDate)} onChange={(e) => engine.update('goals', g.id, (x) => { const v = fromInputDate(e.target.value); if (v) x.dueDate = v; else delete x.dueDate; })} />
            <button className="btn sm danger" onClick={() => engine.remove('goals', g.id)}>Delete</button>
          </div>
          {g.targets.map((t, i) => (
            <div key={t.id} className="row">
              <span style={{ width: 200 }} className="ellipsis">{t.name}</span>
              <div className="bar-bg grow"><span style={{ width: `${progress(t) * 100}%`, background: g.colorHex }} /></div>
              {(t.kind === 'number' || t.kind === 'currency') && <input className="input" type="number" style={{ width: 100 }} value={t.current} onChange={(e) => engine.update('goals', g.id, (x) => { x.targets[i].current = Number(e.target.value); })} />}
              {(t.kind === 'number' || t.kind === 'currency') && <span className="small muted">/ {t.target}</span>}
              {t.kind === 'boolean' && <input type="checkbox" checked={t.current >= 1} onChange={(e) => engine.update('goals', g.id, (x) => { x.targets[i].current = e.target.checked ? 1 : 0; })} />}
              {t.kind === 'tasks' && <span className="small muted">{t.taskIds.length} linked tasks</span>}
            </div>
          ))}
        </div>
      ))}
      {engine.list('goals').length === 0 && <Empty icon="🎯" title="No goals yet" />}
    </div>
  );
}

// ---------------------------------------------------------------- Timesheets

export function TimesheetPage() {
  const { engine } = useApp();
  const [week, setWeek] = useState(() => { const d = startOfDay(); return addDays(d, -((d.getDay() + 6) % 7)); });
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const entries = engine.list('timeEntries').filter((e) => new Date(e.start) >= week && new Date(e.start) < addDays(week, 7));
  const dur = (e: { start: string; end?: string }) => ((e.end ? new Date(e.end).getTime() : Date.now()) - new Date(e.start).getTime()) / 3600000;
  const byTask = [...new Set(entries.map((e) => e.taskId ?? 'none'))];
  return (
    <div className="card">
      <div className="toolbar">
        <button className="btn" onClick={() => setWeek(addDays(week, -7))}>‹</button>
        <h2>{week.toLocaleDateString()} – {addDays(week, 6).toLocaleDateString()}</h2>
        <button className="btn" onClick={() => setWeek(addDays(week, 7))}>›</button>
        <span className="right mono">Total {entries.reduce((a, e) => a + dur(e), 0).toFixed(1)}h</span>
      </div>
      <table className="t">
        <thead><tr><th>Task</th>{days.map((d) => <th key={d.toISOString()} className="num">{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</th>)}<th className="num">Total</th></tr></thead>
        <tbody>{byTask.map((k) => {
          const rows = entries.filter((e) => (e.taskId ?? 'none') === k);
          return (
            <tr key={k}><td>{engine.get('tasks', k)?.title ?? 'No task'}</td>
              {days.map((d) => { const h = rows.filter((e) => startOfDay(new Date(e.start)).getTime() === d.getTime()).reduce((a, e) => a + dur(e), 0); return <td key={d.toISOString()} className="num">{h ? h.toFixed(1) : '–'}</td>; })}
              <td className="num"><strong>{rows.reduce((a, e) => a + dur(e), 0).toFixed(1)}</strong></td></tr>
          );
        })}</tbody>
      </table>
      {entries.length === 0 && <Empty icon="⏱" title="No time tracked this week" sub="Start a timer from any task." />}
    </div>
  );
}

// ---------------------------------------------------------------- Trash

export function TrashPage() {
  const { engine } = useApp();
  const items = engine.list('tasks').filter((t) => t.trashedAt);
  return (
    <div className="card">
      <div className="row"><h2 className="grow">Trash</h2>{items.length > 0 && <button className="btn danger" onClick={() => items.forEach((t) => engine.remove('tasks', t.id))}>Empty trash</button>}</div>
      {items.map((t) => (
        <div key={t.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <span className="grow">{t.title}</span><span className="small muted">Deleted {new Date(t.trashedAt!).toLocaleString()}</span>
          <button className="btn sm" onClick={() => engine.update('tasks', t.id, (x) => { x.archived = false; delete x.trashedAt; })}>Restore</button>
          <button className="btn sm danger" onClick={() => engine.remove('tasks', t.id)}>Delete forever</button>
        </div>
      ))}
      {items.length === 0 && <Empty icon="🗑" title="Trash is empty" />}
    </div>
  );
}

// ---------------------------------------------------------------- Team & account

export function TeamPage() {
  const { engine, toast } = useApp();
  const [invites, setInvites] = useState<{ email: string; role: string; expires_at?: string }[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [name, setName] = useState(engine.session.user.name);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [shown, setShown] = useState<{ title: string; value: string; note: string } | null>(null);
  const [prints, setPrints] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const base = `/api/workspaces/${engine.workspace.id}`;
  const load = () => api<{ invites: { email: string; role: string; expires_at?: string }[] }>(`${base}/team`).then((r) => setInvites(r.invites)).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => {
    Promise.all(engine.team.filter((m) => m.publicKey).map(async (m) => [m.id, await fingerprint(m.publicKey!)] as const)).then((x) => setPrints(Object.fromEntries(x)));
  }, [engine.team.map((m) => m.publicKey).join()]);
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await f(); if (ok) toast(ok); load(); await engine.sync(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const me = engine.session.user;

  return (
    <div className="col" style={{ gap: 16, maxWidth: 880 }}>
      <div className="card col">
        <div className="row">
          <h2 className="grow">Team · {engine.workspace.name}</h2>
          <span className="pill" style={engine.encrypted ? { background: '#2FA86C26', color: '#2FA86C' } : { background: '#E8912D26', color: '#E8912D' }}>
            {engine.encrypted ? `🔒 End-to-end encrypted · key v${engine.keyVersion}` : '⚠ Not encrypted yet'}
          </span>
        </div>
        <table className="t"><tbody>
          {engine.team.map((m) => (
            <tr key={m.id}>
              <td><div className="row"><Avatar m={{ id: m.id, name: m.name, email: m.email, colorHex: m.color }} size={26} /><div><div>{m.name}{m.id === engine.me ? ' (you)' : ''}</div><div className="small muted">{m.email}</div></div>
                {engine.presence.some((p) => p.user_id === m.id) && <span title="Online" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--green)' }} />}</div></td>
              <td className="small">
                {!m.publicKey ? <span className="orange">No keys yet (signs in with an older app)</span>
                  : !m.hasKey && engine.encrypted ? <span className="orange">Waiting for key</span>
                  : <span title="Key fingerprint: compare with your teammate to rule out tampering">🔑 <span className="mono" style={{ whiteSpace: 'nowrap' }}>{prints[m.id] ?? '…'}</span></span>}
              </td>
              <td><EntityCell memberId={m.id} /></td>
              <td style={{ width: 130 }}>{engine.isAdmin && m.role !== 'owner' && m.id !== engine.me
                ? <select className="input" value={m.role} onChange={(e) => run(() => api(`${base}/members/${m.id}/role`, { body: { role: e.target.value } }), 'Role updated')}>
                    <option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option></select>
                : <span className="muted">{m.role}</span>}</td>
              <td style={{ width: 220 }} className="num">{engine.isAdmin && m.role !== 'owner' && m.id !== engine.me && (
                <>
                  <button className="btn sm" disabled={busy} onClick={() => run(async () => {
                    const temp = randomPassword();
                    const { authKey } = await passwordKeys(m.email, temp);
                    await api(`${base}/members/${m.id}/password`, { body: { authKey } });
                    setShown({ title: `Temporary password for ${m.name}`, value: temp, note: 'Share it privately. They sign in with it, get new encryption keys, and should change it under Your profile. A teammate\'s app re-shares the workspace key automatically.' });
                  })}>Reset password</button>{' '}
                  <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Remove ${m.name}? The workspace key will be rotated so they can't read anything new.`) && run(async () => {
                    await api(`${base}/members/${m.id}`, { method: 'DELETE' });
                    await engine.sync();
                    if (engine.encrypted) await engine.rotateKey();
                  }, 'Removed and key rotated')}>Remove</button>
                </>
              )}</td>
            </tr>
          ))}
          {invites.map((i) => (
            <tr key={i.email}><td className="muted">✉️ {i.email} (invited)</td><td /><td className="small muted">{i.expires_at ? `expires ${new Date(i.expires_at).toLocaleDateString()}` : ''}</td><td className="muted">{i.role}</td>
              <td className="num"><button className="btn sm" onClick={() => run(() => api(`${base}/invites/${encodeURIComponent(i.email)}`, { method: 'DELETE' }))}>Cancel</button></td></tr>
          ))}
        </tbody></table>
        {engine.isAdmin && (
          <div className="row wrap">
            <input className="input grow" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}><option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option></select>
            <button className="btn primary" disabled={!email.includes('@') || busy} onClick={() => run(async () => {
              const r = await api<{ code: string }>(`${base}/invites`, { body: { email, role } });
              setShown({ title: `Invite code for ${email}`, value: r.code, note: 'Send this code to your teammate privately (it expires in 14 days). They create an account with that email, then enter the code under "Choose a workspace".' });
              setEmail('');
            })}>Invite</button>
            {engine.encrypted && <button className="btn" disabled={busy} title="Create a new key version and re-encrypt everything" onClick={() => confirm('Rotate the workspace encryption key and re-encrypt all data now?') && run(() => engine.rotateKey(), 'Key rotated')}>🔄 Rotate key</button>}
          </div>
        )}
        <p className="small muted">Invites need the one-time code; knowing the email isn't enough. Each person's key fingerprint should match what they see on their own device.</p>
      </div>
      <NotificationSettings />
      <div className="card col">
        <h2>Your profile & security</h2>
        <div className="row"><input className="input grow" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn" onClick={() => run(() => api('/api/me', { method: 'PATCH', body: { name } }), 'Profile saved')}>Save name</button></div>
        <div className="small muted">Your key fingerprint: <span className="mono">{me.publicKey ? prints[me.id] ?? '…' : '—'}</span></div>
        <div className="row wrap">
          <input className="input grow" type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
          <input className="input grow" type="password" placeholder="New password (10+)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
          <button className="btn" disabled={pw.next.length < 10 || busy} onClick={() => run(async () => {
            const cur = await passwordKeys(me.email, pw.current);
            const meRes = await api<{ user: { encPrivateKey: string; publicKey: string } }>('/api/me');
            const { scalar } = await unlockKeyPair(cur.kek, meRes.user.encPrivateKey, meRes.user.publicKey).catch(() => { throw new Error('Current password is incorrect'); });
            const next = await passwordKeys(me.email, pw.next);
            await api('/api/auth/password', { body: { currentAuthKey: cur.authKey, newAuthKey: next.authKey, encPrivateKey: await sealScalar(next.kek, scalar) } });
            scalar.fill(0);
            setPw({ current: '', next: '' });
          }, 'Password changed; other devices were signed out')}>Change password</button>
        </div>
        <div className="row wrap">
          <button className="btn" disabled={busy} onClick={() => {
            const password = prompt('Enter your password to create a new recovery code (the old one stops working):');
            if (!password) return;
            run(async () => {
              const pk = await passwordKeys(me.email, password);
              const meRes = await api<{ user: { encPrivateKey: string; publicKey: string } }>('/api/me');
              const { scalar } = await unlockKeyPair(pk.kek, meRes.user.encPrivateKey, meRes.user.publicKey).catch(() => { throw new Error('Password is incorrect'); });
              const code = newRecoveryCode();
              const rk = await recoveryKeys(me.email, code);
              await api('/api/me/recovery', { method: 'PUT', body: { recAuth: rk.authKey, encPrivateKeyRec: await sealScalar(rk.kek, scalar) } });
              scalar.fill(0);
              setShown({ title: 'Your new recovery code', value: code, note: 'Store it in a password manager or print it. It is shown only once; the previous code no longer works.' });
            });
          }}>New recovery code</button>
          <button className="btn" disabled={busy} onClick={() => run(() => api('/api/auth/sessions', { method: 'DELETE' }), 'Signed out of all other devices')}>Sign out other devices</button>
        </div>
      </div>
      {shown && (
        <Modal title={shown.title} onClose={() => setShown(null)} footer={<><button className="btn" onClick={() => navigator.clipboard?.writeText(shown.value)}>Copy</button><button className="btn primary" onClick={() => setShown(null)}>Done</button></>}>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, padding: 12, borderRadius: 8, background: 'var(--hover)', textAlign: 'center', userSelect: 'all', wordBreak: 'break-all' }}>{shown.value}</div>
          <p className="small muted">{shown.note}</p>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- entity membership & notifications

/** Which finance entities a person belongs to, and their role in each approval chain. */
function EntityCell({ memberId }: { memberId: ID }) {
  const { engine } = useApp();
  const entities = engine.list('entities').sort((a, b) => a.name.localeCompare(b.name));
  const mine = entities.filter((e) => e.roles.some((r) => r.memberId === memberId));
  const others = entities.filter((e) => !mine.includes(e));
  const set = (entityId: ID, role: string | null) => engine.update('entities', entityId, (e) => {
    e.roles = e.roles.filter((r) => r.memberId !== memberId);
    if (role) e.roles.push({ memberId, role });
  });
  if (!entities.length) return <span className="small muted">No entities</span>;
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      {mine.map((e) => (
        <span key={e.id} className="pill" style={{ background: 'var(--hover)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          {e.name}
          <select className="input sm" style={{ padding: '0 2px', height: 22 }} disabled={!engine.canWrite} value={e.roles.find((r) => r.memberId === memberId)!.role}
            onChange={(ev) => set(e.id, ev.target.value)} title={`Role in ${e.name}`}>
            {e.approvalLevels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          {engine.canWrite && <button className="btn sm ghost" title={`Remove from ${e.name}`} onClick={() => set(e.id, null)}>×</button>}
        </span>
      ))}
      {engine.canWrite && others.length > 0 && (
        <select className="input sm" style={{ height: 24 }} value="" onChange={(ev) => { const e = entities.find((x) => x.id === ev.target.value); if (e) set(e.id, e.approvalLevels[0] ?? 'Requestor'); }}>
          <option value="">+ Entity</option>
          {others.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      )}
    </div>
  );
}

const NOTIFY_OPTIONS: { key: string; title: string; detail?: string }[] = [
  { key: 'taskAssigned', title: 'A task is assigned to me', detail: 'Includes comments assigned to you.' },
  { key: 'taskUpdated', title: "Tasks I'm assigned to or watch are updated", detail: 'Status, due date, description, checklist and comments. Edits within 15 minutes are grouped.' },
  { key: 'mentions', title: 'Someone @mentions me' },
  { key: 'contractExpiring', title: 'A contract of my entities is ending', detail: '60, 30, 14, 7 and 1 day before the end date.' },
  { key: 'approvals', title: 'Orders need my approval or my order changes status' },
];

function NotificationSettings() {
  const { engine, toast } = useApp();
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [emailEnabled, setEmailEnabled] = useState(true);
  useEffect(() => {
    api<{ user: { notifyPrefs: Record<string, boolean> }; emailEnabled: boolean }>('/api/me')
      .then((r) => { setPrefs(r.user.notifyPrefs); setEmailEnabled(r.emailEnabled); })
      .catch((e) => toast((e as Error).message));
  }, []);
  if (!prefs) return <div className="card"><h2>Email notifications</h2><p className="muted">Loading…</p></div>;
  const save = (key: string, v: boolean) => {
    const next = { ...prefs, [key]: v };
    setPrefs(next);
    api<{ notifyPrefs: Record<string, boolean> }>('/api/me/notifications', { method: 'PUT', body: next })
      .then((r) => setPrefs(r.notifyPrefs)).catch((e) => toast((e as Error).message));
  };
  const box = (key: string, title: string, detail?: string, disabled = false) => (
    <label key={key} className="row" style={{ alignItems: 'flex-start', gap: 8, opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={prefs[key] !== false} disabled={disabled} onChange={(e) => save(key, e.target.checked)} style={{ marginTop: 3 }} />
      <span><div>{title}</div>{detail && <div className="small muted">{detail}</div>}</span>
    </label>
  );
  return (
    <div className="card col">
      <h2>Email notifications</h2>
      {!emailEnabled && <div className="small orange">Email isn't set up on the server yet, so nothing is sent until an admin adds the SMTP settings.</div>}
      {box('email', `Send me email notifications (to ${engine.session.user.email})`)}
      <div className="col" style={{ paddingLeft: 20, gap: 6 }}>
        {NOTIFY_OPTIONS.map((o) => box(o.key, o.title, o.detail, prefs.email === false))}
      </div>
      {box('includeDetails', 'Include task and contract details', 'When off, emails only say something happened. Your workspace data is end-to-end encrypted; details in an email are readable by the mail providers along the way.')}
      <div className="row">
        <button className="btn" disabled={!emailEnabled} onClick={() => api('/api/me/notifications/test', { body: {} }).then(() => toast('Test email sent')).catch((e) => toast((e as Error).message))}>Send test email</button>
        <span className="small muted">In-app inbox notifications are always on; these settings only control email.</span>
      </div>
    </div>
  );
}
