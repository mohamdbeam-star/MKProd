# MK Prod test report

**Date:** 22 October 2026 · **Build:** `main` after "One Import / Export button; contract bulk import; attacker test suite"
**Scope:** website (also the Windows and Android apps, which run the same site), the sync server (Cloudflare Worker + D1), and the Mac app's finance screens.
**How:** the real Worker started locally on a throwaway database, driven (1) as a user through a real browser with Playwright and (2) as an attacker through raw HTTP. Everything here is repeatable with the commands at the end.

## Summary

| Suite | What it does | Checks | Result |
|---|---|---|---|
| `Tests/api/core.mjs` | sign-up, sign-in, lockout, cookies/CSRF, invites, roles, encrypted sync, key sharing, recovery, admin reset, removal + key rotation | 42 | all pass |
| `Tests/api/trust_and_compliance.mjs` | email verification, sign-in alerts, devices, 2FA + backup codes, workspace 2FA policy, security logs, supplier links, file attachments, weekly digest, transfer, account and workspace deletion | 53 | all pass |
| `Tests/api/adversarial.mjs` (new) | attacker's-eye checks, see below | 87 | all pass |
| `Tests/browser/finance_import.mjs` (new) | the Import / Export menu on Budgets, Catalog, Contracts as a user | 34 | all pass |
| `Tests/browser/sidebar.mjs` | space rename/delete, switching between two workspaces, Apps page | 6 | all pass |
| `Tests/browser/personal_sync.mjs` | reminders and Inbox follow the person across devices, invisible to teammates | 7 | all pass |
| Type check + production build | `tsc --noEmit`, `vite build` | | clean |
| Mac app | compiled by the GitHub "Mac app" workflow (no Swift toolchain in this environment) | | see the latest run on GitHub |

**Total: 229 automated checks, 0 failures** after the fixes listed under *Findings*.

## 1. As a user: the new Import / Export flow

Each of Budgets, Shopping catalog and Contracts now has **one** `⇅ Import / Export` button. It opens a small menu:

1. **Download template**: an Excel file with the exact columns and two or three example rows.
2. **Upload filled template…**: Excel or CSV. Rows that match an existing entry are updated, new ones are added, unusable rows are counted and reported in the confirmation.
3. **Export to Excel**: everything as it is now.

`+ New budget`, `+ Add item` / `+ Request item` and `+ New contract` are unchanged for one-by-one entry.

What was verified in the browser:

- Only one bulk button per page; the old `⬇ Template`, `⬆ Import Excel`, `⬇ Export` and `⬇ Excel` buttons are gone. Escape and clicking elsewhere close the menu; items work with the keyboard.
- Templates download with the right name and columns (`budget-template.xlsx`, `catalog-template.xlsx`, `contracts-template.xlsx`).
- **Budgets:** five rows uploaded, three valid ones imported into two budgets (same Entity + Year + Category merge into one budget), two bad rows (no entity, non-numeric year) reported. `12,000` as text is read as a number. Header casing and spacing don't matter (`entity`, `YEAR`, `line item`). Re-uploading the same file updates the three lines instead of duplicating them. Export has one row per line with Spent / Committed / Pending / Balance.
- **Catalog:** three products imported, one row without a price skipped. A new category in the file is added to the category filter. `4,200.50` is read as 4200.5. Re-upload with a different letter case of name and supplier updates the price; two identical rows in one file produce one item.
- **Contracts (new):** dates arrive as real Excel dates, as `2026-12-31`, or as `15/03/2026`, and all parse; `Auto renew` accepts Yes/No/true/1/x; `Entity` is matched by name; the status (Active, Expiring, Renewing…) is computed; a row whose end is before its start and a row without a title are skipped and reported. Clicking an imported row opens the normal editor with the values. Re-upload matches on Title + Supplier.
- **Hostile cell content:** a product named `<img src=x onerror=…>` is displayed as text and does not run; a product named `=HYPERLINK("http://evil…")` is exported as a text cell, not a formula.
- **Sync:** a second browser signed in as the same person sees the imported budgets, catalog and contracts within seconds. No page errors or dialogs in the whole run.

Mac: the same menu (CSV template / upload / export) exists on the three screens, with the same matching rules. It is built by the GitHub workflow; no Swift compiler is available in this test environment, so its build result is the workflow run on GitHub.

## 2. As an attacker: what was tried and what happened

All of the following hold (87 checks in `Tests/api/adversarial.mjs`):

**Access control**
- A signed-in user who is not a member of a workspace gets **403** on every workspace route: sync, team list, shares, security log, rename, delete, invite, role change, member removal, file read. Unknown workspace ids also return 403 (no existence leak); malformed ids 404.
- Records never cross workspaces: the same record id in two workspaces stays separate; a workspace never returns another's records.
- Inside a workspace: members cannot invite, rename, change roles or read the security log; admins cannot promote to admin, demote admins, reset the owner's password, invite admins or transfer ownership; nobody can change or remove the owner; a second owner cannot be created. Viewers can read but cannot push or delete records, create supplier links, upload files or send notifications.

