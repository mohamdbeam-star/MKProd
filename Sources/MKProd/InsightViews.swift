import SwiftUI
import Charts

// MARK: - Goals

struct GoalsView: View {
    @Environment(Store.self) private var store
    @State private var editing: Goal?

    var body: some View {
        let folders = Array(Set(store.data.goals.map(\.folder))).sorted()
        VStack(spacing: 0) {
            HStack {
                Text("Goals").font(.title2.bold())
                Spacer()
                Button {
                    let g = Goal(name: "New goal", dueDate: Date().adding(days: 30), ownerId: store.data.currentUserId, targets: [GoalTarget(name: "Target", kind: .number)])
                    store.data.goals.append(g)
                    editing = g
                } label: { Label("New Goal", systemImage: "plus") }
                    .buttonStyle(.borderedProminent)
            }
            .padding(16)
            Divider()
            if store.data.goals.isEmpty {
                EmptyState(icon: "target", title: "No goals yet", subtitle: "Set measurable targets and track them against tasks.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        ForEach(folders, id: \.self) { f in
                            Text(f).font(.headline).foregroundStyle(.secondary)
                            ForEach(store.data.goals.filter { $0.folder == f }) { g in goalCard(g) }
                        }
                    }
                    .padding(16)
                }
            }
        }
        .navigationTitle("Goals")
        .sheet(item: $editing) { g in GoalEditor(goalId: g.id) }
    }

    private func goalCard(_ g: Goal) -> some View {
        HStack(alignment: .top, spacing: 16) {
            ProgressRing(value: store.progress(g), color: Color(hex: g.colorHex), size: 56)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(g.name).font(.title3.bold())
                    Spacer()
                    if let o = store.member(g.ownerId) { AvatarView(member: o) }
                    if let d = g.dueDate { Text("Due \(d.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(d < Date() ? .red : .secondary) }
                    Button("Edit") { editing = g }
                }
                if !g.details.isEmpty { Text(g.details).foregroundStyle(.secondary) }
                ForEach(g.targets) { t in
                    HStack {
                        Text(t.name).frame(width: 220, alignment: .leading)
                        ProgressView(value: store.progress(t)).tint(Color(hex: g.colorHex))
                        Text(targetLabel(t)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 130, alignment: .trailing)
                    }
                    .font(.callout)
                }
            }
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }

    private func targetLabel(_ t: GoalTarget) -> String {
        switch t.kind {
        case .boolean: return t.current >= 1 ? "Done" : "Not done"
        case .tasks:
            let ts = t.taskIds.compactMap { store.task($0) }
            return "\(ts.filter(store.isClosed).count)/\(ts.count) tasks"
        case .currency: return "$\(Int(t.current)) / $\(Int(t.target))"
        case .number: return "\(Int(t.current)) / \(Int(t.target))"
        }
    }
}

