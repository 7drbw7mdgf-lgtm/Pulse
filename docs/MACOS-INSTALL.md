# Install Pulse 1.8.9

Quit Pulse, open **Pulse-1.8.9.dmg**, and drag **Pulse.app** into **Applications**, replacing the previous copy.

An **Apple Silicon Mac**, **macOS 11 or later**, and **Python 3.10 or later** are required. Python for the main backend is installed separately. PDF extraction dependencies and the offline cross-encoder are included; Ollama and its optional model weights are installed separately.

The app is **ad hoc signed** and **has not been notarized by Apple**.

Your existing library remains in your user profile. The installer does not include personal papers or account credentials.

In **Settings → Search sources → Semantic Scholar**, enter an optional API key and choose **Save**. Saved keys stay encrypted on this computer. Public search remains available without a key; **Remove saved key** removes the locally saved key. A key supplied by the computer's environment takes precedence.

Timeline keeps only five nearby paper cards mounted, preserves native scrolling, and updates the inspector after scrolling settles. Year navigation and keyboard selection remain immediate.

**Current Mendeley limitation:** RIS export remains available. Shared sign-in and sync are currently blocked because Mendeley rejects the shared sign-in service's application credentials. The Pulse owner must correct the service's application ID or secret. Reinstalling Pulse or repeating browser sign-in does not repair that server setting.

See the [1.8.9 release notes](releases/1.8.9.md).
