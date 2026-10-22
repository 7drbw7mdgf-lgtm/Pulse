"""Portable single-file workspace backup (.pulse-workspace).

Packages SQLite databases, attached PDFs, screening projects and saved searches
into a self-contained archive with pre-restoration inspection and conflict reporting.
"""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
import zipfile

from pulse_core.constants import APP_VERSION, ClientError, time_iso
from pulse_core.platform_support import config_directory


def _config_dir(directory=None):
    return Path(directory or config_directory())


def export_workspace_archive(output_path=None, directory=None, include_pdfs=True):
    root = _config_dir(directory)
    lib_path = root / 'library.sqlite3'
    screening_path = root / 'screening.sqlite3'
    pdf_dir = root / 'pdfs'

    # Checkpoint WAL files to ensure clean SQLite snapshots
    for db_path in (lib_path, screening_path):
        if db_path.exists():
            try:
                with sqlite3.connect(db_path, timeout=5) as conn:
                    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass

    # Collect metadata for manifest
    paper_count = 0
    tags = set()
    saved_searches = []
    if lib_path.exists():
        try:
            with sqlite3.connect(lib_path, timeout=5) as conn:
                paper_count = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
                tags = {row[0] for row in conn.execute("SELECT DISTINCT tag FROM paper_tags")}
                searches_row = conn.execute("SELECT value FROM workspace WHERE key='savedSearches'").fetchone()
                if searches_row:
                    saved_searches = json.loads(searches_row[0])
        except Exception:
            pass

    screening_count = 0
    if screening_path.exists():
        try:
            with sqlite3.connect(screening_path, timeout=5) as conn:
                screening_count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        except Exception:
            pass

    pdf_files = list(pdf_dir.glob("*")) if (include_pdfs and pdf_dir.exists()) else []

    manifest = {
        "format": "pulse-workspace",
        "version": 1,
        "appVersion": APP_VERSION,
        "createdAt": time_iso(),
        "paperCount": paper_count,
        "pdfCount": len(pdf_files),
        "screeningProjectCount": screening_count,
        "savedSearchCount": len(saved_searches),
        "tags": sorted(list(tags))[:100],
    }

    if output_path is None:
        target = root / f"Pulse-Workspace-{time.strftime('%Y%m%d-%H%M%S')}.pulse-workspace"
    else:
        target = Path(output_path)

    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        if lib_path.exists():
            zf.write(lib_path, "library.sqlite3")
        if screening_path.exists():
            zf.write(screening_path, "screening.sqlite3")
        if saved_searches:
            zf.writestr("savedSearches.json", json.dumps(saved_searches, indent=2))
        if include_pdfs:
            for pdf_file in pdf_files:
                if pdf_file.is_file():
                    zf.write(pdf_file, f"pdfs/{pdf_file.name}")

    return target


def inspect_workspace_archive(archive_path):
    path = Path(archive_path)
    if not path.exists():
        raise ClientError(404, "Workspace archive file was not found.")

    try:
        with zipfile.ZipFile(path, "r") as zf:
            namelist = set(zf.namelist())
            if "manifest.json" not in namelist:
                raise ClientError(400, "Invalid archive: manifest.json is missing.")
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            if manifest.get("format") != "pulse-workspace":
                raise ClientError(400, "File is not a valid Pulse workspace archive.")

            pdf_entries = [name for name in namelist if name.startswith("pdfs/") and len(name) > 5]
            manifest["archivePdfCount"] = len(pdf_entries)
            manifest["hasLibrary"] = "library.sqlite3" in namelist
            manifest["hasScreening"] = "screening.sqlite3" in namelist
            manifest["fileSizeBytes"] = path.stat().st_size
            return manifest
    except zipfile.BadZipFile:
        raise ClientError(400, "The archive file is corrupted or not a valid zip archive.")


def restore_workspace_archive(archive_path, directory=None, mode="replace"):
    manifest = inspect_workspace_archive(archive_path)
    root = _config_dir(directory)
    root.mkdir(parents=True, exist_ok=True)

    backup_dir = root / "backups" / f"pre_restore_{time.strftime('%Y%m%d_%H%M%S')}"
    backup_dir.mkdir(parents=True, exist_ok=True)

    # Safety checkpoint: backup current databases
    for fname in ("library.sqlite3", "library.sqlite3-wal", "screening.sqlite3", "screening.sqlite3-wal"):
        src = root / fname
        if src.exists():
            shutil.copy2(src, backup_dir / fname)

    restored = {"papers": 0, "pdfs": 0, "screening": 0}
    with zipfile.ZipFile(archive_path, "r") as zf:
        namelist = set(zf.namelist())

        if mode == "replace":
            if "library.sqlite3" in namelist:
                target = root / "library.sqlite3"
                for wal_ext in ("-wal", "-shm"):
                    Path(str(target) + wal_ext).unlink(missing_ok=True)
                with open(target, "wb") as f:
                    f.write(zf.read("library.sqlite3"))
                restored["papers"] = manifest.get("paperCount", 0)

            if "screening.sqlite3" in namelist:
                target = root / "screening.sqlite3"
                for wal_ext in ("-wal", "-shm"):
                    Path(str(target) + wal_ext).unlink(missing_ok=True)
                with open(target, "wb") as f:
                    f.write(zf.read("screening.sqlite3"))
                restored["screening"] = manifest.get("screeningProjectCount", 0)

            # Restore PDFs
            pdf_dir = root / "pdfs"
            pdf_dir.mkdir(parents=True, exist_ok=True)
            for name in namelist:
                if name.startswith("pdfs/") and len(name) > 5:
                    basename = Path(name).name
                    dest = pdf_dir / basename
                    with open(dest, "wb") as f:
                        f.write(zf.read(name))
                    restored["pdfs"] += 1
        elif mode == "merge":
            # Merge library papers
            if "library.sqlite3" in namelist:
                with tempfile.NamedTemporaryFile(suffix=".sqlite3") as tmp_lib:
                    tmp_lib.write(zf.read("library.sqlite3"))
                    tmp_lib.flush()
                    with sqlite3.connect(tmp_lib.name) as incoming_conn:
                        incoming_papers = [
                            json.loads(row[0])
                            for row in incoming_conn.execute("SELECT data FROM papers").fetchall()
                        ]
                    from pulse_core.storage import library_store
                    store = library_store()
                    current = store.read(include_content=True)
                    existing_by_id = {p["id"]: p for p in current.get("papers", [])}
                    merged_count = 0
                    for p in incoming_papers:
                        pid = p["id"]
                        if pid not in existing_by_id:
                            existing_by_id[pid] = p
                            merged_count += 1
                    current["papers"] = list(existing_by_id.values())
                    store.write(current)
                    restored["papers"] = merged_count

            # Merge PDFs
            pdf_dir = root / "pdfs"
            pdf_dir.mkdir(parents=True, exist_ok=True)
            for name in namelist:
                if name.startswith("pdfs/") and len(name) > 5:
                    basename = Path(name).name
                    dest = pdf_dir / basename
                    if not dest.exists():
                        with open(dest, "wb") as f:
                            f.write(zf.read(name))
                        restored["pdfs"] += 1

    return {
        "ok": True,
        "mode": mode,
        "restored": restored,
        "backupPath": str(backup_dir),
    }
