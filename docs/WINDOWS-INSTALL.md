# Pulse 2.1.2 for Windows

The Windows installer targets **Windows 10/11, x64**. It includes the Pulse desktop window, Python backend, PyMuPDF PDF reader and SQLite full-text support. Users do not need Python, Rust or Node.js. ARM64 Windows is not separately packaged; x64 compatibility depends on the device's Windows emulation support.

Both Windows and Mac use the same 2.1.2 frontend and backend, including Trends, background graph calculations, cached layouts, retained library rows, lighter autosave, Semantic Scholar settings and smoother Timeline scrolling.

## Install

Run `Pulse-2.1.2-Windows-x64-Setup.exe` and follow the setup prompts. Pulse installs for the current Windows user and adds a Start menu shortcut. The setup downloads Microsoft's WebView2 runtime if the computer does not already have it; that step needs an internet connection.

The Windows installer is unsigned. Windows may show an unknown-publisher or SmartScreen warning. Check that the file came from this project and that its SHA-256 matches the supplied checksum. A production signing certificate is not included.

Pulse stores its library, settings, recovery records and passage index in `%LOCALAPPDATA%\Pulse`. Keep this folder to preserve your workspace when reinstalling. Library JSON export provides a portable copy that can be imported on another computer. Exports use the native Downloads flow. The backend listens only on loopback and requires a session token; no firewall port opening is needed.

## Optional AI and reference managers

Install and run [Ollama for Windows](https://ollama.com/download/windows) to use local AI reports. Pull the models selected in Pulse's settings; Ollama model weights are not included in the setup. Library management, PDF imports and online discovery can run without Ollama. The separate offline pairwise search ranker and its model are bundled in the installer.

Zotero Desktop must be installed and running for local transfers. Mendeley uses the same repaired Pulse sign-in service as the Mac app. Choose **Connect Mendeley**, or **Use Pulse sign-in** if this computer has old custom developer settings. No developer application ID or secret is required on each computer. Mendeley RIS export remains available.

## Build and verify

On a Windows x64 development computer, install PowerShell 7, Python 3.12, Node.js, Rust and Visual Studio C++ build tools. From the repository root:

```powershell
pwsh -File scripts/package-windows.ps1
python scripts/verify-windows-package.py --installer outputs/windows/Pulse-2.1.2-Windows-x64-Setup.exe --report outputs/windows/verification.json
```

The first command produces the setup and checksum. The second installs a temporary copy and tests its bundled backend, native window, library persistence, authenticated API, PDF and DOI extraction, full-text passages and backend shutdown. It uses synthetic records and an isolated profile. These checks do not establish live provider accuracy, account authorization or AI report quality.

The **Build Pulse Windows** GitHub Actions workflow runs the same checks on a native Windows runner and uploads the setup, checksum and report. The installer is built with [Tauri NSIS packaging](https://v2.tauri.app/distribute/windows-installer/), and the backend is frozen with [PyInstaller](https://pyinstaller.org/en/stable/usage.html).

## Offline assets and release verification

Windows packaging builds a separate portable ONNX ranker with its own Python and inference dependencies. The model and English OCR language data are installed beside the frozen backend modules, where the app resolves them. Searches do not download model weights or depend on a developer's Python installation.

The installed-app CI check requires a scanned synthetic PDF to produce OCR text and an offline query to rank a relevant synthetic paper above an unrelated one. It also checks the native window, session authentication, library persistence, passage retrieval, manager APIs, and backend shutdown. A successful source test or installer build alone does not satisfy these checks.

After installing 2.1.2 once, future versions download inside **Settings → App updates**. Pulse verifies signed packages, saves your library and restarts through the native updater. The [small setup wizard](../installer/README.md) can install optional local AI components.
