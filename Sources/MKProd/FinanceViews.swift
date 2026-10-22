import SwiftUI
import AppKit

// MARK: - Shared bits

struct FinanceFilter {
    var year: Int?
    var entityId: UUID?
}

struct FinanceFilterBar: View {
    @Binding var filter: FinanceFilter
    @Environment(Store.self) private var store

    var body: some View {
        HStack {
            Picker("Year", selection: $filter.year) {
                Text("All years").tag(Int?.none)
                ForEach(store.data.finance.years.sorted(by: >), id: \.self) { Text(String($0)).tag(Optional($0)) }
            }
            .frame(width: 150)
            Picker("Entity", selection: $filter.entityId) {
                Text("All entities").tag(UUID?.none)
                ForEach(store.data.entities) { Text($0.name).tag(Optional($0.id)) }
            }
            .frame(width: 240)
        }
    }
}

struct KPI: View {
    let title: String
    let value: String
    var color: Color = .accentColor
    var icon: String = "circle"

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.title2).foregroundStyle(color).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(value).font(.title3.bold()).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct OrderStatusPill: View {
    let status: String

    var color: Color {
        if OrderStatus.isPending(status) { return .orange }
        switch status {
        case OrderStatus.approved, OrderStatus.recorded: return .blue
        case OrderStatus.ordered: return .purple
        case OrderStatus.shipped: return .teal
        case OrderStatus.delivered, OrderStatus.completed: return .green
        case OrderStatus.rejected, OrderStatus.cancelled: return .red
        default: return .gray
        }
    }

    var body: some View {
        Text(status)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
            .lineLimit(1)
    }
}

struct UtilizationBar: View {
    let figures: LineFigures

    var body: some View {
        GeometryReader { g in
            let a = max(figures.allocated, 1)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                HStack(spacing: 0) {
                    Rectangle().fill(Color.green).frame(width: g.size.width * min(figures.spent / a, 1))
                    Rectangle().fill(Color.blue).frame(width: g.size.width * min(figures.committed / a, max(0, 1 - figures.spent / a)))
                    Rectangle().fill(Color.orange.opacity(0.6)).frame(width: g.size.width * min(figures.pending / a, max(0, 1 - (figures.spent + figures.committed) / a)))
                }
                .clipShape(Capsule())
                if figures.utilization > 1 { Capsule().stroke(Color.red, lineWidth: 1.5) }
            }
        }
        .frame(height: 8)
        .help("Spent \(Int(figures.spent)) · Committed \(Int(figures.committed)) · Pending \(Int(figures.pending)) of \(Int(figures.allocated))")
    }
}

func csvEscape(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }

func saveText(_ text: String, name: String) {
    let p = NSSavePanel()
    p.nameFieldStringValue = name
    if p.runModal() == .OK, let url = p.url { try? text.write(to: url, atomically: true, encoding: .utf8) }
}

// MARK: - Budgets

struct BudgetsView: View {
    @Environment(Store.self) private var store
    @State private var filter = FinanceFilter(year: Calendar.current.component(.year, from: Date()))
    @State private var editing: Budget?
    @State private var newOrder: PurchaseOrder?

