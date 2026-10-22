import Foundation

enum SampleData {
    static func make() -> AppData {
        let me = Member(name: "Mohamad Koussa", email: "", colorHex: "#7B68EE")
        let sara = Member(name: "Sara Haddad", colorHex: "#3DBE7A")
        let omar = Member(name: "Omar Nassar", colorHex: "#F0A33A")
        let lina = Member(name: "Lina Farah", colorHex: "#D6409F")
        var d = AppData(currentUserId: me.id)
        d.members = [me, sara, omar, lina]

        var eng = Space(name: "Product", colorHex: "#7B68EE", icon: "hammer")
        eng.fields = [
            FieldDef(name: "Sprint", type: .dropdown, options: ["Sprint 1", "Sprint 2", "Sprint 3"]),
            FieldDef(name: "Customer impact", type: .rating),
            FieldDef(name: "Spec URL", type: .url),
        ]
        var mkt = Space(name: "Marketing", colorHex: "#D6409F", icon: "megaphone")
        mkt.statuses = [
            StatusDef(name: "Idea", colorHex: "#87909E", kind: .open),
            StatusDef(name: "Drafting", colorHex: "#5B8DEF", kind: .active),
            StatusDef(name: "Scheduled", colorHex: "#8E5CF7", kind: .active),
            StatusDef(name: "Published", colorHex: "#3DBE7A", kind: .done),
        ]
        mkt.fields = [FieldDef(name: "Budget", type: .money)]
        let ops = Space(name: "Operations", colorHex: "#12B5CB", icon: "gearshape.2")
        d.spaces = [eng, mkt, ops]

        let roadmap = Folder(spaceId: eng.id, name: "Roadmap")
        d.folders = [roadmap]

        let backlog = TaskList(spaceId: eng.id, folderId: roadmap.id, name: "Backlog")
        let sprint = TaskList(spaceId: eng.id, folderId: roadmap.id, name: "Current Sprint")
        let bugs = TaskList(spaceId: eng.id, name: "Bugs", colorHex: "#E5484D")
        let content = TaskList(spaceId: mkt.id, name: "Content Calendar")
        let campaigns = TaskList(spaceId: mkt.id, name: "Campaigns")
        let office = TaskList(spaceId: ops.id, name: "Office & Admin")
        d.lists = [backlog, sprint, bugs, content, campaigns, office]

        let today = Date().startOfDay
        func t(_ title: String, _ list: TaskList, _ space: Space, status: Int, prio: Priority, who: [Member], start: Int?, due: Int?, tags: [String] = [], est: Int? = nil) -> TaskItem {
            var x = TaskItem(listId: list.id, title: title, statusId: space.statuses[status].id)
            x.priority = prio
            x.assigneeIds = who.map(\.id)
            x.startDate = start.map { today.adding(days: $0) }
            x.dueDate = due.map { today.adding(days: $0) }
            x.tags = tags
            x.estimateMinutes = est
            x.activity = [ActivityItem(date: today.adding(days: -3), text: "\(me.name) created this task")]
            if space.statuses[status].kind == .done { x.completedAt = today.adding(days: -Int.random(in: 0...10)) }
            return x
        }

        var login = t("Redesign onboarding flow", sprint, eng, status: 1, prio: .high, who: [me, sara], start: -2, due: 3, tags: ["ux"], est: 480)
        login.details = "## Goal\nReduce drop-off in the first-run experience.\n\n- Shorter signup\n- Template picker\n- **Guided tour**"
        login.checklists = [Checklist(name: "Acceptance", items: [
            ChecklistItem(text: "Wireframes approved", done: true),
            ChecklistItem(text: "Copy reviewed"),
            ChecklistItem(text: "Analytics events"),
        ])]
        login.comments = [Comment(authorId: sara.id, text: "First pass of the wireframes is in Figma @Mohamad", date: today.adding(days: -1))]
        login.customValues = [eng.fields[0].id: "Sprint 2", eng.fields[1].id: "4"]
        var sub1 = t("Wireframes", sprint, eng, status: 3, prio: .normal, who: [sara], start: -2, due: 0)
        sub1.parentId = login.id
        var sub2 = t("Implement signup screen", sprint, eng, status: 0, prio: .normal, who: [me], start: 1, due: 3)
        sub2.parentId = login.id

        let api = t("Public API v2", backlog, eng, status: 0, prio: .normal, who: [omar], start: 4, due: 18, tags: ["backend"], est: 1200)
        var sso = t("SSO with SAML", backlog, eng, status: 0, prio: .low, who: [omar], start: 10, due: 25, tags: ["backend", "enterprise"])
        sso.blockedBy = [api.id]
        let perf = t("Dashboard performance pass", sprint, eng, status: 2, prio: .urgent, who: [me], start: -4, due: -1, tags: ["perf"], est: 240)
        let crash = t("Crash when exporting CSV", bugs, eng, status: 0, prio: .urgent, who: [omar], start: nil, due: 1, tags: ["bug"])
        let tz = t("Timezone off-by-one in calendar", bugs, eng, status: 1, prio: .high, who: [sara], start: -1, due: 2, tags: ["bug"])
        let dark = t("Dark mode polish", sprint, eng, status: 3, prio: .low, who: [lina], start: -6, due: -3, tags: ["ux"])

        let blog = t("Blog: Q4 product update", content, mkt, status: 1, prio: .normal, who: [lina], start: 0, due: 5, tags: ["blog"])
        let video = t("Launch video script", campaigns, mkt, status: 0, prio: .high, who: [lina, me], start: 2, due: 9)
        let social = t("Social posts for launch week", content, mkt, status: 2, prio: .normal, who: [lina], start: 6, due: 12, tags: ["social"])
        var news = t("Monthly newsletter", content, mkt, status: 0, prio: .normal, who: [lina], start: nil, due: 14)
        news.recurrence = .monthly

        let lease = t("Renew office lease", office, ops, status: 0, prio: .high, who: [me], start: nil, due: 7)
        let laptops = t("Order laptops for new hires", office, ops, status: 1, prio: .normal, who: [omar], start: -1, due: 4)
        let audit = t("Quarterly security audit", office, ops, status: 3, prio: .normal, who: [me], start: -10, due: -5)

        d.tasks = [login, sub1, sub2, api, sso, perf, crash, tz, dark, blog, video, social, news, lease, laptops, audit]
        for i in d.tasks.indices { d.tasks[i].order = Double(i) }

        d.docs = [
            Doc(spaceId: eng.id, title: "Product Requirements", body: "# Product Requirements\n\n## Problem\nTeams juggle too many tools.\n\n## Solution\nOne workspace for tasks, docs, goals and chat.\n\n## Success metrics\n- Weekly active teams\n- Tasks completed per week\n", icon: "doc.richtext", favorite: true),
            Doc(spaceId: mkt.id, title: "Brand Voice", body: "# Brand Voice\n\nClear. Confident. Friendly.\n\n> Write like you talk to a smart friend.", icon: "text.quote"),
            Doc(title: "Meeting Notes", body: "# Weekly Sync\n\n**Attendees:** everyone\n\n1. Roadmap review\n2. Launch timeline\n3. Hiring", icon: "person.3"),
        ]
        d.docs.append(Doc(parentId: d.docs[0].id, spaceId: eng.id, title: "API Appendix", body: "# API Appendix\n\nEndpoints, auth, rate limits."))

        d.whiteboards = [Whiteboard(name: "Launch brainstorm", items: [
            BoardItem(kind: .sticky, text: "Webinar with customers", x: 80, y: 80),
            BoardItem(kind: .sticky, text: "Product Hunt launch", x: 300, y: 120, colorHex: "#A7F3D0"),
            BoardItem(kind: .sticky, text: "Partner co-marketing", x: 520, y: 70, colorHex: "#BFDBFE"),
            BoardItem(kind: .text, text: "Launch ideas", x: 80, y: 20, width: 240, height: 40, colorHex: "#2F3A4A"),
        ])]

        let general = ChatChannel(name: "general")
        d.channels = [general, ChatChannel(name: "product", spaceId: eng.id), ChatChannel(name: "marketing", spaceId: mkt.id)]
        d.messages = [
            ChatMessage(channelId: general.id, authorId: sara.id, text: "Morning team! Standup in 10 ☕️", date: Date().addingTimeInterval(-3600 * 3)),
            ChatMessage(channelId: general.id, authorId: omar.id, text: "API spec is ready for review", date: Date().addingTimeInterval(-3600 * 2)),
        ]

        d.goals = [
            Goal(name: "Ship v2 onboarding", details: "Activation +20%", dueDate: today.adding(days: 30), ownerId: me.id, colorHex: "#7B68EE", folder: "Q4 OKRs", targets: [
                GoalTarget(name: "Onboarding tasks done", kind: .tasks, taskIds: [login.id, sub1.id, sub2.id]),
                GoalTarget(name: "Activation rate %", kind: .number, start: 30, target: 50, current: 38),
            ]),
            Goal(name: "Grow newsletter", dueDate: today.adding(days: 60), ownerId: lina.id, colorHex: "#D6409F", folder: "Q4 OKRs", targets: [
                GoalTarget(name: "Subscribers", kind: .number, start: 1000, target: 5000, current: 2200),
                GoalTarget(name: "Ad budget spent", kind: .currency, start: 0, target: 3000, current: 900),
                GoalTarget(name: "Launch referral program", kind: .boolean),
            ]),
        ]

        d.timeEntries = [
            TimeEntry(taskId: login.id, memberId: me.id, note: "Research", start: today.adding(days: -1).addingTimeInterval(9 * 3600), end: today.adding(days: -1).addingTimeInterval(11.5 * 3600)),
            TimeEntry(taskId: perf.id, memberId: me.id, start: today.adding(days: -2).addingTimeInterval(13 * 3600), end: today.adding(days: -2).addingTimeInterval(16 * 3600), billable: true),
            TimeEntry(taskId: lease.id, memberId: me.id, start: today.addingTimeInterval(9 * 3600), end: today.addingTimeInterval(9.75 * 3600)),
        ]

        d.reminders = [Reminder(title: "Call landlord about lease", date: today.adding(days: 1).addingTimeInterval(10 * 3600), taskId: lease.id)]
        d.inbox = [
            InboxItem(date: today.adding(days: -1), text: "Sara Haddad mentioned you on \"Redesign onboarding flow\"", taskId: login.id),
            InboxItem(date: today, text: "You were assigned \"Renew office lease\"", taskId: lease.id),
        ]
        d.automations = [
            Automation(name: "Urgent bugs → assign Omar", spaceId: eng.id, trigger: .priorityChanged, triggerValue: "Urgent", action: .assign, actionValue: "Omar Nassar"),
            Automation(name: "Review → ping", trigger: .statusChanged, triggerValue: "Review", action: .addComment, actionValue: "Ready for review — please take a look."),
        ]
        d.dashboards = [Dashboard(name: "Team Overview", widgets: [
            DashboardWidget(kind: .statusBreakdown), DashboardWidget(kind: .workload),
            DashboardWidget(kind: .priorityBreakdown), DashboardWidget(kind: .completedTrend),
            DashboardWidget(kind: .overdue), DashboardWidget(kind: .goals),
            DashboardWidget(kind: .timeTracked), DashboardWidget(kind: .recentActivity),
        ])]
        d.favorites = [sprint.id]
        return d
    }
}
