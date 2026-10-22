import SwiftUI
import AppKit

// MARK: - Docs

struct DocsHomeView: View {
    @Environment(Store.self) private var store
    @State private var query = ""

    var body: some View {
        let docs = store.data.docs.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.body.localizedCaseInsensitiveContains(query) }
            .sorted { $0.updated > $1.updated }
        VStack(spacing: 0) {
            HStack {
                TextField("Search docs", text: $query).textFieldStyle(.roundedBorder).frame(width: 260)
                Spacer()
                Menu("New Doc") {
                    Button("Blank doc") { create(title: "Untitled", body: "") }
                    Divider()
                    Button("Meeting notes") { create(title: "Meeting Notes", body: "# Meeting Notes\n\n**Date:** \(Date().formatted(date: .long, time: .omitted))\n\n## Attendees\n- \n\n## Agenda\n1. \n\n## Action items\n- [ ] ") }
                    Button("Project brief") { create(title: "Project Brief", body: "# Project Brief\n\n## Background\n\n## Goals\n\n## Scope\n\n## Timeline\n\n## Risks\n") }
                    Button("Wiki page") { create(title: "Wiki", body: "# Wiki\n\n> Team knowledge base\n\n## How we work\n\n## Tools\n") }
                }
                .fixedSize()
            }
            .padding(12)
            Divider()
            if docs.isEmpty {
                EmptyState(icon: "doc.text", title: "No docs", subtitle: "Create a doc for specs, wikis and notes.")
            } else {
                Table(docs) {
                    TableColumn("Title") { d in
                        Label(d.title, systemImage: d.icon)
                            .onTapGesture(count: 2) { store.selection = .doc(d.id) }
                    }
                    TableColumn("Location") { d in Text(store.space(d.spaceId)?.name ?? "Workspace").foregroundStyle(.secondary) }
                    TableColumn("Parent") { d in Text(store.data.docs.first { $0.id == d.parentId }?.title ?? "—").foregroundStyle(.secondary) }
                    TableColumn("Updated") { d in Text(d.updated.formatted(.relative(presentation: .named))).foregroundStyle(.secondary) }
                    TableColumn("") { d in
                        HStack {
                            Button("Open") { store.selection = .doc(d.id) }
                            Button { if let i = store.data.docs.firstIndex(where: { $0.id == d.id }) { store.data.docs[i].favorite.toggle() } } label: {
                                Image(systemName: d.favorite ? "star.fill" : "star").foregroundStyle(.yellow)
                            }.buttonStyle(.borderless)
                        }
                    }
                    .width(110)
                }
            }
        }
        .navigationTitle("Docs")
    }

    private func create(title: String, body: String) {
        let d = Doc(title: title, body: body)
        store.data.docs.append(d)
        store.selection = .doc(d.id)
    }
}

struct DocEditorView: View {
    let docId: UUID
    @Environment(Store.self) private var store
    @State private var mode = 2 // 0 edit, 1 preview, 2 split

    private var index: Int? { store.data.docs.firstIndex { $0.id == docId } }