    var body: some View {
        let budgets = store.data.budgets.filter { (filter.year == nil || $0.year == filter.year) && (filter.entityId == nil || $0.entityId == filter.entityId) }
            .sorted { (store.entity($0.entityId)?.name ?? "", $0.category) < (store.entity($1.entityId)?.name ?? "", $1.category) }
        let total = budgets.map { store.figures(budget: $0) }.reduce(LineFigures(), +)
        VStack(spacing: 0) {
            HStack {
                FinanceFilterBar(filter: $filter)
                Spacer()
                Button("Import CSV…") { importBudgets() }
                Button { startNew() } label: { Label("New Budget", systemImage: "plus") }
                    .buttonStyle(.borderedProminent).disabled(!store.isFinanceAdmin || store.data.entities.isEmpty)
            }
            .padding(12)
            HStack(spacing: 10) {
                KPI(title: "Allocated", value: store.money(total.allocated), color: .indigo, icon: "banknote")
                KPI(title: "Spent", value: store.money(total.spent), color: .green, icon: "checkmark.circle")
                KPI(title: "Committed", value: store.money(total.committed), color: .blue, icon: "lock")
                KPI(title: "Pending approval", value: store.money(total.pending), color: .orange, icon: "hourglass")
                KPI(title: "Balance", value: store.money(total.balance), color: total.balance < 0 ? .red : .teal, icon: "scalemass")
            }
            .padding(.horizontal, 12)
            Divider().padding(.top, 10)
            if store.data.entities.isEmpty {
                EmptyState(icon: "building.2", title: "Add an entity first", subtitle: "Budgets belong to entities (departments, schools, units). Add them in Finance Settings.")
            } else if budgets.isEmpty {
                EmptyState(icon: "banknote", title: "No budgets for this filter", subtitle: "Create a budget, then split it into line items.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(budgets) { b in budgetCard(b) }
                    }
                    .padding(12)
                }
            }
        }
        .navigationTitle("Budgets")
        .sheet(item: $editing) { b in BudgetEditor(budget: b) }
        .sheet(item: $newOrder) { o in OrderEditor(draft: o) }
    }

    private func budgetCard(_ b: Budget) -> some View {
        let f = store.figures(budget: b)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading) {
                    Text("\(b.category) · \(String(b.year))").font(.headline)
                    Text(store.entity(b.entityId)?.name ?? "—").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing) {
                    Text(store.money(f.balance)).font(.headline).foregroundStyle(f.balance < 0 ? .red : .primary)
                    Text("left of \(store.money(f.allocated))").font(.caption).foregroundStyle(.secondary)
                }
                Button("Edit") { editing = b }.disabled(!store.isFinanceAdmin)
            }
            UtilizationBar(figures: f)
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                GridRow {
                    ForEach(["Line item", "Allocated", "Spent", "Committed", "Pending", "Balance", "Used", ""], id: \.self) { Text($0).font(.caption.bold()).foregroundStyle(.secondary) }
                }
                ForEach(b.lineItems) { l in
                    let lf = store.figures(budget: b.id, line: l.id)
                    GridRow {
                        Text(l.name).lineLimit(1)
                        Text(store.money(lf.allocated)).monospacedDigit()
                        Text(store.money(lf.spent)).monospacedDigit()
                        Text(store.money(lf.committed)).monospacedDigit()
                        Text(store.money(lf.pending)).monospacedDigit().foregroundStyle(.orange)
                        Text(store.money(lf.balance)).monospacedDigit().foregroundStyle(lf.balance < 0 ? .red : .primary)
                        Text("\(Int(lf.utilization * 100))%").foregroundStyle(lf.utilization > 1 ? .red : (lf.utilization > 0.9 ? .orange : .secondary))
                        Button("Order") {
                            newOrder = PurchaseOrder(title: "", entityId: b.entityId, budgetId: b.id, lineItemId: l.id, status: "", requestedBy: store.data.currentUserId)
                        }
                        .buttonStyle(.link)
                    }
                    .font(.callout)
                }
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }

    private func startNew() {
        let entity = filter.entityId ?? store.data.entities.first!.id
        editing = Budget(entityId: entity, year: filter.year ?? Calendar.current.component(.year, from: Date()),
                         category: store.data.finance.categories.first ?? "General", lineItems: [BudgetLine(name: "General", allocated: 0)])
    }

    /// CSV columns: Entity, Year, Category, Line Item, Allocated, Notes. Rows with the same
    /// entity/year/category become one budget.
    private func importBudgets() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.commaSeparatedText]
        p.message = "CSV columns: Entity, Year, Category, Line Item, Allocated, Notes"
        guard p.runModal() == .OK, let url = p.url, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let rows = ClickUpImporter.parseCSV(text).dropFirst()
        var count = 0
        for r in rows where r.count >= 5 {
            let ename = r[0].trimmingCharacters(in: .whitespaces)
            guard let year = Int(r[1].trimmingCharacters(in: .whitespaces)), let amount = Double(r[4].replacingOccurrences(of: ",", with: "")) else { continue }
            var ent = store.data.entities.first { $0.name.caseInsensitiveCompare(ename) == .orderedSame }
            if ent == nil { ent = FinEntity(name: ename); store.data.entities.append(ent!) }
            let cat = r[2].trimmingCharacters(in: .whitespaces)
            if let i = store.data.budgets.firstIndex(where: { $0.entityId == ent!.id && $0.year == year && $0.category == cat }) {
                store.data.budgets[i].lineItems.append(BudgetLine(name: r[3], allocated: amount, notes: r.count > 5 ? r[5] : ""))
            } else {
                store.data.budgets.append(Budget(entityId: ent!.id, year: year, category: cat, lineItems: [BudgetLine(name: r[3], allocated: amount, notes: r.count > 5 ? r[5] : "")]))
            }
            var s = store.data.finance
            if !s.years.contains(year) { s.years.append(year) }
            if !s.categories.contains(cat) { s.categories.append(cat) }
            store.data.financeSettings = [s]
            count += 1
        }
        store.audit("Imported budgets", "\(count) line items")
        store.lastError = "Imported \(count) budget line item(s)."
    }
}

struct BudgetEditor: View {
    @State var budget: Budget
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    init(budget: Budget) { _budget = State(initialValue: budget) }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Budget") {
                    Picker("Entity", selection: $budget.entityId) { ForEach(store.data.entities) { Text($0.name).tag($0.id) } }
                    Picker("Year", selection: $budget.year) { ForEach(store.data.finance.years.sorted(by: >), id: \.self) { Text(String($0)).tag($0) } }
                    Picker("Category", selection: $budget.category) { ForEach(store.data.finance.categories, id: \.self) { Text($0).tag($0) } }
                    TextField("Notes", text: $budget.notes)
                }
                Section("Line items · total \(store.money(budget.total))") {
                    ForEach($budget.lineItems) { $l in
                        HStack {
                            TextField("Name", text: $l.name)
                            TextField("Allocated", value: $l.allocated, format: .number).frame(width: 120).multilineTextAlignment(.trailing)
                            Button { let id = l.id; DispatchQueue.main.async { budget.lineItems.removeAll { $0.id == id } } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                        }
                    }
                    Button("Add line item") { budget.lineItems.append(BudgetLine(name: "New line", allocated: 0)) }
                }
            }
            .formStyle(.grouped)
            HStack {
                if store.data.budgets.contains(where: { $0.id == budget.id }) {
                    Button("Delete budget", role: .destructive) {
                        store.data.budgets.removeAll { $0.id == budget.id }
                        store.audit("Deleted budget", "\(budget.category) \(budget.year)")
                        dismiss()
                    }
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { save() }.keyboardShortcut(.defaultAction)
            }
            .padding()
        }
        .frame(width: 560, height: 560)
    }

    private func save() {
        if let i = store.data.budgets.firstIndex(where: { $0.id == budget.id }) {
            store.data.budgets[i] = budget
            store.audit("Updated budget", "\(budget.category) \(budget.year) · \(store.money(budget.total))")
        } else {
            store.data.budgets.append(budget)
            store.audit("Created budget", "\(budget.category) \(budget.year) · \(store.money(budget.total))")
        }
        dismiss()
    }
}

