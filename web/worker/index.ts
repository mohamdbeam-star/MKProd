/**
 * MK Prod sync API (Cloudflare Worker + D1).
 *
 * The Mac app and the website are both clients of this API. Every synced object is a JSON
 * row in `records`; clients push changed objects and pull everything after their cursor
 * in a single POST /api/workspaces/:id/sync call.
 *
 * Record contents are end-to-end encrypted by the clients (see SECURITY.md): once a
 * workspace has a key version, `data` is `{"enc": "...", "v": n}` and this Worker never sees
 * plaintext. Passwords are stretched on the client; the server only receives an auth key.
 *
 * Email notifications are composed by the clients (the only place data is readable) and
 * relayed here; the server checks the recipient is a member, applies their preferences,
 * de-duplicates and sends over SMTP (worker/email.ts).
 */
import { emailConfigured, escapeHtml, sendMails, type Mail, type SmtpEnv } from './email';

interface Env extends SmtpEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  PBKDF2_ITERATIONS: string;
}

type Role = 'owner' | 'admin' | 'member' | 'viewer';
interface User { id: string; email: string; name: string; color: string }

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const SESSION_DAYS = 30;
const PULL_LIMIT = 500;
const MAX_BODY = 4 * 1024 * 1024;
/** One synced object (a task with its comments, a doc…). D1 rows are capped at 1 MB anyway. */
const MAX_RECORD = 900 * 1024;
const COOKIE = 'mkp_s';
const COLORS = ['#7B68EE', '#5B8DEF', '#3DBE7A', '#F0A33A', '#E5484D', '#D6409F', '#12B5CB', '#8E5CF7'];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- routing

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  if (p === '/api/health') return json({ ok: true });
  if (p === '/api/auth/signup' && m === 'POST') return signup(req, env);
  if (p === '/api/auth/login' && m === 'POST') return login(req, env);
  if (p === '/api/auth/recover' && m === 'POST') return recoverStart(req, env);

  const { user, tokenHash, kind } = await authenticate(req, env);
  if (p === '/api/auth/logout' && m === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }
  if (p === '/api/auth/recover/finish' && m === 'POST') return recoverFinish(req, env, user, tokenHash, kind);
  if (kind !== 'normal') throw new HttpError(403, 'Finish account recovery first');

  if (p === '/api/auth/password' && m === 'POST') return changePassword(req, env, user, tokenHash);
  if (p === '/api/auth/sessions' && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, tokenHash).run();
    return json({ ok: true });
  }
  if (p === '/api/me' && m === 'GET') return me(env, user);
  if (p === '/api/me' && m === 'PATCH') return updateMe(req, env, user);
  if (p === '/api/me/keys' && m === 'PUT') return setKeys(req, env, user);
  if (p === '/api/me/recovery' && m === 'PUT') return setRecovery(req, env, user);
  if (p === '/api/me/notifications' && m === 'PUT') return setNotifyPrefs(req, env, user);
  if (p === '/api/me/notifications/test' && m === 'POST') return testEmail(env, user);
  if (p === '/api/invites/accept' && m === 'POST') return acceptInvite(req, env, user);
  if (p === '/api/workspaces' && m === 'POST') return createWorkspace(req, env, user);

  const ws = p.match(/^\/api\/workspaces\/([0-9A-Fa-f-]{36})(\/.*)?$/);
  if (!ws) throw new HttpError(404, 'Not found');
  const wsId = ws[1].toUpperCase();
  const sub = ws[2] ?? '';
  const role = await roleOf(env, wsId, user.id);
  if (!role) throw new HttpError(403, 'You are not a member of this workspace');

  if (sub === '/sync' && m === 'POST') return sync(req, env, wsId, user, role);
  if (sub === '/keys' && m === 'POST') return addKeys(req, env, wsId, user, role);
  if (sub === '/team' && m === 'GET') return team(env, wsId, role);
  if (sub === '/notify' && m === 'POST') return notify(req, env, wsId, user, role);
  if (sub === '' && m === 'PATCH') {
    requireAdmin(role);
    const { name } = await body<{ name: string }>(req);
    await env.DB.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind(str(name, 120), wsId).run();
    return json({ ok: true });
  }
  if (sub === '/invites' && m === 'POST') {
    requireAdmin(role);
    const b = await body<{ email: string; role: Role }>(req);
    const email = normEmail(b.email);
    const r = oneOf(b.role, ['admin', 'member', 'viewer']);
    if (r === 'admin' && role !== 'owner') throw new HttpError(403, 'Only the owner can invite admins');
    const code = inviteCode();
    const expires = new Date(Date.now() + 14 * 86400_000).toISOString();
    await env.DB.prepare('INSERT OR REPLACE INTO invites (workspace_id, email, role, invited_by, code_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(wsId, email, r, user.id, await sha256(normCode(code)), expires).run();
    // The code is shown once to the admin, who passes it to the teammate.
    return json({ code, expiresAt: expires });
  }
  const inv = sub.match(/^\/invites\/(.+)$/);
  if (inv && m === 'DELETE') {
    requireAdmin(role);
    await env.DB.prepare('DELETE FROM invites WHERE workspace_id = ? AND email = ?').bind(wsId, decodeURIComponent(inv[1])).run();
    return json({ ok: true });
  }
  const mem = sub.match(/^\/members\/([0-9A-Fa-f-]{36})(\/role|\/password)?$/);
  if (mem) {
    const target = mem[1].toUpperCase();
    const targetRole = await roleOf(env, wsId, target);
    if (!targetRole) throw new HttpError(404, 'Member not found');
    if (mem[2] === '/role' && m === 'POST') {
      const r = oneOf((await body<{ role: string }>(req)).role, ['admin', 'member', 'viewer']);
      if (targetRole === 'owner') throw new HttpError(403, 'The owner role cannot be changed');
      if (role !== 'owner' && (r === 'admin' || targetRole === 'admin' || role !== 'admin')) throw new HttpError(403, 'Not allowed');
      await env.DB.prepare('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?').bind(r, wsId, target).run();
      return json({ ok: true });
    }
    if (mem[2] === '/password' && m === 'POST') {
      // Admin reset. The admin's client picks a temporary password and sends only its auth key.
      // The member's key pair is discarded (it was locked with the old password); teammates
      // re-share the workspace key once they sign in and create a new one.
      requireAdmin(role);
      if (targetRole === 'owner' && role !== 'owner') throw new HttpError(403, 'Not allowed');
      const { authKey } = await body<{ authKey: string }>(req);
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, pw_iter = 0, public_key = NULL, enc_private_key = NULL, rec_hash = NULL, rec_salt = NULL, enc_private_key_rec = NULL WHERE id = ?')
          .bind(await authHash(authKey, salt), salt, target),
        env.DB.prepare('DELETE FROM workspace_keys WHERE user_id = ?').bind(target),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target),
      ]);
      return json({ ok: true });
    }
    if (!mem[2] && m === 'DELETE') {
      if (target !== user.id) requireAdmin(role);
      if (targetRole === 'owner') throw new HttpError(403, 'The owner cannot be removed');
      if (targetRole === 'admin' && role !== 'owner' && target !== user.id) throw new HttpError(403, 'Not allowed');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM members WHERE workspace_id = ? AND user_id = ?').bind(wsId, target),
        env.DB.prepare('DELETE FROM presence WHERE workspace_id = ? AND user_id = ?').bind(wsId, target),
        env.DB.prepare('DELETE FROM workspace_keys WHERE workspace_id = ? AND user_id = ?').bind(wsId, target),
      ]);
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- auth

