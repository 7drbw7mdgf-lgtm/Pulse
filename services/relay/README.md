# Pulse relay (sync and problem reports)

A Cloudflare Worker with a D1 database, on Cloudflare's free plan, at `https://pulse-relay.7drbw7mdgf.workers.dev`.

## Sync
Each Mac encrypts its library records with keys derived (HKDF) from the user's sync code: 32 random bytes shown as a 52-character code. Encryption uses AES-GCM in the app window. The relay stores:
- a random vault ID;
- a SHA-256 hash of an access token;
- record IDs that are keyed hashes (HMAC);
- ciphertext.

It cannot read titles, notes or tags, and keeps only the newest version of each record (limit 200 MB per vault). **Turn off and erase the cloud copy** deletes the vault.

## Problem reports
Reports are redacted on the Mac and sent only when the user chooses **Send** after viewing them. They are size-limited (64 KB) and rate-limited (20 per hour per network; the address itself is never stored, only a hash of it combined with the hour). To read them, run `bash services/relay/reports.sh`.

## Deploy or change
```
cd services/relay
npx wrangler@4.20.0 d1 execute pulse-relay --remote --file=schema.sql   # once
npx wrangler@4.20.0 deploy
```
The app reads the relay address from `local-web/pulse-backend/pulse_core/relay-client.json`.

## Tests
`node --test services/relay/test/relay.test.mjs` runs the Worker with D1 replaced by Node's built-in SQLite. `node --test local-web/tests/library_sync.test.mjs` syncs two simulated Macs through the same code.
