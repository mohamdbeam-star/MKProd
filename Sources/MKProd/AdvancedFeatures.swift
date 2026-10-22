import SwiftUI
import AppKit
import Charts

// Computed features shared by the task views: formulas, progress, project health, resource capacity
// and the Gantt critical path. Mirrors web/src/features.ts, so both clients give the same answers.

// MARK: - Formulas

enum FormulaValue: Equatable {
    case number(Double)
    case text(String)

    var number: Double {
        switch self {
        case .number(let n): n
        case .text(let s): Double(s) ?? 0
        }
    }
    var display: String {
        switch self {
        case .number(let n): formatNumber(n)
        case .text(let s): s
        }
    }
    var isTruthy: Bool {
        switch self {
        case .number(let n): n != 0
        case .text(let s): !s.isEmpty && (Double(s) ?? 1) != 0
        }
    }
}

func formatNumber(_ n: Double) -> String {
    if n.rounded() == n, abs(n) < 1e15 { return String(Int(n)) }
    var s = String(format: "%.2f", n)
    while s.hasSuffix("0") { s.removeLast() }
    if s.hasSuffix(".") { s.removeLast() }
    return s
}

/// Spreadsheet-style formulas: numbers, "text", {Field name}, + - * / %, comparisons (= != < > <= >=),
/// & to join text, and IF, ROUND, MIN, MAX, SUM, AVG, ABS, TODAY. Errors come back as "#…" text.
struct FormulaEvaluator {
    private struct Failure: Error { let code: String }
    private let chars: [Character]
    private var i = 0
    private let scope: [String: () -> FormulaValue]

    static func evaluate(_ source: String, scope: [String: () -> FormulaValue]) -> FormulaValue {
        if source.trimmingCharacters(in: .whitespaces).isEmpty { return .text("") }
        var e = FormulaEvaluator(chars: Array(source), scope: scope)
        do {
            let v = try e.comparison()
            e.skipSpace()
            if e.i < e.chars.count { throw Failure(code: "#SYNTAX") }
            if case .number(let n) = v, !n.isFinite { return .text("#NUM") }
            return v
        } catch let f as Failure {
            return .text(f.code)
        } catch {
            return .text("#ERROR")
        }
    }

    private init(chars: [Character], scope: [String: () -> FormulaValue]) {
        self.chars = chars
        self.scope = scope
    }

    private mutating func skipSpace() { while i < chars.count, chars[i].isWhitespace { i += 1 } }
    private mutating func eat(_ s: String) -> Bool {
        skipSpace()
        let c = Array(s)
        guard i + c.count <= chars.count, Array(chars[i..<(i + c.count)]) == c else { return false }
        i += c.count
        return true
    }

    private mutating func primary() throws -> FormulaValue {
        skipSpace()
        guard i < chars.count else { throw Failure(code: "#SYNTAX") }
        if eat("(") {
            let v = try comparison()
            guard eat(")") else { throw Failure(code: "#PAREN") }
            return v
        }
        if eat("-") { return .number(-(try primary()).number) }
        if chars[i] == "\"" {
            guard let end = chars[(i + 1)...].firstIndex(of: "\"") else { throw Failure(code: "#TEXT") }
            let s = String(chars[(i + 1)..<end]); i = end + 1
            return .text(s)
        }
        if chars[i] == "{" {
            guard let end = chars[i...].firstIndex(of: "}") else { throw Failure(code: "#REF") }
            let name = String(chars[(i + 1)..<end]).trimmingCharacters(in: .whitespaces).lowercased(); i = end + 1
            guard let get = scope[name] else { throw Failure(code: "#REF \(name)") }
            return get()
        }
        if chars[i].isNumber {
            var j = i
            while j < chars.count, chars[j].isNumber || chars[j] == "." { j += 1 }
            let n = Double(String(chars[i..<j])) ?? 0; i = j
            return .number(n)
        }
        if chars[i].isLetter {
            var j = i
            while j < chars.count, chars[j].isLetter { j += 1 }
            let name = String(chars[i..<j]).uppercased(); i = j
            guard eat("(") else { throw Failure(code: "#NAME") }
            var args: [FormulaValue] = []
            if !eat(")") {
                repeat { args.append(try comparison()) } while eat(",")
                guard eat(")") else { throw Failure(code: "#PAREN") }
            }
            let ns = args.map(\.number)
            switch name {
            case "IF": return (args.first?.isTruthy ?? false) ? (args.count > 1 ? args[1] : .text("")) : (args.count > 2 ? args[2] : .text(""))
            case "ROUND":
                let p = pow(10, ns.count > 1 ? ns[1] : 0)
                return .number(((ns.first ?? 0) * p).rounded() / p)
            case "MIN": return .number(ns.min() ?? 0)
            case "MAX": return .number(ns.max() ?? 0)
            case "SUM": return .number(ns.reduce(0, +))
            case "AVG": return .number(ns.isEmpty ? 0 : ns.reduce(0, +) / Double(ns.count))
            case "ABS": return .number(abs(ns.first ?? 0))
            case "TODAY": return .number(dayNumber(Date()))
            default: throw Failure(code: "#NAME")
            }
        }
        throw Failure(code: "#SYNTAX")
    }