interface UserRow extends User {
  pw_hash: string; pw_salt: string; pw_iter: number; pw_scheme: number
  public_key: string | null; enc_private_key: string | null
}

function publicUser(u: UserRow) {
  return {
    id: u.id, email: u.email, name: u.name, color: u.color,
    publicKey: u.public_key, encPrivateKey: u.enc_private_key,
  };
}

async function signup(req: Request, env: Env): Promise<Response> {
  await rateLimit(env, `signup:${ip(req)}`, 10, 3600);
  const b = await body<{ email: string; authKey: string; name?: string; publicKey?: string; encPrivateKey?: string; wantToken?: boolean }>(req);
  const email = normEmail(b.email);
  const authKey = checkAuthKey(b.authKey);
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
  const id = crypto.randomUUID().toUpperCase();
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const name = str(b.name || email.split('@')[0], 80);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  await env.DB.prepare(
    'INSERT INTO users (id, email, name, color, pw_hash, pw_salt, pw_iter, pw_scheme, public_key, enc_private_key) VALUES (?, ?, ?, ?, ?, ?, 0, 2, ?, ?)',
  ).bind(id, email, name, color, await authHash(authKey, salt), salt, keyField(b.publicKey, 120), keyField(b.encPrivateKey, 200)).run();
  const token = await newSession(env, id);
  const user = { id, email, name, color, publicKey: b.publicKey ?? null, encPrivateKey: b.encPrivateKey ?? null };
  return json(b.wantToken ? { token, user } : { user }, 200, { 'Set-Cookie': cookie(token) });
}

