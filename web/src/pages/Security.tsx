// Account security (two-factor, devices, personal log, account deletion) and workspace
// governance (two-factor requirement, ownership transfer, workspace log, deletion).
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ID } from '../model';
import { passwordKeys } from '../crypto';
import { api, ApiError } from '../sync';
import { Avatar, Modal, member, useApp } from '../ui';

const EVENT_LABELS: Record<string, string> = {
  signin: 'Signed in', signin_failed: 'Failed sign-in', signin_mfa_failed: 'Wrong two-factor code', signup: 'Account created', email_verified: 'Email confirmed',
  password_changed: 'Password changed', password_reset_admin: 'Password reset by admin', recovery_used: 'Recovery code used', totp_enabled: 'Two-factor on',
  totp_disabled: 'Two-factor off', session_revoked: 'Device signed out', sessions_revoked_all: 'Other devices signed out', invite_created: 'Invite sent',
  invite_cancelled: 'Invite cancelled', invite_accepted: 'Joined', role_changed: 'Role changed', member_removed: 'Member removed', member_left: 'Member left',
  key_rotated: 'Encryption key', workspace_created: 'Workspace created', workspace_renamed: 'Workspace renamed', workspace_deleted: 'Workspace deleted',
  owner_transferred: 'Ownership transferred', require_mfa_changed: 'Two-factor policy', workspace_locked: 'Panic mode on', workspace_unlocked: 'Panic mode off', share_created: 'Supplier link created', share_revoked: 'Supplier link revoked',
};

interface SecurityEvent { id: string; at: string; type: string; detail: string; ip?: string; location?: string; actor_id?: string; actor_name?: string }

