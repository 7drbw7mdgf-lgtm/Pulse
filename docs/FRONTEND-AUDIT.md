# Frontend audit after Pulse 2.1.8

The repair keeps the 2.1.8 PDF reader, Trends topic map and screening workflows.

- The canvas recovers when a saved camera points away from every paper, fits the active map when switching tabs or resizing panels, and keeps fitted zoom on ordinary redraws. Fit view now scales and updates the canvas immediately using active-map papers.
- Fit map, timeline progression and SVG export share a group in the bottom Tools menu. The search bar keeps Paths and Focus map; match counts have room to remain readable.
- The full Library/Bibliography table has a sortable Date added column. New imports record an ISO timestamp, saved dates survive reload and duplicate imports, and the chosen sort is remembered. Older records without a known add date show an em dash and stay below dated records in either sort direction.
- The release dialog uses a grid that fits narrow windows. Dismissal, including Escape, is saved with the local workspace and checked after library restoration, so a new desktop browser port does not show it on every restart.

Validation: all frontend JavaScript unit checks and 13 isolated browser workflows passed. The added `tests/frontend_audit_ui.cjs` covers stale-camera recovery, active-map fitting, redraws and panel resizing, timeline/SVG actions, Date added persistence and sorting, duplicate import, Trends/Timeline themes, and the release dialog at 420px.

These are source hotfixes after the published 2.1.8 installers. The installers and release history are unchanged.
