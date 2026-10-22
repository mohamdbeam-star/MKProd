import SwiftUI

struct ContentView: View {
    @Environment(Store.self) private var store

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 340)
        } detail: {
            DetailRouter(item: store.selection ?? .home)
                .id(store.selection)
                .background(MKBackdrop())
        }
        .inspector(isPresented: Binding(get: { store.openTaskId != nil }, set: { if !$0 { store.openTaskId = nil } })) {
            if let id = store.openTaskId, store.task(id) != nil {
                TaskDetailView(taskId: id)
                    .inspectorColumnWidth(min: 340, ideal: 440, max: 700)
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button { store.showCommandPalette = true } label: {
                    HStack {
                        Image(systemName: "magnifyingglass")
                        Text("Search tasks, docs, lists…").foregroundStyle(.secondary)
                        Spacer()
                        Text("⌘K").font(.caption).foregroundStyle(.tertiary)
                    }
                    .frame(width: 300)
                }
            }
            ToolbarItem { TimerToolbarButton() }
            ToolbarItem {
                Button { store.selection = .inbox } label: {
                    Image(systemName: store.unreadCount > 0 ? "bell.badge.fill" : "bell")
                }
                .help("Inbox (\(store.unreadCount) unread)")
            }
        }
        .sheet(isPresented: $store.showCommandPalette) { CommandPalette() }
        .onOpenURL { url in store.open(url) }
        .safeAreaInset(edge: .top, spacing: 0) {
            if store.cloud.isConnected && !store.cloud.canWrite {
                Label("View-only access: your changes won't be shared with the team.", systemImage: "eye")
                    .font(.callout).frame(maxWidth: .infinity).padding(6).mkCard(radius: 0, tint: .orange)
            }
        }
        .alert("MK Prod", isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.lastError = nil } })) {
            Button("OK") { store.lastError = nil }
        } message: { Text(store.lastError ?? "") }
    }
}

struct DetailRouter: View {
    let item: SidebarItem

    var body: some View {
        switch item {
        case .home: HomeView()
        case .inbox: InboxView()
        case .everything, .myTasks, .space, .folder, .list: TaskContainerView(location: item)
        case .docs: DocsHomeView()
        case .doc(let id): DocEditorView(docId: id)
        case .whiteboards: WhiteboardsHomeView()
        case .whiteboard(let id): WhiteboardView(boardId: id)
        case .chat(let id): ChatView(channelId: id)
        case .goals: GoalsView()
        case .dashboards: DashboardsHomeView()
        case .dashboard(let id): DashboardView(dashboardId: id)
        case .timesheet: TimesheetView()
        case .automations: AutomationsView()
        case .templates: TemplatesView()
        case .trash: TrashView(showTrash: true)
        case .archive: TrashView(showTrash: false)
        case .finDashboard: FinanceDashboardView()
        case .finAlerts: FinanceAlertsView()
        case .finBudgets: BudgetsView()
        case .finOrders: OrdersView(approvalsOnly: false)
        case .finApprovals: OrdersView(approvalsOnly: true)
        case .finCatalog: CatalogView()
        case .finContracts: ContractsView()
        case .finSavings: SavingsView()
        case .finAnalytics: FinanceAnalyticsView()
        case .finReports: FinanceReportsView()
        case .finSettings: FinanceSettingsView()
        case .finAudit: AuditLogView()
        }
    }
}

struct TimerToolbarButton: View {
    @Environment(Store.self) private var store

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            if let e = store.runningEntry {
                Button { store.stopTimer() } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "stop.circle.fill").foregroundStyle(.red)
                        Text(e.duration.hms).monospacedDigit()
                        if let t = store.task(e.taskId) { Text(t.title).lineLimit(1).frame(maxWidth: 140) }
                    }
                }
                .help("Stop timer")
            } else {
                Button { store.startTimer(task: store.openTaskId) } label: { Image(systemName: "play.circle") }
                    .help("Start timer")
            }
        }
    }
}
