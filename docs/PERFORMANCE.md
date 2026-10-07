# Pulse 1.3.1 performance and reliability

This release restores the supplied 1.2 interface inside Tauri and extracts the backend into twelve modules. Discovery traversal and ranking are preserved. Earlier 1.3.0 worker and retained-SVG measurements describe a different frontend and do not apply to this restored workspace.

## Current measurements

Measured on 7 October 2026 with headless Chrome on the development Mac. Short synthetic papers use twenty topic groups and the default threshold. Cold time includes analysis, drawing and layout; warm time is the median of five selection refreshes. No user library was used.

| Papers | Cold render | Warm selection | Calculated links |
| --- | ---: | ---: | ---: |
| 15 | 25.0 ms | 3.6 ms | 105 |
| 100 | 239.8 ms | 54.7 ms | 4,950 |

Selection reuses the analysis and settled layout while the reference renderer redraws SVG elements. Initial graph calculation still runs on the main thread and compares paper pairs; large, dense libraries need further frontend optimisation. These measurements are observations of these fixtures, not speed guarantees or live-provider benchmarks.

```sh
PULSE_BROWSER_CHANNEL=chrome node scripts/benchmark-network.cjs
```

Defaults are 15 and 100 papers. `PULSE_BENCH_SIZES=15,100,250` selects other sizes. Libraries and persistence are isolated from real user data.

## Reliability retained during extraction

- Discovery methods use bounded concurrency and retain successful branches when another fails. The job API supports progress and cancellation; the restored reference UI uses the completed pipeline response.
- Successful scholarly JSON responses use a bounded ten-minute cache. Requests use provider gates and bounded Retry-After retries.
- Model vectors use a bounded SQLite cache keyed by content, provider, endpoint and model, without storing the original document text.
- Browser saves coalesce in a serial queue. Backend revision checks reject stale saves after newer snapshots, resets and unload beacons. Atomic file replacement protects the library write.
- Save errors distinguish a browser-storage fallback from a complete persistence failure.
- Runtime state and caches belong to an application context. Request and worker scopes prevent instances from sharing tokens, libraries or revision state.

## Verification

Twenty-three Python tests pass on Python 3.9, plus browser interaction, graph-engine and save-performance suites. Separate security tests cover encrypted credentials, session/Origin checks, header-based Gemini keys and PDF decompression caps. Ranking parity uses four complete-output fixtures recorded before extraction.

The rebuilt Tauri bundle was checked in the actual Mac webview using a disposable copy and temporary data: startup port/token handshake, graph selection, Timeline ordering, settings persistence, JSON import and JSON/CSV downloads passed without JavaScript errors. The final installer is verified with a deep code-signature check, DMG verification and SHA-256 checksum. It is ad hoc signed and not Apple-notarized.