export function SecurityLogCard({ scope }: { scope: 'me' | 'workspace' }) {
  const { engine } = useApp();
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const load = () => api<{ events: SecurityEvent[] }>(scope === 'me' ? '/api/me/security' : `/api/workspaces/${engine.workspace.id}/security`)
    .then((r) => setEvents(r.events)).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, [scope]);
  const rows = (events ?? []).slice(0, open ? 200 : 8);
  return (
    <div className="card col">
      <div className="row"><h2 className="grow">{scope === 'me' ? 'Your security activity' : 'Workspace security log'}</h2><button className="btn sm" onClick={load}>Refresh</button></div>
      <p className="small muted">{scope === 'me' ? 'Sign-ins, password and two-factor changes on your account, with the device and approximate location.' : 'Who joined, left, changed roles, reset passwords or rotated keys. Visible to owners and admins.'}</p>
      {error && <div className="red small">{error}</div>}
      {events && !events.length && <p className="muted small">Nothing recorded yet.</p>}
      {rows.length > 0 && (
        <table className="t"><tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</td>
              <td><strong className={e.type.includes('failed') ? 'red' : ''}>{EVENT_LABELS[e.type] ?? e.type}</strong><div className="small muted">{e.detail}</div></td>
              <td className="small muted">{scope === 'workspace' && e.actor_name ? <span className="row"><Avatar m={member(engine, e.actor_id)} size={16} />{e.actor_name}</span> : null}{e.location ? <div>{e.location}</div> : null}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      {(events?.length ?? 0) > 8 && <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show all ${events!.length}`}</button>}
    </div>
  );
}

interface Device { id: string; client: string | null; ip: string | null; location: string | null; created_at: string; last_used: string | null; current: boolean }

export function DevicesCard() {
  const { toast } = useApp();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const load = () => api<{ sessions: Device[] }>('/api/auth/sessions').then((r) => setDevices(r.sessions)).catch((e) => toast((e as Error).message));
  useEffect(() => { load(); }, []);
  const revoke = async (d: Device) => {
    if (!confirm(`Sign out ${d.client ?? 'this device'}?`)) return;
    try { await api(`/api/auth/sessions/${d.id}`, { method: 'DELETE' }); toast('Device signed out'); load(); } catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="card col">
      <div className="row"><h2 className="grow">Signed-in devices</h2>
        <button className="btn sm" onClick={() => api('/api/auth/sessions', { method: 'DELETE' }).then(() => { toast('Signed out of all other devices'); load(); }).catch((e) => toast((e as Error).message))}>Sign out all others</button></div>
      {!devices && <p className="muted small">Loading…</p>}
      {devices && (
        <table className="t devices"><tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>{d.client ?? 'Unknown device'}{d.current && <span className="pill" style={{ marginLeft: 6, background: 'var(--accent-soft)', color: 'var(--accent)' }}>This device</span>}
                <div className="small muted">{[d.location, d.ip].filter(Boolean).join(' · ')}</div></td>
              <td className="small muted">Last active {d.last_used ? new Date(d.last_used).toLocaleString() : '—'}<div>Signed in {new Date(d.created_at).toLocaleDateString()}</div></td>
              <td className="num">{!d.current && <button className="btn sm" onClick={() => revoke(d)}>Sign out</button>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

export function TwoFactorCard({ enabled, backupCodesLeft, onChange }: { enabled: boolean; backupCodesLeft: number; onChange: () => void }) {
  const { engine, toast } = useApp();
  const [setup, setSetup] = useState<{ secret: string; url: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const me = engine.session.user;

  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ secret: string; url: string }>('/api/me/totp/start', { body: {} });
      setSetup({ ...r, qr: await QRCode.toDataURL(r.url, { margin: 1, width: 180 }) });
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const enable = async () => {
    setBusy(true);
    try {
      const r = await api<{ backupCodes: string[] }>('/api/me/totp/enable', { body: { code } });
      setCodes(r.backupCodes); setSetup(null); setCode(''); onChange();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const disable = async () => {
    const password = prompt('Enter your password to turn two-factor sign-in off:');
    if (!password) return;
    const otp = prompt('Enter a current code from your authenticator app (or a backup code):');
    if (!otp) return;
    setBusy(true);
    try {
      const { authKey } = await passwordKeys(me.email, password);
      await api('/api/me/totp/disable', { body: { authKey, code: otp } });
      toast('Two-factor sign-in turned off'); onChange();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card col">
      <div className="row"><h2 className="grow">Two-factor sign-in</h2>
        <span className="pill" style={enabled ? { background: '#2FA86C26', color: '#2FA86C' } : { background: '#E8912D26', color: '#E8912D' }}>{enabled ? '✓ On' : 'Off'}</span></div>
      <p className="small muted">A 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) is needed in addition to your password. Strongly recommended; the owner can require it for the whole workspace.</p>
      {!enabled && !setup && <button className="btn primary" disabled={busy} onClick={start} style={{ alignSelf: 'flex-start' }}>Turn on two-factor</button>}
      {setup && (
        <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
          <img className="qr" src={setup.qr} alt="QR code for your authenticator app" />
          <div className="col grow" style={{ minWidth: 240 }}>
            <div><strong>1.</strong> Scan this code with your authenticator app, or enter the key manually:</div>
            <div className="mono small" style={{ wordBreak: 'break-all', userSelect: 'all', background: 'var(--hover)', padding: 6, borderRadius: 6 }}>{setup.secret}</div>
            <div><strong>2.</strong> Enter the 6-digit code the app shows now:</div>
            <div className="row"><input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" style={{ width: 140 }} />
              <button className="btn primary" disabled={busy || code.replace(/\D/g, '').length !== 6} onClick={enable}>Confirm</button>
              <button className="btn ghost" onClick={() => setSetup(null)}>Cancel</button></div>
          </div>
        </div>
      )}
      {enabled && (
        <div className="row wrap">
          <span className="small muted">{backupCodesLeft} backup code(s) left.</span>
          <span className="grow" />
          <button className="btn danger sm" disabled={busy} onClick={disable}>Turn off</button>
        </div>
      )}
      {codes && (
        <Modal title="Save your backup codes" onClose={() => setCodes(null)} footer={<><button className="btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy</button><button className="btn" onClick={() => window.print()}>Print</button><button className="btn primary" onClick={() => setCodes(null)}>Done</button></>}>
          <p className="small">Each code signs you in once if you lose your phone. Keep them with your recovery code. They are shown <strong>only now</strong>.</p>
          <div className="codes" style={{ padding: 12, background: 'var(--hover)', borderRadius: 8, userSelect: 'all' }}>{codes.map((c) => <div key={c}>{c}</div>)}</div>
        </Modal>
      )}
    </div>
  );
}

export function DeleteAccountCard({ onDeleted }: { onDeleted: () => void }) {
  const { engine, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!confirm('Delete your MK Prod account? Workspaces where you are the only member are deleted too. This cannot be undone.')) return;
    const password = prompt('Type your password to confirm:');
    if (!password) return;
    setBusy(true);
    try {
      const { authKey } = await passwordKeys(engine.session.user.email, password);
      await api('/api/me', { method: 'DELETE', body: { authKey } });
      onDeleted();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? e.message : (e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <div className="card col danger-zone">
      <h2>Delete your account</h2>
      <p className="small muted">Removes your profile, keys and sessions permanently. If you own a workspace with other members, transfer ownership first (owner, under Team) or delete that workspace.</p>
      <button className="btn danger" disabled={busy} onClick={run} style={{ alignSelf: 'flex-start' }}>Delete my account…</button>
    </div>
  );
}

/** Owner-only governance: two-factor requirement, ownership transfer, deletion. */
export function WorkspaceGovernanceCard({ requireMfa, lockedAt, onChanged, onDeleted }: { requireMfa: boolean; lockedAt?: string | null; onChanged: () => void; onDeleted: () => void }) {
  const { engine, toast } = useApp();
  const [target, setTarget] = useState<ID>('');
  const [busy, setBusy] = useState(false);
  const base = `/api/workspaces/${engine.workspace.id}`;
  const me = engine.session.user;
  const others = engine.team.filter((m) => m.id !== engine.me && m.publicKey);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await f(); toast(ok); onChanged(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card col">
      <h2>Workspace policy</h2>
      <label className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
        <input type="checkbox" checked={requireMfa} disabled={busy} style={{ marginTop: 3 }} onChange={(e) => {
          if (e.target.checked && !me.totpEnabled && !engine.team.find((m) => m.id === engine.me)?.totpEnabled) { toast('Turn on two-factor for your own account first'); return; }
          run(() => api(base, { method: 'PATCH', body: { requireMfa: e.target.checked } }), e.target.checked ? 'Two-factor is now required for everyone' : 'Two-factor requirement removed');
        }} />
        <span><div>Require two-factor sign-in for every member</div><div className="small muted">Members without it are locked out of this workspace (not their account) until they turn it on.</div></span>
      </label>
      <div className="col" style={{ gap: 6, padding: 10, borderRadius: 10, background: lockedAt ? 'color-mix(in srgb, var(--red) 12%, transparent)' : 'var(--hover)' }}>
        <div className="row">
          <strong className="grow">🚨 Panic mode {lockedAt && <span className="pill" style={{ background: '#E5484D26', color: '#E5484D' }}>LOCKED since {new Date(lockedAt).toLocaleString()}</span>}</strong>
          {lockedAt
            ? <button className="btn" disabled={busy} onClick={() => confirm('Unlock the workspace? Members can sign in and open it again.') && run(() => api(`${base}/lock`, { body: { locked: false } }), 'Workspace unlocked')}>Unlock workspace</button>
            : <button className="btn danger" disabled={busy} onClick={() => {
                if (prompt(`Lock "${engine.workspace.name}" now? Every other member is signed out and refused until you unlock it, and supplier links stop working. Type LOCK to confirm.`)?.trim().toUpperCase() !== 'LOCK') return;
                run(() => api(`${base}/lock`, { body: { locked: true } }), 'Workspace locked');
              }}>Lock workspace now</button>}
        </div>
        <div className="small muted">For a suspected breach or a lost device: instantly blocks everyone except you, including admins, open sessions and supplier links. Your data stays encrypted and untouched; unlock when it's safe.</div>
      </div>
      <div className="row wrap">
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Transfer ownership to…</option>{others.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}</select>
        <button className="btn" disabled={!target || busy} onClick={() => {
          const m = engine.team.find((x) => x.id === target);
          if (confirm(`Make ${m?.name} the owner? You become an admin.`)) run(() => api(`${base}/transfer`, { body: { userId: target } }), 'Ownership transferred');
        }}>Transfer</button>
      </div>
      <div className="row wrap" style={{ marginTop: 6 }}>
        <span className="small muted grow">Deleting the workspace removes every task, order, document and attachment for everyone. Export first (Reports) if you need a copy.</span>
        <button className="btn danger" disabled={busy} onClick={async () => {
          if (!confirm(`Delete "${engine.workspace.name}" for all ${engine.team.length} member(s)? This cannot be undone.`)) return;
          const password = prompt('Type your password to confirm:');
          if (!password) return;
          setBusy(true);
          try {
            const { authKey } = await passwordKeys(me.email, password);
            await api(base, { method: 'DELETE', body: { authKey } });
            onDeleted();
          } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
        }}>Delete workspace…</button>
      </div>
    </div>
  );
}