async function login(req: Request, env: Env): Promise<Response> {
  const b = await body<{ email: string; authKey: string; password?: string; wantToken?: boolean }>(req);
  const email = normEmail(b.email);
  await rateLimit(env, `login-ip:${ip(req)}`, 60, 900);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(email, since).first<{ n: number }>();
  if ((fails?.n ?? 0) >= 8) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  const authKey = checkAuthKey(b.authKey);
  let ok = false;
  if (u?.pw_scheme === 2) {
    ok = timingSafeEqual(await authHash(authKey, u.pw_salt), u.pw_hash);
  } else if (u) {
    // Account created before client-side stretching: verify the raw password once, then upgrade.
    if (typeof b.password !== 'string') throw new HttpError(409, 'Account upgrade needed', { legacy: true });
    ok = timingSafeEqual(await pbkdf2(b.password, u.pw_salt, u.pw_iter), u.pw_hash);
    if (ok) {
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, pw_iter = 0 WHERE id = ?').bind(await authHash(authKey, salt), salt, u.id).run();
    }
  }
  if (!u || !ok) {
    await env.DB.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, new Date().toISOString()).run();
    throw new HttpError(401, 'Invalid email or password');
  }
  // Housekeeping on every successful login: expired sessions and stale throttling rows.
  // login_failures and rate_events hold email addresses and IPs, so they are not kept beyond their use.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_failures WHERE email = ? OR at < ?').bind(email, new Date(Date.now() - 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()),
    env.DB.prepare('DELETE FROM rate_events WHERE at < ?').bind(new Date(Date.now() - 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM notify_log WHERE sent_at < ?').bind(new Date(Date.now() - 180 * 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(new Date(Date.now() - 7 * 86400_000).toISOString()),
  ]);
  const token = await newSession(env, u.id);
  // Browsers get only the HttpOnly cookie; native apps ask for the token to keep in their keychain.
  return json(b.wantToken ? { token, user: publicUser(u) } : { user: publicUser(u) }, 200, { 'Set-Cookie': cookie(token) });
}

async function changePassword(req: Request, env: Env, user: User, tokenHash: string): Promise<Response> {
  const b = await body<{ currentAuthKey: string; newAuthKey: string; encPrivateKey: string }>(req);
  const row = await env.DB.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').bind(user.id).first<{ pw_hash: string; pw_salt: string }>();
  if (!row || !timingSafeEqual(await authHash(checkAuthKey(b.currentAuthKey), row.pw_salt), row.pw_hash)) {
    throw new HttpError(401, 'Current password is incorrect');
  }
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, enc_private_key = ? WHERE id = ?')
      .bind(await authHash(checkAuthKey(b.newAuthKey), salt), salt, keyField(b.encPrivateKey, 200), user.id),
    // Keep this session, sign out everywhere else.
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, tokenHash),
  ]);
  return json({ ok: true });
}

/** First key pair for an account (new account, legacy account, or after an admin reset). */
async function setKeys(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<{ publicKey: string; encPrivateKey: string }>(req);
  const cur = await env.DB.prepare('SELECT public_key FROM users WHERE id = ?').bind(user.id).first<{ public_key: string | null }>();
  if (cur?.public_key) throw new HttpError(409, 'This account already has encryption keys');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET public_key = ?, enc_private_key = ? WHERE id = ?').bind(keyField(b.publicKey, 120), keyField(b.encPrivateKey, 200), user.id),
    env.DB.prepare('DELETE FROM workspace_keys WHERE user_id = ?').bind(user.id),
  ]);
  return json({ ok: true });
}

async function setRecovery(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<{ recAuth: string; encPrivateKeyRec: string }>(req);
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('UPDATE users SET rec_hash = ?, rec_salt = ?, enc_private_key_rec = ? WHERE id = ?')
    .bind(await authHash(checkAuthKey(b.recAuth), salt), salt, keyField(b.encPrivateKeyRec, 200), user.id).run();
  return json({ ok: true });
}

