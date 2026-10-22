# Removing the "could not verify" warning on the Mac

macOS shows *"Apple could not verify 'MK Prod' is free of malware"* for any app that Apple's
notarization service hasn't scanned. Notarization needs an **Apple Developer Program**
membership ($99/year). Once set up, the GitHub build signs and notarizes every release
automatically and the app opens like any other.

## Until then: open the app anyway (once per install)

1. In the dialog click **Done** (not "Move to Trash").
2. **System Settings → Privacy & Security**, scroll to *Security*: next to *"MK Prod" was blocked*,
   click **Open Anyway**, enter your password, open the app.

Terminal alternative: `xattr -dr com.apple.quarantine "/Applications/MK Prod.app"`.

## One-time setup (owner)

1. Enrol at https://developer.apple.com/programs/ (as an individual or your company; 1–2 days).
2. In Xcode (or at developer.apple.com → Certificates): create a **Developer ID Application**
   certificate and export it with its private key as a `.p12` file with a password
   (Keychain Access → My Certificates → right-click → Export).
3. At https://appleid.apple.com → Sign-In and Security → **App-Specific Passwords**: create one
   named "MK Prod notarization".
4. Your **Team ID** is shown at developer.apple.com → Membership.
5. On GitHub: **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `MAC_CERT_P12_B64` | `base64 -i DeveloperID.p12 \| pbcopy` → paste |
| `MAC_CERT_PASSWORD` | the export password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_TEAM_ID` | the 10-character Team ID |
| `APPLE_APP_PASSWORD` | the app-specific password |

6. **Actions → Mac app → Run workflow.** The release notes then read "Signed and notarized with
   Apple" and the app and `.dmg` open without warnings on every Mac.

The same membership also lets the app be distributed through the Mac App Store later, and a
Windows code-signing certificate (separate purchase) does the equivalent for SmartScreen; see
`desktop/README.md`.
