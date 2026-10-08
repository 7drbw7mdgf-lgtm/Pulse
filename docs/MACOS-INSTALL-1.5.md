# Install Pulse 1.5.1

This build supports Apple Silicon Macs with macOS 11 or later and Python 3.10 or later. Python must be available at `/opt/homebrew/bin/python3` or `/usr/local/bin/python3`. PDF extraction dependencies are included. Ollama and its chat models are installed separately for the optional local summary agent.

1. Quit Pulse, open `Pulse-1.5.1.dmg`, and drag **Pulse.app** into **Applications**.
2. Open Pulse from Applications. If macOS blocks this ad hoc signed, non-notarized build, approve it through **System Settings → Privacy & Security → Open Anyway** if you trust the build.
3. Use the existing local Pulse library. Export a copy before using **Clear papers**.

For local summaries, start Ollama and select an installed chat model in the bottom-right **AI agent** panel. DOI parsing and scholarly metadata search do not need an AI model. Metadata lookup and literature discovery contact online scholarly services; summaries use local Ollama.

Pulse 1.5.1 adds the discovery options popup, direct map file drops, inspector switch, sidebar paper actions, full-screen library and compact/expanded views, DOI-first metadata lookup with other-metadata fallback, and the local paper summary agent.

The app is ad hoc signed and has not been notarized by Apple. It requires a separately installed Python interpreter; no Python interpreter or Ollama model weights are bundled.

Version 1.5.1 fixes desktop file drops: drag supported PDF or bibliography files from Finder onto the network grid to import them.
