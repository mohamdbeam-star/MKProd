// End-to-end smoke test of the core sync API (Node 20+, WebCrypto). Run through Tests/api/run.sh.
import fs from 'node:fs';
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
async function call(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const pub = () => b64(crypto.getRandomValues(new Uint8Array(65)));
const encKey = () => b64(crypto.getRandomValues(new Uint8Array(60)));


// With a mail server configured, new accounts must confirm their email before creating or joining workspaces.
async function verifyLatest(email, token) {
  await new Promise((r) => setTimeout(r, 800));
  const raw = fs.readdirSync(MAIL_DIR).sort().map((f) => fs.readFileSync(`${MAIL_DIR}/${f}`, 'utf8')).filter((m) => m.includes(`To: <${email}>`)).pop() ?? '';
  const part = raw.split(/--mkp-[^\r\n]+/).find((p) => p.includes('text/plain')) ?? '';
  const body = Buffer.from((part.split(/\r?\n\r?\n/)[1] ?? '').replace(/\s/g, ''), 'base64').toString('utf8');
  const code = body.match(/code is: (\d{6})/)?.[1];
  const r = await call('POST', '/api/auth/verify', { code }, token);
  return r.status === 200;
}

const alice = { email: 'alice@example.test', pw: 'alice-password-123' };
const bob = { email: 'bob@example.test', pw: 'bob-password-12345' };

// signup
let r = await call('POST', '/api/auth/signup', { email: alice.email, name: 'Alice', authKey: await authKey(alice.email, alice.pw), publicKey: pub(), encPrivateKey: encKey(), wantToken: true });
check('signup alice', r.status === 200 && r.json.token, r.status);
alice.token = r.json.token; alice.id = r.json.user.id;
check('alice verifies email', await verifyLatest(alice.email, alice.token));
r = await call('POST', '/api/auth/signup', { email: alice.email, authKey: await authKey(alice.email, alice.pw) });
check('duplicate signup rejected', r.status === 409);
r = await call('POST', '/api/auth/signup', { email: bob.email, name: 'Bob', authKey: await authKey(bob.email, bob.pw), publicKey: pub(), encPrivateKey: encKey(), wantToken: true });
bob.token = r.json.token; bob.id = r.json.user.id;
check('signup bob', r.status === 200);
check('bob verifies email', await verifyLatest(bob.email, bob.token));

// login good / bad / lockout
r = await call('POST', '/api/auth/login', { email: alice.email, authKey: await authKey(alice.email, alice.pw), wantToken: true });
check('login alice', r.status === 200 && r.json.token);
r = await call('POST', '/api/auth/login', { email: alice.email, authKey: await authKey(alice.email, 'wrong-password-1'), wantToken: true });
check('bad password 401', r.status === 401);
for (let i = 0; i < 8; i++) await call('POST', '/api/auth/login', { email: alice.email, authKey: await authKey(alice.email, 'wrong-' + i), wantToken: true });
r = await call('POST', '/api/auth/login', { email: alice.email, authKey: await authKey(alice.email, alice.pw), wantToken: true });
check('lockout after 8 failures', r.status === 429, r.status);

// cookie session + CSRF header
r = await call('POST', '/api/auth/login', { email: bob.email, authKey: await authKey(bob.email, bob.pw) });
const cookie = r.headers.get('set-cookie') ?? '';
check('cookie is HttpOnly/Secure/Strict', /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie), cookie.slice(0, 60));
const ck = cookie.split(';')[0];
r = await call('POST', '/api/workspaces', { name: 'x' }, null, { Cookie: ck });
check('cookie POST without X-MKProd blocked', r.status === 403);
r = await call('GET', '/api/me', null, null, { Cookie: ck });
check('cookie GET works', r.status === 200);

// unauthenticated
r = await call('GET', '/api/me');
check('no token 401', r.status === 401);

// me, recovery, notifications prefs
r = await call('GET', '/api/me', null, alice.token);
check('me', r.status === 200 && r.json.user.hasRecovery === false && r.json.user.notifyPrefs.email === true);
r = await call('PUT', '/api/me/recovery', { recAuth: await authKey(alice.email, 'rec'), encPrivateKeyRec: encKey() }, alice.token);
check('set recovery', r.status === 200);
r = await call('PUT', '/api/me/notifications', { taskUpdated: false }, alice.token);
check('notify prefs', r.status === 200 && r.json.notifyPrefs.taskUpdated === false && r.json.notifyPrefs.email === true);

// workspace
r = await call('POST', '/api/workspaces', { name: 'Procurement' }, alice.token);
const ws = r.json.id;
check('create workspace', r.status === 200 && ws);
r = await call('GET', `/api/workspaces/${ws}/team`, null, bob.token);
check('non-member blocked', r.status === 403);

