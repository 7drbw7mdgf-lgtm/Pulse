# Pulse development

Pulse 1.3.1 uses the supplied 1.2 workspace as its interaction reference and the 1.3 Tauri shell as its desktop target. Collections becomes Timeline. The library, inspector, discovery ribbon, graph layouts, tags, areas, analyst and bibliography remain available in the shared workspace.

## Run from source

Requires Python 3.9 or later:

```sh
python3 pulse_backend.py
```

Open the printed localhost URL. The backend supplies a per-session token; opening HTML directly does not start the services. `PULSE_CONFIG_DIR` selects an isolated library directory. Otherwise, data remains under `~/Library/Application Support/pulse/`, with first-launch migration from the old Iratxe directory when appropriate.

Optional PDF dependencies are listed in `requirements.txt`. Local AI requires Ollama and installed chat/embedding models. Gemini is the supported cloud service. Basic library management and graph exploration work without AI. Metadata and discovery contact scholarly services and depend on their coverage and rate limits.

## Backend structure

`pulse_backend.py` is a compatibility entry point. The `pulse` package has twelve functional modules:

| Module | Responsibility |
| --- | --- |
| `context.py` | Per-instance configuration, state, locks and context scopes |
| `types.py` | Paper, metadata, library and response TypedDicts |
| `storage.py` | Settings, credential persistence and ordered atomic library saves |
| `metadata.py` | Record normalization, DOI/text helpers and bounded PDF extraction |
| `providers.py` | Scholarly transport and metadata lookups |
| `ranking.py` | Existing pure recommendation ranking |
| `discovery.py` | Citation traversal, branch orchestration and job services |
| `uploads.py` | File parsing and metadata enrichment |
| `ai.py` | AI configuration, embeddings, extraction and analysis |
| `performance.py` | Request/vector caches, concurrency and discovery job management |
| `http.py` | HTTP authentication, input validation and route dispatch |
| `runtime.py` | Startup, readiness handshake, Ollama lifecycle and shutdown |

HTTP requests bind their server's `AppContext`; workers receive captured scopes using `contextual()`. Runtime imports do not start threads or register signal handlers. Expected transport, parsing and filesystem errors use specific catches and logging. Unexpected failures propagate to logged HTTP or job boundaries. Tokens in request query strings are excluded from request logs; known credential query parameters are redacted from formatted exceptions.

Discovery traversal and ranking were retained during extraction. Four synthetic golden fixtures recorded from the original ranking implementation compare complete output records, including ordering, evidence and scores. The old `pulse_core` implementation was replaced to avoid keeping competing service implementations.

The frontend retains the reference's numbered JS/CSS parts, loaded in order, with `js/timeline.js` and `css/timeline.css` providing the new view. Paper selection reuses analysis and settled layout. Inspector scores derive from actual text vectors and citation evidence; unknown influential-citation counts are left blank. Recent-paper shortcuts and cluster labels use the loaded library.

## Validation

```sh
npm ci
npx playwright install chromium
npm test
python3 test_v1_3_security.py
```

For installed Chrome, use `PULSE_BROWSER_CHANNEL=chrome npm test`. All checks use disposable data. The suite covers context isolation, captured workers, original ranking fixtures, discovery depth, branch failures/cancellation, metadata parsing, caches, ordered saves/reset, invalid requests, navigation, Timeline sorting, settings, PubMed addition/deduplication, paper visibility, reset, imports, exports and reload persistence. Security checks cover sessions, encrypted credentials, header-based Gemini keys and PDF decompression caps. Discovery browser responses are fixtures; they do not verify every live provider or configured AI model.

## Build the Mac app

Requires macOS, Xcode command-line tools, Rust and Node.js. The build stages canonical source into ignored `desktop/frontend` and `desktop/src-tauri/resources/backend` directories. No user settings or libraries are packaged.

```sh
bash scripts/package-desktop.sh /tmp/pulse-release "/Volumes/Pulse-v1.2/Pulse.app/Contents/Resources"
```

The optional second argument carries forward the supplied bundle's Ollama binary, PDF dependencies and their license metadata. Without it, those integrations require separate local installation. The release bundles dependencies, but not a Python interpreter. The launcher searches Homebrew Python, `/usr/local/bin/python3`, then system Python.

The Tauri shell waits for a private readiness file containing the actual backend port and token, then opens the served UI. External paper URLs go to the default browser. Exports download through the native webview into Downloads. Backend logs are in `~/Library/Caches/com.pulse.desktop/backend.log`.

To check a built bundle in the native webview:

```sh
python3 tests/native_mac.py desktop/src-tauri/target/release/bundle/macos/Pulse.app
```

This modifies only a disposable bundle copy, then checks startup, Network, Timeline, settings, JSON import and actual JSON/CSV downloads using temporary library/export directories. The packaged app has no test injection. Packaging verifies its deep signature, DMG and SHA-256 checksum. Current releases are Apple Silicon, ad hoc signed, and not Apple-notarized; see the [installation guide](MACOS-INSTALL.md).

## Provenance

The UI and bundled dependencies originate from the user-supplied Pulse 1.2 app; the Tauri project originates from the supplied 1.3 build. The discovery algorithms derive from the existing Pulse/Iratxe implementation. Metadata services include Semantic Scholar, OpenAlex, Crossref and PubMed. API credentials stay in local settings. External requests and optional cloud AI send the information needed for their requested operation.
