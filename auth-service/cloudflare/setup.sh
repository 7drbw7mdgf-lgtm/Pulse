#!/usr/bin/env bash
# One-time setup of Pulse's free Mendeley sign-in service on Cloudflare Workers.
# Run from anywhere: bash auth-service/cloudflare/setup.sh
# You need: a free Cloudflare account, and Node.js (for npx). Secrets are typed here and sent
# only to Cloudflare; nothing is written to disk or to this repository.
set -euo pipefail
cd "$(dirname "$0")"
WRANGLER=(npx --yes wrangler@4.20.0)
export WRANGLER_SEND_METRICS=false

echo "1/4  Signing in to Cloudflare (a browser window opens)…"
# `wrangler whoami` exits 0 even when signed out, so check what it says.
if ! "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in"; then
  "${WRANGLER[@]}" login
  "${WRANGLER[@]}" whoami 2>&1 | grep -q "You are logged in" || { echo "Cloudflare sign-in did not complete." >&2; exit 1; }
fi

echo "2/4  Deploying the sign-in service…"
deploy_log=$("${WRANGLER[@]}" deploy 2>&1 | tee /dev/stderr)
url=$(printf '%s\n' "$deploy_log" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$url" ] || { echo "Could not find the service address in the deploy output." >&2; exit 1; }
echo
echo "     Service address: $url"
echo "     Register a Mendeley application at https://dev.mendeley.com/myapps.html"
echo "     with this exact redirect URL:  $url/callback"
echo

echo "3/4  Storing secrets in Cloudflare (input is hidden)…"
read -r -p "     Mendeley application ID: " client_id
read -r -s -p "     Mendeley application secret: " client_secret; echo
[ -n "$client_id" ] && [ -n "$client_secret" ] || { echo "Both values are needed." >&2; exit 1; }
printf '%s' "$client_id" | "${WRANGLER[@]}" secret put MENDELEY_CLIENT_ID >/dev/null
printf '%s' "$client_secret" | "${WRANGLER[@]}" secret put MENDELEY_CLIENT_SECRET >/dev/null
openssl rand -base64 48 | tr -d '\n' | "${WRANGLER[@]}" secret put STATE_KEY >/dev/null
unset client_secret

echo "4/4  Checking the service…"
sleep 5
if curl -fsS "$url/health" | grep -q '"ok":true'; then
  echo "     Ready. Put this in local-web/pulse-backend/pulse_core/mendeley-client.json as \"exchangeUrl\":"
  echo "     $url"
else
  echo "     The service did not report ready yet. Open $url/health in a minute; it should show \"ok\":true." >&2
  exit 1
fi
