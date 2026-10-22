# MK Prod security design

## Summary

- **End-to-end encryption.** Workspace content (tasks, docs, chat, budgets, orders, contracts…) is encrypted in the Mac app or the browser before upload. The Cloudflare Worker and D1 database store only ciphertext. Neither the server nor anyone with access to the Cloudflare account can read it.
- **The server never sees your password.** Clients stretch it with PBKDF2-SHA256 (600,000 rounds) and send only a derived *auth key*. A separate derived key, which never leaves the device, unlocks your private key.
- **Invites need a one-time code**, shown to the admin who created the invite. Knowing an invited email address is not enough to join.
- **Sessions:**
  - Random 256-bit tokens; the server stores only their SHA-256 hash.
  - On the website the token lives in an `HttpOnly; Secure; SameSite=Strict` cookie that page scripts can't read.
  - In the Mac app it lives in the macOS Keychain.
- **Hardened web delivery:** HSTS, a strict Content-Security-Policy (no third-party scripts, no inline scripts), clickjacking protection, `no-referrer`, and requests forced over HTTPS by Cloudflare.
- **At rest on devices:**
  - **Mac:** FileVault full-disk encryption, plus data files readable only by your macOS user (mode 600). Keys and session are in the Keychain.
  - **Browser:** the offline cache is encrypted with the workspace key, and keys are stored as non-extractable WebCrypto keys.
- **Account recovery:** a recovery code (shown once, kept by you) can reset a forgotten password without losing access to encrypted data.
- **Two-factor sign-in** (TOTP, RFC 6238, SHA-1, 6 digits, 30 s, ±1 step): optional per account, can be required per workspace by the owner. 8 single-use backup codes are stored as SHA-256 hashes. The TOTP secret is stored server-side in plaintext (as every TOTP service must, to verify codes); it protects the login, not the data, which stays end-to-end encrypted.
- **Email confirmation** of new accounts (6-digit code, 30 minutes, hashed) when a mail server is configured.
- **Sign-in alerts** by email and a **security log** per account and per workspace (sign-ins, failed attempts, password/2FA changes, role changes, resets, key rotations, supplier links), kept for one year. A **devices list** lets people sign out any session.
- **Supplier share links:** the client takes a plaintext snapshot of what the supplier may see, encrypts it with a fresh random 256-bit key (`AES-GCM`, `aad = "share|<id>"`), and uploads the ciphertext; the key travels only in the URL fragment (`#k=…`), which browsers never send to servers. Replies are encrypted the same way (`aad = "share-reply|<id>"`). The link key is kept in a synced `shares` record so teammates can read replies. Links expire and can be revoked. Public endpoints are rate-limited per IP.
- **File attachments:** encrypted in the browser with the workspace key (`AES-GCM`, `aad = "<ws>|file|<id>"`) and stored in R2; the server sees size and key version only.
- **Right to erasure:** people can delete their account (password required); owners can delete a workspace or transfer ownership. Throttling tables (`login_failures`, `rate_events`), which contain emails and IPs, are purged after 24 hours; presence after 7 days; the security log after a year.

## What the server can still see (metadata)

- Account names and email addresses, workspace names, member roles, whether two-factor is on.
- Session metadata: device label (from the browser's user agent), network address, approximate city, last activity.
- Share links: who created them, when they expire, how often they were opened, how many replies. Attachments: size and key version.
- Each record's type ("tasks", "orders"…), random id, size, and when and by whom it changed.
- Presence: which page or task id someone has open.
- Timing of activity.

## Algorithms (v1)

All ids are uppercase UUID strings. Base64 is standard with padding. "AES-GCM" means AES-256-GCM with a random 12-byte nonce, serialized as `nonce ‖ ciphertext ‖ 16-byte tag`.

| Purpose | Construction |
|---|---|
| Password stretching | `PBKDF2-HMAC-SHA256(password, "mkprod-v1:" + lowercase(email), 600000, 64 bytes)` → `authKey = [0..32)`, `kek = [32..64)` |
| Server password check | `SHA-256(randomSalt16 ‖ authKey)`, compared in constant time |
| User key pair | ECDH P-256. Public key = 65-byte uncompressed point. Private key = 32-byte scalar |
| Private key at rest on the server | `AES-GCM(kek, scalar, aad = "mkprod-v1:privkey")` |
| Recovery code | 20 random bytes, Base32, shown in groups of 4. `PBKDF2(code, "mkprod-v1-recovery:" + email, 100000, 64)` → `recAuth`, `recKek`. Server stores `SHA-256(salt ‖ recAuth)` and `AES-GCM(recKek, scalar)` |
| Workspace key | 32 random bytes per key *version* (1, 2, …) |
| Sharing a workspace key with a member | Ephemeral P-256 key; `shared = ECDH(eph, memberPublic)`; `wrapKey = HKDF-SHA256(shared, salt "mkprod-v1-wrap", info "<ws>|<user>|<version>", 32)`; `wrapped = ephPublic(65) ‖ AES-GCM(wrapKey, key, aad = info)` |
| Record | `data = {"enc": base64(AES-GCM(workspaceKey, utf8(json), aad = "<ws>|<kind>|<id>")), "v": version}` |
| Browser cache | Same AES-GCM with the current workspace key, `aad = "<ws>|cache"` |

The AAD binds every ciphertext to its workspace, record type and id, so the server can't swap or replay records between slots.

## Key lifecycle

- **Turning encryption on.** The first owner or admin client to connect generates workspace key v1 and shares it with every member who has a key pair. It then re-uploads every record encrypted. From then on the server rejects unencrypted writes.
- **New member.** They accept the invite with its code and create a key pair at sign-up. The next teammate client that holds the key shares it with them automatically.
- **Member removed.** The admin's client creates the next key version, shares it with the remaining members, and re-encrypts every record. The removed person's old copy of the key no longer decrypts new data.
- **Password change.** The private key is re-encrypted on the device with the new `kek`. Nothing else changes.
- **Forgotten password:**
  - **With a recovery code:** the private key is restored and nothing is lost.
  - **Admin reset:** the person gets a temporary password and a new key pair, and teammates re-share the workspace key with them.
  - **Owner without a recovery code, and no other member holding the key:** encrypted server data can't be recovered. The owner's Mac still has a full local copy.

## Trust notes

New members' public keys are trusted on first use. A malicious server could substitute its own key for a new member. To rule that out, compare the key fingerprints in **Team** (the website) or **Cloud & Team** (the Mac app) with your teammate over a separate channel.