**Authentication**
- Tokens are accepted only as a Bearer header or the HttpOnly cookie, never in the URL. Tampered tokens, Basic auth and logged-out tokens are rejected. Cookie sessions need the `X-MKProd` header for non-GET requests (CSRF). After 8 wrong passwords the account is locked (429).
- Sign-in gives the same answer for an unknown email and a wrong password. Malformed auth keys and non-string fields return 400, not 500.
- `PATCH /api/me` ignores `id`, `email`, `emailVerified`, rejects bad colors and caps the name at 80 characters (no mass assignment).
- `/api/apps` (download links) requires sign-in.

**Brute force and flooding**
- Invite-code guessing is limited to 20 attempts per hour per account; supplier-link replies to 20 per hour per IP (and are refused when replies are off); sign-ups to 10 per hour per IP; recovery to 10 per hour per IP.

**Malformed and oversized input**
- Broken JSON → 400; record kinds and ids are validated (SQL-looking strings and `../` are rejected); plaintext records are refused in an encrypted workspace (426); wrong key version → 409; a record over 900 KB → 413; a body over 4 MB → 413; share blobs over 200 KB are refused; share expiry is capped at 90 days; unknown roles and invalid emails → 400. Odd types for cursor, push and viewing are tolerated. SQL-looking query parameters are harmless (prepared statements everywhere).

**Response hygiene**
- API responses: `nosniff`, `no-store`, HSTS, `no-referrer`, no server fingerprint, no password hashes, salts or 2FA secrets in any response.
- Site: Content-Security-Policy without inline scripts, `frame-ancestors 'none'` and `X-Frame-Options: DENY` (no clickjacking), Permissions-Policy, COOP; no CORS headers for foreign origins; TRACE is not served.
- Supplier link responses contain neither the workspace id nor the creator; an unknown link is a plain 404. Another workspace cannot revoke my link.
- Names are HTML-escaped in emails (checked with a name containing `<b>`).

## 3. Findings

Fixed in this build:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium (data quality) | A blank *Unit price* / *Allocated* cell was imported as **0** instead of being rejected, so a half-filled sheet silently created zero-priced items and zero budgets. | Blank numbers are now invalid; the row is skipped and counted in the confirmation ("1 row(s) skipped (no name or price)"). Web and Mac. |
| 2 | Low | A hand-edited sheet with two columns matching the same field (e.g. `Entity` and `entity`) could pick the empty one and skip the row. | The first filled matching column is used. |
| 3 | Low | Two identical new rows in one file created two catalog items / contracts. | Matching now also sees rows added earlier in the same upload. |
| 4 | Low (hardening) | Mac CSV exports wrote cells starting with `=`, `+`, `-`, `@` verbatim; opened in Excel such a cell runs as a formula (CSV injection) if a teammate typed it into a name or note. | Those cells are prefixed with an apostrophe on export (numbers and phone numbers are left alone). The website's Excel exports were already safe: strings are written as text cells. |
| 5 | Low (hardening) | Imports had no size limit on the uploaded file or the text in a cell. | Files over 10 MB are refused; text fields are capped (name 200, notes 2000, …) so one row cannot approach the 900 KB record limit. |
| 6 | Info | Budget import was offered to every role although creating a budget needs an admin; viewers saw import on catalog/contracts although the server rejects their pushes. | The upload entry is shown only to roles that may write (budgets: owners/admins; catalog/contracts: anyone except viewers), with a clear message otherwise. |

Observations, no change made:

- **Sign-up tells you whether an email already has an account** (409). Sign-in does not. This is the usual trade-off for a clear sign-up experience; the per-IP limit of 10 sign-ups per hour keeps it from being used for bulk enumeration.
- Rate limits key on Cloudflare's client IP. Behind one corporate NAT, a team of many people shares a limit for sign-up, recovery and supplier-link views (120/hour); large enough for normal use, worth raising if a big office reports "Too many requests".
- Imports run in the browser and push one encrypted record per budget / item / contract; a sheet with thousands of rows works but takes a few sync rounds (500 records per pull page). Fine for procurement catalogs; not meant as a database loader.
- The static-site headers come from `web/public/_headers` and were confirmed on the local Worker; they apply to the live site through the same assets configuration.

## 4. Reproduce

```bash
Tests/api/run.sh                              # ~3 min: core + trust & compliance + adversarial (needs Node 20+)
cd web && npm run build && npm run db:local && npx wrangler dev --port 8797 &   # the site for the browser tests
node Tests/browser/finance_import.mjs         # needs Playwright (npm i -D playwright in web/)
node Tests/browser/sidebar.mjs
node Tests/browser/personal_sync.mjs
```

`Tests/api/run.sh` refuses to run if something else is already listening on its port, so a stale `wrangler dev` cannot make the results meaningless.