    private mutating func term() throws -> FormulaValue {
        var v = try primary()
        while true {
            if eat("*") { v = .number(v.number * (try primary()).number) }
            else if eat("/") {
                let d = try primary().number
                guard d != 0 else { throw Failure(code: "#DIV/0") }
                v = .number(v.number / d)
            } else if eat("%") {
                let d = try primary().number
                guard d != 0 else { throw Failure(code: "#DIV/0") }
                v = .number(v.number.truncatingRemainder(dividingBy: d))
            } else { return v }
        }
    }

    private mutating func sum() throws -> FormulaValue {
        var v = try term()
        while true {
            if eat("+") { v = .number(v.number + (try term()).number) }
            else if eat("-") { v = .number(v.number - (try term()).number) }
            else if eat("&") { v = .text(v.display + (try term()).display) }
            else { return v }
        }
    }

    private mutating func comparison() throws -> FormulaValue {
        let a = try sum()
        for op in ["<=", ">=", "!=", "=", "<", ">"] where eat(op) {
            let b = try sum()
            let r: Bool
            if case .number(let x) = a, case .number(let y) = b {
                r = op == "=" ? x == y : op == "!=" ? x != y : op == "<" ? x < y : op == ">" ? x > y : op == "<=" ? x <= y : x >= y
            } else {
                let x = a.display, y = b.display
                r = op == "=" ? x == y : op == "!=" ? x != y : op == "<" ? x < y : op == ">" ? x > y : op == "<=" ? x <= y : x >= y
            }
            return .number(r ? 1 : 0)
        }
        return a
    }
}

/// Whole days since 1970 at local midnight: dates in formulas subtract to a number of days.
func dayNumber(_ d: Date) -> Double {
    let local = d.startOfDay
    let offset = TimeInterval(TimeZone.current.secondsFromGMT(for: local))
    return ((local.timeIntervalSince1970 + offset) / 86400).rounded()
}

extension Store {
    /// Share of the work done, 0…100: subtasks and checklist items together.
    func progress(of t: TaskItem) -> Int {
        let subs = subtasks(of: t.id)
        let items = t.checklists.flatMap(\.items)
        let total = subs.count + items.count
        guard total > 0 else { return isClosed(t) ? 100 : 0 }
        let done = subs.filter(isClosed).count + items.filter(\.done).count
        return Int((Double(done) / Double(total) * 100).rounded())
    }

    func formulaScope(_ t: TaskItem, depth: Int = 0) -> [String: () -> FormulaValue] {
        var scope: [String: () -> FormulaValue] = [
            "estimate hours": { .number(Double(t.estimateMinutes ?? 0) / 60) },
            "points": { .number(Double(t.points ?? 0)) },
            "progress": { .number(Double(self.progress(of: t))) },
            "tracked hours": { .number(self.tracked(t.id) / 3600) },
            "priority": { .number(Double(t.priority.rawValue)) },
            "subtasks": { .number(Double(self.subtasks(of: t.id).count)) },
            "start": { .number(t.startDate.map(dayNumber) ?? 0) },
            "due": { .number(t.dueDate.map(dayNumber) ?? 0) },
            "days left": { .number(t.dueDate.map { dayNumber($0) - dayNumber(Date()) } ?? 0) },
            "title": { .text(t.title) },
        ]
        for f in space(ofTask: t)?.fields ?? [] {
            let key = f.name.trimmingCharacters(in: .whitespaces).lowercased()
            scope[key] = {
                let v = t.customValues[f.id] ?? ""
                switch f.type {
                case .formula: return depth > 5 ? .number(0) : FormulaEvaluator.evaluate(f.options.first ?? "", scope: self.formulaScope(t, depth: depth + 1))
                case .progress: return .number(Double(self.progress(of: t)))
                case .number, .money, .rating: return .number(Double(v) ?? 0)
                case .checkbox: return .number(v == "true" ? 1 : 0)
                case .date: return .number(ISO8601DateFormatter().date(from: v).map(dayNumber) ?? 0)
                default: return .text(v)
                }
            }
        }
        return scope
    }

    func formulaValue(_ t: TaskItem, _ f: FieldDef) -> FormulaValue {
        FormulaEvaluator.evaluate(f.options.first ?? "", scope: formulaScope(t))
    }

    /// The text a field shows in tables and charts, computed for formula and progress fields.
    func fieldDisplay(_ t: TaskItem, _ f: FieldDef) -> String {
        let v = t.customValues[f.id] ?? ""
        switch f.type {
        case .formula: return formulaValue(t, f).display
        case .progress: return "\(progress(of: t))%"
        case .checkbox: return v == "true" ? "✓" : ""
        case .rating: return String(repeating: "★", count: Int(v) ?? 0)
        case .people: return v.split(separator: ",").compactMap { UUID(uuidString: String($0)).flatMap(member)?.name }.joined(separator: ", ")
        case .date: return ISO8601DateFormatter().date(from: v)?.formatted(date: .abbreviated, time: .omitted) ?? ""
        default: return v
        }
    }
}

// MARK: - Portfolio

