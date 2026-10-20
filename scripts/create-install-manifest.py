#!/usr/bin/env python3
"""Generate the setup contract from real installers, never placeholder digests."""
import argparse
import hashlib
import json
import re
from pathlib import Path

MIN_VERSION = (2, 1, 1)
BUNDLED = ["python", "pdf", "ocr", "search-ranker"]


def create_manifest(paths):
    components = {}
    version = None
    for platform, path in paths.items():
        if not path:
            continue
        path = Path(path)
        suffix = r"\.dmg" if platform == "macos-arm64" else r"-Windows-x64-Setup\.exe"
        match = re.fullmatch(r"Pulse-(\d+\.\d+\.\d+)" + suffix, path.name)
        if not match or tuple(map(int, match[1].split("."))) < MIN_VERSION:
            raise ValueError(f"Not a compatible Pulse installer: {path.name}")
        if version and version != match[1]:
            raise ValueError("All installers must have the same version")
        version = match[1]
        size = path.stat().st_size
        if size < 1:
            raise ValueError("An installer is empty")
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(block)
        digest = hasher.hexdigest()
        components[platform] = {"file": path.name, "bytes": size, "sha256": digest}
    if not components:
        raise ValueError("Supply at least one actual installer")
    return {"schema": 1, "version": version, "bundled": BUNDLED, "components": components}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mac", type=Path)
    parser.add_argument("--windows", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = create_manifest({"macos-arm64": args.mac, "windows-x64": args.windows})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Created {args.output} for Pulse {manifest['version']}")


if __name__ == "__main__":
    main()