// MARK: - Orders

enum OrderScope: String, CaseIterable, Identifiable {
    case all = "All", pending = "Pending", active = "In progress", done = "Done", rejected = "Rejected", mine = "Requested by me", assigned = "Assigned to me"
    var id: String { rawValue }
}

struct OrdersView: View {
    let approvalsOnly: Bool
    @Environment(Store.self) private var store
    @State private var filter = FinanceFilter()
    @State private var scope: OrderScope = .all
    @State private var search = ""
    @State private var openOrder: PurchaseOrder?
    @State private var draft: PurchaseOrder?

    var body: some View {
        let me = store.data.currentUserId
        let orders = store.data.orders.filter { o in
            if approvalsOnly { return store.canApprove(o, member: me) }
            if let e = filter.entityId, o.entityId != e { return false }
            if let y = filter.year, Calendar.current.component(.year, from: o.requestedDate) != y { return false }
            if !search.isEmpty && !(o.title + o.supplier + o.poNumber + o.lpo + "#\(o.number)").localizedCaseInsensitiveContains(search) { return false }
            switch scope {
            case .all: return true
            case .pending: return OrderStatus.isPending(o.status)
            case .active: return [OrderStatus.approved, OrderStatus.ordered, OrderStatus.shipped].contains(o.status)
            case .done: return [OrderStatus.delivered, OrderStatus.completed, OrderStatus.recorded].contains(o.status)
            case .rejected: return [OrderStatus.rejected, OrderStatus.cancelled].contains(o.status)
            case .mine: return o.requestedBy == me
            case .assigned: return o.assignedTo == me
            }
        }.sorted { $0.requestedDate > $1.requestedDate }
        VStack(spacing: 0) {
            HStack {
                if !approvalsOnly {
                    FinanceFilterBar(filter: $filter)
                    Picker("", selection: $scope) { ForEach(OrderScope.allCases) { Text($0.rawValue).tag($0) } }.frame(width: 170)
                    TextField("Search title, supplier, PO…", text: $search).textFieldStyle(.roundedBorder).frame(width: 200)
                } else {
                    Text("Orders waiting for your decision").font(.headline)
                }
                Spacer()
                if !approvalsOnly {
                    Menu {
                        Button("Purchase order") { startDraft(.order) }
                        Button("Direct expense") { startDraft(.expense) }
                    } label: { Label("New", systemImage: "plus") }
                    .fixedSize()
                    .disabled(store.data.entities.isEmpty)
                }
            }
            .padding(12)
            Divider()
            if orders.isEmpty {
                EmptyState(icon: approvalsOnly ? "checkmark.seal" : "shippingbox", title: approvalsOnly ? "Nothing to approve" : "No orders", subtitle: approvalsOnly ? "You're all caught up." : "Raise a purchase order or record an expense.")
            } else {
                Table(orders) {
                    TableColumn("#") { o in Text("\(o.number)").monospacedDigit().foregroundStyle(.secondary) }.width(50)
                    TableColumn("Title") { o in
                        HStack {
                            Image(systemName: o.type == .order ? "shippingbox" : "creditcard").foregroundStyle(.secondary)
                            Text(o.title)
                            if o.isUnbudgeted { Text("Unbudgeted").font(.caption2).foregroundStyle(.red) }
                        }
                    }
                    TableColumn("Entity") { o in Text(store.entity(o.entityId)?.name ?? "—") }.width(120)
                    TableColumn("Supplier") { o in Text(o.supplier) }.width(120)
                    TableColumn("Amount") { o in Text(store.money(o.amount)).monospacedDigit() }.width(110)
                    TableColumn("Status") { o in OrderStatusPill(status: o.status) }.width(150)
                    TableColumn("Requested") { o in
                        HStack { AvatarView(member: store.member(o.requestedBy), size: 16); Text(o.requestedDate.formatted(date: .abbreviated, time: .omitted)) }
                    }.width(130)
                    TableColumn("") { o in Button("Open") { openOrder = o } }.width(60)
                }
                .contextMenu(forSelectionType: PurchaseOrder.ID.self) { _ in } primaryAction: { ids in
                    if let id = ids.first { openOrder = store.order(id) }
                }
            }
        }
        .navigationTitle(approvalsOnly ? "My Approvals" : "Orders & Expenses")
        .sheet(item: $openOrder) { o in OrderDetail(orderId: o.id) }
        .sheet(item: $draft) { d in OrderEditor(draft: d) }
    }