    var body: some View {
        @Bindable var store = store
        if let i = index {
            let doc = store.data.docs[i]
            HStack(spacing: 0) {
                pageTree(current: doc)
                    .frame(width: 210)
                Divider()
                VStack(spacing: 0) {
                    HStack {
                        TextField("Title", text: Binding(get: { doc.title }, set: { store.data.docs[i].title = $0; store.data.docs[i].updated = Date() }))
                            .textFieldStyle(.plain).font(.title.bold())
                        Spacer()
                        Picker("", selection: $mode) {
                            Image(systemName: "pencil").tag(0)
                            Image(systemName: "eye").tag(1)
                            Image(systemName: "rectangle.split.2x1").tag(2)
                        }
                        .pickerStyle(.segmented).frame(width: 130)
                        Menu {
                            Picker("Location", selection: $store.data.docs[i].spaceId) {
                                Text("Workspace").tag(UUID?.none)
                                ForEach(store.data.spaces) { Text($0.name).tag(Optional($0.id)) }
                            }
                            Button(doc.favorite ? "Unfavorite" : "Favorite") { store.data.docs[i].favorite.toggle() }
                            Button("Pin to sidebar") { store.toggleFavorite(docId) }
                            Button("Copy as Markdown") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(doc.body, forType: .string)
                            }
                            Button("Export Markdown…") { export(doc) }
                            Button("Convert checkboxes to tasks") { convertToTasks(doc) }
                            Divider()
                            Button("Delete", role: .destructive) {
                                store.data.docs.removeAll { $0.id == docId || $0.parentId == docId }
                                store.selection = .docs
                            }
                        } label: { Image(systemName: "ellipsis.circle") }
                            .menuStyle(.borderlessButton).fixedSize()
                    }
                    .padding(.horizontal, 24).padding(.vertical, 12)
                    formatBar(i)
                    Divider()
                    HStack(spacing: 0) {
                        if mode != 1 {
                            TextEditor(text: Binding(get: { doc.body }, set: { store.data.docs[i].body = $0; store.data.docs[i].updated = Date() }))
                                .font(.system(.body, design: .monospaced))
                                .scrollContentBackground(.hidden)
                                .padding(16)
                        }
                        if mode == 2 { Divider() }
                        if mode != 0 {
                            ScrollView { MarkdownText(text: doc.body).padding(24) }
                        }
                    }
                    HStack {
                        Text("\(doc.body.split { $0.isWhitespace }.count) words").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text("Edited \(doc.updated.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 6)
                }
            }
            .navigationTitle(doc.title)
        } else {
            EmptyState(icon: "doc", title: "Doc not found")
        }
    }

    private func formatBar(_ i: Int) -> some View {
        HStack(spacing: 12) {
            ForEach([("H1", "# "), ("H2", "## "), ("H3", "### "), ("•", "- "), ("☐", "- [ ] "), ("❝", "> "), ("—", "\n---\n")], id: \.0) { item in
                Button(item.0) { store.data.docs[i].body += (store.data.docs[i].body.hasSuffix("\n") || store.data.docs[i].body.isEmpty ? "" : "\n") + item.1 }
                    .buttonStyle(.borderless)
            }
            Button("B") { store.data.docs[i].body += "**bold**" }.buttonStyle(.borderless).bold()
            Button("I") { store.data.docs[i].body += "*italic*" }.buttonStyle(.borderless).italic()
            Button("</>") { store.data.docs[i].body += "`code`" }.buttonStyle(.borderless)
            Button("Link") { store.data.docs[i].body += "[title](https://)" }.buttonStyle(.borderless)
            Menu("Mention task") {
                ForEach(store.data.tasks.filter { !$0.archived }.prefix(50)) { t in
                    Button(t.title) { store.data.docs[i].body += "**[\(t.title)]**" }
                }
            }
            .menuStyle(.borderlessButton).fixedSize()
            Spacer()
        }
        .font(.callout)
        .padding(.horizontal, 24).padding(.bottom, 8)
    }

    private func pageTree(current: Doc) -> some View {
        let root = rootOf(current)
        return VStack(alignment: .leading, spacing: 4) {
            Text("PAGES").font(.caption2.bold()).foregroundStyle(.secondary).padding(.bottom, 4)
            pageRow(root, depth: 0)
            Button {
                let d = Doc(parentId: current.id, spaceId: current.spaceId, title: "New page")
                store.data.docs.append(d)
                store.selection = .doc(d.id)
            } label: { Label("Add sub-page", systemImage: "plus") }
                .buttonStyle(.borderless).padding(.top, 6)
            Spacer()
        }
        .padding(12)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func pageRow(_ d: Doc, depth: Int) -> AnyView {
        AnyView(VStack(alignment: .leading, spacing: 2) {
            Label(d.title, systemImage: d.icon)
                .font(.callout)
                .padding(.leading, CGFloat(depth) * 12)
                .padding(.vertical, 3).padding(.horizontal, 6)
                .background(d.id == docId ? Color.accentColor.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 5))
                .onTapGesture { store.selection = .doc(d.id) }
            ForEach(store.data.docs.filter { $0.parentId == d.id }) { pageRow($0, depth: depth + 1) }
        })
    }

    private func rootOf(_ d: Doc) -> Doc {
        var cur = d
        while let p = store.data.docs.first(where: { $0.id == cur.parentId }) { cur = p }
        return cur
    }

    private func export(_ doc: Doc) {
        let p = NSSavePanel()
        p.nameFieldStringValue = doc.title + ".md"
        if p.runModal() == .OK, let url = p.url { try? doc.body.write(to: url, atomically: true, encoding: .utf8) }
    }

    private func convertToTasks(_ doc: Doc) {
        guard let l = store.data.lists.first(where: { $0.spaceId == doc.spaceId }) ?? store.data.lists.first else { return }
        let items = doc.body.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.hasPrefix("- [ ] ") }
        for line in items {
            let title = String(line.dropFirst(6))
            if !title.isEmpty { store.addTask(title, list: l.id) }
        }
        store.lastError = "Created \(items.count) task(s) in \(l.name)."
    }
}

