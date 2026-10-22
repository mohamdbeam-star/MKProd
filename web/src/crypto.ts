// End-to-end encryption primitives (WebCrypto). The formats are specified in SECURITY.md and
// mirrored byte-for-byte by Sources/MKProd/E2E.swift.

/** Byte arrays backed by a plain ArrayBuffer, as WebCrypto requires. */
export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = crypto.subtle;

export const PBKDF2_ROUNDS = 600_000;
export const RECOVERY_ROUNDS = 100_000;

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Bytes {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Bytes;
}
const b64url = (u: Bytes) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const concat = (...parts: Bytes[]): Bytes => {
  const out: Bytes = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---------------------------------------------------------------- password stretching

/** PBKDF2 → { authKey (sent to the server), kek (never leaves the device) }. */
export async function stretch(secret: string, salt: string, rounds: number): Promise<{ authKey: string; kek: CryptoKey }> {
  const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: rounds }, base, 512));
  const kek = await subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { authKey: b64(bits.slice(0, 32)), kek };
}

export const passwordKeys = (email: string, password: string) => stretch(password, 'mkprod-v1:' + email.trim().toLowerCase(), PBKDF2_ROUNDS);
export const recoveryKeys = (email: string, code: string) =>
  stretch(code.toUpperCase().replace(/[^A-Z2-7]/g, ''), 'mkprod-v1-recovery:' + email.trim().toLowerCase(), RECOVERY_ROUNDS);

// ---------------------------------------------------------------- AES-GCM (nonce ‖ ct ‖ tag)

export async function seal(key: CryptoKey, plain: Bytes, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
  return b64(concat(iv, ct));
}

export async function open(key: CryptoKey, sealed: string, aad: string): Promise<Bytes> {
  const all = unb64(sealed);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12), additionalData: enc.encode(aad) }, key, all.slice(12)));
}

// ---------------------------------------------------------------- user key pair (P-256)

export interface KeyPair { privateKey: CryptoKey; publicKey: string }

/** New key pair; returns the public key and the private scalar sealed with `kek`. */
export async function newKeyPair(kek: CryptoKey): Promise<{ pair: KeyPair; publicKey: string; encPrivateKey: string; scalar: Bytes }> {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  const scalar = unb64url(jwk.d!);
  const publicKey = b64(await subtle.exportKey('raw', kp.publicKey));
  const pair = { privateKey: await importPrivate(scalar, publicKey), publicKey };
  return { pair, publicKey, encPrivateKey: await seal(kek, scalar, 'mkprod-v1:privkey'), scalar };
}

/** Unlock the private key with a kek; the resulting CryptoKey is non-extractable. */
export async function unlockKeyPair(kek: CryptoKey, encPrivateKey: string, publicKey: string): Promise<{ pair: KeyPair; scalar: Bytes }> {
  const scalar = await open(kek, encPrivateKey, 'mkprod-v1:privkey');
  return { pair: { privateKey: await importPrivate(scalar, publicKey), publicKey }, scalar };
}

export const sealScalar = (kek: CryptoKey, scalar: Bytes) => seal(kek, scalar, 'mkprod-v1:privkey');

function unb64url(s: string) {
  return unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
}

async function importPrivate(scalar: Bytes, publicKey: string): Promise<CryptoKey> {
  const pub = unb64(publicKey);
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64url(scalar), x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: false },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

const importPublic = (publicKey: string) => subtle.importKey('raw', unb64(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, true, []);

/** Short fingerprint people can compare out of band. */
export async function fingerprint(publicKey: string): Promise<string> {
  const h = new Uint8Array(await subtle.digest('SHA-256', unb64(publicKey)));
  return [...h.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join(' ');
}

// ---------------------------------------------------------------- workspace keys

export async function newWorkspaceKey(): Promise<{ key: CryptoKey; raw: Bytes }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { key: await importWorkspaceKey(raw), raw };
}

export const importWorkspaceKey = (raw: Bytes) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function wrapKeyFor(shared: ArrayBuffer, info: string): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('mkprod-v1-wrap'), info: enc.encode(info) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Wrap a raw workspace key for one member (ephemeral ECDH + HKDF + AES-GCM). */
export async function wrapWorkspaceKey(raw: Bytes, memberPublicKey: string, wsId: string, userId: string, version: number): Promise<string> {
  const info = `${wsId}|${userId}|${version}`;
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: await importPublic(memberPublicKey) }, eph.privateKey, 256);
  const ct = unb64(await seal(await wrapKeyFor(shared, info), raw, info));
  return b64(concat(new Uint8Array(await subtle.exportKey('raw', eph.publicKey)), ct));
}

export async function unwrapWorkspaceKey(wrapped: string, privateKey: CryptoKey, wsId: string, userId: string, version: number): Promise<Bytes> {
  const info = `${wsId}|${userId}|${version}`;
  const all = unb64(wrapped);
  const eph = await subtle.importKey('raw', all.slice(0, 65), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: eph }, privateKey, 256);
  return open(await wrapKeyFor(shared, info), b64(all.slice(65)), info);
}

// ---------------------------------------------------------------- records

export async function encryptRecord(key: CryptoKey, version: number, wsId: string, kind: string, id: string, obj: unknown) {
  return { enc: await seal(key, enc.encode(JSON.stringify(obj)), `${wsId}|${kind}|${id}`), v: version };
}

export async function decryptRecord(key: CryptoKey, wsId: string, kind: string, id: string, data: { enc: string }) {
  return JSON.parse(dec.decode(await open(key, data.enc, `${wsId}|${kind}|${id}`)));
}

export const isEncrypted = (d: unknown): d is { enc: string; v: number } =>
  !!d && typeof (d as { enc?: unknown }).enc === 'string' && typeof (d as { v?: unknown }).v === 'number';

// ---------------------------------------------------------------- recovery codes

export function newRecoveryCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{4}/g)!.join('-');
}

export function randomPassword(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(12)));
}

// ---------------------------------------------------------------- raw bytes (file attachments)

/** AES-GCM over arbitrary bytes, same nonce ‖ ct ‖ tag layout as `seal`, returned as bytes. */
export async function sealBytes(key: CryptoKey, plain: Bytes, aad: string): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
  return concat(iv, ct);
}

export async function openBytes(key: CryptoKey, sealed: Bytes, aad: string): Promise<Bytes> {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: enc.encode(aad) }, key, sealed.slice(12)));
}

// ---------------------------------------------------------------- supplier share links

/**
 * A share link carries its own random key in the URL fragment (never sent to the server).
 * Whoever has the link can read the snapshot; the server only ever stores ciphertext.
 */
export async function newLinkKey(): Promise<{ key: CryptoKey; fragment: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32)) as Bytes;
  return { key: await importWorkspaceKey(raw), fragment: b64url(raw) };
}

export async function linkKeyFrom(fragment: string): Promise<CryptoKey> {
  return importWorkspaceKey(unb64url(fragment));
}

export const sealJson = (key: CryptoKey, obj: unknown, aad: string) => seal(key, enc.encode(JSON.stringify(obj)), aad);
export async function openJson<T = unknown>(key: CryptoKey, sealed: string, aad: string): Promise<T> {
  return JSON.parse(dec.decode(await open(key, sealed, aad))) as T;
}
