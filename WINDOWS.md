# MK Prod on Windows

MK Prod runs on Windows as an installed app: its own window, Start-menu entry, taskbar icon,
notifications, and it opens while offline. It installs **per user, with no admin rights** and no
installer file, because it is the website packaged by the browser (a "progressive web app").
Every feature matches the website exactly, since it *is* the same code, including end-to-end
encryption, two-factor sign-in, approvals, supplier links, file attachments and the order record.

## Install (about 20 seconds)

Microsoft Edge (already on every Windows 10/11 PC) or Google Chrome:

1. Open **https://mkprod.mohamd-beam.workers.dev** and sign in.
2. Click **⬇ Install as an app** at the bottom of the left sidebar. (If you don't see it: Edge menu
   **⋯ → Apps → Install MK Prod**, or in Chrome the install icon at the right end of the address bar.)
3. Confirm. MK Prod opens in its own window and appears in the Start menu. Pin it to the taskbar
   from there if you like.

Nothing else to do. Updates arrive automatically the next time the app opens online.

## Everyday use

- **Offline:** the app opens and shows your workspace from its encrypted local copy; edits sync
  when you're back online.
- **Notifications:** allow them when asked, so assignments, mentions and approvals pop up on the
  desktop.
- **Sign out / remove:** Start menu → right-click MK Prod → Uninstall (per user, no admin), or
  inside the app: Team & account → Sign out.

## Company-managed PCs

- Works on standard user accounts; nothing is written outside the user's profile.
- Only outbound HTTPS to `mkprod.mohamd-beam.workers.dev` is needed.
- If Edge is locked down so that app installation is blocked by policy, the website works in a
  normal browser tab with identical features; only the separate window and Start-menu entry are
  lost.

## Why not a classic .exe?

A traditional installer would mean a second code base to keep in step with the website and the
Mac app, and would need Windows machines to build, sign and test on. The installed web app gives
the same result with none of that. If a signed `.exe` is ever required (for example by an IT
policy), the website can be wrapped as a desktop app without changing any feature code; ask for
it when the need arises.
