# Install Pulse 1.7.8

Quit Pulse, open **Pulse-1.7.8.dmg**, and drag **Pulse.app** into **Applications**.

This build reduces CPU cross-encoder ranking to 75 candidates and meaning ranking to 150, reuses background embedding work, and caps Europe PMC collection at eight seconds. It retains all candidates for ordinary ranking and keeps multi-window text coverage in the bundled offline ranker. Direct citation discovery, bridge discovery, full-text passages and selected-paper reports remain available.

Apple Silicon Mac, macOS 11 or later, and Python 3.10 or later are required. PDF extraction dependencies are included. Python for the main backend, Ollama and its optional model weights are installed separately; the cross-encoder is bundled. The app is ad hoc signed and has not been notarized by Apple.

Your existing library remains in your user profile. The installer does not include personal papers or account credentials.

Mendeley RIS export works now. Shared sign-in and library sync require the Pulse owner's application registration and HTTPS hosting and are unavailable in the default installer. See **MENDELEY-ACTIVATION.md** for the owner's remaining activation steps.
