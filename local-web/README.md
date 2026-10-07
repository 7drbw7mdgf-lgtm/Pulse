# Pulse local web workspace

This independently runnable source contains the localhost updates: a compact discovery dropdown, map file drops, inspector visibility, sidebar paper actions, full-screen library with compact/expanded views, and a confirmed Clear papers action.

Paper imports extract DOI identifiers from text, PDF metadata and links. DOI lookup runs first; title, authors, year, journal and other available bibliographic fields are used when a DOI cannot identify the paper. Weak or ambiguous matches retain the extracted record.

The floating **AI agent** button uses installed Ollama chat models to summarize extracted paper text or abstracts. It labels records with only metadata and supports cancellation and summary downloads. It does not perform OCR or retrieve paywalled text.

## Run

Requires Python 3.10 or later. From this directory:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
PULSE_CONFIG_DIR="$PWD/.pulse-data" PULSE_PORT=62661 PULSE_APP_VERSION=1.4.0 python3 pulse-backend/pulse_backend.py
```

Open the localhost URL printed by the server. Use a free port if 62661 is already in use. `.pulse-data` keeps this copy's library separate. Omitting `PULSE_CONFIG_DIR` uses Pulse's existing application-support data directory. The backend automatically finds the sibling frontend.

For summaries, install [Ollama](https://ollama.com/download), start it locally, and install a chat model. Select that model in the AI agent panel. The summary agent connects to port 11434 and runs locally. Metadata lookup and discovery use online scholarly services.

## Library controls

**Full screen** fills the workspace with the library; **Exit full screen** returns to the map and sidebar. **Expanded / Compact** switches paper detail density.

**Clear papers** asks for confirmation and shows the paper count. **Cancel** preserves the library. **Clear all papers** removes papers, tags, map areas and links; export first to retain a copy. The button is disabled when there are no papers. Older saves finish before the reset, and a failed reset preserves the current browser library.

## Checks

From this directory, with Python dependencies installed and Node.js available:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/parser.cjs
node tests/library.cjs
```

These checks use synthetic fixtures and mocked services. They cover DOI normalization, metadata matching, PDF extraction, source selection, chunking, summary failures/cancellation, and library clear/cancel/save ordering. Browser checks also verified full-screen transitions, density switching and cancelling the clear dialog with a separate test library.

This folder is the local web update; it has not been packaged into a replacement signed Mac app. The repository's root desktop app and release instructions remain separate.
