#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
build=$(mktemp -d "${TMPDIR:-/tmp}/pulse-setup-test.XXXXXX")
trap 'rm -rf "$build"' EXIT
swiftc -swift-version 5 -target "$(uname -m)-apple-macosx11.0" -module-cache-path "${TMPDIR:-/tmp}/pulse-setup-swift-modules" \
  "$root/installer/macos/SetupCore.swift" "$root/installer/macos/CoreTests.swift" -o "$build/tests" -framework CryptoKit
"$build/tests" "$@"
