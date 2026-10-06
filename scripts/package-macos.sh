#!/bin/bash
set -euo pipefail
template_app=${1:?Pass the path to the supplied Pulse.app template}
release_dir=${2:?Pass an output directory outside the source checkout}
source_root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$release_dir/staging"
app_path="$release_dir/staging/Pulse.app"
if [ -e "$app_path" ]; then
  echo "Build destination already exists: $app_path" >&2
  exit 1
fi
ditto "$template_app" "$app_path"
for resource in app.js index.html style.css pulse_backend.py iratxe_backend.py pulse_performance.py graph-engine.js graph-worker.js favicon.png; do
  cp "$source_root/$resource" "$app_path/Contents/Resources/$resource"
done
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 1.3.0' "$app_path/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 1.3.0' "$app_path/Contents/Info.plist"
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"
cp "$source_root/scripts/Allow-Pulse.command" "$release_dir/staging/Allow-Pulse.command"
cp "$source_root/docs/MACOS-INSTALL.md" "$release_dir/staging/MACOS-INSTALL.md"
ln -s /Applications "$release_dir/staging/Applications"
hdiutil create -volname 'Pulse 1.3.0' -srcfolder "$release_dir/staging" -ov -format UDZO "$release_dir/Pulse-1.3.0.dmg"
hdiutil verify "$release_dir/Pulse-1.3.0.dmg"
(cd "$release_dir" && shasum -a 256 "Pulse-1.3.0.dmg") > "$release_dir/Pulse-1.3.0-SHA256SUMS.txt"