// MARK: - Whiteboards

struct WhiteboardsHomeView: View {
    @Environment(Store.self) private var store

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 16)], spacing: 16) {
                Button {
                    let w = Whiteboard(name: "Untitled whiteboard")
                    store.data.whiteboards.append(w)
                    store.selection = .whiteboard(w.id)
                } label: {
                    VStack { Image(systemName: "plus").font(.largeTitle); Text("New whiteboard") }
                        .frame(maxWidth: .infinity, minHeight: 150)
                        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                ForEach(store.data.whiteboards) { w in
                    VStack(alignment: .leading) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor))
                            ForEach(w.items.prefix(8)) { it in
                                RoundedRectangle(cornerRadius: 2).fill(Color(hex: it.colorHex).opacity(0.8))
                                    .frame(width: it.width / 5, height: it.height / 5)
                                    .position(x: 20 + it.x / 5, y: 20 + it.y / 5)
                            }
                        }
                        .frame(height: 150)
                        Text(w.name).font(.headline)
                        Text("\(w.items.count) objects").font(.caption).foregroundStyle(.secondary)
                    }
                    .onTapGesture { store.selection = .whiteboard(w.id) }
                    .contextMenu {
                        Button("Delete", role: .destructive) { store.data.whiteboards.removeAll { $0.id == w.id } }
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle("Whiteboards")
    }
}

struct WhiteboardView: View {
    let boardId: UUID
    @Environment(Store.self) private var store
    @State private var selected: UUID?
    @State private var connecting: UUID?
    @State private var drag: [UUID: CGSize] = [:]
    @State private var zoom: CGFloat = 1

    private var index: Int? { store.data.whiteboards.firstIndex { $0.id == boardId } }

