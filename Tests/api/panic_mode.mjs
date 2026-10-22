// Panic mode: the owner locks a workspace; everyone else (sessions, sync, supplier links) is
// refused until it is unlocked. Needs the Worker on :8799 and the SMTP sink writing into MAIL_DIR.
import fs from 'node:fs';
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8799}`;
const MAIL_DIR = process.argv[2];
const b64 = (u) => Buffer.from(u).toString('base64');
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function authKey(email, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('mkprod-v1:' + email), iterations: 1000 }, base, 512));
  return b64(bits.slice(0, 32));
}
async function call(method, path, body, token, headers = {}, raw = false) {
  const res = await fetch(BASE + path, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  if (raw && res.ok && method === 'GET') return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const pub = () => b64(crypto.getRandomValues(new Uint8Array(65)));
const encKey = () => b64(crypto.getRandomValues(new Uint8Array(60)));

// Read the newest email to `addr` and pull a 6-digit code out of it.
function mailsTo(addr) {
  return fs.readdirSync(MAIL_DIR).sort().map((f) => fs.readFileSync(`${MAIL_DIR}/${f}`, 'utf8')).filter((m) => m.includes(`To: <${addr}>`));
}
function decodeMail(raw) {
  const parts = raw.split(/--mkp-[^\r\n]+/);
  const textPart = parts.find((p) => p.includes('text/plain')) ?? '';
  const b64body = textPart.split(/\r?\n\r?\n/)[1] ?? '';
  return Buffer.from(b64body.replace(/\s/g, ''), 'base64').toString('utf8');
}
function latestCode(addr) {
  const ms = mailsTo(addr);
  const body = decodeMail(ms[ms.length - 1] ?? '');
  return body.match(/code is: (\d{6})/)?.[1];
}

// TOTP (same algorithm as worker/totp.ts) to act as the authenticator app.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function unbase32(s) { const out = []; let bits = 0, v = 0; for (const c of s) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
async function totp(secret, now = Date.now()) {
  const key = await crypto.subtle.importKey('raw', unbase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  let counter = Math.floor(now / 30000); const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 255; counter = Math.floor(counter / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)); const o = mac[19] & 15;
  return String((((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 1e6).padStart(6, '0');
}

const owner = { email: 'panic-owner@example.test', pw: 'owner-password-123' };
const mate = { email: 'panic-admin@example.test', pw: 'mate-password-12345' };

async function newUser(u, name) {
  // Its own client address: the earlier suites use up the sign-up allowance of 'local'.
  const r = await call('POST', '/api/auth/signup', { email: u.email, name, authKey: await authKey(u.email, u.pw), publicKey: pub(), encPrivateKey: encKey(), wantToken: true }, null, { 'CF-Connecting-IP': '198.51.100.7' });
  u.token = r.json.token; u.id = r.json.user.id;
  await sleep(800);
  await call('POST', '/api/auth/verify', { code: latestCode(u.email) }, u.token);
}
await newUser(owner, 'Owner');
await newUser(mate, 'Admin');
let r = await call('POST', '/api/workspaces', { name: 'Panic' }, owner.token);
const ws = r.json.id;
r = await call('POST', `/api/workspaces/${ws}/invites`, { email: mate.email, role: 'admin' }, owner.token);
r = await call('POST', '/api/invites/accept', { code: r.json.code }, mate.token);
check('admin joined', r.status === 200);
const shareId = crypto.randomUUID().toUpperCase();
r = await call('POST', `/api/workspaces/${ws}/shares`, { id: shareId, kind: 'order', refId: crypto.randomUUID(), label: '#1 Test', blob: b64(crypto.getRandomValues(new Uint8Array(64))), days: 7 }, owner.token);
check('share created', r.status === 200);

r = await call('POST', `/api/workspaces/${ws}/lock`, { locked: true }, mate.token);
check('admin cannot lock', r.status === 403);
r = await call('POST', `/api/workspaces/${ws}/lock`, { locked: 'yes' }, owner.token);
check('bad body rejected', r.status === 400);
r = await call('POST', `/api/workspaces/${ws}/lock`, { locked: true }, owner.token);
check('owner locks', r.status === 200 && !!r.json.lockedAt);

r = await call('GET', '/api/me', null, mate.token);
check('admin signed out by lock', r.status === 401);
r = await call('POST', '/api/auth/login', { email: mate.email, authKey: await authKey(mate.email, mate.pw), wantToken: true });
mate.token = r.json.token;
check('admin can still sign in to the account', r.status === 200 && !!mate.token);
r = await call('GET', '/api/me', null, mate.token);
check('me shows workspace locked', r.json.workspaces?.find((w) => w.id === ws)?.locked === true);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0 }, mate.token);
check('admin sync refused (423)', r.status === 423 && r.json.locked === true);
r = await call('GET', `/api/workspaces/${ws}/team`, null, mate.token);
check('admin team refused', r.status === 423);
r = await call('POST', `/api/workspaces/${ws}/lock`, { locked: false }, mate.token);
check('admin cannot unlock', r.status === 423);
r = await call('GET', `/api/share/${shareId}`);
check('supplier link blocked', r.status === 423);
r = await call('POST', `/api/share/${shareId}/reply`, { blob: b64(crypto.getRandomValues(new Uint8Array(20))) }, null, { 'CF-Connecting-IP': '198.51.100.8' });
check('supplier reply blocked', r.status === 423, r.status);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0 }, owner.token);
check('owner still syncs', r.status === 200);
r = await call('GET', `/api/workspaces/${ws}/team`, null, owner.token);
check('team shows lockedAt', r.status === 200 && !!r.json.lockedAt);

r = await call('POST', `/api/workspaces/${ws}/lock`, { locked: false }, owner.token);
check('owner unlocks', r.status === 200 && r.json.lockedAt === null);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0 }, mate.token);
check('admin syncs again', r.status === 200);
r = await call('GET', `/api/share/${shareId}`);
check('supplier link works again', r.status === 200);
r = await call('GET', `/api/workspaces/${ws}/security`, null, owner.token);
const types = (r.json.events ?? []).map((e) => e.type);
check('security log records lock and unlock', types.includes('workspace_locked') && types.includes('workspace_unlocked'), types.join(','));

console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
