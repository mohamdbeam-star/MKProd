// Smoke test for the trust & compliance release: email verification, TOTP, devices, security
// log, shares, files, transfer, deletion, require-MFA. Needs the Worker on :8799 and the SMTP
// sink writing .eml files into MAIL_DIR.
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

const owner = { email: 'owner@example.test', pw: 'owner-password-123' };
const mate = { email: 'mate@example.test', pw: 'mate-password-12345' };

// ---- sign-up requires email confirmation (SMTP is configured)
let r = await call('POST', '/api/auth/signup', { email: owner.email, name: 'Owner', authKey: await authKey(owner.email, owner.pw), publicKey: pub(), encPrivateKey: encKey(), wantToken: true });
check('signup → needsVerification', r.status === 200 && r.json.needsVerification === true && r.json.user.emailVerified === false);
owner.token = r.json.token; owner.id = r.json.user.id;
r = await call('POST', '/api/workspaces', { name: 'Blocked' }, owner.token);
check('unverified cannot create workspace', r.status === 403 && r.json.needsVerification === true);
await sleep(800);
let code = latestCode(owner.email);
check('verification email received', !!code, code);
r = await call('POST', '/api/auth/verify', { code: '000000' }, owner.token);
check('wrong verify code rejected', r.status === 400);
r = await call('POST', '/api/auth/verify', { code }, owner.token);
check('verify ok', r.status === 200);
r = await call('GET', '/api/me', null, owner.token);
check('me.emailVerified', r.json.user.emailVerified === true && r.json.filesEnabled === true);

r = await call('POST', '/api/auth/signup', { email: mate.email, name: 'Mate', authKey: await authKey(mate.email, mate.pw), publicKey: pub(), encPrivateKey: encKey(), wantToken: true });
mate.token = r.json.token; mate.id = r.json.user.id;
await sleep(800);
r = await call('POST', '/api/auth/verify', { code: latestCode(mate.email) }, mate.token);
check('mate verified', r.status === 200);

// ---- workspace + invite
r = await call('POST', '/api/workspaces', { name: 'Procurement' }, owner.token);
const ws = r.json.id;
check('create workspace', r.status === 200 && ws);
r = await call('POST', `/api/workspaces/${ws}/invites`, { email: mate.email, role: 'member' }, owner.token);
r = await call('POST', '/api/invites/accept', { code: r.json.code }, mate.token);
check('mate joined', r.status === 200);
r = await call('POST', `/api/workspaces/${ws}/keys`, { version: 1, wraps: [{ userId: owner.id, wrapped: encKey() }, { userId: mate.id, wrapped: encKey() }] }, owner.token);
check('key v1', r.status === 200);

