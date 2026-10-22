// Browser check of Whiteboards on the website: create a board, add items, move and resize,
// connect two items, recolour, convert to a task, see it on a second device, and confirm the
// removed pages (Docs, Overview, Alerts, Analytics) are gone from the sidebar.
// Needs Playwright and the Worker on :8797 with a fresh DB (see personal_sync.mjs).
import { chromium } from 'playwright';
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
const browser = await chromium.launch();
let failures = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${extra}`); if (!ok) failures++; };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.type() === 'prompt' ? d.accept('Launch plan') : d.accept());
const email = `wb-${Date.now()}@example.test`, pw = 'whiteboard-pass-1';
await page.goto(BASE + '/');
await page.click('.seg button:nth-child(2)');
await page.fill('input[autocomplete="name"]', 'Mohamad');
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', pw);
await page.click('button.btn.primary');
await page.waitForSelector('text=Save your recovery code', { timeout: 30000 });
await page.click('input[type="checkbox"]');
await page.click('button.btn.primary');
await page.waitForSelector('text=Choose a workspace');
await page.fill('input[placeholder="New workspace name"]', 'Procurement');
await page.click('button.btn.primary:has-text("Create")');
await page.waitForSelector('.side');
await page.waitForTimeout(2000);

const side = await page.locator('.side').innerText();
check('sidebar: Docs, Overview, Alerts and Analytics are gone', !/\bDocs\b|\bOverview\b|\bAlerts\b|\bAnalytics\b/.test(side), side.replace(/\n/g, ' | ').slice(0, 300));
check('sidebar: Whiteboards present', side.includes('Whiteboards'));
await page.goto(BASE + '/#/docs'); await page.waitForTimeout(400);
check('old /docs route falls back to Home', (await page.locator('h1, h2').first().innerText()).length > 0 && !(await page.innerText('body')).includes('New doc'));

await page.click('.side .nav:has-text("Whiteboards")');
await page.waitForSelector('h1:has-text("Whiteboards")');
check('empty state', (await page.innerText('body')).includes('No whiteboards yet'));
await page.click('button:has-text("New whiteboard")');   // prompt answered with "Launch plan"
await page.waitForSelector('.wb-canvas');
check('board created and opened', (await page.inputValue('.wb-bar input')) === 'Launch plan');

await page.click('.wb-bar button:has-text("Sticky")');
await page.click('.wb-bar button:has-text("Box")');
await page.click('.wb-bar button:has-text("Text")');
check('three items on the canvas', (await page.locator('.wb-item').count()) === 3 && (await page.locator('.wb-item.sticky').count()) === 1);

// Type into the selected text item (added last, so selected).
await page.locator('.wb-item.on .wb-text').fill('Kick-off');
await page.waitForTimeout(300);
check('typing stores the text', (await page.locator('.wb-item.text .wb-text').inputValue()) === 'Kick-off');

// Move the sticky by dragging it.
const sticky = page.locator('.wb-item.sticky');
const b0 = await sticky.boundingBox();
await page.mouse.move(b0.x + 30, b0.y + 60);
await page.mouse.down();
await page.mouse.move(b0.x + 230, b0.y + 160, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const b1 = await sticky.boundingBox();
check('drag moves the sticky', Math.round(b1.x - b0.x) === 200 && Math.round(b1.y - b0.y) === 100, `${b1.x - b0.x},${b1.y - b0.y}`);

// Resize it with the corner handle (it is selected after the drag).
const h = await page.locator('.wb-item.sticky .wb-resize').boundingBox();
await page.mouse.move(h.x + 9, h.y + 9); await page.mouse.down(); await page.mouse.move(h.x + 69, h.y + 49, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(300);
const b2 = await sticky.boundingBox();
check('corner handle resizes', Math.round(b2.width - b1.width) === 60 && Math.round(b2.height - b1.height) === 40, `${b2.width - b1.width}x${b2.height - b1.height}`);

// Connect sticky → box.
await page.click('.wb-bar button:has-text("Connect")');
await page.locator('.wb-item.rectangle').click({ position: { x: 10, y: 100 } });  // a corner the overlapping text item does not cover
await page.waitForTimeout(300);
check('connector drawn between the two items', (await page.locator('.wb-lines line').count()) === 1);

// Colour the box (now selected).
await page.locator('.wb-swatch').nth(1).click();
await page.waitForTimeout(200);
check('colour applied', (await page.locator('.wb-item.rectangle').evaluate((el) => getComputedStyle(el).borderColor)) === 'rgb(167, 243, 208)');

// Zoom keeps everything and the coordinates scale.
await page.click('.wb-bar button[aria-label="Zoom out"]');
check('zoom shows 90%', (await page.locator('.wb-bar .mono').innerText()) === '90%');
await page.click('.wb-bar button[aria-label="Zoom in"]');

// Convert the text item to a task.
await page.locator('.wb-item.text').click();
await page.click('.wb-bar button:has-text("Convert to task")');
await page.waitForSelector('.drawer', { timeout: 5000 }).catch(() => {});
const drawerTitle = await page.locator('.drawer textarea.plain').first().inputValue().catch(() => '');
check('convert to task opens the new task', drawerTitle === 'Kick-off', drawerTitle);
await page.locator('.scrim').first().click({ position: { x: 5, y: 5 }, force: true }).catch(() => {});   // close the task drawer
await page.waitForSelector('.scrim', { state: 'detached', timeout: 5000 }).catch(() => {});

// Delete the box with the keyboard.
await page.locator('.wb-item.rectangle').click({ position: { x: 10, y: 100 } });  // a corner the overlapping text item does not cover
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
check('Delete removes the item and its connector', (await page.locator('.wb-item').count()) === 2 && (await page.locator('.wb-lines line').count()) === 0);

// Second device, same person: the board and its items are there.
const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => errors.push('device2: ' + e.message));
await p2.goto(BASE + '/');
await p2.fill('input[type="email"]', email);
await p2.fill('input[type="password"]', pw);
await p2.click('button.btn.primary');
await p2.waitForSelector('.side', { timeout: 30000 });
await p2.click('.side .nav:has-text("Whiteboards")');
await p2.waitForSelector('.card:has-text("Launch plan")', { timeout: 15000 });
await p2.click('.card:has-text("Launch plan")');
await p2.waitForSelector('.wb-canvas');
await p2.waitForFunction(() => document.querySelectorAll('.wb-item').length === 2, null, { timeout: 15000 }).catch(() => {});
check('device 2 sees the same board with 2 items', (await p2.locator('.wb-item').count()) === 2 && (await p2.locator('.wb-item.text .wb-text').inputValue()) === 'Kick-off');
// Edit on device 2, see it on device 1.
await p2.click('.wb-bar button:has-text("Circle")');
await page.waitForFunction(() => document.querySelectorAll('.wb-item.ellipse').length === 1, null, { timeout: 15000 }).catch(() => {});
check('device 1 receives the circle added on device 2', (await page.locator('.wb-item.ellipse').count()) === 1);

// Mobile width: the page still works (Android app).
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await mp.goto(BASE + '/');
await mp.fill('input[type="email"]', email); await mp.fill('input[type="password"]', pw); await mp.click('button.btn.primary');
await mp.waitForSelector('.menu-btn, .side', { timeout: 30000 });
await mp.goto(BASE + '/#/whiteboards'); await mp.waitForTimeout(1500);
await mp.click('.card:has-text("Launch plan")');
await mp.waitForSelector('.wb-canvas');
check('phone: board opens with no horizontal page overflow', (await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)) && (await mp.locator('.wb-item').count()) === 3);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall whiteboard checks passed');
process.exit(failures ? 1 : 0);
