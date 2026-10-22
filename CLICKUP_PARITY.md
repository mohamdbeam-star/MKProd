# ClickUp → MK Prod feature parity

## What the installed ClickUp app actually contains

I analyzed `/Applications/ClickUp.app` (version 3.5.343, `com.clickup.desktop-app`) statically with REA. Nothing was executed and no account was used.

- `Contents/Resources/app.asar` (210 MB, 23,741 files) is an **Electron shell**. Outside `node_modules` it holds only `main.js`, `preload.js`, one bundled chunk (`907.js`), and small HTML pages (loading, error, find-in-page, screen picker, camera window, prompt).
- `main.js` loads the product UI remotely from **`https://app.clickup.com`** (other hosts: `doc.clickup.com`, `forms.clickup.com`, `sharing.clickup.com`, `export.clickup.com`, `run.clickup.ai`).
  - **This means ClickUp's task, doc and view features aren't in the binary, so they can't be extracted from it.**
  - The web feature list below comes from ClickUp's public product, not from the binary.
- REA Evidence `ev_0cb46b0e…a4a63` (main/preload/907.js) records one context-bridge API with 24 members: `app, appMenu, commServer, contents, contextMenu, desktopCapturer, menubar, nativeTheme, offline, pushNotifications, shortcut, systemPreferences, tray, views, window, …`. It also records IPC channels including `commandBar.getMode`, `views.delete` and `window.getType`.
- Strings in `main.js` and the bundled native add-ons show these desktop features:
  - command bar window
  - global shortcut
  - tray/menubar
  - push notifications (FCM)
  - clipboard history
  - screen capture (Clips)
  - meeting "notetaker" detection
  - offline mode
  - encrypted local SQLite cache
  - keychain storage (`keytar`)

## Parity matrix

✅ in MK Prod · 🟡 partial · ❌ not built (reason given)

### Desktop shell (from the binary)

| ClickUp desktop feature | MK Prod |
|---|---|
| Global shortcut + command bar quick-create | ✅ ⌃⌥Space floating Quick Add panel from any app |
| Tray / menubar panel | ✅ Menu bar extra: running timer, due-today tasks, quick add |
| Push notifications | ✅ macOS notifications for reminders, assignments, mentions |
| Offline mode | ✅ Local-first; sync catches up when back online |
| Secure credential storage | ✅ Session in macOS Keychain |
| Deep links | ✅ `mkprod://task/<id>`, `mkprod://list/<id>`, `mkprod://doc/<id>`; *Copy Link* on tasks |
| Find in page | 🟡 ⌘K global search and per-view filter, no in-page find bar |
| Clips (screen recording) | ❌ Not built |
| AI Notetaker / meeting detection | ❌ Needs an AI transcription service |
| Clipboard history | ❌ Not a project-management feature; skipped |

### Product (ClickUp web app, public features)

| Area | Status |
|---|---|
| Hierarchy: Workspace › Space › Folder › List, Everything, Favorites | ✅ |
| Custom statuses per Space, custom fields (9 types) | ✅ |
| Tasks: assignees, watchers, priority, tags, dates, estimates, points, milestones, recurring, subtasks, checklists, dependencies, links, attachments | ✅ |
| Comments, @mentions, **assigned comments**, resolve | ✅ |
| Views: List, Board, Calendar, Gantt, Table, Workload, Mind Map, Form | ✅ |
| **Bulk edit** (multi-select: status, priority, assignee, due, move, archive, delete) | ✅ |
| **Sprints** (dates, points, burndown, complete sprint → roll over unfinished) | ✅ |
| Archive and **Trash with restore** | ✅ |
| Home / My Work, Inbox, Reminders, Notepad | ✅ |
| Docs (nested pages, Markdown, templates, export) | ✅ |
| Whiteboards, Chat channels | ✅ |
| Goals and targets, Dashboards (8 card types), Time tracking and timesheets | ✅ |
| Automations (6 triggers × 8 actions), Templates | ✅ |
| **Import from ClickUp CSV export** | ✅ (File → Import from ClickUp) |
| **Cloud sync + multi-user collaboration** (invites, roles, presence, notifications, field-level merge) | ✅ via a free Cloudflare Worker + D1, shared with the website |
| **Website** with the same data | ✅ list/board/calendar/table/Gantt views, task drawer, docs, chat, goals, timesheets, trash, team admin |
| Timeline / Activity / Embed views | 🟡 Gantt covers Timeline; activity is per task |
| Saved views per location, task types, custom task IDs | ❌ Not yet |
| Public share links, guests with per-item permissions | ❌ Roles are per workspace; no public links |
| Real-time co-editing of the same doc paragraph | 🟡 Merged per field every ~4 s, not keystroke-level |
| Email-in, integrations (Slack, GitHub, Google Calendar…), ClickUp AI, mobile apps | ❌ Out of scope for a local Mac app |

## Features from the previous Budget Tracker (Google Apps Script site)

These come from `files.zip`: `Complete-AppsScript.js`, 227 KB, and `index.html`, 707 KB. Both the Mac app and the website now include them.

| Budget Tracker feature | MK Prod |
|---|---|
| Entities, years, categories, contract types, item categories | ✅ Finance settings |
| Approval hierarchy per entity + entity roles (Requestor, Manager 1, Entity Manager…) | ✅ editable approval chain and role per person |
| Budgets with line items (allocated vs spent) | ✅ plus committed, pending and balance |
| Orders / expenses with approval workflow, PO, LPO, supplier, items | ✅ |
| Unbudgeted expense approval | ✅ extra admin approval step |
| Shipped (tracking) / Delivered / Completed, order history | ✅ |
| Assign order to procurement staff | ✅ |
| Beam Shopping portal (catalog + cart + item approval) | ✅ Shopping catalog |
| Savings records | ✅ |
| Contracts with expiry tracking | ✅ |
| Alerts page | ✅ |
| Executive view, analytics, YoY, variance, spend analysis, order-time analytics | ✅ |
| Reports & Excel export / templates / PDF | ✅ Excel on the website; CSV + PDF in the Mac app |
| Projects & tasks with Kanban / calendar / comments / time entries | ✅ already part of MK Prod |
| Audit log | ✅ |
| User management, admin-approved users, password reset by email code | 🟡 invites + roles; admins issue temporary passwords (no email service configured) |
| Email notifications (MailApp) | 🟡 in-app Inbox + desktop notifications instead of email |
| Bidding portal / company policy links | ❌ these were external links in the old site |
| Convert BSP order to budget order | 🟡 checkout from the catalog creates a budget order directly |
