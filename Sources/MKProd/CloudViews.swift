import SwiftUI
import AppKit

struct CloudSettingsView: View {
    @Environment(Store.self) private var store
    @State private var url = ""
    @State private var email = ""
    @State private var password = ""
    @State private var recoveryCode = ""
    @State private var recovering = false
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
                        Text("No shared workspaces yet. Publish this one, or enter the invite code an admin gave you.")
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
                                Button("Disconnect") { cloud.disconnect() }
                            } else {
                                Button("Open") { open(ws) }.buttonStyle(.borderedProminent)
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
                        Button("Publish this workspace") {
                            let n = newWorkspace.isEmpty ? store.data.workspaceName : newWorkspace
                            run { try await cloud.publishCurrentWorkspace(name: n) }
                        }
                        .disabled(busy)
                    }
                    Button("Refresh list") { run { try await cloud.refreshWorkspaces() } }.buttonStyle(.link)
                } header: { Text("3 · Shared workspace") }

                SecuritySection()
            }

            if cloud.isConnected {
                TeamSection()
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

    /// After signing in, connect straight away instead of leaving the app signed in but not syncing.
    private func offerToOpen() {
        guard !cloud.isConnected, let ws = cloud.workspaces.first else { return }
        let others = cloud.workspaces.count > 1 ? " You can switch to your other workspaces here later." : ""
        if confirm("Open “\(ws.name)” on this Mac?",
                   "Your Mac will show the team's spaces, lists and tasks and keep them in sync. Your current local data is saved to a backup file first.\(others)",
                   ok: "Open \(ws.name)") {
            run { try await cloud.join(ws) }
        }
    }

    private func open(_ ws: CloudWorkspace) {
        if confirm("Open “\(ws.name)”?", "Your current local data is saved to a backup file next to the data file, then replaced by the shared workspace.", ok: "Replace local data and open") {
            run { try await cloud.join(ws) }
        }
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
                    TextField("teammate@company.com", text: $inviteEmail)
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
