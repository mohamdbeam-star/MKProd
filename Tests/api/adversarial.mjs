// Attacker's-eye checks against the real Worker: access control across workspaces and roles,
// brute force and flooding limits, oversized and malformed input, header hygiene, injection.
// Run through Tests/api/run.sh (needs the mail sink for the verification codes).
import fs from 'node:fs';
import net from 'node:net';
const MAIL_DIR = process.argv[2];
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8799}`;
const b64 = (u) => Buffer.from(u).toString('base64');
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

async function authKey(email, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('mkprod-v1:' + email), iterations: 1000 }, base, 512));
  return b64(bits.slice(0, 32));
}
async function raw(method, path, body, token, headers = {}) {
  const payload = body === undefined || body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(BASE + path, { method, headers: { ...(typeof body === 'string' ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: payload });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const call = raw;
const pub = () => b64(crypto.getRandomValues(new Uint8Array(65)));
const encKey = () => b64(crypto.getRandomValues(new Uint8Array(60)));
const uuid = () => crypto.randomUUID().toUpperCase();

async function verifyLatest(email, token) {
  await new Promise((r) => setTimeout(r, 800));
  const rawMail = fs.readdirSync(MAIL_DIR).sort().map((f) => fs.readFileSync(`${MAIL_DIR}/${f}`, 'utf8')).filter((m) => m.includes(`To: <${email}>`)).pop() ?? '';
  const part = rawMail.split(/--mkp-[^\r\n]+/).find((p) => p.includes('text/plain')) ?? '';
  const body = Buffer.from((part.split(/\r?\n\r?\n/)[1] ?? '').replace(/\s/g, ''), 'base64').toString('utf8');
  const code = body.match(/code is: (\d{6})/)?.[1];
  return (await call('POST', '/api/auth/verify', { code }, token)).status === 200;
}
async function user(name, email, pw) {
  const r = await call('POST', '/api/auth/signup', { email, name, authKey: await authKey(email, pw), publicKey: pub(), encPrivateKey: encKey(), wantToken: true });
  if (r.status !== 200) throw new Error(`signup ${email}: ${r.status} ${r.text}`);
  const u = { email, pw, token: r.json.token, id: r.json.user.id };
  if (!(await verifyLatest(email, u.token))) throw new Error('verify ' + email);
  return u;
}
async function workspace(owner, name) {
  const r = await call('POST', '/api/workspaces', { name }, owner.token);
  if (r.status !== 200) throw new Error('workspace ' + r.text);
  return r.json.id;
}
async function invite(owner, ws, who, role) {
  const r = await call('POST', `/api/workspaces/${ws}/invites`, { email: who.email, role }, owner.token);
  const a = await call('POST', '/api/invites/accept', { code: r.json.code }, who.token);
  if (a.status !== 200) throw new Error('accept ' + a.text);
}
const enc = (v = 1) => ({ enc: b64(crypto.getRandomValues(new Uint8Array(48))), v });

// ---------------------------------------------------------------- set-up: two workspaces, four people
const owner = await user('Owner <b>x</b>', 'adv-owner@example.test', 'owner-password-123');
const admin = await user('Admin', 'adv-admin@example.test', 'admin-password-123');
const member = await user('Member', 'adv-member@example.test', 'member-password-12');
const outsider = await user('Outsider', 'adv-outsider@example.test', 'outsider-password-1');
const wsA = await workspace(owner, 'Workspace A');
const wsB = await workspace(outsider, 'Workspace B');
await invite(owner, wsA, admin, 'admin');
await invite(owner, wsA, member, 'member');
// Encrypt A (key version 1) like a real client does.
let r = await call('POST', `/api/workspaces/${wsA}/keys`, { version: 1, wraps: [{ userId: owner.id, wrapped: encKey() }, { userId: admin.id, wrapped: encKey() }, { userId: member.id, wrapped: encKey() }] }, owner.token);
check('workspace A encrypted (key v1)', r.status === 200, r.text);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: uuid(), data: enc() }] }, owner.token);
check('owner can sync', r.status === 200 && r.json.records.length === 1, r.status);

// ---------------------------------------------------------------- 1. cross-workspace access (IDOR)
for (const [what, m, path, body] of [
  ['sync', 'POST', `/api/workspaces/${wsA}/sync`, { cursor: 0 }],
  ['team', 'GET', `/api/workspaces/${wsA}/team`],
  ['shares', 'GET', `/api/workspaces/${wsA}/shares`],
  ['security log', 'GET', `/api/workspaces/${wsA}/security`],
  ['rename', 'PATCH', `/api/workspaces/${wsA}`, { name: 'pwned' }],
  ['delete', 'DELETE', `/api/workspaces/${wsA}`, { authKey: await authKey(outsider.email, outsider.pw) }],
  ['invite', 'POST', `/api/workspaces/${wsA}/invites`, { email: 'x@y.z', role: 'admin' }],
  ['role change', 'POST', `/api/workspaces/${wsA}/members/${owner.id}/role`, { role: 'viewer' }],
  ['remove member', 'DELETE', `/api/workspaces/${wsA}/members/${member.id}`],
  ['file read', 'GET', `/api/workspaces/${wsA}/files/${uuid()}`],
]) {
  r = await call(m, path, body, outsider.token);
  check(`outsider blocked: ${what}`, r.status === 403, r.status);
}
r = await call('GET', `/api/workspaces/${wsA}/team`, null, outsider.token);
check('outsider gets no member list', !r.text.includes(owner.email));
r = await call('POST', `/api/workspaces/${wsA.toLowerCase()}/sync`, { cursor: 0 }, member.token);
check('lower-case workspace id resolves for members', r.status === 200);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0 }, outsider.token);
check('non-member sync is 403, not an empty success', r.status === 403);
r = await call('GET', `/api/workspaces/${uuid()}/team`, null, owner.token);
check('unknown workspace 403 (no existence leak)', r.status === 403);
r = await call('GET', `/api/workspaces/not-a-uuid/team`, null, owner.token);
check('malformed workspace id 404', r.status === 404);

// ---------------------------------------------------------------- 2. role boundaries inside a workspace
r = await call('POST', `/api/workspaces/${wsA}/invites`, { email: 'x@y.z', role: 'member' }, member.token);
check('member cannot invite', r.status === 403);
r = await call('PATCH', `/api/workspaces/${wsA}`, { name: 'renamed by member' }, member.token);
check('member cannot rename workspace', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/members/${member.id}/role`, { role: 'admin' }, admin.token);
check('admin cannot promote to admin', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/members/${member.id}/role`, { role: 'admin' }, member.token);
check('member cannot promote self', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/members/${owner.id}/role`, { role: 'viewer' }, admin.token);
check('owner role cannot be changed', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/members/${member.id}/role`, { role: 'owner' }, owner.token);
check('nobody can assign a second owner', r.status === 400);
r = await call('POST', `/api/workspaces/${wsA}/invites`, { email: 'x@y.z', role: 'admin' }, admin.token);
check('admin cannot invite admins', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/members/${owner.id}/password`, { authKey: await authKey('a', 'b') }, admin.token);
check('admin cannot reset the owner password', r.status === 403);
r = await call('DELETE', `/api/workspaces/${wsA}/members/${admin.id}`, null, member.token);
check('member cannot remove others', r.status === 403);
r = await call('DELETE', `/api/workspaces/${wsA}/members/${owner.id}`, null, admin.token);
check('owner cannot be removed', r.status === 403);
r = await call('DELETE', `/api/workspaces/${wsA}/members/${admin.id}`, null, admin.token);
check('admin can leave', r.status === 200);
await invite(owner, wsA, admin, 'admin');
r = await call('GET', `/api/workspaces/${wsA}/security`, null, member.token);
check('member cannot read the workspace security log', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/transfer`, { userId: member.id }, admin.token);
check('admin cannot transfer ownership', r.status === 403);

// viewer
r = await call('POST', `/api/workspaces/${wsA}/members/${member.id}/role`, { role: 'viewer' }, owner.token);
check('owner demotes member to viewer', r.status === 200);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: uuid(), data: enc() }] }, member.token);
check('viewer cannot push records', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: uuid(), deleted: true }] }, member.token);
check('viewer cannot delete records', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/shares`, { kind: 'order', refId: uuid(), blob: encKey() }, member.token);
check('viewer cannot create supplier links', r.status === 403);
r = await call('POST', `/api/workspaces/${wsA}/notify`, { notices: [{ to: owner.id, type: 'taskAssigned', subject: 'x' }] }, member.token);
check('viewer cannot send notifications', r.status === 403);
r = await call('PUT', `/api/workspaces/${wsA}/files/${uuid()}`, 'x'.repeat(100), member.token, { 'Content-Type': 'application/octet-stream', 'X-Key-Version': '1' });
check('viewer cannot upload files', r.status === 403 || r.status === 503, r.status);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0 }, member.token);
check('viewer can still read', r.status === 200 && r.json.role === 'viewer');
await call('POST', `/api/workspaces/${wsA}/members/${member.id}/role`, { role: 'member' }, owner.token);

