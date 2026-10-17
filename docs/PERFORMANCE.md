# Large-library performance

The desktop package stages `local-web/pulse-frontend` and `local-web/pulse-backend`. Performance regression tests exercise those production files, independently of the historical root frontend.

## Changes

Graph input snapshots compare relevant scalar fields and copied metadata arrays without serializing unchanged full text. The analysis engine caches tokenization, similarity pairs and citation topology. Selection, colour changes and ordinary redraws reuse the accepted result. Libraries of at least 120 papers use a worker for analysis; force layouts with at least 120 active nodes also run there. Revision and position checks reject stale results. Layout caches include map membership, dimensions, mode, centering, spacing and pinned coordinates.

Library cards and full-screen table rows retain their DOM identity unless displayed content changes. A measured scrolling window limits mounted rows; a focused editor remains mounted. Event delegation prevents duplicate listeners. Sorting precomputes expensive keys once per paper. Map counters use sets instead of repeatedly searching the whole library for each link.

Autosave keeps one request in flight and combines later edits into the latest snapshot. Cached paper serialization and bibliography extraction avoid repeated full-text processing. A successful full save establishes an opaque storage revision; later requests can transfer changed papers. The backend validates that exact baseline and checkpoints the complete library atomically. A foreign clear or recovery invalidates old patches. The full local browser backup and on-disk checkpoint still contain the complete library; this is not a database migration.

Trends reuses accepted graph keywords and topic groups. It caches publication and concept aggregates by relevant metadata, retains the dashboard when unchanged, and initially draws 24 paper cards and 12 concepts.

## Reproducing validation

Run `npm run test:workspace` for scoring parity, stale worker results/fallback, maps and pinning, keyed Library rows/editors, scrolling, save conflicts/clear/recovery, and Trends coverage and cache invalidation. Run `npm run test:performance:workspace` for a headless production-frontend benchmark using isolated synthetic libraries and no external service requests.

Measured on the development Mac with the same fixtures and four active map papers:

| Operation | 336 papers before | 336 papers after | 1,000 papers before | 1,000 papers after |
| --- | ---: | ---: | ---: | ---: |
| Unchanged redraw, median of three | 196.8 ms | 2.5 ms | 1,763.7 ms | 9.5 ms |
| Initial render returns | 209.5 ms | 12.0 ms | 1,814.6 ms | 5.1 ms |
| Calculation and view ready | 428.1 ms | 212.0 ms | 3,558.7 ms | 952.8 ms |
| Paper selection | 10.1 ms | 3.8 ms | 54.6 ms | 12.1 ms |
| Mounted library rows | 336 | 20 | 1,000 | 20 |

Relationship and cluster totals match the baseline. Settled positions remain stable across unchanged redraws. Cached Trends reopening measured 0.8–1.5 ms. A separate synthetic save fixture with 336 papers and 24,000 full-text characters per paper sent 30,340 bytes for a one-paper delta versus 8,789,926 bytes for the full request (99.65% less transfer).

These measurements describe synthetic local fixtures, not guaranteed timings for every library, machine or external search provider. Cold calculation still depends on paper count, text and relationship density.