    var body: some View {
        if let i = index {
            let board = store.data.whiteboards[i]
            VStack(spacing: 0) {
                toolbar(i, board)
                Divider()
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        dotGrid
                        Canvas { ctx, _ in
                            for c in board.connectors {
                                guard let a = board.items.first(where: { $0.id == c.from }), let b = board.items.first(where: { $0.id == c.to }) else { continue }
                                let pa = center(a), pb = center(b)
                                var p = Path()
                                p.move(to: pa)
                                p.addLine(to: pb)
                                ctx.stroke(p, with: .color(.secondary), style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                            }
                        }
                        .allowsHitTesting(false)
                        ForEach(board.items) { item in itemView(i, item) }
                    }
                    .frame(width: 2400, height: 1600, alignment: .topLeading)
                    .scaleEffect(zoom, anchor: .topLeading)
                    .frame(width: 2400 * zoom, height: 1600 * zoom, alignment: .topLeading)
                    .contentShape(Rectangle())
                    .onTapGesture { selected = nil; connecting = nil }
                }
                .background(Color(nsColor: .textBackgroundColor))
            }
            .navigationTitle(board.name)
        }
    }

    private func center(_ it: BoardItem) -> CGPoint {
        let d = drag[it.id] ?? .zero
        return CGPoint(x: it.x + it.width / 2 + d.width, y: it.y + it.height / 2 + d.height)
    }

    private var dotGrid: some View {
        Canvas { ctx, size in
            for x in stride(from: 0, to: size.width, by: 24) {
                for y in stride(from: 0, to: size.height, by: 24) {
                    ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.5, height: 1.5)), with: .color(.secondary.opacity(0.3)))
                }
            }
        }
    }

    private func toolbar(_ i: Int, _ board: Whiteboard) -> some View {
        @Bindable var store = store
        return HStack(spacing: 10) {
            TextField("Name", text: $store.data.whiteboards[i].name).textFieldStyle(.plain).font(.headline).frame(width: 200)
            Divider().frame(height: 18)
            Button { add(i, .sticky) } label: { Label("Sticky", systemImage: "note") }
            Button { add(i, .text) } label: { Label("Text", systemImage: "textformat") }
            Button { add(i, .rectangle) } label: { Label("Box", systemImage: "rectangle") }
            Button { add(i, .ellipse) } label: { Label("Circle", systemImage: "circle") }
            if let sel = selected {
                Divider().frame(height: 18)
                Button { connecting = sel } label: { Label(connecting == nil ? "Connect" : "Pick target…", systemImage: "arrow.right") }
                Menu("Color") {
                    ForEach(["#FFE27A", "#A7F3D0", "#BFDBFE", "#FBCFE8", "#FED7AA", "#E9D5FF", "#2F3A4A"], id: \.self) { h in
                        Button(h) { mutate(i, sel) { $0.colorHex = h } }
                    }
                }.fixedSize()
                Button { toTask(i, sel) } label: { Label("Convert to task", systemImage: "checkmark.circle") }
                Button(role: .destructive) {
                    store.data.whiteboards[i].items.removeAll { $0.id == sel }
                    store.data.whiteboards[i].connectors.removeAll { $0.from == sel || $0.to == sel }
                    selected = nil
                } label: { Image(systemName: "trash") }
            }
            Spacer()
            Button { zoom = max(zoom - 0.1, 0.4) } label: { Image(systemName: "minus.magnifyingglass") }
            Text("\(Int(zoom * 100))%").monospacedDigit().frame(width: 44)
            Button { zoom = min(zoom + 0.1, 2) } label: { Image(systemName: "plus.magnifyingglass") }
        }
        .buttonStyle(.borderless)
        .padding(10)
    }

    private func itemView(_ i: Int, _ item: BoardItem) -> some View {
        let isSel = selected == item.id
        let d = drag[item.id] ?? .zero
        let textBinding = Binding(get: { item.text }, set: { v in mutate(i, item.id) { $0.text = v } })
        return Group {
            switch item.kind {
            case .sticky:
                TextField("", text: textBinding, axis: .vertical)
                    .textFieldStyle(.plain).padding(10)
                    .frame(width: item.width, height: item.height, alignment: .topLeading)
                    .background(Color(hex: item.colorHex), in: RoundedRectangle(cornerRadius: 4))
                    .foregroundStyle(.black)
                    .shadow(color: .black.opacity(0.15), radius: 3, y: 2)
            case .text:
                TextField("", text: textBinding, axis: .vertical)
                    .textFieldStyle(.plain).font(.title2.bold())
                    .foregroundStyle(Color(hex: item.colorHex))
                    .frame(width: item.width, height: item.height, alignment: .topLeading)
            case .rectangle:
                TextField("", text: textBinding).textFieldStyle(.plain).multilineTextAlignment(.center)
                    .frame(width: item.width, height: item.height)
                    .background(RoundedRectangle(cornerRadius: 8).stroke(Color(hex: item.colorHex == "#FFE27A" ? "#5B8DEF" : item.colorHex), lineWidth: 2))
            case .ellipse:
                TextField("", text: textBinding).textFieldStyle(.plain).multilineTextAlignment(.center)
                    .frame(width: item.width, height: item.height)
                    .background(Ellipse().stroke(Color(hex: item.colorHex == "#FFE27A" ? "#3DBE7A" : item.colorHex), lineWidth: 2))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(isSel ? Color.accentColor : .clear, lineWidth: 2).padding(-3))
        .overlay(alignment: .bottomTrailing) {
            if isSel {
                Image(systemName: "arrow.up.left.and.arrow.down.right").font(.caption2).padding(3)
                    .background(Color.accentColor, in: Circle()).foregroundStyle(.white)
                    .gesture(DragGesture().onEnded { v in
                        mutate(i, item.id) { $0.width = max(60, $0.width + v.translation.width); $0.height = max(30, $0.height + v.translation.height) }
                    })
            }
        }
        .offset(x: item.x + d.width, y: item.y + d.height)
        .onTapGesture {
            if let from = connecting, from != item.id {
                store.data.whiteboards[i].connectors.append(BoardConnector(from: from, to: item.id))
                connecting = nil
            }
            selected = item.id
        }
        .gesture(
            DragGesture(minimumDistance: 3)
                .onChanged { v in drag[item.id] = v.translation }
                .onEnded { v in
                    drag[item.id] = nil
                    mutate(i, item.id) { $0.x += v.translation.width; $0.y += v.translation.height }
                }
        )
    }

    private func add(_ i: Int, _ kind: BoardItemKind) {
        let n = store.data.whiteboards[i].items.count
        var it = BoardItem(kind: kind, text: kind == .text ? "Heading" : "", x: 120 + Double(n % 6) * 40, y: 120 + Double(n % 6) * 30)
        if kind == .text { it.width = 260; it.height = 44; it.colorHex = "#2F3A4A" }
        if kind == .ellipse { it.width = 140; it.height = 140 }
        store.data.whiteboards[i].items.append(it)
        selected = it.id
    }

    private func mutate(_ i: Int, _ id: UUID, _ f: (inout BoardItem) -> Void) {
        if let j = store.data.whiteboards[i].items.firstIndex(where: { $0.id == id }) { f(&store.data.whiteboards[i].items[j]) }
    }

    private func toTask(_ i: Int, _ id: UUID) {
        guard let it = store.data.whiteboards[i].items.first(where: { $0.id == id }), let l = store.data.lists.first else { return }
        let t = store.addTask(it.text.isEmpty ? "Whiteboard item" : it.text, list: l.id)
        store.updateTask(t.id) { $0.details = "Created from whiteboard \"\(store.data.whiteboards[i].name)\"" }
        store.openTaskId = t.id
    }
}

