# Install Pulse 2.1.12 on Mac

Pulse 2.1.12 targets Apple Silicon and includes its Python interpreter, PDF/OCR dependencies and offline search ranker. You do not need to install Python. Ollama and optional local AI models are installed separately.

1. Open the Pulse 2.1.12 DMG and drag Pulse into Applications.
2. Quit older Pulse instances before opening the upgraded app so they do not write to the same profile.
3. Open Pulse from Applications. Its library remains in `~/Library/Application Support/pulse`.
4. On first use, Pulse imports the existing JSON library into SQLite. It retains the original JSON and a migration checkpoint in `backups`; notes, tags, local full text and map assignments are preserved.

Use **Export → JSON** for a portable current copy and **Recovery** to undo removals or restore a workspace. The old `library.json` becomes a migration checkpoint; after migration, `library.sqlite3` is the live library. Do not edit or copy an old JSON file over an active database. Move data with JSON export/import or copy the entire data folder while Pulse is closed.

Local development builds use an ad hoc signature until publisher credentials are configured. They are not Apple-notarized. See [signing setup](SIGNING.md). The included Allow Pulse helper is for the exact app version and is intended for user-controlled local builds.

For Mendeley, choose **Use Pulse sign-in** in Reference managers. If a connection fails, open **Settings → Connections → Check connections** for specific recovery advice. Optional Semantic Scholar keys live in **Settings → Search sources**.

The published 2.0.1 and earlier Mac packages require Python 3.10+ installed separately; the bundled interpreter described here applies to 2.1 builds.

After this one-time installation, use **Settings → App updates** for signed automatic downloads and **Restart & update**. No new DMG needs to be opened for later releases. [Update guide](APP-UPDATES.md).
