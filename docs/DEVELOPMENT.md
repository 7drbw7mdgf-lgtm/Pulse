# Pulse development

The current Tauri desktop app stages `local-web/pulse-frontend` and `local-web/pulse-backend`. Both platforms share this application source; platform packaging adds the native launcher and dependencies.

## Run and test

Requires Python 3.10+, Node.js and the local workspace PDF dependency:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r local-web/requirements.txt
npm ci
npm start
npm run test:workspace
```

For separate data, set `PULSE_CONFIG_DIR` to an isolated directory before starting. Omitting it uses `~/Library/Application Support/pulse` on macOS, `%LOCALAPPDATA%\Pulse` on Windows, or `$XDG_DATA_HOME/pulse` (default `~/.local/share/pulse`) on Linux. Open the server's printed URL. The current tests use synthetic papers and mocked services; no real library is needed.

`npm test` runs the current workspace regression suite. Shared sign-in tests run separately in GitHub Actions. `tests/native_mac.py` is an optional native Mac smoke check.

## Current source layout

- `local-web/pulse-frontend`: UI, graph, library table, bulk selection, inspector, reports and manager controls.
- `local-web/pulse-backend/pulse_core`: persistence and recovery, metadata extraction/matching, metrics and relation lists, discovery, AI reports, manager connections and OAuth.
- `local-web/pulse-backend/pulse_mcp.py`: newline-delimited JSON-RPC MCP bridge over stdio.
- `desktop/src-tauri`: Mac/Windows launcher, served workspace window, native downloads and external URL opening.

For MCP, configure your compatible client's command as a Python 3.10+ interpreter and its argument as the absolute path to `local-web/pulse-backend/pulse_mcp.py`. Use the same `PULSE_CONFIG_DIR` as the desired Pulse library. Account connection settings are managed in Pulse. Tools omit full paper text and never return credentials; manager saves need explicit user intent.

## Build the Mac app

Requires macOS, Xcode command-line tools, Rust and Node.js:

```sh
python3 -m venv /tmp/pulse-pdf-deps
/tmp/pulse-pdf-deps/bin/python3 -m pip install -r local-web/requirements.txt
bash scripts/package-desktop.sh /tmp/pulse-2.0.1-release /tmp/pulse-pdf-deps/lib/python3.12/site-packages
```

Adjust the dependency path to the Python version used. The optional second argument is a directory of PDF dependencies built for the target Mac; it is not a previous app bundle. Omit it to rely on separately installed dependencies. The script stages source, builds Tauri, verifies the app signature, creates a DMG and writes its SHA-256 checksum. Stage outputs and build files are ignored; no user library or settings are packaged.

The launcher finds Python 3.10+ in Homebrew, `/usr/local/bin` or the system location. A Python interpreter and Ollama/model weights are not bundled. Exports use native downloads; backend logs go to the app cache. First-launch guidance is in [the installation guide](MACOS-INSTALL.md).

## Build the Windows app

Run `pwsh -File scripts/package-windows.ps1` on Windows 10/11 x64 with Python 3.12, Node.js, Rust and the MSVC C++ build tools. The script stages the current workspace, freezes Python and PyMuPDF into a backend executable, builds the Tauri NSIS setup and writes `outputs/windows/SHA256SUMS.txt`. Run `python scripts/verify-windows-package.py --installer outputs/windows/Pulse-2.0.1-Windows-x64-Setup.exe --report outputs/windows/verification.json` to install into a temporary directory and check the native window, bundled PDF/DOI extraction, SQLite full-text passages, library persistence, session authentication and process cleanup.

GitHub Actions provides a native Windows build workflow with the same commands. Build artifacts contain the setup, checksum and verification report. The setup uses a current-user installation and installs WebView2 if it is absent. No Python installation is needed on users’ computers; local AI still requires Ollama and its model weights. See [Windows installation](WINDOWS-INSTALL.md).

## Mendeley connection

The shared token-exchange service holds the application secret; each desktop keeps its own encrypted account tokens. Fresh sign-in and library sync were verified after the service repair on 17 October 2026. Per-attempt state and verifier checks, callback validation and generation guards protect connection attempts. No application secret is shipped. Custom registrations and RIS export remain supported. See [connection and owner repair](MENDELEY-ACTIVATION.md).

## Verification limits

Automated checks exercise synthetic records and mocked providers. Browser checks use an isolated library. Packaging confirms contents and integrity; none of these checks establish live manager authorization, discovery recall or report accuracy. Historical performance notes describe their own version and should not be generalized to this build.

## Portable offline search ranker

The Mac release uses a frozen CPU ONNX worker, independent of the system Python used by the main backend. The bundled Mac runtime uses the checksum-verified `cpython-3.11.17+20261009-aarch64-apple-darwin-install_only_stripped.tar.gz` from the official [python-build-standalone release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261009). On an Apple Silicon Mac, create a build venv with that macOS 11-compatible interpreter and install `scripts/requirements-search-runtime.txt`, then run:

```sh
/path/to/build-venv/bin/python scripts/build-search-runtime.py --output /tmp/pulse-search-runtime
bash scripts/package-desktop.sh /tmp/pulse-2.0.1-release /path/to/pdf-dependencies /tmp/pulse-search-runtime
```

The builder downloads the fixed model revision, bundles its licence, records SHA-256 values and freezes the interpreter, ONNX Runtime, NumPy and tokenizer into a relocatable executable. It verifies inference with an empty HOME and without a Python executable on PATH. Search does not download weights or execute remote model code. Staging rejects model-only manifests and machine-specific Python paths. The release check additionally denies access to network, Homebrew and the user's search runtime while running inference from the DMG. Windows packaging builds the same portable ranker format for Windows and verifies inference from the installed app.


## 2.1 development and persistence

The 2.1 build stores papers and workspace fields in `library.sqlite3` beside the existing settings file. First use imports a valid `library.json` (or an existing JSON backup), keeps the original file, and writes a `library_pre_sqlite_*.json` checkpoint. New ordinary saves update SQLite rows instead of rewriting the legacy file. Treat the database as authoritative after migration; close older Pulse versions before opening the upgraded app on the same profile. JSON export and Recovery provide portable copies; periodic JSON checkpoints are retained in the backups folder.

Run `npm test` for the current backend, browser and research workflow checks. `tests/research_workflow.cjs` exercises multi-phrase/tag All/Any matching, reading queue, saved searches, watchlist seen-state and reload persistence with isolated synthetic data and mocked online results.

The Mac build now freezes the backend with PyInstaller using a macOS 11-compatible Python 3.11 build interpreter. Install `scripts/requirements-macos-build.txt` in that build environment and set `PULSE_BACKEND_BUILD_PYTHON` when invoking `scripts/package-desktop.sh`; pass an empty PDF-dependencies argument and the portable ranker as the third argument. The resulting app needs no system Python. See [signing setup](SIGNING.md).
