import Foundation

// Budget & procurement module, carried over from the Bukhatir Budget Tracker:
// entities with approval chains, budgets with line items, orders/expenses with an
// approval workflow, savings, contracts, an item catalog and an audit log.

struct EntityRoleAssignment: Codable, Hashable {
    var memberId: UUID
    var role: String
}

/// A department, school or company unit that owns budgets and raises orders.
struct FinEntity: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var code: String = ""
    /// Approval chain in order. "Requestor" is the level that raises orders and never approves.
    var approvalLevels: [String] = ["Requestor", "Manager", "Entity Manager"]
    var roles: [EntityRoleAssignment] = []

    func role(of member: UUID) -> String? { roles.first { $0.memberId == member }?.role }
}

struct BudgetLine: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var allocated: Double
    var notes: String = ""
}

struct Budget: Identifiable, Codable, Hashable {
    var id = UUID()
    var entityId: UUID
    var year: Int
    var category: String
    var notes: String = ""
    var lineItems: [BudgetLine] = []
    var created = Date()

    var total: Double { lineItems.reduce(0) { $0 + $1.allocated } }
}

enum OrderType: String, Codable, CaseIterable, Identifiable {
    case order, expense
    var id: String { rawValue }
    var label: String { self == .order ? "Purchase order" : "Direct expense" }
}

struct OrderLine: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var qty: Double = 1
    var unitPrice: Double = 0
    var catalogItemId: UUID?

    var total: Double { qty * unitPrice }
}

struct OrderEvent: Identifiable, Codable, Hashable {
    var id = UUID()
    var date = Date()
    var memberId: UUID
    var action: String
    var from: String = ""
    var to: String = ""
    var note: String = ""
}

enum OrderStatus {
    static let approved = "Approved"
    static let ordered = "Ordered"
    static let shipped = "Shipped"
    static let delivered = "Delivered"
    static let completed = "Completed"
    static let rejected = "Rejected"
    static let cancelled = "Cancelled"
    static let recorded = "Recorded"
    static let fulfilment = [ordered, shipped, delivered, completed]

    static func isPending(_ s: String) -> Bool { s.hasPrefix("Pending") }
    /// Money is committed once approved and until delivered.
    static func isCommitted(_ s: String) -> Bool { [approved, ordered, shipped].contains(s) }
    static func isSpent(_ s: String) -> Bool { [delivered, completed, recorded].contains(s) }
}

struct PurchaseOrder: Identifiable, Codable, Hashable {
    var id = UUID()
    var number: Int = 0
    var type: OrderType = .order
    var title: String
    var entityId: UUID
    var budgetId: UUID?
    var lineItemId: UUID?
    var supplier: String = ""
    var supplierEmail: String = ""
    var items: [OrderLine] = []
    var currency: String = "AED"
    var poNumber: String = ""
    var lpo: String = ""
    var itemCategory: String = ""
    var status: String
    var isUnbudgeted = false
    var requestedBy: UUID
    var requestedDate = Date()
    var expectedDelivery: Date?
    var actualDelivery: Date?
    var trackingNumber: String = ""
    var deliveryNotes: String = ""
    var assignedTo: UUID?
    var approvedBy: UUID?
    var approvedDate: Date?
    var notes: String = ""
    var history: [OrderEvent] = []
    var updated = Date()

    var amount: Double { items.reduce(0) { $0 + $1.total } }
}

struct Saving: Identifiable, Codable, Hashable {
    var id = UUID()
    var entityId: UUID
    var budgetId: UUID?
    var lineItemId: UUID?
    var type: String
    var amount: Double
    var date = Date()
    var description: String = ""
    var lpo: String = ""
    var recordedBy: UUID
}

struct Contract: Identifiable, Codable, Hashable {
    var id = UUID()
    var entityId: UUID?
    var title: String
    var supplier: String
    var type: String = ""
    var value: Double = 0
    var startDate: Date
    var endDate: Date
    var autoRenew = false
    var terminated = false
    var contact: String = ""
    var email: String = ""
    var phone: String = ""
    var notes: String = ""

    func status(today: Date = Date()) -> String {
        if terminated { return "Terminated" }
        if endDate < today.startOfDay { return autoRenew ? "Renewing" : "Expired" }
        if endDate < today.adding(days: 60) { return "Expiring" }
        if startDate > today { return "Upcoming" }
        return "Active"
    }
}

struct CatalogItem: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var category: String = ""
    var unitPrice: Double = 0
    var unit: String = "pcs"
    var supplier: String = ""
    var status: String = "approved" // pending | approved | rejected
    var addedBy: UUID
    var addedDate = Date()
}

struct AuditEntry: Identifiable, Codable, Hashable {
    var id = UUID()
    var date = Date()
    var memberId: UUID
    var action: String
    var details: String = ""
}

/// One per workspace: the lists that feed pickers across the finance module.
/// "While I'm away, `to` may approve whatever `from` could approve", until the end of `until`.
struct Delegation: Identifiable, Codable, Hashable {
    var id = UUID()
    var from: UUID
    var to: UUID
    var until: Date
    var note: String = ""
}

struct FinanceSettings: Identifiable, Codable, Hashable {
    static let singletonId = UUID(uuidString: "F1A2C3E4-0000-4000-8000-000000000001")!
    var id = FinanceSettings.singletonId
    var currency: String = "AED"
    var years: [Int] = [Calendar.current.component(.year, from: Date())]
    var categories: [String] = ["Operations", "IT", "Facilities", "Marketing", "Training"]
    var contractTypes: [String] = ["Service", "Maintenance", "Supply", "Lease", "License"]
    var itemCategories: [String] = ["Stationery", "IT Equipment", "Furniture", "Cleaning", "Other"]
    var savingsTypes: [String] = ["Negotiation", "Alternative supplier", "Bulk discount", "Cancelled need"]
    var nextOrderNumber: Int = 1001
    /// Optional so settings saved by older clients still decode; managed on the website.
    var delegations: [Delegation]?

    func activeDelegations(now: Date = Date()) -> [Delegation] {
        (delegations ?? []).filter { $0.until >= now }
    }
}
