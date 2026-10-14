#!/usr/bin/env bash
# Store (or rotate) the Mendeley application ID and secret in the Cloudflare sign-in service.
# Input is hidden and goes only to Cloudflare. Run: bash auth-service/cloudflare/set-mendeley-secrets.sh
set -euo pipefail
cd "$(dirname "$0")"
export WRANGLER_SEND_METRICS=false
WRANGLER=(npx --yes wrangler@4.20.0)
# Usage: set-mendeley-secrets.sh [APPLICATION_ID]   (the ID is a number, e.g. 26261; it is not secret)
client_id=${1:-}
[ -n "$client_id" ] || read -r -p "Mendeley application ID (a number): " client_id
[[ "$client_id" =~ ^[0-9]+$ ]] || { echo "The application ID is the number shown for your app at dev.mendeley.com, not the secret." >&2; exit 1; }
read -r -s -p "Mendeley application secret (hidden): " client_secret; echo
[ -n "$client_secret" ] || { echo "The secret is needed." >&2; exit 1; }
printf '%s' "$client_id" | "${WRANGLER[@]}" secret put MENDELEY_CLIENT_ID >/dev/null
printf '%s' "$client_secret" | "${WRANGLER[@]}" secret put MENDELEY_CLIENT_SECRET >/dev/null
unset client_secret
sleep 5
curl -fsS https://pulse-mendeley.7drbw7mdgf.workers.dev/health | grep -q '"ok":true' && echo "Ready: the sign-in service is configured." || echo "Saved. The service may take a minute to report ready."