    private func startDraft(_ type: OrderType) {
        draft = PurchaseOrder(type: type, title: "", entityId: filter.entityId ?? store.data.entities.first!.id, status: "", requestedBy: store.data.currentUserId)
    }
}

struct OrderEditor: View {
    @State var draft: PurchaseOrder
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    init(draft: PurchaseOrder) {
        var d = draft
        if d.items.isEmpty { d.items = [OrderLine(name: "")] }
        _draft = State(initialValue: d)
    }

    var body: some View {
        let budgets = store.data.budgets.filter { $0.entityId == draft.entityId }.sorted { $0.year > $1.year }
        let lineFigures = draft.budgetId.flatMap { b in draft.lineItemId.map { store.figures(budget: b, line: $0) } }
        VStack(spacing: 0) {
            Form {
                Section(draft.type.label) {
                    Picker("Type", selection: $draft.type) { ForEach(OrderType.allCases) { Text($0.label).tag($0) } }.pickerStyle(.segmented)
                    TextField("Title *", text: $draft.title)
                    Picker("Entity", selection: $draft.entityId) { ForEach(store.data.entities) { Text($0.name).tag($0.id) } }
                    Picker("Budget", selection: $draft.budgetId) {
                        Text("Unbudgeted").tag(UUID?.none)
                        ForEach(budgets) { Text("\($0.category) \(String($0.year))").tag(Optional($0.id)) }
                    }
                    if let b = store.budget(draft.budgetId) {
                        Picker("Line item", selection: $draft.lineItemId) {
                            Text("Choose…").tag(UUID?.none)
                            ForEach(b.lineItems) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                    if let f = lineFigures {
                        LabeledContent("Remaining on line") {
                            Text(store.money(f.balance - f.pending)).foregroundStyle(f.balance - f.pending < draft.amount ? .red : .green)
                        }
                    } else {
                        Label("Unbudgeted spend needs an extra admin approval.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout)
                    }
                    TextField("Supplier", text: $draft.supplier)
                    TextField("Supplier email", text: $draft.supplierEmail)
                    Picker("Item category", selection: $draft.itemCategory) {
                        Text("—").tag("")
                        ForEach(store.data.finance.itemCategories, id: \.self) { Text($0).tag($0) }
                    }
                    if draft.type == .expense { TextField("LPO / invoice #", text: $draft.lpo) }
                    if draft.type == .order {
                        DatePicker("Expected delivery", selection: Binding(get: { draft.expectedDelivery ?? Date().adding(days: 14) }, set: { draft.expectedDelivery = $0 }), displayedComponents: .date)
                    }
                }
                Section("Items · total \(store.money(draft.amount))") {
                    ForEach($draft.items) { $it in
                        HStack {
                            TextField("Item", text: $it.name)
                            TextField("Qty", value: $it.qty, format: .number).frame(width: 60).multilineTextAlignment(.trailing)
                            TextField("Unit price", value: $it.unitPrice, format: .number).frame(width: 100).multilineTextAlignment(.trailing)
                            Text(store.money(it.total)).frame(width: 110, alignment: .trailing).monospacedDigit()
                            Button { let id = it.id; DispatchQueue.main.async { draft.items.removeAll { $0.id == id } } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                        }
                    }
                    HStack {
                        Button("Add item") { draft.items.append(OrderLine(name: "")) }
                        Menu("From catalog") {
                            ForEach(store.data.catalog.filter { $0.status == "approved" }) { c in
                                Button("\(c.name) · \(store.money(c.unitPrice))") {
                                    draft.items.removeAll { $0.name.isEmpty }
                                    draft.items.append(OrderLine(name: c.name, qty: 1, unitPrice: c.unitPrice, catalogItemId: c.id))
                                    if draft.supplier.isEmpty { draft.supplier = c.supplier }
                                }
                            }
                        }
                        .fixedSize()
                    }
                }
                Section("Notes") { TextField("Justification / notes", text: $draft.notes, axis: .vertical).lineLimit(2...5) }
            }
            .formStyle(.grouped)
            .onChange(of: draft.entityId) { draft.budgetId = nil; draft.lineItemId = nil }
            .onChange(of: draft.budgetId) { draft.lineItemId = nil }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(draft.type == .order ? "Submit for approval" : "Record expense") {
                    draft.items.removeAll { $0.name.trimmingCharacters(in: .whitespaces).isEmpty }
                    store.createOrder(draft)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(draft.title.trimmingCharacters(in: .whitespaces).isEmpty || draft.items.allSatisfy { $0.name.isEmpty } || (draft.budgetId != nil && draft.lineItemId == nil))
            }
            .padding()
        }
        .frame(width: 640, height: 680)
    }
}

struct OrderDetail: View {
    let orderId: UUID
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var poNumber = ""
    @State private var tracking = ""

    var body: some View {
        if let o = store.order(orderId) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("#\(o.number) · \(o.type.label)").font(.caption).foregroundStyle(.secondary)
                        Text(o.title).font(.title2.bold())
                        HStack {
                            OrderStatusPill(status: o.status)
                            if o.isUnbudgeted { Text("UNBUDGETED").font(.caption2.bold()).foregroundStyle(.red) }
                        }
                    }
                    Spacer()
                    Text(store.money(o.amount)).font(.title.bold()).monospacedDigit()
                }
                .padding()
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                            row("Entity", store.entity(o.entityId)?.name ?? "—")
                            row("Budget line", store.budget(o.budgetId).map { b in "\(b.category) \(String(b.year)) › \(store.budgetLine(o.budgetId, o.lineItemId)?.name ?? "")" } ?? "Unbudgeted")
                            row("Supplier", [o.supplier, o.supplierEmail].filter { !$0.isEmpty }.joined(separator: " · "))
                            row("Requested by", "\(store.member(o.requestedBy)?.name ?? "—") on \(o.requestedDate.formatted(date: .abbreviated, time: .shortened))")
                            if !o.poNumber.isEmpty { row("PO number", o.poNumber) }
                            if !o.lpo.isEmpty { row("LPO / invoice", o.lpo) }
                            if let d = o.expectedDelivery { row("Expected delivery", d.formatted(date: .abbreviated, time: .omitted)) }
                            if !o.trackingNumber.isEmpty { row("Tracking", o.trackingNumber) }
                            if let d = o.actualDelivery { row("Delivered", d.formatted(date: .abbreviated, time: .omitted)) }
                            GridRow {
                                Text("Assigned to").foregroundStyle(.secondary)
                                Picker("", selection: Binding(get: { o.assignedTo }, set: { store.assignOrder(o.id, to: $0) })) {
                                    Text("Unassigned").tag(UUID?.none)
                                    ForEach(store.data.members) { Text($0.name).tag(Optional($0.id)) }
                                }
                                .labelsHidden().frame(width: 200)
                            }
                        }
                        .font(.callout)

                        VStack(alignment: .leading, spacing: 4) {
                            Text("Items").font(.headline)
                            ForEach(o.items) { it in
                                HStack {
                                    Text(it.name)
                                    Spacer()
                                    Text("\(it.qty.formatted()) × \(store.money(it.unitPrice))").foregroundStyle(.secondary)
                                    Text(store.money(it.total)).monospacedDigit().frame(width: 120, alignment: .trailing)
                                }
                                .font(.callout)
                            }
                        }
                        if !o.notes.isEmpty { Text(o.notes).font(.callout).foregroundStyle(.secondary) }

                        actions(o)

                        VStack(alignment: .leading, spacing: 6) {
                            Text("History").font(.headline)
                            ForEach(o.history.reversed()) { e in
                                HStack(alignment: .top) {
                                    AvatarView(member: store.member(e.memberId), size: 18)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text("\(e.action)\(e.to.isEmpty ? "" : " → \(e.to)")").font(.callout)
                                        if !e.note.isEmpty { Text(e.note).font(.caption).foregroundStyle(.secondary) }
                                    }
                                    Spacer()
                                    Text(e.date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .padding()
                }
                Divider()
                HStack {
                    if o.requestedBy == store.data.currentUserId && OrderStatus.isPending(o.status) {
                        Button("Withdraw", role: .destructive) { store.setOrderStatus(o.id, OrderStatus.cancelled, note: "Withdrawn by requester") }
                    }
                    if store.isFinanceAdmin {
                        Button("Delete", role: .destructive) { store.data.orders.removeAll { $0.id == o.id }; store.audit("Deleted order #\(o.number)", o.title); dismiss() }
                    }
                    Spacer()
                    Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                }
                .padding()
            }
            .frame(width: 640, height: 720)
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        GridRow { Text(k).foregroundStyle(.secondary); Text(v.isEmpty ? "—" : v).textSelection(.enabled) }
    }

    @ViewBuilder
    private func actions(_ o: PurchaseOrder) -> some View {
        let canApprove = store.canApprove(o, member: store.data.currentUserId)
        let next = store.fulfilmentActions(o)
        if canApprove || !next.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(canApprove ? "Your decision" : "Fulfilment").font(.headline)
                TextField("Note (optional)", text: $note)
                if canApprove {
                    HStack {
                        if store.nextStatus(after: o.status, order: o) == nil && o.type == .order { TextField("PO number", text: $poNumber).frame(width: 160) }
                        Spacer()
                        Button("Reject", role: .destructive) { store.reject(o.id, reason: note.isEmpty ? "No reason given" : note); note = "" }
                        Button("Approve") { store.approve(o.id, note: note, poNumber: poNumber); note = "" }.buttonStyle(.borderedProminent)
                    }
                } else {
                    HStack {
                        if next.contains(OrderStatus.ordered) { TextField("PO number", text: $poNumber).frame(width: 140) }
                        if next.contains(OrderStatus.shipped) { TextField("Tracking #", text: $tracking).frame(width: 140) }
                        Spacer()
                        ForEach(next, id: \.self) { s in
                            Button("Mark \(s)") {
                                if s == OrderStatus.ordered && !poNumber.isEmpty { store.updateOrder(o.id) { $0.poNumber = poNumber } }
                                store.setOrderStatus(o.id, s, note: note, tracking: tracking)
                                note = ""
                            }
                            .buttonStyle(.bordered)
                            .tint(s == OrderStatus.cancelled ? Color.red : Color.accentColor)
                        }
                    }
                }
            }
            .padding(12)
            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

// MARK: - Catalog / shopping portal

struct CartLine: Identifiable, Hashable {
    let id: UUID
    var qty: Double
}

struct CatalogView: View {
    @Environment(Store.self) private var store
    @State private var search = ""
    @State private var category = ""
    @State private var cart: [CartLine] = []
    @State private var checkout: PurchaseOrder?
    @State private var newItem: CatalogItem?

    var body: some View {
        let items = store.data.catalog.filter { $0.status == "approved" && (category.isEmpty || $0.category == category) && (search.isEmpty || ($0.name + $0.supplier).localizedCaseInsensitiveContains(search)) }
        let pending = store.data.catalog.filter { $0.status == "pending" }
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack {
                    TextField("Search catalog", text: $search).textFieldStyle(.roundedBorder).frame(width: 240)
                    Picker("", selection: $category) {
                        Text("All categories").tag("")
                        ForEach(store.data.finance.itemCategories, id: \.self) { Text($0).tag($0) }
                    }
                    .frame(width: 180)
                    Spacer()
                    Button { newItem = CatalogItem(name: "", category: store.data.finance.itemCategories.first ?? "", addedBy: store.data.currentUserId) } label: {
                        Label(store.isFinanceAdmin ? "Add item" : "Request new item", systemImage: "plus")
                    }
                }
                .padding(12)
                Divider()
                ScrollView {
                    if store.isFinanceAdmin && !pending.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Awaiting approval").font(.headline)
                            ForEach(pending) { c in
                                HStack {
                                    Text(c.name)
                                    Text("\(c.category) · \(store.money(c.unitPrice)) · requested by \(store.member(c.addedBy)?.name ?? "—")").font(.caption).foregroundStyle(.secondary)
                                    Spacer()
                                    Button("Reject") { setStatus(c.id, "rejected") }
                                    Button("Approve") { setStatus(c.id, "approved") }.buttonStyle(.borderedProminent)
                                }
                            }
                        }
                        .padding(12)
                        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                        .padding(12)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 12)], spacing: 12) {
                        ForEach(items) { c in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(c.category.uppercased()).font(.caption2.bold()).foregroundStyle(.secondary)
                                Text(c.name).font(.headline).lineLimit(2)
                                Text(c.supplier).font(.caption).foregroundStyle(.secondary)
                                HStack {
                                    Text("\(store.money(c.unitPrice)) / \(c.unit)").monospacedDigit()
                                    Spacer()
                                    Button { add(c.id) } label: { Image(systemName: "cart.badge.plus") }.buttonStyle(.borderedProminent)
                                }
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
                            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                            .contextMenu {
                                if store.isFinanceAdmin {
                                    Button("Edit") { newItem = c }
                                    Button("Remove", role: .destructive) { store.data.catalog.removeAll { $0.id == c.id } }
                                }
                            }
                        }
                    }
                    .padding(12)
                    if items.isEmpty { EmptyState(icon: "cart", title: "Catalog is empty", subtitle: "Add approved items so people can order them in a few clicks.").frame(height: 260) }
                }
            }
            Divider()
            cartPanel.frame(width: 300)
        }
        .navigationTitle("Shopping Catalog")
        .sheet(item: $checkout) { o in OrderEditor(draft: o) }
        .sheet(item: $newItem) { i in CatalogItemEditor(item: i) }
    }

    private var cartPanel: some View {
        let lines = cart.compactMap { l in store.data.catalog.first { $0.id == l.id }.map { (l, $0) } }
        let total = lines.reduce(0) { $0 + $1.0.qty * $1.1.unitPrice }
        return VStack(alignment: .leading, spacing: 10) {
            Label("Cart", systemImage: "cart").font(.headline)
            if lines.isEmpty { Text("Add items from the catalog.").foregroundStyle(.secondary) }
            ForEach(lines, id: \.0.id) { l, c in
                HStack {
                    Text(c.name).lineLimit(1)
                    Spacer()
                    Stepper("\(Int(l.qty))", value: Binding(get: { l.qty }, set: { q in if let i = cart.firstIndex(where: { $0.id == l.id }) { cart[i].qty = q } }), in: 1...9999)
                        .fixedSize()
                    Button { cart.removeAll { $0.id == l.id } } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                }
                .font(.callout)
            }
            Divider()
            HStack { Text("Total"); Spacer(); Text(store.money(total)).bold().monospacedDigit() }
            Button("Checkout → create order") {
                guard let e = store.data.entities.first else { return }
                var o = PurchaseOrder(title: "Catalog order", entityId: e.id, status: "", requestedBy: store.data.currentUserId)
                o.items = lines.map { OrderLine(name: $0.1.name, qty: $0.0.qty, unitPrice: $0.1.unitPrice, catalogItemId: $0.1.id) }
                o.supplier = Set(lines.map(\.1.supplier)).count == 1 ? lines.first!.1.supplier : ""
                checkout = o
                cart = []
            }
            .buttonStyle(.borderedProminent)
            .disabled(lines.isEmpty || store.data.entities.isEmpty)
            Spacer()
        }
        .padding(14)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func add(_ id: UUID) {
        if let i = cart.firstIndex(where: { $0.id == id }) { cart[i].qty += 1 } else { cart.append(CartLine(id: id, qty: 1)) }
    }

    private func setStatus(_ id: UUID, _ s: String) {
        if let i = store.data.catalog.firstIndex(where: { $0.id == id }) {
            store.data.catalog[i].status = s
            store.audit("Catalog item \(s)", store.data.catalog[i].name)
        }
    }
}

