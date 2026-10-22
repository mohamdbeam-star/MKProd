import SwiftUI
import Charts
import AppKit

private struct YearPoint: Identifiable {
    var id: String { "\(category)-\(year)" }
    let category: String
    let year: String
    let value: Double
}

private struct ApproverStat: Identifiable {
    var id: String { name }
    let name: String
    let hours: Double
    let count: Int
}

private struct StepAvg: Identifiable {
    var id: String { step }
    let step: String
    let days: Double
}

private struct Bar: Identifiable {
    var id: String { label + series }
    let label: String
    let series: String
    let value: Double
}

/// Orders that count as money going out (approved, in flight, delivered, or recorded expenses).
private func isOutgoing(_ o: PurchaseOrder) -> Bool {
    OrderStatus.isCommitted(o.status) || OrderStatus.isSpent(o.status) || (o.type == .expense && o.status == OrderStatus.approved)
}

// MARK: - Overview (executive dashboard)

struct FinanceDashboardView: View {
    @Environment(Store.self) private var store
    @State private var filter = FinanceFilter(year: Calendar.current.component(.year, from: Date()))

    var body: some View {
        let budgets = store.data.budgets.filter { (filter.year == nil || $0.year == filter.year) && (filter.entityId == nil || $0.entityId == filter.entityId) }
        let total = budgets.map { store.figures(budget: $0) }.reduce(LineFigures(), +)
        let orders = store.data.orders.filter { (filter.entityId == nil || $0.entityId == filter.entityId) && (filter.year == nil || Calendar.current.component(.year, from: $0.requestedDate) == filter.year) }
        let savings = store.data.savings.filter { (filter.entityId == nil || $0.entityId == filter.entityId) && (filter.year == nil || Calendar.current.component(.year, from: $0.date) == filter.year) }
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Finance Overview").font(.largeTitle.bold())
                    Spacer()
                    FinanceFilterBar(filter: $filter)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 10) {
                    KPI(title: "Total budget", value: store.money(total.allocated), color: .indigo, icon: "banknote")
                    KPI(title: "Spent", value: store.money(total.spent), color: .green, icon: "checkmark.circle")
                    KPI(title: "Committed", value: store.money(total.committed), color: .blue, icon: "lock")
                    KPI(title: "Remaining", value: store.money(total.balance), color: total.balance < 0 ? .red : .teal, icon: "scalemass")
                    KPI(title: "Utilization", value: "\(Int(total.utilization * 100))%", color: total.utilization > 0.9 ? .orange : .mint, icon: "gauge.with.dots.needle.67percent")
                    KPI(title: "Pending approvals", value: "\(orders.filter { OrderStatus.isPending($0.status) }.count)", color: .orange, icon: "hourglass")
                    KPI(title: "Savings", value: store.money(savings.reduce(0) { $0 + $1.amount }), color: .green, icon: "dollarsign.arrow.circlepath")
                    KPI(title: "Unbudgeted spend", value: store.money(orders.filter { $0.isUnbudgeted && isOutgoing($0) }.reduce(0) { $0 + $1.amount }), color: .red, icon: "exclamationmark.triangle")
                }
                HStack(alignment: .top, spacing: 16) {
                    card("Budget vs spent by entity") {
                        Chart(entityBars(budgets)) { b in
                            BarMark(x: .value("Entity", b.label), y: .value("Amount", b.value)).foregroundStyle(by: .value("", b.series)).position(by: .value("", b.series))
                        }
                        .chartForegroundStyleScale(["Budget": Color.indigo.opacity(0.5), "Spent": Color.green, "Committed": Color.blue])
                    }
                    card("Spend by category") {
                        let cats = categoryTotals(budgets)
                        Chart(cats, id: \.0) { c in
                            SectorMark(angle: .value("Spent", max(c.1.spent + c.1.committed, 0.0001)), innerRadius: .ratio(0.55), angularInset: 1).foregroundStyle(by: .value("Category", c.0))
                        }
                    }
                }
                HStack(alignment: .top, spacing: 16) {
                    card("Monthly spend") {
                        let monthly = monthlySpend(orders)
                        Chart(monthly, id: \.0) { m in BarMark(x: .value("Month", m.0, unit: .month), y: .value("Spend", m.1)).foregroundStyle(Color.accentColor.gradient) }
                    }
                    card("Alerts") {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(store.financeAlerts.prefix(8)) { a in AlertRow(alert: a) }
                                if store.financeAlerts.isEmpty { Text("No alerts 🎉").foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
                card("Top suppliers") {
                    let sup = topSuppliers(orders)
                    Chart(sup, id: \.0) { s in BarMark(x: .value("Amount", s.1), y: .value("Supplier", s.0)).foregroundStyle(Color.purple.gradient) }
                }
            }
            .padding(20)
        }
        .navigationTitle("Finance Overview")
    }

