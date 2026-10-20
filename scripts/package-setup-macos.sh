#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?Pass an output folder}
mkdir -p "$out"
out=$(cd "$out" && pwd)
app="$out/Pulse Setup.app"
[ ! -e "$app" ] || { echo 'Use a fresh output folder.' >&2; exit 1; }
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -swift-version 5 -target arm64-apple-macosx11.0 -module-cache-path "${TMPDIR:-/tmp}/pulse-setup-swift-modules" \
  "$root/installer/macos/SetupCore.swift" "$root/installer/macos/SetupApp.swift" \
  -o "$app/Contents/MacOS/PulseSetup" -framework AppKit -framework CryptoKit
cp "$root/desktop/src-tauri/icons/icon.icns" "$app/Contents/Resources/icon.icns"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.pulse.setup</string>
<key>CFBundleName</key><string>Pulse Setup</string>
<key>CFBundleDisplayName</key><string>Pulse Setup</string>
<key>CFBundleExecutable</key><string>PulseSetup</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
identity=${APPLE_SIGNING_IDENTITY:--}
args=(--force --sign "$identity")
if [ "$identity" != '-' ]; then args+=(--options runtime --timestamp); fi
codesign "${args[@]}" "$app"
codesign --verify --deep --strict "$app"
archive="$out/Pulse-Setup-Mac-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
if [ -n "${PULSE_NOTARY_PROFILE:-}" ]; then
  [ "$identity" != '-' ] || { echo 'Notarization requires a Developer ID identity.' >&2; exit 1; }
  xcrun notarytool submit "$archive" --keychain-profile "$PULSE_NOTARY_PROFILE" --wait
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  rm "$archive"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
fi
(cd "$out" && shasum -a 256 Pulse-Setup-Mac-arm64.zip) > "$out/Pulse-Setup-Mac-arm64-SHA256SUMS.txt"
printf 'Built %s\n' "$archive"
