#!/bin/bash
# Start the Pulse workspace for development with its own library, never the installed app's.
# Set PULSE_CONFIG_DIR to use another profile, and PULSE_PORT (or a launcher's PORT) for another port.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
export PULSE_CONFIG_DIR="${PULSE_CONFIG_DIR:-$root/.dev-profile}"
export PULSE_PORT="${PULSE_PORT:-${PORT:-8790}}"
export PULSE_DISABLE_BUNDLED_OLLAMA="${PULSE_DISABLE_BUNDLED_OLLAMA:-1}"
mkdir -p "$PULSE_CONFIG_DIR"
cd "$root"
exec bash scripts/with-venv.sh python3 -B local-web/pulse-backend/pulse_backend.py
