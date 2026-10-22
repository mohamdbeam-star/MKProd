# MK Prod

A native macOS (SwiftUI) productivity workspace with a ClickUp-style feature set. It's an original implementation with no ClickUp code, assets or branding. It's local-first: everything is stored in `~/Library/Application Support/MKProd/workspace.json`.

## Build & run

```bash
./build_app.sh
open "MK Prod.app"
```

Requirements: macOS 14+ and the Xcode Command Line Tools. Without full Xcode, the script builds against the macOS 26.5 SDK, because the macOS 27 CLT SDK needs SwiftUI macro plugins that only ship with Xcode.

## Features

| Area | What's included |
|---|---|
| Hierarchy | Workspace → Spaces (color, icon, privacy) → Folders → Lists; favorites, rename, duplicate, archive, delete |
| Tasks | Custom statuses per Space, priorities, multiple assignees, watchers, tags, start/due dates, estimates, sprint points, milestones, recurring tasks, subtasks, checklists (with assignees), dependencies (waiting on / blocking), linked tasks, attachments, comments with @mentions and resolve, activity log |
| Custom fields | Text, number, money, dropdown, checkbox, date, URL, email, rating (per Space) |
| Views | List (grouped, collapsible, inline add, drag to regroup), Board (drag between columns), Calendar (month/week, drag to reschedule), Gantt (drag bars, zoom, dependency arrows, today line), Table (sortable, custom-field columns), Workload (capacity heatmap), Mind Map, Form (submissions create tasks) |
| Filtering | Search, assignee, priority, tag, show closed, overdue only, "Me mode"; group by status/priority/assignee/due/list; sort options |
| Home | My Work (overdue/today/next/unscheduled), reminders, recents, notepad, 7-day agenda, goals |
| Inbox | Notifications for assignments, mentions, reminders; read/clear/restore |
| Docs | Nested pages, Markdown editor with live preview/split view, templates, export to `.md`, convert checkboxes to tasks |
| Whiteboards | Stickies, text, shapes, connectors, colors, resize, zoom, convert to task |
| Chat | Channels, per-Space channels, post as any member, create task from message |
| Goals | Folders, owners, due dates; number, currency, true/false and task-linked targets |
| Dashboards | Cards: status donut, priority, workload, overdue, 14-day completions, time tracked, goal progress, recent activity; per-Space scope |
| Time tracking | Global timer (toolbar, ⇧⌘T), per-task timer, manual entries, billable flag, weekly timesheets |
| Automations | When (created / status / priority / assignee / tag / due date passed) → Then (status, priority, assign, tag, move, comment, set due, archive), scoped per Space |
| Templates | Save any task (with subtasks) as a template; instantiate into any list |
| Other | ⌘K command palette and global search, JSON backup/restore, CSV export, macOS notifications for reminders, settings for people/statuses/fields |

## Website, team sync & collaboration

The team website and the sync server are one free Cloudflare Worker with a D1 database (`web/`). The website and the Mac app share the same data and stay in sync within seconds. Setup and deploy steps: **[CLOUD_SETUP.md](CLOUD_SETUP.md)**.

## Security

- **End-to-end encrypted.** Workspace content is encrypted on the Mac or in the browser (AES-256-GCM, P-256 key sharing). The server and Cloudflare only ever store ciphertext.
- **Passwords never leave the device.** They're stretched locally (PBKDF2-SHA256, 600,000 rounds).
- **Invites need a one-time code**, and there's a recovery code for forgotten passwords.
- **Two-factor sign-in** (authenticator app), optional per person and enforceable per workspace by the owner; email confirmation of new accounts; sign-in alerts; a devices list; and a security log per account and per workspace.
- **Sessions:** the website uses an HttpOnly cookie, and the Mac app stores its session and keys in the Keychain.
- **Hardened delivery:** strict security headers on the site, and Mac data files readable only by your macOS user (on top of FileVault).
- **Right to erasure:** delete your account, delete or transfer a workspace.

Design and threat notes: **[SECURITY.md](SECURITY.md)**.

## Budget & procurement (from the previous Budget Tracker)

Available in both the Mac app and the website:

- **Entities** with configurable approval chains and per-person entity roles
- **Budgets** split into line items, showing allocated / spent / committed / pending / balance
- **Orders and direct expenses**:
  - multi-level approval
  - final admin approval for unbudgeted spend
  - PO numbers
  - Ordered → Shipped (tracking number) → Delivered → Completed
  - staff assignment and a full history
- **Shopping catalog** with a cart, plus item requests that need approval
- **Contracts**, flagged active, expiring (within 60 days), expired or renewing
- **Savings**
- **Alerts**: over budget, budget lines ≥90% used, expiring contracts, late deliveries, approvals waiting
- **Analytics**: executive overview, year over year, budget variance, spend analysis (with price variance), order time
- **Reports**: Excel downloads on the website, CSV and a PDF executive report in the Mac app; budget import from Excel/CSV templates
- **Audit log** of every finance action
- **Supplier links** (website): a read-only, expiring, encrypted page per order that the supplier opens without an account to confirm, decline or ask
- **Order record** (website): the full order with its approval trail as PDF or Excel, for auditors
- **Approval delegation** (out of office), honoured by both clients
- **Encrypted file attachments** on tasks (website upload/download; Mac shows them by name)
- **Weekly summary email** every Monday

See **[CLICKUP_PARITY.md](CLICKUP_PARITY.md)** for the full feature checklist.

## Tests

```bash
Tests/api/run.sh        # any machine with Node 20+: ~100 API checks (auth, 2FA, roles, encrypted sync, shares, files, deletion)
Tests/run_sync_e2e.sh   # macOS only: two Mac-client processes against the real Worker, 34 checks
```

Both start the real Worker with `wrangler dev` on a throwaway local database, with a local mail sink so email flows (verification codes, sign-in alerts, notifications) are exercised too.
