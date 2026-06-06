/**
 * MyPizzaTeamMenu — macOS menu bar app for managing the mpt daemon.
 *
 * Features:
 * - Status bar icon (🍕) with dropdown menu
 * - Start/Stop daemon controls
 * - Team directory picker
 * - Port configuration
 * - Open UI in browser
 * - Shows daemon status (running/stopped + uptime)
 */

import SwiftUI
import AppKit

@main
struct MyPizzaTeamMenuApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var daemon: DaemonManager!
    var statusTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        daemon = DaemonManager()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = createPizzaIcon()
            button.image?.isTemplate = true
        }

        updateMenu()

        // Poll daemon status every 5 seconds
        statusTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.daemon.checkStatus()
            DispatchQueue.main.async { self?.updateMenu() }
        }
        daemon.checkStatus()
    }

    func updateMenu() {
        let menu = NSMenu()

        // Status line
        let statusText = daemon.isRunning
            ? "✅ Running (port \(daemon.port))"
            : "⏹ Stopped"
        let statusItem = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)

        if daemon.isRunning, let uptime = daemon.uptime {
            let uptimeItem = NSMenuItem(title: "   Uptime: \(formatUptime(uptime))", action: nil, keyEquivalent: "")
            uptimeItem.isEnabled = false
            menu.addItem(uptimeItem)

            if let agents = daemon.agentCount {
                let agentItem = NSMenuItem(title: "   Agents: \(agents)", action: nil, keyEquivalent: "")
                agentItem.isEnabled = false
                menu.addItem(agentItem)
            }
        }

        menu.addItem(NSMenuItem.separator())

        // Start/Stop
        if daemon.isRunning {
            menu.addItem(NSMenuItem(title: "Stop Daemon", action: #selector(stopDaemon), keyEquivalent: "s"))
            menu.addItem(NSMenuItem(title: "Open UI in Browser", action: #selector(openUI), keyEquivalent: "o"))
        } else {
            menu.addItem(NSMenuItem(title: "Start Daemon", action: #selector(startDaemon), keyEquivalent: "s"))
        }

        menu.addItem(NSMenuItem.separator())

        // Team Dir
        let teamDirTitle = daemon.teamDir.isEmpty
            ? "Team Directory: (not set)"
            : "Team Directory: \(abbreviatePath(daemon.teamDir))"
        let teamDirItem = NSMenuItem(title: teamDirTitle, action: nil, keyEquivalent: "")
        teamDirItem.isEnabled = false
        menu.addItem(teamDirItem)
        menu.addItem(NSMenuItem(title: "Choose Team Directory…", action: #selector(chooseTeamDir), keyEquivalent: "d"))

        menu.addItem(NSMenuItem.separator())

        // Port
        let portItem = NSMenuItem(title: "Port: \(daemon.port)", action: nil, keyEquivalent: "")
        portItem.isEnabled = false
        menu.addItem(portItem)

        menu.addItem(NSMenuItem.separator())

        // Quit
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))

        // Set targets
        for item in menu.items {
            item.target = self
        }

        self.statusItem.menu = menu
    }

    @objc func startDaemon() {
        daemon.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.daemon.checkStatus()
            self?.updateMenu()
        }
    }

    @objc func stopDaemon() {
        daemon.stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.daemon.checkStatus()
            self?.updateMenu()
        }
    }

    @objc func openUI() {
        let url = URL(string: "http://localhost:\(daemon.port)")!
        NSWorkspace.shared.open(url)
    }

    @objc func chooseTeamDir() {
        let panel = NSOpenPanel()
        panel.title = "Choose Team Directory"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false

        if !daemon.teamDir.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: daemon.teamDir)
        }

        if panel.runModal() == .OK, let url = panel.url {
            daemon.teamDir = url.path
            daemon.savePreferences()
            updateMenu()
        }
    }

    @objc func quit() {
        if daemon.isRunning {
            daemon.stop()
        }
        NSApp.terminate(nil)
    }

    func formatUptime(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }

    func abbreviatePath(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    /// Create a 18x18 pizza slice icon as a template image for the menu bar.
    func createPizzaIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let ctx = NSGraphicsContext.current!.cgContext
            let color = NSColor.black
            ctx.setFillColor(color.cgColor)
            ctx.setStrokeColor(color.cgColor)
            ctx.setLineWidth(1.2)

            // Pizza slice triangle (pointing up)
            let path = CGMutablePath()
            path.move(to: CGPoint(x: 9, y: 16))     // top center (tip)
            path.addLine(to: CGPoint(x: 2, y: 3))   // bottom left
            // Curved crust at the bottom
            path.addQuadCurve(to: CGPoint(x: 16, y: 3), control: CGPoint(x: 9, y: 1))
            path.closeSubpath()
            ctx.addPath(path)
            ctx.strokePath()

            // Pepperoni dots
            ctx.fillEllipse(in: CGRect(x: 7, y: 9, width: 3, height: 3))
            ctx.fillEllipse(in: CGRect(x: 5, y: 5, width: 2.5, height: 2.5))
            ctx.fillEllipse(in: CGRect(x: 10, y: 5.5, width: 2.5, height: 2.5))

            return true
        }
        image.isTemplate = true
        return image
    }
}
