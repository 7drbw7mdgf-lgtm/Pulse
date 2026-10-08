# Shared Mendeley sign-in for Pulse

This service lets every Pulse user sign in with their own Mendeley account without entering developer settings. One Pulse-owned registered application serves all users and devices. Each device gets its own revocable session. This is a deployable implementation, **not a live activated service** until the steps below are completed.

## One-time owner activation

1. Choose an HTTPS domain and server with Docker Compose. Point the domain's DNS to the server and open ports 80 and 443. Keep the broker's port 8000 private; the included proxy is its only public entry point.
2. Register a Pulse application at the [Mendeley Developer Portal](https://dev.mendeley.com/myapps.html). Register the exact redirect `https://YOUR_DOMAIN/oauth/callback`. Confirm permitted use, application approval and current provider requirements before public activation.
3. Copy `.env.example` to `.env` on the server, enter the registered ID and secret, and generate a Fernet key. Protect `.env` with mode 600. Keep an encrypted backup of the token key separately from the encrypted database.
4. Run `docker compose up -d --build` in this directory. Verify `https://YOUR_DOMAIN/health` returns `ok: true` and protocol 1. Caddy provides TLS automatically. Its default configuration does not log callback URLs.
5. Set `brokerUrl` in `local-web/pulse-backend/pulse_core/mendeley-client.json` to `https://YOUR_DOMAIN`, leaving client ID and secret out of the desktop package. Rebuild Pulse.
6. Check the full sign-in, account creation, declined consent, expired code, refresh, disconnect, two-account isolation, pagination and a second device using test accounts. The automated tests use a fake provider; a real provider review is still required before public release.

Users then click **Connect Mendeley**, sign in or create an Elsevier account in the provider's browser page, approve access and return to Pulse. There is no developer registration step for ordinary users. Administrator-only custom application settings are available by launching with `PULSE_MENDELEY_ADMIN=1`.

## Authentication and storage

The broker uses Mendeley's documented [confidential authorization-code flow](https://dev.mendeley.com/reference/topics/authorization_auth_code.html): the secret and provider tokens stay on the server. S256 proof protects the desktop's one-use claim of the resulting session. That proof is between Pulse and this broker; it does **not** assert undocumented Mendeley PKCE support. A native public-client flow remains disabled unless separately verified with the provider.

OAuth state and a Secure, HttpOnly, SameSite browser cookie bind the callback to its initiating browser. Claims expire after ten minutes and cannot be replayed. Provider tokens are encrypted in SQLite; only hashed opaque session identifiers are stored. Idle sessions expire after 30 days, with a 90-day maximum. Disconnect removes the server session. If the server is unreachable during disconnect, Pulse clears local credentials and tells the user to revoke access in Mendeley for immediate server revocation.

The service exposes a fixed allowlist for reading a personal library/profile and explicitly sending bibliographic records. It does not accept arbitrary proxy destinations, PDF uploads, full paper text, remote deletion or cross-origin browser calls. Requests have size, concurrency and rate bounds. All replicas must share the same transactional store; the included deployment uses one broker instance. Do not copy the SQLite database live without a consistent SQLite backup. Keep secrets out of image layers, logs, public repositories and the Mac bundle.

## Library behavior

Sync imports new and changed bibliographic records while Pulse is open, on connection and every five minutes when enabled. It reads all available pages before applying a result; a failed page does not apply a partial library. Matching uses an account-bound document ID, then DOI or normalized title. Pulse preserves local edits and tags. Remote deletion never deletes a local paper. Locally removed papers stay out of automatic imports; clearing pauses automatic sync. Undo and Recovery can restore them. **Sync now** is also available.

Sending citations to Mendeley or Zotero remains an explicit action on the chosen papers. Metadata lookup runs on import and before export, with DOI first and conservative bibliographic search if no DOI is available. Unavailable source fields remain empty. No guarantee is made that every publication registry contains every bibliographic field.

## Tests

Install `requirements.txt` into an isolated environment, then run `python -m unittest discover -s auth-service/tests -v` from the repository root. Run the desktop workspace tests separately using `npm run test:workspace`.
