#!/bin/bash
# One-command development setup, kept inside this checkout (all outputs are ignored by Git):
#   .venv/                 Python with the backend's runtime dependencies, used by npm scripts
#   node_modules/          Playwright for the browser test suites, plus its Chromium build
# With --build it also prepares Mac release tooling:
#   desktop/node_modules/  Tauri CLI
#   .build/python/         Pinned macOS 11+ CPython 3.11 (python-build-standalone), checksum-verified
#   .build/backend-venv/   PyInstaller and PDF dependencies for freezing the backend
#   .build/search-runtime/ Offline search ranker bundled into release apps
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
build=0
for argument in "$@"; do
  case "$argument" in
    --build) build=1 ;;
    *) echo 'Usage: scripts/setup-dev.sh [--build]' >&2; exit 2 ;;
  esac
done

python=''
for candidate in python3.12 python3.13 python3.11 python3.14 python3.10 python3; do
  if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
    python=$(command -v "$candidate"); break
  fi
done
[ -n "$python" ] || { echo 'Install Python 3.10 or newer first.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Install Node.js (with npm) first.' >&2; exit 1; }

if ! .venv/bin/python3 -c 'import sys' 2>/dev/null; then
  echo "Creating .venv with $python"
  rm -rf .venv
  "$python" -m venv .venv
fi
.venv/bin/python3 -m pip install --quiet --disable-pip-version-check -r local-web/requirements.txt
npm ci --no-audit --no-fund
npx playwright install chromium

if [ "$build" = 1 ]; then
  [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || { echo 'Mac release tooling targets Apple Silicon macOS.' >&2; exit 1; }
  (cd desktop && npm ci --no-audit --no-fund)
  # Matches the interpreter used for 2.1.x releases; macOS 11 deployment target.
  release=20261009
  archive="cpython-3.11.17+$release-aarch64-apple-darwin-install_only_stripped.tar.gz"
  digest=f58d38af4680fbf9f89c329e732b7cca1bd06ff7a93884798b27d541bee138f6
  mkdir -p .build
  if [ ! -x .build/python/bin/python3.11 ]; then
    curl -fsSL -o ".build/$archive" "https://github.com/astral-sh/python-build-standalone/releases/download/$release/${archive//+/%2B}"
    echo "$digest  .build/$archive" | shasum -a 256 -c -
    rm -rf .build/python && tar -xzf ".build/$archive" -C .build && rm ".build/$archive"
  fi
  [ -x .build/backend-venv/bin/python3 ] || .build/python/bin/python3.11 -m venv .build/backend-venv
  .build/backend-venv/bin/python3 -m pip install --quiet --disable-pip-version-check -r scripts/requirements-macos-build.txt
  if [ ! -f .build/search-runtime/manifest.json ]; then
    [ -x .build/runtime-venv/bin/python3 ] || .build/python/bin/python3.11 -m venv .build/runtime-venv
    .build/runtime-venv/bin/python3 -m pip install --quiet --disable-pip-version-check -r scripts/requirements-search-runtime.txt
    rm -rf .build/search-runtime
    .build/runtime-venv/bin/python3 scripts/build-search-runtime.py --output .build/search-runtime
  fi
fi

echo
echo 'Pulse development setup is ready.'
echo '  npm test          run the full regression suite'
echo '  npm run dev       start Pulse with a separate development library (.dev-profile)'
[ "$build" = 1 ] && echo '  npm run build:mac -- <release folder>   build the Mac app, update archive and DMG'
exit 0
