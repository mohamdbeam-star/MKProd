import Foundation

/// Totals for one budget line (or a whole budget when summed).
struct LineFigures {
    var allocated = 0.0
    var spent = 0.0
    var committed = 0.0
    var pending = 0.0
    var savings = 0.0

    var balance: Double { allocated - spent - committed }
    var utilization: Double { allocated > 0 ? (spent + committed) / allocated : 0 }

    static func + (a: LineFigures, b: LineFigures) -> LineFigures {
        LineFigures(allocated: a.allocated + b.allocated, spent: a.spent + b.spent, committed: a.committed + b.committed,
                    pending: a.pending + b.pending, savings: a.savings + b.savings)
    }
}

enum UnbudgetedStep {
    static let status = "Pending Unbudgeted Approval"
}

extension Store {
    // MARK: Lookups

    func entity(_ id: UUID?) -> FinEntity? { data.entities.first { $0.id == id } }
    func budget(_ id: UUID?) -> Budget? { data.budgets.first { $0.id == id } }
    func order(_ id: UUID?) -> PurchaseOrder? { data.orders.first { $0.id == id } }
    func budgetLine(_ budgetId: UUID?, _ lineId: UUID?) -> BudgetLine? { budget(budgetId)?.lineItems.first { $0.id == lineId } }

    /// Owners and admins (or anyone, when working offline) can manage finance settings and approve anything.
    var isFinanceAdmin: Bool { !cloud.isConnected || cloud.isAdmin }

    func money(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 0
        return "\(data.finance.currency) \(f.string(from: NSNumber(value: v)) ?? String(v))"
    }

    // MARK: Budget arithmetic

    /// An order's money is "spent" once delivered (or recorded/approved for direct expenses),
    /// "committed" between approval and delivery, and "pending" while awaiting approval.
    func figures(budget b: UUID, line: UUID) -> LineFigures {
        var f = LineFigures(allocated: budgetLine(b, line)?.allocated ?? 0)
        for o in data.orders where o.budgetId == b && o.lineItemId == line {
            if o.type == .expense {
                if o.status == OrderStatus.recorded || o.status == OrderStatus.approved { f.spent += o.amount }
                else if OrderStatus.isPending(o.status) { f.pending += o.amount }
            } else if OrderStatus.isSpent(o.status) { f.spent += o.amount }
            else if OrderStatus.isCommitted(o.status) { f.committed += o.amount }
            else if OrderStatus.isPending(o.status) { f.pending += o.amount }
        }
        f.savings = data.savings.filter { $0.budgetId == b && $0.lineItemId == line }.reduce(0) { $0 + $1.amount }
        return f
    }

    func figures(budget b: Budget) -> LineFigures {
        b.lineItems.map { figures(budget: b.id, line: $0.id) }.reduce(LineFigures(), +)
    }

    // MARK: Order workflow

    func initialStatus(for entityId: UUID, type: OrderType, unbudgeted: Bool) -> String {
        if type == .expense { return unbudgeted ? UnbudgetedStep.status : OrderStatus.recorded }
        let levels = entity(entityId)?.approvalLevels.filter { $0 != "Requestor" } ?? []
        return levels.first.map { "Pending \($0)" } ?? "Pending Approval"
    }

    /// The status after the current approval step, or nil when this was the final step.
    func nextStatus(after current: String, order o: PurchaseOrder) -> String? {
        if current == UnbudgetedStep.status { return nil }
        let levels = entity(o.entityId)?.approvalLevels.filter { $0 != "Requestor" } ?? []
        let role = current.replacingOccurrences(of: "Pending ", with: "")
        if let i = levels.firstIndex(of: role), i + 1 < levels.count { return "Pending \(levels[i + 1])" }
        // Spending outside a budget needs a final sign-off from an admin.
        return o.isUnbudgeted ? UnbudgetedStep.status : nil
    }

