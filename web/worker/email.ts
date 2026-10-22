/**
 * Notification emails over SMTP (works with Gmail app passwords, Outlook, Zoho, Brevo…).
 *
 * Configure with Worker secrets: SMTP_HOST, SMTP_PORT (465 = TLS, 587 = STARTTLS),
 * SMTP_USER, SMTP_PASS, SMTP_FROM (address shown as sender). Without them, email is off.
 * SMTP_PORT 2525 with SMTP_HOST 127.0.0.1 is allowed in plaintext for local tests only.
 */
import { connect } from 'cloudflare:sockets';

export interface SmtpEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
}

export interface Mail { to: string; subject: string; text: string; html: string }

export const emailConfigured = (env: SmtpEnv) => !!(env.SMTP_HOST && env.SMTP_FROM && (env.SMTP_HOST === '127.0.0.1' || (env.SMTP_USER && env.SMTP_PASS)));

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const cleanAddress = (a: string) => {
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(a)) throw new Error('Bad address');
  return a;
};

/** Sends each mail as its own SMTP transaction over one connection. */
export async function sendMails(env: SmtpEnv, fromName: string, mails: Mail[]): Promise<number> {
  if (!emailConfigured(env) || !mails.length) return 0;
  const port = Number(env.SMTP_PORT || 465);
  const local = env.SMTP_HOST === '127.0.0.1';
  let socket = connect({ hostname: env.SMTP_HOST!, port }, { secureTransport: local ? 'off' : port === 465 ? 'on' : 'starttls', allowHalfOpen: false });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const dec = new TextDecoder();
  let buf = '';

  async function reply(): Promise<{ code: number; text: string }> {
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const text = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(lines[i].slice(0, 3)), text };
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP connection closed');
      buf += dec.decode(value, { stream: true });
    }
  }
  async function cmd(line: string, expect: number[]): Promise<string> {
    await writer.write(new TextEncoder().encode(line + '\r\n'));
    const r = await reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${line.split(' ')[0]} failed: ${r.text.slice(0, 200)}`);
    return r.text;
  }

  try {
    const greet = await reply();
    if (greet.code !== 220) throw new Error('SMTP greeting failed');
    await cmd('EHLO mkprod', [250]);
    if (!local && port !== 465) {
      await cmd('STARTTLS', [220]);
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      await cmd('EHLO mkprod', [250]);
    }
    if (env.SMTP_USER && env.SMTP_PASS) await cmd('AUTH PLAIN ' + b64(`\0${env.SMTP_USER}\0${env.SMTP_PASS}`), [235]);
    let sent = 0;
    const from = cleanAddress(env.SMTP_FROM!);
    for (const m of mails) {
      const to = cleanAddress(m.to);
      const boundary = 'mkp-' + crypto.randomUUID();
      const msg = [
        `From: ${encodeHeader(fromName)} <${from}>`,
        `To: <${to}>`,
        `Subject: ${encodeHeader(m.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID()}@mkprod>`,
        'MIME-Version: 1.0',
        'Auto-Submitted: auto-generated',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(b64(m.text)),
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(b64(m.html)),
        `--${boundary}--`,
        '',
      ].join('\r\n');
      await cmd(`MAIL FROM:<${from}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      await cmd(msg + '\r\n.', [250]);
      sent++;
    }
    await cmd('QUIT', [221]).catch(() => {});
    return sent;
  } finally {
    try { await socket.close(); } catch { /* already closed */ }
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