struct CatalogItemEditor: View {
    @State var item: CatalogItem
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    init(item: CatalogItem) { _item = State(initialValue: item) }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                TextField("Name", text: $item.name)
                Picker("Category", selection: $item.category) { ForEach(store.data.finance.itemCategories, id: \.self) { Text($0).tag($0) } }
                TextField("Unit price", value: $item.unitPrice, format: .number)
                TextField("Unit", text: $item.unit)
                TextField("Supplier", text: $item.supplier)
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button(store.isFinanceAdmin ? "Save" : "Submit request") {
                    if let i = store.data.catalog.firstIndex(where: { $0.id == item.id }) { store.data.catalog[i] = item } else { store.requestCatalogItem(item) }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(item.name.isEmpty)
            }
            .padding()
        }
        .frame(width: 420, height: 340)
    }
}

// MARK: - Contracts

struct ContractsView: View {
    @Environment(Store.self) private var store
    @State private var editing: Contract?
    @State private var statusFilter = ""

    var body: some View {
        let contracts = store.data.contracts.filter { statusFilter.isEmpty || $0.status() == statusFilter }.sorted { $0.endDate < $1.endDate }
        let active = store.data.contracts.filter { ["Active", "Expiring"].contains($0.status()) }
        VStack(spacing: 0) {
            HStack {
                Picker("Status", selection: $statusFilter) {
                    Text("All").tag("")
                    ForEach(["Active", "Expiring", "Expired", "Renewing", "Upcoming", "Terminated"], id: \.self) { Text($0).tag($0) }
                }
                .frame(width: 200)
                Spacer()
                Button("Export CSV") { export() }
                Button { editing = Contract(title: "", supplier: "", type: store.data.finance.contractTypes.first ?? "", startDate: Date(), endDate: Date().adding(days: 365)) } label: { Label("New Contract", systemImage: "plus") }
                    .buttonStyle(.borderedProminent)
            }
            .padding(12)
            HStack(spacing: 10) {
                KPI(title: "Active contracts", value: "\(active.count)", color: .green, icon: "doc.plaintext")
                KPI(title: "Active value", value: store.money(active.reduce(0) { $0 + $1.value }), color: .indigo, icon: "banknote")
                KPI(title: "Expiring in 60 days", value: "\(store.data.contracts.filter { $0.status() == "Expiring" }.count)", color: .orange, icon: "clock.badge.exclamationmark")
                KPI(title: "Expired", value: "\(store.data.contracts.filter { $0.status() == "Expired" }.count)", color: .red, icon: "xmark.octagon")
            }
            .padding(.horizontal, 12)
            Divider().padding(.top, 10)
            Table(contracts) {
                TableColumn("Contract") { c in Text(c.title).bold() }
                TableColumn("Supplier") { c in Text(c.supplier) }
                TableColumn("Type") { c in Text(c.type) }.width(100)
                TableColumn("Entity") { c in Text(store.entity(c.entityId)?.name ?? "—") }.width(110)
                TableColumn("Value") { c in Text(store.money(c.value)).monospacedDigit() }.width(110)
                TableColumn("Ends") { c in Text(c.endDate.formatted(date: .abbreviated, time: .omitted)) }.width(100)
                TableColumn("Status") { c in OrderStatusPill(status: c.status()) }.width(90)
                TableColumn("") { c in Button("Edit") { editing = c } }.width(50)
            }
        }
        .navigationTitle("Contracts")
        .sheet(item: $editing) { c in ContractEditor(contract: c) }
    }

