# Install Pulse 1.5.8

Quit Pulse, open **Pulse-1.5.8.dmg**, and drag **Pulse.app** into **Applications**.

Apple Silicon Mac, macOS 11 or later, and Python 3.10 or later are required. PDF extraction dependencies are included. Python, Ollama and model weights are installed separately. This app is ad hoc signed and has not been notarized by Apple.

## Automatic paper details

Pulse checks imported and restored paper records automatically. DOI lookup comes first; title, authors, year and other available metadata support a conservative search when there is no DOI. Export checks citation details and carries available publication fields through to RIS, CSV, JSON and reference-manager transfers. Missing registry details remain empty. Local corrections are retained on refresh.

## Mendeley

Citation export works now: open the Mendeley pill, choose the papers, and use **Export for Mendeley**. Import the RIS file into Mendeley.

Shared sign-in and library sync are implemented but await the Pulse owner's application registration and HTTPS hosting. They are unavailable in this default installer. Once activated, users simply connect their Mendeley account; developer settings are hidden. The included activation document explains the remaining owner steps.

## Library sync after activation

Automatic sync imports new and updated records while Pulse is open, with **Sync now** also available. Local edits and tags are preserved. Remote deletions do not delete local papers. Removed papers remain out of automatic imports; clearing pauses sync. Undo and Recovery remain available.

## Verification

75 current-app Python checks, 11 shared sign-in checks, eight JavaScript suites and 23 backend compatibility checks passed. An isolated browser preview verified automatic metadata completion, simulated library import and a downloaded selected-paper RIS file. Real Mendeley authentication has not been tested. The package signature, version, bundled resources and disk image were checked.
