import SwiftUI
import AppKit
import Carbon
import Charts

// MARK: - Trash & archive

struct TrashView: View {
    let showTrash: Bool
    @Environment(Store.self) private var store

    var body: some View {
        let items = store.data.tasks.filter { showTrash ? $0.trashedAt != nil : ($0.archived && $0.trashedAt == nil) }
            .sorted { ($0.trashedAt ?? $0.updated) > ($1.trashedAt ?? $1.updated) }
        VStack(spacing: 0) {
            HStack {
                Text(showTrash ? "Deleted tasks stay here until you empty the trash." : "Archived tasks are hidden from views but kept.")
                    .foregroundStyle(.secondary)
                Spacer()
                if showTrash && !items.isEmpty {
                    Button("Empty Trash", role: .destructive) { items.forEach { store.deleteTask($0.id) } }
                }
            }
            .padding(12)
            Divider()
            if items.isEmpty {
                EmptyState(icon: showTrash ? "trash" : "archivebox", title: showTrash ? "Trash is empty" : "Nothing archived")
            } else {
                List(items) { t in
                    HStack {
                        StatusPill(status: store.status(of: t), compact: true)
                        VStack(alignment: .leading) {
                            Text(t.title)
                            Text(store.locationName(t)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let d = t.trashedAt { Text("Deleted \(d.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary) }
                        Button("Restore") { store.restoreTask(t.id) }
                        if showTrash {
                            Button(role: .destructive) { store.deleteTask(t.id) } label: { Image(systemName: "trash.slash") }
                                .buttonStyle(.borderless).help("Delete forever")
                        }
                    }
                }
            }
        }
        .navigationTitle(showTrash ? "Trash" : "Archive")
    }
}

// MARK: - Sprints

struct SprintBar: View {
    let list: TaskList
    @Environment(Store.self) private var store
    @State private var completing = false

    var body: some View {
        let tasks = store.data.tasks.filter { $0.listId == list.id && !$0.archived }
        let total = tasks.reduce(0) { $0 + ($1.points ?? 1) }
        let done = tasks.filter(store.isClosed).reduce(0) { $0 + ($1.points ?? 1) }
        let start = list.sprintStart!.startOfDay, end = list.sprintEnd!.startOfDay
        let daysLeft = max(Calendar.current.dateComponents([.day], from: Date().startOfDay, to: end).day ?? 0, 0)
        HStack(alignment: .center, spacing: 20) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Sprint", systemImage: "flag.checkered").font(.headline)
                Text("\(start.formatted(.dateTime.month().day())) – \(end.formatted(.dateTime.month().day()))").foregroundStyle(.secondary)
                Text(Date() > end ? "Ended" : "\(daysLeft) days left").font(.caption).foregroundStyle(Date() > end ? .red : .secondary)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("\(done) / \(total) points").font(.headline)
                ProgressView(value: Double(done), total: Double(max(total, 1))).frame(width: 160)
            }
            burndown(tasks: tasks, total: total, start: start, end: end)
                .frame(width: 260, height: 70)
            Spacer()
            Button("Complete sprint…") { completing = true }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Color.accentColor.opacity(0.06))
        .sheet(isPresented: $completing) { CompleteSprintSheet(list: list) }
    }

    /// Ideal line vs. points remaining at the end of each day so far.
    private func burndown(tasks: [TaskItem], total: Int, start: Date, end: Date) -> some View {
        let days = max(Calendar.current.dateComponents([.day], from: start, to: end).day ?? 1, 1)
        let actual: [(Date, Int)] = (0...days).compactMap { i in
            let d = start.adding(days: i)
            guard d <= Date() else { return nil }
            let closed = tasks.filter { ($0.completedAt ?? .distantFuture) < d.adding(days: 1) }.reduce(0) { $0 + ($1.points ?? 1) }
            return (d, total - closed)
        }
        return Chart {
            LineMark(x: .value("Day", start), y: .value("Ideal", total), series: .value("s", "Ideal")).foregroundStyle(.gray.opacity(0.5))
            LineMark(x: .value("Day", end), y: .value("Ideal", 0), series: .value("s", "Ideal")).foregroundStyle(.gray.opacity(0.5))
            ForEach(actual, id: \.0) { p in
                LineMark(x: .value("Day", p.0), y: .value("Remaining", p.1), series: .value("s", "Actual")).foregroundStyle(Color.accentColor)
            }
        }
        .chartXAxis(.hidden)
        .chartLegend(.hidden)
    }
}

struct CompleteSprintSheet: View {
    let list: TaskList
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var target: UUID?

    var body: some View {
        let open = store.data.tasks.filter { $0.listId == list.id && !$0.archived && !store.isClosed($0) }
        VStack(alignment: .leading, spacing: 14) {
            Text("Complete \(list.name)").font(.title2.bold())
            Text("\(open.count) unfinished task(s) will move to:")
            Picker("", selection: $target) {
                Text("A new next sprint").tag(UUID?.none)
                ForEach(store.data.lists.filter { $0.id != list.id && !$0.archived && $0.spaceId == list.spaceId }) { Text($0.name).tag(Optional($0.id)) }
            }
            .labelsHidden()
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Complete sprint") {
                    let dest = target ?? store.nextSprint(after: list.id)
                    for t in open { store.updateTask(t.id) { $0.listId = dest } }
                    if let i = store.data.lists.firstIndex(where: { $0.id == list.id }) { store.data.lists[i].archived = true }
                    store.selection = .list(dest)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

struct SprintSettingsSheet: View {
    let listId: UUID
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var start = Date().startOfDay
    @State private var end = Date().startOfDay.adding(days: 13)
    @State private var enabled = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sprint settings").font(.title2.bold())
            Toggle("This list is a sprint", isOn: $enabled)
            DatePicker("Start", selection: $start, displayedComponents: .date).disabled(!enabled)
            DatePicker("End", selection: $end, in: start..., displayedComponents: .date).disabled(!enabled)
            Text("Task points come from each task's Sprint points field (default 1).").font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    if let i = store.data.lists.firstIndex(where: { $0.id == listId }) {
                        store.data.lists[i].sprintStart = enabled ? start : nil
                        store.data.lists[i].sprintEnd = enabled ? end : nil
                    }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 360)
        .onAppear {
            if let l = store.list(listId), let s = l.sprintStart, let e = l.sprintEnd { start = s; end = e }
        }
    }
}

// MARK: - Bulk actions

struct BulkActionBar: View {
    @Binding var selection: Set<UUID>
    @Environment(Store.self) private var store

    var body: some View {
        let tasks = selection.compactMap { store.task($0) }
        let statusNames = Array(NSOrderedSet(array: tasks.flatMap { store.statuses(for: $0).map(\.name) })) as? [String] ?? []
        HStack(spacing: 14) {
            Text("\(selection.count) selected").bold()
            Menu("Status") {
                ForEach(statusNames, id: \.self) { n in
                    Button(n) { each { t in store.statuses(for: t).first { $0.name == n }.map { s in store.updateTask(t.id) { $0.statusId = s.id } } } }
                }
            }
            Menu("Priority") {
                ForEach(Priority.allCases.reversed()) { p in Button(p.label) { each { t in store.updateTask(t.id) { $0.priority = p } } } }
            }
            Menu("Assign") {
                ForEach(store.data.members) { m in
                    Button(m.name) { each { t in store.updateTask(t.id) { if !$0.assigneeIds.contains(m.id) { $0.assigneeIds.append(m.id) } } } }
                }
                Divider()
                Button("Unassign all") { each { t in store.updateTask(t.id) { $0.assigneeIds = [] } } }
            }
            Menu("Due date") {
                Button("Today") { setDue(Date().startOfDay) }
                Button("Tomorrow") { setDue(Date().startOfDay.adding(days: 1)) }
                Button("Next week") { setDue(Date().startOfDay.adding(days: 7)) }
                Button("Clear") { setDue(nil) }
            }
            Menu("Move to") {
                ForEach(store.data.lists.filter { !$0.archived }) { l in
                    Button(l.name) { each { t in store.updateTask(t.id) { $0.listId = l.id } } }
                }
            }
            Button("Archive") { each { t in store.updateTask(t.id) { $0.archived = true } }; selection = [] }
            Button("Delete", role: .destructive) { selection.forEach(store.trashTask); selection = [] }
            Spacer()
            Button { selection = [] } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .mkCard(radius: 12, interactive: true)
        .shadow(radius: 8, y: 2)
        .padding(16)
    }

    private func each(_ f: (TaskItem) -> Void) { selection.compactMap { store.task($0) }.forEach(f) }
    private func setDue(_ d: Date?) { each { t in store.updateTask(t.id) { $0.dueDate = d } } }
}

// MARK: - Global quick add (⌃⌥Space) and menu bar

enum GlobalHotKey {
    static var action: (() -> Void)?
    private static var ref: EventHotKeyRef?

    /// Registers Control-Option-Space system-wide. Carbon hot keys need no Accessibility permission.
    static func register() {
        guard ref == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { GlobalHotKey.action?() }
            return noErr
        }, 1, &spec, nil, nil)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x4D4B5044), id: 1),
                            GetApplicationEventTarget(), 0, &ref)
    }
}

