import Foundation
import CryptoKit
import CommonCrypto

/// End-to-end encryption primitives. Formats are specified in SECURITY.md and mirrored
/// byte-for-byte by web/src/crypto.ts.
enum E2E {
    static let passwordRounds: UInt32 = 600_000
    static let recoveryRounds: UInt32 = 100_000

    struct Stretched {
        let authKey: String // sent to the server
        let kek: SymmetricKey // never leaves the device
    }

    // MARK: Password stretching

    static func stretch(_ secret: String, salt: String, rounds: UInt32) -> Stretched {
        var out = [UInt8](repeating: 0, count: 64)
        let pw = Array(secret.utf8)
        let s = Array(salt.utf8)
        let rc = pw.withUnsafeBufferPointer { p in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: Int8.self) }, pw.count,
                                 s, s.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds, &out, out.count)
        }
        precondition(rc == kCCSuccess, "PBKDF2 failed")
        defer { out.withUnsafeMutableBytes { _ = memset($0.baseAddress, 0, $0.count) } }
        return Stretched(authKey: Data(out[0..<32]).base64EncodedString(), kek: SymmetricKey(data: Data(out[32..<64])))
    }

    static func passwordKeys(email: String, password: String) -> Stretched {
        stretch(password, salt: "mkprod-v1:" + email.trimmingCharacters(in: .whitespaces).lowercased(), rounds: passwordRounds)
    }

    static func recoveryKeys(email: String, code: String) -> Stretched {
        let clean = code.uppercased().filter { "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".contains($0) }
        return stretch(clean, salt: "mkprod-v1-recovery:" + email.trimmingCharacters(in: .whitespaces).lowercased(), rounds: recoveryRounds)
    }

    // MARK: AES-GCM (nonce ‖ ciphertext ‖ tag)

    static func seal(_ key: SymmetricKey, _ plain: Data, aad: String) throws -> String {
        try AES.GCM.seal(plain, using: key, authenticating: Data(aad.utf8)).combined!.base64EncodedString()
    }

    static func open(_ key: SymmetricKey, _ sealed: String, aad: String) throws -> Data {
        guard let raw = Data(base64Encoded: sealed) else { throw CloudError(message: "Corrupt encrypted data") }
        return try AES.GCM.open(AES.GCM.SealedBox(combined: raw), using: key, authenticating: Data(aad.utf8))
    }

    // MARK: User key pair (P-256)

    struct KeyPair {
        let privateKey: P256.KeyAgreement.PrivateKey
        var publicKey: String { privateKey.publicKey.x963Representation.base64EncodedString() }
    }

    static func newKeyPair(kek: SymmetricKey) throws -> (pair: KeyPair, encPrivateKey: String) {
        let pk = P256.KeyAgreement.PrivateKey()
        return (KeyPair(privateKey: pk), try seal(kek, pk.rawRepresentation, aad: "mkprod-v1:privkey"))
    }

    static func unlock(kek: SymmetricKey, encPrivateKey: String) throws -> KeyPair {
        KeyPair(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: try open(kek, encPrivateKey, aad: "mkprod-v1:privkey")))
    }

    static func sealPrivateKey(_ pair: KeyPair, kek: SymmetricKey) throws -> String {
        try seal(kek, pair.privateKey.rawRepresentation, aad: "mkprod-v1:privkey")
    }

    /// A key only this person's devices can derive (own key pair agreed with itself, through HKDF).
    /// Encrypts the inbox and reminders so they sync between devices but stay unreadable to teammates.
    /// Mirrors `personalKey` in web/src/crypto.ts.
    static func personalKey(_ pair: KeyPair) throws -> SymmetricKey {
        let shared = try pair.privateKey.sharedSecretFromKeyAgreement(with: pair.privateKey.publicKey)
        return shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data("mkprod-v1-personal".utf8), sharedInfo: Data("personal".utf8), outputByteCount: 32)
    }

    static func fingerprint(_ publicKey: String) -> String {
        guard let raw = Data(base64Encoded: publicKey) else { return "—" }
        let hex = SHA256.hash(data: raw).prefix(8).map { String(format: "%02X", $0) }.joined()
        return stride(from: 0, to: hex.count, by: 4).map { i in
            String(hex[hex.index(hex.startIndex, offsetBy: i)..<hex.index(hex.startIndex, offsetBy: i + 4)])
        }.joined(separator: " ")
    }

    // MARK: Workspace keys

    private static func wrapKey(shared: SharedSecret, info: String) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data("mkprod-v1-wrap".utf8), sharedInfo: Data(info.utf8), outputByteCount: 32)
    }

    static func wrap(workspaceKey raw: Data, for memberPublicKey: String, ws: UUID, user: UUID, version: Int) throws -> String {
        let info = "\(ws.uuidString)|\(user.uuidString)|\(version)"
        guard let pubRaw = Data(base64Encoded: memberPublicKey) else { throw CloudError(message: "Bad public key") }
        let member = try P256.KeyAgreement.PublicKey(x963Representation: pubRaw)
        let eph = P256.KeyAgreement.PrivateKey()
        let shared = try eph.sharedSecretFromKeyAgreement(with: member)
        let sealed = try AES.GCM.seal(raw, using: wrapKey(shared: shared, info: info), authenticating: Data(info.utf8)).combined!
        return (eph.publicKey.x963Representation + sealed).base64EncodedString()
    }

    static func unwrap(_ wrapped: String, with pair: KeyPair, ws: UUID, user: UUID, version: Int) throws -> Data {
        let info = "\(ws.uuidString)|\(user.uuidString)|\(version)"
        guard let all = Data(base64Encoded: wrapped), all.count > 65 else { throw CloudError(message: "Bad wrapped key") }
        let eph = try P256.KeyAgreement.PublicKey(x963Representation: all.prefix(65))
        let shared = try pair.privateKey.sharedSecretFromKeyAgreement(with: eph)
        return try AES.GCM.open(AES.GCM.SealedBox(combined: all.dropFirst(65)), using: wrapKey(shared: shared, info: info), authenticating: Data(info.utf8))
    }

    // MARK: Records

    static func encryptRecord(_ plain: Data, key: SymmetricKey, version: Int, ws: UUID, kind: String, id: String) throws -> [String: Any] {
        ["enc": try seal(key, plain, aad: "\(ws.uuidString)|\(kind)|\(id.uppercased())"), "v": version]
    }

    static func decryptRecord(_ obj: [String: Any], key: SymmetricKey, ws: UUID, kind: String, id: String) throws -> Data {
        guard let sealed = obj["enc"] as? String else { throw CloudError(message: "Not encrypted") }
        return try open(key, sealed, aad: "\(ws.uuidString)|\(kind)|\(id.uppercased())")
    }

    // MARK: Codes

    static func newRecoveryCode() -> String {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var bytes = [UInt8](repeating: 0, count: 20)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        var bits = 0, value = 0
        var out = ""
        for b in bytes {
            value = (value << 8) | Int(b)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[(value >> (bits - 5)) & 31])
                bits -= 5
            }
            value &= (1 << bits) - 1
        }
        return stride(from: 0, to: out.count, by: 4).map { i in
            String(out[out.index(out.startIndex, offsetBy: i)..<out.index(out.startIndex, offsetBy: min(i + 4, out.count))])
        }.joined(separator: "-")
    }

    static func randomPassword() -> String {
        var bytes = [UInt8](repeating: 0, count: 12)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
