// Browser check: delete a space from the sidebar, switch between two workspaces, open the Apps page.
// Needs Playwright and the Worker on :8797 with a fresh DB (see personal_sync.mjs).
import { chromium } from 'playwright';
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await ctx.newPage();
let failures = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${extra}`); if (!ok) failures++; };
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('dialog', (d) => d.type() === 'prompt' ? d.accept(d.defaultValue() === 'Team' ? 'Marketing' : 'Second list') : d.accept());

await page.goto(BASE + '/');
await page.click('.seg button:nth-child(2)');
await page.fill('input[autocomplete="name"]', 'Mohamad');
await page.fill('input[type="email"]', `side-${Date.now()}@example.test`);
await page.fill('input[type="password"]', 'sidebar-test-pass-1');
await page.click('button.btn.primary');
await page.waitForSelector('text=Save your recovery code', { timeout: 30000 });
await page.click('input[type="checkbox"]');
await page.click('button.btn.primary');
await page.waitForSelector('text=Choose a workspace');
await page.fill('input[placeholder="New workspace name"]', 'Procurement');
await page.click('button.btn.primary:has-text("Create")');
await page.waitForSelector('.side');
await page.waitForTimeout(2500);

// Rename the "Team" space via its ⋯ menu (prompt answered with "Marketing").
const spaceRow = page.locator('.side .nav', { hasText: 'Team' }).first();
await spaceRow.hover();
await spaceRow.locator('button.more').click();
await page.click('.menu .item:has-text("Rename space")');
await page.waitForTimeout(500);
check('space renamed', (await page.locator('.side .nav', { hasText: 'Marketing' }).count()) === 1);

// Delete it (confirm accepted).
const row2 = page.locator('.side .nav', { hasText: 'Marketing' }).first();
await row2.hover();
await row2.locator('button.more').click();
await page.click('.menu .item:has-text("Delete space")');
await page.waitForTimeout(800);
check('space deleted', (await page.locator('.side .nav', { hasText: 'Marketing' }).count()) === 0);

// Second workspace through the switcher → "Create or join…", then switch back and forth.
await page.click('.ws-head');
await page.click('.menu .item:has-text("Create or join")');
await page.waitForSelector('text=Choose a workspace');
await page.fill('input[placeholder="New workspace name"]', 'Facilities');
await page.click('button.btn.primary:has-text("Create")');
await page.waitForSelector('.side');
await page.waitForTimeout(2000);
check('in second workspace', (await page.locator('.ws-head strong').textContent()) === 'Facilities');
await page.click('.ws-head');
const items = await page.locator('.menu .item').allTextContents();
check('switcher lists both workspaces', items.some((t) => t.includes('Procurement')) && items.some((t) => t.includes('Facilities')), items.join(' | '));
await page.click('.menu .item:has-text("Procurement")');
await page.waitForTimeout(2000);
check('switched back to first', (await page.locator('.ws-head strong').textContent()) === 'Procurement');

// Apps page renders (the local server can't reach GitHub releases for a private repo; the page must still show the three cards).
await page.click('.side .nav:has-text("Get the apps")');
await page.waitForTimeout(2500);
const cards = await page.locator('.page h3').allTextContents();
check('apps page shows Mac/Windows/Android', ['Mac', 'Windows', 'Android'].every((t) => cards.includes(t)), cards.join(','));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
