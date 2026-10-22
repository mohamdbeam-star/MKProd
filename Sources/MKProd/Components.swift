import SwiftUI

struct AvatarView: View {
    let member: Member?
    var size: CGFloat = 22

    var body: some View {
        ZStack {
            Circle().fill(member.map { Color(hex: $0.colorHex) } ?? Color.gray.opacity(0.3))
            Text(member?.initials ?? "?")
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .help(member?.name ?? "Unassigned")
    }
}

struct AvatarStack: View {
    let ids: [UUID]
    @Environment(Store.self) private var store
    var size: CGFloat = 22

    var body: some View {
        if ids.isEmpty {
            Image(systemName: "person.crop.circle.badge.plus").foregroundStyle(.tertiary)
        } else {
            HStack(spacing: -6) {
                ForEach(ids.prefix(4), id: \.self) { id in
                    AvatarView(member: store.member(id), size: size)
                        .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1.5))
                }
                if ids.count > 4 { Text("+\(ids.count - 4)").font(.caption2).padding(.leading, 8) }
            }
        }
    }
}

struct StatusPill: View {
    let status: StatusDef?
    var compact = false

    var body: some View {
        let c = Color(hex: status?.colorHex ?? "#87909E")
        HStack(spacing: 4) {
            Circle().fill(c).frame(width: 7, height: 7)
            if !compact {
                Text((status?.name ?? "—").uppercased())
                    .font(.system(size: 10, weight: .bold))
            }
        }
        .padding(.horizontal, compact ? 4 : 7)
        .padding(.vertical, 3)
        .background(c.opacity(0.15), in: Capsule())
        .foregroundStyle(c)
    }
}

struct PriorityFlag: View {
    let priority: Priority
    var showLabel = false

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: priority == .none ? "flag" : "flag.fill")
                .foregroundStyle(priority == .none ? Color.secondary.opacity(0.5) : priority.color)
            if showLabel { Text(priority.label) }
        }
        .help(priority.label)
    }
}

struct TagChip: View {
    let tag: String
    var body: some View {
        Text(tag)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color(hex: tagColor(tag)).opacity(0.2), in: RoundedRectangle(cornerRadius: 4))
            .foregroundStyle(Color(hex: tagColor(tag)))
    }
}

func tagColor(_ tag: String) -> String {
    let sum = tag.unicodeScalars.reduce(0) { $0 + Int($1.value) }
    return paletteHexes[sum % paletteHexes.count]
}

struct DueLabel: View {
    let date: Date?
    var overdue = false
    var body: some View {
        if let date {
            Text(date.shortLabel)
                .font(.callout)
                .foregroundStyle(overdue ? Color.red : (Calendar.current.isDateInToday(date) ? .orange : .secondary))
        } else {
            Image(systemName: "calendar").foregroundStyle(.tertiary)
        }
    }
}

/// Pickers used across views to edit a task's common properties. They use popovers rather than
/// menus because macOS menu labels flatten custom views (colored flags, avatars) to monochrome.
struct PopoverPicker<Label: View, Content: View>: View {
    @ViewBuilder let label: () -> Label
    @ViewBuilder let content: (_ close: @escaping () -> Void) -> Content
    @State private var open = false

    var body: some View {
        Button { open = true } label: { label() }
            .buttonStyle(.plain)
            .popover(isPresented: $open, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 2) { content { open = false } }
                    .padding(8)
                    .frame(minWidth: 180, alignment: .leading)
            }
    }
}

