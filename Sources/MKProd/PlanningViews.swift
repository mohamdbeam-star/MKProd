import SwiftUI

// MARK: - Calendar

struct CalendarView: View {
    let tasks: [TaskItem]
    let defaultList: UUID?
    @Environment(Store.self) private var store
    @State private var month = Date()
    @State private var weekMode = false

    private var cal: Calendar { Calendar.current }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { shift(-1) } label: { Image(systemName: "chevron.left") }
                Button("Today") { month = Date() }
                Button { shift(1) } label: { Image(systemName: "chevron.right") }
                Text(weekMode ? month.formatted(.dateTime.month(.wide).day().year()) : month.formatted(.dateTime.month(.wide).year()))
                    .font(.title3.bold())
                Spacer()
                Picker("", selection: $weekMode) { Text("Month").tag(false); Text("Week").tag(true) }
                    .pickerStyle(.segmented).frame(width: 160)
                let unscheduled = tasks.filter { $0.dueDate == nil }.count
                if unscheduled > 0 { Text("\(unscheduled) unscheduled").foregroundStyle(.secondary).font(.caption) }
            }
            .padding(12)
            HStack(spacing: 0) {
                ForEach(weekdaySymbols, id: \.self) { d in
                    Text(d).font(.caption.bold()).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            .padding(.bottom, 4)
            let days = visibleDays
            let rows = days.count / 7
            GeometryReader { geo in
                VStack(spacing: 1) {
                    ForEach(0..<rows, id: \.self) { r in
                        HStack(spacing: 1) {
                            ForEach(0..<7, id: \.self) { c in
                                dayCell(days[r * 7 + c])
                                    .frame(width: (geo.size.width - 6) / 7, height: (geo.size.height - CGFloat(rows)) / CGFloat(rows))
                            }
                        }
                    }
                }
            }
            .background(Color.primary.opacity(0.08))
        }
    }

    private var weekdaySymbols: [String] {
        let s = cal.shortWeekdaySymbols
        let first = cal.firstWeekday - 1
        return Array(s[first...] + s[..<first])
    }

    private var visibleDays: [Date] {
        if weekMode {
            let start = cal.dateInterval(of: .weekOfYear, for: month)!.start
            return (0..<7).map { start.adding(days: $0) }
        }
        let first = cal.dateInterval(of: .month, for: month)!.start
        let weekStart = cal.dateInterval(of: .weekOfYear, for: first)!.start
        let count = cal.range(of: .day, in: .month, for: month)!.count
        let lead = cal.dateComponents([.day], from: weekStart, to: first).day!
        let cells = Int(ceil(Double(lead + count) / 7.0)) * 7
        return (0..<cells).map { weekStart.adding(days: $0) }
    }

    private func shift(_ n: Int) {
        month = cal.date(byAdding: weekMode ? .weekOfYear : .month, value: n, to: month)!
    }

    private func dayCell(_ day: Date) -> some View {
        let inMonth = weekMode || cal.isDate(day, equalTo: month, toGranularity: .month)
        let items = tasks.filter { $0.dueDate.map { cal.isDate($0, inSameDayAs: day) } ?? false }
        return VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text("\(cal.component(.day, from: day))")
                    .font(.caption.weight(cal.isDateInToday(day) ? .bold : .regular))
                    .foregroundStyle(cal.isDateInToday(day) ? Color.white : (inMonth ? Color.primary : Color.secondary.opacity(0.5)))
                    .padding(4)
                    .background(cal.isDateInToday(day) ? Color.accentColor : .clear, in: Circle())
                Spacer()
                Button {
                    if let l = defaultList { store.openTaskId = store.addTask("New task", list: l, due: day).id }
                } label: { Image(systemName: "plus").font(.caption2) }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(items) { t in
                        HStack(spacing: 4) {
                            Circle().fill(Color(hex: store.status(of: t)?.colorHex ?? "#888")).frame(width: 6, height: 6)
                            Text(t.title).font(.caption).lineLimit(1).strikethrough(store.isClosed(t))
                        }
                        .padding(.horizontal, 4).padding(.vertical, 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(hex: store.status(of: t)?.colorHex ?? "#888").opacity(0.15), in: RoundedRectangle(cornerRadius: 3))
                        .onTapGesture { store.openTaskId = t.id }
                        .draggable(t.id.uuidString)
                        .contextMenu { TaskContextMenu(task: t) }
                    }
                }
            }
        }
        .padding(4)
        .background(inMonth ? Color(nsColor: .textBackgroundColor) : Color(nsColor: .windowBackgroundColor))
        .dropDestination(for: String.self) { ids, _ in
            for s in ids {
                guard let id = UUID(uuidString: s), let t = store.task(id) else { continue }
                // Keep the task's duration when rescheduling.
                var span: TimeInterval?
                if let s = t.startDate, let d = t.dueDate { span = d.timeIntervalSince(s) }
                store.updateTask(id) { x in
                    x.dueDate = day
                    if let span { x.startDate = day.addingTimeInterval(-span) }
                }
            }
            return true
        }
    }
}

