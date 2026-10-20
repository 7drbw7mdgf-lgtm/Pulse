import Foundation
import CryptoKit

let pulseRepo = "7drbw7mdgf-lgtm/Pulse"
let setupModels = ["gemma3:4b", "nomic-embed-text"]

struct SetupFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
struct ReleaseAsset: Codable {
    let name: String
    let size: Int64
    let digest: String?
    let browser_download_url: String
}
struct Release: Codable {
    let tag_name: String
    let draft: Bool
    let prerelease: Bool
    let assets: [ReleaseAsset]
}
struct Component: Codable {
    let file: String
    let bytes: Int64
    let sha256: String
}
struct Manifest: Codable {
    let schema: Int
    let version: String
    let bundled: [String]
    let components: [String: Component]
}
struct InstallPlan {
    let version: String
    let pulse: ReleaseAsset
}
func validVersion(_ text: String) -> Bool {
    text.range(of: #"^\d{1,4}\.\d{1,4}\.\d{1,4}$"#, options: .regularExpression) != nil
}
func versionParts(_ version: String) -> [Int] { version.split(separator: ".").compactMap { Int($0) } }
func atLeast(_ version: String, _ minimum: String) -> Bool {
    let a = versionParts(version), b = versionParts(minimum)
    return a == b || b.lexicographicallyPrecedes(a)
}
func validHash(_ hash: String) -> Bool {
    hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
}
func assetURL(_ asset: ReleaseAsset, repo: String, tag: String) throws -> URL {
    guard asset.size > 0, asset.size <= 20 * 1024 * 1024 * 1024,
          !asset.name.isEmpty, !asset.name.contains("/"), !asset.name.contains("\\"),
          !asset.name.contains(".."), !tag.contains("/"),
          let digest = asset.digest, digest.hasPrefix("sha256:"), validHash(String(digest.dropFirst(7))),
          let url = URL(string: asset.browser_download_url), url.scheme == "https",
          url.host == "github.com", url.user == nil, url.password == nil, url.port == nil,
          url.query == nil, url.fragment == nil,
          url.path == "/\(repo)/releases/download/\(tag)/\(asset.name)" else {
        throw SetupFailure("GitHub supplied an invalid asset or missing SHA-256 digest. No file was installed.")
    }
    return url
}
func makePlan(_ manifest: Manifest, _ release: Release, platform: String = "macos-arm64") throws -> InstallPlan {
    guard manifest.schema == 1, validVersion(manifest.version), atLeast(manifest.version, "2.1.1"),
          release.tag_name == "v\(manifest.version)", !release.draft, !release.prerelease,
          Set(["python", "pdf", "ocr", "search-ranker"]).isSubset(of: Set(manifest.bundled)) else {
        throw SetupFailure("This release does not contain the complete Pulse runtime required by setup.")
    }
    guard let component = manifest.components[platform] else {
        throw SetupFailure("Pulse \(manifest.version) has no compatible package for this computer yet. Try again after the publisher adds it.")
    }
    let expected = platform == "macos-arm64" ? "Pulse-\(manifest.version).dmg" : "Pulse-\(manifest.version)-Windows-x64-Setup.exe"
    guard component.file == expected, validHash(component.sha256),
          let asset = release.assets.first(where: { $0.name == expected }),
          asset.size == component.bytes, asset.digest == "sha256:\(component.sha256)" else {
        throw SetupFailure("The setup manifest and GitHub installer do not agree. Retry after the release upload finishes.")
    }
    _ = try assetURL(asset, repo: pulseRepo, tag: release.tag_name)
    return InstallPlan(version: manifest.version, pulse: asset)
}
func sha256(_ path: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: path)
    defer { try? file.close() }
    var hash = SHA256()
    while let bytes = try file.read(upToCount: 1024 * 1024), !bytes.isEmpty { hash.update(data: bytes) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
func verified(_ path: URL, _ asset: ReleaseAsset) -> Bool {
    guard let size = try? path.resourceValues(forKeys: [.fileSizeKey]).fileSize,
          Int64(size) == asset.size, let digest = asset.digest else { return false }
    return (try? sha256(path)) == String(digest.dropFirst(7))
}
// Renames occur on the destination volume. A failed replacement restores the previous app.
func replaceApp(staged: URL, destination: URL, beforeCommit: (() throws -> Void)? = nil) throws {
    let fm = FileManager.default
    let backup = destination.deletingLastPathComponent().appendingPathComponent(".Pulse-previous-\(UUID().uuidString).app")
    let existed = fm.fileExists(atPath: destination.path)
    if existed { try fm.moveItem(at: destination, to: backup) }
    do {
        try beforeCommit?()
        try fm.moveItem(at: staged, to: destination)
    } catch {
        if existed { try fm.moveItem(at: backup, to: destination) }
        throw error
    }
    if existed { try? fm.removeItem(at: backup) }
}

// URLSession streams large downloads to disk. Only GitHub's HTTPS asset redirects are accepted.
final class Download: NSObject, URLSessionDownloadDelegate {
    let done = DispatchSemaphore(value: 0)
    var failure: Error?
    var result: URL?
    let limit: Int64
    let output: URL
    let progress: (Int64, Int64) -> Void
    var lastUpdate = Date.distantPast
    init(output: URL, limit: Int64, progress: @escaping (Int64, Int64) -> Void) {
        self.output = output; self.limit = limit; self.progress = progress
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let hosts = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]
        let allowed = request.url?.scheme == "https" && hosts.contains(request.url?.host ?? "") &&
            request.url?.user == nil && request.url?.password == nil && (request.url?.port == nil || request.url?.port == 443)
        if !allowed { failure = SetupFailure("GitHub redirected the download to an untrusted address.") }
        completionHandler(allowed ? request : nil)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit { failure = SetupFailure("Download is larger than the release metadata allows."); downloadTask.cancel() }
        if Date().timeIntervalSince(lastUpdate) >= 0.1 || totalBytesWritten >= limit {
            lastUpdate = Date(); progress(totalBytesWritten, totalBytesExpectedToWrite)
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let response = downloadTask.response as? HTTPURLResponse, response.statusCode == 200 else {
            let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
            failure = SetupFailure(status == 403 || status == 429 ? "GitHub is rate limiting requests. Wait a few minutes and retry." : "Download failed (HTTP \(status)). Check your connection and retry.")
            return
        }
        do {
            let size = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard Int64(size) <= limit else { throw SetupFailure("Download exceeded its expected size.") }
            try FileManager.default.moveItem(at: location, to: output)
            result = output
        } catch { failure = error }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil { failure = error }; done.signal()
    }
}

final class ModelPull: NSObject, URLSessionDataDelegate {
    let done = DispatchSemaphore(value: 0)
    var failure: Error?
    var pending = Data()
    var success = false
    var validResponse = false
    let progress: (String, Double?) -> Void
    init(progress: @escaping (String, Double?) -> Void) { self.progress = progress }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        validResponse = (response as? HTTPURLResponse)?.statusCode == 200
        if !validResponse { failure = SetupFailure("Ollama could not start the model download. Retry after checking Ollama.") }
        completionHandler(validResponse ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        failure = SetupFailure("Ollama redirected its local API unexpectedly."); completionHandler(nil)
    }
    func consume(_ bytes: Data) throws {
        pending.append(bytes)
        while let end = pending.firstIndex(of: 10) {
            let line = pending.prefix(upTo: end)
            pending.removeSubrange(...end)
            if line.isEmpty { continue }
            let json = try JSONSerialization.jsonObject(with: line) as? [String: Any] ?? [:]
            if let error = json["error"] as? String { throw SetupFailure("Ollama: \(error)") }
            let status = json["status"] as? String ?? "Downloading model"
            if status == "success" { success = true }
            let completed = (json["completed"] as? NSNumber)?.doubleValue ?? 0
            let total = (json["total"] as? NSNumber)?.doubleValue ?? 0
            progress(status, total > 0 ? completed / total : nil)
        }
        if pending.count > 65536 { throw SetupFailure("Unexpected Ollama progress response.") }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        do { try consume(data) } catch { failure = error; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil { failure = error }
        if failure == nil && !success { failure = SetupFailure("The model download ended before verification. Retry to resume it.") }
        done.signal()
    }
}

final class SetupEngine {
    let cache: URL
    private let lock = NSLock()
    private var stopped = false
    private var task: URLSessionTask?
    var report: (String, Double?) -> Void = { _, _ in }
    init(cache: URL? = nil) {
        self.cache = cache ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("com.pulse.setup")
    }
    func cancel() { lock.lock(); stopped = true; let active = task; lock.unlock(); active?.cancel() }
    func check() throws {
        lock.lock(); let value = stopped; lock.unlock()
        if value { throw SetupFailure("Setup cancelled. Verified downloads are kept so you can retry.") }
    }
    private func wait(_ active: URLSessionTask, _ signal: DispatchSemaphore) throws {
        lock.lock(); task = active; let cancelled = stopped; lock.unlock()
        active.resume(); if cancelled { active.cancel() }
        signal.wait()
        lock.lock(); task = nil; lock.unlock()
        try check()
    }
    func fetch(_ url: URL, limit: Int64, label: String) throws -> URL {
        try check()
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let output = cache.appendingPathComponent(".download-\(UUID().uuidString)")
        let delegate = Download(output: output, limit: limit) { [weak self] count, _ in
            let detail = limit > 2 * 1024 * 1024 ? " • \(ByteCountFormatter.string(fromByteCount: count, countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: limit, countStyle: .file))" : ""
            self?.report(label + detail, limit > 2 * 1024 * 1024 ? Double(count) / Double(limit) : nil)
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 4 * 60 * 60
        config.httpAdditionalHeaders = ["User-Agent": "Pulse-Setup/1.0", "Accept": "application/vnd.github+json"]
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            try wait(session.downloadTask(with: url), delegate.done)
            if let error = delegate.failure { throw error }
            guard let file = delegate.result else { throw SetupFailure("Download did not finish. Retry to continue.") }
            return file
        } catch { try? FileManager.default.removeItem(at: output); throw error }
    }
    func release(repo: String) throws -> Release {
        let file = try fetch(URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!, limit: 2 * 1024 * 1024, label: "Checking GitHub releases")
        defer { try? FileManager.default.removeItem(at: file) }
        return try JSONDecoder().decode(Release.self, from: Data(contentsOf: file))
    }
    func download(_ asset: ReleaseAsset, repo: String, tag: String) throws -> URL {
        let url = try assetURL(asset, repo: repo, tag: tag)
        let output = cache.appendingPathComponent(String(asset.digest!.dropFirst(7)) + "-" + asset.name)
        report("Checking \(asset.name)", nil)
        if verified(output, asset) { return output }
        try? FileManager.default.removeItem(at: output)
        let file = try fetch(url, limit: asset.size, label: "Downloading \(asset.name)")
        defer { try? FileManager.default.removeItem(at: file) }
        report("Verifying SHA-256 • \(asset.name)", nil)
        guard verified(file, asset) else { throw SetupFailure("The download failed SHA-256 verification. It was discarded. Check your connection and retry.") }
        try check()
        try FileManager.default.moveItem(at: file, to: output)
        return output
    }
    func plan() throws -> InstallPlan {
        let current = try release(repo: pulseRepo)
        guard let asset = current.assets.first(where: { $0.name == "pulse-install-manifest.json" }), asset.size <= 65536 else {
            throw SetupFailure("GitHub's latest release (\(current.tag_name)) is not ready for this setup wizard. The publisher must add the complete Pulse 2.1.1+ package and setup manifest. Retry after that release is published, or open the release page.")
        }
        let path = try download(asset, repo: pulseRepo, tag: current.tag_name)
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: path))
        return try makePlan(manifest, current)
    }
    func diskCheck(localAI: Bool) throws {
        let values = try FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        let free = (values[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        let required: Int64 = localAI ? 10_000_000_000 : 2_000_000_000
        if free < required { throw SetupFailure("Free at least \(localAI ? "10" : "2") GB on your home disk, then retry.") }
    }
    @discardableResult func run(_ executable: String, _ arguments: [String]) throws -> Data {
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        let output = Pipe(); process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        if process.terminationStatus != 0 { throw SetupFailure("\(URL(fileURLWithPath: executable).lastPathComponent) could not finish. Close the app if it is running, check disk permissions, then retry.") }
        return bytes
    }
    func installPulse(_ file: URL, version: String, destination: URL, canReplace: () -> Bool = { true }) throws {
        try check()
        report("Installing Pulse \(version) in ~/Applications", nil)
        let fm = FileManager.default
        try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let mount = fm.temporaryDirectory.appendingPathComponent("Pulse-setup-\(UUID().uuidString)")
        let staged = destination.deletingLastPathComponent().appendingPathComponent(".Pulse-install-\(UUID().uuidString).app")
        try fm.createDirectory(at: mount, withIntermediateDirectories: true)
        defer {
            _ = try? run("/usr/bin/hdiutil", ["detach", mount.path])
            try? fm.removeItem(at: mount); try? fm.removeItem(at: staged)
        }
        _ = try run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount.path, file.path])
        let app = mount.appendingPathComponent("Pulse.app")
        guard let bundle = Bundle(url: app), bundle.bundleIdentifier == "com.pulse.desktop",
              bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version,
              fm.isExecutableFile(atPath: app.appendingPathComponent("Contents/Resources/resources/backend/pulse_backend").path) else {
            throw SetupFailure("The downloaded disk image does not contain the expected complete Pulse app.")
        }
        _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        _ = try run("/usr/bin/ditto", [app.path, staged.path])
        _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged.path])
        let quarantine = String(format: "0081;%llx;Pulse Setup;%@", Int64(Date().timeIntervalSince1970), UUID().uuidString)
        _ = try run("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantine, staged.path])
        try check()
        if !canReplace() { throw SetupFailure("Pulse was opened during the download. Close Pulse, then retry setup.") }
        try replaceApp(staged: staged, destination: destination)
    }
    func ollamaTags() -> [String]? {
        let url = URL(string: "http://127.0.0.1:11434/api/tags")!
        let result = TagsResult()
        let session = URLSession(configuration: .ephemeral)
        var request = URLRequest(url: url); request.timeoutInterval = 2
        let active = session.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let models = json["models"] as? [[String: Any]] {
                result.names = models.compactMap { $0["name"] as? String }
            }
            result.done.signal()
        }
        active.resume(); result.done.wait(); session.invalidateAndCancel()
        return result.names
    }
    func ensureOllama() throws {
        if ollamaTags() != nil { report("Using your existing Ollama server", nil); return }
        let fm = FileManager.default
        let userApp = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Ollama.app")
        let systemApp = URL(fileURLWithPath: "/Applications/Ollama.app")
        var app = fm.fileExists(atPath: systemApp.path) ? systemApp : userApp
        if !fm.fileExists(atPath: app.path) {
            let current = try release(repo: "ollama/ollama")
            guard !current.draft, !current.prerelease,
                  let asset = current.assets.first(where: { $0.name == "Ollama-darwin.zip" }) else { throw SetupFailure("The official Ollama Mac download is unavailable. Retry later.") }
            let file = try download(asset, repo: "ollama/ollama", tag: current.tag_name)
            try check(); report("Installing the optional Ollama runtime", nil)
            let temporary = fm.temporaryDirectory.appendingPathComponent("Ollama-setup-\(UUID().uuidString)")
            try fm.createDirectory(at: temporary, withIntermediateDirectories: true)
            defer { try? fm.removeItem(at: temporary) }
            _ = try run("/usr/bin/ditto", ["-x", "-k", file.path, temporary.path])
            let extracted = temporary.appendingPathComponent("Ollama.app")
            guard let bundle = Bundle(url: extracted), bundle.bundleIdentifier == "com.electron.ollama" else { throw SetupFailure("The Ollama archive contained an unexpected app.") }
            if let minimum = bundle.object(forInfoDictionaryKey: "LSMinimumSystemVersion") as? String {
                let parts = minimum.split(separator: ".").compactMap { Int($0) }
                guard !parts.isEmpty, ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(
                    majorVersion: parts[0], minorVersion: parts.count > 1 ? parts[1] : 0, patchVersion: parts.count > 2 ? parts[2] : 0)) else {
                    throw SetupFailure("The current Ollama runtime requires macOS \(minimum). Deselect local AI to finish Pulse setup, or update macOS.")
                }
            }
            _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", extracted.path])
            // OS policy remains in force; no quarantine attributes or Gatekeeper rules are changed.
            _ = try run("/usr/sbin/spctl", ["--assess", "--type", "execute", extracted.path])
            try fm.createDirectory(at: userApp.deletingLastPathComponent(), withIntermediateDirectories: true)
            _ = try run("/usr/bin/ditto", [extracted.path, userApp.path]); app = userApp
        }
        report("Opening Ollama • complete any macOS prompts", nil)
        _ = try run("/usr/bin/open", [app.path])
        for _ in 0..<120 {
            try check()
            if ollamaTags() != nil { return }
            Thread.sleep(forTimeInterval: 0.5)
        }
        throw SetupFailure("Ollama is installed but is not responding. Open Ollama, complete its setup prompts, then retry here. Pulse is already installed.")
    }
    func pullModels() throws {
        for model in setupModels {
            try check()
            let names = ollamaTags() ?? []
            if names.contains(model) || names.contains(model + ":latest") { report("\(model) is already available", 1); continue }
            let delegate = ModelPull { [weak self] status, value in self?.report("\(model) • \(status)", value) }
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 120; config.timeoutIntervalForResource = 8 * 60 * 60
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/pull")!)
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model, "stream": true])
            report("Downloading \(model) from the Ollama registry", nil)
            try wait(session.dataTask(with: request), delegate.done)
            if let failure = delegate.failure { throw failure }
            let installed = ollamaTags() ?? []
            guard installed.contains(model) || installed.contains(model + ":latest") else { throw SetupFailure("Ollama did not report \(model) as installed. Retry to resume.") }
        }
    }
}
private final class TagsResult {
    let done = DispatchSemaphore(value: 0)
    var names: [String]?
}
