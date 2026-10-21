# Pulse

A private, local-first desktop workspace for scientific literature discovery and synthesis.

[![Release](https://img.shields.io/badge/release-v2.1.2-blue.svg)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/tag/v2.1.2)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Download Pulse 2.1.2

- **[Mac — Apple Silicon](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v2.1.2/Pulse-2.1.2.dmg)** — macOS 11+, with Python, PDF tools, OCR and the offline search ranker included. [Installation guide](docs/MACOS-INSTALL.md).
- **[Windows — x64](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v2.1.2/Pulse-2.1.2-Windows-x64-Setup.exe)** — Windows 10/11. Python, PDF extraction, OCR and the offline search ranker are bundled. [Installation guide](docs/WINDOWS-INSTALL.md).
- [Checksums](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v2.1.2/Pulse-2.1.2-SHA256SUMS.txt) · [Release notes](docs/releases/2.1.2.md) · [Previous releases](https://github.com/7drbw7mdgf-lgtm/Pulse/releases).

Both installers use the same application source and version. The Mac app is ad hoc signed and not Apple-notarized; the Windows installer is unsigned.

Unreleased source additions: [full-text evidence and citation verification, formal screening projects, source retries, cache maintenance and opt-in ranking experiments](docs/search/RESEARCH-WORKFLOWS.md). These additions are not in the 2.1.2 installers linked above.

## Setup and future updates

- [Small Mac setup wizard](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/latest/download/Pulse-Setup-Mac-arm64.zip)
- [Small Windows setup wizard](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/latest/download/Pulse-Setup-Windows-x64.exe)

Setup downloads the app from GitHub and can add optional local AI components. Install 2.1.2 once, then use **Settings → App updates** for future releases: Pulse downloads signed updates in the background and saves your library before **Restart & update**. [Update guide](docs/APP-UPDATES.md) · [Setup details](installer/README.md).

This release adds multi-keyword/tag search, Fast/Enhanced ranking, saved searches and watchlists, a reading queue, SQLite library storage, faster graphs, complete indexed references and shared OpenAlex caching. Citation benchmark results were mixed across datasets; see the [citation evaluation](docs/search/CITATION-STRUCTURE.md).

## What the app does

- Follow author trajectories when discovering related research, and inspect available citation contexts and intent.
- Apply relevance feedback to unreviewed results while keeping reviewed papers in place.
- Compare selected papers side by side: sentences are picked from each abstract (or local full text) by fixed rules, with no AI; check each cell against its quote, then export Markdown or CSV.
- Rank results with the bundled offline cross-encoder (MiniLM; a biomedical model was tested and not adopted) and inspect the included independent benchmark tools.
- Optionally sync an encrypted citation library between computers. PDFs and extracted full text remain on the computer that imported them. Problem reports stay local until you review and send one.

- Import PDFs, citation files, DOIs or text into a persistent local library. Keep notes, tags, reading status and relevance labels.
- Explore relationship maps, a scrolling Timeline, a full library table and a Trends dashboard. Filter publication periods and open their papers directly.
- Discover related literature across scholarly sources, review why results match, and add selected papers. Optional Semantic Scholar and OpenAlex keys are managed in Settings.
- Connect Mendeley through Pulse sign-in, sync citations while preserving local edits, or transfer citations to Zotero Desktop. If this computer has old Mendeley developer settings, choose **Use Pulse sign-in**. [Connection guide](docs/MENDELEY-ACTIVATION.md).
- Use an optional local Ollama installation for paper reports. Ollama and its model weights are installed separately.

Pulse 2.1.2 caches relationships, graph layouts and Trends aggregates, moves larger graph calculations into a worker, keeps unchanged library rows, and combines autosaves with changed-paper transfers. See [performance validation](docs/PERFORMANCE.md).

Your library and local AI analysis stay on your computer by default. Optional library sync sends encrypted library data to the configured relay; PDFs and extracted text stay local. Online discovery and reference-manager actions contact their selected services. Problem reports require your review before sending. No personal library or account credentials are included in either installer.

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