/** Step 1 of recovery: prove the recovery code, receive the recovery-wrapped private key. */
async function recoverStart(req: Request, env: Env): Promise<Response> {
  await rateLimit(env, `recover:${ip(req)}`, 10, 3600);
  const b = await body<{ email: string; recAuth: string }>(req);
  const email = normEmail(b.email);
  const u = await env.DB.prepare('SELECT id, rec_hash, rec_salt, enc_private_key_rec FROM users WHERE email = ?')
    .bind(email).first<{ id: string; rec_hash: string | null; rec_salt: string | null; enc_private_key_rec: string | null }>();
  const ok = u?.rec_hash && u.rec_salt && timingSafeEqual(await authHash(checkAuthKey(b.recAuth), u.rec_salt), u.rec_hash);
  if (!u || !ok) {
    await env.DB.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, new Date().toISOString()).run();
    throw new HttpError(401, 'Recovery code is incorrect');
  }
  const token = await newSession(env, u.id, 'recovery', 15 * 60_000);
  return json({ token, encPrivateKeyRec: u.enc_private_key_rec });
}

/** Step 2: set a new password (and the private key re-locked with it). */
async function recoverFinish(req: Request, env: Env, user: User, tokenHash: string, kind: string): Promise<Response> {
  if (kind !== 'recovery') throw new HttpError(403, 'Not a recovery session');
  const b = await body<{ newAuthKey: string; encPrivateKey: string; wantToken?: boolean }>(req);
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, enc_private_key = ? WHERE id = ?')
      .bind(await authHash(checkAuthKey(b.newAuthKey), salt), salt, keyField(b.encPrivateKey, 200), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  const token = await newSession(env, user.id);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<UserRow>();
  return json(b.wantToken ? { token, user: publicUser(u!) } : { user: publicUser(u!) }, 200, { 'Set-Cookie': cookie(token) });
}

async function authenticate(req: Request, env: Env): Promise<{ user: User; tokenHash: string; kind: string }> {
  let token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) {
    token = readCookie(req, COOKIE) ?? '';
    // Cookie sessions must come from our own page: block cross-site form posts (CSRF).
    if (token && req.method !== 'GET' && req.headers.get('X-MKProd') !== '1') throw new HttpError(403, 'Missing request header');
  }
  if (!token) throw new HttpError(401, 'Sign in required');
  const tokenHash = await sha256(token);
  const u = await env.DB.prepare(
    'SELECT u.id, u.email, u.name, u.color, s.kind FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(tokenHash, new Date().toISOString()).first<User & { kind: string }>();
  if (!u) throw new HttpError(401, 'Your session expired. Please sign in again.');
  return { user: { id: u.id, email: u.email, name: u.name, color: u.color }, tokenHash, kind: u.kind };
}

async function newSession(env: Env, userId: string, kind = 'normal', ttlMs = SESSION_DAYS * 86400_000): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + ttlMs).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, kind) VALUES (?, ?, ?, ?)').bind(await sha256(token), userId, expires, kind).run();
  return token;
}

async function acceptInvite(req: Request, env: Env, user: User): Promise<Response> {
  await rateLimit(env, `invite:${user.id}`, 20, 3600);
  const { code } = await body<{ code: string }>(req);
  const inv = await env.DB.prepare('SELECT workspace_id, role, expires_at FROM invites WHERE email = ? AND code_hash = ?')
    .bind(user.email.toLowerCase(), await sha256(normCode(code))).first<{ workspace_id: string; role: Role; expires_at: string | null }>();
  if (!inv) throw new HttpError(404, 'That invite code is not valid for your email address');
  if (inv.expires_at && inv.expires_at < new Date().toISOString()) throw new HttpError(410, 'This invite has expired. Ask for a new one.');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO members (workspace_id, user_id, role) VALUES (?, ?, ?)').bind(inv.workspace_id, user.id, inv.role),
    env.DB.prepare('DELETE FROM invites WHERE workspace_id = ? AND email = ?').bind(inv.workspace_id, user.email.toLowerCase()),
  ]);
  const w = await env.DB.prepare('SELECT id, name FROM workspaces WHERE id = ?').bind(inv.workspace_id).first<{ id: string; name: string }>();
  return json({ workspace: { ...w, role: inv.role } });
}

// ---------------------------------------------------------------- profile & workspaces

