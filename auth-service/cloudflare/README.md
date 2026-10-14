# Free Mendeley sign-in for every Pulse user (Cloudflare Workers)

This lets anyone who installs Pulse on any Mac click **Connect Mendeley**, sign in, and sync, without registering a developer application or typing a secret.

## How it works

Mendeley only issues tokens to an application that proves its secret, and a secret cannot be shipped inside a public app. This small service holds that one secret and does nothing else:

1. Pulse asks the service to start a sign-in, sending a one-time PKCE challenge and the local port it is listening on.
2. The user signs in on Mendeley's page. Mendeley sends the browser to the service, which forwards it straight back to Pulse on that computer (`http://127.0.0.1:<port>/mendeley/callback`).
3. Pulse sends the code and its PKCE verifier to the service. The service checks the verifier, adds the application secret, gets the tokens from Mendeley and returns them.
4. Pulse stores the tokens encrypted on that computer and calls Mendeley directly from then on. Refreshing a token goes through the service, which adds the secret.

The service stores nothing: no database, no user tokens, no logs of codes. Sign-in state travels in an HMAC-signed value that expires after ten minutes. It runs on Cloudflare's free Workers plan (100,000 requests a day; Pulse uses a few per sign-in and one per hour of use), needs no card, and is always on.

## One-time setup (about 10 minutes)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. In a terminal, from the repository: `bash auth-service/cloudflare/setup.sh`. It signs you in to Cloudflare, deploys the service and prints its address, for example `https://pulse-mendeley.<you>.workers.dev`.
3. When the script prints the redirect URL, register a new application at https://dev.mendeley.com/myapps.html with exactly that redirect URL (`…workers.dev/callback`). Use a new application so your existing one keeps working.
4. Paste the application ID and secret when the script asks. The script also generates the signing key. Everything goes only to Cloudflare as encrypted Worker secrets.
5. The script checks `https://…workers.dev/health` and prints the address to put in `local-web/pulse-backend/pulse_core/mendeley-client.json` as `"exchangeUrl"`. Rebuild Pulse.

Your own application settings (Settings → Mendeley & Zotero) still take priority on a Mac where you entered them.

## Tests

`node --test auth-service/cloudflare/test/worker.test.mjs` tests the service with Mendeley faked. `local-web/tests/test_mendeley_exchange.py` runs the real service code (in Node) together with Pulse's sign-in, callback, token storage and refresh.

The older Docker service in `auth-service/` (which stores tokens on the server) remains available but is not needed.
