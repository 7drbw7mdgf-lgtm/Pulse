# Pulse

A private, local-first desktop workspace for scientific literature discovery and synthesis.

[![Release](https://img.shields.io/badge/release-v1.8.9-blue.svg)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/tag/v1.8.9)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Download Pulse 1.8.9

- **[Mac — Apple Silicon](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.8.9/Pulse-1.8.9.dmg)** — macOS 11+, with Python 3.10+ installed separately. [Installation guide](docs/MACOS-INSTALL.md).
- **[Windows — x64](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.8.9/Pulse-1.8.9-Windows-x64-Setup.exe)** — Windows 10/11. Python, PDF extraction, OCR and the offline search ranker are bundled. [Installation guide](docs/WINDOWS-INSTALL.md).
- [Checksums](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.8.9/Pulse-1.8.9-SHA256SUMS.txt) · [Release notes](docs/releases/1.8.9.md) · [Previous releases](https://github.com/7drbw7mdgf-lgtm/Pulse/releases).

Both installers use the same application source and version. The Mac app is ad hoc signed and not Apple-notarized; the Windows installer is unsigned.

## What the app does

- Import PDFs, citation files, DOIs or text into a persistent local library. Keep notes, tags, reading status and relevance labels.
- Explore relationship maps, a scrolling Timeline, a full library table and a Trends dashboard. Filter publication periods and open their papers directly.
- Discover related literature across scholarly sources, review why results match, and add selected papers. Optional Semantic Scholar and OpenAlex keys are managed in Settings.
- Connect Mendeley through Pulse sign-in, sync citations while preserving local edits, or transfer citations to Zotero Desktop. If this computer has old Mendeley developer settings, choose **Use Pulse sign-in**. [Connection guide](docs/MENDELEY-ACTIVATION.md).
- Use an optional local Ollama installation for paper reports. Ollama and its model weights are installed separately.

Pulse 1.8.9 caches relationships, graph layouts and Trends aggregates, moves larger graph calculations into a worker, keeps unchanged library rows, and combines autosaves with changed-paper transfers. See [performance validation](docs/PERFORMANCE.md).

Your library, PDFs, notes and local AI analysis stay on your computer. Online discovery and reference-manager actions contact their selected services; sending citations is an explicit action. No personal library or account credentials are included in either installer.

## Source and development

The current app is in [`local-web`](local-web/README.md); [`desktop`](desktop) contains its Mac/Windows Tauri launcher. See [development and packaging](docs/DEVELOPMENT.md), [search sources](docs/SEARCH-SOURCES.md), and [search implementation notes](docs/search).

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r local-web/requirements.txt
npm ci
npm start
npm test
```

Set `PULSE_CONFIG_DIR` to an isolated directory when testing without your normal library. Historical release notes remain in [`docs/releases`](docs/releases), and previous installers remain on [GitHub Releases](https://github.com/7drbw7mdgf-lgtm/Pulse/releases).
