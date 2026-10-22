import Foundation

/// Email notices for teammates, composed from this Mac's own edits (the server can't read the
/// encrypted data, so the client that made a change describes it). The Worker checks each
/// recipient's preferences, de-duplicates by `dedupe` and sends (POST /workspaces/:id/notify).
enum EmailNotices {
    /// Edits to the same task within this window produce one "updated" email per person.
    static let updateWindow: TimeInterval = 15 * 60
    /// Reminder points before a contract's end date, in days.
    static let contractThresholds = [60, 30, 14, 7, 1]

    static func notice(to: UUID, type: String, subject: String, lines: [String], generic: String, dedupe: String) -> [String: Any] {
        ["to": to.uuidString, "type": type, "subject": subject, "lines": lines, "generic": generic, "dedupe": dedupe]
    }

    private static func bucket(_ d: Date) -> Int { Int(d.timeIntervalSince1970 / updateWindow) }

    static func forTask(old: Data?, new: Data, store: Store) -> [[String: Any]] {
        guard let t = try? JSONDecoder.cloud.decode(TaskItem.self, from: new), t.trashedAt == nil else { return [] }
        let before = old.flatMap { try? JSONDecoder.cloud.decode(TaskItem.self, from: $0) }
        let me = store.data.currentUserId
        let actor = store.me.name
        let place = store.list(t.listId)?.name ?? "a list"
        var out: [[String: Any]] = []

        // New assignees
        let added = Set(t.assigneeIds).subtracting(before?.assigneeIds ?? []).subtracting([me])
        for a in added {
            var lines = ["\(actor) assigned you \"\(t.title)\" in \(place)."]
            if let d = t.dueDate { lines.append("Due \(d.formatted(date: .abbreviated, time: .omitted)).") }
            if t.priority != .none { lines.append("Priority: \(t.priority.label).") }
            if !t.details.isEmpty { lines.append(String(t.details.prefix(300))) }
            out.append(notice(to: a, type: "taskAssigned", subject: "You were assigned: \(t.title)", lines: lines,
                              generic: "A task was assigned to you.", dedupe: "\(t.id.uuidString):\(a.uuidString):\(bucket(Date()))"))
        }

        // Mentions in new comments
        let oldComments = Set(before?.comments.map(\.id) ?? [])
        let newComments = t.comments.filter { !oldComments.contains($0.id) && $0.authorId == me }
        var mentioned = Set<UUID>()
        for c in newComments {
            for m in store.data.members where m.id != me {
                let first = m.name.split(separator: " ").first.map(String.init) ?? m.name
                guard !first.isEmpty, c.text.localizedCaseInsensitiveContains("@" + first) || c.assigneeId == m.id else { continue }
                mentioned.insert(m.id)
                out.append(notice(to: m.id, type: "mentions", subject: "\(actor) mentioned you on \(t.title)",
                                  lines: ["\(actor) wrote on \"\(t.title)\":", String(c.text.prefix(500))],
                                  generic: "Someone mentioned you on a task.", dedupe: "comment:\(c.id.uuidString):\(m.id.uuidString)"))
            }
        }

        // Updates for everyone already following the task
        guard let b = before else { return out }
        var changes: [String] = []
        if b.title != t.title { changes.append("Renamed from \"\(b.title)\".") }
        if b.statusId != t.statusId { changes.append("Status: \(store.status(of: t)?.name ?? "changed").") }
        if b.dueDate != t.dueDate { changes.append("Due date: \(t.dueDate?.formatted(date: .abbreviated, time: .omitted) ?? "removed").") }
        if b.priority != t.priority { changes.append("Priority: \(t.priority.label).") }
        if b.details != t.details { changes.append("Description edited.") }
        if b.checklists != t.checklists { changes.append("Checklist updated.") }
        if !newComments.isEmpty { changes.append("New comment: \(String(newComments.last!.text.prefix(300)))") }
        if b.attachments.count != t.attachments.count { changes.append("Attachments changed.") }
        if Set(b.assigneeIds) != Set(t.assigneeIds) && added.isEmpty { changes.append("Assignees changed.") }
        guard !changes.isEmpty else { return out }
        let followers = Set(t.assigneeIds + t.watcherIds).subtracting([me]).subtracting(added).subtracting(mentioned)
        for f in followers {
            out.append(notice(to: f, type: "taskUpdated", subject: "Updated: \(t.title)", lines: ["\(actor) updated \"\(t.title)\" in \(place):"] + changes,
                              generic: "A task you follow was updated.", dedupe: "\(t.id.uuidString):\(bucket(Date()))"))
        }
        return out
    }

