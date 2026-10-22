import SwiftUI
import AppKit

struct CloudSettingsView: View {
    @Environment(Store.self) private var store
    @State private var url = ""
    @State private var email = ""
    @State private var password = ""
    @State private var recoveryCode = ""
    @State private var recovering = false
    @State private var otpCode = ""
    @State private var verifyCode = ""
    @State private var name = ""
    @State private var newWorkspace = ""
    @State private var inviteCode = ""
    @State private var busy = false
    @State private var message: String?

    private var cloud: CloudSync { store.cloud }

    var body: some View {
        Form {
            Section {
                Text("MK Prod syncs through your team's MK Prod server on Cloudflare — the same address as the website. Everything is end-to-end encrypted on this Mac before upload.")
                    .font(.callout).foregroundStyle(.secondary)
                TextField("Server address", text: $url, prompt: Text("https://mkprod.<you>.workers.dev"))
                HStack {
                    Button("Save server") { cloud.config = CloudConfig(url: url.trimmingCharacters(in: .whitespaces)) }
                        .disabled(url.isEmpty || !(url.hasPrefix("https://") || url.hasPrefix("http://127.0.0.1") || url.hasPrefix("http://localhost")))
                    Spacer()
                    statusLabel
                }
            } header: { Text("1 · Cloud server") }

            if cloud.config.isComplete {
                Section {
                    if cloud.isSignedIn {
                        HStack {
                            Label(cloud.email, systemImage: "person.crop.circle.badge.checkmark")
                            Spacer()
                            Button("Sign out") { cloud.signOut() }
                        }
                        if cloud.client.needsEmailVerification {
                            Text("Confirm your email: enter the 6-digit code we sent to \(cloud.email). Until then you can't create or join workspaces.")
                                .font(.callout).foregroundStyle(.orange)
                            HStack {
                                TextField("Verification code", text: $verifyCode)
                                Button("Confirm") { run({ try await cloud.client.verifyEmail(code: verifyCode); verifyCode = "" }) }
                                    .disabled(verifyCode.filter(\.isNumber).count != 6 || busy)
                                Button("Send a new code") { run { try await cloud.client.resendVerification() } }.buttonStyle(.link)
                            }
                        }
                    } else if cloud.client.pendingMfa != nil {
                        Label("Two-factor sign-in", systemImage: "lock.shield")
                        TextField("6-digit code or backup code", text: $otpCode)
                        HStack {
                            Button("Continue") { run({ try await cloud.client.completeMfa(code: otpCode); otpCode = ""; password = "" }, then: afterSignIn) }
                                .keyboardShortcut(.defaultAction)
                                .disabled(otpCode.count < 6 || busy)
                            Button("Back") { cloud.client.pendingMfa = nil; otpCode = "" }.buttonStyle(.link)
                            if busy { ProgressView().controlSize(.small) }
                        }
                    } else if recovering {
                        TextField("Email", text: $email)
                        TextField("Recovery code", text: $recoveryCode)
                        SecureField("New password (10+ characters)", text: $password)
                        HStack {
                            Button("Reset password") {
                                run({ try await cloud.recover(email: email, code: recoveryCode, newPassword: password); password = ""; recoveryCode = ""; recovering = false }, then: afterSignIn)
                            }
                            .keyboardShortcut(.defaultAction)
                            .disabled(email.isEmpty || recoveryCode.count < 20 || password.count < 10 || busy)
                            Button("Back") { recovering = false }.buttonStyle(.link)
                            if busy { ProgressView().controlSize(.small) }
                        }
                    } else {
                        TextField("Your name", text: $name)
                        TextField("Email", text: $email)
                        SecureField("Password", text: $password)
                        HStack {
                            Button("Sign in") { run({ try await cloud.signIn(email: email, password: password); password = "" }, then: afterSignIn) }
                                .keyboardShortcut(.defaultAction)
                                .disabled(email.isEmpty || password.count < 8 || busy)
                            Button("Create account") { run({ try await cloud.signUp(email: email, password: password, name: name.isEmpty ? email : name); password = "" }, then: afterSignIn) }
                                .disabled(email.isEmpty || password.count < 10 || busy)
                            if busy { ProgressView().controlSize(.small) }
                            Spacer()
                            Button("Forgot password?") { recovering = true }.buttonStyle(.link)
                        }
                        Text("Your password never leaves this Mac: it's stretched here and unlocks your encryption keys, which are stored in the Keychain. New passwords need 10+ characters.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } header: { Text("2 · Account") }
            }

            if cloud.isSignedIn {
                Section {
                    if !cloud.isConnected && !cloud.workspaces.isEmpty {
                        Label("Not syncing yet: click Open next to your workspace.", systemImage: "exclamationmark.icloud")
                            .foregroundStyle(.orange)
                    }
                    if cloud.workspaces.isEmpty {
                        Text("No workspaces yet. Create one, or enter the invite code an admin gave you.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(cloud.workspaces) { ws in
                        HStack {
                            Image(systemName: ws.id == cloud.workspaceId ? "checkmark.circle.fill" : "building.2")
                                .foregroundStyle(ws.id == cloud.workspaceId ? .green : .secondary)
                            Text(ws.name)
                            if ws.id == cloud.workspaceId && cloud.isEncrypted {
                                Label("End-to-end encrypted", systemImage: "lock.fill").font(.caption).foregroundStyle(.green)
                            }
                            Spacer()
                            if ws.id == cloud.workspaceId {
                                Text("Open now").foregroundStyle(.secondary)
                            } else {
                                Button("Open") { run { try await cloud.join(ws) } }.buttonStyle(.borderedProminent)
                            }
                        }
                    }
                    HStack {
                        TextField("Invite code (XXXX-XXXX-XXXX)", text: $inviteCode)
                        Button("Join") { run { try await cloud.acceptInvite(code: inviteCode); inviteCode = "" } }
                            .disabled(inviteCode.filter(\.isLetter).count + inviteCode.filter(\.isNumber).count < 12 || busy)
                    }
                    HStack {
                        TextField("New workspace name", text: $newWorkspace)
                        Button("Create workspace") {
                            let n = newWorkspace.trimmingCharacters(in: .whitespaces)
                            run { try await cloud.createWorkspace(name: n.isEmpty ? "My workspace" : n); newWorkspace = "" }
                        }
                        .disabled(busy)
                    }
                    if let legacy = cloud.legacyLocalData {
                        HStack {
                            Image(systemName: "externaldrive.badge.icloud").foregroundStyle(.orange)
                            Text("This Mac still has data from the old local-only version (\(legacy.tasks.count) tasks, \(legacy.orders.count) orders).")
                                .font(.callout)
                            Spacer()
                            Button("Upload as a workspace") {
                                run { try await cloud.uploadLegacyLocalData(name: legacy.workspaceName) }
                            }
                            .disabled(busy)
                        }
                    }
                    Button("Refresh list") { run { try await cloud.refreshWorkspaces() } }.buttonStyle(.link)
                } header: { Text("3 · Shared workspace") }

                SecuritySection()
                AppsSection()
            }

            if cloud.isConnected {
                TeamSection()
                if cloud.myRole == "owner" { PanicModeSection() }
            }

            if let message {
                Section { Text(message).foregroundStyle(.orange) }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            url = cloud.config.url
            name = store.me.name
        }
        .task { if cloud.isSignedIn { run { try await cloud.refreshWorkspaces() } } }
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch cloud.status {
        case .off: Label("Offline", systemImage: "icloud.slash").foregroundStyle(.secondary)
        case .syncing: Label("Syncing…", systemImage: "arrow.triangle.2.circlepath.icloud")
        case .synced(let d): Label("Synced \(d.formatted(date: .omitted, time: .standard))\(cloud.isEncrypted ? " · encrypted" : "")", systemImage: cloud.isEncrypted ? "lock.icloud" : "checkmark.icloud").foregroundStyle(.green)
        case .error(let e): Label(e, systemImage: "exclamationmark.icloud").foregroundStyle(cloud.waitingForKey ? .orange : .red).lineLimit(2)
        }
    }

    private func run(_ work: @escaping () async throws -> Void, then: (() -> Void)? = nil) {
        busy = true
        message = nil
        Task { @MainActor in
            do {
                try await work()
                then?()
            } catch { message = error.localizedDescription }
            busy = false
        }
    }

    private func afterSignIn() {
        if let code = cloud.client.newRecoveryCode {
            cloud.client.newRecoveryCode = nil
            showSecret("Save your recovery code",
                       "Your data is end-to-end encrypted. If you forget your password, this code is the only way back in without losing access. Store it in a password manager or print it — it's shown only once.",
                       code)
        }
        offerToOpen()
    }

    /// After signing in: one workspace → open it straight away; several → the list is shown.
    private func offerToOpen() {
        guard !cloud.isConnected, cloud.workspaces.count == 1, let ws = cloud.workspaces.first else { return }
        run { try await cloud.join(ws) }
    }
}

/// Password, recovery code and other-device sign-out.
struct SecuritySection: View {
    @Environment(Store.self) private var store
    @State private var current = ""
    @State private var next = ""
    @State private var busy = false
    @State private var note: String?

    private var cloud: CloudSync { store.cloud }

    var body: some View {
        Section {
            if let pk = cloud.client.session?.publicKey {
                LabeledContent("Your key fingerprint") { Text(E2E.fingerprint(pk)).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
            }
            SecureField("Current password", text: $current)
            SecureField("New password (10+ characters)", text: $next)
            HStack {
                Button("Change password") {
                    act("Password changed. Other devices were signed out.") { try await cloud.client.changePassword(current: current, new: next); current = ""; next = "" }
                }
                .disabled(current.isEmpty || next.count < 10 || busy)
                Button("New recovery code…") {
                    guard let pw = askPassword() else { return }
                    act(nil) {
                        let code = try await cloud.client.regenerateRecoveryCode(password: pw)
                        showSecret("Your new recovery code", "Store it in a password manager or print it. It's shown only once; the previous code no longer works.", code)
                    }
                }
                Button("Sign out other devices") { act("Signed out of all other devices.") { try await cloud.client.call("DELETE", "/api/auth/sessions") } }
                if busy { ProgressView().controlSize(.small) }
            }
            if let note { Text(note).font(.callout).foregroundStyle(.secondary) }
        } header: { Text("Security") }
    }

    private func act(_ done: String?, _ work: @escaping () async throws -> Void) {
        busy = true
        note = nil
        Task { @MainActor in
            do { try await work(); note = done } catch { note = error.localizedDescription }
            busy = false
        }
    }
}

/// Owner only: lock the workspace for everyone else at once (suspected breach, lost device).
/// Same switch as the website's Team page; the server enforces it, the apps only show it.
struct PanicModeSection: View {
    @Environment(Store.self) private var store
    @State private var lockedAt: String?
    @State private var busy = false
    @State private var confirmLock = false
    @State private var note: String?

    private var cloud: CloudSync { store.cloud }
    private var base: String? { cloud.workspaceId.map { "/api/workspaces/\($0.uuidString)" } }

    var body: some View {
        Section {
            HStack {
                if let lockedAt {
                    Label("Locked since \(ISO8601DateFormatter.plain.date(from: lockedAt)?.formatted(date: .abbreviated, time: .shortened) ?? lockedAt)", systemImage: "lock.fill")
                        .foregroundStyle(.red)
                } else {
                    Label("Workspace open", systemImage: "lock.open").foregroundStyle(.secondary)
                }
                Spacer()
                if lockedAt != nil {
                    Button("Unlock workspace") { setLocked(false) }.disabled(busy)
                } else {
                    Button("Lock workspace now…", role: .destructive) { confirmLock = true }.disabled(busy)
                }
                if busy { ProgressView().controlSize(.small) }
            }
            Text("For a suspected breach or a lost device: instantly blocks everyone except you, including admins, open sessions and supplier links. Your data stays encrypted and untouched; unlock when it's safe.")
                .font(.caption).foregroundStyle(.secondary)
            if let note { Text(note).font(.callout).foregroundStyle(.orange) }
        } header: { Text("Panic mode") }
        .task { await load() }
        .confirmationDialog("Lock \(cloud.workspaces.first { $0.id == cloud.workspaceId }?.name ?? "this workspace") now?", isPresented: $confirmLock) {
            Button("Lock workspace", role: .destructive) { setLocked(true) }
        } message: {
            Text("Every other member is signed out and refused until you unlock it, and supplier links stop working.")
        }
    }

    private func load() async {
        guard let base else { return }
        if let obj = try? await cloud.client.call("GET", "\(base)/team") { lockedAt = obj["lockedAt"] as? String }
    }

    private func setLocked(_ locked: Bool) {
        guard let base else { return }
        busy = true
        note = nil
        Task { @MainActor in
            do {
                let obj = try await cloud.client.call("POST", "\(base)/lock", ["locked": locked])
                lockedAt = obj["lockedAt"] as? String
            } catch { note = error.localizedDescription }
            busy = false
        }
    }
}

struct TeamSection: View {
    @Environment(Store.self) private var store
    @State private var inviteEmail = ""
    @State private var inviteRole = "member"
    @State private var error: String?
    @State private var busy = false

    private var cloud: CloudSync { store.cloud }

    var body: some View {
        Section {
            Label(cloud.isEncrypted ? "End-to-end encrypted · key version \(cloud.keyVersion)" : "Not encrypted yet (an owner or admin enables it on connect)",
                  systemImage: cloud.isEncrypted ? "lock.fill" : "lock.open")
                .foregroundStyle(cloud.isEncrypted ? .green : .orange)
            ForEach(cloud.team) { m in
                HStack {
                    AvatarView(member: Member(id: m.id, name: m.name, email: m.email, colorHex: m.color), size: 24)
                    VStack(alignment: .leading) {
                        Text(m.name + (m.id == store.data.currentUserId ? " (you)" : ""))
                        Text(m.email).font(.caption).foregroundStyle(.secondary)
                        if let pk = m.publicKey {
                            Text((!m.hasKey && cloud.isEncrypted ? "Waiting for key · " : "🔑 ") + E2E.fingerprint(pk))
                                .font(.system(.caption2, design: .monospaced)).foregroundStyle(!m.hasKey && cloud.isEncrypted ? .orange : .secondary)
                                .help("Key fingerprint: compare with what your teammate sees to rule out tampering")
                        } else {
                            Text("No encryption keys yet").font(.caption2).foregroundStyle(.orange)
                        }
                    }
                    if cloud.online.contains(where: { $0.id == m.id }) {
                        Circle().fill(.green).frame(width: 7, height: 7).help("Online")
                    }
                    Spacer()
                    if cloud.isAdmin && m.role != "owner" && m.id != store.data.currentUserId {
                        Picker("", selection: Binding(get: { m.role }, set: { r in act { try await cloud.setRole(m.id, r) } })) {
                            Text("Admin").tag("admin"); Text("Member").tag("member"); Text("Viewer").tag("viewer")
                        }
                        .labelsHidden().frame(width: 100)
                        Button("Reset password") {
                            act {
                                let temp = try await cloud.resetPassword(m.id)
                                showSecret("Temporary password for \(m.name)", "Share it privately. They sign in with it, get new encryption keys, and should change it afterwards. A teammate's app re-shares the workspace key automatically.", temp)
                            }
                        }
                        .buttonStyle(.link)
                        Button(role: .destructive) {
                            if confirm("Remove \(m.name)?", "The workspace key is rotated so they can't read anything new.", ok: "Remove") {
                                act { try await cloud.remove(m.id) }
                            }
                        } label: { Image(systemName: "person.badge.minus") }
                            .buttonStyle(.borderless)
                    } else {
                        Text(m.role.capitalized).foregroundStyle(.secondary)
                    }
                }
            }
            if cloud.isAdmin {
                ForEach(cloud.invites) { i in
                    HStack {
                        Image(systemName: "envelope").foregroundStyle(.secondary)
                        Text(i.email)
                        Text("invited · \(i.role)").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Cancel") { act { try await cloud.cancelInvite(i.email) } }.buttonStyle(.link)
                    }
                }
                HStack {
                    Text("Invite:").foregroundStyle(.secondary)
                    TextField("Email address of the person to invite", text: $inviteEmail)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                    Picker("", selection: $inviteRole) {
                        Text("Admin").tag("admin"); Text("Member").tag("member"); Text("Viewer").tag("viewer")
                    }
                    .labelsHidden().frame(width: 100)
                    Button("Invite") {
                        let e = inviteEmail.trimmingCharacters(in: .whitespaces)
                        act {
                            let code = try await cloud.invite(email: e, role: inviteRole)
                            inviteEmail = ""
                            showSecret("Invite code for \(e)", "Send this code to your teammate privately (it expires in 14 days). They create an account with that email, then enter the code under Shared workspace → Join (or on the website).", code)
                        }
                    }
                    .disabled(!inviteEmail.contains("@") || busy)
                    if cloud.isEncrypted {
                        Button("Rotate key") {
                            if confirm("Rotate the encryption key?", "A new key version is created and all data is re-encrypted.", ok: "Rotate") { act { try await cloud.rotateKey() } }
                        }
                    }
                }
                Text("Invites need the one-time code; knowing the email isn't enough.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !cloud.canWrite {
                Label("You have view-only access to this workspace.", systemImage: "eye").foregroundStyle(.orange)
            }
            if let error { Text(error).foregroundStyle(.red) }
        } header: { Text("Team · \(cloud.workspaceName)") }
    }

    private func act(_ work: @escaping () async throws -> Void) {
        error = nil
        busy = true
        Task { @MainActor in
            do { try await work() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

/// Shows a one-time secret (invite code, temporary password, recovery code) with a Copy button.
@MainActor
func showSecret(_ title: String, _ message: String, _ secret: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = message + "\n\n" + secret
    a.addButton(withTitle: "Copy & Close")
    a.addButton(withTitle: "Close")
    if a.runModal() == .alertFirstButtonReturn {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(secret, forType: .string)
    }
}

/// Asks for the account password in a secure field.
@MainActor
func askPassword() -> String? {
    let a = NSAlert()
    a.messageText = "Enter your password"
    a.informativeText = "Needed to unlock your keys and create a new recovery code. The previous code stops working."
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    a.accessoryView = field
    a.addButton(withTitle: "Continue")
    a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = field
    return a.runModal() == .alertFirstButtonReturn && !field.stringValue.isEmpty ? field.stringValue : nil
}

/// Compact cloud status for the sidebar footer: sync state plus who is online.
struct CloudStatusBadge: View {
    @Environment(Store.self) private var store

    var body: some View {
        let cloud = store.cloud
        if cloud.isSignedIn && !cloud.isConnected {
            SettingsLink {
                Image(systemName: "exclamationmark.icloud").foregroundStyle(.orange)
            }
            .buttonStyle(.plain)
            .help("Signed in but not syncing: open a workspace in Settings → Cloud & Team")
        } else if cloud.isConnected {
            HStack(spacing: 6) {
                switch cloud.status {
                case .syncing: Image(systemName: "arrow.triangle.2.circlepath.icloud").foregroundStyle(.secondary)
                case .error(let e): Image(systemName: "exclamationmark.icloud").foregroundStyle(.red).help(e)
                default: Image(systemName: "checkmark.icloud").foregroundStyle(.green).help("Synced with \(cloud.workspaceName)")
                }
                let others = cloud.online.map(\.id).filter { $0 != store.data.currentUserId }
                if !others.isEmpty {
                    AvatarStack(ids: others, size: 16).help("Online now")
                }
            }
        }
    }
}

/// Shows teammates currently looking at a task.
struct ViewersBadge: View {
    let taskId: UUID
    @Environment(Store.self) private var store

    var body: some View {
        let ids = store.cloud.viewers(ofTask: taskId)
        if !ids.isEmpty {
            HStack(spacing: 4) {
                AvatarStack(ids: ids, size: 18)
                Text(ids.count == 1 ? "is viewing" : "are viewing").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// A plain macOS confirmation alert; reliable inside the Settings window, unlike sheets/dialogs there.
@MainActor
func confirm(_ title: String, _ message: String, ok: String) -> Bool {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = message
    a.addButton(withTitle: ok)
    a.addButton(withTitle: "Cancel")
    return a.runModal() == .alertFirstButtonReturn
}


/// Download links for the other platforms, read from the server (GitHub Releases).
struct AppsSection: View {
    @Environment(Store.self) private var store
    @State private var apps: [(platform: String, version: String, url: URL, name: String)] = []
    @State private var note: String?

    var body: some View {
        Section {
            if apps.isEmpty {
                Text(note ?? "Loading…").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(apps, id: \.platform) { a in
                HStack {
                    Image(systemName: a.platform == "windows" ? "pc" : a.platform == "android" ? "smartphone" : "laptopcomputer")
                    Text(a.platform == "windows" ? "Windows" : a.platform == "android" ? "Android" : "Mac")
                    Text("v\(a.version)").foregroundStyle(.secondary)
                    Spacer()
                    Link("Download \(a.name)", destination: a.url)
                }
            }
            Text("Same workspace and account on every device. Windows and Android need no admin rights to install.")
                .font(.caption).foregroundStyle(.secondary)
        } header: { Text("Apps for your other devices") }
        .task {
            do {
                let obj = try await store.cloud.client.call("GET", "/api/apps")
                var out: [(String, String, URL, String)] = []
                for a in obj["apps"] as? [[String: Any]] ?? [] {
                    guard let platform = a["platform"] as? String, let version = a["version"] as? String,
                          let assets = a["assets"] as? [[String: Any]] else { continue }
                    // Prefer the installer/dmg/apk over zip and portable variants.
                    let preferred = assets.first { ($0["name"] as? String ?? "").hasSuffix(".dmg") || ($0["name"] as? String ?? "").hasSuffix(".apk") || (($0["name"] as? String ?? "").hasSuffix(".exe") && !($0["name"] as? String ?? "").contains("portable")) } ?? assets.first
                    if let p = preferred, let u = (p["url"] as? String).flatMap(URL.init), let n = p["name"] as? String { out.append((platform, version, u, n)) }
                }
                apps = out.map { (platform: $0.0, version: $0.1, url: $0.2, name: $0.3) }
                if apps.isEmpty { note = (obj["error"] as? String) ?? "No downloads published yet." }
            } catch {
                note = error.localizedDescription
            }
        }
    }
}
