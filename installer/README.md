# Pulse Setup

Small native download wizards: AppKit on macOS and .NET Framework/Windows Forms on Windows. Neither needs Python, Node, a browser runtime, or the Pulse payload to start. The Windows wizard needs the .NET Framework 4.8 included in supported Windows versions.

The wizard reads the **latest stable GitHub release**, then its `pulse-install-manifest.json`. Only releases with the complete bundled Python/PDF/OCR/search runtime qualify (2.1.1+). It never falls back to the older Python-dependent Mac package. All executable downloads are restricted to release assets in `7drbw7mdgf-lgtm/Pulse` and `ollama/ollama`. Files are streamed to disk, checked against both the release metadata and a SHA-256 hash, and cached for retries. No GitHub token is needed.

Pulse is required. Local AI is optional and off by default. If selected, setup reuses a responding Ollama server or installs the official runtime from Ollama's GitHub releases, then pulls `gemma3:4b` and `nomic-embed-text` using Ollama's loopback API. **Model weights come from the Ollama registry, not GitHub.** Existing models are reused. Pulse's existing AI settings and library are never rewritten. Custom model names/endpoints remain the user's settings.

Mac setup installs to `~/Applications/Pulse.app`, keeping a previous copy until the new copy is verified. It asks the user to close an active Pulse instance. Windows runs the existing current-user NSIS setup; WebView2, if absent, is downloaded by that installer from Microsoft. Optional Ollama setup uses its standard current-user installer. Native installers finish normally if the wizard is cancelled during installation; the wizard does not kill them. Cancellation stops downloads/model requests; verified downloads and partial Ollama model blobs can be reused.

## Build

```sh
bash scripts/package-setup-macos.sh /absolute/output/folder
# Windows, PowerShell 7 (also compiled by the Windows workflow):
./scripts/package-setup-windows.ps1 -OutputDirectory outputs/setup
```

Optional signing uses `APPLE_SIGNING_IDENTITY` / `PULSE_NOTARY_PROFILE` on Mac and the existing `PULSE_WINDOWS_CERT_*` variables on Windows. Without publisher certificates, builds are ad hoc/unsigned; setup never strips quarantine or disables OS protections.

## Publish with the app

1. Build and test the app payloads and both small wizards from the same source revision.
2. Generate the component manifest from the actual release files:

   ```sh
   python3 scripts/create-install-manifest.py --mac /path/Pulse-2.1.1.dmg --windows /path/Pulse-2.1.1-Windows-x64-Setup.exe --output /path/pulse-install-manifest.json
   ```

   One platform may be omitted while preparing a draft. Setup on that platform then reports that no compatible package has been published. Do not publish a partial release as Latest unless intended.
3. Attach `pulse-install-manifest.json`, app installers, `Pulse-Setup-Mac-arm64.zip`, `Pulse-Setup-Windows-x64.exe`, and their checksum files to the **same** GitHub release. Publish it as Latest only after verification. The wizard then tracks that release without needing to rebuild for each app update.

An installer built locally cannot make unpublished GitHub payloads available. Until a compatible release and manifest are published, setup explains this and offers Retry / Release page. GitHub rate limits, offline failures, insufficient disk space and corrupt downloads produce actionable errors without modifying the library.

## Validation

`python3 -m unittest discover -s installer/tests` checks release generation and contract fixtures. `bash scripts/test-setup-macos.sh` compiles/runs the native core tests, including SHA-256, corrupt-cache rejection, release provenance and transactional rollback. `Pulse Setup.app/Contents/MacOS/PulseSetup --check-release` checks current public metadata without installing. `--preview` displays the selection UI with installation disabled. Windows core tests run in CI before the wizard is packaged; they do not install Pulse or download models.