struct GoalEditor: View {
    let goalId: UUID
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var store = store
        if let i = store.data.goals.firstIndex(where: { $0.id == goalId }) {
            VStack(spacing: 0) {
                Form {
                    Section("Goal") {
                        TextField("Name", text: $store.data.goals[i].name)
                        TextField("Description", text: $store.data.goals[i].details)
                        TextField("Folder", text: $store.data.goals[i].folder)
                        Picker("Owner", selection: $store.data.goals[i].ownerId) {
                            Text("None").tag(UUID?.none)
                            ForEach(store.data.members) { Text($0.name).tag(Optional($0.id)) }
                        }
                        DatePicker("Due", selection: Binding(get: { store.data.goals[i].dueDate ?? Date() }, set: { store.data.goals[i].dueDate = $0 }), displayedComponents: .date)
                        LabeledContent("Color") { ColorDots(hex: $store.data.goals[i].colorHex) }
                    }
                    Section("Targets") {
                        ForEach($store.data.goals[i].targets) { $t in
                            VStack(alignment: .leading) {
                                HStack {
                                    TextField("Target name", text: $t.name)
                                    Picker("", selection: $t.kind) { ForEach(TargetKind.allCases) { Text($0.label).tag($0) } }.labelsHidden().frame(width: 120)
                                    Button { let id = t.id; DispatchQueue.main.async { store.data.goals[i].targets.removeAll { $0.id == id } } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                                }
                                switch t.kind {
                                case .number, .currency:
                                    HStack {
                                        TextField("Start", value: $t.start, format: .number)
                                        TextField("Current", value: $t.current, format: .number)
                                        TextField("Target", value: $t.target, format: .number)
                                    }
                                case .boolean:
                                    Toggle("Achieved", isOn: Binding(get: { t.current >= 1 }, set: { t.current = $0 ? 1 : 0 }))
                                case .tasks:
                                    Menu("Linked tasks (\(t.taskIds.count))") {
                                        ForEach(store.data.tasks.filter { !$0.archived }) { task in
                                            Button { if t.taskIds.contains(task.id) { t.taskIds.removeAll { $0 == task.id } } else { t.taskIds.append(task.id) } } label: {
                                                Label(task.title, systemImage: t.taskIds.contains(task.id) ? "checkmark" : "circle")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Button("Add target") { store.data.goals[i].targets.append(GoalTarget(name: "Target", kind: .number)) }
                    }
                }
                .formStyle(.grouped)
                HStack {
                    Button("Delete goal", role: .destructive) { store.data.goals.remove(at: i); dismiss() }
                    Spacer()
                    Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                }
                .padding()
            }
            .frame(width: 560, height: 600)
        }
    }
}

// MARK: - Dashboards

struct DashboardsHomeView: View {
    @Environment(Store.self) private var store

    var body: some View {
        List {
            ForEach(store.data.dashboards) { d in
                HStack {
                    Label(d.name, systemImage: "chart.bar.xaxis")
                    Spacer()
                    Text("\(d.widgets.count) cards").foregroundStyle(.secondary)
                    Button("Open") { store.selection = .dashboard(d.id) }
                }
                .contextMenu { Button("Delete", role: .destructive) { store.data.dashboards.removeAll { $0.id == d.id } } }
            }
        }
        .safeAreaInset(edge: .top) {
            HStack {
                Text("Dashboards").font(.title2.bold())
                Spacer()
                Button {
                    let d = Dashboard(name: "New Dashboard", widgets: [DashboardWidget(kind: .statusBreakdown), DashboardWidget(kind: .workload)])
                    store.data.dashboards.append(d)
                    store.selection = .dashboard(d.id)
                } label: { Label("New Dashboard", systemImage: "plus") }.buttonStyle(.borderedProminent)
            }
            .padding(16)
        }
        .navigationTitle("Dashboards")
    }
}

struct DashboardView: View {
    let dashboardId: UUID
    @Environment(Store.self) private var store

    var body: some View {
        @Bindable var store = store
        if let i = store.data.dashboards.firstIndex(where: { $0.id == dashboardId }) {
            VStack(spacing: 0) {
                HStack {
                    TextField("Name", text: $store.data.dashboards[i].name).textFieldStyle(.plain).font(.title2.bold())
                    Spacer()
                    Menu {
                        ForEach(WidgetKind.allCases) { k in
                            Button(k.label) { store.data.dashboards[i].widgets.append(DashboardWidget(kind: k)) }
                        }
                    } label: { Label("Add card", systemImage: "plus") }
                        .fixedSize()
                }
                .padding(16)
                Divider()
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 380), spacing: 16)], spacing: 16) {
                        ForEach(store.data.dashboards[i].widgets) { w in
                            WidgetCard(widget: w, onRemove: { store.data.dashboards[i].widgets.removeAll { $0.id == w.id } },
                                       onScope: { sp in
                                           if let j = store.data.dashboards[i].widgets.firstIndex(where: { $0.id == w.id }) { store.data.dashboards[i].widgets[j].spaceId = sp }
                                       })
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle(store.data.dashboards[i].name)
        }
    }
}

private struct Slice: Identifiable {
    var id: String { name }
    let name: String
    let value: Double
    let color: Color
}

struct WidgetCard: View {
    let widget: DashboardWidget
    let onRemove: () -> Void
    let onScope: (UUID?) -> Void
    @Environment(Store.self) private var store

    private var tasks: [TaskItem] {
        let base = store.data.tasks.filter { !$0.archived }
        guard let sp = widget.spaceId else { return base }
        return base.filter { store.space(ofTask: $0)?.id == sp }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(widget.kind.label).font(.headline)
                Spacer()
                Menu {
                    Picker("Scope", selection: Binding(get: { widget.spaceId }, set: onScope)) {
                        Text("Whole workspace").tag(UUID?.none)
                        ForEach(store.data.spaces) { Text($0.name).tag(Optional($0.id)) }
                    }
                    Button("Remove card", role: .destructive, action: onRemove)
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            }
            Text(store.space(widget.spaceId)?.name ?? "Workspace").font(.caption).foregroundStyle(.secondary)
            content.frame(height: 220)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.06)))
    }

    @ViewBuilder
    private var content: some View {
        switch widget.kind {
        case .statusBreakdown:
            let slices = statusSlices
            Chart(slices) { s in
                SectorMark(angle: .value("Tasks", s.value), innerRadius: .ratio(0.55), angularInset: 1.5)
                    .foregroundStyle(s.color)
                    .annotation(position: .overlay) { Text("\(Int(s.value))").font(.caption.bold()).foregroundStyle(.white) }
            }
            .chartLegend(.hidden)
            .overlay(alignment: .trailing) {
                VStack(alignment: .leading) {
                    ForEach(slices) { s in HStack { Circle().fill(s.color).frame(width: 8); Text(s.name).font(.caption) } }
                }
            }
        case .priorityBreakdown:
            Chart(Priority.allCases.reversed()) { p in
                BarMark(x: .value("Priority", p.label), y: .value("Tasks", tasks.filter { $0.priority == p && !store.isClosed($0) }.count))
                    .foregroundStyle(p.color)
            }
        case .workload:
            Chart(store.data.members) { m in
                BarMark(x: .value("Open tasks", tasks.filter { $0.assigneeIds.contains(m.id) && !store.isClosed($0) }.count), y: .value("Member", m.name))
                    .foregroundStyle(Color(hex: m.colorHex))
            }
        case .overdue:
            let over = tasks.filter(store.isOverdue)
            VStack(alignment: .leading) {
                Text("\(over.count)").font(.system(size: 48, weight: .bold)).foregroundStyle(over.isEmpty ? .green : .red)
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(over) { t in
                            HStack { Text(t.title).lineLimit(1); Spacer(); Text(t.dueDate?.shortLabel ?? "").foregroundStyle(.red) }
                                .font(.callout).onTapGesture { store.openTaskId = t.id }
                        }
                    }
                }
            }
        case .completedTrend:
            let days = (0..<14).map { Date().startOfDay.adding(days: -13 + $0) }
            Chart(days, id: \.self) { d in
                let n = tasks.filter { $0.completedAt.map { Calendar.current.isDate($0, inSameDayAs: d) } ?? false }.count
                BarMark(x: .value("Day", d, unit: .day), y: .value("Completed", n)).foregroundStyle(.green.gradient)
            }
        case .timeTracked:
            let days = (0..<7).map { Date().startOfDay.adding(days: -6 + $0) }
            let entries = store.data.timeEntries.filter { e in widget.spaceId == nil || store.task(e.taskId).flatMap { store.space(ofTask: $0)?.id } == widget.spaceId }
            VStack(alignment: .leading) {
                Text(entries.filter { $0.start > Date().adding(days: -7) }.reduce(0) { $0 + $1.duration }.hoursMinutes + " this week").font(.title2.bold())
                Chart(days, id: \.self) { d in
                    let h = entries.filter { Calendar.current.isDate($0.start, inSameDayAs: d) }.reduce(0) { $0 + $1.duration } / 3600
                    BarMark(x: .value("Day", d, unit: .day), y: .value("Hours", h)).foregroundStyle(Color.accentColor.gradient)
                }
            }
        case .goals:
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(store.data.goals) { g in
                        HStack {
                            Text(g.name).frame(width: 160, alignment: .leading).lineLimit(1)
                            ProgressView(value: store.progress(g)).tint(Color(hex: g.colorHex))
                            Text("\(Int(store.progress(g) * 100))%").font(.caption.monospacedDigit())
                        }
                    }
                }
            }
        case .recentActivity:
            let items = tasks.flatMap { t in t.activity.map { (t, $0) } }.sorted { $0.1.date > $1.1.date }.prefix(12)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(items), id: \.1.id) { t, a in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(a.text).font(.callout)
                            Text("\(t.title) · \(a.date.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary)
                        }
                        .onTapGesture { store.openTaskId = t.id }
                    }
                }
            }
        }
    }

    private var statusSlices: [Slice] {
        var out: [Slice] = []
        for s in store.data.spaces.flatMap(\.statuses) where !out.contains(where: { $0.name == s.name }) {
            let n = tasks.filter { store.status(of: $0)?.name == s.name }.count
            if n > 0 { out.append(Slice(name: s.name, value: Double(n), color: Color(hex: s.colorHex))) }
        }
        return out
    }
}

