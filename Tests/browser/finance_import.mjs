// Browser check of the bulk Import / Export menu on Budgets, Shopping catalog and Contracts:
// one button, template download, upload of a filled template (Excel), update on re-upload,
// export, hostile cell contents (HTML, formulas), the row-by-row editors, and the result
// reaching a second device of the same person.
// Needs Playwright and the Worker on :8797 with a fresh DB (see personal_sync.mjs).
import { chromium } from 'playwright';
import * as XLSX from '../../web/node_modules/xlsx/xlsx.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

XLSX.set_fs(fs); // the ESM build needs the file system handed in for readFile/writeFile
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkp-import-'));
const year = new Date().getFullYear();
let failures = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${extra}`); if (!ok) failures++; };
function xlsxFile(name, rows, sheet = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { cellDates: true }), sheet);
  const p = path.join(tmp, name);
  XLSX.writeFile(wb, p, { cellDates: true });
  return p;
}
async function saved(download) { const p = await download.path(); if (!p) throw new Error('download failed: ' + (await download.failure())); return p; }
const firstSheet = (p) => { const wb = XLSX.readFile(p, { cellDates: true }); return wb.Sheets[wb.SheetNames[0]]; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
const waitToast = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.toast')?.textContent ?? ''), re.source, { timeout: 15000 }).then(() => page.textContent('.toast'));
const openMenu = async () => { await page.click('.toolbar button:has-text("Import / Export")'); await page.waitForSelector('.data-menu .menu'); };

const email = `import-${Date.now()}@example.test`, pw = 'import-test-pass-1';
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
await page.waitForTimeout(2500);

// ---------------------------------------------------------------- Budgets
await page.goto(BASE + '/#/budgets'); await page.waitForSelector('h1:has-text("Budgets")');
check('budgets: a single Import / Export button', (await page.locator('.toolbar button:has-text("Import / Export")').count()) === 1
  && (await page.locator('.toolbar :text("Import Excel")').count()) === 0 && (await page.locator('.toolbar button:has-text("Template")').count()) === 0);
check('budgets: "+ New budget" (one by one) still there', (await page.locator('.toolbar button:has-text("New budget")').count()) === 1);
await openMenu();
check('budgets: menu offers template, upload, export', (await page.locator('.data-menu .menu [role=menuitem]').count()) === 3
  && (await page.locator('.data-menu .menu').innerText()).includes('Columns: Entity, Year, Category'));
await page.keyboard.press('Escape');
check('budgets: Escape closes the menu', (await page.locator('.data-menu .menu').count()) === 0);
await openMenu();
let [dl] = await Promise.all([page.waitForEvent('download'), page.click('.data-menu .menu [role=menuitem]:has-text("Download template")')]);
let rows = XLSX.utils.sheet_to_json(firstSheet(await saved(dl)));
check('budgets: template is an Excel file with example rows', dl.suggestedFilename() === 'budget-template.xlsx' && rows.length === 3 && 'Entity' in rows[0] && 'Line Item' in rows[0] && 'Allocated' in rows[0]);
const budgetsFile = xlsxFile('budgets-filled.xlsx', [
  { Entity: 'Finance Dept', Year: year, Category: 'IT', 'Line Item': 'Laptops', Allocated: 50000, Notes: 'Replacement cycle' },
  { Entity: 'finance dept', Year: String(year), Category: 'IT', 'Line Item': 'Software licences', Allocated: '12,000', Notes: '' },
  { entity: 'Operations', YEAR: year, category: 'Facilities', 'line item': 'Cleaning', allocated: 30000 },  // odd header casing
  { Entity: '', Year: year, Category: 'X', 'Line Item': 'no entity', Allocated: 1 },                          // invalid → skipped
  { Entity: 'Finance Dept', Year: 'abc', Category: 'IT', 'Line Item': 'bad year', Allocated: 1 },            // invalid → skipped
]);
await page.setInputFiles('[data-testid="import-budgets"]', budgetsFile);
let t = await waitToast(/budget line/);
check('budgets: 3 lines added, 2 bad rows skipped', /3 budget line\(s\) added, 0 updated, 2 row\(s\) skipped/.test(t), t);
await page.waitForTimeout(400);
const body = await page.innerText('body');
check('budgets: one IT budget for Finance Dept with both lines, one Facilities budget', (await page.locator('.card h3:has-text("IT ·")').count()) === 1 && (await page.locator('.card h3:has-text("Facilities ·")').count()) === 1 && body.includes('Laptops') && body.includes('Software licences') && body.includes('Cleaning'));
check('budgets: "12,000" parsed as a number', body.includes('12,000') || body.includes('12 000') || body.includes('12000'));
await page.waitForTimeout(3200);
await page.setInputFiles('[data-testid="import-budgets"]', budgetsFile);
t = await waitToast(/updated/);
check('budgets: re-upload updates instead of duplicating', /0 budget line\(s\) added, 3 updated/.test(t) && (await page.locator('.card h3:has-text("IT ·")').count()) === 1, t);
await openMenu();
[dl] = await Promise.all([page.waitForEvent('download'), page.click('.data-menu .menu [role=menuitem]:has-text("Export")')]);
rows = XLSX.utils.sheet_to_json(firstSheet(await saved(dl)));
check('budgets: export has one row per line with figures', rows.length === 3 && 'Balance' in rows[0] && rows.find((r) => r['Line Item'] === 'Laptops')?.Allocated === 50000, JSON.stringify(rows[0]));

// ---------------------------------------------------------------- Shopping catalog
await page.goto(BASE + '/#/catalog'); await page.waitForSelector('h1:has-text("Shopping catalog")');
const arrowButtons = async () => (await page.locator('.toolbar button, .toolbar label.btn').allInnerTexts()).filter((x) => /^[⬇⬆]/.test(x.trim())).length;
check('catalog: a single Import / Export button', (await page.locator('.toolbar button:has-text("Import / Export")').count()) === 1 && (await arrowButtons()) === 0);
await page.click('.toolbar button:has-text("Add item")');
check('catalog: "+ Add item" opens the single-item form', (await page.locator('.modal h2:has-text("Add catalog item")').count()) === 1 && (await page.locator('.modal input').count()) >= 4);
await page.click('.modal button:has-text("Cancel")');
await openMenu();
[dl] = await Promise.all([page.waitForEvent('download'), page.click('.data-menu .menu [role=menuitem]:has-text("Download template")')]);
rows = XLSX.utils.sheet_to_json(firstSheet(await saved(dl)));
check('catalog: template downloaded', dl.suggestedFilename() === 'catalog-template.xlsx' && rows.length === 3 && 'Unit price' in rows[0]);
const catalogFile = xlsxFile('catalog-filled.xlsx', [
  { Name: 'A4 copy paper 80gsm', Category: 'Stationery', 'Unit price': 95, Unit: 'box', Supplier: 'Office Depot' },
  { Name: '<img src=x onerror="window.__xss=1"> paper', Category: 'IT Equipment', 'Unit price': '4,200.50', Unit: 'pcs', Supplier: 'Dell' },
  { Name: '=HYPERLINK("http://evil.example","Click")', Category: 'Brand new category', 'Unit price': 1, Unit: '', Supplier: '' },
  { Name: 'No price here', Category: 'Other' },
]);
await page.setInputFiles('[data-testid="import-catalog items"]', catalogFile);
t = await waitToast(/added/);
check('catalog: 3 added, 1 skipped', /3 added, 0 updated, 1 row\(s\) skipped/.test(t), t);
await page.waitForTimeout(400);
const cards = page.locator('.grid.g3 .card');
check('catalog: 3 cards shown', (await cards.count()) === 3);
check('catalog: HTML in a product name is shown as text, not executed', (await page.evaluate(() => window.__xss)) === undefined && (await page.innerText('body')).includes('<img src=x onerror="window.__xss=1"> paper') && errors.length === 0, errors.join(' | '));
check('catalog: new category added to the filter', (await page.locator('.toolbar select option:has-text("Brand new category")').count()) === 1);
await openMenu();
[dl] = await Promise.all([page.waitForEvent('download'), page.click('.data-menu .menu [role=menuitem]:has-text("Export")')]);
const sheet = firstSheet(await saved(dl));
rows = XLSX.utils.sheet_to_json(sheet);
const formulaCell = Object.keys(sheet).filter((k) => k[0] !== '!').map((k) => sheet[k]).find((c) => String(c.v).startsWith('=HYPERLINK'));
check('catalog: export writes "=HYPERLINK" as text, not as a formula', rows.length === 3 && formulaCell && formulaCell.t === 's' && !formulaCell.f);
check('catalog: "4,200.50" parsed', rows.find((r) => r.Supplier === 'Dell')?.['Unit price'] === 4200.5);
await page.waitForTimeout(3200);
await page.setInputFiles('[data-testid="import-catalog items"]', xlsxFile('catalog-update.xlsx', [
  { Name: 'A4 COPY PAPER 80gsm', Category: 'Stationery', 'Unit price': 99, Unit: 'box', Supplier: 'office depot' },
  { Name: 'Stapler', Category: 'Stationery', 'Unit price': 12, Unit: 'pcs', Supplier: 'Office Depot' },
  { Name: 'Stapler', Category: 'Stationery', 'Unit price': 11, Unit: 'pcs', Supplier: 'Office Depot' },   // duplicate row in the same file
]));
t = await waitToast(/added/);
check('catalog: same name + supplier (any case) updates; a duplicate row in one file does not double', /1 added, 2 updated/.test(t) && (await cards.count()) === 4, t);

// ---------------------------------------------------------------- Contracts
await page.goto(BASE + '/#/contracts'); await page.waitForSelector('h1:has-text("Contracts")');
check('contracts: a single Import / Export button', (await page.locator('.toolbar button:has-text("Import / Export")').count()) === 1 && (await page.locator('.toolbar button:has-text("Excel")').count()) === 0);
await page.click('.toolbar button:has-text("New contract")');
check('contracts: "+ New contract" opens the single-contract form', (await page.locator('.modal h2:has-text("New contract")').count()) === 1);
await page.click('.modal button:has-text("Cancel")');
await openMenu();
[dl] = await Promise.all([page.waitForEvent('download'), page.click('.data-menu .menu [role=menuitem]:has-text("Download template")')]);
rows = XLSX.utils.sheet_to_json(firstSheet(await saved(dl)));
check('contracts: template downloaded with the contract columns', dl.suggestedFilename() === 'contracts-template.xlsx' && rows.length === 2 && ['Title', 'Supplier', 'Start', 'End', 'Auto renew', 'Email'].every((k) => k in rows[0]));
const contractsFile = xlsxFile('contracts-filled.xlsx', [
  { Title: 'Cleaning services HQ', Supplier: 'Cleanco', Type: 'Service', Entity: 'Finance Dept', Value: 120000, Start: new Date(year, 0, 1), End: new Date(year, 11, 31), 'Auto renew': 'Yes', Contact: 'Sara Ali', Email: 'sara@cleanco.example', Phone: '+971 50 000 0000', Notes: 'Monthly invoicing' },
  { Title: 'Printer fleet lease', Supplier: 'Xerox', Type: 'Lease', Entity: '', Value: '36,000', Start: `15/03/${year}`, End: `${year + 2}-02-28`, 'Auto renew': 'no' },
  { Title: 'Old framework agreement', Supplier: 'Acme', Type: 'Supply', Value: 10, Start: `${year - 3}-01-01`, End: `${year - 2}-01-01`, 'Auto renew': 'Yes' },
  { Title: 'Ends before it starts', Supplier: 'X', Start: `${year}-05-01`, End: `${year}-04-01` },   // invalid → skipped
  { Supplier: 'No title', Start: `${year}-01-01`, End: `${year}-12-31` },                            // invalid → skipped
]);
await page.setInputFiles('[data-testid="import-contracts"]', contractsFile);
t = await waitToast(/contract/);
check('contracts: 3 added, 2 skipped', /3 contract\(s\) added, 0 updated, 2 row\(s\) skipped/.test(t), t);
await page.waitForTimeout(400);
const trs = page.locator('table.t tbody tr');
check('contracts: 3 rows in the table', (await trs.count()) === 3);
const cleaning = page.locator('table.t tbody tr', { hasText: 'Cleaning services HQ' });
check('contracts: entity matched by name, status computed', (await cleaning.innerText()).includes('Finance Dept') && /Active|Expiring/.test(await cleaning.innerText()));
check('contracts: expired auto-renew contract shows Renewing', (await page.locator('table.t tbody tr', { hasText: 'Old framework' }).innerText()).includes('Renewing'));
await openMenu();
[dl] = await Promise.all([page.waitForEvent('download'), page.click('.data-menu .menu [role=menuitem]:has-text("Export")')]);
rows = XLSX.utils.sheet_to_json(firstSheet(await saved(dl)));
const lease = rows.find((r) => r.Title === 'Printer fleet lease');
check('contracts: dates from Excel cells, dd/mm/yyyy and ISO all parsed', rows.find((r) => r.Title === 'Cleaning services HQ')?.Start === `${year}-01-01` && lease?.Start === `${year}-03-15` && lease?.End === `${year + 2}-02-28` && lease?.Value === 36000 && lease?.['Auto renew'] === 'No', JSON.stringify(lease));
await cleaning.click();
check('contracts: clicking a row opens the editor with the imported values', (await page.locator('.modal h2:has-text("Edit contract")').count()) === 1 && (await page.inputValue('.modal input >> nth=0')) === 'Cleaning services HQ' && (await page.locator('.modal input[type=checkbox]').first().isChecked()));
await page.click('.modal button:has-text("Cancel")');
await page.waitForTimeout(3200);
await page.setInputFiles('[data-testid="import-contracts"]', xlsxFile('contracts-update.xlsx', [{ Title: 'cleaning services hq', Supplier: 'CLEANCO', Value: 125000, Start: `${year}-01-01`, End: `${year + 1}-12-31`, 'Auto renew': 'Yes' }]));
t = await waitToast(/contract/);
check('contracts: re-upload updates by title + supplier', /0 contract\(s\) added, 1 updated/.test(t) && (await trs.count()) === 3, t);

// ---------------------------------------------------------------- Second device of the same person sees everything
const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const p2 = await ctx2.newPage();
await p2.goto(BASE + '/');
await p2.fill('input[type="email"]', email);
await p2.fill('input[type="password"]', pw);
await p2.click('button.btn.primary');
await p2.waitForSelector('.side', { timeout: 30000 });
await p2.goto(BASE + '/#/contracts');
await p2.waitForFunction(() => document.querySelectorAll('table.t tbody tr').length === 3, null, { timeout: 15000 }).catch(() => {});
check('device 2: imported contracts are there', (await p2.locator('table.t tbody tr').count()) === 3);
await p2.goto(BASE + '/#/catalog'); await p2.waitForTimeout(800);
check('device 2: imported catalog is there', (await p2.locator('.grid.g3 .card').count()) === 4);
await p2.goto(BASE + '/#/budgets'); await p2.waitForTimeout(800);
check('device 2: imported budgets are there', (await p2.locator('.card h3:has-text("IT ·")').count()) === 1);

check('no page errors or dialogs during the run', errors.length === 0, errors.join(' | '));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall import/export checks passed');
process.exit(failures ? 1 : 0);
