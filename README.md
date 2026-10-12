# Pulse

### A private, local-first workspace for scientific literature discovery and synthesis

[![Release](https://img.shields.io/badge/release-v1.7.7-blue.svg)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/tag/v1.7.7)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases)

---

**[Download for Mac (Apple Silicon)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.7.7/Pulse-1.7.7.dmg)** &nbsp;|&nbsp; **[Download for Windows (x64, 1.7.6)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.7.6/Pulse-1.7.6-Windows-x64-Setup.exe)** &nbsp;|&nbsp; **[Release Notes](docs/releases/1.7.7.md)** &nbsp;|&nbsp; **[Run from Source](local-web/README.md)**

---

> **Why Pulse?** Most research-mapping tools live entirely in the browser. They store your reading lists on remote servers and send what you upload to third-party cloud language models.
> 
> If you are working on an **unpublished manuscript, a confidential grant proposal, a patent application, or sensitive clinical data**, that's a security and privacy risk.
>
> **Pulse is built to be local-first.** Your library, PDFs, reading notes, and AI analysis stay strictly on your computer.

---

![Pulse Discovery Review Workspace](docs/images/pulse-1.7.1-discovery.png)

## What Pulse Does

Pulse connects the entire workflow of literature exploration into one cohesive desktop application:

1. **Import Anything:** Add papers by DOI, title, PMID, pasted citation, or bibliography file (BibTeX, RIS, EndNote, CSV), or simply drop PDF files straight into the workspace.
2. **Explore Connections Visually:** See how papers relate to each other through an interactive citation network, radial cluster maps, a full-screen library table, or a chronological timeline view.
3. **Smart Discovery:** Start with a seed paper or a research question. Pulse traverses citation networks and cross-checks multiple scholarly indexes (Semantic Scholar, OpenAlex, Europe PMC, Crossref, and CORE) to recommend relevant literature.
4. **Triage Without Noise:** Results are neatly categorized into **Strong matches** (evidence-backed results in the top 10% of the displayed list and full pool), **Related** (the top 40% of the displayed list), and **Explore**. Clear badges explain *why* each paper was suggested (e.g. citation links, co-authors, or shared topics).
5. **Bridge Literature:** Select 2 to 8 papers to uncover "bridge papers"—cross-disciplinary work connecting different fields or ideas.
6. **Local AI Assistant:** Run synthesis reports and section summaries directly on your machine using local [Ollama](https://ollama.com) models. No external API keys required, no subscription fees, and no data leaves your device.
7. **Reference Manager Sync:** Seamlessly send papers and metadata to Zotero Desktop or export citation bundles in RIS format for Mendeley.

---

## Privacy by Design: What Stays Local vs. What Leaves

| Feature | Where it lives |
| :--- | :--- |
| **Your Library & Notes** | On your computer only (`~/Library/Application Support/pulse` on macOS, `%LOCALAPPDATA%\Pulse` on Windows). |
| **PDFs & Extracted Text** | Read, indexed, and stored entirely on your computer. Never uploaded. |
| **AI Summaries & Analysis** | Processed by local Ollama models on your GPU/CPU. |
| **Accounts & Tracking** | None. No account required, no telemetry, no tracking cookies. |
| **Scholarly Lookups** | Pulse sends public paper identifiers (DOIs, titles, search keywords) to open scholarly APIs (Crossref, OpenAlex, Europe PMC, Semantic Scholar, CORE) just like a web browser lookup. |

---

## Screenshots

<div align="center">

| Interactive Timeline View | Dark Mode Review Workspace |
| :---: | :---: |
| ![Timeline View](docs/images/pulse-1.7.1-timeline.png) | ![Dark Mode](docs/images/pulse-1.7.1-discovery-dark.png) |

| Comprehensive Paper Inspector | Full-Screen Library Table |
| :---: | :---: |
| ![Paper Inspector](docs/images/pulse-1.7.1-inspector.png) | ![Library Table](docs/images/pulse-1.7.1-library.png) |

</div>

---

## Installation

### macOS (Apple Silicon, macOS 11+)
1. Download **[Pulse-1.7.4.dmg](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.7.4/Pulse-1.7.4.dmg)**.
2. Open the DMG and drag **Pulse.app** into your **Applications** folder.
3. *Note:* Ensure you have Python 3.10+ installed (e.g. via Homebrew `brew install python`). Because Pulse is ad-hoc signed, if macOS blocks the first launch, right-click the app and choose **Open**, or run the `Allow-Pulse-Tauri.command` included in the DMG.

### Windows (Windows 10/11 x64)
1. Download **[Pulse-1.7.4-Windows-x64-Setup.exe](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.7.4/Pulse-1.7.4-Windows-x64-Setup.exe)**.
2. Run the installer and follow the on-screen instructions. Python and PDF extraction engines are bundled directly inside the Windows setup.

---

## Optional: Setting Up Local AI with Ollama

Pulse functions as a complete citation mapper and bibliography tool without AI. If you want local AI summaries, reading notes, and passage synthesis:

1. Download and install [Ollama](https://ollama.com).
2. Pull the recommended local models in your terminal:
   ```bash
   # Embedding model for semantic search & meaning matching
   ollama pull nomic-embed-text

   # Fast lightweight reviewer
   ollama pull llama3.2:3b

   # Detailed paper synthesis & reports
   ollama pull qwen2.5:7b
   ```
3. In Pulse → **Settings**, confirm the local AI provider is active.

---

## Running from Source

Developers and researchers who wish to run directly from source or customize the algorithms:

```bash
# Clone the repository
git clone https://github.com/7drbw7mdgf-lgtm/Pulse.git
cd Pulse

# Install frontend and backend dependencies
npm ci
python3 -m venv .venv
source .venv/bin/activate
pip install -r local-web/requirements.txt

# Start the desktop application
npm start
```

### Model Context Protocol (MCP) Bridge
Pulse includes a built-in MCP server for integrating your local library into Claude Desktop or other MCP-compatible tools. Point your MCP client to:
```bash
python3 /path/to/Pulse/local-web/pulse-backend/pulse_mcp.py
```

---

## What's New in 1.7.7

- **Faster citation exploration:** Direct, one-hop discovery is the default. Optional extra hops share an eight-second budget, retaining direct citations and any completed results when the budget expires.
- **Portable offline ranking on Mac:** The DMG carries the cross-encoder model and a self-contained executable with its interpreter and inference libraries. It does not depend on a developer's Python installation or home-directory model cache. Unavailable pairwise ranking is reported in the review header.
- **Readable review bands:** Related uses the top 40% of the returned list. Strong match requires the top 10% of that list, the full-pool rank gate, an absolute evidence threshold and two independent retrieval channels. Remaining results stay available as Explore; explicit relevance labels take precedence.
- **Foundational-paper support:** A capped six-point bonus combines total citations with topic support and an actual seed-reference, co-citation or shared-reference relationship. It complements the nine-point velocity prior and participates in shortlist selection. Popularity alone does not qualify a paper.
- **CORE recovery:** Transient server errors get one short recovery attempt. Persistent errors stop that source within an eight-second budget, preserving results from other providers. Pulse cannot repair an upstream CORE outage.

The Mac release includes these fixes; the linked Windows installer remains 1.7.6. Current Windows source is built in CI. See the [1.7.7 release notes](docs/releases/1.7.7.md) for checks and limits. The reported Inciteful comparison has not been rerun against its original seed set; the ranking change is not a claim of measured parity.

---

## License

Pulse is open-source software licensed under the [MIT License](LICENSE). Free for personal, academic, and commercial use.