// ---- sign-in alert email on login
const before = mailsTo(owner.email).length;
r = await call('POST', '/api/auth/login', { email: owner.email, authKey: await authKey(owner.email, owner.pw), wantToken: true }, null, { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Chrome/120 Safari/537' });
const secondToken = r.json.token;
await sleep(800);
const alerts = mailsTo(owner.email).slice(before);
check('sign-in alert email sent', alerts.length === 1 && decodeMail(alerts[0]).includes('Chrome on Mac'), alerts.length);

// ---- devices
r = await call('GET', '/api/auth/sessions', null, owner.token);
check('devices listed', r.status === 200 && r.json.sessions.length === 2 && r.json.sessions.some((s) => s.current) && r.json.sessions.some((s) => s.client === 'Chrome on Mac'), JSON.stringify(r.json).slice(0, 200));
const other = r.json.sessions.find((s) => !s.current);
r = await call('DELETE', `/api/auth/sessions/${other.id}`, null, owner.token);
check('revoke device', r.status === 200);
r = await call('GET', '/api/me', null, secondToken);
check('revoked token dead', r.status === 401);

// ---- TOTP
r = await call('POST', '/api/me/totp/start', {}, owner.token);
check('totp start', r.status === 200 && r.json.secret && r.json.url.startsWith('otpauth://totp/'));
const secret = r.json.secret;
r = await call('POST', '/api/me/totp/enable', { code: '123456' }, owner.token);
check('wrong totp code rejected', r.status === 400);
r = await call('POST', '/api/me/totp/enable', { code: await totp(secret) }, owner.token);
check('totp enabled + 8 backup codes', r.status === 200 && r.json.backupCodes?.length === 8);
const backup = r.json.backupCodes;
r = await call('POST', '/api/auth/login', { email: owner.email, authKey: await authKey(owner.email, owner.pw), wantToken: true });
check('login → mfa step', r.status === 200 && r.json.mfa === true && r.json.mfaToken);
const mfaToken = r.json.mfaToken;
r = await call('GET', '/api/me', null, mfaToken);
check('mfa token cannot access API', r.status === 403 && r.json.mfa === true);
r = await call('POST', '/api/auth/mfa', { code: '000000', wantToken: true }, mfaToken);
check('wrong mfa code', r.status === 401);
r = await call('POST', '/api/auth/mfa', { code: await totp(secret), wantToken: true }, mfaToken);
check('mfa with authenticator code', r.status === 200 && r.json.token && r.json.user.totpEnabled === true);
owner.token = r.json.token;
r = await call('POST', '/api/auth/login', { email: owner.email, authKey: await authKey(owner.email, owner.pw), wantToken: true });
r = await call('POST', '/api/auth/mfa', { code: backup[0], wantToken: true }, r.json.mfaToken);
check('mfa with backup code', r.status === 200 && r.json.token);
r = await call('POST', '/api/auth/login', { email: owner.email, authKey: await authKey(owner.email, owner.pw), wantToken: true });
r = await call('POST', '/api/auth/mfa', { code: backup[0], wantToken: true }, r.json.mfaToken);
check('backup code single-use', r.status === 401);
r = await call('GET', '/api/me', null, owner.token);
check('backupCodesLeft 7', r.json.user.backupCodesLeft === 7);

// ---- require MFA for the workspace
r = await call('PATCH', `/api/workspaces/${ws}`, { requireMfa: true }, mate.token);
check('member cannot set policy', r.status === 403);
r = await call('PATCH', `/api/workspaces/${ws}`, { requireMfa: true }, owner.token);
check('owner requires mfa', r.status === 200);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0 }, mate.token);
check('member without 2FA locked out', r.status === 403 && r.json.mfaRequired === true);
r = await call('GET', '/api/me', null, mate.token);
check('…but account still works', r.status === 200);
r = await call('PATCH', `/api/workspaces/${ws}`, { requireMfa: false }, owner.token);
r = await call('POST', `/api/workspaces/${ws}/sync`, { cursor: 0 }, mate.token);
check('policy off → member back', r.status === 200);

// ---- security log
r = await call('GET', '/api/me/security', null, owner.token);
const types = r.json.events.map((e) => e.type);
check('my security log', r.status === 200 && types.includes('signin') && types.includes('totp_enabled') && types.includes('session_revoked') && types.includes('signin_mfa_failed'), types.slice(0, 8).join(','));
r = await call('GET', `/api/workspaces/${ws}/security`, null, mate.token);
check('member cannot read workspace log', r.status === 403);
r = await call('GET', `/api/workspaces/${ws}/security`, null, owner.token);
const wt = r.json.events.map((e) => e.type);
check('workspace log', r.status === 200 && wt.includes('invite_accepted') && wt.includes('key_rotated') && wt.includes('require_mfa_changed') && r.json.events[0].actor_name, wt.join(','));

// ---- supplier share links (public)
const shareId = crypto.randomUUID().toUpperCase();
r = await call('POST', `/api/workspaces/${ws}/shares`, { id: shareId, kind: 'order', refId: crypto.randomUUID(), label: '#1001 Laptops', blob: b64(crypto.getRandomValues(new Uint8Array(200))), days: 14 }, owner.token);
check('share created with client id', r.status === 200 && r.json.id === shareId);
r = await call('GET', `/api/share/${shareId}`);
check('public share readable', r.status === 200 && r.json.blob && r.json.allowReply === true && !('workspace_id' in r.json));
r = await call('POST', `/api/share/${shareId}/reply`, { blob: b64(crypto.getRandomValues(new Uint8Array(40))) });
check('public reply', r.status === 200);
r = await call('GET', `/api/workspaces/${ws}/shares?ref=x`, null, owner.token);
r = await call('GET', `/api/workspaces/${ws}/shares`, null, owner.token);
check('shares listed with replies + views', r.status === 200 && r.json.shares[0].replies.length === 1 && r.json.shares[0].views >= 1, JSON.stringify(r.json).slice(0, 160));
r = await call('DELETE', `/api/workspaces/${ws}/shares/${shareId}`, null, owner.token);
r = await call('GET', `/api/share/${shareId}`);
check('revoked share gone', r.status === 404);
r = await call('GET', `/api/share/${crypto.randomUUID()}`);
check('unknown share 404', r.status === 404);