// MARK: - Gantt

struct GanttView: View {
    let tasks: [TaskItem]
    @Environment(Store.self) private var store
    @State private var dayWidth: CGFloat = 32
    @State private var dragOffsets: [UUID: CGFloat] = [:]
    @State private var showCritical = true
    @State private var showBaseline = true
    @State private var confirmBaseline = false

    private let rowHeight: CGFloat = 34
    private var critical: Set<UUID> { showCritical ? criticalPath(tasks) : [] }
    private var hasBaseline: Bool { tasks.contains { $0.baselineStart != nil || $0.baselineDue != nil } }
    private func slip(_ t: TaskItem) -> Int {
        guard let b = t.baselineDue, let d = t.dueDate else { return 0 }
        return Calendar.current.dateComponents([.day], from: b.startOfDay, to: d.startOfDay).day ?? 0
    }
    private let labelWidth: CGFloat = 240

    private var range: (Date, Int) {
        let dated = tasks.flatMap { [$0.startDate, $0.dueDate, showBaseline ? $0.baselineStart : nil, showBaseline ? $0.baselineDue : nil].compactMap { $0 } }
        let start = (dated.min() ?? Date()).startOfDay.adding(days: -3)
        let end = max((dated.max() ?? Date()).startOfDay, Date().startOfDay).adding(days: 10)
        let days = max(Calendar.current.dateComponents([.day], from: start, to: end).day ?? 30, 21)
        return (start, days)
    }