async function me(env: Env, user: User): Promise<Response> {
  const [ws, u] = await env.DB.batch([
    env.DB.prepare('SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at').bind(user.id),
    env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id),
  ]);
  const row = u.results[0] as unknown as UserRow & { rec_hash: string | null; notify_prefs: string | null };
  return json({
    user: { ...publicUser(row), hasRecovery: !!row.rec_hash, notifyPrefs: prefsOf(row.notify_prefs) },
    workspaces: ws.results, emailEnabled: emailConfigured(env),
  });
}

async function updateMe(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<{ name?: string; color?: string }>(req);
  const name = b.name !== undefined ? str(b.name, 80) : user.name;
  const color = b.color && /^#[0-9A-Fa-f]{6}$/.test(b.color) ? b.color : user.color;
  await env.DB.prepare('UPDATE users SET name = ?, color = ? WHERE id = ?').bind(name, color, user.id).run();
  return json({ user: { ...user, name, color } });
}

async function createWorkspace(req: Request, env: Env, user: User): Promise<Response> {
  const { name } = await body<{ name: string }>(req);
  const id = crypto.randomUUID().toUpperCase();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)').bind(id, str(name || 'Workspace', 120), user.id),
    env.DB.prepare("INSERT INTO members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user.id),
    env.DB.prepare('INSERT INTO counters (workspace_id, seq) VALUES (?, 0)').bind(id),
  ]);
  return json({ id });
}

async function team(env: Env, wsId: string, role: Role): Promise<Response> {
  const [w, mem, inv] = await env.DB.batch([
    env.DB.prepare('SELECT name, key_version FROM workspaces WHERE id = ?').bind(wsId),
    membersQuery(env, wsId),
    env.DB.prepare('SELECT email, role, expires_at FROM invites WHERE workspace_id = ? ORDER BY created_at').bind(wsId),
  ]);
  const wr = w.results[0] as { name: string; key_version: number } | undefined;
  return json({
    name: wr?.name ?? '', keyVersion: wr?.key_version ?? 0, role,
    members: mem.results,
    invites: role === 'owner' || role === 'admin' ? inv.results : [],
  });
}