final class QuickAddPanel {
    private static var panel: NSPanel?

    static func show(store: Store) {
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 150), styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
                            backing: .buffered, defer: false)
            p.titleVisibility = .hidden
            p.titlebarAppearsTransparent = true
            p.isFloatingPanel = true
            p.level = .floating
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.isReleasedWhenClosed = false
            panel = p
        }
        panel?.contentView = NSHostingView(rootView: QuickAddView(close: { panel?.orderOut(nil) }).environment(store))
        panel?.center()
        NSApp.activate(ignoringOtherApps: true)
        panel?.makeKeyAndOrderFront(nil)
    }
}

struct QuickAddView: View {
    let close: () -> Void
    @Environment(Store.self) private var store
    @State private var title = ""
    @State private var listId: UUID?
    @State private var due: Date?
    @State private var assignToMe = true
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "plus.circle.fill").foregroundStyle(Color.accentColor).font(.title2)
                TextField("New task — press Return to save, Esc to close", text: $title)
                    .textFieldStyle(.plain).font(.title3).focused($focused)
                    .onSubmit(save)
                    .onExitCommand(perform: close)
            }
            HStack {
                Picker("", selection: $listId) {
                    ForEach(store.data.lists.filter { !$0.archived }) { l in
                        Text("\(store.space(l.spaceId)?.name ?? "") › \(l.name)").tag(Optional(l.id))
                    }
                }
                .labelsHidden().frame(width: 240)
                DatePopoverButton(date: due) { due = $0 }
                Toggle("Assign to me", isOn: $assignToMe).toggleStyle(.checkbox)
                Spacer()
                Button("Save", action: save).keyboardShortcut(.defaultAction).disabled(title.isEmpty)
            }
        }
        .padding(18)
        .onAppear {
            listId = listId ?? store.data.favorites.compactMap { store.list($0) }.first?.id ?? store.data.lists.first?.id
            focused = true
        }
    }

    private func save() {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, let l = listId else { return }
        let task = store.addTask(t, list: l, due: due)
        if assignToMe { store.updateTask(task.id) { $0.assigneeIds = [store.data.currentUserId] } }
        title = ""
        due = nil
        close()
    }
}