// ---------------------------------------------------------------- 3. authentication edge cases
r = await call('GET', `/api/me?token=${owner.token}`);
check('token in the query string is ignored', r.status === 401);
r = await call('GET', '/api/me', null, owner.token.slice(0, -2) + 'AA');
check('tampered token rejected', r.status === 401);
r = await call('GET', '/api/me', null, null, { Authorization: 'Basic ' + b64('a:b') });
check('non-bearer auth rejected', r.status === 401);
r = await call('GET', '/api/apps');
check('/api/apps needs sign-in', r.status === 401);
r = await call('GET', '/api/apps', null, owner.token);
check('/api/apps for signed-in users', r.status === 200 && Array.isArray(r.json.apps));
// login: unknown email and wrong password are indistinguishable
const a1 = await call('POST', '/api/auth/login', { email: 'nobody-here@example.test', authKey: await authKey('nobody-here@example.test', 'x-password-1234'), wantToken: true });
const a2 = await call('POST', '/api/auth/login', { email: owner.email, authKey: await authKey(owner.email, 'wrong-password-1'), wantToken: true });
check('no account enumeration on login', a1.status === 401 && a2.status === 401 && a1.json.error === a2.json.error, `${a1.json.error} | ${a2.json.error}`);
r = await call('POST', '/api/auth/login', { email: owner.email, authKey: 'not-a-key', wantToken: true });
check('malformed auth key rejected (400, not 500)', r.status === 400);
r = await call('POST', '/api/auth/login', { email: { $ne: null }, authKey: await authKey('a', 'b') });
check('object instead of string → 400', r.status === 400, r.status);
// logout kills the token
const tmp = await call('POST', '/api/auth/login', { email: member.email, authKey: await authKey(member.email, member.pw), wantToken: true });
r = await call('POST', '/api/auth/logout', {}, tmp.json.token);
r = await call('GET', '/api/me', null, tmp.json.token);
check('token dead after logout', r.status === 401);
// mass assignment
r = await call('PATCH', '/api/me', { name: 'N', color: 'javascript:alert(1)', emailVerified: false, id: outsider.id, email: 'owner@evil.test' }, member.token);
const me = await call('GET', '/api/me', null, member.token);
check('PATCH /me ignores unknown fields and bad colors', r.status === 200 && me.json.user.email === member.email && me.json.user.id === member.id && /^#[0-9A-Fa-f]{6}$/.test(me.json.user.color));
r = await call('PATCH', '/api/me', { name: 'x'.repeat(5000) }, member.token);
check('name capped at 80 chars', r.status === 200 && r.json.user.name.length === 80);

// ---------------------------------------------------------------- 4. brute force and flooding
let last;
for (let i = 0; i < 22; i++) last = await call('POST', '/api/invites/accept', { code: 'AAAA-BBBB-' + String(i).padStart(4, '0') }, outsider.token);
check('invite-code guessing rate-limited (429)', last.status === 429, last.status);
const shareId = uuid();
r = await call('POST', `/api/workspaces/${wsA}/shares`, { id: shareId, kind: 'order', refId: uuid(), blob: encKey(), allowReply: true }, owner.token);
check('share created', r.status === 200);
for (let i = 0; i < 21; i++) last = await call('POST', `/api/share/${shareId}/reply`, { blob: encKey() });
check('supplier reply flood limited (429)', last.status === 429, last.status);
r = await call('POST', `/api/share/${shareId}/reply`, { blob: '<script>alert(1)</script>' });
check('non-base64 reply rejected', r.status === 400 || r.status === 429, r.status);
r = await call('GET', `/api/share/${uuid()}`);
check('unknown share: 404 with no detail', r.status === 404 && !r.text.includes('workspace'));
r = await call('GET', `/api/share/${shareId}`);
check('share response carries no workspace id or creator', r.status === 200 && !r.text.includes(wsA) && !r.text.includes(owner.id));
const noReply = uuid();
await call('POST', `/api/workspaces/${wsA}/shares`, { id: noReply, kind: 'order', refId: uuid(), blob: encKey(), allowReply: false }, owner.token);
r = await call('POST', `/api/share/${noReply}/reply`, { blob: encKey() });
check('reply refused when replies are off', r.status >= 400 && r.status !== 500, r.status);
r = await call('DELETE', `/api/workspaces/${wsB}/shares/${shareId}`, null, outsider.token);
r = await call('GET', `/api/share/${shareId}`);
check('other workspace cannot revoke my share', r.status === 200 || r.status === 429, r.status);

// ---------------------------------------------------------------- 5. malformed and oversized input
r = await call('POST', `/api/workspaces/${wsA}/sync`, '{"cursor": 0, "push": [', owner.token, { 'Content-Type': 'application/json' });
check('broken JSON → 400', r.status === 400);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks; DROP TABLE records', id: uuid(), data: enc() }] }, owner.token);
check('bad record kind → 400', r.status === 400);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: '../../etc/passwd', data: enc() }] }, owner.token);
check('bad record id → 400', r.status === 400);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: uuid(), data: { title: 'plaintext' } }] }, owner.token);
check('plaintext refused in an encrypted workspace (426)', r.status === 426);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: uuid(), data: enc(7) }] }, owner.token);
check('wrong key version refused (409)', r.status === 409);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: uuid(), data: { enc: 'A'.repeat(950 * 1024), v: 1 } }] }, owner.token);
check('record over 900 KB → 413', r.status === 413);
r = await call('POST', `/api/workspaces/${wsA}/sync`, '{"cursor":0,"x":"' + 'A'.repeat(4 * 1024 * 1024 + 10) + '"}', owner.token, { 'Content-Type': 'application/json' });
check('body over 4 MB → 413', r.status === 413, r.status);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: -5, push: 'not-an-array' }, owner.token);
check('odd cursor/push types tolerated', r.status === 200);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 'abc', viewing: 'x'.repeat(10000) }, owner.token);
check('oversized viewing string tolerated', r.status === 200);
r = await call('GET', `/api/workspaces/${wsA}/shares?ref=' OR 1=1 --`, null, owner.token);
check('SQL-ish query param harmless', r.status === 200 && r.json.shares.length === 0);
r = await call('POST', '/api/auth/signup', { email: "x'; DROP TABLE users; --@example.test", authKey: await authKey('a', 'b'), publicKey: pub(), encPrivateKey: encKey() });
check('SQL-ish email rejected or stored safely', r.status === 400 || r.status === 200 || r.status === 429, r.status);
r = await call('GET', '/api/me', null, owner.token);
check('users table intact', r.status === 200);
r = await call('POST', `/api/workspaces/${wsA}/invites`, { email: 'x@y.z', role: 'superuser' }, owner.token);
check('unknown role → 400', r.status === 400);
r = await call('POST', `/api/workspaces/${wsA}/invites`, { email: 'not an email', role: 'member' }, owner.token);
check('invalid invite email → 400', r.status === 400);
r = await call('POST', `/api/workspaces/${wsA}/shares`, { kind: 'order', refId: uuid(), blob: encKey(), days: 100000 }, owner.token);
check('share expiry capped at 90 days', r.status === 200 && new Date(r.json.expiresAt) - Date.now() < 91 * 86400_000);
r = await call('POST', `/api/workspaces/${wsA}/shares`, { kind: 'order', refId: uuid(), blob: 'A'.repeat(300 * 1024) }, owner.token);
check('share blob over 200 KB refused', r.status === 400);
r = await call('GET', '/api/workspaces/' + wsA + '/files/..%2F..%2Fetc', null, owner.token);
check('path traversal in file id → 404', r.status === 404);
r = await call('PUT', '/api/me/notifications', { email: 'yes', weeklyDigest: 1, __proto__: { polluted: true } }, owner.token);
check('notification prefs coerce/ignore odd types', r.status === 200 && typeof r.json.notifyPrefs.email === 'boolean');