function membersQuery(env: Env, wsId: string) {
  return env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.color, m.role, u.public_key AS publicKey,
           EXISTS (SELECT 1 FROM workspace_keys k JOIN workspaces w ON w.id = k.workspace_id
                   WHERE k.workspace_id = m.workspace_id AND k.user_id = u.id AND k.version = w.key_version) AS hasKey
    FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.joined_at`).bind(wsId);
}

// ---------------------------------------------------------------- workspace keys

/**
 * Share wrapped workspace keys. Any writer may share the *current* version with members who
 * lack it; starting a new version (first encryption or rotation) is admin-only and must
 * include the caller's own copy.
 */
async function addKeys(req: Request, env: Env, wsId: string, user: User, role: Role): Promise<Response> {
  const b = await body<{ version: number; wraps: { userId: string; wrapped: string }[] }>(req);
  const w = await env.DB.prepare('SELECT key_version FROM workspaces WHERE id = ?').bind(wsId).first<{ key_version: number }>();
  const current = w?.key_version ?? 0;
  const version = Number(b.version);
  if (!Array.isArray(b.wraps) || !b.wraps.length || b.wraps.length > 500) throw new HttpError(400, 'No keys');
  if (version === current + 1) {
    requireAdmin(role);
    if (!b.wraps.some((x) => x.userId?.toUpperCase() === user.id)) throw new HttpError(400, 'Include your own key');
  } else if (version !== current || current === 0) {
    throw new HttpError(409, 'Key version changed; sync and try again', { keyVersion: current });
  } else if (role === 'viewer') {
    throw new HttpError(403, 'Viewers cannot share keys');
  }
  const members = new Set(((await env.DB.prepare('SELECT user_id FROM members WHERE workspace_id = ?').bind(wsId).all()).results as { user_id: string }[]).map((r) => r.user_id));
  const stmts = b.wraps.filter((x) => members.has(String(x.userId).toUpperCase())).map((x) =>
    env.DB.prepare('INSERT OR IGNORE INTO workspace_keys (workspace_id, user_id, version, wrapped) VALUES (?, ?, ?, ?)')
      .bind(wsId, String(x.userId).toUpperCase(), version, keyField(x.wrapped, 400)));
  if (version === current + 1) stmts.push(env.DB.prepare('UPDATE workspaces SET key_version = ? WHERE id = ? AND key_version = ?').bind(version, wsId, current));
  await env.DB.batch(stmts);
  return json({ ok: true, keyVersion: version });
}

// ---------------------------------------------------------------- sync

interface PushRecord { kind: string; id: string; data?: unknown; deleted?: boolean }

async function sync(req: Request, env: Env, wsId: string, user: User, role: Role): Promise<Response> {
  const b = await body<{ cursor?: number; push?: PushRecord[]; viewing?: string; client?: string }>(req);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const push = Array.isArray(b.push) ? b.push : [];
  const w = await env.DB.prepare('SELECT key_version FROM workspaces WHERE id = ?').bind(wsId).first<{ key_version: number }>();
  const keyVersion = w?.key_version ?? 0;

  if (push.length) {
    if (role === 'viewer') throw new HttpError(403, 'Viewers cannot make changes');
    const rows = push.map((r) => {
      if (typeof r.kind !== 'string' || !/^[a-zA-Z]{1,40}$/.test(r.kind)) throw new HttpError(400, 'Bad record kind');
      if (typeof r.id !== 'string' || !/^[0-9A-Fa-f-]{36}$/.test(r.id)) throw new HttpError(400, 'Bad record id');
      if (!r.deleted && keyVersion > 0) {
        // Once a workspace is encrypted, refuse plaintext (e.g. from an outdated client).
        const d = r.data as { enc?: unknown; v?: unknown } | undefined;
        if (!d || typeof d.enc !== 'string' || typeof d.v !== 'number') throw new HttpError(426, 'This workspace is end-to-end encrypted. Update the app.', { keyVersion });
        // Only the current key version, so members added after a rotation can read every record.
        if (d.v !== keyVersion) throw new HttpError(409, 'Encryption key changed; sync and try again', { keyVersion });
      }
      const d = r.deleted ? '{}' : JSON.stringify(r.data ?? {});
      if (d.length > MAX_RECORD) throw new HttpError(413, 'One item is too large to sync (over 900 KB). Attach big files by link instead.');
      return { k: r.kind, i: r.id.toUpperCase(), d, x: r.deleted ? 1 : 0 };
    });
    // One transaction: assign consecutive sequence numbers and upsert every row.
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO records (workspace_id, kind, id, data, deleted, seq, updated_at, updated_by)
        SELECT ?1, j.value ->> 'k', j.value ->> 'i', j.value ->> 'd', j.value ->> 'x',
               (SELECT seq FROM counters WHERE workspace_id = ?1) + j.key + 1, ?2, ?3
        FROM json_each(?4) AS j WHERE true
        ON CONFLICT (workspace_id, kind, id) DO UPDATE SET
          data = excluded.data, deleted = excluded.deleted, seq = excluded.seq,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(wsId, now, user.id, JSON.stringify(rows)),
      env.DB.prepare('UPDATE counters SET seq = seq + ? WHERE workspace_id = ?').bind(rows.length, wsId),
    ]);
  }

  const cursor = Math.max(0, Number(b.cursor) || 0);
  const viewing = str(b.viewing ?? '', 200);
  const recent = new Date(Date.now() - 20_000).toISOString();
  const [recs, , pres, mem, keys] = await env.DB.batch([
    env.DB.prepare('SELECT kind, id, data, deleted, seq, updated_by FROM records WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .bind(wsId, cursor, PULL_LIMIT),
    // Presence: write at most every 20 s unless what the user is viewing changed.
    env.DB.prepare(`
      INSERT INTO presence (workspace_id, user_id, viewing, client, last_seen) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET viewing = excluded.viewing, client = excluded.client, last_seen = excluded.last_seen
      WHERE presence.viewing != excluded.viewing OR presence.last_seen < ?6`).bind(wsId, user.id, viewing, str(b.client ?? '', 20), now, recent),
    env.DB.prepare('SELECT user_id, viewing, client, last_seen FROM presence WHERE workspace_id = ? AND last_seen > ?')
      .bind(wsId, new Date(Date.now() - 60_000).toISOString()),
    membersQuery(env, wsId),
    env.DB.prepare('SELECT version, wrapped FROM workspace_keys WHERE workspace_id = ? AND user_id = ? ORDER BY version').bind(wsId, user.id),
  ]);

  type Row = { kind: string; id: string; data: string; deleted: number; seq: number; updated_by: string };
  const rows = recs.results as Row[];
  // Splice stored JSON in directly instead of parsing and re-serializing it.
  const records = rows.map((r) =>
    `{"kind":${JSON.stringify(r.kind)},"id":${JSON.stringify(r.id)},"deleted":${r.deleted ? 'true' : 'false'},"seq":${r.seq},"updatedBy":${JSON.stringify(r.updated_by)},"data":${r.data}}`,
  );
  const next = rows.length ? rows[rows.length - 1].seq : cursor;
  const out = `{"cursor":${next},"more":${rows.length === PULL_LIMIT},"role":${JSON.stringify(role)},"keyVersion":${keyVersion},` +
    `"myKeys":${JSON.stringify(keys.results)},"members":${JSON.stringify(mem.results)},"presence":${JSON.stringify(pres.results)},"records":[${records.join(',')}]}`;
  return new Response(out, { headers: headers() });
}

// ---------------------------------------------------------------- helpers

// ---------------------------------------------------------------- email notifications

const NOTICE_TYPES = ['taskAssigned', 'taskUpdated', 'contractExpiring', 'approvals', 'mentions'] as const;
type NoticeType = (typeof NOTICE_TYPES)[number];
type NotifyPrefs = { email: boolean; includeDetails: boolean } & Record<NoticeType, boolean>;
const DEFAULT_PREFS: NotifyPrefs = {
  email: true, includeDetails: true, taskAssigned: true, taskUpdated: true, contractExpiring: true, approvals: true, mentions: true,
};

function prefsOf(raw: string | null | undefined): NotifyPrefs {
  let saved: Record<string, unknown> = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { /* corrupt row: defaults */ }
  const out = { ...DEFAULT_PREFS };
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof NotifyPrefs)[]) if (typeof saved[k] === 'boolean') out[k] = saved[k] as boolean;
  return out;
}

async function setNotifyPrefs(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<Partial<NotifyPrefs>>(req);
  const prefs = prefsOf(JSON.stringify(b));
  await env.DB.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').bind(JSON.stringify(prefs), user.id).run();
  return json({ notifyPrefs: prefs });
}

async function testEmail(env: Env, user: User): Promise<Response> {
  if (!emailConfigured(env)) throw new HttpError(503, 'Email is not set up on this server yet (see CLOUD_SETUP.md).');
  await rateLimit(env, `testmail:${user.id}`, 5, 3600);
  await sendMails(env, 'MK Prod', [renderMail(user.email, user.name, 'Test email from MK Prod', ['Email notifications are working for your account.'], '')]);
  return json({ ok: true });
}

interface Notice { to: string; type: string; subject: string; lines?: string[]; generic?: string; dedupe?: string }

/**
 * Relays notification emails composed by a client. Recipients must be members of the
 * workspace; each recipient's preferences decide whether it is sent and whether details
 * (task titles etc.) are included or replaced by the generic line.
 */
async function notify(req: Request, env: Env, wsId: string, user: User, role: Role): Promise<Response> {
  if (role === 'viewer') throw new HttpError(403, 'Viewers cannot send notifications');
  const b = await body<{ notices: Notice[] }>(req);
  const notices = Array.isArray(b.notices) ? b.notices.slice(0, 50) : [];
  if (!notices.length) return json({ sent: 0, skipped: 0 });
  if (!emailConfigured(env)) return json({ sent: 0, skipped: notices.length, emailEnabled: false });
  await rateLimit(env, `notify:${user.id}`, 60, 3600);

  const rows = (await env.DB.prepare('SELECT u.id, u.email, u.name, u.notify_prefs FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?')
    .bind(wsId).all()).results as { id: string; email: string; name: string; notify_prefs: string | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const wsName = (await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(wsId).first<{ name: string }>())?.name ?? 'MK Prod';
  const now = new Date().toISOString();
  const mails: Mail[] = [];
  const logged: [string, string][] = [];
  let skipped = 0;
  for (const n of notices) {
    const to = byId.get(String(n.to ?? '').toUpperCase());
    const type = NOTICE_TYPES.includes(n.type as NoticeType) ? (n.type as NoticeType) : null;
    // Task events go to others; contract reminders may go to the sender too.
    if (!to || !type || (to.id === user.id && type !== 'contractExpiring')) { skipped++; continue; }
    const prefs = prefsOf(to.notify_prefs);
    if (!prefs.email || !prefs[type]) { skipped++; continue; }
    const dedupe = str(n.dedupe || crypto.randomUUID(), 200);
    const fresh = await env.DB.prepare('INSERT OR IGNORE INTO notify_log (workspace_id, user_id, dedupe, sent_at) VALUES (?, ?, ?, ?)')
      .bind(wsId, to.id, `${type}:${dedupe}`, now).run();
    if (!fresh.meta.changes) { skipped++; continue; }
    logged.push([to.id, `${type}:${dedupe}`]);
    const detailed = prefs.includeDetails;
    const subject = detailed ? str(n.subject, 200) : str(n.generic || 'You have a new notification', 200);
    const lines = detailed ? (Array.isArray(n.lines) ? n.lines : []).slice(0, 12).map((l) => str(l, 500)) : [str(n.generic || subject, 500)];
    mails.push(renderMail(to.email, to.name, subject, [...lines, `From ${user.name || user.email} in ${wsName}.`], 'You can turn these emails off in MK Prod › Settings › Notifications.'));
  }
  if (!mails.length) return json({ sent: 0, skipped });
  try {
    const sent = await sendMails(env, 'MK Prod', mails);
    return json({ sent, skipped });
  } catch (e) {
    console.error('notify send failed', e);
    // Forget the de-dupe marks so a later attempt can send them.
    await env.DB.batch(logged.map(([uid, d]) => env.DB.prepare('DELETE FROM notify_log WHERE workspace_id = ? AND user_id = ? AND dedupe = ?').bind(wsId, uid, d)));
    throw new HttpError(502, 'The email server rejected the message. Check the SMTP settings.');
  }
}

function renderMail(to: string, name: string, subject: string, lines: string[], footer: string): Mail {
  const greeting = `Hi ${name || to.split('@')[0]},`;
  const text = [greeting, '', ...lines, '', footer].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1f2330;max-width:560px">
<div style="font-weight:700;color:#7B68EE;font-size:16px;margin-bottom:12px">MK Prod</div>
<p>${escapeHtml(greeting)}</p>${lines.map((l) => `<p style="margin:6px 0">${escapeHtml(l)}</p>`).join('')}
<p style="color:#8a8f98;font-size:12px;margin-top:20px">${escapeHtml(footer)}</p></div>`;
  return { to, subject: `[MK Prod] ${subject}`, text, html };
}

