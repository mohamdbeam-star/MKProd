import SwiftUI

private enum CreateRequest: Identifiable {
    case space, folder(UUID), list(UUID, UUID?), channel
    case rename(SidebarItem, String)
    var id: String {
        switch self {
        case .space: "space"
        case .folder(let s): "folder\(s)"
        case .list(let s, let f): "list\(s)\(f?.uuidString ?? "")"
        case .channel: "channel"
        case .rename(let i, _): "rename\(i)"
        }
    }
}

struct SidebarView: View {
    @Environment(Store.self) private var store
    @State private var request: CreateRequest?
    @State private var editingSpace: Space?
    @State private var sprintList: TaskList?

    var body: some View {
        @Bindable var store = store
        List(selection: $store.selection) {
            Section {
                if store.cloud.isSignedIn {
                    WorkspaceSwitcher()
                }
                Button { store.showCommandPalette = true } label: {
                    HStack {
                        Image(systemName: "magnifyingglass")
                        Text("Search")
                        Spacer()
                        Text("⌘K").font(.caption).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                row("Home", "house", .home)
                Label {
                    HStack {
                        Text("Inbox")
                        Spacer()
                        if store.unreadCount > 0 {
                            Text("\(store.unreadCount)").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Color.red, in: Capsule()).foregroundStyle(.white)
                        }
                    }
                } icon: { Image(systemName: "tray") }
                .tag(SidebarItem.inbox)
                row("My Tasks", "person.crop.circle.badge.checkmark", .myTasks)
                row("Everything", "square.stack.3d.up", .everything)
            }

            if !store.data.favorites.isEmpty {
                Section("Favorites") {
                    ForEach(store.data.favorites, id: \.self) { id in
                        if let l = store.list(id) {
                            row(l.name, "list.bullet", .list(id))
                        } else if let d = store.data.docs.first(where: { $0.id == id }) {
                            row(d.title, d.icon, .doc(id))
                        }
                    }
                }
            }

            Section {
                ForEach(store.data.spaces) { space in
                    spaceRow(space)
                }
            } header: {
                HStack {
                    Text("Spaces")
                    Spacer()
                    Button { request = .space } label: { Image(systemName: "plus") }.buttonStyle(.plain).help("New Space")
                }
            }

            Section("Whiteboards") {
                row("Whiteboards", "scribble.variable", .whiteboards)
            }

            Section {
                ForEach(store.data.channels) { c in
                    row(c.name, "number", .chat(c.id))
                        .contextMenu {
                            Button("Delete Channel", role: .destructive) {
                                store.data.channels.removeAll { $0.id == c.id }
                                store.data.messages.removeAll { $0.channelId == c.id }
                            }
                        }
                }
            } header: {
                HStack {
                    Text("Chat")
                    Spacer()
                    Button { request = .channel } label: { Image(systemName: "plus") }.buttonStyle(.plain).help("New Channel")
                }
            }

            Section("Budget & Procurement") {
                row("Budgets", "banknote", .finBudgets)
                row("Orders & Expenses", "shippingbox", .finOrders)
                Label {
                    HStack {
                        Text("My Approvals")
                        Spacer()
                        let n = store.data.orders.filter { store.canApprove($0, member: store.data.currentUserId) }.count
                        if n > 0 { Text("\(n)").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 1).background(Color.accentColor, in: Capsule()).foregroundStyle(.white) }
                    }
                } icon: { Image(systemName: "checkmark.seal") }
                .tag(SidebarItem.finApprovals)
                row("Shopping Catalog", "cart", .finCatalog)
                row("Contracts", "doc.plaintext", .finContracts)
                row("Savings", "dollarsign.arrow.circlepath", .finSavings)
                row("Reports", "doc.richtext", .finReports)
                row("Audit Log", "list.bullet.clipboard", .finAudit)
                row("Finance Settings", "slider.horizontal.3", .finSettings)
            }

            Section("Workspace") {
                row("Goals", "target", .goals)
                row("Portfolio", "square.stack.3d.up", .portfolio)
                row("Resources", "person.badge.clock", .resources)
                row("Dashboards", "chart.bar.xaxis", .dashboards)
                row("Timesheets", "clock", .timesheet)
                row("Automations", "bolt", .automations)
                row("Templates", "square.on.square.dashed", .templates)
                row("Content Directory", "books.vertical", .directory)
                row("Archive", "archivebox", .archive)
                row("Trash", "trash", .trash)
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack {
                AvatarView(member: store.me, size: 26)
                VStack(alignment: .leading, spacing: 0) {
                    Text(store.me.name).font(.callout.weight(.medium))
                    Text(store.data.workspaceName).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                UpdateButton()
                CloudStatusBadge()
                SettingsLink { Image(systemName: "gearshape") }.buttonStyle(.plain)
            }
            .padding(10)
            .background(.bar)
        }
        .sheet(item: $request) { r in
            switch r {
            case .space:
                NamePrompt(title: "New Space") { store.selection = .space(store.addSpace($0).id) }
            case .folder(let s):
                NamePrompt(title: "New Folder") { store.selection = .folder(store.addFolder($0, space: s).id) }
            case .list(let s, let f):
                NamePrompt(title: "New List") { store.selection = .list(store.addList($0, space: s, folder: f).id) }
            case .channel:
                NamePrompt(title: "New Channel") { name in
                    let c = ChatChannel(name: name.lowercased().replacingOccurrences(of: " ", with: "-"))
                    store.data.channels.append(c)
                    store.selection = .chat(c.id)
                }
            case .rename(let item, let current):
                NamePrompt(title: "Rename", initial: current) { rename(item, $0) }
            }
        }
        .sheet(item: $editingSpace) { s in SpaceSettingsView(spaceId: s.id) }
        .sheet(item: $sprintList) { l in SprintSettingsSheet(listId: l.id) }
    }

    private func row(_ title: String, _ icon: String, _ tag: SidebarItem) -> some View {
        Label(title, systemImage: icon).tag(tag)
    }

    @ViewBuilder
    private func spaceRow(_ space: Space) -> some View {
        DisclosureGroup {
            ForEach(store.data.folders.filter { $0.spaceId == space.id }) { f in
                DisclosureGroup {
                    ForEach(store.lists(inSpace: space.id, folder: f.id)) { l in listRow(l) }
                } label: {
                    Label(f.name, systemImage: "folder").tag(SidebarItem.folder(f.id))
                        .contextMenu {
                            Button("New List") { request = .list(space.id, f.id) }
                            Button("New Sprint") {
                                let last = store.data.lists.filter { $0.folderId == f.id && $0.isSprint }.last
                                if let last { store.selection = .list(store.nextSprint(after: last.id)) } else {
                                    let l = store.addList("Sprint 1", space: space.id, folder: f.id)
                                    if let i = store.data.lists.firstIndex(where: { $0.id == l.id }) {
                                        store.data.lists[i].sprintStart = Date().startOfDay
                                        store.data.lists[i].sprintEnd = Date().startOfDay.adding(days: 13)
                                    }
                                    store.selection = .list(l.id)
                                }
                            }
                            Button("Rename") { request = .rename(.folder(f.id), f.name) }
                            Divider()
                            Button("Delete Folder", role: .destructive) { store.deleteFolder(f.id) }
                        }
                }
            }
            ForEach(store.lists(inSpace: space.id, folder: nil)) { l in listRow(l) }
        } label: {
            Label {
                Text(space.name)
            } icon: {
                Image(systemName: space.icon)
                    .foregroundStyle(.white)
                    .font(.system(size: 9, weight: .bold))
                    .frame(width: 18, height: 18)
                    .background(Color(hex: space.colorHex), in: RoundedRectangle(cornerRadius: 4))
            }
            .tag(SidebarItem.space(space.id))
            .contextMenu {
                Button("New List") { request = .list(space.id, nil) }
                Button("New Folder") { request = .folder(space.id) }
                Button("Space Settings…") { editingSpace = space }
                Button("Rename") { request = .rename(.space(space.id), space.name) }
                Divider()
                Button("Delete Space", role: .destructive) { store.deleteSpace(space.id) }
            }
        }
    }

    private func listRow(_ l: TaskList) -> some View {
        let count = store.data.tasks.filter { $0.listId == l.id && $0.parentId == nil && !$0.archived }.count
        return Label {
            HStack {
                Text(l.name)
                Spacer()
                Text("\(count)").font(.caption).foregroundStyle(.tertiary)
            }
        } icon: {
            Image(systemName: l.isSprint ? "flag.checkered" : "list.bullet").foregroundStyle(l.colorHex.map { Color(hex: $0) } ?? .secondary)
        }
        .tag(SidebarItem.list(l.id))
        .contextMenu {
            Button(store.data.favorites.contains(l.id) ? "Remove from Favorites" : "Add to Favorites") { store.toggleFavorite(l.id) }
            Button("Rename") { request = .rename(.list(l.id), l.name) }
            Button("Duplicate") { store.duplicateList(l.id) }
            Button("Sprint Settings…") { sprintList = l }
            Menu("Color") {
                ForEach(paletteHexes, id: \.self) { h in
                    Button(h) { if let i = store.data.lists.firstIndex(where: { $0.id == l.id }) { store.data.lists[i].colorHex = h } }
                }
            }
            Divider()
            Button("Archive") { if let i = store.data.lists.firstIndex(where: { $0.id == l.id }) { store.data.lists[i].archived = true } }
            Button("Delete List", role: .destructive) { store.deleteList(l.id) }
        }
    }

    private func rename(_ item: SidebarItem, _ name: String) {
        switch item {
        case .space(let id): if let i = store.data.spaces.firstIndex(where: { $0.id == id }) { store.data.spaces[i].name = name }
        case .folder(let id): if let i = store.data.folders.firstIndex(where: { $0.id == id }) { store.data.folders[i].name = name }
        case .list(let id): if let i = store.data.lists.firstIndex(where: { $0.id == id }) { store.data.lists[i].name = name }
        default: break
        }
    }
}


/// Switches between the shared workspaces the signed-in person belongs to. Each switch loads
/// that workspace from the server (a backup of the current local copy is written first).
struct WorkspaceSwitcher: View {
    @Environment(Store.self) private var store
    @State private var switching = false

    var body: some View {
        Menu {
            Section("Shared workspaces") {
                ForEach(store.cloud.workspaces) { ws in
                    Button {
                        guard ws.id != store.cloud.workspaceId else { return }
                        switching = true
                        Task { @MainActor in
                            do { try await store.cloud.join(ws) } catch { store.lastError = error.localizedDescription }
                            switching = false
                        }
                    } label: {
                        if ws.id == store.cloud.workspaceId { Label(ws.name, systemImage: "checkmark") } else { Text("\(ws.name)  ·  \(ws.role)") }
                    }
                }
                if store.cloud.workspaces.isEmpty { Text("None yet") }
            }
            Section {
                SettingsLink { Text("Create or join a workspace…") }
            }
        } label: {
            HStack {
                Image(systemName: "building.2")
                Text(store.data.workspaceName).fontWeight(.semibold).lineLimit(1)
                Spacer()
                if switching { ProgressView().controlSize(.mini) } else { Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
        }
        .menuStyle(.borderlessButton)
        .task { try? await store.cloud.refreshWorkspaces() }
    }
}
