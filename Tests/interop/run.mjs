// Cross-checks the website's crypto (web/src/crypto.ts) against the Mac app's (E2E.swift).
import { execFileSync } from 'node:child_process';
import * as C from './crypto.mjs';

const tool = (...args) => execFileSync(process.argv[2], args, { encoding: 'utf8' }).trim();
let failed = 0;
const check = (ok, what) => { console.log(ok ? '  ✓' : '  ✗', what); if (!ok) failed++; };
const email = 'Interop.Tester@Example.test', pw = 'correct horse battery staple';
const ws = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', user = '11111111-2222-4333-8444-555555555555';

// 1. Password stretching produces the same auth key and kek.
const web = await C.passwordKeys(email, pw);
const [macAuth, macKekCheck] = tool('derive', email, pw).split(' ');
check(web.authKey === macAuth, 'same auth key from the same password (PBKDF2 600k)');
check(new TextDecoder().decode(await C.open(web.kek, macKekCheck, 't')) === 'kek-check', 'web kek opens data sealed with Mac kek');

// 2. Recovery codes.
const code = tool('code');
check(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(code) && /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(C.newRecoveryCode()), 'both make 8×4 Base32 recovery codes');
check((await C.recoveryKeys(email, code.toLowerCase())).authKey === tool('recovery', email, code), 'same recovery auth key (case-insensitive)');

// 3. A private key sealed on the Mac unlocks in the browser and vice versa.
const [macPub, macEncPriv] = tool('keypair', email, pw).split(' ');
const unlocked = await C.unlockKeyPair(web.kek, macEncPriv, macPub);
check(unlocked.pair.publicKey === macPub, 'web unlocks a Mac-sealed private key');
const webKp = await C.newKeyPair(web.kek);
check(tool('unlock', email, pw, webKp.encPrivateKey) === webKp.publicKey, 'Mac unlocks a web-sealed private key');

// 4. Workspace key wrapping both ways.
const { raw } = await C.newWorkspaceKey();
const wrappedOnMac = tool('wrap', C.b64(raw), webKp.publicKey, ws, user, '3');
check(C.b64(await C.unwrapWorkspaceKey(wrappedOnMac, webKp.pair.privateKey, ws, user, 3)) === C.b64(raw), 'web unwraps a key the Mac wrapped');
const wrappedOnWeb = await C.wrapWorkspaceKey(raw, macPub, ws, user, 3);
check(tool('unwrap', email, pw, macEncPriv, wrappedOnWeb, ws, user, '3') === C.b64(raw), 'Mac unwraps a key the web wrapped');
let refused = false;
try { tool('unwrap', email, pw, macEncPriv, wrappedOnWeb, ws, user, '4'); } catch { refused = true; }
check(refused, 'wrapped key bound to its version (wrong version rejected)');

// 5. Records both ways, with AAD binding.
const key = await C.importWorkspaceKey(raw);
const obj = { id: 'X', title: 'Ünïcødé ✓ "quotes"', n: 3.5 };
const webRec = await C.encryptRecord(key, 1, ws, 'tasks', '99999999-0000-4000-8000-000000000001', obj);
check(JSON.parse(tool('dec', C.b64(raw), ws, 'tasks', '99999999-0000-4000-8000-000000000001', webRec.enc)).title === obj.title, 'Mac decrypts a web-encrypted record');
const macSealed = tool('enc', C.b64(raw), ws, 'orders', JSON.stringify(obj), '99999999-0000-4000-8000-000000000002');
check((await C.decryptRecord(key, ws, 'orders', '99999999-0000-4000-8000-000000000002', { enc: macSealed })).title === obj.title, 'web decrypts a Mac-encrypted record');
let swapped = false;
try { await C.decryptRecord(key, ws, 'tasks', '99999999-0000-4000-8000-000000000002', { enc: macSealed }); } catch { swapped = true; }
check(swapped, 'record moved to another kind/id fails to decrypt (AAD)');

// 6. Fingerprints agree.
check(await C.fingerprint(macPub) === tool('fingerprint', macPub), 'same key fingerprint');

console.log(failed ? `${failed} interop check(s) FAILED` : 'All crypto interop checks passed.');
process.exit(failed ? 1 : 0);
