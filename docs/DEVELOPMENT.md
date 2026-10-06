# Pulse: setup and development

Technical setup, implementation details, validation and build provenance for contributors. For downloads and the basic workflow, see the [main README](../README.md).

## Run from source

Requires Python 3.9 or later. Run these commands from the Pulse source folder containing `pulse_backend.py`:

```sh
python3 pulse_backend.py
```

Open the localhost URL printed by the server. The server injects a per-session API token; opening `index.html` directly or using a generic static server does not provide the backend.

Optional PDF extraction dependencies:

```sh
python3 -m pip install -r requirements.txt
```

Ollama and installed chat/embedding models are optional for local AI extraction and analysis. Configure the endpoint and models under Settings. Google Gemini is the supported cloud provider. Metadata and discovery require access to their upstream services; availability and rate limits can affect results.

The macOS release carries forward the native Apple Silicon launcher, Ollama binary and PDF dependencies from the supplied Pulse v1 bundle. It is signed ad hoc and is not notarized. The original launcher source was not present in the supplied DMG; the included packaging script therefore takes that bundle as its template.

## Workspaces and interactions

- Add papers by title/text, DOI or PMID, with duplicate detection and visible lookup errors.
- Import PDF, BibTeX, RIS, CSV, JSON and EndNote records; export the map and bibliography.
- Discover fills the main panel with a starting-paper selector, methods, depth and an explicit search action. Select candidates before adding them.
- Network uses the full canvas without a library sidebar. Full screen expands it across the window; Escape exits. Click a paper to inspect it and discover related work.
- Timeline arranges the shared papers by publication date, oldest first, with year fallback and undated papers last. Its papers can start a new discovery.
- Library opens the bibliography. Network supports Network, Clusters and Radial layouts. Collections navigation has been removed.
- Filter papers by metadata, filter graph links by type, and synchronize labels with graph settings.
- Expand/compress the graph, fit the view, inspect links and edit paper tags.
- Run Direct, 2-Hop, 3-Hop or bounded Iterative discovery. Iterative explores up to four hops and stops when its frontier is empty; expansion is limited to four papers per direction per hop.
- Toggle discovery methods consistently across the ribbon and inspector. Disabled Concepts stays disabled in the backend.
- Pin a discovery seed, review results and retain the resulting link evidence after reload.
- Switch local/cloud settings, save the scanning option, test the connection and reset the library.
- Reach toolbars and dialogs in resized windows. Recent papers and cluster labels reflect the actual library.

Map similarity bars use local text-vector cosine similarity, verified citation/co-citation edges and keyword overlap. Unknown influential citation counts remain blank. These are map evidence measures, not provider-generated SPECTER2 scores or a clinical/scientific assessment.

Settings and the library live under `~/Library/Application Support/pulse/`. On the first default launch, the backend can migrate the previous Iratxe directory. An explicit `PULSE_CONFIG_DIR` selects an isolated directory and disables automatic migration. No personal library, settings or API keys are included in the repository or release.

Discover and Network share one paper library. Discover finds and reviews candidates; Network shows relationships and can start discovery from any selected paper. Adding candidates returns them to the same map, with the discovery evidence saved.

## Tests

```sh
npm install
npx playwright install chromium
npm test
```

For an installed Chrome browser, use `PULSE_BROWSER_CHANNEL=chrome npm test`. The UI suite launches its own backend and temporary library. Python tests cover discovery depth, disabled branches, PMID parsing, storage and reset. Browser tests exercise workspace navigation, fullscreen, chronological ordering, discovery from map nodes and timeline papers, result selection, import/export, settings, responsive layouts and reload persistence. Discovery responses in browser tests are deterministic fixtures; the PMID lookup was also checked against a live PubMed record.

## macOS packaging

The native launcher invokes `/usr/bin/python3`; it does not bundle a Python interpreter. A working Python 3.9+ interpreter at that path is a requirement for the supplied macOS launcher. The source backend can instead be started with an available compatible Python executable.

```sh
bash scripts/package-macos.sh "/Volumes/Pulse v1/Pulse.app" /tmp/pulse-release
```

This copies the supplied native template, replaces the app resources, updates the version and rebuilds its signature and DMG. The disk image includes the macOS guide and app-specific quarantine helper. Build output is ignored by Git.

Download the latest DMG from [GitHub Releases](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/latest). For first-launch approval of this ad hoc signed build, read [the macOS installation guide](MACOS-INSTALL.md). The included [Allow-Pulse.command](../scripts/Allow-Pulse.command) verifies Pulse 1.3.0 before offering to remove only its quarantine attribute; it does not notarize the app or disable system-wide security settings.

## Sources and provenance

The app resources originate from the user-supplied `pulse-v1.dmg`; the backend was compared with the supplied Iratxe 3.2 bundle. External metadata/discovery uses Semantic Scholar, OpenAlex, Crossref and [NCBI PubMed E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25499/). API keys remain local. Bundled third-party binaries and their licence metadata remain in the native template/release; they are not part of the source checkout.

## Performance and reliability

The shared graph engine caches text analysis and citation evidence. Libraries above 100 papers use a background worker for analysis and force layout; selection changes preserve SVG elements and settled positions. Dense networks draw up to 2,500 of the strongest visible links while retaining all calculated relationships for counts, inspector metrics and JSON export.

Discovery runs at most three methods concurrently, with at most two JSON requests per provider. The interface polls progress, shows partial candidates and supports cancellation. Cancellation stops further requests and discards late results; an already running HTTP request can take until its timeout to finish. Successful JSON responses have a bounded, ten-minute memory cache. Model vectors are reused in a bounded SQLite cache keyed by text, provider, endpoint and model, without storing the original document text.

Library writes are serialised, coalesced and protected against stale revisions, including unload beacons. Autosaves omit derived links and clusters, which are rebuilt from papers and explicit evidence on load. JSON exports retain calculated links. Save failures distinguish a successful browser fallback from a complete persistence failure.

The test suite includes worker responsiveness, stale results, cancellation, partial discovery, model-cache invalidation, save ordering and fallback failures.