// MARK: - Timesheets

struct TimesheetView: View {
    @Environment(Store.self) private var store
    @State private var weekStart = Calendar.current.dateInterval(of: .weekOfYear, for: Date())!.start
    @State private var memberId: UUID?

    var body: some View {
        let days = (0..<7).map { weekStart.adding(days: $0) }
        let entries = store.data.timeEntries.filter { $0.start >= weekStart && $0.start < weekStart.adding(days: 7) && (memberId == nil || $0.memberId == memberId) }
        let taskIds = Array(Set(entries.map { $0.taskId?.uuidString ?? "none" })).sorted()
        VStack(spacing: 0) {
            HStack {
                Button { weekStart = weekStart.adding(days: -7) } label: { Image(systemName: "chevron.left") }
                Text("\(weekStart.formatted(date: .abbreviated, time: .omitted)) – \(weekStart.adding(days: 6).formatted(date: .abbreviated, time: .omitted))").font(.headline)
                Button { weekStart = weekStart.adding(days: 7) } label: { Image(systemName: "chevron.right") }
                Spacer()
                Picker("Person", selection: $memberId) {
                    Text("Everyone").tag(UUID?.none)
                    ForEach(store.data.members) { Text($0.name).tag(Optional($0.id)) }
                }
                .frame(width: 220)
                Text("Total: \(entries.reduce(0) { $0 + $1.duration }.hoursMinutes)").bold()
                Text("Billable: \(entries.filter(\.billable).reduce(0) { $0 + $1.duration }.hoursMinutes)").foregroundStyle(.green)
            }
            .padding(12)
            Divider()
            ScrollView {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                    GridRow {
                        Text("Task").bold().frame(width: 260, alignment: .leading)
                        ForEach(days, id: \.self) { d in Text(d.formatted(.dateTime.weekday(.abbreviated).day())).bold().frame(width: 70) }
                        Text("Total").bold().frame(width: 70)
                    }
                    Divider()
                    ForEach(taskIds, id: \.self) { key in
                        let rowEntries = entries.filter { ($0.taskId?.uuidString ?? "none") == key }
                        GridRow {
                            Text(store.task(UUID(uuidString: key))?.title ?? "No task").lineLimit(1).frame(width: 260, alignment: .leading)
                                .onTapGesture { if let id = UUID(uuidString: key) { store.openTaskId = id } }
                            ForEach(days, id: \.self) { d in
                                let s = rowEntries.filter { Calendar.current.isDate($0.start, inSameDayAs: d) }.reduce(0) { $0 + $1.duration }
                                Text(s > 0 ? s.hoursMinutes : "–").monospacedDigit().foregroundStyle(s > 0 ? .primary : .tertiary).frame(width: 70)
                            }
                            Text(rowEntries.reduce(0) { $0 + $1.duration }.hoursMinutes).bold().frame(width: 70)
                        }
                    }
                    Divider()
                    GridRow {
                        Text("Daily total").bold().frame(width: 260, alignment: .leading)
                        ForEach(days, id: \.self) { d in
                            Text(entries.filter { Calendar.current.isDate($0.start, inSameDayAs: d) }.reduce(0) { $0 + $1.duration }.hoursMinutes).bold().frame(width: 70)
                        }
                        Text(entries.reduce(0) { $0 + $1.duration }.hoursMinutes).bold().frame(width: 70)
                    }
                }
                .padding(16)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Entries").font(.headline)
                    ForEach(entries.sorted { $0.start > $1.start }) { e in
                        HStack {
                            AvatarView(member: store.member(e.memberId), size: 18)
                            Text(store.task(e.taskId)?.title ?? "No task").lineLimit(1).frame(width: 240, alignment: .leading)
                            Text(e.start.formatted(date: .abbreviated, time: .shortened)).foregroundStyle(.secondary)
                            Text("→ \(e.end?.formatted(date: .omitted, time: .shortened) ?? "running")").foregroundStyle(.secondary)
                            Spacer()
                            Toggle("Billable", isOn: Binding(get: { e.billable }, set: { v in
                                if let i = store.data.timeEntries.firstIndex(where: { $0.id == e.id }) { store.data.timeEntries[i].billable = v }
                            })).toggleStyle(.checkbox)
                            Text(e.duration.hoursMinutes).monospacedDigit().frame(width: 70, alignment: .trailing)
                            Button { store.data.timeEntries.removeAll { $0.id == e.id } } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                        }
                        .font(.callout)
                    }
                }
                .padding(16)
            }
        }
        .navigationTitle("Timesheets")
    }
}

