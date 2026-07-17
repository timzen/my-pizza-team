/**
 * DaemonManager — Manages the mpt daemon process lifecycle.
 *
 * Handles:
 * - Starting/stopping the daemon subprocess
 * - Health check polling
 * - Preferences persistence (teamDir, port)
 * - Finding the mpt binary (bundled or in PATH)
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
    var lastError: String?
    private var process: Process?

    private let prefsKey = "com.my-pizza-team.menubar"

    init() {
        let defaults = UserDefaults.standard
        self.teamDir = defaults.string(forKey: "\(prefsKey).teamDir") ?? ""
        self.port = defaults.integer(forKey: "\(prefsKey).port")
        if self.port == 0 { self.port = 7437 }
        self.browserAppPath = defaults.string(forKey: "\(prefsKey).browserAppPath") ?? ""
        self.terminalAppPath = defaults.string(forKey: "\(prefsKey).terminalAppPath") ?? ""

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
    }

    /// Find the mpt binary path
    private func findBinary() -> String? {
        // Check alongside this app bundle
        if let bundlePath = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("mpt") {
            if FileManager.default.isExecutableFile(atPath: bundlePath.path) {
                return bundlePath.path
            }
        }

        // Check /usr/local/bin
        let usrLocal = "/usr/local/bin/mpt"
        if FileManager.default.isExecutableFile(atPath: usrLocal) {
            return usrLocal
        }

        // Check in PATH via `which`
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["mpt"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = FileHandle.nullDevice
        try? which.run()
        which.waitUntilExit()
        if which.terminationStatus == 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !path.isEmpty { return path }
        }

        return nil
    }

    func start() {
        guard !isRunning else { return }
        guard let binary = findBinary() else {
            NSLog("mpt binary not found")
            return
        }

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
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.arguments = ["start"]
        var env = ProcessInfo.processInfo.environment
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
            NSLog("mpt daemon started (PID: \(proc.processIdentifier)), log: \(logFile)")
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
                return
            }

            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                self.isRunning = (json["status"] as? String) == "ok"
                self.uptime = json["uptime"] as? Int
                self.agentCount = json["agents"] as? Int
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