    // Pre-computed outside the view builders: these expressions are too much for the type checker inline.
    private func categoryTotals(_ budgets: [Budget]) -> [(String, LineFigures)] {
        let grouped: [String: [Budget]] = Dictionary(grouping: budgets, by: \.category)
        var out: [(String, LineFigures)] = []
        for (category, bs) in grouped {
            var f = LineFigures()
            for b in bs { f = f + store.figures(budget: b) }
            out.append((category, f))
        }
        return out.sorted { ($0.1.spent + $0.1.committed) > ($1.1.spent + $1.1.committed) }
    }

    private func monthlySpend(_ orders: [PurchaseOrder]) -> [(Date, Double)] {
        var totals: [Date: Double] = [:]
        for o in orders where isOutgoing(o) {
            let month = Calendar.current.dateInterval(of: .month, for: o.requestedDate)?.start ?? o.requestedDate
            totals[month, default: 0] += o.amount
        }
        return totals.map { ($0.key, $0.value) }.sorted { $0.0 < $1.0 }
    }

    private func topSuppliers(_ orders: [PurchaseOrder]) -> [(String, Double)] {
        var totals: [String: Double] = [:]
        for o in orders where isOutgoing(o) && !o.supplier.isEmpty { totals[o.supplier, default: 0] += o.amount }
        return Array(totals.map { ($0.key, $0.value) }.sorted { $0.1 > $1.1 }.prefix(8))
    }

    private func entityBars(_ budgets: [Budget]) -> [Bar] {
        Dictionary(grouping: budgets, by: \.entityId).flatMap { (eid, bs) -> [Bar] in
            let f = bs.map { store.figures(budget: $0) }.reduce(LineFigures(), +)
            let n = store.entity(eid)?.name ?? "?"
            return [Bar(label: n, series: "Budget", value: f.allocated), Bar(label: n, series: "Spent", value: f.spent), Bar(label: n, series: "Committed", value: f.committed)]
        }
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content().frame(height: 240)
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .mkCard(radius: 12)
    }
}

struct AlertRow: View {
    let alert: Store.FinanceAlert
    @Environment(Store.self) private var store

    var body: some View {
        HStack(alignment: .top) {
            Image(systemName: alert.severity == 2 ? "exclamationmark.octagon.fill" : (alert.severity == 1 ? "exclamationmark.triangle.fill" : "info.circle.fill"))
                .foregroundStyle(alert.severity == 2 ? .red : (alert.severity == 1 ? .orange : .blue))
            VStack(alignment: .leading, spacing: 1) {
                Text(alert.title).font(.callout.weight(.medium))
                if !alert.detail.isEmpty { Text(alert.detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
        }
        .contentShape(Rectangle())
        .onTapGesture { store.selection = alert.target }
    }
}

struct FinanceAlertsView: View {
    @Environment(Store.self) private var store

    var body: some View {
        let alerts = store.financeAlerts
        Group {
            if alerts.isEmpty {
                EmptyState(icon: "checkmark.shield", title: "No alerts", subtitle: "Budgets over 90%, expiring contracts, late deliveries and pending approvals show up here.")
            } else {
                List(alerts) { a in AlertRow(alert: a).padding(.vertical, 4) }
            }
        }
        .navigationTitle("Alerts")
    }
}

// MARK: - Analytics

struct FinanceAnalyticsView: View {
    @Environment(Store.self) private var store
    @State private var tab = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                Text("Year over year").tag(0)
                Text("Budget variance").tag(1)
                Text("Spend analysis").tag(2)
                Text("Order time").tag(3)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 560).padding(12)
            Divider()
            ScrollView {
                Group {
                    switch tab {
                    case 0: yoy
                    case 1: variance
                    case 2: spend
                    default: orderTime
                    }
                }
                .padding(20)
            }
        }
        .navigationTitle("Analytics")
    }

