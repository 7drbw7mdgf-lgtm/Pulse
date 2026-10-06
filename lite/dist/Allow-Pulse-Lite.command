#!/bin/bash
# Allow a trusted Pulse Lite 1.0.0 installation to open on this Mac.
# This does not notarize Pulse Lite or change system-wide security settings.
set -euo pipefail

expected_id='local.pulse.paper-linkage.lite'
expected_version='1.0.0'
check_only=false
confirmed=false
app_path=''

usage() {
  cat <<'HELP'
Usage: bash Allow-Pulse-Lite.command [--check | --yes] ["/Applications/Pulse Lite.app"]

  --check  Verify the app without changing anything.
  --yes    Explicitly approve removing quarantine without an interactive prompt.
  --help   Show this help.

Without a path, checks /Applications/Pulse Lite.app, then ~/Applications/Pulse Lite.app.
Only Pulse Lite 1.0.0 with a valid bundle signature is accepted. This script removes
only com.apple.quarantine from that app. It never uses sudo, disables Gatekeeper,
changes SIP, re-signs the app, downloads code or launches it automatically.
HELP
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --check) check_only=true ;;
    --yes) confirmed=true ;;
    --help|-h) usage; exit 0 ;;
    -*) fail "Unknown option: $arg" ;;
    *) [ -z "$app_path" ] || fail 'Pass just one Pulse Lite.app path.'; app_path="$arg" ;;
  esac
done

[ "$(/usr/bin/uname -s)" = 'Darwin' ] || fail 'This helper requires macOS.'
[ "$EUID" -ne 0 ] || fail 'Run as your normal user, without sudo.'
if [ -z "$app_path" ]; then
  if [ -d '/Applications/Pulse Lite.app' ]; then
    app_path='/Applications/Pulse Lite.app'
  else
    app_path="$HOME/Applications/Pulse Lite.app"
  fi
fi
while [ "$app_path" != '/' ] && [ "${app_path%/}" != "$app_path" ]; do
  app_path=${app_path%/}
done
[ -d "$app_path" ] || fail 'Install Pulse Lite.app in Applications first, or pass its path.'
[ ! -L "$app_path" ] || fail 'Pass the installed app itself, not a symbolic link.'
app_path=$(cd "$app_path" && /bin/pwd -P)
[ "${app_path##*/}" = 'Pulse Lite.app' ] || fail 'The target must be named Pulse Lite.app.'
plist="$app_path/Contents/Info.plist"
[ -f "$plist" ] || fail 'The target is not a macOS app bundle.'
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
[ "$bundle_id" = "$expected_id" ] || fail "Unexpected bundle identifier: $bundle_id"
[ "$version" = "$expected_version" ] || fail "Expected Pulse Lite $expected_version, found $version. Install this release first."
/usr/bin/codesign --verify --deep --strict "$app_path" || fail 'Signature verification failed. Download a fresh copy from the Pulse Lite GitHub release.'
printf 'Verified Pulse Lite %s\nApp: %s\n' "$version" "$app_path"
printf 'The ad hoc signature checks bundle integrity; it does not verify a developer identity or notarization.\n'
if "$check_only"; then
  printf 'Check complete. Nothing changed.\n'
  exit 0
fi
case "$app_path" in /Volumes/*) fail 'Copy Pulse Lite.app from the DMG into Applications before using this helper.' ;; esac

printf '\nThis removes the downloaded-app quarantine flag only from the app above.\n'
printf 'Use it only after downloading Pulse Lite from the official GitHub release and checking its SHA-256 checksum.\n'
if ! "$confirmed"; then
  [ -t 0 ] || fail 'Interactive approval requires Terminal. Use --check, or pass --yes to explicitly approve.'
  read -r -p 'Trust this Pulse Lite build and remove its quarantine flag? Type yes: ' answer
  [ "$answer" = 'yes' ] || { printf 'Cancelled. Nothing changed.\n'; exit 0; }
fi
# -s operates on symlinks themselves, avoiding targets outside the app bundle.
if ! /usr/bin/xattr -drs com.apple.quarantine "$app_path"; then
  fail 'Could not remove quarantine. Use System Settings > Privacy & Security > Open Anyway, or install a copy in your own ~/Applications folder.'
fi
printf '\nDone. Open Pulse Lite.app from Finder. Re-running this helper is harmless.\n'
printf 'Other apps and system-wide security settings were not changed.\n'
