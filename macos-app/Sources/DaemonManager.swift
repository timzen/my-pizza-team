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
    private var process: Process?

    private let prefsKey = "com.my-pizza-team.menubar"

    init() {
        let defaults = UserDefaults.standard
        self.teamDir = defaults.string(forKey: "\(prefsKey).teamDir") ?? ""
        self.port = defaults.integer(forKey: "\(prefsKey).port")
        if self.port == 0 { self.port = 7437 }

        // Auto-detect team dir if not set
        if self.teamDir.isEmpty {
            let candidates = [
                FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".pi-pizza-team").path,
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

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.arguments = [] // daemon/main.ts is the entry point for the compiled binary
        var env = ProcessInfo.processInfo.environment
        if !teamDir.isEmpty {
            env["TEAM_DIR"] = teamDir
        }
        env["PORT"] = String(port)
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            self.process = proc
            NSLog("mpt daemon started (PID: \(proc.processIdentifier))")
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
            }
        }.resume()

        _ = semaphore.wait(timeout: .now() + 3.0)
    }
}