enum ProjectHealth: String, CaseIterable {
    case onTrack = "On track", atRisk = "At risk", offTrack = "Off track", done = "Done", notStarted = "Not started"
    var color: Color {
        switch self {
        case .done: Color(hex: "#3DBE7A")
        case .onTrack: Color(hex: "#5B8DEF")
        case .atRisk: Color(hex: "#F0A33A")
        case .offTrack: Color(hex: "#E5484D")
        case .notStarted: Color(hex: "#87909E")
        }
    }
}

struct ProjectSummary: Identifiable {
    var id: UUID { listId }
    let listId: UUID
    let name: String
    let spaceId: UUID
    let total: Int
    let done: Int
    let overdue: Int
    let progress: Int
    let expected: Int
    let start: Date?
    let end: Date?
    let health: ProjectHealth
    let owners: [UUID]
}

extension Store {
    /// One row per list: progress against the time elapsed between its first start and last due date.
    /// 15+ points behind or anything overdue is "at risk"; 30+ points behind or past the end is "off track".
    func projectSummary(_ list: TaskList) -> ProjectSummary {
        let tasks = data.tasks.filter { $0.listId == list.id && !$0.archived && $0.parentId == nil }
        let done = tasks.filter(isClosed).count
        let today = Date().startOfDay
        let overdue = tasks.filter { ($0.dueDate.map { $0 < today } ?? false) && !isClosed($0) }.count
        let start = list.sprintStart ?? tasks.compactMap { $0.startDate ?? $0.dueDate }.min()
        let end = list.sprintEnd ?? tasks.compactMap { $0.dueDate ?? $0.startDate }.max()
        let progress = tasks.isEmpty ? 0 : Int((Double(done) / Double(tasks.count) * 100).rounded())
        var expected = 0
        if let start, let end {
            let span = max(end.timeIntervalSince(start), 86400)
            expected = max(0, min(100, Int((today.timeIntervalSince(start) / span * 100).rounded())))
        }
        let gap = expected - progress
        let health: ProjectHealth
        if !tasks.isEmpty && done == tasks.count { health = .done }
        else if tasks.isEmpty || (progress == 0 && expected == 0) { health = .notStarted }
        else if (end.map { $0 < today } ?? false) || gap >= 30 { health = .offTrack }
        else if gap >= 15 || overdue > 0 { health = .atRisk }
        else { health = .onTrack }
        var counts: [UUID: Int] = [:]
        for t in tasks { for a in t.assigneeIds { counts[a, default: 0] += 1 } }
        let owners = counts.sorted { $0.value > $1.value }.prefix(3).map(\.key)
        return ProjectSummary(listId: list.id, name: list.name, spaceId: list.spaceId, total: tasks.count, done: done, overdue: overdue,
                              progress: progress, expected: expected, start: start, end: end, health: health, owners: owners)
    }
}

// MARK: - Resource management

extension Store {
    func resource(for memberId: UUID) -> Resource {
        data.resources.first { $0.id == memberId } ?? Resource(id: memberId)
    }

    func setResource(_ r: Resource) {
        if let i = data.resources.firstIndex(where: { $0.id == r.id }) { data.resources[i] = r } else { data.resources.append(r) }
    }

    func isWorkingDay(_ r: Resource, _ day: Date) -> Bool {
        let weekday = Calendar.current.component(.weekday, from: day) - 1
        guard r.workDays.contains(weekday) else { return false }
        let d = day.startOfDay
        return !r.timeOff.contains { d >= $0.start.startOfDay && d <= $0.end.startOfDay }
    }

    /// Hours of open, estimated work on a day: each estimate (1h if none) spread over the working days
    /// from start to due, split between assignees.
    func allocatedHours(_ r: Resource, on day: Date, tasks: [TaskItem]) -> (hours: Double, tasks: [TaskItem]) {
        guard isWorkingDay(r, day) else { return (0, []) }
        let d = day.startOfDay
        var hours = 0.0
        var hit: [TaskItem] = []
        for t in tasks where t.assigneeIds.contains(r.id) && !isClosed(t) {
            guard let due = t.dueDate?.startOfDay else { continue }
            let s = (t.startDate ?? due).startOfDay
            guard d >= s && d <= due else { continue }
            var working = 0
            var x = s
            while x <= due { if isWorkingDay(r, x) { working += 1 }; x = x.adding(days: 1) }
            hours += Double(t.estimateMinutes ?? 60) / 60 / Double(max(working, 1)) / Double(max(t.assigneeIds.count, 1))
            hit.append(t)
        }
        return (hours, hit)
    }
}

// MARK: - Critical path