    private func export() {
        var lines = ["Title,Supplier,Type,Entity,Value,Start,End,Auto renew,Status,Contact,Email,Phone,Notes"]
        for c in store.data.contracts {
            lines.append([csvEscape(c.title), csvEscape(c.supplier), csvEscape(c.type), csvEscape(store.entity(c.entityId)?.name ?? ""), String(c.value),
                          c.startDate.formatted(.iso8601.year().month().day()), c.endDate.formatted(.iso8601.year().month().day()),
                          c.autoRenew ? "Yes" : "No", c.status(), csvEscape(c.contact), csvEscape(c.email), csvEscape(c.phone), csvEscape(c.notes)].joined(separator: ","))
        }
        saveText(lines.joined(separator: "\n"), name: "contracts.csv")
    }
}

struct ContractEditor: View {
    @State var contract: Contract
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    init(contract: Contract) { _contract = State(initialValue: contract) }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Contract") {
                    TextField("Title", text: $contract.title)
                    TextField("Supplier", text: $contract.supplier)
                    Picker("Type", selection: $contract.type) { ForEach(store.data.finance.contractTypes, id: \.self) { Text($0).tag($0) } }
                    Picker("Entity", selection: $contract.entityId) {
                        Text("Whole organization").tag(UUID?.none)
                        ForEach(store.data.entities) { Text($0.name).tag(Optional($0.id)) }
                    }
                    TextField("Value", value: $contract.value, format: .number)
                    DatePicker("Start", selection: $contract.startDate, displayedComponents: .date)
                    DatePicker("End", selection: $contract.endDate, displayedComponents: .date)
                    Toggle("Renews automatically", isOn: $contract.autoRenew)
                    Toggle("Terminated", isOn: $contract.terminated)
                }
                Section("Contact") {
                    TextField("Name", text: $contract.contact)
                    TextField("Email", text: $contract.email)
                    TextField("Phone", text: $contract.phone)
                    TextField("Notes", text: $contract.notes, axis: .vertical)
                }
            }
            .formStyle(.grouped)
            HStack {
                if store.data.contracts.contains(where: { $0.id == contract.id }) {
                    Button("Delete", role: .destructive) { store.data.contracts.removeAll { $0.id == contract.id }; store.audit("Deleted contract", contract.title); dismiss() }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    if let i = store.data.contracts.firstIndex(where: { $0.id == contract.id }) { store.data.contracts[i] = contract } else { store.data.contracts.append(contract) }
                    store.audit("Saved contract", "\(contract.title) · \(contract.supplier)")
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(contract.title.isEmpty)
            }
            .padding()
        }
        .frame(width: 520, height: 620)
    }
}

