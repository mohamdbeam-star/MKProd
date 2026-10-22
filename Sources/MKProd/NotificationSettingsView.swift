import SwiftUI

/// Assigns a person to finance entities, with their role in each entity's approval chain.
struct EntityAssignmentMenu: View {
    @Environment(Store.self) private var store
    let memberId: UUID

    private var assigned: [FinEntity] { store.data.entities.filter { $0.role(of: memberId) != nil } }

    var body: some View {
        Menu {
            if store.data.entities.isEmpty {
                Text("No entities yet: add them in Finance › Settings")
            }
            ForEach(store.data.entities) { e in
                Menu((e.role(of: memberId) != nil ? "✓ " : "") + e.name) {
                    ForEach(e.approvalLevels, id: \.self) { level in
                        Button((e.role(of: memberId) == level ? "✓ " : "") + level) { set(e.id, level) }
                    }
                    Divider()
                    Button("Not assigned") { set(e.id, nil) }.disabled(e.role(of: memberId) == nil)
                }
            }
        } label: {
            Label(assigned.isEmpty ? "No entities" : assigned.map(\.name).joined(separator: ", "), systemImage: "building.2")
                .lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(!store.cloud.canWrite && store.cloud.isConnected)
        .help("Entities this person belongs to")
    }

    private func set(_ entity: UUID, _ role: String?) {
        // Deferred so the menu finishes closing before the list re-renders.
        DispatchQueue.main.async {
            guard let i = store.data.entities.firstIndex(where: { $0.id == entity }) else { return }
            var e = store.data.entities[i]
            e.roles.removeAll { $0.memberId == memberId }
            if let role { e.roles.append(EntityRoleAssignment(memberId: memberId, role: role)) }
            store.data.entities[i] = e
            store.audit("Entity", "\(store.member(memberId)?.name ?? "Someone") → \(e.name): \(role ?? "removed")")
        }
    }
}

/// Each person's own email preferences, stored with their account on the server.
struct NotificationSettingsView: View {
    @Environment(Store.self) private var store
    @State private var prefs: [String: Bool] = [:]
    @State private var loaded = false
    @State private var busy = false
    @State private var note: String?

    private var cloud: CloudSync { store.cloud }

    private static let options: [(key: String, title: String, detail: String)] = [
        ("taskAssigned", "A task is assigned to me", "Includes comments assigned to you."),
        ("taskUpdated", "Tasks I'm assigned to or watch are updated", "Status, due date, description, checklist and comment changes. Edits within 15 minutes are grouped."),
        ("mentions", "Someone @mentions me", ""),
        ("contractExpiring", "A contract of my entities is ending", "60, 30, 14, 7 and 1 day before the end date."),
        ("approvals", "Orders need my approval or my order changes status", ""),
    ]

    var body: some View {
        Form {
            if !cloud.isSignedIn {
                Text("Sign in under Cloud & Team to receive email notifications.").foregroundStyle(.secondary)
            } else {
                Section {
                    Toggle("Send me email notifications", isOn: binding("email"))
                    LabeledContent("Sent to", value: cloud.email)
                    if loaded && !cloud.emailEnabledOnServer {
                        Label("Email isn't set up on the server yet, so nothing is sent until an admin adds the SMTP settings (see CLOUD_SETUP.md).", systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.orange)
                    }
                } header: { Text("Email") }

                Section {
                    ForEach(Self.options, id: \.key) { o in
                        Toggle(isOn: binding(o.key)) {
                            Text(o.title)
                            if !o.detail.isEmpty { Text(o.detail) }
                        }
                        .disabled(prefs["email"] == false)
                    }
                } header: { Text("Email me when") }

                Section {
                    Toggle(isOn: binding("includeDetails")) {
                        Text("Include task and contract details")
                        Text("When off, emails only say something happened (\"A task was assigned to you\"). Your workspace data is end-to-end encrypted; details in an email are readable by the mail providers along the way.")
                    }
                } header: { Text("Privacy") }

                Section {
                    HStack {
                        Button("Send test email") { act("Test email sent to \(cloud.email).") { try await cloud.sendTestEmail() } }
                            .disabled(busy || !cloud.emailEnabledOnServer)
                        if busy { ProgressView().controlSize(.small) }
                        Spacer()
                    }
                    Text("In-app Inbox notifications are always on; these settings only control email.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let note { Text(note).font(.callout).foregroundStyle(.secondary) }
                }
            }
        }
        .formStyle(.grouped)
        .task(id: cloud.isSignedIn) {
            guard cloud.isSignedIn else { return }
            do { try await cloud.loadNotifyPrefs(); prefs = cloud.notifyPrefs; loaded = true } catch { note = error.localizedDescription }
        }
    }

    private func binding(_ key: String) -> Binding<Bool> {
        Binding(get: { prefs[key] ?? true }, set: { v in
            prefs[key] = v
            let all = prefs
            act(nil) { try await cloud.saveNotifyPrefs(all) }
        })
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