    var body: some View {
        let (start, days) = range
        VStack(spacing: 0) {
            HStack {
                Text("Drag bars to reschedule. Dependencies show as arrows.").font(.caption).foregroundStyle(.secondary)
                Toggle("Critical path", isOn: $showCritical).toggleStyle(.checkbox)
                    .help("The longest chain of dependent tasks: a delay on any of them delays the end of the chain.")
                Toggle("Baseline", isOn: $showBaseline).toggleStyle(.checkbox)
                if hasBaseline {
                    let late = tasks.filter { slip($0) > 0 }.count
                    Text(late > 0 ? "\(late) behind baseline" : "On baseline").font(.caption).foregroundStyle(late > 0 ? .red : .green)
                }
                Button("Save baseline") { if hasBaseline { confirmBaseline = true } else { saveBaseline() } }
                    .help("Keep today's planned dates so later slips show as a grey line under each bar")
                if hasBaseline {
                    Button("Clear baseline") {
                        for t in tasks { store.updateTask(t.id) { $0.baselineStart = nil; $0.baselineDue = nil } }
                    }
                }
                Spacer()
                Image(systemName: "minus.magnifyingglass")
                Slider(value: $dayWidth, in: 14...70).frame(width: 140)
                Image(systemName: "plus.magnifyingglass")
            }
            .padding(10)
            Divider()
            ScrollView([.vertical]) {
                HStack(alignment: .top, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Task").font(.caption.bold()).frame(height: 36).padding(.leading, 8)
                        ForEach(tasks) { t in
                            HStack {
                                StatusPill(status: store.status(of: t), compact: true)
                                Text(t.title).lineLimit(1).font(.callout)
                                    .foregroundStyle(critical.contains(t.id) ? Color.red : Color.primary)
                            }
                            .frame(width: labelWidth, height: rowHeight, alignment: .leading)
                            .padding(.leading, 8)
                            .contentShape(Rectangle())
                            .onTapGesture { store.openTaskId = t.id }
                        }
                    }
                    .frame(width: labelWidth)
                    Divider()
                    ScrollView(.horizontal) {
                        ZStack(alignment: .topLeading) {
                            grid(start: start, days: days)
                            dependencyLines(start: start)
                            ForEach(Array(tasks.enumerated()), id: \.element.id) { i, t in
                                bar(t, row: i, start: start)
                            }
                        }
                        .frame(width: CGFloat(days) * dayWidth, height: 36 + CGFloat(tasks.count) * rowHeight, alignment: .topLeading)
                    }
                }
            }
        }
        .confirmationDialog("Replace the saved baseline with the current dates?", isPresented: $confirmBaseline) {
            Button("Replace baseline") { saveBaseline() }
        }
    }

    private func saveBaseline() {
        for t in tasks where t.startDate != nil || t.dueDate != nil {
            store.updateTask(t.id) { $0.baselineStart = $0.startDate; $0.baselineDue = $0.dueDate }
        }
    }

    private func grid(start: Date, days: Int) -> some View {
        ZStack(alignment: .topLeading) {
            HStack(spacing: 0) {
                ForEach(0..<days, id: \.self) { d in
                    let day = start.adding(days: d)
                    let weekend = Calendar.current.isDateInWeekend(day)
                    VStack(spacing: 0) {
                        VStack(spacing: 0) {
                            Text(day.formatted(.dateTime.weekday(.narrow))).font(.system(size: 9)).foregroundStyle(.tertiary)
                            Text("\(Calendar.current.component(.day, from: day))").font(.caption2)
                        }
                        .frame(height: 36)
                        Rectangle().fill(weekend ? Color.primary.opacity(0.04) : .clear)
                    }
                    .frame(width: dayWidth)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.06)).frame(width: 1) }
                }
            }
            let todayX = CGFloat(Calendar.current.dateComponents([.day], from: start, to: Date().startOfDay).day ?? 0) * dayWidth + dayWidth / 2
            Rectangle().fill(Color.red).frame(width: 2).offset(x: todayX).padding(.top, 30)
        }
    }

    private func x(for date: Date, start: Date) -> CGFloat {
        CGFloat(date.startOfDay.timeIntervalSince(start) / 86400) * dayWidth
    }

    private func barFrame(_ t: TaskItem, start: Date) -> (CGFloat, CGFloat)? {
        guard let s = t.startDate ?? t.dueDate, let e = t.dueDate ?? t.startDate else { return nil }
        let x0 = x(for: s, start: start)
        let x1 = x(for: e, start: start) + dayWidth
        return (x0, max(x1 - x0, dayWidth))
    }

    @ViewBuilder
    private func baselineBar(_ t: TaskItem, row: Int, start: Date) -> some View {
        if showBaseline, let s = t.baselineStart ?? t.baselineDue, let e = t.baselineDue ?? t.baselineStart {
            let x0 = x(for: s, start: start)
            Capsule().fill(Color.secondary.opacity(0.5))
                .frame(width: max(x(for: e, start: start) + dayWidth - x0, dayWidth), height: 4)
                .offset(x: x0, y: 36 + CGFloat(row) * rowHeight + rowHeight - 6)
                .help("Baseline \(s.formatted(date: .abbreviated, time: .omitted)) → \(e.formatted(date: .abbreviated, time: .omitted))")
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private func bar(_ t: TaskItem, row: Int, start: Date) -> some View {
        baselineBar(t, row: row, start: start)
        if let (x0, w) = barFrame(t, start: start) {
            let color = Color(hex: store.status(of: t)?.colorHex ?? "#7B68EE")
            let off = dragOffsets[t.id] ?? 0
            Group {
                if t.isMilestone {
                    Image(systemName: "diamond.fill").foregroundStyle(.purple).font(.system(size: 16))
                        .frame(width: dayWidth, height: rowHeight - 10)
                } else {
                    RoundedRectangle(cornerRadius: 5).fill(color.opacity(0.85))
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.red, lineWidth: critical.contains(t.id) ? 2 : 0))
                        .overlay(alignment: .leading) {
                            Text(t.title).font(.caption2.bold()).foregroundStyle(.white).lineLimit(1).padding(.horizontal, 6)
                        }
                        .frame(width: w, height: rowHeight - 12)
                }
            }
            .offset(x: x0 + off, y: 36 + CGFloat(row) * rowHeight + 6)
            .onTapGesture { store.openTaskId = t.id }
            .gesture(
                DragGesture()
                    .onChanged { v in dragOffsets[t.id] = v.translation.width }
                    .onEnded { v in
                        let days = Int((v.translation.width / dayWidth).rounded())
                        dragOffsets[t.id] = nil
                        guard days != 0 else { return }
                        store.updateTask(t.id) { x in
                            x.startDate = x.startDate?.adding(days: days)
                            x.dueDate = x.dueDate?.adding(days: days)
                        }
                    }
            )
            .help("\(t.title)\n\(t.startDate?.formatted(date: .abbreviated, time: .omitted) ?? "–") → \(t.dueDate?.formatted(date: .abbreviated, time: .omitted) ?? "–")\(critical.contains(t.id) ? "\nOn the critical path" : "")\(slip(t) != 0 ? "\n\(abs(slip(t))) day(s) \(slip(t) > 0 ? "late" : "early") vs baseline" : "")")
        }
    }

    private func dependencyLines(start: Date) -> some View {
        let index = Dictionary(uniqueKeysWithValues: tasks.enumerated().map { ($1.id, $0) })
        let hot = critical
        return Canvas { ctx, _ in
            for (row, t) in tasks.enumerated() {
                for b in t.blockedBy {
                    guard let r0 = index[b], let src = tasks.first(where: { $0.id == b }),
                          let (sx, sw) = barFrame(src, start: start), let (tx, _) = barFrame(t, start: start) else { continue }
                    let p0 = CGPoint(x: sx + sw, y: 36 + CGFloat(r0) * rowHeight + rowHeight / 2)
                    let p1 = CGPoint(x: tx, y: 36 + CGFloat(row) * rowHeight + rowHeight / 2)
                    var path = Path()
                    path.move(to: p0)
                    path.addCurve(to: p1, control1: CGPoint(x: p0.x + 20, y: p0.y), control2: CGPoint(x: p1.x - 20, y: p1.y))
                    let onPath = hot.contains(t.id) && hot.contains(b)
                    ctx.stroke(path, with: .color(onPath ? .red : .orange), lineWidth: onPath ? 2.5 : 1.5)
                    var head = Path()
                    head.move(to: p1)
                    head.addLine(to: CGPoint(x: p1.x - 6, y: p1.y - 4))
                    head.addLine(to: CGPoint(x: p1.x - 6, y: p1.y + 4))
                    head.closeSubpath()
                    ctx.fill(head, with: .color(.orange))
                }
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Table

private enum TableSort: String { case name, status, priority, due, start, estimate, tracked }

struct TaskTableView: View {
    let tasks: [TaskItem]
    let fields: [FieldDef]
    @Environment(Store.self) private var store
    @State private var sort: TableSort = .name
    @State private var ascending = true

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    ForEach(sorted) { t in row(t) }
                } header: { header }
            }
            .padding(12)
        }
    }

    private var sorted: [TaskItem] {
        let s = tasks.sorted { a, b in
            switch sort {
            case .name: a.title.localizedCompare(b.title) == .orderedAscending
            case .status: (store.status(of: a)?.name ?? "") < (store.status(of: b)?.name ?? "")
            case .priority: a.priority < b.priority
            case .due: (a.dueDate ?? .distantFuture) < (b.dueDate ?? .distantFuture)
            case .start: (a.startDate ?? .distantFuture) < (b.startDate ?? .distantFuture)
            case .estimate: (a.estimateMinutes ?? 0) < (b.estimateMinutes ?? 0)
            case .tracked: store.tracked(a.id) < store.tracked(b.id)
            }
        }
        return ascending ? s : s.reversed()
    }

    private func headerCell(_ title: String, _ key: TableSort?, width: CGFloat) -> some View {
        Button {
            guard let key else { return }
            if sort == key { ascending.toggle() } else { sort = key; ascending = true }
        } label: {
            HStack(spacing: 3) {
                Text(title)
                if let key, sort == key { Image(systemName: ascending ? "chevron.up" : "chevron.down") }
            }
            .font(.caption.bold()).foregroundStyle(.secondary)
            .frame(width: width, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    private var header: some View {
        HStack(spacing: 8) {
            headerCell("Name", .name, width: 260)
            headerCell("Status", .status, width: 110)
            headerCell("Assignees", nil, width: 90)
            headerCell("Priority", .priority, width: 80)
            headerCell("Start", .start, width: 80)
            headerCell("Due", .due, width: 80)
            headerCell("Estimate", .estimate, width: 70)
            headerCell("Tracked", .tracked, width: 70)
            headerCell("Tags", nil, width: 140)
            ForEach(fields) { f in headerCell(f.name, nil, width: 130) }
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func row(_ t: TaskItem) -> some View {
        HStack(spacing: 8) {
            Text(t.title).lineLimit(1).frame(width: 260, alignment: .leading)
                .contentShape(Rectangle()).onTapGesture { store.openTaskId = t.id }
            StatusMenu(task: t).frame(width: 110, alignment: .leading)
            AssigneeMenu(task: t).frame(width: 90, alignment: .leading)
            PriorityMenu(task: t, showLabel: true).frame(width: 80, alignment: .leading)
            DatePopoverButton(date: t.startDate) { d in store.updateTask(t.id) { $0.startDate = d } }.frame(width: 80, alignment: .leading)
            DatePopoverButton(date: t.dueDate, overdue: store.isOverdue(t)) { d in store.updateTask(t.id) { $0.dueDate = d } }.frame(width: 80, alignment: .leading)
            Text(t.estimateMinutes.map { TimeInterval($0 * 60).hoursMinutes } ?? "—").frame(width: 70, alignment: .leading)
            Text(store.tracked(t.id) > 0 ? store.tracked(t.id).hoursMinutes : "—").frame(width: 70, alignment: .leading)
            HStack(spacing: 3) { ForEach(t.tags.prefix(3), id: \.self) { TagChip(tag: $0) } }.frame(width: 140, alignment: .leading)
            ForEach(fields) { f in
                CustomFieldEditor(taskId: t.id, field: f, compact: true).frame(width: 130, alignment: .leading)
            }
        }
        .font(.callout)
        .padding(.vertical, 5)
        .background(store.openTaskId == t.id ? Color.accentColor.opacity(0.1) : .clear)
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
        .contextMenu { TaskContextMenu(task: t) }
    }
}

// MARK: - Workload

struct WorkloadView: View {
    let tasks: [TaskItem]
    @Environment(Store.self) private var store
    @State private var capacityHours: Double = 8
    @State private var startDay = Date().startOfDay

    var body: some View {
        let days = (0..<14).map { startDay.adding(days: $0) }
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button { startDay = startDay.adding(days: -7) } label: { Image(systemName: "chevron.left") }
                Button("This week") { startDay = Date().startOfDay }
                Button { startDay = startDay.adding(days: 7) } label: { Image(systemName: "chevron.right") }
                Spacer()
                Text("Capacity per day:")
                Stepper("\(Int(capacityHours))h", value: $capacityHours, in: 1...16)
            }
            .padding(12)
            Divider()
            ScrollView([.horizontal, .vertical]) {
                Grid(alignment: .leading, horizontalSpacing: 2, verticalSpacing: 2) {
                    GridRow {
                        Text("Member").font(.caption.bold()).frame(width: 160, alignment: .leading)
                        ForEach(days, id: \.self) { d in
                            VStack {
                                Text(d.formatted(.dateTime.weekday(.abbreviated))).font(.caption2)
                                Text(d.formatted(.dateTime.day())).font(.caption.bold())
                            }
                            .frame(width: 64)
                        }
                    }
                    ForEach(store.data.members) { m in
                        GridRow {
                            HStack { AvatarView(member: m); Text(m.name).lineLimit(1) }.frame(width: 160, alignment: .leading)
                            ForEach(days, id: \.self) { d in cell(member: m, day: d) }
                        }
                    }
                }
                .padding(12)
            }
        }
    }

    /// Hours of estimated work landing on a day, spreading each estimate across its date range.
    private func load(member: Member, day: Date) -> (Double, [TaskItem]) {
        var hours = 0.0
        var list: [TaskItem] = []
        for t in tasks where t.assigneeIds.contains(member.id) && !store.isClosed(t) {
            guard let due = t.dueDate?.startOfDay else { continue }
            let start = (t.startDate ?? due).startOfDay
            guard day >= start && day <= due else { continue }
            let span = max(Double(Calendar.current.dateComponents([.day], from: start, to: due).day ?? 0) + 1, 1)
            hours += Double(t.estimateMinutes ?? 60) / 60 / span
            list.append(t)
        }
        return (hours, list)
    }

    private func cell(member: Member, day: Date) -> some View {
        let (h, ts) = load(member: member, day: day)
        let ratio = h / capacityHours
        let color: Color = ratio > 1 ? .red : (ratio > 0.7 ? .orange : (ratio > 0 ? .green : .clear))
        return VStack(spacing: 2) {
            Text(h > 0 ? String(format: "%.1fh", h) : "").font(.caption.bold())
            Text(ts.isEmpty ? "" : "\(ts.count) task\(ts.count == 1 ? "" : "s")").font(.system(size: 9))
        }
        .frame(width: 64, height: 46)
        .background(color.opacity(0.25), in: RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.primary.opacity(0.06)))
        .help(ts.map(\.title).joined(separator: "\n"))
    }
}

// MARK: - Mind map

struct MindMapView: View {
    let location: SidebarItem
    let tasks: [TaskItem]
    @Environment(Store.self) private var store

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            HStack(alignment: .center, spacing: 40) {
                node(store.title(for: location), color: .accentColor, bold: true)
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(tasks) { t in branch(t) }
                }
                .overlay(alignment: .leading) { Rectangle().fill(Color.accentColor.opacity(0.4)).frame(width: 2).offset(x: -20) }
            }
            .padding(40)
        }
    }

    private func branch(_ t: TaskItem) -> AnyView {
        let subs = store.subtasks(of: t.id)
        return AnyView(HStack(alignment: .center, spacing: 30) {
            Rectangle().fill(Color.accentColor.opacity(0.4)).frame(width: 20, height: 2).padding(.trailing, -30)
            node(t.title, color: Color(hex: store.status(of: t)?.colorHex ?? "#888"))
                .onTapGesture { store.openTaskId = t.id }
                .contextMenu { TaskContextMenu(task: t) }
            if !subs.isEmpty {
                VStack(alignment: .leading, spacing: 10) { ForEach(subs) { branch($0) } }
                    .overlay(alignment: .leading) { Rectangle().fill(Color.accentColor.opacity(0.3)).frame(width: 2).offset(x: -15) }
            }
        })
    }

    private func node(_ title: String, color: Color, bold: Bool = false) -> some View {
        Text(title)
            .font(bold ? .headline : .callout)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(color, lineWidth: 1.5))
    }
}

