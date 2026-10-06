# Pulse — explore the connections between research papers

Pulse is a Mac app for finding related research papers, mapping how they connect, and seeing a topic develop over time. Start with a paper you know, build a reading list around it, and explore the same library as a network, a timeline, or a searchable bibliography.

It is designed for researchers, students, and anyone getting to grips with a new field, planning a literature review, or following a citation trail.

**[Download Pulse Full](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.2.1/Pulse-1.2.1.dmg)** · **[Download Pulse Lite](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/lite-v1.0.0/Pulse-Lite-1.0.0.dmg)** · [Installation guide](docs/MACOS-INSTALL.md)

![Pulse's Discover workspace: choose a starting paper, search methods, and exploration depth.](docs/images/discover.png)

*The actual Discover interface with an illustrative sample library. This screenshot is not a live search result.*

## What you can do with Pulse

- **Find your next paper.** Start from a known paper and explore references, papers that cite it, shared citations, and related text or concepts. Review candidates and choose what to add.
- **See the connections.** Explore an interactive network, inspect individual papers, switch layouts, or expand the map to fill the window.
- **Follow a topic through time.** Timeline places your papers in publication order, making it easier to read from earlier work to newer developments.
- **Bring your reading list with you.** Add papers by title, DOI, or PubMed ID. Import PDFs and common bibliography formats, including BibTeX, RIS, CSV, JSON, and EndNote records.
- **Keep the work you have collected.** Search and filter your library, add tags, and export your map or bibliography.

For example, you could start with a review article, look for the work it cites and the work that cites it, select a few promising papers, and then use Timeline to plan a reading order.

## One library, four ways to explore it

| Workspace | Use it when you want to… |
| --- | --- |
| **Discover** | Find related papers and decide which ones belong in your library. |
| **Network** | Understand relationships and choose a paper to explore further. |
| **Timeline** | Read the literature in chronological order. |
| **Library** | Search, filter, and manage your bibliography. |

Discover and Network work together. Select a paper on the map to start a discovery, review the candidates, and add your choices to the same network. You can also start a discovery from Timeline.

## Choose your edition

| | Pulse Full 1.2.1 | Pulse Lite 1.0.0 |
| --- | --- | --- |
| Discover, Network, Timeline, and Library | Included | Included |
| Saved-paper limit | No built-in paper cap | **15 papers total** |
| Best suited to | An expanding reading list or literature review | Trying the workflow or exploring a small topic |
| Download | [Full DMG](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/v1.2.1/Pulse-1.2.1.dmg) | [Lite DMG](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/lite-v1.0.0/Pulse-Lite-1.0.0.dmg) |
| Help | [Full installation guide](docs/MACOS-INSTALL.md) | [Lite guide and details](lite/) |

Lite has its own saved library and can coexist with Full. Its 15-paper limit applies across every workspace; removing a paper in Library frees a slot. Lite exports can be opened in Full.

## Get started

1. Download the edition you want, open its DMG, and drag the app into **Applications**.
2. Launch Pulse and add a starting paper by title, DOI, PubMed ID, or PDF.
3. Open **Discover**, choose your starting paper and search methods, then click **Find related papers**. Select the candidates you want to keep and explore them in Network or Timeline.

**Current Mac requirements:** macOS 11 or later, an **Apple Silicon Mac**, and Python 3.9 or later available at `/usr/bin/python3` for the native launcher's local backend. The current DMG is not an Intel build.

These releases are ad hoc signed and are not Apple-notarized. If macOS blocks the first launch, follow the [installation guide](docs/MACOS-INSTALL.md). Each DMG includes a guide and an app-specific approval helper. On GitHub Releases, download the **DMG** to install the app.

## Local library, online discovery

Your paper library and settings are saved on your Mac. Metadata lookup and discovery contact online scholarly services, including Semantic Scholar, OpenAlex, Crossref, and PubMed. Their coverage and rate limits can affect the results you receive.

AI features are optional. You can configure local models through Ollama or the supported Gemini cloud provider in Settings. Basic library management and map exploration do not require an AI model. Map connections combine citation evidence with text and keyword measures; paper details help you see what a connection represents.

## Help and development

Found a problem or have an idea? [Open an issue](https://github.com/7drbw7mdgf-lgtm/Pulse/issues) and describe what you were trying to do, your app version, and what happened.

For Python setup, storage locations, tests, packaging, and implementation provenance, see the [development notes](docs/DEVELOPMENT.md). [Pulse Lite](lite/) has its own limit and development documentation.
