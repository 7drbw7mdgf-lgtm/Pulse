# Updates inside Pulse

Pulse 2.1.2 introduces **Settings → App updates** on Mac and Windows. Install this version once with the small setup wizard or normal installer. Older versions do not contain the updater, so they cannot acquire it automatically.

Pulse checks the stable GitHub release when it opens and every six hours while active. Automatic downloading is on initially and can be disabled in Settings. Download progress and cancellation are available. A verified download is kept in the native app cache for retry/reopening; it is verified again before use. Click **Restart & update** when ready. Pulse waits for a successful backend library save and refuses to restart if saving fails or a library mutation/sync is active. App replacement preserves the separate library profile, connection credentials and model folders.

The Mac updater replaces the installed `.app` from a compressed update archive. It never asks you to mount a new DMG. Move Pulse out of its disk image before using updates. The Windows updater uses the current-user NSIS package in passive mode and restarts the application. The backend process is stopped before replacement/installer exit. Failed Mac replacement uses Tauri's rollback behavior and attempts to bring the saved workspace back online.

Update signatures use the public key embedded in Pulse, independently of Apple notarization and Windows Authenticode. `requireSignedVersion` also binds each package to its announced version, preventing an old signed package being presented as a new release. Verification cannot be bypassed. Only versioned HTTPS assets in `7drbw7mdgf-lgtm/Pulse` are accepted; native update commands are restricted to the actual main window's loopback port. External browser workspaces cannot replace the desktop app.

## Release procedure

The private update key is stored locally in Git metadata under `pulse-update-signing/pulse.key`, mode 0600, with its enclosing directory mode 0700. It is never tracked or put in an app. Keep a secure backup; changing or losing it can strand existing installations. The public verification key is in `desktop/src-tauri/tauri.conf.json`. Never put the private key in a workflow, log, release asset or frontend.

Set `TAURI_SIGNING_PRIVATE_KEY` to the local private key path, then run the normal packaging scripts. Tauri creates and signs the update files with the app version in the trusted signature comment. Windows CI sets `PULSE_DEFER_UPDATE_SIGNING=1`, builds/tests the installer without the private key, then the release operator signs the downloaded, verified file locally using `tauri signer sign --private-key-path /protected/pulse.key --app-version VERSION /release/Pulse-VERSION-Windows-x64-Setup.exe`. Do not publish until that signature is present. This keeps the update key off GitHub. The final release contains:

- `Pulse-VERSION-macOS-arm64.app.tar.gz` and `.sig`
- `Pulse-VERSION-Windows-x64-Setup.exe` and `.sig`
- The DMG and small setup wizards for first installation.

Generate both feeds from the actual files:

```sh
python3 scripts/create-update-manifest.py --mac /release/Pulse-VERSION-macOS-arm64.app.tar.gz --windows /release/Pulse-VERSION-Windows-x64-Setup.exe --notes docs/releases/VERSION.md --output /release/latest.json
python3 scripts/create-install-manifest.py --mac /release/Pulse-VERSION.dmg --windows /release/Pulse-VERSION-Windows-x64-Setup.exe --output /release/pulse-install-manifest.json
```

Attach the feeds, packages, signatures, wizards and checksums to the **same** GitHub release. Upload and verify the complete draft before publishing it as Latest. Never mark a partial Mac-only or Windows-only release Latest. Future installed clients read `https://github.com/7drbw7mdgf-lgtm/Pulse/releases/latest/download/latest.json`; setup reads `pulse-install-manifest.json` from that stable release.

Update archives include the complete matching native shell, frontend and backend. They are full application updates rather than binary patches. Optional Ollama/model installations remain separate and can be repaired with setup. Publisher signing still requires the separate certificates described in [SIGNING.md](SIGNING.md).