async function roleOf(env: Env, wsId: string, userId: string): Promise<Role | null> {
  const r = await env.DB.prepare('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?').bind(wsId, userId).first<{ role: Role }>();
  return r?.role ?? null;
}

function requireAdmin(role: Role) {
  if (role !== 'owner' && role !== 'admin') throw new HttpError(403, 'Only owners and admins can do this');
}

async function rateLimit(env: Env, bucket: string, max: number, windowSec: number) {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND at > ?').bind(bucket, since).first<{ n: number }>();
  if ((r?.n ?? 0) >= max) throw new HttpError(429, 'Too many requests. Please wait and try again.');
  await env.DB.prepare('INSERT INTO rate_events (bucket, at) VALUES (?, ?)').bind(bucket, new Date().toISOString()).run();
}

function ip(req: Request) {
  return req.headers.get('CF-Connecting-IP') ?? 'local';
}

async function body<T>(req: Request): Promise<T> {
  const len = Number(req.headers.get('Content-Length') ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Request too large');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large');
  try { return (text ? JSON.parse(text) : {}) as T; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function headers(extra: Record<string, string> = {}): HeadersInit {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: headers(extra) });
}

function cookie(token: string) {
  return `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function oneOf<T extends string>(v: unknown, allowed: T[]): T {
  if (!allowed.includes(v as T)) throw new HttpError(400, `Must be one of: ${allowed.join(', ')}`);
  return v as T;
}

function normEmail(v: unknown): string {
  const e = str(v, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Enter a valid email address');
  return e;
}

/** Auth keys are 32-byte values (base64), derived on the client. */
function checkAuthKey(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(v)) throw new HttpError(400, 'Update the app to sign in');
  return v;
}

function keyField(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9+/=]+$/.test(v)) throw new HttpError(400, 'Bad key data');
  return v;
}

function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((x) => alphabet[x % alphabet.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const normCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function authHash(authKey: string, salt: string): Promise<string> {
  const a = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
  const b2 = Uint8Array.from(atob(authKey), (c) => c.charCodeAt(0));
  const all = new Uint8Array(a.length + b2.length);
  all.set(a); all.set(b2, a.length);
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', all)));
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, key, 256);
  return b64(new Uint8Array(bits));
}

async function sha256(s: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
