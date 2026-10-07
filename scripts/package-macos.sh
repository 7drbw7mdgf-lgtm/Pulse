#!/bin/bash
# Compatibility name for the current Tauri packager.
set -euo pipefail
template_app=${1:?Pass the path to the supplied Pulse.app template}
release_dir=${2:?Pass a fresh release directory}
exec bash "$(dirname "$0")/package-desktop.sh" "$release_dir" "$template_app/Contents/Resources"