/// Longest chain of dependent tasks (by `blockedBy`), measured in days; a delay on any of them
/// delays the end of the whole chain.
func criticalPath(_ tasks: [TaskItem]) -> Set<UUID> {
    let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    func length(_ t: TaskItem) -> Int {
        guard let s = t.startDate ?? t.dueDate, let e = t.dueDate ?? t.startDate else { return 1 }
        return max(1, (Calendar.current.dateComponents([.day], from: s.startOfDay, to: e.startOfDay).day ?? 0) + 1)
    }
    var memo: [UUID: (total: Int, prev: UUID?)] = [:]
    var visiting: Set<UUID> = []
    func best(_ t: TaskItem) -> (total: Int, prev: UUID?) {
        if let m = memo[t.id] { return m }
        if visiting.contains(t.id) { return (0, nil) }
        visiting.insert(t.id)
        var r: (total: Int, prev: UUID?) = (length(t), nil)
        for p in t.blockedBy {
            guard let pt = byId[p] else { continue }
            let b = best(pt)
            if b.total + length(t) > r.total { r = (b.total + length(t), p) }
        }
        visiting.remove(t.id)
        memo[t.id] = r
        return r
    }
    var end: UUID?
    var top = 0
    for t in tasks {
        let b = best(t)
        if b.prev != nil && b.total > top { top = b.total; end = t.id }
    }
    var out: Set<UUID> = []
    var cur = end
    while let c = cur, !out.contains(c) { out.insert(c); cur = memo[c]?.prev }
    return out
}

// MARK: - Chart view

private enum ChartGroup: Hashable {
    case status, priority, assignee, tag, list, month, field(UUID)
}

private enum ChartMetric: Hashable {
    case count, estimate, points, tracked, field(UUID)
}

private enum ChartStyle: String, CaseIterable, Identifiable {
    case bar = "Bar", donut = "Donut", line = "Line"
    var id: String { rawValue }
}

private struct ChartRow: Identifiable {
    var id: String { key }
    let key: String
    let value: Double
    let color: Color
    let taskIds: [UUID]
}

/// Bar, donut or line chart of the tasks in view, grouped and summed by any property.
struct TaskChartView: View {
    let tasks: [TaskItem]
    @Environment(Store.self) private var store
    @State private var style: ChartStyle = .bar
    @State private var group: ChartGroup = .status
    @State private var metric: ChartMetric = .count

    private var fields: [FieldDef] {
        var seen: Set<UUID> = []
        return tasks.flatMap { store.space(ofTask: $0)?.fields ?? [] }.filter { seen.insert($0.id).inserted }
    }

    var body: some View {
        let rows = computeRows()
        let total = rows.reduce(0) { $0 + $1.value }
        VStack(alignment: .leading, spacing: 12) {
            controls(total: total)
            if rows.isEmpty {
                EmptyState(icon: "chart.bar", title: "Nothing to chart", subtitle: "No tasks match the current filters.")
            } else {
                chart(rows).frame(minHeight: 260, maxHeight: 360).padding(12).mkCard()
                legend(rows, total: total)
            }
        }
        .padding(16)
    }

    private func controls(total: Double) -> some View {
        HStack(spacing: 12) {
            Picker("", selection: $style) { ForEach(ChartStyle.allCases) { Text($0.rawValue).tag($0) } }
                .pickerStyle(.segmented).frame(width: 200).labelsHidden()
            Picker("Group by", selection: $group) {
                Text("Status").tag(ChartGroup.status)
                Text("Priority").tag(ChartGroup.priority)
                Text("Assignee").tag(ChartGroup.assignee)
                Text("Tag").tag(ChartGroup.tag)
                Text("List").tag(ChartGroup.list)
                Text("Due month").tag(ChartGroup.month)
                ForEach(fields.filter { [.dropdown, .checkbox, .people, .rating, .text].contains($0.type) }) { f in Text(f.name).tag(ChartGroup.field(f.id)) }
            }
            .fixedSize()
            Picker("Measure", selection: $metric) {
                Text("Number of tasks").tag(ChartMetric.count)
                Text("Estimated hours").tag(ChartMetric.estimate)
                Text("Points").tag(ChartMetric.points)
                Text("Tracked hours").tag(ChartMetric.tracked)
                ForEach(fields.filter { [.number, .money, .rating, .formula, .progress].contains($0.type) }) { f in Text("Sum of \(f.name)").tag(ChartMetric.field(f.id)) }
            }
            .fixedSize()
            Spacer()
            Text("Total: \(formatNumber((total * 100).rounded() / 100))").font(.callout.bold())
        }
    }

    @ViewBuilder
    private func chart(_ rows: [ChartRow]) -> some View {
        switch style {
        case .bar:
            Chart(rows) { r in
                BarMark(x: .value("Group", r.key), y: .value("Value", r.value)).foregroundStyle(r.color)
            }
        case .line:
            Chart(rows) { r in
                LineMark(x: .value("Group", r.key), y: .value("Value", r.value)).interpolationMethod(.catmullRom)
                PointMark(x: .value("Group", r.key), y: .value("Value", r.value)).foregroundStyle(r.color)
            }
        case .donut:
            Chart(rows) { r in
                SectorMark(angle: .value("Value", r.value), innerRadius: .ratio(0.55), angularInset: 1).foregroundStyle(r.color)
            }
        }
    }

