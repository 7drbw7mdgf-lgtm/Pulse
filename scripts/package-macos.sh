#!/bin/bash
set -euo pipefail
template_app=${1:?Pass the path to the supplied Pulse.app template}
release_dir=${2:?Pass an output directory outside the source checkout}
source_root=$(cd "$(dirname "$0")/.." && pwd)

rm -rf "$release_dir/staging"
mkdir -p "$release_dir/staging"
app_path="$release_dir/staging/Pulse.app"

echo "==> Staging Pulse.app from template..."
ditto "$template_app" "$app_path"

echo "==> Cleaning redundant files from bundle..."
# 1. Remove redundant vendored python (PyMuPDF C headers, static libs, .so)
# Pulse uses built-in pure-Python safe Flate decompression for PDF parsing.
rm -rf "$app_path/Contents/Resources/python"

# 2. Remove any cached pyc files or compiler artifacts
find "$app_path" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$app_path" -name "*.pyc" -delete 2>/dev/null || true
find "$app_path" -name ".DS_Store" -delete 2>/dev/null || true

echo "==> Copying updated resources..."
for resource in app.js index.html style.css pulse_backend.py iratxe_backend.py pulse_performance.py graph-engine.js graph-worker.js favicon.png; do
  cp "$source_root/$resource" "$app_path/Contents/Resources/$resource"
done

rm -rf "$app_path/Contents/Resources/pulse_core" "$app_path/Contents/Resources/css" "$app_path/Contents/Resources/js"
cp -r "$source_root/pulse_core" "$app_path/Contents/Resources/pulse_core"
cp -r "$source_root/css" "$app_path/Contents/Resources/css"
cp -r "$source_root/js" "$app_path/Contents/Resources/js"

# Final cleanup in Resources
find "$app_path" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$app_path" -name "*.pyc" -delete 2>/dev/null || true
find "$app_path" -name ".DS_Store" -delete 2>/dev/null || true
find "$release_dir/staging" -name ".DS_Store" -delete 2>/dev/null || true

echo "==> Setting bundle version..."
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 1.3.0' "$app_path/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 1.3.0' "$app_path/Contents/Info.plist"

echo "==> Code signing..."
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"

echo "==> Staging installer extras..."
cp "$source_root/scripts/Allow-Pulse.command" "$release_dir/staging/Allow-Pulse.command"
cp "$source_root/docs/MACOS-INSTALL.md" "$release_dir/staging/MACOS-INSTALL.md"
ln -s /Applications "$release_dir/staging/Applications"

echo "==> Creating optimized compressed DMG..."
rm -f "$release_dir/Pulse-1.3.0.dmg"
hdiutil create -volname 'Pulse 1.3.0' -srcfolder "$release_dir/staging" -ov -format UDZO -imagekey zlib-level=9 "$release_dir/Pulse-1.3.0.dmg"
hdiutil verify "$release_dir/Pulse-1.3.0.dmg"
(cd "$release_dir" && shasum -a 256 "Pulse-1.3.0.dmg") > "$release_dir/Pulse-1.3.0-SHA256SUMS.txt"
echo "==> Build complete!"