    func canApprove(_ o: PurchaseOrder, member: UUID) -> Bool {
        guard OrderStatus.isPending(o.status), o.status != "Pending" else { return false }
        if o.status == UnbudgetedStep.status { return member == data.currentUserId ? isFinanceAdmin : cloud.team.first { $0.id == member }.map { $0.role == "owner" || $0.role == "admin" } ?? false }
        if member == data.currentUserId && isFinanceAdmin { return true }
        guard let role = entity(o.entityId)?.role(of: member), role != "Requestor" else { return false }
        return o.status == "Pending \(role)" || o.status == "Pending Approval"
    }

    func nextOrderNumber() -> Int {
        max(data.finance.nextOrderNumber, (data.orders.map(\.number).max() ?? 1000) + 1)
    }

    @discardableResult
    func createOrder(_ draft: PurchaseOrder) -> PurchaseOrder {
        var o = draft
        o.number = nextOrderNumber()
        o.isUnbudgeted = o.budgetId == nil || o.lineItemId == nil
        o.status = initialStatus(for: o.entityId, type: o.type, unbudgeted: o.isUnbudgeted)
        o.requestedBy = data.currentUserId
        o.requestedDate = Date()
        o.history = [OrderEvent(memberId: data.currentUserId, action: o.type == .expense ? "Recorded" : "Submitted", to: o.status)]
        o.updated = Date()
        data.orders.append(o)
        if var s = data.financeSettings.first { s.nextOrderNumber = o.number + 1; data.financeSettings = [s] }
        audit("Created \(o.type.label.lowercased()) #\(o.number)", "\(o.title) · \(money(o.amount))")
        if let line = budgetLine(o.budgetId, o.lineItemId), let b = o.budgetId {
            let f = figures(budget: b, line: line.id)
            if f.spent + f.committed + f.pending > f.allocated {
                notify("Order #\(o.number) exceeds the remaining budget on \(line.name)", taskId: nil)
            }
        }
        return o
    }

    /// `change` works on a copy, so it may read `data` freely.
    func updateOrder(_ id: UUID, _ change: (inout PurchaseOrder) -> Void) {
        guard let i = data.orders.firstIndex(where: { $0.id == id }) else { return }
        var o = data.orders[i]
        change(&o)
        o.updated = Date()
        data.orders[i] = o
    }

    func approve(_ id: UUID, note: String = "", poNumber: String = "") {
        guard let o = order(id), canApprove(o, member: data.currentUserId) else { return }
        let next = nextStatus(after: o.status, order: o)
        updateOrder(id) { x in
            if !poNumber.isEmpty { x.poNumber = poNumber }
            x.status = next ?? OrderStatus.approved
            if next == nil { x.approvedBy = self.data.currentUserId; x.approvedDate = Date() }
            x.history.append(OrderEvent(memberId: self.data.currentUserId, action: "Approved", from: o.status, to: x.status, note: note))
        }
        audit("Approved order #\(o.number)", note)
    }

    func reject(_ id: UUID, reason: String) {
        guard let o = order(id), canApprove(o, member: data.currentUserId) else { return }
        updateOrder(id) { x in
            x.status = OrderStatus.rejected
            x.history.append(OrderEvent(memberId: self.data.currentUserId, action: "Rejected", from: o.status, to: x.status, note: reason))
        }
        audit("Rejected order #\(o.number)", reason)
    }

    func setOrderStatus(_ id: UUID, _ status: String, note: String = "", tracking: String = "", delivered: Date? = nil) {
        guard let o = order(id) else { return }
        updateOrder(id) { x in
            x.status = status
            if !tracking.isEmpty { x.trackingNumber = tracking }
            if status == OrderStatus.delivered { x.actualDelivery = delivered ?? Date(); if !note.isEmpty { x.deliveryNotes = note } }
            x.history.append(OrderEvent(memberId: self.data.currentUserId, action: "Status changed", from: o.status, to: status, note: note))
        }
        audit("Order #\(o.number) → \(status)", note)
    }

    func assignOrder(_ id: UUID, to member: UUID?) {
        guard let o = order(id) else { return }
        updateOrder(id) { x in
            x.assignedTo = member
            x.history.append(OrderEvent(memberId: self.data.currentUserId, action: "Assigned", note: self.member(member)?.name ?? "Unassigned"))
        }
        audit("Assigned order #\(o.number)", self.member(member)?.name ?? "Unassigned")
    }

