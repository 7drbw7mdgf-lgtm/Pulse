import AppKit
import Darwin

final class SetupApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let title = NSTextField(labelWithString: "Set up Pulse")
    let subtitle = NSTextField(wrappingLabelWithString: "Your research workspace, ready in a few steps.")
    let status = NSTextField(wrappingLabelWithString: "Checking the latest release on GitHub…")
    let detail = NSTextField(wrappingLabelWithString: "")
    let progress = NSProgressIndicator()
    let ai = NSButton(checkboxWithTitle: "Add local AI", target: nil, action: nil)
    let primary = NSButton(title: "Continue", target: nil, action: nil)
    let secondary = NSButton(title: "Release page", target: nil, action: nil)
    let cancel = NSButton(title: "Cancel", target: nil, action: nil)
    let destination = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Pulse.app")
    var engine = SetupEngine()
    var plan: InstallPlan?
    var page = 0
    var busy = false
    var finished = false
    var preview: Bool = {
        #if SETUP_PREVIEW
        return true
        #else
        return CommandLine.arguments.contains("--preview")
        #endif
    }()
    var pulseInstalled = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Pulse Setup", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem); NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 650, height: 640), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Pulse Setup"; window.delegate = self; window.center()
        let root = NSView(); root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        window.contentView = root
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 17
        stack.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 38), stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -38), stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 30)])
        let brand = NSTextField(labelWithString: "●  PULSE   /   SETUP")
        brand.font = .systemFont(ofSize: 12, weight: .semibold); brand.textColor = .systemTeal
        title.font = .systemFont(ofSize: 30, weight: .bold)
        subtitle.font = .systemFont(ofSize: 15); subtitle.textColor = .secondaryLabelColor
        stack.addArrangedSubview(brand); stack.addArrangedSubview(title); stack.addArrangedSubview(subtitle)
        let core = NSTextField(wrappingLabelWithString: "✓  Pulse · required\n\nLibrary, discovery, graphs and Trends. Python, PDF tools, OCR and the offline search ranker are included.")
        core.font = .systemFont(ofSize: 14); core.maximumNumberOfLines = 5
        stack.addArrangedSubview(card(core, width: 574))
        ai.font = .systemFont(ofSize: 15, weight: .semibold); ai.target = self; ai.action = #selector(selectionChanged)
        let aiText = NSTextField(wrappingLabelWithString: "Private chat and semantic embeddings with Ollama, Gemma 3 4B and nomic-embed-text. Optional · about 4 GB download · allow 10 GB free.\n\nApps download from GitHub. AI weights download from the Ollama registry. Existing models are reused.")
        aiText.font = .systemFont(ofSize: 12); aiText.textColor = .secondaryLabelColor
        let aiStack = NSStackView(views: [ai, aiText]); aiStack.orientation = .vertical; aiStack.alignment = .leading; aiStack.spacing = 10
        stack.addArrangedSubview(card(aiStack, width: 574))
        progress.style = .bar; progress.minValue = 0; progress.maxValue = 1; progress.isIndeterminate = true
        progress.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(progress); progress.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        status.font = .systemFont(ofSize: 13, weight: .medium); status.maximumNumberOfLines = 4
        detail.font = .systemFont(ofSize: 11); detail.textColor = .secondaryLabelColor; detail.maximumNumberOfLines = 3
        stack.addArrangedSubview(status); stack.addArrangedSubview(detail)
        let footer = NSStackView(views: [secondary, cancel, primary]); footer.spacing = 12
        footer.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(footer)
        NSLayoutConstraint.activate([footer.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -38), footer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -26), footer.topAnchor.constraint(greaterThanOrEqualTo: stack.bottomAnchor, constant: 16)])
        primary.bezelStyle = .rounded; primary.keyEquivalent = "\r"; primary.target = self; primary.action = #selector(next)
        secondary.bezelStyle = .rounded; secondary.target = self; secondary.action = #selector(releases)
        cancel.bezelStyle = .rounded; cancel.target = self; cancel.action = #selector(stop)
        if #unavailable(macOS 14) {
            ai.isEnabled = false; ai.title = "Local AI needs macOS 14 or newer"
        }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        #if !arch(arm64)
        status.stringValue = "This Mac setup currently supports Apple silicon. See GitHub releases for other builds."
        primary.isEnabled = false; progress.isHidden = true
        return
        #endif
        if preview {
            plan = InstallPlan(version: "2.1.1", pulse: ReleaseAsset(name: "Preview", size: 216570767, digest: nil, browser_download_url: ""))
            status.stringValue = "Pulse 2.1.1 · Apple silicon · 217 MB from GitHub"
            detail.stringValue = "Preview only · installation is disabled. Your library and settings stay in place."
            progress.isHidden = true; primary.isEnabled = true
        } else { loadPlan() }
    }
    func card(_ content: NSView, width: CGFloat) -> NSView {
        let view = NSView(); view.wantsLayer = true
        view.layer?.cornerRadius = 12; view.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        content.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(content)
        NSLayoutConstraint.activate([view.widthAnchor.constraint(equalToConstant: width), content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18), content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18), content.topAnchor.constraint(equalTo: view.topAnchor, constant: 16), content.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16)])
        return view
    }
    func setProgress(_ text: String, _ fraction: Double?) {
        status.stringValue = text; progress.isHidden = false
        progress.isIndeterminate = fraction == nil
        if let fraction = fraction { progress.stopAnimation(nil); progress.doubleValue = min(1, max(0, fraction)) }
        else { progress.startAnimation(nil) }
    }
    func newEngine() {
        engine = SetupEngine()
        engine.report = { [weak self] text, fraction in DispatchQueue.main.async { self?.setProgress(text, fraction) } }
    }
    func loadPlan() {
        busy = true; primary.isEnabled = false; primary.title = "Continue"; cancel.isEnabled = true
        newEngine(); setProgress("Checking the latest release on GitHub…", nil)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let plan = try self.engine.plan()
                DispatchQueue.main.async {
                    self.plan = plan; self.busy = false; self.progress.isHidden = true
                    self.status.stringValue = "Pulse \(plan.version) · Apple silicon · \(ByteCountFormatter.string(fromByteCount: plan.pulse.size, countStyle: .file)) from GitHub"
                    self.detail.stringValue = "Installs to ~/Applications. Your library and settings stay in place."
                    self.primary.title = "Continue"; self.primary.isEnabled = true
                }
            } catch { DispatchQueue.main.async { self.fail(error) } }
        }
    }
    @objc func selectionChanged() { if page == 1 { showReview() } }
    func showReview() {
        guard let plan = plan else { return }
        page = 1; title.stringValue = "Ready to install"
        subtitle.stringValue = ai.state == .on ? "Pulse and local AI · allow 10 GB free." : "Pulse · no additional runtime needed."
        status.stringValue = "Pulse \(plan.version) → ~/Applications/Pulse.app"
        detail.stringValue = ai.state == .on ? "Ollama opens its own setup prompts. Model weights download afterward. Existing custom AI settings are preserved." : "Downloads are verified with SHA-256. Close Pulse before continuing."
        primary.title = "Download & install"; progress.isHidden = true
        if preview { detail.stringValue = "Preview only · installation and downloads are disabled."; primary.isEnabled = false }
    }
    @objc func next() {
        if finished { openPulse(); return }
        if primary.title == "Retry" { if plan == nil { loadPlan() } else { install() }; return }
        if page == 0 { showReview(); return }
        install()
    }
    func install() {
        if preview { return }
        guard let plan = plan else { return }
        let active = NSRunningApplication.runningApplications(withBundleIdentifier: "com.pulse.desktop")
        if !active.isEmpty {
            status.stringValue = "Close Pulse, then click Retry. Your open work will be preserved."
            primary.title = "Retry"; return
        }
        // Avoid installing an older release alongside a newer user installation.
        for path in [destination, URL(fileURLWithPath: "/Applications/Pulse.app")] {
            if let version = Bundle(url: path)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
               validVersion(version), atLeast(version, plan.version), version != plan.version {
                status.stringValue = "Pulse \(version) is already installed. This release is older; see GitHub for the newest compatible setup."
                primary.isEnabled = false; return
            }
        }
        let localAI = ai.state == .on
        busy = true; primary.isEnabled = false; ai.isEnabled = false; cancel.title = "Cancel"; cancel.isEnabled = true
        newEngine(); setProgress("Preparing the installation", nil)
        detail.stringValue = "You can cancel downloads. A native installation already in progress will finish safely."
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.engine.diskCheck(localAI: localAI)
                if !self.pulseInstalled {
                    let file = try self.engine.download(plan.pulse, repo: pulseRepo, tag: "v\(plan.version)")
                    try self.engine.installPulse(file, version: plan.version, destination: self.destination,
                        canReplace: { NSRunningApplication.runningApplications(withBundleIdentifier: "com.pulse.desktop").isEmpty })
                    self.pulseInstalled = true
                }
                if localAI { try self.engine.ensureOllama(); try self.engine.pullModels() }
                DispatchQueue.main.async {
                    self.busy = false; self.finished = true; self.title.stringValue = "Pulse is ready"
                    self.subtitle.stringValue = "Your research workspace is installed."
                    self.status.stringValue = localAI ? "Pulse, Ollama and both AI models are ready." : "Pulse is installed. You can add local AI by running setup again."
                    self.detail.stringValue = "Open Pulse to connect your library services. macOS may ask you to approve opening a downloaded app."
                    self.progress.isHidden = true; self.primary.title = "Open Pulse"; self.primary.isEnabled = true; self.cancel.title = "Close"; self.cancel.isEnabled = true
                }
            } catch { DispatchQueue.main.async { self.fail(error) } }
        }
    }
    func fail(_ error: Error) {
        busy = false; progress.stopAnimation(nil); progress.isHidden = true
        status.stringValue = error.localizedDescription
        detail.stringValue = pulseInstalled ? "Pulse is installed. Retry optional AI setup, or close setup and open ~/Applications/Pulse.app." : "Check your connection and available disk space. Verified downloads are kept for Retry."
        primary.title = "Retry"; primary.isEnabled = true; cancel.title = "Close"; cancel.isEnabled = true
        if #available(macOS 14, *) { ai.isEnabled = true }
    }
    func openPulse() {
        NSWorkspace.shared.openApplication(at: destination, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error = error { DispatchQueue.main.async { self.status.stringValue = "macOS could not open Pulse: \(error.localizedDescription)" } }
            else { DispatchQueue.main.async { NSApp.terminate(nil) } }
        }
    }
    @objc func releases() { NSWorkspace.shared.open(URL(string: "https://github.com/\(pulseRepo)/releases/latest")!) }
    @objc func stop() {
        if busy { engine.cancel(); status.stringValue = "Cancelling · any installation in progress will finish safely"; cancel.isEnabled = false }
        else { NSApp.terminate(nil) }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if busy { stop(); return false }; return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if busy { stop(); return .terminateCancel }; return .terminateNow
    }
}

@main struct Main {
    static func main() {
        if CommandLine.arguments.contains("--check-release") {
            do { let plan = try SetupEngine().plan(); print("Compatible release: \(plan.version), \(plan.pulse.name)") }
            catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
            return
        }
        let app = NSApplication.shared
        let delegate = SetupApp()
        let lockFolder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(delegate.preview ? "com.pulse.setup.preview" : "com.pulse.setup")
        try? FileManager.default.createDirectory(at: lockFolder, withIntermediateDirectories: true)
        let lockFile = Darwin.open(lockFolder.appendingPathComponent("setup.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard lockFile >= 0, flock(lockFile, LOCK_EX | LOCK_NB) == 0 else {
            let alert = NSAlert(); alert.messageText = "Pulse Setup is already open"
            alert.informativeText = "Finish or close the other setup window before opening another."; alert.runModal(); return
        }
        defer { flock(lockFile, LOCK_UN); Darwin.close(lockFile) }
        app.delegate = delegate; app.run()
        withExtendedLifetime(delegate) {}
    }
}