// ---------------------------------------------------------------- 6. response hygiene
r = await call('GET', '/api/me', null, owner.token);
const h = (k) => r.headers.get(k) ?? '';
check('API: nosniff + no-store + HSTS + no-referrer', h('x-content-type-options') === 'nosniff' && h('cache-control') === 'no-store' && h('strict-transport-security').includes('max-age') && h('referrer-policy') === 'no-referrer');
check('API: no server fingerprint', !h('x-powered-by'));
check('me: no password hash, salt or secrets in the response', !/pw_hash|pw_salt|totp_secret|rec_hash/.test(r.text));
const page = await fetch(BASE + '/');
const ph = (k) => page.headers.get(k) ?? '';
check('site: CSP without unsafe-inline scripts', ph('content-security-policy').includes("script-src 'self'") && !ph('content-security-policy').includes("script-src 'self' 'unsafe-inline'"));
check('site: frame-ancestors none + X-Frame-Options DENY', ph('content-security-policy').includes("frame-ancestors 'none'") && ph('x-frame-options') === 'DENY');
check('site: Permissions-Policy and COOP', ph('permissions-policy').includes('camera=()') && ph('cross-origin-opener-policy') === 'same-origin');
r = await call('GET', '/api/does-not-exist', null, owner.token);
check('unknown API route → 404 JSON', r.status === 404 && r.json.error);
const traceStatus = await new Promise((resolve) => {
  const sock = net.connect(Number(new URL(BASE).port), '127.0.0.1', () => sock.write(`TRACE /api/me HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${owner.token}\r\nConnection: close\r\n\r\n`));
  let data = ''; sock.on('data', (d) => { data += d; }); sock.on('close', () => resolve(Number(data.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]) || 0)); sock.on('error', () => resolve(0));
});
check('TRACE not served (no echo of the Authorization header)', traceStatus === 404 || traceStatus === 405 || traceStatus === 400, traceStatus);
r = await raw('OPTIONS', '/api/me', undefined, null, { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' });
check('no CORS for foreign origins', !r.headers.get('access-control-allow-origin'), r.headers.get('access-control-allow-origin') ?? '');
// HTML injection into emails: the owner's name contains <b>
r = await call('POST', '/api/me/notifications/test', {}, owner.token);
await new Promise((res) => setTimeout(res, 1200));
const mails = fs.readdirSync(MAIL_DIR).sort().map((f) => fs.readFileSync(`${MAIL_DIR}/${f}`, 'utf8')).filter((m) => m.includes(`To: <${owner.email}>`) && m.includes('Test email'));
const htmlPart = (mails.pop() ?? '').split(/--mkp-[^\r\n]+/).find((p) => p.includes('text/html')) ?? '';
const html = Buffer.from((htmlPart.split(/\r?\n\r?\n/)[1] ?? '').replace(/\s/g, ''), 'base64').toString('utf8');
check('names are HTML-escaped in emails', r.status === 200 && html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), r.status);

// ---------------------------------------------------------------- 7. data isolation across workspaces
const outsiderRec = uuid();
r = await call('POST', `/api/workspaces/${wsB}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: outsiderRec, data: { title: 'B only' } }] }, outsider.token);
check('workspace B accepts its owner', r.status === 200);
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0 }, owner.token);
check('workspace A never returns B records', r.status === 200 && !r.text.includes(outsiderRec));
r = await call('POST', `/api/workspaces/${wsA}/sync`, { cursor: 0, push: [{ kind: 'tasks', id: outsiderRec, data: enc() }] }, owner.token);
r = await call('POST', `/api/workspaces/${wsB}/sync`, { cursor: 0 }, outsider.token);
check('same record id in two workspaces stays separate', r.status === 200 && r.json.records.find((x) => x.id === outsiderRec)?.data?.title === 'B only');

console.log(failures ? `\n${failures} FAILED` : '\nall adversarial checks passed');
process.exit(failures ? 1 : 0);
