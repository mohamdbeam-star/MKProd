import Foundation
import Security
import CryptoKit

/// Address of the team's MK Prod server (the Cloudflare Worker that also serves the website).
struct CloudConfig: Codable, Equatable {
    var url: String

    var isComplete: Bool { URL(string: url)?.host != nil }
}

struct CloudSession: Codable {
    var token: String
    var userId: UUID
    var email: String
    var name: String
    var publicKey: String?
}

struct CloudError: LocalizedError {
    let message: String
    var status = 0
    var errorDescription: String? { message }
}

enum Keychain {
    private static let service = "com.mkoussa.mkprod.cloud" + (Store.profile.map { "." + URL(fileURLWithPath: $0).lastPathComponent } ?? "")

    static func save(_ data: Data, account: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        // Never synced to iCloud or restored onto another Mac.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func delete(account: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}

/// Client for the MK Prod Worker API (web/worker/index.ts).
final class CloudClient {
    var config: CloudConfig
    private(set) var session: CloudSession?

    /// The unlocked P-256 key pair, kept in the Keychain. Without it the session can't read
    /// an encrypted workspace, so it counts as signed out.
    private(set) var keyPair: E2E.KeyPair?
    /// Shown once after sign-up/sign-in when the account had no recovery code yet.
    var newRecoveryCode: String?
    /// Set when the server accepted the password but wants the authenticator code (two-factor).
    var pendingMfa: (token: String, kek: SymmetricKey, email: String)?
    /// Set after sign-up (or sign-in to an unconfirmed account) until the emailed code is entered.
    var needsEmailVerification = false

    init(config: CloudConfig) {
        self.config = config
        if let raw = Keychain.load(account: "session"), let s = try? JSONDecoder().decode(CloudSession.self, from: raw),
           let pk = Keychain.load(account: "privateKey"), let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: pk) {
            session = s
            keyPair = E2E.KeyPair(privateKey: key)
        } else {
            Keychain.delete(account: "session")
        }
    }

    var isSignedIn: Bool { session != nil && keyPair != nil }

    // MARK: Auth (passwords are stretched here; the server only sees the auth key)

    func signUp(email: String, password: String, name: String) async throws {
        let email = email.trimmingCharacters(in: .whitespaces).lowercased()
        let pk = E2E.passwordKeys(email: email, password: password)
        let (pair, encPrivateKey) = try E2E.newKeyPair(kek: pk.kek)
        let obj = try await call("POST", "/api/auth/signup", [
            "email": email, "name": name, "authKey": pk.authKey, "publicKey": pair.publicKey, "encPrivateKey": encPrivateKey, "wantToken": true,
        ], auth: false)
        try await finishAuth(obj, kek: pk.kek, email: email)
    }

    func signIn(email: String, password: String) async throws {
        let email = email.trimmingCharacters(in: .whitespaces).lowercased()
        let pk = E2E.passwordKeys(email: email, password: password)
        var obj: [String: Any]
        do {
            obj = try await call("POST", "/api/auth/login", ["email": email, "authKey": pk.authKey, "wantToken": true], auth: false)
        } catch let e as CloudError where e.status == 409 {
            // Account from before client-side encryption: prove the password once, then upgrade.
            obj = try await call("POST", "/api/auth/login", ["email": email, "authKey": pk.authKey, "password": password, "wantToken": true], auth: false)
        }
        if obj["mfa"] as? Bool == true, let token = obj["mfaToken"] as? String {
            pendingMfa = (token, pk.kek, email)
            throw CloudError(message: "Enter the 6-digit code from your authenticator app.", status: 428)
        }
        try await finishAuth(obj, kek: pk.kek, email: email)
    }

    /// Second step of a two-factor sign-in.
    func completeMfa(code: String) async throws {
        guard let p = pendingMfa else { throw CloudError(message: "Sign in first.") }
        session = CloudSession(token: p.token, userId: UUID(), email: p.email, name: "")
        do {
            let obj = try await call("POST", "/api/auth/mfa", ["code": code, "wantToken": true])
            pendingMfa = nil
            try await finishAuth(obj, kek: p.kek, email: p.email)
        } catch {
            session = nil
            throw error
        }
    }

    func verifyEmail(code: String) async throws {
        try await call("POST", "/api/auth/verify", ["code": code])
        needsEmailVerification = false
    }

    func resendVerification() async throws {
        try await call("POST", "/api/auth/verify/resend", [:])
    }

    /// Forgotten password: the recovery code unlocks the private key, which is re-locked with the new password.
    func recover(email: String, code: String, newPassword: String) async throws {
        let email = email.trimmingCharacters(in: .whitespaces).lowercased()
        let rk = E2E.recoveryKeys(email: email, code: code)
        let start = try await call("POST", "/api/auth/recover", ["email": email, "recAuth": rk.authKey], auth: false)
        guard let token = start["token"] as? String, let encRec = start["encPrivateKeyRec"] as? String else { throw CloudError(message: "Recovery failed") }
        let pair = try E2E.unlock(kek: rk.kek, encPrivateKey: encRec)
        let pk = E2E.passwordKeys(email: email, password: newPassword)
        session = CloudSession(token: token, userId: UUID(), email: email, name: "")
        let obj = try await call("POST", "/api/auth/recover/finish", ["newAuthKey": pk.authKey, "encPrivateKey": try E2E.sealPrivateKey(pair, kek: pk.kek), "wantToken": true])
        try await finishAuth(obj, kek: pk.kek, email: email)
    }

    private func finishAuth(_ obj: [String: Any], kek: SymmetricKey, email: String) async throws {
        guard let token = obj["token"] as? String, let user = obj["user"] as? [String: Any],
              let idString = user["id"] as? String, let id = UUID(uuidString: idString)
        else { throw CloudError(message: "Unexpected sign-in response from the server.") }
        var s = CloudSession(token: token, userId: id, email: user["email"] as? String ?? email, name: user["name"] as? String ?? "", publicKey: user["publicKey"] as? String)
        session = s
        let pair: E2E.KeyPair
        if let enc = user["encPrivateKey"] as? String, s.publicKey != nil {
            do { pair = try E2E.unlock(kek: kek, encPrivateKey: enc) } catch { throw CloudError(message: "Could not unlock your encryption keys with this password.") }
        } else {
            let (p, encPrivateKey) = try E2E.newKeyPair(kek: kek)
            try await call("PUT", "/api/me/keys", ["publicKey": p.publicKey, "encPrivateKey": encPrivateKey])
            s.publicKey = p.publicKey
            pair = p
        }
        let me = try await call("GET", "/api/me")
        needsEmailVerification = obj["needsVerification"] as? Bool == true || (me["user"] as? [String: Any])?["emailVerified"] as? Bool == false
        if (me["user"] as? [String: Any])?["hasRecovery"] as? Bool != true {
            let code = E2E.newRecoveryCode()
            let rk = E2E.recoveryKeys(email: s.email, code: code)
            try await call("PUT", "/api/me/recovery", ["recAuth": rk.authKey, "encPrivateKeyRec": try E2E.sealPrivateKey(pair, kek: rk.kek)])
            newRecoveryCode = code
        }
        session = s
        keyPair = pair
        Keychain.save(try JSONEncoder().encode(s), account: "session")
        Keychain.save(pair.privateKey.rawRepresentation, account: "privateKey")
    }

    /// Re-locks the private key with a new password; other devices are signed out by the server.
    func changePassword(current: String, new: String) async throws {
        guard let s = session, let pair = keyPair else { throw CloudError(message: "Not signed in.") }
        let cur = E2E.passwordKeys(email: s.email, password: current)
        let next = E2E.passwordKeys(email: s.email, password: new)
        try await call("POST", "/api/auth/password", ["currentAuthKey": cur.authKey, "newAuthKey": next.authKey, "encPrivateKey": try E2E.sealPrivateKey(pair, kek: next.kek)])
    }

    /// Replaces the recovery code. Requires the password (re-checked by the server via the auth key).
    func regenerateRecoveryCode(password: String) async throws -> String {
        guard let s = session, let pair = keyPair else { throw CloudError(message: "Not signed in.") }
        let pk = E2E.passwordKeys(email: s.email, password: password)
        let me = try await call("GET", "/api/me")
        guard let enc = (me["user"] as? [String: Any])?["encPrivateKey"] as? String, (try? E2E.unlock(kek: pk.kek, encPrivateKey: enc)) != nil else {
            throw CloudError(message: "Password is incorrect.")
        }
        let code = E2E.newRecoveryCode()
        let rk = E2E.recoveryKeys(email: s.email, code: code)
        try await call("PUT", "/api/me/recovery", ["recAuth": rk.authKey, "encPrivateKeyRec": try E2E.sealPrivateKey(pair, kek: rk.kek)])
        return code
    }

    func signOut() {
        if session != nil { Task { _ = try? await call("POST", "/api/auth/logout", [:]) ; self.clearSession() } } else { clearSession() }
    }

    func clearSession() {
        session = nil
        keyPair = nil
        pendingMfa = nil
        needsEmailVerification = false
        Keychain.delete(account: "session")
        Keychain.delete(account: "privateKey")
    }

    func updateProfile(name: String, color: String) async throws {
        _ = try await call("PATCH", "/api/me", ["name": name, "color": color])
        session?.name = name
        if let s = session { Keychain.save(try JSONEncoder().encode(s), account: "session") }
    }

    private func storeSession(_ obj: [String: Any]) throws {
        guard let token = obj["token"] as? String, let user = obj["user"] as? [String: Any],
              let idString = user["id"] as? String, let id = UUID(uuidString: idString)
        else { throw CloudError(message: "Unexpected sign-in response from the server.") }
        let s = CloudSession(token: token, userId: id, email: user["email"] as? String ?? "", name: user["name"] as? String ?? "")
        session = s
        Keychain.save(try JSONEncoder().encode(s), account: "session")
    }

    // MARK: Requests

    @discardableResult
    func call(_ method: String, _ path: String, _ body: [String: Any]? = nil, auth: Bool = true) async throws -> [String: Any] {
        guard config.isComplete, let base = URL(string: config.url.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))) else {
            throw CloudError(message: "Server address is not set.")
        }
        var req = URLRequest(url: base.appendingPathComponent(String(path.dropFirst())))
        req.httpMethod = method
        req.timeoutInterval = 25
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if auth {
            guard let token = session?.token else { throw CloudError(message: "Not signed in.") }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(code) else {
            if code == 401 && auth { clearSession() }
            throw CloudError(message: obj["error"] as? String ?? "Server returned HTTP \(code).", status: code)
        }
        return obj
    }
}

extension JSONEncoder {
    /// Deterministic output so unchanged objects encode to identical bytes.
    static var cloud: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }
}

extension JSONDecoder {
    static var cloud: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            // Accept "2026-10-21T10:00:00Z" and the fractional form browsers produce.
            let s = try dec.singleValueContainer().decode(String.self)
            if let d = ISO8601DateFormatter.plain.date(from: s) ?? ISO8601DateFormatter.fractional.date(from: s) { return d }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "Bad date \(s)"))
        }
        return d
    }
}

extension ISO8601DateFormatter {
    static let plain = ISO8601DateFormatter()
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
