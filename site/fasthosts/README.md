# Pulse public homepage (static shared hosting)

This folder contains a standalone `index.html` landing page for the Pulse desktop application. It is intentionally **not** the Pulse research UI: the real workspace needs Python backend services and per-user local databases.

The site includes the main feature overview, privacy explanation and links to the current [Pulse releases](https://github.com/7drbw7mdgf-lgtm/Pulse/releases/latest). It requires no backend, database, runtime secrets, tracking scripts or build tools.

## Fasthosts deployment

Pulse's current deployment route uses the existing verified Sparkboard Fasthosts publishing pipeline, which can stage this file under `/pulse/index.html` on [sparkboard.co.uk](https://sparkboard.co.uk). That shared-host deployment is intentionally separate from the desktop Pulse server. The website is sourced from a pinned Pulse commit by the Sparkboard build, so changes in Pulse are published only after the pinned revision is updated and the Sparkboard workflow succeeds. There is no independent Fasthosts SFTP configuration or credentials in Pulse.

The shared website must use the known FTPS publishing destination: the Sparkboard hosting pipeline validates the remote root against the live HTTPS site, stages transfers safely, uploads the homepage last and verifies public assets. Do not replace the Sparkboard homepage or upload local databases and Python files.

## Scope

A public, download-oriented landing page is supported on standard Fasthosts Web Hosting. Running the live interactive Pulse backend publicly would require additional server infrastructure and authentication/security hardening.