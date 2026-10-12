# Pulse

### A private, local-first workspace for scientific literature discovery and synthesis

[![Release](https://img.shields.io/badge/release-v1.7.11-blue.svg)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/tag/v1.7.11)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases)

---

**[Download for Mac (Apple Silicon)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.7.11/Pulse-1.7.11.dmg)** &nbsp;|&nbsp; **[Download for Windows (x64, 1.7.6)](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.7.6/Pulse-1.7.6-Windows-x64-Setup.exe)** &nbsp;|&nbsp; **[Release Notes](docs/releases/1.7.11.md)** &nbsp;|&nbsp; **[Run from Source](local-web/README.md)**

---

> **Why Pulse?** Most research-mapping tools live entirely in the browser. They store your reading lists on remote servers and send what you upload to third-party cloud language models.
> 
> If you are working on an **unpublished manuscript, a confidential grant proposal, a patent application, or sensitive clinical data**, that's a security and privacy risk.
>
> **Pulse is built to be local-first.** Your library, PDFs, reading notes, and AI analysis stay strictly on your computer.

---

![Pulse Discovery Review Workspace — synthetic example](docs/images/pulse-1.7.11-discovery.png)

## Concept search (source update)

Type a concept, key phrases or a research question into **Find papers**, then press **Enter** or **Search papers**. No seed paper or existing library is required. Pulse uses the configured AI to extract focused keywords and close synonyms, searches the selected literature indexes, and ranks results against the original topic with the existing semantic and cross-encoder stages when available. The results show the search keywords and support filters, previews, relevance feedback and adding selected papers to the library or map.

The original phrase always remains a retrieval query. Keyword expansion has an eight-second request timeout; missing models, unavailable AI or invalid output fall back to phrase search with a clear notice. **Run again** and **Refine with feedback** retain the original topic even after another paper is selected. **Discover related** continues to use selected seed papers. This source update is not included in the published 1.7.11 installers linked above.

## DBEF calibration and citation channels (source update)

DBEF now uses a seed-derived saturation scale, records assessed overlap, assessed zero and unavailable graph evidence separately, and imputes missing graph support conservatively by default. Co-citation runs as its own eight-second branch beside direct citations and coupling. The velocity bonus is still counted once. Ranking caches are versioned to bypass older results.

The frozen three-case and five-seed benchmarks include condensed nDCG, known-paper/landmark recall, per-channel assessment and every judged paper’s rank delta. Results are mixed; these eight cases cannot establish significance. See [the calibration guide](docs/search/DBEF-CALIBRATION.md) and [per-case benchmark reports](docs/search/RANKING-BENCHMARK.md). These changes are source updates, not a new published installer.

## Research quality and speed (source update)

- **Evidence-weighted DBEF:** incomplete bibliographies and weak shared-reference links contribute less, while direct citation evidence keeps its own weight.
- **Better relevance feedback:** positive and negative examples teach question-specific preferred and rejected concepts, with optional embedding contrast for synonyms. Search details explain the profile.
- **Stronger citation checks:** column-aware reference extraction and bundled local English OCR support scanned PDFs. DOI verification also checks supplied initials, journal, volume, issue, pages and precise dates; conflicts stay reviewable.
- **Publication updates:** linked preprints and published versions are grouped. Selected verified papers show recorded corrections, concerns and retraction notices with DOI links.
- **Faster ranking:** balanced shortlists of 96 embeddings and 48 single-excerpt cross-encoder scores, score caching and indexed version matching reduce repeated work while retaining the full result pool. The synthetic neural check on the test Mac dropped from 20.9 to 13.4 seconds; provider collection is excluded.
- **Forty mixed-topic benchmark questions:** open the local review tool from Settings. Twenty biomedical questions use SciFact human evidence labels. General-topic and landmark proposals require human review; the runner excludes provisional judgments by default and refuses to fit DBEF without sufficient reviewed, seeded cases.

See [the implementation and benchmark guide](docs/search/QUALITY-UPGRADE.md) for measured timings, source outages, review steps and limitations. These source changes are not included in the published installers linked above; no empirically fitted DBEF policy has been activated.

## What’s new in 1.7.11

- **Bibliography-first lookup:** author–year citations use the selected paper’s full reference list before online search, including explicit `2026a`/`2026b` suffixes. Bibliography tails survive long PDF imports and workspace recovery.
- **Verify before adding:** choosing a citation fetches the DOI record and checks the title, authors and publication dates. Complete registry metadata leads; mismatches and unavailable verification leave the library unchanged. Exports recheck records that have not passed identity verification, preserving personal corrections.
- **Source backoff:** rate limits and repeated HTTP/connection failures pause the affected credential scope. Cached successes and other sources continue. Search details show provider contributions and retry times. Local cancellation and time budgets do not count as source failures.
- **Progressive review:** large result lists render in batches of 100. Incoming results and final ranking preserve selection, filters and the visible scroll anchor; unchanged rows retain their DOM identity.
- **Measured ranking checks:** a frozen public-metadata benchmark compares DBEF on/off on the same pools, reports known-paper/landmark ranks, top-20 hits, top-50 misses, nDCG and separate collection/ranking times. The first run shows mixed results, rather than a universal DBEF improvement. See [the benchmark guide](docs/search/RANKING-BENCHMARK.md) and [reliability notes](docs/search/SEARCH-RELIABILITY.md).

## DBEF introduced in 1.7.10

**DBEF shared-reference discovery** replaces the old co-citation and first-four-reference network searches. It weights reference overlap by specificity and title/abstract relevance, adjusts for bibliography length and recent citation velocity, and balances reference pivots across selected seeds. The supplied scorer is built into the app without extra Python packages or model downloads.

Repeated equivalent provider queries and concurrent identical metadata requests now share work. Direct citations, semantic recommendations, selected literature indexes and optional full-text search remain complementary routes. The clearer statuses, linked previews and paper-link fixes from 1.7.9 remain included. See the [DBEF implementation guide](docs/search/DBEF.md) for equations, limits and validation.

**Find a paper from an in-text citation:** paste `(Martín-González et al., 2026)` or `Smith & Lee (2024)` into **Add paper**. Pulse searches Crossref and OpenAlex by author and year, shows possible titles and indexed DOIs, and lets you choose the paper. Accents, compound surnames, grouped citations and year suffixes are supported; optional title words refine ambiguous searches. Short citations never become placeholder papers or silently select the first result.

Discovery now defaults to **500 results**, with **1,000** and **2,000** options. The collection deadlines and 75-paper cross-encoder budget remain bounded; a requested count is a maximum, not a guarantee of that many matches. Old workspaces saved at 200 results move to 500.

![In-text citation lookup — synthetic example](docs/images/pulse-1.7.11-citation-lookup.png)

## What Pulse Does

Pulse connects the entire workflow of literature exploration into one cohesive desktop application:

1. **Import Anything:** Add papers by DOI, title, PMID, pasted citation, or bibliography file (BibTeX, RIS, EndNote, CSV), or simply drop PDF files straight into the workspace.
2. **Explore Connections Visually:** See how papers relate to each other through an interactive citation network, radial cluster maps, a full-screen library table, or a chronological timeline view.
3. **Smart Discovery:** Start with a seed paper or a research question. Pulse uses DBEF shared-reference discovery, follows direct citations and cross-checks multiple scholarly indexes (Semantic Scholar, OpenAlex, Europe PMC, Crossref, and CORE) to recommend relevant literature.
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
| **Concept Search Keywords** | Extracted by the configured AI, locally by default. If you configure cloud AI, your typed topic is sent to that provider. Extracted phrases and the original topic are sent to the selected scholarly indexes. |
| **Accounts & Tracking** | None. No account required, no telemetry, no tracking cookies. |
| **Scholarly Lookups** | Pulse sends public paper identifiers (DOIs, titles, search keywords) to open scholarly APIs (Crossref, OpenAlex, Europe PMC, Semantic Scholar, CORE) just like a web browser lookup. |

---

## Screenshots

![Current map workspace — synthetic example](docs/images/pulse-1.7.11-workspace.png)

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
1. Download **[Pulse-1.7.11.dmg](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.7.11/Pulse-1.7.11.dmg)**.
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

## Performance changes retained from 1.7.8

- **Less CPU reranking:** The cross-encoder assesses up to 75 candidates instead of 150. It retains overlapping text windows, source/channel coverage and foundational-paper support. All retrieved candidates remain eligible for text/citation ranking and the release now offers up to 2,000 displayed results.
- **Less embedding work:** Meaning ranking uses up to 150 candidates instead of 250. Collection warms the exact question and current ranked shortlist instead of queuing every arriving paper. Background and final ranking share in-flight work, and cache reads/writes are batched. A richer abstract invalidates an older embedding for the same DOI.
- **Europe PMC time budget:** Europe PMC now shares CORE's eight-second collection cap, including retries and socket waits. Completed results survive with a partial-result notice.
- **Clear performance measurements:** API timings separate collection, embedding, cross-encoder and total ranking time, with counts for papers actually assessed. Neural budgets and cancellation also apply while waiting for ongoing embedding work.

The offline Mac ranker, visible result bands, citation-hop cap and CORE recovery from 1.7.7 remain in place. The Mac release includes these changes; the linked Windows installer remains 1.7.6 and current Windows source is built in CI. See the [1.7.8 release notes](docs/releases/1.7.8.md). Timing measurements use synthetic inputs on the test Mac and do not establish live search latency or real-world recall.

---

## License

Pulse is open-source software licensed under the [MIT License](LICENSE). Free for personal, academic, and commercial use.
