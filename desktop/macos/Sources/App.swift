/**
 * MyPizzaTeamMenu — macOS menu bar app for managing the mpt daemon.
 *
 * Features:
 * - Status bar icon (🍕) with dropdown menu
 * - Start/Stop/Restart daemon controls
 * - Team directory picker + reveal in Finder
 * - Port configuration
 * - Open UI in a chosen browser (configurable)
 * - Open the team directory in a chosen terminal (configurable)
 * - Shows the app version and daemon status (running/stopped + uptime)
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
            : daemon.lastError != nil ? "❌ Failed to start" : "⏹ Stopped"
        let statusItem = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)

        // Show error if daemon failed
        if !daemon.isRunning, let error = daemon.lastError {
            let errorItem = NSMenuItem(title: "   \(error)", action: nil, keyEquivalent: "")
            errorItem.isEnabled = false
            menu.addItem(errorItem)

            let logDir = daemon.teamDir.isEmpty
                ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".my-pizza-team").path
                : daemon.teamDir
            let logPath = (logDir as NSString).appendingPathComponent("daemon.log")
            menu.addItem(NSMenuItem(title: "   Open daemon.log", action: #selector(openLog), keyEquivalent: "l"))
        }

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

        // Start/Stop/Restart
        if daemon.isRunning {
            menu.addItem(NSMenuItem(title: "Stop Daemon", action: #selector(stopDaemon), keyEquivalent: "s"))
            menu.addItem(NSMenuItem(title: "Restart Daemon", action: #selector(restartDaemon), keyEquivalent: "r"))
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
        let revealItem = NSMenuItem(title: "Open Team Directory in Finder", action: #selector(openTeamDir), keyEquivalent: "")
        // Only actionable when a directory is set and exists on disk.
        revealItem.isEnabled = !daemon.teamDir.isEmpty && FileManager.default.fileExists(atPath: daemon.teamDir)
        menu.addItem(revealItem)
        let termItem = NSMenuItem(title: "Open Team Directory in Terminal", action: #selector(openTeamDirInTerminal), keyEquivalent: "")
        termItem.isEnabled = !daemon.teamDir.isEmpty && FileManager.default.fileExists(atPath: daemon.teamDir)
        menu.addItem(termItem)

        menu.addItem(NSMenuItem.separator())

        // Port
        let portItem = NSMenuItem(title: "Port: \(daemon.port)", action: nil, keyEquivalent: "")
        portItem.isEnabled = false
        menu.addItem(portItem)

        // Browser selection
        let browserItem = NSMenuItem(title: "Browser: \(currentBrowserName())", action: nil, keyEquivalent: "")
        browserItem.submenu = buildBrowserMenu()
        menu.addItem(browserItem)

        // Terminal selection
        let terminalItem = NSMenuItem(title: "Terminal: \(currentTerminalName())", action: nil, keyEquivalent: "")
        terminalItem.submenu = buildTerminalMenu()
        menu.addItem(terminalItem)

        menu.addItem(NSMenuItem.separator())

        // Version (read from the app bundle; falls back to "dev" for `swift run").
        let versionItem = NSMenuItem(title: "My Pizza Team v\(appVersion())", action: nil, keyEquivalent: "")
        versionItem.isEnabled = false
        menu.addItem(versionItem)

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
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.daemon.checkStatus()
            if !(self?.daemon.isRunning ?? false) {
                self?.daemon.checkLogForErrors()
            }
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

    @objc func restartDaemon() {
        daemon.stop()
        // Give the old process a moment to release the port before starting again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self else { return }
            self.daemon.start()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                self.daemon.checkStatus()
                if !self.daemon.isRunning { self.daemon.checkLogForErrors() }
                self.updateMenu()
            }
        }
    }

    @objc func openUI() {
        let url = URL(string: "http://localhost:\(daemon.port)")!
        if daemon.browserAppPath.isEmpty {
            NSWorkspace.shared.open(url)
        } else {
            // Open the UI with the user's chosen browser; fall back to the system
            // default if that app can't be launched (e.g. it was uninstalled).
            let appURL = URL(fileURLWithPath: daemon.browserAppPath)
            let config = NSWorkspace.OpenConfiguration()
            NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config) { _, error in
                if error != nil {
                    DispatchQueue.main.async { NSWorkspace.shared.open(url) }
                }
            }
        }
    }

    @objc func openTeamDir() {
        guard !daemon.teamDir.isEmpty else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: daemon.teamDir))
    }

    @objc func openTeamDirInTerminal() {
        guard !daemon.teamDir.isEmpty else { return }
        let dirURL = URL(fileURLWithPath: daemon.teamDir)
        // Empty pref = Apple's Terminal.app.
        let termURL = daemon.terminalAppPath.isEmpty
            ? URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
            : URL(fileURLWithPath: daemon.terminalAppPath)
        let config = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open([dirURL], withApplicationAt: termURL, configuration: config) { _, error in
            if error != nil {
                // Fall back to `open -a Terminal <dir>` if the chosen app failed.
                DispatchQueue.main.async {
                    let p = Process()
                    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                    p.arguments = ["-a", "Terminal", self.daemon.teamDir]
                    try? p.run()
                }
            }
        }
    }

    /// Choose which browser opens the UI. An empty represented object means "system default".
    @objc func selectBrowser(_ sender: NSMenuItem) {
        daemon.browserAppPath = (sender.representedObject as? String) ?? ""
        daemon.savePreferences()
        updateMenu()
    }

    /// Choose which terminal opens the team dir. Empty represented object means Terminal.app.
    @objc func selectTerminal(_ sender: NSMenuItem) {
        daemon.terminalAppPath = (sender.representedObject as? String) ?? ""
        daemon.savePreferences()
        updateMenu()
    }

    /// Pick any terminal app from disk (for terminals not in the known list).
    @objc func chooseTerminal() {
        let panel = NSOpenPanel()
        panel.title = "Choose Terminal App"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        if panel.runModal() == .OK, let url = panel.url {
            daemon.terminalAppPath = url.path
            daemon.savePreferences()
            updateMenu()
        }
    }

    @objc func openLog() {
        let logDir = daemon.teamDir.isEmpty
            ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".my-pizza-team").path
            : daemon.teamDir
        let logPath = (logDir as NSString).appendingPathComponent("daemon.log")
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
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

    /// The app's version string from its bundle Info.plist, or "dev" for `swift run`.
    func appVersion() -> String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return (v?.isEmpty == false) ? v! : "dev"
    }

    /// Display name of the currently selected browser ("System Default" when unset).
    func currentBrowserName() -> String {
        if daemon.browserAppPath.isEmpty { return "System Default" }
        return URL(fileURLWithPath: daemon.browserAppPath).deletingPathExtension().lastPathComponent
    }

    /// Apps able to open an http(s) URL, i.e. installed browsers.
    func installedBrowsers() -> [URL] {
        guard let probe = URL(string: "https://localhost") else { return [] }
        let urls = NSWorkspace.shared.urlsForApplications(toOpen: probe)
        // De-dupe and sort by display name for a stable menu.
        var seen = Set<String>()
        return urls
            .filter { seen.insert($0.path).inserted }
            .sorted { $0.deletingPathExtension().lastPathComponent.localizedCaseInsensitiveCompare($1.deletingPathExtension().lastPathComponent) == .orderedAscending }
    }

    /// Submenu for picking the browser that opens the UI: System Default + each installed browser.
    func buildBrowserMenu() -> NSMenu {
        let submenu = NSMenu()

        let defaultItem = NSMenuItem(title: "System Default", action: #selector(selectBrowser(_:)), keyEquivalent: "")
        defaultItem.representedObject = ""
        defaultItem.state = daemon.browserAppPath.isEmpty ? .on : .off
        defaultItem.target = self
        submenu.addItem(defaultItem)

        submenu.addItem(NSMenuItem.separator())

        for appURL in installedBrowsers() {
            let name = appURL.deletingPathExtension().lastPathComponent
            let item = NSMenuItem(title: name, action: #selector(selectBrowser(_:)), keyEquivalent: "")
            item.representedObject = appURL.path
            item.state = (appURL.path == daemon.browserAppPath) ? .on : .off
            item.target = self
            submenu.addItem(item)
        }

        return submenu
    }

    /// Display name of the currently selected terminal ("Terminal" when unset).
    func currentTerminalName() -> String {
        if daemon.terminalAppPath.isEmpty { return "Terminal" }
        return URL(fileURLWithPath: daemon.terminalAppPath).deletingPathExtension().lastPathComponent
    }

    /// Installed terminal apps, discovered by probing well-known bundle ids
    /// (macOS has no "apps that open a dir in a terminal" query like it does for browsers).
    func installedTerminals() -> [URL] {
        let bundleIDs = [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "dev.warp.Warp-Stable",
            "net.kovidgoyal.kitty",
            "org.alacritty",
            "com.github.wez.wezterm",
            "com.mitchellh.ghostty",
            "co.zeit.hyper",
        ]
        var urls: [URL] = []
        var seen = Set<String>()
        for id in bundleIDs {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id), seen.insert(url.path).inserted {
                urls.append(url)
            }
        }
        // Include a custom pick that isn't in the known list so it stays visible/checked.
        if !daemon.terminalAppPath.isEmpty, seen.insert(daemon.terminalAppPath).inserted {
            urls.append(URL(fileURLWithPath: daemon.terminalAppPath))
        }
        return urls.sorted { $0.deletingPathExtension().lastPathComponent.localizedCaseInsensitiveCompare($1.deletingPathExtension().lastPathComponent) == .orderedAscending }
    }

    /// Submenu for picking the terminal that opens the team dir: known terminals + a Choose… escape hatch.
    func buildTerminalMenu() -> NSMenu {
        let submenu = NSMenu()

        let defaultItem = NSMenuItem(title: "Terminal (default)", action: #selector(selectTerminal(_:)), keyEquivalent: "")
        defaultItem.representedObject = ""
        defaultItem.state = daemon.terminalAppPath.isEmpty ? .on : .off
        defaultItem.target = self
        submenu.addItem(defaultItem)

        submenu.addItem(NSMenuItem.separator())

        for appURL in installedTerminals() where appURL.lastPathComponent != "Terminal.app" {
            let name = appURL.deletingPathExtension().lastPathComponent
            let item = NSMenuItem(title: name, action: #selector(selectTerminal(_:)), keyEquivalent: "")
            item.representedObject = appURL.path
            item.state = (appURL.path == daemon.terminalAppPath) ? .on : .off
            item.target = self
            submenu.addItem(item)
        }

        submenu.addItem(NSMenuItem.separator())
        let chooseItem = NSMenuItem(title: "Choose…", action: #selector(chooseTerminal), keyEquivalent: "")
        chooseItem.target = self
        submenu.addItem(chooseItem)

        return submenu
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
