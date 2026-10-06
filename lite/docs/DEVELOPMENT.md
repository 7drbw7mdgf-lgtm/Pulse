# Pulse Lite: limits and development

For an introduction and downloads, see the [Lite README](../README.md).

## The 15-paper limit

- Title/text, DOI and PMID additions all check available capacity, including after asynchronous lookups finish.
- PDF and bibliographic imports add only the available slots. Bulk imports and discovery selections report skipped papers. Import duplicates merge without taking a new slot.
- Discovery candidates can still be reviewed at capacity. Adding candidates, recommendations, seminal papers and citation trails respects the same shared cap.
- Network, Library and Timeline show the same papers; the limit applies to the whole library, not to each view.
- Remove a paper using its **Remove** button in Library to free a slot. Existing saved links are cleaned up with it.
- The backend rejects a library save above 15 papers with HTTP 413, regardless of caller-supplied limit fields. Oversized saved files are rejected and preserved. Reset Lite in Settings to replace such a file intentionally.
- JSON exports remain compatible with full Pulse. When importing a larger Pulse export, Lite keeps only the available slots and reports the remainder.

Lite uses `~/Library/Application Support/pulse-lite/` and independent browser-storage keys. It does not migrate the full Pulse or Iratxe library. Use `PULSE_LITE_CONFIG_DIR` to choose an isolated test directory; full Pulse's `PULSE_CONFIG_DIR` and `IRATXE_CONFIG_DIR` are ignored by Lite.

## Install

Download the [Pulse Lite release](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/tag/lite-v1.1.0), or the identical installer under [dist/](../dist/). Verify `Pulse-Lite-1.1.0-SHA256SUMS.txt`, open the DMG and drag **Pulse Lite.app** into Applications. It has its own bundle identifier and can coexist with full Pulse.

The Apple Silicon build is signed ad hoc and is not notarized. Read [MACOS-INSTALL.md](MACOS-INSTALL.md) for first-launch approval. The DMG also contains [Allow-Pulse-Lite.command](../scripts/Allow-Pulse-Lite.command), which verifies the Lite app before offering to remove only its quarantine attribute.

## Run from source

Run these commands from the Lite source folder containing `pulse_backend.py`. The native Mac launcher separately expects Python 3.9+ at `/usr/bin/python3`.

```sh
python3 pulse_backend.py
```

Requires Python 3.9 or later. Open the localhost URL printed by the backend, which injects its per-session API token. Optional PDF extraction packages are listed in `requirements.txt`; local AI features use Ollama and installed models. Metadata/discovery uses upstream services and can be affected by their rate limits.

## Tests

```sh
npm ci
npx playwright install chromium
npm test
```

For installed Chrome, use `PULSE_BROWSER_CHANNEL=chrome npm test`. Tests use disposable Lite libraries. The suite covers workspace controls, backend storage limits, batch imports, duplicate merging, discovery, citation/recommendation insertion paths, concurrent lookups, reload/export, slot release and oversized-file preservation.

## Build the macOS DMG

```sh
bash scripts/package-macos.sh "/Volumes/Pulse v1/Pulse.app" /tmp/pulse-lite-release
```

The supplied Pulse v1 native bundle is the template because its launcher source was not included in the original DMG. Packaging replaces the resources, sets the Lite bundle name and identifier, signs the bundle, includes the guide/helper and verifies the disk image. Third-party licence files remain in the native template. No personal libraries, settings or API keys are bundled.

## Performance and reliability

The shared graph engine caches text analysis and citation evidence. Libraries above 100 papers use a background worker for analysis and force layout; selection changes preserve SVG elements and settled positions. Dense networks draw up to 2,500 of the strongest visible links while retaining all calculated relationships for counts, inspector metrics and JSON export.

Discovery runs at most three methods concurrently, with at most two JSON requests per provider. The interface polls progress, shows partial candidates and supports cancellation. Cancellation stops further requests and discards late results; an already running HTTP request can take until its timeout to finish. Successful JSON responses have a bounded, ten-minute memory cache. Model vectors are reused in a bounded SQLite cache keyed by text, provider, endpoint and model, without storing the original document text.

Library writes are serialised, coalesced and protected against stale revisions, including unload beacons. Autosaves omit derived links and clusters, which are rebuilt from papers and explicit evidence on load. JSON exports retain calculated links. Save failures distinguish a successful browser fallback from a complete persistence failure.

The test suite includes worker responsiveness, stale results, cancellation, partial discovery, model-cache invalidation, save ordering and fallback failures.