    private var yoy: some View {
        let years = store.data.finance.years.sorted()
        let rows = Dictionary(grouping: store.data.budgets, by: \.category).map { cat, bs in
            (cat, years.map { y in bs.filter { $0.year == y }.map { store.figures(budget: $0) }.reduce(LineFigures(), +) })
        }.sorted { $0.0 < $1.0 }
        return VStack(alignment: .leading, spacing: 14) {
            Text("Budget and spend by category across years").font(.headline)
            Chart(yearPoints(rows, years)) { p in
                BarMark(x: .value("Category", p.category), y: .value("Spent", p.value))
                    .foregroundStyle(by: .value("Year", p.year))
                    .position(by: .value("Year", p.year))
            }
            .frame(height: 280)
            Grid(alignment: .trailing, horizontalSpacing: 18, verticalSpacing: 6) {
                GridRow {
                    Text("Category").bold().gridColumnAlignment(.leading)
                    ForEach(years, id: \.self) { Text("\(String($0)) budget").bold(); Text("\(String($0)) spent").bold() }
                    if years.count >= 2 { Text("Δ spent").bold() }
                }
                ForEach(rows, id: \.0) { cat, figs in
                    GridRow {
                        Text(cat).gridColumnAlignment(.leading)
                        ForEach(Array(figs.enumerated()), id: \.offset) { _, f in Text(store.money(f.allocated)); Text(store.money(f.spent + f.committed)) }
                        if figs.count >= 2 {
                            let a = figs[figs.count - 2].spent + figs[figs.count - 2].committed, b = figs.last!.spent + figs.last!.committed
                            Text(a > 0 ? "\(Int((b - a) / a * 100))%" : "—").foregroundStyle(b > a ? .red : .green)
                        }
                    }
                }
            }
            .font(.callout.monospacedDigit())
        }
    }

    private func yearPoints(_ rows: [(String, [LineFigures])], _ years: [Int]) -> [YearPoint] {
        var out: [YearPoint] = []
        for (cat, figs) in rows {
            for (i, f) in figs.enumerated() { out.append(YearPoint(category: cat, year: String(years[i]), value: f.spent + f.committed)) }
        }
        return out
    }

    private func approverStats(_ orders: [PurchaseOrder]) -> [ApproverStat] {
        var hours: [UUID: [Double]] = [:]
        for o in orders {
            for (i, e) in o.history.enumerated() where i > 0 && (e.action == "Approved" || e.action == "Rejected") {
                hours[e.memberId, default: []].append(e.date.timeIntervalSince(o.history[i - 1].date) / 3600)
            }
        }
        return hours.map { k, v in ApproverStat(name: store.member(k)?.name ?? "?", hours: v.reduce(0, +) / Double(v.count), count: v.count) }
            .sorted { $0.hours < $1.hours }
    }