struct MenuBarContent: View {
    @Environment(Store.self) private var store

    var body: some View {
        let mine = store.data.tasks.filter {
            !$0.archived && $0.assigneeIds.contains(store.data.currentUserId) && !store.isClosed($0)
                && ($0.dueDate ?? .distantFuture) < Date().startOfDay.adding(days: 1)
        }
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("MK Prod").font(.headline)
                Spacer()
                CloudStatusBadge()
            }
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                if let e = store.runningEntry {
                    HStack {
                        Image(systemName: "record.circle").foregroundStyle(.red)
                        Text(store.task(e.taskId)?.title ?? "Timer").lineLimit(1)
                        Spacer()
                        Text(e.duration.hms).monospacedDigit()
                        Button("Stop") { store.stopTimer() }
                    }
                } else {
                    Button { store.startTimer(task: nil) } label: { Label("Start timer", systemImage: "play.fill") }
                }
            }
            Divider()
            Text("Due today & overdue").font(.caption.bold()).foregroundStyle(.secondary)
            if mine.isEmpty { Text("All clear 🎉").foregroundStyle(.secondary) }
            ForEach(mine.prefix(8)) { t in
                HStack {
                    Button {
                        if let done = store.statuses(for: t).first(where: { $0.kind == .done }) { store.updateTask(t.id) { $0.statusId = done.id } }
                    } label: { Image(systemName: "circle") }.buttonStyle(.plain)
                    Text(t.title).lineLimit(1)
                    Spacer()
                    Button { store.startTimer(task: t.id) } label: { Image(systemName: "play.circle") }.buttonStyle(.plain).help("Track time")
                }
            }
            Divider()
            HStack {
                Button("Quick add (⌃⌥Space)") { QuickAddPanel.show(store: store) }
                Spacer()
                Button("Open MK Prod") {
                    NSApp.activate(ignoringOtherApps: true)
                    NSApp.windows.first { $0.canBecomeMain }?.makeKeyAndOrderFront(nil)
                }
            }
        }
        .padding(14)
        .frame(width: 320)
    }
}