// MARK: - Automations

struct AutomationsView: View {
    @Environment(Store.self) private var store

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Automations").font(.title2.bold())
                    Text("When something happens, MK Prod does the busywork.").foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    store.data.automations.append(Automation(name: "New automation", trigger: .statusChanged, action: .setPriority, actionValue: "High"))
                } label: { Label("Add Automation", systemImage: "plus") }
                    .buttonStyle(.borderedProminent)
            }
            .padding(16)
            Divider()
            if store.data.automations.isEmpty {
                EmptyState(icon: "bolt", title: "No automations", subtitle: "Create a rule like \"When status changes to Review, assign Sara\".")
            } else {
                List {
                    ForEach($store.data.automations) { $a in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Toggle("", isOn: $a.enabled).labelsHidden().toggleStyle(.switch)
                                TextField("Name", text: $a.name).font(.headline).textFieldStyle(.plain)
                                Spacer()
                                Text("Ran \(a.runCount)×").font(.caption).foregroundStyle(.secondary)
                                Button(role: .destructive) { let id = a.id; DispatchQueue.main.async { store.data.automations.removeAll { $0.id == id } } } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless)
                            }
                            HStack {
                                Text("IN").font(.caption.bold()).foregroundStyle(.secondary)
                                Picker("", selection: $a.spaceId) {
                                    Text("All spaces").tag(UUID?.none)
                                    ForEach(store.data.spaces) { Text($0.name).tag(Optional($0.id)) }
                                }
                                .labelsHidden().frame(width: 140)
                                Text("WHEN").font(.caption.bold()).foregroundStyle(.secondary)
                                Picker("", selection: $a.trigger) { ForEach(TriggerType.allCases) { Text($0.label).tag($0) } }
                                    .labelsHidden().frame(width: 170)
                                if a.trigger != .taskCreated && a.trigger != .dueDatePassed {
                                    valueField(for: a.trigger, value: $a.triggerValue, placeholder: "any")
                                }
                                Text("THEN").font(.caption.bold()).foregroundStyle(.secondary)
                                Picker("", selection: $a.action) { ForEach(ActionType.allCases) { Text($0.label).tag($0) } }
                                    .labelsHidden().frame(width: 200)
                                if a.action != .archive { actionField(a.action, value: $a.actionValue) }
                            }
                        }
                        .padding(.vertical, 6)
                        .opacity(a.enabled ? 1 : 0.5)
                    }
                }
            }
        }
        .navigationTitle("Automations")
    }

    private var statusNames: [String] { Array(NSOrderedSet(array: store.data.spaces.flatMap { $0.statuses.map(\.name) })) as? [String] ?? [] }

    @ViewBuilder
    private func valueField(for trigger: TriggerType, value: Binding<String>, placeholder: String) -> some View {
        switch trigger {
        case .statusChanged:
            Picker("", selection: value) { Text("Any").tag(""); ForEach(statusNames, id: \.self) { Text($0).tag($0) } }.labelsHidden().frame(width: 130)
        case .priorityChanged:
            Picker("", selection: value) { Text("Any").tag(""); ForEach(Priority.allCases) { Text($0.label).tag($0.label) } }.labelsHidden().frame(width: 130)
        case .assigneeAdded:
            Picker("", selection: value) { Text("Anyone").tag(""); ForEach(store.data.members) { Text($0.name).tag($0.name) } }.labelsHidden().frame(width: 130)
        default:
            TextField(placeholder, text: value).frame(width: 110)
        }
    }

    @ViewBuilder
    private func actionField(_ action: ActionType, value: Binding<String>) -> some View {
        switch action {
        case .setStatus:
            Picker("", selection: value) { ForEach(statusNames, id: \.self) { Text($0).tag($0) } }.labelsHidden().frame(width: 130)
        case .setPriority:
            Picker("", selection: value) { ForEach(Priority.allCases) { Text($0.label).tag($0.label) } }.labelsHidden().frame(width: 130)
        case .assign:
            Picker("", selection: value) { ForEach(store.data.members) { Text($0.name).tag($0.name) } }.labelsHidden().frame(width: 130)
        case .moveToList:
            Picker("", selection: value) { ForEach(store.data.lists) { Text($0.name).tag($0.name) } }.labelsHidden().frame(width: 130)
        default:
            TextField("value", text: value).frame(width: 160)
        }
    }
}
