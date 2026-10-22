// Minimal SMTP server for tests: accepts every message and writes it to <dir>/<n>.eml.
import net from 'node:net';
import fs from 'node:fs';
const [port, dir] = [Number(process.argv[2] || 2525), process.argv[3]];
fs.mkdirSync(dir, { recursive: true });
let n = 0;
net.createServer((sock) => {
  let buf = '', data = false, msg = '';
  const say = (l) => sock.write(l + '\r\n');
  say('220 sink ESMTP');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) {
        if (line === '.') { data = false; fs.writeFileSync(`${dir}/${String(++n).padStart(3, '0')}.eml`, msg); msg = ''; say('250 queued'); }
        else msg += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') say('250 sink');
      else if (cmd === 'DATA') { data = true; say('354 go'); }
      else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
      else say('250 ok');
    }
  });
  sock.on('error', () => {});
}).listen(port, '127.0.0.1');