    private var variance: some View {
        let rows: [(String, String, LineFigures)] = store.data.budgets.flatMap { b in
            b.lineItems.map { l in ("\(store.entity(b.entityId)?.name ?? "") · \(b.category) \(String(b.year))", l.name, store.figures(budget: b.id, line: l.id)) }
        }.sorted { $0.2.utilization > $1.2.utilization }
        return VStack(alignment: .leading, spacing: 10) {
            Text("Allocated vs actual per line item (sorted by utilization)").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow { ForEach(["Budget", "Line", "Allocated", "Actual", "Variance", "Used"], id: \.self) { Text($0).bold() } }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                    let actual = r.2.spent + r.2.committed
                    GridRow {
                        Text(r.0).foregroundStyle(.secondary)
                        Text(r.1)
                        Text(store.money(r.2.allocated))
                        Text(store.money(actual))
                        Text(store.money(r.2.allocated - actual)).foregroundStyle(actual > r.2.allocated ? .red : .green)
                        UtilizationBar(figures: r.2).frame(width: 120)
                    }
                }
            }
            .font(.callout.monospacedDigit())
            if rows.isEmpty { Text("No budget lines yet.").foregroundStyle(.secondary) }
        }
    }

    private var spend: some View {
        let out = store.data.orders.filter(isOutgoing)
        let lines = out.flatMap { o in o.items.map { (o, $0) } }
        // Same item bought at different prices: highlight the spread.
        let priceVar = Dictionary(grouping: lines) { $0.1.name.lowercased() }.compactMap { _, v -> (String, Double, Double, Int)? in
            let prices = v.map(\.1.unitPrice).filter { $0 > 0 }
            guard prices.count > 1, let lo = prices.min(), let hi = prices.max(), hi > lo else { return nil }
            return (v[0].1.name, lo, hi, prices.count)
        }.sorted { ($0.2 - $0.1) / max($0.1, 1) > ($1.2 - $1.1) / max($1.1, 1) }
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading) {
                    Text("By item category").font(.headline)
                    let cat = Dictionary(grouping: out) { $0.itemCategory.isEmpty ? "Uncategorized" : $0.itemCategory }.map { ($0.key, $0.value.reduce(0) { $0 + $1.amount }) }
                    Chart(cat, id: \.0) { c in SectorMark(angle: .value("Amount", c.1), innerRadius: .ratio(0.5)).foregroundStyle(by: .value("Category", c.0)) }.frame(height: 240)
                }
                VStack(alignment: .leading) {
                    Text("By entity").font(.headline)
                    let ent = Dictionary(grouping: out, by: \.entityId).map { (store.entity($0.key)?.name ?? "?", $0.value.reduce(0) { $0 + $1.amount }) }
                    Chart(ent, id: \.0) { e in BarMark(x: .value("Amount", e.1), y: .value("Entity", e.0)).foregroundStyle(Color.indigo.gradient) }.frame(height: 240)
                }
            }
            Text("Price variance (same item, different prices)").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow { ForEach(["Item", "Lowest", "Highest", "Spread", "Purchases"], id: \.self) { Text($0).bold() } }
                ForEach(Array(priceVar.prefix(20).enumerated()), id: \.offset) { _, p in
                    GridRow {
                        Text(p.0)
                        Text(store.money(p.1))
                        Text(store.money(p.2))
                        Text("\(Int((p.2 - p.1) / max(p.1, 1) * 100))%").foregroundStyle(.orange)
                        Text("\(p.3)")
                    }
                }
            }
            .font(.callout.monospacedDigit())
            if priceVar.isEmpty { Text("No repeated items with different prices yet.").foregroundStyle(.secondary) }
        }
    }

    private var orderTime: some View {
        // Days between the first event and each later milestone.
        func days(_ o: PurchaseOrder, to status: String) -> Double? {
            guard let start = o.history.first?.date, let e = o.history.first(where: { $0.to == status }) else { return nil }
            return e.date.timeIntervalSince(start) / 86400
        }
        let orders = store.data.orders.filter { $0.type == .order }
        let steps = [OrderStatus.approved, OrderStatus.ordered, OrderStatus.shipped, OrderStatus.delivered, OrderStatus.completed]
        let avgs: [StepAvg] = steps.compactMap { s in
            let v = orders.compactMap { days($0, to: s) }
            return v.isEmpty ? nil : StepAvg(step: s, days: v.reduce(0, +) / Double(v.count))
        }
        let approvers = approverStats(orders)
        return VStack(alignment: .leading, spacing: 16) {
            Text("Average days from request to each milestone").font(.headline)
            Chart(avgs) { a in
                BarMark(x: .value("Step", a.step), y: .value("Days", a.days))
                    .foregroundStyle(Color.teal.gradient)
                    .annotation { Text(String(format: "%.1f d", a.days)).font(.caption) }
            }
                .frame(height: 240)
            Text("Approver response time").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow { Text("Approver").bold(); Text("Avg hours to decide").bold(); Text("Decisions").bold() }
                ForEach(approvers) { a in GridRow { Text(a.name); Text(String(format: "%.1f", a.hours)); Text("\(a.count)") } }
            }
            .font(.callout.monospacedDigit())
            if avgs.isEmpty { Text("Order timings appear once orders move through approval and delivery.").foregroundStyle(.secondary) }
        }
    }
}

// MARK: - Reports

struct FinanceReportsView: View {
    @Environment(Store.self) private var store