    static func forOrder(old: Data?, new: Data, store: Store) -> [[String: Any]] {
        guard let o = try? JSONDecoder.cloud.decode(PurchaseOrder.self, from: new) else { return [] }
        let before = old.flatMap { try? JSONDecoder.cloud.decode(PurchaseOrder.self, from: $0) }
        guard before?.status != o.status else { return [] }
        let me = store.data.currentUserId
        let entity = store.data.entities.first { $0.id == o.entityId }?.name ?? "an entity"
        var out: [[String: Any]] = []
        for m in store.data.members where m.id != me && store.canApprove(o, member: m.id) {
            out.append(notice(to: m.id, type: "approvals", subject: "Approval needed: #\(o.number) \(o.title)",
                              lines: ["Order #\(o.number) \"\(o.title)\" for \(entity) is waiting for your approval.", "Status: \(o.status)."],
                              generic: "An order is waiting for your approval.", dedupe: "order:\(o.id.uuidString):\(o.status):\(m.id.uuidString)"))
        }
        if o.requestedBy != me, before != nil {
            out.append(notice(to: o.requestedBy, type: "approvals", subject: "Order #\(o.number) is now \(o.status)",
                              lines: ["Your order #\(o.number) \"\(o.title)\" for \(entity) is now \(o.status)."],
                              generic: "One of your orders changed status.", dedupe: "order:\(o.id.uuidString):\(o.status):requester"))
        }
        return out
    }

    /// Reminders for contracts nearing their end date, to the people assigned to the contract's
    /// entity (or the workspace admins when it has none). Any teammate's app may send these;
    /// the server's de-dupe key makes sure each reminder goes out once.
    static func forContracts(store: Store, admins: [UUID], today: Date = Date()) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        for c in store.data.contracts where !c.terminated {
            let days = Calendar.current.dateComponents([.day], from: today.startOfDay, to: c.endDate.startOfDay).day ?? -1
            guard days >= 0, let threshold = contractThresholds.last(where: { days <= $0 }) else { continue }
            let entity = c.entityId.flatMap { id in store.data.entities.first { $0.id == id } }
            let people = entity.map { Set($0.roles.map(\.memberId)) } ?? Set(admins)
            let when = days == 0 ? "today" : days == 1 ? "tomorrow" : "in \(days) days"
            var lines = ["The contract \"\(c.title)\" with \(c.supplier)\(entity.map { " (\($0.name))" } ?? "") ends \(when), on \(c.endDate.formatted(date: .long, time: .omitted))."]
            if c.autoRenew { lines.append("It is set to renew automatically.") }
            if c.value > 0 { lines.append("Value: \(c.value.formatted(.number.precision(.fractionLength(0...2))))") }
            if !c.contact.isEmpty || !c.email.isEmpty { lines.append("Supplier contact: \([c.contact, c.email, c.phone].filter { !$0.isEmpty }.joined(separator: " · "))") }
            for p in people where store.member(p) != nil {
                out.append(notice(to: p, type: "contractExpiring", subject: "Contract ending \(when): \(c.title)", lines: lines,
                                  generic: "A contract for your entity is ending soon.",
                                  dedupe: "contract:\(c.id.uuidString):\(day.string(from: c.endDate)):\(threshold)"))
            }
        }
        return out
    }
}
