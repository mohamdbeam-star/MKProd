import SwiftUI
import AppKit
import UniformTypeIdentifiers

@main
struct MKProdApp: App {
    @State private var store = Store()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup("MK Prod") {
            ContentView()
                .environment(store)
                .frame(minWidth: 1000, minHeight: 640)
                .onAppear {
                    store.requestNotificationPermission()
                    GlobalHotKey.action = { [store] in QuickAddPanel.show(store: store) }
                    GlobalHotKey.register()
                }
        }
        .defaultSize(width: 1440, height: 900)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Task") { NotificationCenter.default.post(name: .newTask, object: nil) }
                    .keyboardShortcut("n")
                Button("Quick Search…") { store.showCommandPalette = true }
                    .keyboardShortcut("k")
                Button("Quick Add Anywhere (⌃⌥Space)") { QuickAddPanel.show(store: store) }
            }
            CommandGroup(after: .saveItem) {
                Button("Save Now") { store.saveNow() }.keyboardShortcut("s")
                Divider()
                Button("Export Workspace (JSON)…") { exportJSON() }
                Button("Import Workspace (JSON)…") { importJSON() }
                Button("Export Tasks (CSV)…") { exportCSV() }
                Button("Import tasks from CSV…") { importTasksCSV() }
            }
            CommandMenu("Go") {
                Button("Home") { store.selection = .home }.keyboardShortcut("1")
                Button("Inbox") { store.selection = .inbox }.keyboardShortcut("2")
                Button("My Tasks") { store.selection = .myTasks }.keyboardShortcut("3")
                Button("Everything") { store.selection = .everything }.keyboardShortcut("4")
                Button("Docs") { store.selection = .docs }.keyboardShortcut("5")
                Button("Goals") { store.selection = .goals }.keyboardShortcut("6")
                Button("Dashboards") { store.selection = .dashboards }.keyboardShortcut("7")
                Button("Timesheets") { store.selection = .timesheet }.keyboardShortcut("8")
            }
            CommandMenu("Time") {
                Button(store.runningEntry == nil ? "Start Timer" : "Stop Timer") {
                    if store.runningEntry == nil { store.startTimer(task: store.openTaskId) } else { store.stopTimer() }
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])
            }
        }

        Settings {
            SettingsView().environment(store).frame(width: 720, height: 620)
        }

        MenuBarExtra {
            MenuBarContent().environment(store)
        } label: {
            Image(systemName: store.runningEntry == nil ? "checkmark.circle" : "record.circle")
        }
        .menuBarExtraStyle(.window)
    }

    private func exportJSON() {
        let p = NSSavePanel()
        p.allowedContentTypes = [.json]
        p.nameFieldStringValue = "MKProd-backup.json"
        if p.runModal() == .OK, let url = p.url {
            do { try store.exportJSON(to: url) } catch { store.lastError = error.localizedDescription }
        }
    }

    private func importJSON() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.json]
        if p.runModal() == .OK, let url = p.url {
            do { try store.importJSON(from: url) } catch { store.lastError = "Import failed: \(error.localizedDescription)" }
        }
    }

    private func importTasksCSV() {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.commaSeparatedText]
        p.message = "Choose a CSV export of tasks (columns such as Space, Folder, List, Task Name, Status, Assignees, Due Date)."
        if p.runModal() == .OK, let url = p.url {
            do {
                let n = try CSVTaskImporter.importFile(url, into: store)
                store.lastError = "Imported \(n) task(s) from the CSV file."
            } catch { store.lastError = "Import failed: \(error.localizedDescription)" }
        }
    }

    private func exportCSV() {
        let p = NSSavePanel()
        p.allowedContentTypes = [.commaSeparatedText]
        p.nameFieldStringValue = "MKProd-tasks.csv"
        if p.runModal() == .OK, let url = p.url {
            let scope = store.selection ?? .everything
            do { try store.exportCSV(store.tasks(for: scope, includeSubtasks: true), to: url) } catch { store.lastError = error.localizedDescription }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