// MARK: - ClickUp CSV import

/// Imports a ClickUp "Export to CSV" file: spaces, folders, lists, statuses, assignees,
/// tags, dates, estimates and subtasks are recreated by name.
enum ClickUpImporter {
    static func parseCSV(_ text: String) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var quoted = false
        var chars = Array(text.unicodeScalars)
        if chars.first == "\u{FEFF}" { chars.removeFirst() }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if quoted {
                if c == "\"" {
                    if i + 1 < chars.count && chars[i + 1] == "\"" { field.unicodeScalars.append("\""); i += 1 } else { quoted = false }
                } else { field.unicodeScalars.append(c) }
            } else if c == "\"" {
                quoted = true
            } else if c == "," {
                row.append(field); field = ""
            } else if c == "\n" || c == "\r" {
                if c == "\r" && i + 1 < chars.count && chars[i + 1] == "\n" { i += 1 }
                row.append(field); field = ""
                if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
                row = []
            } else { field.unicodeScalars.append(c) }
            i += 1
        }
        if !field.isEmpty || !row.isEmpty { row.append(field); rows.append(row) }
        return rows
    }

    private static func list(_ s: String) -> [String] {
        s.trimmingCharacters(in: CharacterSet(charactersIn: "[] ")).split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private static func date(_ s: String) -> Date? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        if let ms = Double(t) { return Date(timeIntervalSince1970: ms > 1e11 ? ms / 1000 : ms) }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        // "Wednesday, October 21st 2026" → "Wednesday, October 21 2026"
        let plain = t.replacingOccurrences(of: #"(\d)(st|nd|rd|th)\b"#, with: "$1", options: .regularExpression)
        for fmt in ["EEEE, MMMM d yyyy", "EEEE, MMMM d yyyy, h:mm a", "MM/dd/yyyy, h:mm:ss a", "MM/dd/yyyy", "yyyy-MM-dd'T'HH:mm:ss.SSSZ", "yyyy-MM-dd", "MMM d, yyyy"] {
            f.dateFormat = fmt
            if let d = f.date(from: plain) { return d }
        }
        return nil
    }

    @discardableResult
    static func importFile(_ url: URL, into store: Store) throws -> Int {
        let text = try String(contentsOf: url, encoding: .utf8)
        let rows = parseCSV(text)
        guard let header = rows.first else { return 0 }
        let col = Dictionary(header.enumerated().map { ($1.trimmingCharacters(in: .whitespaces).lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
        func v(_ r: [String], _ names: String...) -> String {
            for n in names { if let i = col[n], i < r.count { return r[i] } }
            return ""
        }
        var d = store.data
        var byClickUpId: [String: UUID] = [:]
        var parentLinks: [(UUID, String)] = []
        var count = 0
        for r in rows.dropFirst() {
            let title = v(r, "task name", "name")
            guard !title.isEmpty else { continue }
            let spaceName = v(r, "space name").isEmpty ? "Imported from ClickUp" : v(r, "space name")
            let listName = v(r, "list name").isEmpty ? "Imported" : v(r, "list name")
            let folderName = v(r, "folder name")

            var spaceIdx = d.spaces.firstIndex { $0.name == spaceName }
            if spaceIdx == nil { d.spaces.append(Space(name: spaceName, colorHex: paletteHexes.randomElement()!)); spaceIdx = d.spaces.count - 1 }
            let space = d.spaces[spaceIdx!]
            var folderId: UUID?
            if !folderName.isEmpty && folderName.lowercased() != "hidden" {
                if let f = d.folders.first(where: { $0.spaceId == space.id && $0.name == folderName }) { folderId = f.id } else {
                    let f = Folder(spaceId: space.id, name: folderName); d.folders.append(f); folderId = f.id
                }
            }
            let listId: UUID
            if let l = d.lists.first(where: { $0.spaceId == space.id && $0.folderId == folderId && $0.name == listName }) { listId = l.id } else {
                let l = TaskList(spaceId: space.id, folderId: folderId, name: listName); d.lists.append(l); listId = l.id
            }

            let statusName = v(r, "status").isEmpty ? "to do" : v(r, "status")
            var status = d.spaces[spaceIdx!].statuses.first { $0.name.caseInsensitiveCompare(statusName) == .orderedSame }
            if status == nil {
                let closed = ["complete", "completed", "done", "closed"].contains(statusName.lowercased())
                let s = StatusDef(name: statusName.capitalized, colorHex: closed ? "#3DBE7A" : paletteHexes.randomElement()!, kind: closed ? .done : .active)
                let at = closed ? d.spaces[spaceIdx!].statuses.count : (d.spaces[spaceIdx!].statuses.firstIndex { $0.kind == .done } ?? d.spaces[spaceIdx!].statuses.count)
                d.spaces[spaceIdx!].statuses.insert(s, at: at)
                status = s
            }

            var t = TaskItem(listId: listId, title: title, statusId: status!.id)
            t.details = v(r, "task content", "description")
            t.dueDate = date(v(r, "due date")) ?? date(v(r, "due date text"))
            t.startDate = date(v(r, "start date")) ?? date(v(r, "start date text"))
            t.created = date(v(r, "date created")) ?? Date()
            t.tags = list(v(r, "tags")).map { $0.lowercased() }
            switch v(r, "priority").lowercased() {
            case "urgent", "1": t.priority = .urgent
            case "high", "2": t.priority = .high
            case "normal", "3": t.priority = .normal
            case "low", "4": t.priority = .low
            default: break
            }
            if let ms = Double(v(r, "time estimated")), ms > 0 { t.estimateMinutes = Int(ms / 60000) }
            for who in list(v(r, "assignees")) {
                if let m = d.members.first(where: { $0.name.caseInsensitiveCompare(who) == .orderedSame || $0.email.caseInsensitiveCompare(who) == .orderedSame }) {
                    t.assigneeIds.append(m.id)
                } else {
                    let m = Member(name: who, email: who.contains("@") ? who : "", colorHex: paletteHexes.randomElement()!)
                    d.members.append(m)
                    t.assigneeIds.append(m.id)
                }
            }
            if d.spaces[spaceIdx!].statuses.first(where: { $0.id == t.statusId })?.kind == .done { t.completedAt = t.created }
            t.activity = [ActivityItem(text: "Imported from ClickUp")]
            t.order = Double(d.tasks.count)
            let cuId = v(r, "task id")
            if !cuId.isEmpty { byClickUpId[cuId] = t.id }
            let parent = v(r, "parent id")
            if !parent.isEmpty && parent.lowercased() != "null" { parentLinks.append((t.id, parent)) }
            d.tasks.append(t)
            count += 1
        }
        for (child, parent) in parentLinks {
            if let p = byClickUpId[parent], let i = d.tasks.firstIndex(where: { $0.id == child }) { d.tasks[i].parentId = p }
        }
        store.data = d
        return count
    }
}
