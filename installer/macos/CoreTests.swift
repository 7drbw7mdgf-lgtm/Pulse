import Foundation

@main struct CoreTests {
    static func main() throws {
        var checks = 0
        func expect(_ value: Bool, _ label: String) {
            checks += 1
            if !value { fatalError("FAIL: \(label)") }
        }
        func rejects(_ label: String, _ action: () throws -> Void) {
            do { try action(); fatalError("FAIL: \(label) was accepted") } catch { checks += 1 }
        }
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("Pulse-setup-tests-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let file = root.appendingPathComponent("payload")
        try Data("abc".utf8).write(to: file)
        let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        let asset = ReleaseAsset(name: "Pulse-2.1.1.dmg", size: 3, digest: "sha256:" + digest,
            browser_download_url: "https://github.com/\(pulseRepo)/releases/download/v2.1.1/Pulse-2.1.1.dmg")
        let release = Release(tag_name: "v2.1.1", draft: false, prerelease: false, assets: [asset])
        let component = Component(file: asset.name, bytes: 3, sha256: digest)
        let manifest = Manifest(schema: 1, version: "2.1.1", bundled: ["python", "pdf", "ocr", "search-ranker"], components: ["macos-arm64": component])
        expect(try sha256(file) == digest, "known SHA-256")
        expect(verified(file, asset), "verified file")
        try Data("abd".utf8).write(to: file)
        expect(!verified(file, asset), "same-size corrupted cache rejected")
        try Data("abcd".utf8).write(to: file)
        expect(!verified(file, asset), "wrong size rejected")
        expect(try makePlan(manifest, release).version == "2.1.1", "compatible plan")
        rejects("missing platform") { _ = try makePlan(manifest, release, platform: "windows-x64") }
        rejects("mismatched release") { _ = try makePlan(manifest, Release(tag_name: "v2.1.2", draft: false, prerelease: false, assets: [asset])) }
        rejects("draft") { _ = try makePlan(manifest, Release(tag_name: "v2.1.1", draft: true, prerelease: false, assets: [asset])) }
        rejects("missing bundled runtime") { _ = try makePlan(Manifest(schema: 1, version: "2.1.1", bundled: ["python"], components: manifest.components), release) }
        rejects("legacy release") { _ = try makePlan(Manifest(schema: 1, version: "2.0.1", bundled: manifest.bundled, components: manifest.components), release) }
        rejects("hash mismatch") { _ = try makePlan(Manifest(schema: 1, version: "2.1.1", bundled: manifest.bundled, components: ["macos-arm64": Component(file: asset.name, bytes: 3, sha256: String(repeating: "0", count: 64))]), release) }
        for address in ["http://github.com/\(pulseRepo)/releases/download/v2.1.1/Pulse-2.1.1.dmg",
                        "https://github.com.evil.example/\(pulseRepo)/releases/download/v2.1.1/Pulse-2.1.1.dmg",
                        "https://github.com/other/repo/releases/download/v2.1.1/Pulse-2.1.1.dmg",
                        asset.browser_download_url + "?token=bad"] {
            rejects("untrusted asset URL") { _ = try assetURL(ReleaseAsset(name: asset.name, size: 3, digest: asset.digest, browser_download_url: address), repo: pulseRepo, tag: "v2.1.1") }
        }
        rejects("digest absent") { _ = try assetURL(ReleaseAsset(name: asset.name, size: 3, digest: nil, browser_download_url: asset.browser_download_url), repo: pulseRepo, tag: "v2.1.1") }
        expect(atLeast("2.10.0", "2.9.9") && !atLeast("2.1.1", "2.1.2"), "numeric version ordering")
        expect(!validVersion("2.1.1/../../bad"), "version traversal")
        let old = root.appendingPathComponent("Pulse.app"), staged = root.appendingPathComponent("new.app")
        try Data("old".utf8).write(to: old); try Data("new".utf8).write(to: staged)
        rejects("replacement failure") { try replaceApp(staged: staged, destination: old, beforeCommit: { throw SetupFailure("Injected failure") }) }
        expect(try String(contentsOf: old, encoding: .utf8) == "old", "previous app restored")
        try replaceApp(staged: staged, destination: old)
        expect(try String(contentsOf: old, encoding: .utf8) == "new", "transaction committed")
        expect(try fm.contentsOfDirectory(atPath: root.path).allSatisfy { !$0.hasPrefix(".Pulse-previous-") }, "backup cleaned after success")
        var fractions: [Double] = []
        let pull = ModelPull { _, fraction in if let fraction = fraction { fractions.append(fraction) } }
        try pull.consume(Data("{\"status\":\"pulling\",\"total\":100,\"completed\":".utf8))
        try pull.consume(Data("25}\n{\"status\":\"success\"}\n".utf8))
        expect(pull.success && fractions == [0.25], "fragmented model progress")
        rejects("model error") { try pull.consume(Data("{\"error\":\"disk full\"}\n".utf8)) }
        rejects("unbounded model progress") { try ModelPull { _, _ in }.consume(Data(repeating: 65, count: 65537)) }
        let cancelled = SetupEngine(cache: root); cancelled.cancel()
        rejects("cancel before install") { try cancelled.check() }
        if let index = CommandLine.arguments.firstIndex(of: "--package"), CommandLine.arguments.count > index + 1 {
            let image = URL(fileURLWithPath: CommandLine.arguments[index + 1])
            let app = root.appendingPathComponent("Applications/Pulse.app")
            try SetupEngine(cache: root).installPulse(image, version: "2.1.1", destination: app)
            expect(Bundle(url: app)?.bundleIdentifier == "com.pulse.desktop", "real DMG installs into isolated directory")
            let backend = app.appendingPathComponent("Contents/Resources/resources/backend/pulse_backend")
            expect(fm.isExecutableFile(atPath: backend.path), "bundled backend survives installation")
        }
        print("Pulse Mac setup: \(checks) checks passed")
    }
}