// MARK: - Chat

struct ChatView: View {
    let channelId: UUID
    @Environment(Store.self) private var store
    @State private var text = ""

    var body: some View {
        let msgs = store.data.messages.filter { $0.channelId == channelId }.sorted { $0.date < $1.date }
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(msgs) { m in
                            HStack(alignment: .top) {
                                AvatarView(member: store.member(m.authorId), size: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack {
                                        Text(store.member(m.authorId)?.name ?? "Unknown").bold()
                                        Text(m.date.formatted(date: .omitted, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                                    }
                                    MarkdownText(text: m.text)
                                }
                                Spacer()
                            }
                            .id(m.id)
                            .contextMenu {
                                Button("Create task from message") {
                                    let sp = store.data.channels.first { $0.id == channelId }?.spaceId
                                    if let l = store.data.lists.first(where: { $0.spaceId == sp }) ?? store.data.lists.first {
                                        store.openTaskId = store.addTask(m.text, list: l.id).id
                                    }
                                }
                                Button("Delete", role: .destructive) { store.data.messages.removeAll { $0.id == m.id } }
                            }
                        }
                    }
                    .padding(16)
                }
                .onAppear { proxy.scrollTo(msgs.last?.id) }
                .onChange(of: msgs.count) { proxy.scrollTo(msgs.last?.id) }
            }
            Divider()
            HStack {
                Menu {
                    ForEach(store.data.members) { m in Button("Post as \(m.name)") { send(as: m.id) } }
                } label: { AvatarView(member: store.me, size: 24) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help("Post as another member")
                TextField("Message \(store.title(for: .chat(channelId)))", text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(1...5)
                    .onSubmit { send(as: store.data.currentUserId) }
                Button("Send") { send(as: store.data.currentUserId) }.disabled(text.isEmpty)
            }
            .padding(12)
        }
        .navigationTitle(store.title(for: .chat(channelId)))
    }

    private func send(as author: UUID) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        store.data.messages.append(ChatMessage(channelId: channelId, authorId: author, text: t))
        if author != store.data.currentUserId, t.localizedCaseInsensitiveContains("@" + (store.me.name.split(separator: " ").first.map(String.init) ?? "")) {
            store.notify("\(store.member(author)?.name ?? "Someone") mentioned you in \(store.title(for: .chat(channelId)))", taskId: nil)
        }
        text = ""
    }
}
