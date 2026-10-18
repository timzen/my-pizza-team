/**
 * DaemonManager — Manages the mpt daemon process lifecycle.
 *
 * Handles:
 * - Starting/stopping the daemon subprocess
 * - Health check polling
 * - Preferences persistence (teamDir, port)
 * - Finding mpt: the saved Node (~/.config/mpt/runtime.json) running the
 *   installed npm package, else `mpt` on the login shell's PATH
 */

import Foundation

class DaemonManager {
    var isRunning = false
    var uptime: Int?
    var agentCount: Int?
    var teamDir: String
    var port: Int
    /// Bundle path of the browser to open the UI with. Empty = system default.
    var browserAppPath: String
    /// Bundle path of the terminal to open the team dir in. Empty = Terminal.app.
    var terminalAppPath: String
    /// Custom leader launch command (template). Empty = built-in default.
    var leaderCommand: String
    /// Configured tmux session name (from /health); used by the default leader command.
    var tmuxSession: String = ""
    /// Whether a leader coordinator is connected (from /health).
    var leaderPresent: Bool = false
    var lastError: String?
    /// Set when the last start found no mpt to run; the menu shows it instead of a log error.
    var installHint: String?
    private var process: Process?

    /// Built-in leader launch command. Runs via the user's login shell.
    /// Placeholders: {session} {dir} {port} {url}. Kept as a soft, editable
    /// default so the app has no hard dependency on the pi harness — it just
    /// ships a sensible starting command the user can change.
    static let defaultLeaderCommand =
        "tmux new-session -A -d -s \"{session}\" -n leader -c \"{dir}\" 'pi --ppt-lead --ppt-daemon={url}'"

    private let prefsKey = "com.my-pizza-team.menubar"