    private func legend(_ rows: [ChartRow], total: Double) -> some View {
        VStack(spacing: 0) {
            ForEach(rows) { r in
                HStack {
                    RoundedRectangle(cornerRadius: 3).fill(r.color).frame(width: 10, height: 10)
                    Text(r.key)
                    Spacer()
                    Text(formatNumber((r.value * 100).rounded() / 100)).monospacedDigit()
                    Text(total > 0 ? "\(Int((r.value / total * 100).rounded()))%" : "0%").foregroundStyle(.secondary).frame(width: 44, alignment: .trailing)
                    Button { store.openTaskId = r.taskIds.first } label: { Image(systemName: "arrow.up.right.square") }.buttonStyle(.plain).help("Open the first task")
                }
                .font(.callout)
                .padding(.vertical, 5)
                Divider().opacity(0.5)
            }
        }
        .padding(12)
        .mkCard()
    }

    private func keys(_ t: TaskItem) -> [String] {
        switch group {
        case .status: return [store.status(of: t)?.name ?? "—"]
        case .priority: return [t.priority.label]
        case .assignee: return t.assigneeIds.isEmpty ? ["Unassigned"] : t.assigneeIds.map { store.member($0)?.name ?? "?" }
        case .tag: return t.tags.isEmpty ? ["No tag"] : t.tags
        case .list: return [store.list(t.listId)?.name ?? "—"]
        case .month: return [t.dueDate.map { $0.formatted(.iso8601.year().month()) } ?? "No due date"]
        case .field(let id):
            guard let f = fields.first(where: { $0.id == id }) else { return ["—"] }
            if f.type == .people {
                let ids = (t.customValues[f.id] ?? "").split(separator: ",").compactMap { UUID(uuidString: String($0)) }
                return ids.isEmpty ? ["Nobody"] : ids.map { store.member($0)?.name ?? "?" }
            }
            let v = store.fieldDisplay(t, f)
            return [v.isEmpty ? "(empty)" : v]
        }
    }

    private func value(_ t: TaskItem) -> Double {
        switch metric {
        case .count: return 1
        case .estimate: return Double(t.estimateMinutes ?? 0) / 60
        case .points: return Double(t.points ?? 0)
        case .tracked: return store.tracked(t.id) / 3600
        case .field(let id):
            guard let f = fields.first(where: { $0.id == id }) else { return 0 }
            switch f.type {
            case .formula:
                if case .number(let n) = store.formulaValue(t, f) { return n }
                return 0
            case .progress: return Double(store.progress(of: t))
            default: return Double(t.customValues[f.id] ?? "") ?? 0
            }
        }
    }

    private func computeRows() -> [ChartRow] {
        var order: [String] = []
        var totals: [String: (Double, [UUID])] = [:]
        for t in tasks {
            let v = value(t)
            for k in keys(t) {
                if totals[k] == nil { order.append(k); totals[k] = (0, []) }
                totals[k]!.0 += v
                totals[k]!.1.append(t.id)
            }
        }
        switch group {
        case .month: order.sort()
        case .priority: order = Priority.allCases.reversed().map(\.label).filter { totals[$0] != nil }
        case .status: break
        default: order.sort { totals[$0]!.0 > totals[$1]!.0 }
        }
        let palette = paletteHexes
        return order.enumerated().map { i, k in
            ChartRow(key: k, value: totals[k]!.0, color: color(for: k, index: i, palette: palette), taskIds: totals[k]!.1)
        }
    }

    private func color(for key: String, index: Int, palette: [String]) -> Color {
        switch group {
        case .status: Color(hex: store.data.spaces.flatMap(\.statuses).first { $0.name == key }?.colorHex ?? palette[index % palette.count])
        case .priority: Priority.allCases.first { $0.label == key }?.color ?? .gray
        default: Color(hex: palette[index % palette.count])
        }
    }
}

// MARK: - Portfolio page

struct PortfolioView: View {
    @Environment(Store.self) private var store
    @State private var spaceFilter: UUID?
    @State private var healthFilter: ProjectHealth?

