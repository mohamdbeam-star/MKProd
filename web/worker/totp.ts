/**
 * RFC 6238 time-based one-time passwords (what Google Authenticator, 1Password, Authy… produce).
 * 20-byte secret, SHA-1, 6 digits, 30-second steps; one step of clock drift either way is accepted.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const newTotpSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));

export function otpauthUrl(secret: string, email: string, issuer = 'MK Prod') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = mac[19] & 0x0f;
  const code = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** True if `code` matches the current step or its neighbours. */
export async function verifyTotp(secret: string, code: string, now = Date.now()): Promise<boolean> {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) return false;
  const key = unbase32(secret);
  const step = Math.floor(now / 30_000);
  for (const d of [0, -1, 1]) {
    if (await hotp(key, step + d) === digits) return true;
  }
  return false;
}

/** 8 one-time backup codes, shown once; the server stores their SHA-256 hashes. */
export function newBackupCodes(): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 8 }, () => {
    const b = crypto.getRandomValues(new Uint8Array(10));
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5, 10)}`;
  });
}

export const normBackup = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');