    init() {
        let defaults = UserDefaults.standard
        self.teamDir = defaults.string(forKey: "\(prefsKey).teamDir") ?? ""
        self.port = defaults.integer(forKey: "\(prefsKey).port")
        if self.port == 0 { self.port = 7437 }
        self.browserAppPath = defaults.string(forKey: "\(prefsKey).browserAppPath") ?? ""
        self.terminalAppPath = defaults.string(forKey: "\(prefsKey).terminalAppPath") ?? ""
        self.leaderCommand = defaults.string(forKey: "\(prefsKey).leaderCommand") ?? ""

        // Auto-detect team dir if not set
        if self.teamDir.isEmpty {
            let candidates = [
                FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".my-pizza-team").path,
                FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".pi-pizza-team").path,
                FileManager.default.currentDirectoryPath + "/.my-pizza-team",
                FileManager.default.currentDirectoryPath + "/.pi-pizza-team",
            ]
            for candidate in candidates {
                if FileManager.default.fileExists(atPath: candidate) {
                    self.teamDir = candidate
                    break
                }
            }
        }
    }

    func savePreferences() {
        let defaults = UserDefaults.standard
        defaults.set(teamDir, forKey: "\(prefsKey).teamDir")
        defaults.set(port, forKey: "\(prefsKey).port")
        defaults.set(browserAppPath, forKey: "\(prefsKey).browserAppPath")
        defaults.set(terminalAppPath, forKey: "\(prefsKey).terminalAppPath")
        defaults.set(leaderCommand, forKey: "\(prefsKey).leaderCommand")
    }

    /// The leader command template in effect (custom if set, else the default).
    func effectiveLeaderCommand() -> String {
        return leaderCommand.isEmpty ? DaemonManager.defaultLeaderCommand : leaderCommand
    }

    /// The directory the leader should run in: the project dir (parent of the
    /// `.my-pizza-team` state dir), falling back to the team dir or home.
    func leaderDir() -> String {
        if teamDir.isEmpty { return FileManager.default.homeDirectoryForCurrentUser.path }
        let ns = teamDir as NSString
        let last = ns.lastPathComponent
        if last == ".my-pizza-team" || last == ".pi-pizza-team" {
            return ns.deletingLastPathComponent
        }
        return teamDir
    }

    /// The effective leader command with placeholders substituted.
    func resolvedLeaderCommand() -> String {
        let session = tmuxSession.isEmpty ? "my-pizza-team" : tmuxSession
        return effectiveLeaderCommand()
            .replacingOccurrences(of: "{session}", with: session)
            .replacingOccurrences(of: "{dir}", with: leaderDir())
            .replacingOccurrences(of: "{port}", with: String(port))
            .replacingOccurrences(of: "{url}", with: "http://localhost:\(port)")
    }

    // MARK: - Finding mpt

    /// How to run mpt: the executable, the arguments before mpt's own (the package
    /// entry when launching through node), and the PATH to give it.
    struct MptLaunch {
        let executable: String
        let leadingArguments: [String]
        let path: String?
    }

    /// Shown in the menu when mpt can't be found at all.
    static let installHintText = "mpt not found. Install with `npm i -g my-pizza-team`, then run `mpt setup`"

    /// Find how to launch mpt. mpt is an npm package run by Node, so the app no
    /// longer bundles a binary. In order:
    ///   1. The saved Node (`MPT_NODE`, else `~/.config/mpt/runtime.json`, written by
    ///      `mpt setup`/`install`/`upgrade`), running the package entry found next to
    ///      it — the same Node the launchd service and `mpt upgrade` use.
    ///   2. `mpt` on the login shell's PATH (a node shebang script; it runs because
    ///      that PATH also has node).
    private func findMpt() -> MptLaunch? {
        let shellPath = loginShellPath()

        if let node = savedNode(), let entry = packageEntry(forNode: node) {
            let nodeDir = (node as NSString).deletingLastPathComponent
            // Put the saved Node's directory first so whatever the daemon spawns
            // (`pi`, other node shebang scripts) finds the same Node.
            let path = [nodeDir, shellPath ?? ProcessInfo.processInfo.environment["PATH"] ?? ""]
                .filter { !$0.isEmpty }.joined(separator: ":")
            return MptLaunch(executable: node, leadingArguments: [entry], path: path)
        }

        if let bin = loginShellWhichMpt() {
            return MptLaunch(executable: bin, leadingArguments: [], path: shellPath)
        }
        return nil
    }

    /// The Node that runs mpt: `MPT_NODE`, else the "node" key of
    /// `~/.config/mpt/runtime.json` (see shared/runtime-config.ts). Kept as written,
    /// never symlink-resolved, so a Homebrew `/opt/homebrew/bin/node` survives upgrades.
    private func savedNode() -> String? {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["MPT_NODE"], !env.isEmpty,
           fm.isExecutableFile(atPath: env) {
            return env
        }
        let file = fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/mpt/runtime.json")
        guard let data = try? Data(contentsOf: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let node = json["node"] as? String, !node.isEmpty,
              fm.isExecutableFile(atPath: node) else {
            return nil
        }
        return node
    }

    /// The installed package's entry (`.../my-pizza-team/dist/main.js`) for `node`.
    /// First the `mpt` bin npm links next to node (`<dirname(node)>/mpt` → realpath),
    /// then — for a custom npm prefix — the global root reported by that Node's npm.
    private func packageEntry(forNode node: String) -> String? {
        let fm = FileManager.default
        let nodeDir = (node as NSString).deletingLastPathComponent

        let bin = (nodeDir as NSString).appendingPathComponent("mpt")
        if fm.fileExists(atPath: bin) {
            let real = (bin as NSString).resolvingSymlinksInPath
            if real.hasSuffix(".js") && fm.fileExists(atPath: real) { return real }
        }

        // npm is a JS script next to node; run it with this exact node, so the answer
        // is the prefix `mpt upgrade` installs into.
        let npm = (nodeDir as NSString).appendingPathComponent("npm")
        if fm.fileExists(atPath: npm),
           let root = run(node, [npm, "root", "-g"], path: nodeDir + ":/usr/bin:/bin"),
           !root.isEmpty {
            let entry = (root as NSString).appendingPathComponent("my-pizza-team/dist/main.js")
            if fm.fileExists(atPath: entry) { return entry }
        }
        return nil
    }

    /// The login shell's PATH (GUI apps get a minimal one), the same way App.swift
    /// runs the leader command through `$SHELL -lc`.
    private func loginShellPath() -> String? {
        // A marker, because profile scripts may print their own output.
        guard let out = runLoginShell("printf '__MPT_PATH__=%s\\n' \"$PATH\"") else { return nil }
        return markedValue(out, "__MPT_PATH__=")
    }

    /// `command -v mpt` in the login shell.
    private func loginShellWhichMpt() -> String? {
        guard let out = runLoginShell("printf '__MPT_BIN__=%s\\n' \"$(command -v mpt)\"") else { return nil }
        guard let bin = markedValue(out, "__MPT_BIN__="),
              FileManager.default.isExecutableFile(atPath: bin) else { return nil }
        return bin
    }

    private func runLoginShell(_ command: String) -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        return run(shell, ["-lc", command], path: nil)
    }

    /// The non-empty value after `marker` on the last line that starts with it.
    private func markedValue(_ output: String, _ marker: String) -> String? {
        let line = output.components(separatedBy: "\n").last { $0.hasPrefix(marker) }
        guard let value = line?.dropFirst(marker.count), !value.isEmpty else { return nil }
        return String(value)
    }

    /// Run a command and return its trimmed stdout, or nil if it couldn't run or failed.
    private func run(_ executable: String, _ arguments: [String], path: String?) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = arguments
        if let path = path {
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = path
            p.environment = env
        }
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        // Read before waiting, so a full pipe can't deadlock the child.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Lifecycle

    func start() {
        guard !isRunning else { return }
        // Re-resolved on every start, so installing mpt while the app runs just works.
        guard let mpt = findMpt() else {
            NSLog("mpt not found")
            installHint = DaemonManager.installHintText
            return
        }
        installHint = nil

        // Validate team dir exists or can be created
        if !teamDir.isEmpty && !FileManager.default.fileExists(atPath: teamDir) {
            do {
                try FileManager.default.createDirectory(atPath: teamDir, withIntermediateDirectories: true)
            } catch {
                NSLog("Failed to create team dir: \(error)")
                return
            }
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: mpt.executable)
        proc.arguments = mpt.leadingArguments + ["start"]
        var env = ProcessInfo.processInfo.environment
        if let path = mpt.path { env["PATH"] = path }
        if !teamDir.isEmpty {
            env["TEAM_DIR"] = teamDir
        }
        env["PORT"] = String(port)
        proc.environment = env

        // Log stdout/stderr to a file for debugging
        let logDir = teamDir.isEmpty
            ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".my-pizza-team").path
            : teamDir
        if !FileManager.default.fileExists(atPath: logDir) {
            try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        }
        let logFile = (logDir as NSString).appendingPathComponent("daemon.log")
        FileManager.default.createFile(atPath: logFile, contents: nil)
        let logHandle = FileHandle(forWritingAtPath: logFile)
        logHandle?.seekToEndOfFile()
        proc.standardOutput = logHandle ?? FileHandle.nullDevice
        proc.standardError = logHandle ?? FileHandle.nullDevice

        do {
            try proc.run()
            self.process = proc
            NSLog("mpt daemon started via \(mpt.executable) (PID: \(proc.processIdentifier)), log: \(logFile)")
        } catch {
            NSLog("Failed to start mpt: \(error)")
        }
    }

    func stop() {
        // Try graceful shutdown via the process we spawned
        if let proc = process, proc.isRunning {
            proc.terminate()
            process = nil
        }

        // Also try to find and kill the PID from the pid file
        if !teamDir.isEmpty {
            let pidFile = (teamDir as NSString).appendingPathComponent("daemon.pid")
            if let pidStr = try? String(contentsOfFile: pidFile, encoding: .utf8),
               let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
                kill(pid, SIGTERM)
            }
        }

        isRunning = false
        uptime = nil
        agentCount = nil
        leaderPresent = false
    }

    func checkStatus() {
        guard let url = URL(string: "http://localhost:\(port)/health") else {
            isRunning = false
            return
        }

        let semaphore = DispatchSemaphore(value: 0)
        var request = URLRequest(url: url)
        request.timeoutInterval = 2.0

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            defer { semaphore.signal() }
            guard let self = self,
                  let data = data,
                  let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                self?.isRunning = false
                self?.uptime = nil
                self?.agentCount = nil
                self?.leaderPresent = false
                return
            }

            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                self.isRunning = (json["status"] as? String) == "ok"
                self.uptime = json["uptime"] as? Int
                self.agentCount = json["agents"] as? Int
                self.leaderPresent = json["leaderPresent"] as? Bool ?? false
                if let session = json["tmuxSession"] as? String, !session.isEmpty { self.tmuxSession = session }
                if self.isRunning { self.lastError = nil }
            }
        }.resume()

        _ = semaphore.wait(timeout: .now() + 3.0)
    }

    /// Check daemon.log for error messages (called when daemon fails to start)
    func checkLogForErrors() {
        let logDir = teamDir.isEmpty
            ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".my-pizza-team").path
            : teamDir
        let logFile = (logDir as NSString).appendingPathComponent("daemon.log")
        guard let content = try? String(contentsOfFile: logFile, encoding: .utf8) else { return }

        // Look for error lines in the last few lines
        let lines = content.components(separatedBy: "\n").suffix(10)
        for line in lines {
            if line.contains("❌") || line.contains("Failed") || line.contains("Error") {
                lastError = line.trimmingCharacters(in: .whitespaces)
                return
            }
        }
        lastError = "Daemon failed to start. Check: \(logFile)"
    }
}
