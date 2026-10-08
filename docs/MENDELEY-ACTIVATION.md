# Mendeley activation — Pulse 1.5.8

Pulse now includes a shared confidential sign-in service and an account-bound library sync implementation. Ordinary users will click **Connect Mendeley**, sign in or create an account in Mendeley's browser page, approve access and return to Pulse. A new device creates its own session; it does not need a new developer application.

**The shared service has not been registered or deployed.** The default build therefore offers citation export, with direct sign-in unavailable until the owner activates the service. No application ID, secret or live token is bundled. Developer settings are hidden unless an administrator explicitly enables them.

## Owner activation

Deploy the [included service](../auth-service/README.md) at an HTTPS domain, register that exact `/oauth/callback` redirect with Mendeley, and retain the application secret on the server. Set the deployed public HTTPS origin in `local-web/pulse-backend/pulse_core/mendeley-client.json`, then rebuild Pulse. The linked deployment guide includes Docker Compose, TLS, encrypted token storage, backups and live verification steps.

Mendeley's published [authorization-code instructions](https://dev.mendeley.com/reference/topics/authorization_auth_code.html) describe a confidential client with a secret; they do not establish enforced native/public-client PKCE support. The shared service uses that documented confidential flow. S256 proof binds a one-use desktop claim to the initiating device; it is a separate broker protection, not a claim about provider PKCE. The existing public-client route stays gated until independently verified. Implicit sign-in remains disabled.

## User behavior after activation

Automatic sync imports new and updated metadata while Pulse is open, when connected and every five minutes if enabled. **Sync now** imports on demand. Every available page is read before applying a result. Pulse retains local edits and tags, does not propagate Mendeley deletions, and remembers locally removed papers. Clearing pauses automatic sync; Undo and Recovery restore local content. Sending chosen citations remains a separate explicit action.

The service stores encrypted provider access/refresh tokens, with hashed per-device session identifiers. Pulse stores its opaque device session in protected local settings. The browser receives only the sign-in result. Callback state, browser cookies, device proof, expiry, one-use claims, fixed provider destinations and account isolation are tested. Revocation and refresh cannot re-create a disconnected server session.

## Verification status

The local tests use synthetic papers, simulated accounts and a mocked provider. They cover callback protections, replay, encryption, expiry, disconnect, refresh races, account separation, pagination, metadata fields, local edits, removal recovery and delayed-page cancellation. These tests do **not** establish live Mendeley activation. Before public activation, review current registration requirements and test sign-in, account creation, consent refusal, refresh, disconnect, multiple accounts and a new device against the real provider.

Reference: [OAuth Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).