    /// Next fulfilment steps available for an approved order.
    func fulfilmentActions(_ o: PurchaseOrder) -> [String] {
        guard o.type == .order else { return [] }
        switch o.status {
        case OrderStatus.approved: return [OrderStatus.ordered, OrderStatus.cancelled]
        case OrderStatus.ordered: return [OrderStatus.shipped, OrderStatus.delivered, OrderStatus.cancelled]
        case OrderStatus.shipped: return [OrderStatus.delivered]
        case OrderStatus.delivered: return [OrderStatus.completed]
        default: return []
        }
    }

    // MARK: Catalog

    func requestCatalogItem(_ item: CatalogItem) {
        var i = item
        i.addedBy = data.currentUserId
        i.status = isFinanceAdmin ? "approved" : "pending"
        data.catalog.append(i)
        audit("Catalog item \(i.status == "approved" ? "added" : "requested")", i.name)
    }

    // MARK: Audit & alerts

    func audit(_ action: String, _ details: String = "") {
        data.audit.append(AuditEntry(memberId: data.currentUserId, action: action, details: details))
        if data.audit.count > 5000 { data.audit.removeFirst(data.audit.count - 5000) }
    }

    struct FinanceAlert: Identifiable {
        let id = UUID()
        let severity: Int // 2 critical, 1 warning, 0 info
        let title: String
        let detail: String
        let target: SidebarItem
    }

    var financeAlerts: [FinanceAlert] {
        var out: [FinanceAlert] = []
        for b in data.budgets {
            let ename = entity(b.entityId)?.name ?? ""
            for l in b.lineItems {
                let f = figures(budget: b.id, line: l.id)
                guard l.allocated > 0 else { continue }
                if f.utilization > 1 {
                    out.append(.init(severity: 2, title: "Over budget: \(l.name)", detail: "\(ename) · \(b.category) \(b.year) · \(Int(f.utilization * 100))% used", target: .finBudgets))
                } else if f.utilization >= 0.9 {
                    out.append(.init(severity: 1, title: "Nearly exhausted: \(l.name)", detail: "\(ename) · \(Int(f.utilization * 100))% used, \(money(f.balance)) left", target: .finBudgets))
                }
            }
        }
        for c in data.contracts {
            switch c.status() {
            case "Expired": out.append(.init(severity: 2, title: "Contract expired: \(c.title)", detail: "\(c.supplier) · ended \(c.endDate.formatted(date: .abbreviated, time: .omitted))", target: .finContracts))
            case "Expiring": out.append(.init(severity: 1, title: "Contract expiring: \(c.title)", detail: "\(c.supplier) · ends \(c.endDate.formatted(date: .abbreviated, time: .omitted))", target: .finContracts))
            default: break
            }
        }
        let mine = data.orders.filter { canApprove($0, member: data.currentUserId) }
        if !mine.isEmpty { out.append(.init(severity: 1, title: "\(mine.count) order(s) waiting for your approval", detail: mine.prefix(3).map(\.title).joined(separator: ", "), target: .finApprovals)) }
        let late = data.orders.filter { $0.type == .order && [OrderStatus.ordered, OrderStatus.shipped].contains($0.status) && ($0.expectedDelivery ?? .distantFuture) < Date().startOfDay }
        for o in late { out.append(.init(severity: 1, title: "Late delivery: #\(o.number) \(o.title)", detail: "Expected \(o.expectedDelivery!.formatted(date: .abbreviated, time: .omitted))", target: .finOrders)) }
        let pendingCatalog = data.catalog.filter { $0.status == "pending" }.count
        if pendingCatalog > 0 && isFinanceAdmin { out.append(.init(severity: 0, title: "\(pendingCatalog) catalog item(s) awaiting approval", detail: "", target: .finCatalog)) }
        return out.sorted { $0.severity > $1.severity }
    }
}
