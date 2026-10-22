// Deploys the Worker. File attachments need an R2 bucket; if R2 isn't enabled on the Cloudflare
// account (bucket can't be created), deploy without the binding so everything else still ships.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const quiet = (cmd) => spawnSync(cmd, { shell: true, encoding: 'utf8' });

const config = fs.readFileSync('wrangler.jsonc', 'utf8');
const bucket = config.match(/"bucket_name":\s*"([^"]+)"/)?.[1];

let hasR2 = false;
if (bucket) {
  const list = quiet('npx wrangler r2 bucket list');
  if (list.status === 0 && list.stdout.includes(bucket)) hasR2 = true;
  else {
    const create = quiet(`npx wrangler r2 bucket create ${bucket}`);
    hasR2 = create.status === 0;
    if (!hasR2) {
      console.warn('\n⚠ R2 is not enabled on this Cloudflare account, so file attachments stay off.');
      console.warn('  Enable it once: dashboard → R2 Object Storage → Get started. Then run `npm run deploy` again.\n');
    }
  }
}

run('npx wrangler d1 migrations apply mkprod --remote');
if (hasR2) {
  run('npx wrangler deploy');
} else {
  // Same config minus the r2_buckets block, written next to the original so relative paths still resolve.
  const stripped = config.replace(/\s*"r2_buckets":\s*\[[\s\S]*?\],?/, '');
  fs.writeFileSync('wrangler.no-r2.jsonc', stripped);
  try { run('npx wrangler deploy --config wrangler.no-r2.jsonc'); } finally { fs.unlinkSync('wrangler.no-r2.jsonc'); }
}
