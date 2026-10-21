# Map and library tools

## Focus and resize

Use **Focus map** beside the network search to give the network the whole workspace. **Exit focus** restores the previous panels; Escape also exits when focus is outside a text field or dialog. Drag either panel divider to resize the Library or paper details. A focused divider also supports Left/Right arrows and Home. Widths are remembered on this computer.

## Search within a network

Search titles, abstracts, authors, journals, keywords, tags and notes on the active map. Use quoted phrases and Any/All matching. The arrow buttons visit each match; **Fit all matches** changes the camera without changing paper positions. **Show matches only** hides other nodes and their links. Expand **Matched papers & snippets** to see the matching terms, fields and source excerpts. This search does not send queries to literature providers or recalculate relationships.

## Paths

Choose **Paths**, or select two map papers and choose **Show path**. Choose which link types to include. Pulse finds a shortest undirected path through links already displayed in the active map, at its current threshold. Each step identifies citations, shared references, co-citation, similarity or mixed evidence. Similarity and shared references do not establish a citation or agreement. No path means no path in the loaded, selected link types; it does not establish that the papers are unrelated.

## Smart collections

Use **Collections** above the Library filter. Save a name, comma-separated phrases, tags, matching mode, reading status and optional year limits. For example, `Campylobacter, oxidative stress` with **Not read** includes papers matching both phrases that have not been marked Read. The Library's collection selector applies the saved rule. Membership responds to imports and edits; removing a rule does not remove papers.

## Duplicate review

Use **Duplicates** above the Library filter. Suspected pairs share a DOI, PMID, or normalized title with a compatible publication year. Detection proposes candidates and never merges them automatically. Review both columns, choose the record ID to retain and choose individual metadata values. Different DOIs are flagged for review. Notes, tags, PDF attachments/annotations, source aliases and map membership are combined. A durable recovery point stores both originals before the write.

**Undo last library change** restores the original records and leaves unrelated newer records and edits alone. Undo pauses if the merged record itself has newer content edits, to avoid overwriting them. Its original records remain in the recovery snapshot. **Keep separate** dismisses a suspected pair.

## PDF reading and quotations

Choose a paper and **Read PDF** in its details. Attach a local PDF, or use a PDF already imported after this feature was added. Older imports need the original file attached once. PDF files are stored by content hash under the local profile's `pdfs` folder. Exported library JSON contains attachment references and annotations, not the PDF binaries; moving a library to another computer requires copying or reattaching those PDFs.

Use page navigation and zoom, select text, choose a highlight colour and optionally add a memo. Saved highlights can be revisited, edited and removed, with Undo for the last removal. Scanned pages use bundled English OCR when available; a page without selectable text or OCR reports that limitation.

**Quote to Notes** creates a note quotation and a link back to the page. **Quote to Evidence Matrix** assigns a quotation to a comparison column. Pulse verifies the quotation against the actual local PDF page, including OCR when used, before saving it and again when it is used as a reviewer-selected matrix cell. Select that paper in a comparison to see the saved quotation and its page provenance. OCR text still needs checking against the page image. Attachments and PDF annotations remain local and are excluded from library relay sync; quotations explicitly inserted into Notes follow the existing Notes sync setting.

## Scheduled watchlists

Save an online search under **Saved searches**, enable **Watch**, then choose **Daily while open** or **Weekly while open**. Manual is the default. Due checks run one at a time while Pulse is running and idle, and resume after sleep or an overdue launch. They use the saved query, tags and sources without replacing the current search or opening its results dialog. Provider errors retain the existing baseline and retry after an hour; partial checks report the unavailable sources.

Candidates appear under **New papers** in the Library. **Add to Library** marks a candidate To read without adding it to a map; **Dismiss** removes it from the pending inbox. Include reviewed candidates to return one to the inbox. Results are deduplicated against the inbox and library. The inbox holds up to 10,000 candidates; older reviewed history is trimmed at that limit, while a full unreviewed inbox pauses automatic checks. Search history retains the latest 20,000 identities per watchlist. Checking while Pulse is closed requires a separate background service and is outside this scheduler.

## Validation

`npm run test:workspace-features` exercises the seven workflows against a synthetic library and a generated PDF, including persistence, typed paths, duplicate merge/undo, page-grounded matrix quotations and daily/weekly/error scheduling. `test_library_features.py` covers durable merge/recovery, file validation and verified PDF evidence. The full `npm test` command includes these checks.