struct PickerRow: View {
    let title: String
    var selected = false
    let action: () -> Void
    @ViewBuilder var icon: () -> AnyView
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                icon()
                Text(title)
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(hover ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

struct StatusMenu: View {
    let task: TaskItem
    @Environment(Store.self) private var store
    var compact = false

    var body: some View {
        PopoverPicker {
            StatusPill(status: store.status(of: task), compact: compact)
        } content: { close in
            ForEach(store.statuses(for: task)) { s in
                PickerRow(title: s.name, selected: s.id == task.statusId, action: {
                    store.updateTask(task.id) { $0.statusId = s.id }
                    close()
                }) { AnyView(Circle().fill(Color(hex: s.colorHex)).frame(width: 9, height: 9)) }
            }
        }
    }
}

struct PriorityMenu: View {
    let task: TaskItem
    @Environment(Store.self) private var store
    var showLabel = false

    var body: some View {
        PopoverPicker {
            PriorityFlag(priority: task.priority, showLabel: showLabel)
        } content: { close in
            ForEach(Priority.allCases.reversed()) { p in
                PickerRow(title: p.label, selected: p == task.priority, action: {
                    store.updateTask(task.id) { $0.priority = p }
                    close()
                }) { AnyView(PriorityFlag(priority: p)) }
            }
        }
    }
}

struct AssigneeMenu: View {
    let task: TaskItem
    @Environment(Store.self) private var store

    var body: some View {
        PopoverPicker {
            AvatarStack(ids: task.assigneeIds)
        } content: { _ in
            Text("Assignees").font(.caption.bold()).foregroundStyle(.secondary).padding(.horizontal, 8)
            ForEach(store.data.members) { m in
                PickerRow(title: m.name, selected: task.assigneeIds.contains(m.id), action: {
                    store.updateTask(task.id) {
                        if let i = $0.assigneeIds.firstIndex(of: m.id) { $0.assigneeIds.remove(at: i) } else { $0.assigneeIds.append(m.id) }
                    }
                }) { AnyView(AvatarView(member: m, size: 20)) }
            }
        }
    }
}

struct DatePopoverButton: View {
    let date: Date?
    var overdue = false
    let onChange: (Date?) -> Void
    @State private var open = false
    @State private var temp = Date()

    var body: some View {
        Button { temp = date ?? Date(); open = true } label: { DueLabel(date: date, overdue: overdue) }
            .buttonStyle(.plain)
            .popover(isPresented: $open) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Button("Today") { onChange(Date().startOfDay); open = false }
                        Button("Tomorrow") { onChange(Date().startOfDay.adding(days: 1)); open = false }
                        Button("Next week") { onChange(Date().startOfDay.adding(days: 7)); open = false }
                    }
                    DatePicker("", selection: $temp, displayedComponents: [.date])
                        .datePickerStyle(.graphical)
                        .labelsHidden()
                    HStack {
                        Button("Clear", role: .destructive) { onChange(nil); open = false }
                        Spacer()
                        Button("Set") { onChange(temp); open = false }.keyboardShortcut(.defaultAction)
                    }
                }
                .padding()
                .frame(width: 280)
            }
    }
}

struct ProgressRing: View {
    let value: Double
    var color: Color = .accentColor
    var size: CGFloat = 36

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.15), lineWidth: 4)
            Circle().trim(from: 0, to: value).stroke(color, style: StrokeStyle(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90))
            Text("\(Int(value * 100))%").font(.system(size: size * 0.26, weight: .semibold))
        }
        .frame(width: size, height: size)
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    var subtitle = ""
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 36)).foregroundStyle(.tertiary)
            Text(title).font(.headline)
            if !subtitle.isEmpty { Text(subtitle).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

struct ColorDots: View {
    @Binding var hex: String
    var body: some View {
        HStack(spacing: 6) {
            ForEach(paletteHexes, id: \.self) { h in
                Circle().fill(Color(hex: h)).frame(width: 16, height: 16)
                    .overlay(Circle().stroke(Color.primary, lineWidth: h == hex ? 2 : 0))
                    .onTapGesture { hex = h }
            }
        }
    }
}

/// A small modal for naming a new thing.
struct NamePrompt: View {
    let title: String
    var initial = ""
    let onDone: (String) -> Void
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            TextField("Name", text: $text).textFieldStyle(.roundedBorder).onSubmit(commit)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create", action: commit).keyboardShortcut(.defaultAction).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 340)
        .onAppear { text = initial }
    }

    private func commit() {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        onDone(t)
        dismiss()
    }
}

/// Markdown rendering for docs, descriptions and comments.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                lineView(line)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func lineView(_ line: String) -> some View {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("### ") {
            inline(String(trimmed.dropFirst(4))).font(.title3.bold())
        } else if trimmed.hasPrefix("## ") {
            inline(String(trimmed.dropFirst(3))).font(.title2.bold()).padding(.top, 4)
        } else if trimmed.hasPrefix("# ") {
            inline(String(trimmed.dropFirst(2))).font(.largeTitle.bold()).padding(.bottom, 4)
        } else if trimmed.hasPrefix("- [x] ") || trimmed.hasPrefix("- [ ] ") {
            HStack(alignment: .top) {
                Image(systemName: trimmed.hasPrefix("- [x]") ? "checkmark.square.fill" : "square")
                inline(String(trimmed.dropFirst(6)))
            }
        } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
            HStack(alignment: .top) { Text("•"); inline(String(trimmed.dropFirst(2))) }
        } else if trimmed.hasPrefix("> ") {
            inline(String(trimmed.dropFirst(2))).italic().padding(.leading, 10)
                .overlay(Rectangle().fill(Color.accentColor).frame(width: 3), alignment: .leading)
        } else if trimmed == "---" {
            Divider()
        } else if trimmed.isEmpty {
            Spacer().frame(height: 4)
        } else {
            inline(line)
        }
    }

    private func inline(_ s: String) -> Text {
        if let a = try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(a)
        }
        return Text(s)
    }
}
