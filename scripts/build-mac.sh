#!/bin/bash
# Build the Mac app, signed update archive and DMG with the in-checkout tooling from `setup-dev.sh --build`.
# The update signing key is read from Git metadata (see docs/APP-UPDATES.md); override with TAURI_SIGNING_PRIVATE_KEY.
set -euo pipefail
release_dir=${1:?'Pass a fresh release folder outside the checkout, e.g. ../pulse-2.1.7-release'}
root=$(cd "$(dirname "$0")/.." && pwd)
for required in .build/backend-venv/bin/python3 .build/search-runtime/manifest.json desktop/node_modules/.bin/tauri; do
  [ -e "$root/$required" ] || { echo "Missing $required. Run: bash scripts/setup-dev.sh --build" >&2; exit 1; }
done
key=${TAURI_SIGNING_PRIVATE_KEY:-"$(cd "$root" && cd "$(git rev-parse --git-common-dir)" && pwd)/pulse-update-signing/pulse.key"}
[ -f "$key" ] || { echo "Update signing key not found at $key" >&2; exit 1; }
PULSE_BACKEND_BUILD_PYTHON="$root/.build/backend-venv/bin/python3" \
PULSE_TAURI_CLI="$root/desktop/node_modules/.bin/tauri" \
TAURI_SIGNING_PRIVATE_KEY="$key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
  bash "$root/scripts/package-desktop.sh" "$release_dir" '' "$root/.build/search-runtime"