// invite flow
r = await call('POST', `/api/workspaces/${ws}/invites`, { email: bob.email, role: 'member' }, alice.token);
check('invite', r.status === 200 && r.json.code);
const code = r.json.code;
r = await call('POST', '/api/invites/accept', { code: 'AAAA-BBBB-CCCC' }, bob.token);
check('wrong code rejected', r.status === 404);
r = await call('POST', '/api/invites/accept', { code }, bob.token);
check('accept invite', r.status === 200 && r.json.workspace.role === 'member');

// keys: first version admin-only
r = await call('POST', `/api/workspaces/${ws}/keys`, { version: 1, wraps: [{ userId: bob.id, wrapped: encKey() }] }, bob.token);
check('member cannot start key v1', r.status === 403 || r.status === 409, r.status);
r = await call('POST', `/api/workspaces/${ws}/keys`, { version: 1, wraps: [{ userId: alice.id, wrapped: encKey() }, { userId: bob.id, wrapped: encKey() }] }, alice.token);
check('admin starts key v1', r.status === 200 && r.json.keyVersion === 1);

// sync: plaintext refused once encrypted; ciphertext accepted; pull works; presence
const id = crypto.randomUUID().toUpperCase();
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0, push: [{ kind: 'tasks', id, data: { title: 'plain' } }] }, alice.token);
check('plaintext refused (426)', r.status === 426);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0, push: [{ kind: 'tasks', id, data: { enc: 'AAAA', v: 1 } }], viewing: 'task:' + id, client: 'test' }, alice.token);
check('encrypted push', r.status === 200 && r.json.cursor === 1 && r.json.records.length === 1 && r.json.myKeys.length === 1, JSON.stringify(r.json).slice(0, 120));
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0, push: [{ kind: 'tasks', id, data: { enc: 'BBBB', v: 7 } }] }, alice.token);
check('wrong key version 409', r.status === 409);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0, push: [{ kind: 'tasks', id, data: { enc: 'x'.repeat(950 * 1024), v: 1 } }] }, alice.token);
check('oversized record 413', r.status === 413);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0 }, bob.token);
check('bob pulls record + sees presence', r.status === 200 && r.json.records[0]?.data?.enc === 'AAAA' && r.json.presence.some((p) => p.user_id === alice.id) && r.json.members.length === 2);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 1, push: [{ kind: 'tasks', id, deleted: true }] }, bob.token);
check('tombstone', r.status === 200 && r.json.records[0]?.deleted === true);

// roles
r = await call('POST', `/api/workspaces/${ws}/members/${bob.id}/role`, { role: 'viewer' }, alice.token);
check('role → viewer', r.status === 200);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0, push: [{ kind: 'tasks', id, data: { enc: 'CCCC', v: 1 } }] }, bob.token);
check('viewer cannot push', r.status === 403);
r = await call('POST', `/api/workspaces/${ws}/members/${alice.id}/role`, { role: 'viewer' }, bob.token);
check('viewer cannot change roles', r.status === 403);

// notify relays (email disabled → skipped, but the SQL runs)
r = await call('POST', `/api/workspaces/${ws}/notify`, { notices: [{ to: bob.id, type: 'taskAssigned', subject: 's', lines: ['l'], dedupe: 'd1' }] }, alice.token);
check('notify endpoint', r.status === 200 && (r.json.sent + r.json.skipped) === 1, JSON.stringify(r.json));

// admin password reset + sessions
r = await call('POST', `/api/workspaces/${ws}/members/${bob.id}/password`, { authKey: await authKey(bob.email, 'temp-pass-1') }, alice.token);
check('admin reset', r.status === 200);
r = await call('GET', '/api/me', null, bob.token);
check('bob signed out by reset', r.status === 401);
r = await call('POST', '/api/auth/login', { email: bob.email, authKey: await authKey(bob.email, 'temp-pass-1'), wantToken: true });
check('bob logs in with temp password, keys cleared', r.status === 200 && r.json.user.publicKey === null);
bob.token = r.json.token;
r = await call('PUT', '/api/me/keys', { publicKey: pub(), encPrivateKey: encKey() }, bob.token);
check('bob sets new keys', r.status === 200);

// recovery flow
r = await call('POST', '/api/auth/recover', { email: alice.email, recAuth: await authKey(alice.email, 'rec') });
check('recover start', r.status === 200 && r.json.token && r.json.encPrivateKeyRec);
r = await call('POST', '/api/auth/recover/finish', { newAuthKey: await authKey(alice.email, 'new-pass-123'), encPrivateKey: encKey(), wantToken: true }, r.json.token);
check('recover finish', r.status === 200 && r.json.token);
alice.token = r.json.token;

// remove member, logout
r = await call('DELETE', `/api/workspaces/${ws}/members/${bob.id}`, null, alice.token);
check('remove bob', r.status === 200);
r = await call('GET', `/api/workspaces/${ws}/team`, null, bob.token);
check('removed member blocked', r.status === 403);
r = await call('POST', '/api/auth/logout', {}, alice.token);
check('logout', r.status === 200);
r = await call('GET', '/api/me', null, alice.token);
check('token dead after logout', r.status === 401);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