// MARK: - Savings

struct SavingsView: View {
    @Environment(Store.self) private var store
    @State private var filter = FinanceFilter()
    @State private var editing: Saving?

    var body: some View {
        let items = store.data.savings.filter { (filter.entityId == nil || $0.entityId == filter.entityId) && (filter.year == nil || Calendar.current.component(.year, from: $0.date) == filter.year) }
            .sorted { $0.date > $1.date }
        let byType = Dictionary(grouping: items, by: \.type).mapValues { $0.reduce(0) { $0 + $1.amount } }
        VStack(spacing: 0) {
            HStack {
                FinanceFilterBar(filter: $filter)
                Spacer()
                Button { editing = Saving(entityId: filter.entityId ?? store.data.entities.first?.id ?? UUID(), type: store.data.finance.savingsTypes.first ?? "Negotiation", amount: 0, recordedBy: store.data.currentUserId) } label: {
                    Label("Record Saving", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent).disabled(store.data.entities.isEmpty)
            }
            .padding(12)
            HStack(spacing: 10) {
                KPI(title: "Total savings", value: store.money(items.reduce(0) { $0 + $1.amount }), color: .green, icon: "dollarsign.arrow.circlepath")
                ForEach(byType.sorted { $0.value > $1.value }.prefix(3), id: \.key) { t, v in KPI(title: t, value: store.money(v), color: .teal, icon: "tag") }
            }
            .padding(.horizontal, 12)
            Divider().padding(.top, 10)
            Table(items) {
                TableColumn("Date") { s in Text(s.date.formatted(date: .abbreviated, time: .omitted)) }.width(100)
                TableColumn("Entity") { s in Text(store.entity(s.entityId)?.name ?? "—") }.width(120)
                TableColumn("Type") { s in Text(s.type) }.width(130)
                TableColumn("Description") { s in Text(s.description) }
                TableColumn("LPO") { s in Text(s.lpo) }.width(90)
                TableColumn("Amount") { s in Text(store.money(s.amount)).monospacedDigit().foregroundStyle(.green) }.width(110)
                TableColumn("") { s in Button("Edit") { editing = s } }.width(50)
            }
        }
        .navigationTitle("Savings")
        .sheet(item: $editing) { s in SavingEditor(saving: s) }
    }
}

struct SavingEditor: View {
    @State var saving: Saving
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    init(saving: Saving) { _saving = State(initialValue: saving) }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Picker("Entity", selection: $saving.entityId) { ForEach(store.data.entities) { Text($0.name).tag($0.id) } }
                Picker("Budget", selection: $saving.budgetId) {
                    Text("None").tag(UUID?.none)
                    ForEach(store.data.budgets.filter { $0.entityId == saving.entityId }) { Text("\($0.category) \(String($0.year))").tag(Optional($0.id)) }
                }
                if let b = store.budget(saving.budgetId) {
                    Picker("Line item", selection: $saving.lineItemId) {
                        Text("None").tag(UUID?.none)
                        ForEach(b.lineItems) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
                Picker("Type", selection: $saving.type) { ForEach(store.data.finance.savingsTypes, id: \.self) { Text($0).tag($0) } }
                TextField("Amount", value: $saving.amount, format: .number)
                DatePicker("Date", selection: $saving.date, displayedComponents: .date)
                TextField("Description", text: $saving.description)
                TextField("LPO", text: $saving.lpo)
            }
            .formStyle(.grouped)
            HStack {
                if store.data.savings.contains(where: { $0.id == saving.id }) {
                    Button("Delete", role: .destructive) { store.data.savings.removeAll { $0.id == saving.id }; dismiss() }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    if let i = store.data.savings.firstIndex(where: { $0.id == saving.id }) { store.data.savings[i] = saving } else { store.data.savings.append(saving) }
                    store.audit("Recorded saving", "\(saving.type) · \(store.money(saving.amount))")
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(saving.amount <= 0)
            }
            .padding()
        }
        .frame(width: 480, height: 520)
    }
}
