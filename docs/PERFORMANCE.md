# Pulse optimisation — Pulse 1.3.0

Measured on 6 October 2026 using isolated synthetic libraries. These are local development measurements, not promises for every Mac or research topic. No personal libraries were used.

## What changed

- Paper text, vectors, similarities, and citation evidence are cached until their inputs change. Moving or selecting a paper no longer repeats analysis or layout.
- Libraries above 100 papers calculate analysis and force layout in a background worker. Larger layouts use a spatial grid with bounded close-neighbour sampling. The graph keeps its SVG elements during selection changes.
- Dense networks draw the 2,500 strongest links matching the current link filter. All calculated relationships remain in library counts and full JSON exports; inspector metrics use the full graph. Citation evidence is retained; this is a display limit, not a paper quota.
- Discovery methods run with bounded concurrency. The interface shows progress and partial candidates, supports cancellation, and reports method failures. Candidate additions are disabled while results are still changing.
- Successful scholarly JSON requests use a bounded ten-minute memory cache. Requests are limited to two per provider, with bounded retries that respect Retry-After. Selected metadata batches use two workers and return in the original order.
- Model vectors use a persistent, bounded SQLite cache keyed by content, provider, endpoint, and model. The cache stores vectors and hashes rather than the original document text.
- Saves are serialised and coalesced. The backend rejects stale revisions, including late saves after a reset or final unload snapshot. Autosaves exclude derived links and clusters, which are reconstructed on load; exported JSON retains them.
- A complete save failure is reported as a failure. “Saved locally” is shown only when browser storage actually succeeded.

## Browser benchmark

The test generated short synthetic papers in 20 topic groups, with the same default threshold in both versions. Cold time includes analysis, drawing, and settled layout. Warm time is the median of five selection refreshes with unchanged paper content. The old version draws every link; the new version draws at most 2,500. This comparison measures the resulting user interaction, not an identical rendering workload.

| Papers | Previous cold render | Optimised cold render | Previous warm refresh | Optimised warm refresh |
| --- | ---: | ---: | ---: | ---: |
| 15 | 51.9 ms | 18.1 ms | 6.0 ms | 0.6 ms |
| 100 | 1,454.7 ms | 51.5 ms | 2,411.5 ms | 1.6 ms |
| 500 | Not measured | 266.4 ms | Not measured | 4.3 ms |
| 1,000 | Not measured | 707.9 ms | Not measured | 8.3 ms |

The 1,000-paper fixture initially rendered in under a second, with calculation running in the background. Longer or denser libraries can take more time. Paper length, shared vocabulary, relationship density, machine load, and upstream API responses affect performance. Results use headless Chrome on the development Mac. Network-service speedups were not measured against live providers.

Run the benchmark from the source folder with:

```sh
PULSE_BROWSER_CHANNEL=chrome node scripts/benchmark-network.cjs
```

Omit the browser-channel setting to use Playwright's installed Chromium. Full exercises 15, 100, 500 and 1,000 papers. The benchmark disables persistence and uses temporary storage.

## Actual macOS app checks

Both generated app bundles were also tested in the native macOS WebView using disposable copies and isolated storage:

- **Full, 500 synthetic papers:** 219 ms initial calculation and 17 ms selection refresh. The background worker completed without errors, the UI event-loop heartbeat continued, and selection retained existing nodes without new analysis or layout.

These native fixtures differ from the browser benchmark and should not be compared as a browser-versus-native contest.

## Verification

The test suite includes 17 Python tests plus browser workspace, graph and performance suites. Coverage includes cancellation, partial results, provider errors, cache invalidation, stale worker results, ordered and coalesced saves, fallback failures, imports, exports, timeline, and persistence.

DMGs are built from the existing native templates with updated resources. Packaging verifies code signatures and disk-image checksums; each download includes a version-specific installation guide and approval helper. Both remain ad hoc signed, Apple Silicon builds for macOS 11 or later, with the existing system-Python requirement.