    var body: some View {
        let all = store.data.lists.filter { !$0.archived && (spaceFilter == nil || $0.spaceId == spaceFilter) }.map(store.projectSummary)
        let rows = all.filter { healthFilter == nil || $0.health == healthFilter }
            .sorted { ($0.end ?? .distantFuture) < ($1.end ?? .distantFuture) }
        let dates = rows.flatMap { [$0.start, $0.end].compactMap { $0 } } + [Date()]
        let minD = dates.min() ?? Date(), maxD = dates.max() ?? Date()
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    ForEach([ProjectHealth.onTrack, .atRisk, .offTrack, .done], id: \.self) { h in
                        Button { healthFilter = healthFilter == h ? nil : h } label: {
                            VStack(alignment: .leading) {
                                Text("\(all.filter { $0.health == h }.count)").font(.title.bold())
                                Text(h.rawValue).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            .mkCard(tint: h.color.opacity(0.25))
                            .overlay(RoundedRectangle(cornerRadius: MKGlass.cardRadius).stroke(h.color, lineWidth: healthFilter == h ? 2 : 0))
                        }
                        .buttonStyle(.plain)
                    }
                }
                HStack {
                    Text("Portfolio").font(.title2.bold())
                    Spacer()
                    Picker("Space", selection: $spaceFilter) {
                        Text("All spaces").tag(UUID?.none)
                        ForEach(store.data.spaces) { s in Text(s.name).tag(UUID?.some(s.id)) }
                    }
                    .fixedSize()
                }
                if rows.isEmpty {
                    EmptyState(icon: "square.stack.3d.up", title: "No projects", subtitle: "Every list is a project here. Create lists in a space to see them.")
                } else {
                    VStack(spacing: 0) {
                        ForEach(rows) { r in PortfolioRowView(r: r, minD: minD, maxD: maxD) }
                    }
                    .padding(12).mkCard()
                }
                Text("Health compares progress with the time elapsed between a project's first start date and last due date (or its sprint dates): 15+ points behind or any overdue task is at risk, 30+ points behind or past its end date is off track.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .navigationTitle("Portfolio")
    }
}

private struct PortfolioRowView: View {
    let r: ProjectSummary
    let minD: Date
    let maxD: Date
    @Environment(Store.self) private var store

    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(Color(hex: store.space(r.spaceId)?.colorHex ?? "#7B68EE")).frame(width: 10, height: 10)
            VStack(alignment: .leading) {
                Text(r.name)
                Text(store.space(r.spaceId)?.name ?? "").font(.caption).foregroundStyle(.secondary)
            }
            .frame(width: 190, alignment: .leading)
            Text(r.health.rawValue.uppercased()).font(.caption2.bold()).foregroundStyle(r.health.color)
                .padding(.horizontal, 6).padding(.vertical, 2).background(r.health.color.opacity(0.15), in: Capsule())
                .frame(width: 90, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                ProgressView(value: Double(r.progress), total: 100).tint(r.health.color).frame(width: 110)
                Text(r.expected > 0 && r.health != .done ? "\(r.progress)% · expected \(r.expected)%" : "\(r.progress)%").font(.caption2).foregroundStyle(.secondary)
            }
            AvatarStack(ids: r.owners, size: 20).frame(width: 70, alignment: .leading)
            Text("\(r.total - r.done) / \(r.total) open").font(.caption).frame(width: 80, alignment: .leading)
            Text(r.overdue > 0 ? "\(r.overdue) overdue" : "").font(.caption).foregroundStyle(.red).frame(width: 70, alignment: .leading)
            timeline.frame(height: 12)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture { store.selection = .list(r.listId) }
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
    }

    private var timeline: some View {
        GeometryReader { geo in
            let span = max(maxD.timeIntervalSince(minD), 86400)
            let pos = { (d: Date) -> CGFloat in CGFloat(d.timeIntervalSince(minD) / span) * geo.size.width }
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.06))
                if let s = r.start, let e = r.end {
                    Capsule().fill(r.health.color.opacity(0.8)).frame(width: max(pos(e) - pos(s), 4)).offset(x: pos(s))
                }
                Rectangle().fill(Color.red).frame(width: 2).offset(x: pos(Date()))
            }
        }
    }
}

// MARK: - Resources page

struct ResourcesView: View {
    @Environment(Store.self) private var store
    @State private var weeks = 8
    @State private var from: Date = {
        let d = Date().startOfDay
        let back = (Calendar.current.component(.weekday, from: d) + 5) % 7
        return d.adding(days: -back)
    }()
    @State private var editing: UUID?

    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    var body: some View {
        let tasks = store.data.tasks.filter { !$0.archived }
        let starts = (0..<weeks).map { from.adding(days: $0 * 7) }
        VStack(spacing: 0) {
            HStack {
                Text("Resource management").font(.title2.bold())
                Spacer()
                Button { from = from.adding(days: -7) } label: { Image(systemName: "chevron.left") }
                Button("This week") {
                    let d = Date().startOfDay
                    from = d.adding(days: -((Calendar.current.component(.weekday, from: d) + 5) % 7))
                }
                Button { from = from.adding(days: 7) } label: { Image(systemName: "chevron.right") }
                Picker("", selection: $weeks) { Text("4 wk").tag(4); Text("8 wk").tag(8); Text("12 wk").tag(12) }
                    .pickerStyle(.segmented).frame(width: 170).labelsHidden()
            }
            .padding(16)
            Divider()
            ScrollView([.horizontal, .vertical]) {
                Grid(alignment: .leading, horizontalSpacing: 6, verticalSpacing: 6) {
                    GridRow {
                        Text("Person · capacity").font(.caption.bold()).foregroundStyle(.secondary).frame(width: 230, alignment: .leading)
                        ForEach(starts, id: \.self) { s in
                            Text(s.formatted(.dateTime.month(.abbreviated).day())).font(.caption.bold()).foregroundStyle(.secondary).frame(width: 84)
                        }
                    }
                    ForEach(store.data.members) { m in
                        GridRow {
                            personCell(m)
                            ForEach(starts, id: \.self) { s in weekCell(m.id, s, tasks: tasks) }
                        }
                    }
                }
                .padding(16)
            }
            Text("Each open task's estimate (1h if none) is spread over its assignees' working days between start and due date. Green is under 80% of capacity, orange 80–100%, red over capacity.")
                .font(.caption).foregroundStyle(.secondary).padding(12)
        }
        .navigationTitle("Resources")
        .sheet(item: Binding(get: { editing.map { IdentifiedID(id: $0) } }, set: { editing = $0?.id })) { e in
            ResourceEditor(memberId: e.id)
        }
    }

