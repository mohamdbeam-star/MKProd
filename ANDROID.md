# MK Prod on Android

A native Android app around the web app, so every feature is identical to the website and the
Mac/Windows apps and is always current. Android 7.0 and newer: phones, tablets and foldables.

## Install

**github.com/mohamdbeam-star/MKProd → Releases → "MK Prod for Android"** → download
`MK-Prod-<version>-android.apk` on the phone and open it.

- Android asks once to allow installs from the browser or files app (**Settings → Apps → Special
  app access → Install unknown apps**).
- Google Play Protect may warn about an app from outside the store: **More details → Install
  anyway**. (Publishing on Google Play removes that step; it needs a developer account, $25 once.)

Alternative without any download: open https://mkprod.mohamd-beam.workers.dev in Chrome and tap
**Install as an app** at the bottom of the menu. That gives the same app as a Chrome-managed
install, updated automatically.

## Foldables (Honor Magic V series, Galaxy Z Fold, Pixel Fold…)

The app is declared resizable and handles every configuration change itself, so folding,
unfolding, rotating, split-screen and floating windows never restart it or lose what you were
typing. The layout is the same responsive one as the website: a phone layout with a slide-in menu
on the cover screen, and the full sidebar layout on the inner screen or a tablet.

## What works, what doesn't

- Everything on the website, including two-factor sign-in, approvals, supplier links, attachments
  (upload from Files/Gallery, download to the Downloads folder) and Excel exports.
- Dark mode follows the system setting.
- Push notifications are not available in this shell (Android's web view has no notification
  support); the Inbox inside the app and email notifications cover it. A later version can add
  true push notifications.

## Signing key (one-time, for the owner)

Each APK must be signed. The GitHub build signs with a **temporary** key until you give it a
permanent one; with a temporary key, a newer version can't install over an older one (users
would have to uninstall first). Create the permanent key once, on your Mac:

```bash
keytool -genkeypair -v -keystore mkprod-android.jks -alias mkprod -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=MK Prod" -storepass 'CHOOSE-A-STRONG-PASSWORD' -keypass 'CHOOSE-A-STRONG-PASSWORD'
base64 -i mkprod-android.jks | pbcopy     # keystore, base64, now on the clipboard
```

Then on GitHub: **Settings → Secrets and variables → Actions → New repository secret**, four times:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | paste the clipboard |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |
| `ANDROID_KEY_ALIAS` | `mkprod` |
| `ANDROID_KEY_PASSWORD` | the same password |

Keep `mkprod-android.jks` and the password somewhere safe (password manager): losing them means
future versions can't update existing installs. Re-run the "Android app" workflow (Actions tab →
Run workflow) and the release is re-signed with the permanent key.

## Build locally

Android Studio: open the `android` folder. Command line (JDK 17 + Android SDK):

```bash
cd android && gradle assembleRelease     # unsigned unless KEYSTORE_* env vars are set
```
