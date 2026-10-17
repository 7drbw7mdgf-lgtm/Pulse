# Mendeley registration and owner repair

Pulse ships the public address of its shared token-exchange service, `https://pulse-mendeley.7drbw7mdgf.workers.dev`. Mendeley application **26261** is registered with the exact callback URL `https://pulse-mendeley.7drbw7mdgf.workers.dev/callback`. No application secret or personal account token is bundled in the installer.

## Current status

The service is deployed and starts browser sign-in. Mendeley currently rejects the service’s application credentials with HTTP 401 during token exchange. A successful `/health` response confirms configuration presence; it does not validate the application credentials. Installing a new Pulse build or repeating browser login cannot replace the rejected server credential.

## Owner repair

Only the owner of both the Mendeley application and the existing Cloudflare Worker should perform these steps:

1. Open [Mendeley My Apps](https://dev.mendeley.com/myapps.html) and expand application **26261**. Check the callback URL above. If the current secret is unavailable or invalid, generate a new secret and save the application changes yourself.
2. Run `python3 auth-service/cloudflare/repair-registration.py` interactively. It prompts for the secret without displaying it. Keep the secret out of chat, command arguments and repository files.
3. The helper verifies application authentication directly with Mendeley before replacing the existing Worker’s `MENDELEY_CLIENT_ID` and `MENDELEY_CLIENT_SECRET`. It leaves `STATE_KEY` in place and checks the public service with a fresh synthetic request.
4. Once the helper reports verified application authentication, complete a real sign-in in Pulse and choose **Sync now**. On a Mac with old custom developer settings, choose **Use Pulse sign-in** first.

The synthetic check verifies the application credentials. A real account login, library sync and token refresh still need to succeed before shared sign-in can be described as working.

## How this connection works

The [Cloudflare service](../auth-service/cloudflare/README.md) adds the confidential application secret when exchanging or refreshing tokens. Signed, expiring state and a per-attempt verifier bind the desktop request to its callback. The service stores no token database. Tokens return to the initiating Mac, remain encrypted in that Mac’s settings, and library requests go directly to Mendeley. The older Docker broker in `auth-service/` is a separate deployment option.

Sync preserves local edits, notes and tags. Sending selected citations is a separate explicit action. RIS export remains available while direct sign-in is unavailable.

Mendeley’s [authorization-code documentation](https://dev.mendeley.com/reference/topics/authorization_auth_code.html) describes the application credentials and token-exchange errors. Automated provider tests use simulated responses and do not prove that the live registration works.
