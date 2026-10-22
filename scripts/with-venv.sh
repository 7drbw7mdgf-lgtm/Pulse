#!/bin/bash
# Run a command with this checkout's .venv first on PATH, when it exists (CI installs into its own Python).
root=$(cd "$(dirname "$0")/.." && pwd)
if [ -x "$root/.venv/bin/python3" ]; then
  export PATH="$root/.venv/bin:$PATH"
  export PULSE_TEST_PYTHON="${PULSE_TEST_PYTHON:-$root/.venv/bin/python3}"
fi
exec "$@"
