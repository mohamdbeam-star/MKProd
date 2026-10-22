import Foundation
import CryptoKit

/// Command-line access to E2E.swift so Tests/interop/run.mjs can cross-check it against web/src/crypto.ts.
@main
struct CryptoTool {
    static func main() throws {
        let a = Array(CommandLine.arguments.dropFirst())
        func b(_ s: String) -> Data { Data(base64Encoded: s)! }
        switch a[0] {
        case "derive": // email password → authKey kekCheck
            let s = E2E.passwordKeys(email: a[1], password: a[2])
            print(s.authKey, try E2E.seal(s.kek, Data("kek-check".utf8), aad: "t"))
        case "recovery": // email code → authKey
            print(E2E.recoveryKeys(email: a[1], code: a[2]).authKey)
        case "keypair": // email password → publicKey encPrivateKey
            let s = E2E.passwordKeys(email: a[1], password: a[2])
            let (pair, enc) = try E2E.newKeyPair(kek: s.kek)
            print(pair.publicKey, enc)
        case "unlock": // email password encPrivateKey → publicKey
            print(try E2E.unlock(kek: E2E.passwordKeys(email: a[1], password: a[2]).kek, encPrivateKey: a[3]).publicKey)
        case "wrap": // raw pub ws user version → wrapped
            print(try E2E.wrap(workspaceKey: b(a[1]), for: a[2], ws: UUID(uuidString: a[3])!, user: UUID(uuidString: a[4])!, version: Int(a[5])!))
        case "unwrap": // email password encPrivateKey wrapped ws user version → raw
            let pair = try E2E.unlock(kek: E2E.passwordKeys(email: a[1], password: a[2]).kek, encPrivateKey: a[3])
            print(try E2E.unwrap(a[4], with: pair, ws: UUID(uuidString: a[5])!, user: UUID(uuidString: a[6])!, version: Int(a[7])!).base64EncodedString())
        case "enc": // raw ws kind id json → sealed
            let r = try E2E.encryptRecord(Data(a[4].utf8), key: SymmetricKey(data: b(a[0 + 1])), version: 1, ws: UUID(uuidString: a[2])!, kind: a[3], id: a[5])
            print(r["enc"] as! String)
        case "dec": // raw ws kind id sealed → json
            let d = try E2E.decryptRecord(["enc": a[5]], key: SymmetricKey(data: b(a[1])), ws: UUID(uuidString: a[2])!, kind: a[3], id: a[4])
            print(String(data: d, encoding: .utf8)!)
        case "fingerprint":
            print(E2E.fingerprint(a[1]))
        case "code":
            print(E2E.newRecoveryCode())
        default:
            fatalError("unknown command")
        }
    }
}
