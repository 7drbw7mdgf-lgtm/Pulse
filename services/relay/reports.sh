#!/usr/bin/env bash
# List problem reports users chose to send (newest first). Usage: bash services/relay/reports.sh [count]
set -euo pipefail
cd "$(dirname "$0")"
export WRANGLER_SEND_METRICS=false
count=${1:-20}
[[ "$count" =~ ^[0-9]+$ ]] || { echo "Count must be a number." >&2; exit 1; }
npx --yes wrangler@4.20.0 d1 execute pulse-relay --remote --json \
  --command "SELECT datetime(created/1000,'unixepoch') AS sent, version, kind, body FROM reports ORDER BY created DESC LIMIT $count" \
  | python3 print_reports.py