    private func personCell(_ m: Member) -> some View {
        let r = store.resource(for: m.id)
        let off = r.timeOff.filter { $0.end >= Date().startOfDay }.count
        return HStack {
            AvatarView(member: m, size: 24)
            VStack(alignment: .leading) {
                Text(m.name)
                Text("\(formatNumber(r.hoursPerDay))h × \(r.workDays.sorted().map { Self.weekdays[$0] }.joined(separator: " "))\(off > 0 ? " · \(off) time off" : "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { editing = m.id } label: { Image(systemName: "gearshape") }.buttonStyle(.borderless).help("Capacity and time off")
        }
        .frame(width: 230)
    }

    private func weekCell(_ memberId: UUID, _ weekStart: Date, tasks: [TaskItem]) -> some View {
        let r = store.resource(for: memberId)
        var cap = 0.0, used = 0.0
        var hit: [UUID: TaskItem] = [:]
        for d in 0..<7 {
            let day = weekStart.adding(days: d)
            if store.isWorkingDay(r, day) { cap += r.hoursPerDay }
            let a = store.allocatedHours(r, on: day, tasks: tasks)
            used += a.hours
            for t in a.tasks { hit[t.id] = t }
        }
        let ratio = cap > 0 ? used / cap : (used > 0 ? 2 : 0)
        let color: Color = ratio > 1 ? .red : ratio > 0.8 ? .orange : ratio > 0 ? .green : .clear
        return VStack(spacing: 1) {
            Text(used > 0 ? String(format: "%.1fh", used) : "—").font(.caption.bold())
            Text("of \(formatNumber(cap))h\(cap > 0 ? " · \(Int((ratio * 100).rounded()))%" : "")").font(.system(size: 9)).foregroundStyle(.secondary)
        }
        .frame(width: 84, height: 40)
        .background(color.opacity(0.2), in: RoundedRectangle(cornerRadius: 6))
        .help(hit.values.map(\.title).sorted().joined(separator: "\n"))
        .onTapGesture { if let t = hit.values.first { store.openTaskId = t.id } }
    }
}

struct IdentifiedID: Identifiable { let id: UUID }

private struct ResourceEditor: View {
    let memberId: UUID
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var offStart = Date()
    @State private var offEnd = Date()
    @State private var offNote = ""

    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    var body: some View {
        let r = store.resource(for: memberId)
        VStack(alignment: .leading, spacing: 12) {
            Text("Capacity · \(store.member(memberId)?.name ?? "")").font(.title3.bold())
            Stepper("Hours per working day: \(formatNumber(r.hoursPerDay))", value: Binding(get: { r.hoursPerDay }, set: { v in var x = r; x.hoursPerDay = v; store.setResource(x) }), in: 0...24, step: 0.5)
            HStack {
                Text("Working days")
                ForEach(0..<7, id: \.self) { i in
                    Toggle(Self.weekdays[i], isOn: Binding(get: { r.workDays.contains(i) }, set: { on in
                        var x = r
                        x.workDays = on ? (x.workDays + [i]).sorted() : x.workDays.filter { $0 != i }
                        store.setResource(x)
                    }))
                    .toggleStyle(.checkbox)
                }
            }
            Divider()
            Text("Time off").font(.headline)
            if r.timeOff.isEmpty { Text("None planned.").foregroundStyle(.secondary) }
            ForEach(r.timeOff.sorted { $0.start < $1.start }) { o in
                HStack {
                    Text("\(o.start.formatted(date: .abbreviated, time: .omitted)) → \(o.end.formatted(date: .abbreviated, time: .omitted))")
                    if !o.note.isEmpty { Text(o.note).foregroundStyle(.secondary) }
                    Spacer()
                    Button { var x = r; x.timeOff.removeAll { $0.id == o.id }; store.setResource(x) } label: { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
                }
            }
            HStack {
                DatePicker("", selection: $offStart, displayedComponents: .date).labelsHidden()
                Text("→")
                DatePicker("", selection: $offEnd, in: offStart..., displayedComponents: .date).labelsHidden()
                TextField("Note (vacation, training…)", text: $offNote)
                Button("Add") {
                    var x = r
                    x.timeOff.append(TimeOff(start: offStart.startOfDay, end: max(offEnd, offStart).startOfDay, note: offNote.trimmingCharacters(in: .whitespaces)))
                    store.setResource(x)
                    offNote = ""
                }
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 560)
    }
}

// MARK: - Content directory

private struct DirectoryRow: Identifiable {
    var id: String { type + key.uuidString }
    let key: UUID
    let type: String
    let icon: String
    let name: String
    let location: String
    let contains: String
    let isPrivate: Bool
    let updated: Date?
    let open: SidebarItem?
}

/// Everything in the workspace in one searchable table, for admins auditing what exists and where.
struct ContentDirectoryView: View {
    @Environment(Store.self) private var store
    @State private var query = ""
    @State private var type = ""

    var body: some View {
        let all = rows()
        let q = query.lowercased()
        let shown = all.filter { (type.isEmpty || $0.type == type) && (q.isEmpty || "\($0.name) \($0.location)".lowercased().contains(q)) }
            .sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }
        VStack(spacing: 0) {
            HStack {
                Text("Content directory").font(.title2.bold())
                Text("\(all.count) items").foregroundStyle(.secondary)
                Spacer()
                TextField("Search names and locations", text: $query).textFieldStyle(.roundedBorder).frame(width: 240)
                Picker("", selection: $type) {
                    Text("All types").tag("")
                    ForEach(Array(Set(all.map(\.type))).sorted(), id: \.self) { Text($0).tag($0) }
                }
                .fixedSize().labelsHidden()
            }
            .padding(16)
            Divider()
            Table(shown) {
                TableColumn("Name") { r in Label(r.name, systemImage: r.icon) }
                TableColumn("Type") { r in Text(r.type).foregroundStyle(.secondary) }
                TableColumn("Location") { r in Text(r.location) }
                TableColumn("Contains") { r in Text(r.contains) }.width(110)
                TableColumn("Privacy") { r in Text(r.isPrivate ? "🔒 Private" : "") }.width(80)
                TableColumn("Last task update") { r in Text(r.updated?.formatted(date: .abbreviated, time: .shortened) ?? "") }
                TableColumn("") { r in
                    if let target = r.open { Button("Open") { store.selection = target }.buttonStyle(.link) }
                }
                .width(50)
            }
        }
        .navigationTitle("Content Directory")
    }

    private func rows() -> [DirectoryRow] {
        let tasks = store.data.tasks.filter { !$0.archived }
        func latest(_ ts: [TaskItem]) -> Date? { ts.map(\.updated).max() }
        var out: [DirectoryRow] = []
        for s in store.data.spaces {
            let ids = Set(store.data.lists.filter { $0.spaceId == s.id }.map(\.id))
            let ts = tasks.filter { ids.contains($0.listId) }
            out.append(DirectoryRow(key: s.id, type: "Space", icon: "square.grid.2x2", name: s.name, location: "—", contains: "\(ts.count) tasks", isPrivate: s.isPrivate, updated: latest(ts), open: .space(s.id)))
        }
        for f in store.data.folders {
            let ids = Set(store.data.lists.filter { $0.folderId == f.id }.map(\.id))
            let ts = tasks.filter { ids.contains($0.listId) }
            out.append(DirectoryRow(key: f.id, type: "Folder", icon: "folder", name: f.name, location: store.space(f.spaceId)?.name ?? "", contains: "\(ts.count) tasks", isPrivate: store.space(f.spaceId)?.isPrivate ?? false, updated: latest(ts), open: .folder(f.id)))
        }
        for l in store.data.lists {
            let ts = tasks.filter { $0.listId == l.id }
            let where_ = [store.space(l.spaceId)?.name, store.folder(l.folderId)?.name].compactMap { $0 }.joined(separator: " › ")
            out.append(DirectoryRow(key: l.id, type: l.archived ? "List (archived)" : l.isSprint ? "Sprint" : "List", icon: l.isSprint ? "flag.checkered" : "list.bullet",
                                    name: l.name, location: where_, contains: "\(ts.count) tasks", isPrivate: store.space(l.spaceId)?.isPrivate ?? false, updated: latest(ts), open: l.archived ? nil : .list(l.id)))
        }
        for d in store.data.docs {
            let words = d.body.split(whereSeparator: \.isWhitespace).count
            let where_ = d.parentId.flatMap { p in store.data.docs.first { $0.id == p }?.title } ?? store.space(d.spaceId)?.name ?? "Docs"
            out.append(DirectoryRow(key: d.id, type: "Doc", icon: "doc.text", name: d.title.isEmpty ? "Untitled" : d.title, location: where_, contains: "\(words) words", isPrivate: false, updated: d.updated, open: .doc(d.id)))
        }
        for c in store.data.channels {
            let n = store.data.messages.filter { $0.channelId == c.id }.count
            out.append(DirectoryRow(key: c.id, type: "Chat channel", icon: "bubble.left.and.bubble.right", name: "#" + c.name, location: store.space(c.spaceId)?.name ?? "Workspace", contains: "\(n) messages", isPrivate: false, updated: nil, open: .chat(c.id)))
        }
        for g in store.data.goals {
            out.append(DirectoryRow(key: g.id, type: "Goal", icon: "target", name: g.name, location: g.folder, contains: "\(g.targets.count) targets", isPrivate: false, updated: nil, open: .goals))
        }
        for w in store.data.whiteboards {
            out.append(DirectoryRow(key: w.id, type: "Whiteboard", icon: "scribble.variable", name: w.name, location: "Whiteboards", contains: "\(w.items.count) items", isPrivate: false, updated: nil, open: .whiteboard(w.id)))
        }
        for d in store.data.dashboards {
            out.append(DirectoryRow(key: d.id, type: "Dashboard", icon: "gauge.with.dots.needle.33percent", name: d.name, location: "Dashboards", contains: "\(d.widgets.count) cards", isPrivate: false, updated: nil, open: .dashboard(d.id)))
        }
        return out
    }
}
