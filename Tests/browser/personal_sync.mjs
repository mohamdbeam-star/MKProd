// Checks personal sync in the real web app: a reminder added on device 1 appears on device 2 of the
// same person (read state too), and a teammate in the same workspace sees nothing of it.
// Needs Playwright (`npm i -D playwright` in web/, or a global install) and the Worker on :8797 with a fresh DB.
import { chromium } from 'playwright';
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
const browser = await chromium.launch();
let failures = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${extra}`); if (!ok) failures++; };

async function signup(ctx, name, email) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', name, e.message));
  await page.goto(BASE + '/');
  await page.click('.seg button:nth-child(2)');
  await page.fill('input[autocomplete="name"]', name);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'personal-sync-pass-1');
  await page.click('button.btn.primary');
  await page.waitForSelector('text=Save your recovery code', { timeout: 30000 });
  await page.click('input[type="checkbox"]');
  await page.click('button.btn.primary');
  await page.waitForSelector('text=Choose a workspace');
  return page;
}
async function signin(ctx, email) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', email, e.message));
  await page.goto(BASE + '/');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'personal-sync-pass-1');
  await page.click('button.btn.primary');
  await page.waitForSelector('.side', { timeout: 30000 });
  return page;
}

const t = Date.now();
const alice = `alice-${t}@example.test`, bob = `bob-${t}@example.test`;

// Alice, device 1: create workspace, add a reminder due now.
const a1 = await browser.newContext();
const p1 = await signup(a1, 'Alice', alice);
await p1.fill('input[placeholder="New workspace name"]', 'Procurement');
await p1.click('button.btn.primary:has-text("Create")');
await p1.waitForSelector('.side');
await p1.waitForTimeout(2500);
await p1.fill('input[placeholder="Remind me to…"]', 'Call the cleaning supplier');
await p1.fill('input[type="datetime-local"]', '2020-01-01T09:00');
await p1.click('button.btn.primary:has-text("Add")');
await p1.waitForTimeout(6000); // a sync tick: reminder is due → inbox entry
const inbox1 = await p1.locator('.nav:has-text("Inbox") .badge').textContent().catch(() => '');
check('device 1: due reminder reached the inbox', inbox1 === '1', inbox1);

// Invite Bob.
await p1.goto(BASE + '/#/team'); await p1.waitForTimeout(800);
await p1.fill('input[placeholder="teammate@company.com"]', bob);
await p1.click('button:has-text("Invite")');
await p1.waitForSelector('.modal .mono');
const code = (await p1.locator('.modal .mono').textContent()).trim();
await p1.click('.modal button:has-text("Done")');

// Alice, device 2 (fresh browser profile): same account, should see the reminder and the inbox item.
const a2 = await browser.newContext();
const p2 = await signin(a2, alice);
await p2.waitForTimeout(6000);
const reminder2 = await p2.locator('text=Call the cleaning supplier').count();
check('device 2: reminder synced', reminder2 >= 1, String(reminder2));
const inbox2 = await p2.locator('.nav:has-text("Inbox") .badge').textContent().catch(() => '');
check('device 2: inbox item synced, unread', inbox2 === '1', inbox2);
await p2.goto(BASE + '/#/inbox'); await p2.waitForTimeout(500);
await p2.click('button:has-text("Mark all read")');
await p2.waitForTimeout(6000);
await p1.goto(BASE + '/#/inbox'); await p1.waitForTimeout(6000);
const unread1 = await p1.locator('.nav:has-text("Inbox") .badge').count();
check('device 1: read state synced back', unread1 === 0, String(unread1));

// Bob joins: must see neither Alice's reminder nor her inbox.
const b = await browser.newContext();
const pb = await signup(b, 'Bob', bob);
await pb.fill('input[placeholder="Invite code (XXXX-XXXX-XXXX)"]', code);
await pb.click('button:has-text("Join")');
await pb.waitForSelector('.side', { timeout: 30000 });
await pb.waitForTimeout(8000); // key sharing from Alice's open sessions + pull
const status = await pb.locator('.side-foot .small').textContent();
check('bob gets the workspace key', /Synced/.test(status ?? ''), status ?? '');
const remB = await pb.locator('text=Call the cleaning supplier').count();
check("bob can't see Alice's reminder", remB === 0, String(remB));
await pb.goto(BASE + '/#/inbox'); await pb.waitForTimeout(500);
const inboxB = await pb.locator('text=Inbox zero').count();
check("bob's inbox is empty", inboxB === 1);
const consoleWarnings = [];
pb.on('console', (m) => consoleWarnings.push(m.text()));

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