    var body: some View {
        Form {
            Section("Export (CSV, opens in Excel/Numbers)") {
                exportRow("Budgets & line items", "budgets.csv", budgetsCSV)
                exportRow("Orders & expenses", "orders.csv", ordersCSV)
                exportRow("Savings", "savings.csv") {
                    (["Date,Entity,Type,Amount,Description,LPO"] + store.data.savings.map { s in
                        [s.date.formatted(.iso8601.year().month().day()), csvEscape(store.entity(s.entityId)?.name ?? ""), csvEscape(s.type), String(s.amount), csvEscape(s.description), csvEscape(s.lpo)].joined(separator: ",")
                    }).joined(separator: "\n")
                }
                exportRow("Unbudgeted spend", "unbudgeted.csv") { ordersCSV(store.data.orders.filter(\.isUnbudgeted)) }
                exportRow("Audit log", "audit-log.csv") {
                    (["Date,User,Action,Details"] + store.data.audit.reversed().map { a in
                        [ISO8601DateFormatter.plain.string(from: a.date), csvEscape(store.member(a.memberId)?.name ?? ""), csvEscape(a.action), csvEscape(a.details)].joined(separator: ",")
                    }).joined(separator: "\n")
                }
            }
            Section("Import templates") {
                exportRow("Budget import template", "budget-template.csv") { "Entity,Year,Category,Line Item,Allocated,Notes\nFinance Dept,\(Calendar.current.component(.year, from: Date())),IT,Laptops,50000,Replacement cycle" }
                Text("Budgets, the shopping catalog and contracts each have an Import / Export button: download the template there, fill it in, upload it.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Printable") {
                Button("Executive report (PDF)…") { exportExecutivePDF() }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Reports")
    }

    private func exportRow(_ title: String, _ file: String, _ make: @escaping () -> String) -> some View {
        HStack { Text(title); Spacer(); Button("Export…") { saveText(make(), name: file) } }
    }

    private func budgetsCSV() -> String {
        var lines = ["Entity,Year,Category,Line Item,Allocated,Spent,Committed,Pending,Balance,Utilization %"]
        for b in store.data.budgets {
            for l in b.lineItems {
                let f = store.figures(budget: b.id, line: l.id)
                lines.append([csvEscape(store.entity(b.entityId)?.name ?? ""), String(b.year), csvEscape(b.category), csvEscape(l.name),
                              String(f.allocated), String(f.spent), String(f.committed), String(f.pending), String(f.balance), String(Int(f.utilization * 100))].joined(separator: ","))
            }
        }
        return lines.joined(separator: "\n")
    }

    private func ordersCSV() -> String { ordersCSV(store.data.orders) }

    private func ordersCSV(_ orders: [PurchaseOrder]) -> String {
        var lines = ["Number,Type,Title,Entity,Budget,Line,Supplier,Amount,Currency,Status,Unbudgeted,Requested by,Requested,PO,LPO,Expected,Delivered"]
        for o in orders.sorted(by: { $0.number < $1.number }) {
            let b = store.budget(o.budgetId)
            lines.append([String(o.number), o.type.rawValue, csvEscape(o.title), csvEscape(store.entity(o.entityId)?.name ?? ""),
                          csvEscape(b.map { "\($0.category) \($0.year)" } ?? ""), csvEscape(store.budgetLine(o.budgetId, o.lineItemId)?.name ?? ""),
                          csvEscape(o.supplier), String(o.amount), o.currency, csvEscape(o.status), o.isUnbudgeted ? "Yes" : "No",
                          csvEscape(store.member(o.requestedBy)?.name ?? ""), o.requestedDate.formatted(.iso8601.year().month().day()),
                          csvEscape(o.poNumber), csvEscape(o.lpo), o.expectedDelivery?.formatted(.iso8601.year().month().day()) ?? "",
                          o.actualDelivery?.formatted(.iso8601.year().month().day()) ?? ""].joined(separator: ","))
        }
        return lines.joined(separator: "\n")
    }

    @MainActor
    private func exportExecutivePDF() {
        let p = NSSavePanel()
        p.nameFieldStringValue = "executive-report.pdf"
        guard p.runModal() == .OK, let url = p.url else { return }
        let renderer = ImageRenderer(content: ExecutiveReport().environment(store).frame(width: 800).padding(30).background(Color.white).environment(\.colorScheme, .light))
        renderer.render { size, draw in
            var box = CGRect(origin: .zero, size: size)
            guard let ctx = CGContext(url as CFURL, mediaBox: &box, nil) else { return }
            ctx.beginPDFPage(nil)
            draw(ctx)
            ctx.endPDFPage()
            ctx.closePDF()
        }
        NSWorkspace.shared.open(url)
    }
}

struct ExecutiveReport: View {
    @Environment(Store.self) private var store

    var body: some View {
        let year = Calendar.current.component(.year, from: Date())
        let budgets = store.data.budgets.filter { $0.year == year }
        let total = budgets.map { store.figures(budget: $0) }.reduce(LineFigures(), +)
        VStack(alignment: .leading, spacing: 14) {
            Text("Executive Report · \(String(year))").font(.largeTitle.bold())
            Text("\(store.data.workspaceName) · generated \(Date().formatted(date: .long, time: .shortened))").foregroundStyle(.secondary)
            Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 6) {
                GridRow { Text("Total budget").bold(); Text(store.money(total.allocated)) }
                GridRow { Text("Spent").bold(); Text(store.money(total.spent)) }
                GridRow { Text("Committed").bold(); Text(store.money(total.committed)) }
                GridRow { Text("Remaining").bold(); Text(store.money(total.balance)) }
                GridRow { Text("Savings").bold(); Text(store.money(store.data.savings.filter { Calendar.current.component(.year, from: $0.date) == year }.reduce(0) { $0 + $1.amount })) }
            }
            Text("By entity").font(.title2.bold()).padding(.top, 8)
            ForEach(store.data.entities) { e in
                let f = budgets.filter { $0.entityId == e.id }.map { store.figures(budget: $0) }.reduce(LineFigures(), +)
                HStack {
                    Text(e.name).frame(width: 200, alignment: .leading)
                    UtilizationBar(figures: f).frame(width: 260)
                    Text("\(Int(f.utilization * 100))%").frame(width: 50)
                    Text(store.money(f.balance) + " left")
                }
            }
            Text("Alerts").font(.title2.bold()).padding(.top, 8)
            ForEach(store.financeAlerts.prefix(12)) { a in Text("• \(a.title) — \(a.detail)") }
        }
        .foregroundStyle(.black)
    }
}

// MARK: - Settings

struct FinanceSettingsView: View {
    @Environment(Store.self) private var store
    @State private var newLevel: [UUID: String] = [:]

    var body: some View {
        Form {
            if !store.isFinanceAdmin {
                Label("Only workspace owners and admins can change finance settings.", systemImage: "lock").foregroundStyle(.orange)
            }
            Section("Entities & approval chains") {
                ForEach(store.data.entities) { e in entityEditor(e) }
                Button("Add entity") { store.data.entities.append(FinEntity(name: "New entity")) }
            }
            listSection("Fiscal years", values: store.data.finance.years.map(String.init)) { s in
                var x = store.data.finance; x.years = s.compactMap(Int.init).sorted(); store.data.financeSettings = [x]
            }
            listSection("Budget categories", values: store.data.finance.categories) { s in var x = store.data.finance; x.categories = s; store.data.financeSettings = [x] }
            listSection("Contract types", values: store.data.finance.contractTypes) { s in var x = store.data.finance; x.contractTypes = s; store.data.financeSettings = [x] }
            listSection("Item categories", values: store.data.finance.itemCategories) { s in var x = store.data.finance; x.itemCategories = s; store.data.financeSettings = [x] }
            listSection("Savings types", values: store.data.finance.savingsTypes) { s in var x = store.data.finance; x.savingsTypes = s; store.data.financeSettings = [x] }
            Section("Currency") {
                TextField("Currency code", text: Binding(get: { store.data.finance.currency }, set: { var x = store.data.finance; x.currency = $0; store.data.financeSettings = [x] }))
            }
        }
        .formStyle(.grouped)
        .disabled(!store.isFinanceAdmin)
        .navigationTitle("Finance Settings")
    }

    private func entityIndex(_ id: UUID) -> Int? { store.data.entities.firstIndex { $0.id == id } }

    @ViewBuilder
    private func entityEditor(_ e: FinEntity) -> some View {
        if let i = entityIndex(e.id) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    TextField("Name", text: Binding(get: { store.data.entities[i].name }, set: { store.data.entities[i].name = $0 })).font(.headline)
                    TextField("Code", text: Binding(get: { store.data.entities[i].code }, set: { store.data.entities[i].code = $0 })).frame(width: 80)
                    Button(role: .destructive) { store.data.entities.remove(at: i) } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                        .disabled(store.data.budgets.contains { $0.entityId == e.id } || store.data.orders.contains { $0.entityId == e.id })
                        .help("Entities with budgets or orders can't be deleted")
                }
                Text("Approval chain (orders move left → right)").font(.caption).foregroundStyle(.secondary)
                HStack {
                    ForEach(Array(e.approvalLevels.enumerated()), id: \.offset) { li, level in
                        HStack(spacing: 2) {
                            Text("\(li + 1). \(level)").font(.callout)
                            if level != "Requestor" {
                                Button { store.data.entities[i].approvalLevels.remove(at: li) } label: { Image(systemName: "xmark").font(.caption2) }.buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.12), in: Capsule())
                        if li < e.approvalLevels.count - 1 { Image(systemName: "arrow.right").font(.caption).foregroundStyle(.secondary) }
                    }
                    TextField("Add level", text: Binding(get: { newLevel[e.id] ?? "" }, set: { newLevel[e.id] = $0 }))
                        .frame(width: 120)
                        .onSubmit {
                            let v = (newLevel[e.id] ?? "").trimmingCharacters(in: .whitespaces)
                            if !v.isEmpty && !e.approvalLevels.contains(v) { store.data.entities[i].approvalLevels.append(v) }
                            newLevel[e.id] = ""
                        }
                }
                Text("People in this entity").font(.caption).foregroundStyle(.secondary)
                ForEach(store.data.members) { m in
                    HStack {
                        AvatarView(member: m, size: 18)
                        Text(m.name).frame(width: 180, alignment: .leading)
                        Picker("", selection: Binding(get: { e.role(of: m.id) ?? "" }, set: { r in
                            store.data.entities[i].roles.removeAll { $0.memberId == m.id }
                            if !r.isEmpty { store.data.entities[i].roles.append(EntityRoleAssignment(memberId: m.id, role: r)) }
                        })) {
                            Text("No role").tag("")
                            ForEach(e.approvalLevels, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden().frame(width: 180)
                    }
                    .font(.callout)
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func listSection(_ title: String, values: [String], set: @escaping ([String]) -> Void) -> some View {
        Section(title) {
            ChipListEditor(values: values, onChange: set)
        }
    }
}

struct ChipListEditor: View {
    let values: [String]
    let onChange: ([String]) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading) {
            FlowLayout(spacing: 6) {
                ForEach(values, id: \.self) { v in
                    HStack(spacing: 3) {
                        Text(v)
                        Button { onChange(values.filter { $0 != v }) } label: { Image(systemName: "xmark").font(.caption2) }.buttonStyle(.plain)
                    }
                    .font(.callout)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                }
            }
            TextField("Add and press Return", text: $text).onSubmit {
                let t = text.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty && !values.contains(t) { onChange(values + [t]) }
                text = ""
            }
        }
    }
}

/// Wraps children onto new lines like text.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? 600, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (i, p) in arrange(bounds.width, subviews).points.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified)
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (points: [CGPoint], size: CGSize) {
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, maxX: CGFloat = 0
        var pts: [CGPoint] = []
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > width { x = 0; y += row + spacing; row = 0 }
            pts.append(CGPoint(x: x, y: y))
            x += sz.width + spacing
            row = max(row, sz.height)
            maxX = max(maxX, x)
        }
        return (pts, CGSize(width: maxX, height: y + row))
    }
}

// MARK: - Audit log

struct AuditLogView: View {
    @Environment(Store.self) private var store
    @State private var search = ""

    var body: some View {
        let rows = store.data.audit.reversed().filter { search.isEmpty || ($0.action + $0.details + (store.member($0.memberId)?.name ?? "")).localizedCaseInsensitiveContains(search) }
        VStack(spacing: 0) {
            HStack {
                TextField("Search log", text: $search).textFieldStyle(.roundedBorder).frame(width: 260)
                Spacer()
                Text("\(store.data.audit.count) entries").foregroundStyle(.secondary)
            }
            .padding(12)
            Divider()
            Table(Array(rows)) {
                TableColumn("When") { a in Text(a.date.formatted(date: .abbreviated, time: .shortened)) }.width(150)
                TableColumn("Who") { a in HStack { AvatarView(member: store.member(a.memberId), size: 16); Text(store.member(a.memberId)?.name ?? "—") } }.width(160)
                TableColumn("Action") { a in Text(a.action) }
                TableColumn("Details") { a in Text(a.details).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Audit Log")
    }
}
