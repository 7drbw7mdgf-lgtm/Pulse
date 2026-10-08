# Pulse 1.5.7 development

The current Tauri desktop app stages `local-web/pulse-frontend` and `local-web/pulse-backend`. Historical root workspace files and tests remain for compatibility.

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

For separate data, set `PULSE_CONFIG_DIR` to an isolated directory before starting. Omitting it uses normal Pulse storage under `~/Library/Application Support/pulse`. Open the server's printed URL. The current tests use synthetic papers and mocked services; no real library is needed.

The historical root test suite remains under `npm test` and `python3 test_v1_3_security.py`; its browser checks require `npx playwright install chromium`.

## Current source layout

- `local-web/pulse-frontend`: UI, graph, library table, bulk selection, inspector, reports and manager controls.
- `local-web/pulse-backend/pulse_core`: persistence and recovery, metadata extraction/matching, metrics and relation lists, discovery, AI reports, manager connections and OAuth.
- `local-web/pulse-backend/pulse_mcp.py`: newline-delimited JSON-RPC MCP bridge over stdio.
- `desktop/src-tauri`: Mac launcher, served workspace window, native downloads and external URL opening.

For MCP, configure your compatible client's command as a Python 3.10+ interpreter and its argument as the absolute path to `local-web/pulse-backend/pulse_mcp.py`. Use the same `PULSE_CONFIG_DIR` as the desired Pulse library. Account connection settings are managed in Pulse. Tools omit full paper text and never return credentials; manager saves need explicit user intent.

## Build the Mac app

Requires macOS, Xcode command-line tools, Rust and Node.js:

```sh
python3 -m venv /tmp/pulse-pdf-deps
/tmp/pulse-pdf-deps/bin/python3 -m pip install -r local-web/requirements.txt
bash scripts/package-desktop.sh /tmp/pulse-1.5.7-release /tmp/pulse-pdf-deps/lib/python3.12/site-packages
```

Adjust the dependency path to the Python version used. The optional second argument is a directory of PDF dependencies built for the target Mac; it is not a previous app bundle. Omit it to rely on separately installed dependencies. The script stages source, builds Tauri, verifies the app signature, creates a DMG and writes its SHA-256 checksum. Stage outputs and build files are ignored; no user library or settings are packaged.

The launcher finds Python 3.10+ in Homebrew, `/usr/local/bin` or the system location. A Python interpreter and Ollama/model weights are not bundled. Exports use native downloads; backend logs go to the app cache. First-launch guidance is in [the installation guide](MACOS-INSTALL.md).

## Mendeley release status

Authorization-code sign-in sends an S256 challenge and verifier. Implicit sign-in is disabled. Callback host/path, unique state, expiry and one-use response checks are enforced, and token storage follows profile verification. The shared registration remains disabled until registration and provider PKCE enforcement are verified; no secret is shipped. Custom confidential applications remain configurable. RIS export works without registration. See [the activation review](MENDELEY-ACTIVATION.md).

## Verification limits

Automated checks exercise synthetic records and mocked providers. Browser checks use an isolated library. Packaging confirms contents and integrity; none of these checks establish live manager authorization, discovery recall or report accuracy. Historical performance notes describe their own version and should not be generalized to this build.
