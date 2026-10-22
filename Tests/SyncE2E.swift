import Foundation

/// End-to-end team sync check. Each phase runs in its own process with its own MKPROD_HOME,
/// playing one teammate against the Worker in web/ running under `wrangler dev` (see Tests/run_sync_e2e.sh).
@main
struct SyncE2E {
    @MainActor
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 3 else { fail("usage: SyncE2E <phase> <server-url>") }
        let phase = args[1]
        let store = Store()
        let cloud = store.cloud
        cloud.config = CloudConfig(url: args[2])
        do {
            // Later phases sign in again; each phase removes its Keychain session on exit.
            let bobPassword = shared("bob-password") ?? "bob-test-pw"
            if phase.hasPrefix("alice-") && phase != "alice-setup" { try await cloud.signIn(email: "alice@example.test", password: "alice-test-pw") }
            if phase.hasPrefix("bob-") && !["bob-join", "bob-recover"].contains(phase) { try await cloud.signIn(email: "bob@example.test", password: bobPassword) }
            switch phase {
            case "alice-setup":
                try await cloud.signUp(email: "alice@example.test", password: "alice-test-pw", name: "Alice")
                check(cloud.client.newRecoveryCode != nil, "Alice got a recovery code at sign-up")
                try await cloud.publishCurrentWorkspace(name: "Team Test")
                let code = try await cloud.invite(email: "bob@example.test", role: "member")
                check(code.count == 14, "invite returned a one-time code")
                share("invite", code)
                check(cloud.workspaceId != nil, "workspace created")
                check(cloud.isEncrypted && cloud.keyVersion == 1, "workspace encrypted on first connect (key v\(cloud.keyVersion))")
                check(store.data.currentUserId == cloud.client.session?.userId, "local user remapped to cloud account")
                if case .synced = cloud.status { ok("first encrypted upload succeeded") } else { fail("first upload: \(cloud.status)") }

            case "bob-join":
                try await cloud.signUp(email: "bob@example.test", password: "bob-test-pw", name: "Bob")
                share("bob-recovery", cloud.client.newRecoveryCode ?? "")
                check(cloud.workspaces.isEmpty, "signing up with the invited email alone does not join")
                do { try await cloud.acceptInvite(code: "AAAA-BBBB-CCCC"); fail("wrong invite code was accepted") } catch { ok("wrong invite code rejected") }
                try await cloud.acceptInvite(code: shared("invite")!)
                check(cloud.workspaces.count == 1, "invite code accepted, workspace visible")
                try await cloud.join(cloud.workspaces[0])
                check(cloud.waitingForKey && store.data.tasks.isEmpty, "Bob can't read anything until a teammate shares the key")

            case "alice-share":
                await cloud.sync()
                check(cloud.team.first { $0.name == "Bob" }?.hasKey == false, "Alice sees Bob needs the key (\(cloud.team.map { "\($0.name):\($0.hasKey)" }), \(cloud.status))")
                await cloud.sync()
                try await cloud.fetchTeam()
                check(cloud.team.first { $0.name == "Bob" }?.hasKey == true, "Alice's app shared the key with Bob")

            case "bob-joined":
                await cloud.sync()
                check(!cloud.waitingForKey, "Bob unlocked the workspace key")
                check(store.data.tasks.count >= 16, "Bob decrypted Alice's tasks (\(store.data.tasks.count))")
                check(store.data.members.count == 2, "team has 2 members (\(store.data.members.map(\.name)))")
                check(cloud.myRole == "member", "Bob is a member")

            case "alice-edit":
                await cloud.sync()
                let list = store.data.lists[0].id
                let t = store.addTask("Created by Alice", list: list)
                let bob = store.data.members.first { $0.name == "Bob" }!.id
                store.updateTask(t.id) { $0.assigneeIds = [bob] }
                await cloud.sync()
                ok("Alice created and assigned a task")

            case "bob-check":
                await cloud.sync()
                guard let t = store.data.tasks.first(where: { $0.title == "Created by Alice" }) else { fail("Bob did not receive Alice's task") }
                check(t.assigneeIds == [store.data.currentUserId], "assignment arrived")
                check(store.data.inbox.contains { $0.text.contains("You were assigned \"Created by Alice\"") }, "Bob got an inbox notification")
                store.addComment("On it @Alice", to: t.id)
                store.updateTask(t.id) { $0.title = "Created by Alice (Bob edited)" }
                await cloud.sync()
                ok("Bob commented and renamed")

            case "alice-check":
                await cloud.sync()
                guard let t = store.data.tasks.first(where: { $0.title == "Created by Alice (Bob edited)" }) else { fail("Alice did not receive Bob's edit") }
                check(t.comments.contains { $0.text == "On it @Alice" }, "comment arrived")
                check(store.data.inbox.contains { $0.text.contains("mentioned you") }, "Alice got a mention notification")
                check(cloud.online.count == 2, "presence shows 2 online (\(cloud.online.count))")
                store.trashTask(t.id)
                await cloud.sync()
                let bob = cloud.team.first { $0.name == "Bob" }!.id
                try await cloud.setRole(bob, "viewer")
                ok("Alice trashed the task and made Bob a viewer")

            case "bob-viewer":
                await cloud.sync()
                check(store.data.tasks.first { $0.title.hasPrefix("Created by Alice") }?.trashedAt != nil, "trash synced")
                check(!cloud.canWrite, "Bob is now view-only")
                store.addTask("Viewer should not share this", list: store.data.lists[0].id)
                await cloud.sync()
                if case .error(let e) = cloud.status { fail("viewer sync errored: \(e)") }
                check(!store.data.tasks.contains { $0.title == "Viewer should not share this" }, "viewer's edit was rolled back")

            case "alice-final":
                await cloud.sync()
                check(!store.data.tasks.contains { $0.title == "Viewer should not share this" }, "viewer's edit did not reach the team")
                // Concurrent edit, part 1: Alice changes priority and comments without syncing yet.
                // No awaits after the edits, so they stay unsynced when this process exits.
                try await cloud.setRole(cloud.team.first { $0.name == "Bob" }!.id, "member")
                let t = store.data.tasks.first { $0.title == "Redesign onboarding flow" }!
                store.updateTask(t.id) { $0.priority = .urgent }
                store.addComment("Alice's offline comment", to: t.id)
                ok("Alice edited offline and restored Bob to member")

            case "bob-concurrent":
                await cloud.sync()
                let t = store.data.tasks.first { $0.title == "Redesign onboarding flow" }!
                store.updateTask(t.id) { $0.dueDate = Date(timeIntervalSince1970: 1_900_000_000) }
                store.addComment("Bob's comment", to: t.id)
                await cloud.sync()
                ok("Bob changed the due date and commented")

            case "alice-merge":
                // Alice's unsynced edits are still local; this sync merges them with Bob's.
                await cloud.sync()
                let t = store.data.tasks.first { $0.title == "Redesign onboarding flow" }!
                check(t.priority == .urgent, "Alice's priority kept")
                check(t.dueDate == Date(timeIntervalSince1970: 1_900_000_000), "Bob's due date merged in")
                check(t.comments.contains { $0.text == "Alice's offline comment" } && t.comments.contains { $0.text == "Bob's comment" }, "both comments kept")

            case "alice-finance":
                // Alice sets up an entity where Bob is the manager, a budget, and raises an order.
                let bob = store.data.members.first { $0.name == "Bob" }!.id
                var e = FinEntity(name: "Finance Dept", approvalLevels: ["Requestor", "Manager"])
                e.roles = [EntityRoleAssignment(memberId: store.data.currentUserId, role: "Requestor"), EntityRoleAssignment(memberId: bob, role: "Manager")]
                store.data.entities.append(e)
                let line = BudgetLine(name: "Laptops", allocated: 10_000)
                let b = Budget(entityId: e.id, year: 2026, category: "IT", lineItems: [line])
                store.data.budgets.append(b)
                var o = PurchaseOrder(title: "Two laptops", entityId: e.id, budgetId: b.id, lineItemId: line.id, status: "", requestedBy: store.data.currentUserId)
                o.items = [OrderLine(name: "Laptop", qty: 2, unitPrice: 3_000)]
                let created = store.createOrder(o)
                check(created.status == "Pending Manager", "order waits for the Manager (\(created.status))")
                check(store.figures(budget: b.id, line: line.id).pending == 6_000, "6,000 shown as pending on the line")
                await cloud.sync()

            case "bob-approve":
                await cloud.sync()
                guard let o = store.data.orders.first(where: { $0.title == "Two laptops" }) else { fail("order did not reach Bob") }
                check(store.canApprove(o, member: store.data.currentUserId), "Bob can approve as Manager")
                check(store.data.inbox.contains { $0.text.contains("waiting for your approval") }, "Bob was notified to approve")
                store.approve(o.id, note: "OK", poNumber: "PO-77")
                await cloud.sync()
                ok("Bob approved")

            case "alice-fulfil":
                await cloud.sync()
                guard let o = store.data.orders.first(where: { $0.title == "Two laptops" }) else { fail("order missing") }
                check(o.status == OrderStatus.approved && o.poNumber == "PO-77", "approval and PO number arrived")
                check(store.data.inbox.contains { $0.text.contains("is now Approved") }, "Alice was told it was approved")
                store.setOrderStatus(o.id, OrderStatus.ordered)
                store.setOrderStatus(o.id, OrderStatus.delivered)
                let b = store.data.budgets.first { $0.category == "IT" }!
                let f = store.figures(budget: b.id, line: b.lineItems[0].id)
                check(f.spent == 6_000 && f.balance == 4_000, "delivered order counts as spent; 4,000 left")
                await cloud.sync()

            case "bob-merge":
                await cloud.sync()
                let t = store.data.tasks.first { $0.title == "Redesign onboarding flow" }!
                check(t.priority == .urgent && t.comments.contains { $0.text == "Alice's offline comment" }, "merged task reached Bob")
                check(!store.data.tasks.contains { $0.title == "Viewer should not share this" }, "no stale viewer edits resurfaced")

            case "bob-recover":
                // Forgotten password: the recovery code restores the same keys, so nothing needs re-sharing.
                do { try await cloud.signIn(email: "bob@example.test", password: "wrong-password"); fail("wrong password accepted") } catch { ok("wrong password rejected") }
                try await cloud.recover(email: "bob@example.test", code: shared("bob-recovery")!, newPassword: "bob-new-password-1")
                share("bob-password", "bob-new-password-1")
                await cloud.sync()
                check(!cloud.waitingForKey && store.data.tasks.count >= 16, "after recovery Bob still reads everything")

            case "alice-reset-bob":
                await cloud.sync()
                guard let bob = cloud.team.first(where: { $0.name == "Bob" })?.id else { fail("Bob not in team") }
                let temp = try await cloud.resetPassword(bob)
                share("bob-password", temp)
                try await cloud.fetchTeam()
                check(cloud.team.first { $0.name == "Bob" }?.publicKey == nil, "admin reset discards Bob's old keys")

            case "bob-after-reset":
                await cloud.sync()
                check(cloud.waitingForKey, "with a temporary password Bob has new keys and waits for the workspace key")

            case "alice-reshare":
                await cloud.sync()
                await cloud.sync()
                try await cloud.fetchTeam()
                check(cloud.team.first { $0.name == "Bob" }?.hasKey == true, "Alice's app re-shared the key with Bob's new key pair")

            case "bob-rekeyed":
                await cloud.sync()
                check(!cloud.waitingForKey && store.data.tasks.count >= 16, "Bob reads the workspace again")

            case "alice-remove-bob":
                await cloud.sync()
                guard let bob = cloud.team.first(where: { $0.name == "Bob" })?.id else { fail("Bob not in team") }
                try await cloud.remove(bob)
                check(cloud.keyVersion == 2, "removing Bob rotated the key to v\(cloud.keyVersion)")
                if case .synced = cloud.status { ok("everything re-encrypted with the new key") } else { fail("re-encrypt: \(cloud.status)") }

            case "bob-removed":
                try await cloud.refreshWorkspaces()
                check(cloud.workspaces.isEmpty, "Bob no longer has the workspace")

            case "mac-web-check":
                // Cross-client: data created on the website must decode and work in the Mac app.
                try await cloud.signIn(email: args[3], password: args[4])
                guard let ws = cloud.workspaces.first else { fail("no workspace for website user") }
                try await cloud.join(ws)
                guard let t = store.data.tasks.first(where: { $0.title == "Prepare Q4 supplier review" }) else { fail("website task missing in Mac data (\(store.data.tasks.count) tasks)") }
                check(t.priority == .high && t.tags == ["procurement"] && t.dueDate != nil, "website task fields decoded (priority, tag, due)")
                check(store.status(of: t)?.name == "In Progress", "status resolved via website-created space")
                check(store.subtasks(of: t.id).map(\.title) == ["Collect three quotes"], "website subtask linked")
                guard let o = store.data.orders.first(where: { $0.title == "Laptops for new hires" }) else { fail("website order missing") }
                check(o.status == "Pending Manager" && o.amount == 13_500, "website order decoded: \(o.status), \(o.amount)")
                let b = store.data.budgets.first { $0.category == "IT" }!
                check(store.figures(budget: b.id, line: b.lineItems[0].id).pending == 13_500, "Mac computes the same pending figure")
                store.approve(o.id, note: "Approved from Mac", poNumber: "PO-MAC-1")
                store.addComment("Checked on the Mac app", to: t.id)
                await cloud.sync()
                check(cloud.status == .synced(Date()) || { if case .synced = cloud.status { return true }; return false }(), "Mac pushed approval")

            case "bob-prefs":
                try await cloud.loadNotifyPrefs()
                check(cloud.emailEnabledOnServer, "server reports email is set up")
                check(cloud.notifyPrefs["taskAssigned"] == true && cloud.notifyPrefs["contractExpiring"] == true, "notifications default to on")
                var p = cloud.notifyPrefs
                p["taskAssigned"] = false
                p["includeDetails"] = false
                try await cloud.saveNotifyPrefs(p)
                try await cloud.loadNotifyPrefs()
                check(cloud.notifyPrefs["taskAssigned"] == false && cloud.notifyPrefs["includeDetails"] == false, "Bob muted assignment emails and hid details")
                try await cloud.sendTestEmail()
                ok("test email requested")

            case "alice-notify":
                await cloud.sync()
                let bob = store.data.members.first { $0.name == "Bob" }!.id
                let t = store.addTask("Muted assignment", list: store.data.lists[0].id)
                store.updateTask(t.id) { $0.assigneeIds = [bob] }
                await cloud.sync()
                store.updateTask(t.id) { $0.dueDate = Date().addingTimeInterval(3 * 86400) }
                let entity = store.data.entities.first { $0.name == "Finance Dept" }!
                store.data.contracts.append(Contract(entityId: entity.id, title: "Hosting renewal", supplier: "Acme Cloud",
                                                     startDate: Date().addingTimeInterval(-300 * 86400), endDate: Date().startOfDay.adding(days: 10)))
                await cloud.sync()
                ok("Alice assigned a task to Bob, updated it, and added a contract ending in 10 days")

            default:
                fail("unknown phase \(phase)")
            }
        } catch {
            fail("\(phase): \(error.localizedDescription)")
        }
        store.saveNow()
        Keychain.delete(account: "session"); Keychain.delete(account: "privateKey")
        exit(0)
    }

    /// Values passed between phases (separate processes) via files in E2E_SHARE.
    static func share(_ name: String, _ value: String) {
        try? value.write(toFile: (ProcessInfo.processInfo.environment["E2E_SHARE"] ?? NSTemporaryDirectory()) + "/" + name, atomically: true, encoding: .utf8)
    }

    static func shared(_ name: String) -> String? {
        try? String(contentsOfFile: (ProcessInfo.processInfo.environment["E2E_SHARE"] ?? NSTemporaryDirectory()) + "/" + name, encoding: .utf8)
    }

    static func check(_ cond: Bool, _ what: String) {
        if cond { ok(what) } else { fail(what) }
    }

    static func ok(_ s: String) { print("  ✓ \(s)") }

    static func fail(_ s: String) -> Never {
        print("  ✗ \(s)")
        Keychain.delete(account: "session"); Keychain.delete(account: "privateKey")
        exit(1)
    }
}
