# MK Prod cloud: website + team sync on Cloudflare (free)

**Live:** https://mkprod.mohamd-beam.workers.dev. Put this address in the Mac app under Settings → Cloud & Team → Server address.

One Cloudflare Worker provides everything:

- **the website**: the React app in `web/src`
- **the sync API** that both the website and the Mac app use (`web/worker/index.ts`)
- **storage** in a Cloudflare D1 database (`web/migrations`)

Changes made on the website show up in the Mac app and vice versa, usually within about 5 seconds.

## Free-plan limits

| Resource | Free allowance | Typical team use |
|---|---|---|
| Worker requests | 100,000 / day | Each open app or browser tab polls every 4 s while visible (30 s in a background tab) → roughly 7,000 per active person per 8-hour day |
| D1 storage | 5 GB | Years of tasks, docs and orders |
| D1 reads / writes | 5 M / 100 k rows per day | Comfortable for small teams |
| Static assets | Unlimited | The website itself |

A team of **up to about 10 people** working all day stays inside the free plan. If you outgrow it, the Workers Paid plan is $5/month. Nothing needs to change in the code.

## Deploy (one time, about 2 minutes)

You need Node.js and a Cloudflare account. The `wrangler` CLI on this Mac is already signed in.

```bash
cd web
npm install
npm run deploy
```

`npm run deploy` does three things (the `mkprod` database already exists, and its id is in `web/wrangler.jsonc`):

1. builds the website
2. creates the D1 database on first run and applies the migrations
3. publishes the Worker

It prints the site address, e.g. `https://mkprod.<your-subdomain>.workers.dev`.

To use your own domain, open Cloudflare dashboard → Workers & Pages → mkprod → Settings → Domains & Routes → Add custom domain.

## First use

1. Open the site address and choose **Create account**. Your password (10+ characters) never leaves your device.
2. **Save the recovery code** you're shown. It's the only way back in if you forget your password, and it's shown once.
3. Create a workspace. It's end-to-end encrypted from the start.
4. In **Team & account** (👥 at the bottom of the sidebar), invite a teammate by email. You get a **one-time invite code**; send it to them privately.
5. The teammate creates an account with that email on the site or in the Mac app, then enters the code (**Join** under *Choose a workspace*). Your app shares the encryption key with them automatically the next time it syncs.

### Mac app

In the app: **Settings (⌘,) → Cloud & Team**.

1. Paste the site address → **Save server**.
2. Sign in with the same account as on the website.
3. Do one of the following:
   - **Open** your workspace.
   - **Publish this workspace** to upload local data as a new encrypted workspace.
   - **Join** with an invite code.

Security details: **[SECURITY.md](SECURITY.md)**.

## Roles

| Role | Can do |
|---|---|
| Owner | Everything; the only one who can create admins; can't be removed |
| Admin | Invite/remove people, change roles (not to admin), reset passwords, finance settings, final approval of unbudgeted spend |
| Member | Edit everything; approve orders where their entity role matches the pending step |
| Viewer | Read everything; their edits are not shared and roll back on the next sync |

The server enforces workspace roles. Order approvals follow each entity's approval chain (**Finance settings → Entities**), the same way the old budget tracker did.

**Forgotten password:**
- **With your recovery code:** choose **Forgot password?** on the sign-in screen. Nothing is lost.
- **Without it:** an admin chooses **Reset password**, which gives a one-time temporary password. You get new encryption keys, and teammates' apps re-share the workspace key automatically.
- **If you're the only owner and lose both** your password and recovery code, the encrypted server copy can't be decrypted (by design). Your Mac still holds a full local copy.

## How sync behaves

- Every object (task, doc, budget, order…) is one row in D1 with a change counter. Clients pull everything after their last counter, then push what changed.
- **Two people editing the same item:** changes merge field by field. Comments, checklist items and order lines from both sides are kept. If both change the same field, the later save wins.
- **Offline:** the Mac app stores everything locally, and the website caches in the browser (IndexedDB). Both catch up when back online.
- **Presence:** the sidebar shows who is online, and a task shows who else has it open.
- **Notifications:** assignments, @mentions, assigned comments, orders waiting for *your* approval, and status changes of *your* orders go to the Inbox. You also get a desktop notification if you allow it.

## Local development

```bash
cd web
npm install
npm run db:local       # create the local D1 tables
npm run dev            # builds the site and serves it + the API on http://127.0.0.1:8787
```

Point the Mac app's server address at `http://127.0.0.1:8787` to test both clients together.

## Tests

- `Tests/interop/run.sh` checks that the Mac app's cryptography (CryptoKit) and the website's (WebCrypto) produce byte-compatible keys and ciphertext.
- `Tests/run_sync_e2e.sh` starts the real Worker under `wrangler dev` with a throwaway database. Two separate Mac-client processes (Alice and Bob) then run through the following, and the script finally confirms the database holds only ciphertext:

- invites
- assignments and @mentions
- presence
- trash
- viewer lock-down
- concurrent-edit merge
- a full purchase order: submit → manager approval → ordered → delivered → budget spent
- invite codes and key sharing
- recovery code and admin password reset (with key re-sharing)
- member removal with key rotation

## Email notifications

Each teammate's app writes the email text, because only the apps can read the encrypted data. The Worker then checks the recipient's preferences (Settings › Notifications on the Mac, Team & account on the website), skips duplicates, and sends the email over SMTP. Until SMTP is configured, no email is sent and the settings screens say so.

Any SMTP account works. A free option is a Gmail account with an App Password (Google Account › Security › 2-Step Verification › App passwords). Run these in `web/`; each command asks for its value:

```bash
npx wrangler d1 migrations apply mkprod --remote
npx wrangler secret put SMTP_HOST      # smtp.gmail.com
npx wrangler secret put SMTP_PORT      # 465
npx wrangler secret put SMTP_USER      # the Gmail address
npx wrangler secret put SMTP_PASS      # the 16-character app password
npx wrangler secret put SMTP_FROM      # the same Gmail address
npm run deploy
```

Then use **Send test email** in Settings › Notifications.

When emails are sent:

- **Task assigned:** to the new assignee.
- **Task updated:** to assignees and watchers. Edits made within 15 minutes go out as one email.
- **@mention:** to the person mentioned.
- **Order approval:** to the people who can approve the order, and to the requester when its status changes.
- **Contract ending:** 60, 30, 14, 7 and 1 day before the end date, to the people assigned to the contract's entity. If the contract has no entity, it goes to the owners and admins.

Nobody gets an email about their own edits. Each person can turn off any type, or hide the details so the email only says that something happened.
