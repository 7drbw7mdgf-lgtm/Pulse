# Pulse Lite — explore a small reading list

Pulse Lite helps you find related research papers, see how they connect, and arrange them in publication order. It has the same Discover, Network, Timeline, and Library workspaces as Full, with a **hard cap of 15 saved papers**.

It is a useful starting point for trying Pulse or exploring a tightly focused topic.

**[Download Pulse Lite 1.0.0](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/download/lite-v1.0.0/Pulse-Lite-1.0.0.dmg)** · [Installation guide](docs/MACOS-INSTALL.md) · [Explore Full](../README.md)

## A simple way to begin

1. Add a paper by title, DOI, PubMed ID, or PDF.
2. Use **Discover** to look for related work and select the papers you want to keep.
3. Explore the connections in **Network**, follow the publication order in **Timeline**, or manage the list in **Library**.

You can also import common bibliography formats and export your library or map.

## How the 15-paper limit works

The limit applies to the entire saved library, including imports, duplicates that create a new record, and papers added through discovery. Discover candidates remain available to review when the library is full. Bulk additions use the available slots and report skipped papers; matching duplicates merge without taking a new slot.

Remove a paper in **Library** to make room. Lite has separate storage from Full, so trying it does not change your Full library. Lite exports can be imported into Full when you want to continue with a larger collection.

## Install and requirements

The current installer is for **Apple Silicon Macs running macOS 11 or later**. The native launcher uses Python 3.9 or later at `/usr/bin/python3` for its local backend. Open the DMG and drag **Pulse Lite.app** into Applications.

The build is ad hoc signed and not Apple-notarized. Follow the [first-launch guide](docs/MACOS-INSTALL.md) if macOS blocks it. The DMG includes the guide and the app-specific `Allow-Pulse-Lite.command` helper. The same download files are in [dist/](dist/).

Your library is saved locally. Metadata and discovery use online scholarly services; optional AI can use local Ollama models or the supported cloud provider. See [how Pulse works](../README.md#local-library-online-discovery) for details.

For source setup, exact limit behavior, storage, tests, and packaging, see the [Lite development notes](docs/DEVELOPMENT.md). For help or feedback, [open an issue](https://github.com/7drbw7mdgf-lgtm/Pulse/issues).