// ---- files (R2)
const fileId = crypto.randomUUID().toUpperCase();
const payload = crypto.getRandomValues(new Uint8Array(5000));
r = await call('PUT', `/api/workspaces/${ws}/files/${fileId}`, payload, owner.token, { 'Content-Type': 'application/octet-stream', 'X-Key-Version': '1', 'Content-Length': '5000' }, true);
check('file upload', r.status === 200 && r.json.size === 5000, JSON.stringify(r.json));
r = await call('GET', `/api/workspaces/${ws}/files/${fileId}`, null, mate.token, {}, true);
check('file download identical', r.status === 200 && r.bytes.length === 5000 && Buffer.compare(Buffer.from(r.bytes), Buffer.from(payload)) === 0 && r.headers.get('x-key-version') === '1');
r = await call('PUT', `/api/workspaces/${ws}/files/${crypto.randomUUID()}`, payload, owner.token, { 'Content-Type': 'application/octet-stream', 'X-Key-Version': '9', 'Content-Length': '5000' }, true);
check('wrong key version refused', r.status === 409);
r = await call('DELETE', `/api/workspaces/${ws}/files/${fileId}`, null, owner.token);
r = await call('GET', `/api/workspaces/${ws}/files/${fileId}`, null, owner.token, {}, true);
check('deleted file 404', r.status === 404);

// ---- digest notice type accepted (to self allowed)
r = await call('POST', `/api/workspaces/${ws}/notify`, { notices: [{ to: owner.id, type: 'weeklyDigest', subject: 'Your week', lines: ['x'], dedupe: 'digest:w1' }] }, owner.token);
check('weekly digest to self sent', r.status === 200 && r.json.sent === 1, JSON.stringify(r.json));

// ---- transfer ownership, delete workspace, delete account
r = await call('DELETE', `/api/workspaces/${ws}`, { authKey: await authKey(owner.email, owner.pw) }, mate.token);
check('member cannot delete workspace', r.status === 403);
r = await call('DELETE', '/api/me', { authKey: await authKey(owner.email, owner.pw) }, owner.token);
check('owner with members cannot delete account', r.status === 409);
r = await call('POST', `/api/workspaces/${ws}/transfer`, { userId: mate.id }, owner.token);
check('transfer ownership', r.status === 200);
r = await call('GET', `/api/workspaces/${ws}/team`, null, owner.token);
check('roles swapped', r.json.role === 'admin' && r.json.members.find((m) => m.id === mate.id).role === 'owner');
r = await call('DELETE', '/api/me', { authKey: await authKey(owner.email, 'wrong-password-0') }, owner.token);
check('delete account needs password', r.status === 401);
r = await call('DELETE', '/api/me', { authKey: await authKey(owner.email, owner.pw) }, owner.token);
check('former owner deletes account', r.status === 200);
r = await call('POST', '/api/auth/login', { email: owner.email, authKey: await authKey(owner.email, owner.pw), wantToken: true });
check('deleted account cannot log in', r.status === 401);
r = await call('GET', `/api/workspaces/${ws}/team`, null, mate.token);
check('workspace survives with 1 member', r.status === 200 && r.json.members.length === 1);
r = await call('DELETE', `/api/workspaces/${ws}`, { authKey: await authKey(mate.email, mate.pw) }, mate.token);
check('new owner deletes workspace', r.status === 200);
r = await call('GET', '/api/me', null, mate.token);
check('no workspaces left', r.json.workspaces.length === 0);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
