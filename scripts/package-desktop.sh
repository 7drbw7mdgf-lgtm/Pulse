#!/bin/bash
# Build the Tauri app and a verified installer from canonical source.
set -euo pipefail
release_dir=${1:?Pass a fresh release directory outside the checkout}
python_dependencies=${2:-}
source_root=$(cd "$(dirname "$0")/.." && pwd)
version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$source_root/package.json")
[ ! -e "$release_dir/staging" ] || { echo 'Use a fresh release directory.' >&2; exit 1; }
mkdir -p "$release_dir"
release_dir=$(cd "$release_dir" && pwd)
if [ -n "$python_dependencies" ]; then
  python3 "$source_root/scripts/stage-desktop.py" --python-dependencies "$python_dependencies"
else
  python3 "$source_root/scripts/stage-desktop.py"
fi
build_args=(build --ci --bundles app -- --locked)
if [ "${PULSE_BUILD_OFFLINE:-0}" = 1 ]; then build_args+=(--offline); fi
cd "$source_root/desktop"
if [ -n "${PULSE_TAURI_CLI:-}" ]; then
  "$PULSE_TAURI_CLI" "${build_args[@]}"
else
  npm ci
  npm run tauri -- "${build_args[@]}"
fi
target_dir=${CARGO_TARGET_DIR:-"$source_root/desktop/src-tauri/target"}
app_path="$target_dir/release/bundle/macos/Pulse.app"
codesign --verify --deep --strict "$app_path"
mkdir -p "$release_dir/staging"
ditto "$app_path" "$release_dir/staging/Pulse.app"
cp "$source_root/scripts/Allow-Pulse-Tauri.command" "$release_dir/staging/Allow-Pulse-Tauri.command"
cp "$source_root/docs/MACOS-INSTALL.md" "$release_dir/staging/MACOS-INSTALL.md"
ln -s /Applications "$release_dir/staging/Applications"
image="Pulse-$version.dmg"
hdiutil create -volname "Pulse $version" -srcfolder "$release_dir/staging" -format UDZO -imagekey zlib-level=9 "$release_dir/$image"
hdiutil verify "$release_dir/$image"
(cd "$release_dir" && shasum -a 256 "$image") > "$release_dir/Pulse-$version-SHA256SUMS.txt"
printf 'Built %s\n' "$release_dir/$image"