// MARK: - Form

struct TaskFormView: View {
    let defaultList: UUID?
    @Environment(Store.self) private var store
    @State private var title = ""
    @State private var details = ""
    @State private var priority: Priority = .normal
    @State private var hasDue = false
    @State private var due = Date()
    @State private var email = ""
    @State private var listId: UUID?
    @State private var submitted = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Request Form").font(.largeTitle.bold())
                Text("Submissions become tasks in the selected list.").foregroundStyle(.secondary)
                Form {
                    Picker("Submit to list", selection: $listId) {
                        ForEach(store.data.lists.filter { !$0.archived }) { Text($0.name).tag(Optional($0.id)) }
                    }
                    TextField("Request title *", text: $title)
                    TextField("Your email", text: $email)
                    Picker("Priority", selection: $priority) { ForEach(Priority.allCases) { Text($0.label).tag($0) } }
                    Toggle("Needed by", isOn: $hasDue)
                    if hasDue { DatePicker("Date", selection: $due, displayedComponents: .date) }
                    TextField("Details", text: $details, axis: .vertical).lineLimit(4...10)
                }
                .formStyle(.grouped)
                HStack {
                    Spacer()
                    if submitted { Label("Submitted!", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                    Button("Submit", action: submit).buttonStyle(.borderedProminent).disabled(title.isEmpty || listId == nil)
                }
            }
            .padding(30)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .onAppear { listId = listId ?? defaultList }
    }

    private func submit() {
        guard let l = listId else { return }
        let t = store.addTask(title, list: l)
        store.updateTask(t.id) { x in
            x.details = details + (email.isEmpty ? "" : "\n\nSubmitted by: \(email)")
            x.priority = priority
            x.dueDate = hasDue ? due : nil
            x.tags.append("form")
        }
        title = ""; details = ""; email = ""; hasDue = false
        submitted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { submitted = false }
    }
}
