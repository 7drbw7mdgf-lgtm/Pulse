#!/usr/bin/env python3
"""Create Tauri's GitHub latest.json from signed artifacts for the same app version."""
import argparse
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import re

REPO = "7drbw7mdgf-lgtm/Pulse"


def create_manifest(paths, notes=""):
    platforms = {}
    version = None
    for target, path in paths.items():
        if path is None:
            continue
        path = Path(path)
        suffix = "macOS-arm64.app.tar.gz" if target == "darwin-aarch64" else "Windows-x64-Setup.exe"
        match = re.fullmatch(r"Pulse-(\d+\.\d+\.\d+)-" + re.escape(suffix), path.name)
        if not match or (version and version != match[1]):
            raise ValueError("Update assets must have matching versions and canonical release names")
        version = match[1]
        if not path.is_file() or not 0 < path.stat().st_size <= 1024 ** 3:
            raise ValueError("Update package missing, empty or larger than 1 GiB")
        signature = Path(str(path) + ".sig").read_text().strip()
        decoded = base64.b64decode(signature, validate=True).decode("utf-8")
        trusted = next((line for line in decoded.splitlines() if line.startswith("trusted comment:")), "")
        if not re.search(r"(?:\t| )version:" + re.escape(version) + r"(?:\s|$)", trusted):
            raise ValueError("The update signature must be bound to the release version")
        platforms[target] = {"signature": signature,
            "url": f"https://github.com/{REPO}/releases/download/v{version}/{path.name}"}
    if not platforms:
        raise ValueError("Supply at least one signed update package")
    return {"version": version, "notes": notes,
        "pub_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "platforms": platforms}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mac", type=Path)
    parser.add_argument("--windows", type=Path)
    parser.add_argument("--notes", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = create_manifest({"darwin-aarch64": args.mac, "windows-x86_64": args.windows}, args.notes.read_text() if args.notes else "")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Created {args.output.name}: Pulse {manifest['version']}, {len(manifest['platforms'])} platforms")


if __name__ == "__main__":
    main()
