"""Portable single-file workspace backup (.pulse-workspace).

Packages SQLite databases, attached PDFs, screening projects and saved searches
into a self-contained archive with pre-restoration inspection and conflict reporting.
"""
import contextlib
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
from pulse_performance import LIBRARY_WRITE_LOCK

SQLITE_MAGIC = b"SQLite format 3\x00"
PDF_MAGIC = b"%PDF-"
MAX_MANIFEST_BYTES = 1 * 1024 * 1024
MAX_SQLITE_BYTES = 256 * 1024 * 1024
MAX_PDF_ENTRY_BYTES = 50 * 1024 * 1024
MAX_ARCHIVE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
_STREAM_CHUNK_BYTES = 64 * 1024


def _config_dir(directory=None):
    return Path(directory or config_directory())


def _validate_archive_path(archive_path):
    if not archive_path or not isinstance(archive_path, (str, os.PathLike)):
        raise ClientError(400, "Workspace archive path is required.")
    path = Path(archive_path)
    if not path.exists() or not path.is_file():
        raise ClientError(404, "Workspace archive file was not found.")
    return path


def _read_bounded_bytes(zf, name, max_bytes):
    info = zf.getinfo(name)
    if info.file_size < 0 or info.file_size > max_bytes:
        raise ClientError(413, f"Archive entry '{name}' exceeds maximum allowed size ({max_bytes} bytes).")
    chunks = []
    total = 0
    with zf.open(info, "r") as stream:
        while True:
            chunk = stream.read(_STREAM_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ClientError(413, f"Archive entry '{name}' exceeds maximum allowed size ({max_bytes} bytes).")
            chunks.append(chunk)
    return b"".join(chunks)


def _extract_bounded_file(zf, name, dest_path, max_bytes, required_magic=None, verify_sqlite=False):
    info = zf.getinfo(name)
    if info.file_size < 0 or info.file_size > max_bytes:
        raise ClientError(413, f"Archive entry '{name}' exceeds maximum allowed size ({max_bytes} bytes).")
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{dest_path.name}.", suffix=".tmp", dir=str(dest_path.parent))
    tmp_path = Path(tmp_name)
    try:
        total = 0
        header_checked = required_magic is None
        header_buf = b""
        with os.fdopen(fd, "wb") as out_file, zf.open(info, "r") as stream:
            while True:
                chunk = stream.read(_STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ClientError(413, f"Archive entry '{name}' exceeds maximum allowed size ({max_bytes} bytes).")
                if not header_checked:
                    header_buf += chunk
                    if len(header_buf) >= len(required_magic):
                        if not header_buf.startswith(required_magic):
                            raise ClientError(400, f"Invalid file header for archive entry '{name}'.")
                        header_checked = True
                out_file.write(chunk)
            if not header_checked:
                raise ClientError(400, f"Invalid or truncated header for archive entry '{name}'.")
            out_file.flush()
            os.fsync(out_file.fileno())
        if verify_sqlite:
            try:
                with contextlib.closing(sqlite3.connect(tmp_path, timeout=5)) as conn:
                    check = conn.execute("PRAGMA quick_check(1)").fetchone()
                    if not check or check[0] != "ok":
                        raise ClientError(400, f"Integrity check failed for SQLite archive entry '{name}'.")
            except sqlite3.DatabaseError as exc:
                raise ClientError(400, f"Corrupted SQLite database in archive entry '{name}': {exc}") from exc
        os.replace(tmp_path, dest_path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _validate_archive_entries(zf):
    total_uncompressed = 0
    for info in zf.infolist():
        raw_name = info.filename
        if not raw_name or "\x00" in raw_name or raw_name.startswith(("/", "\\")) or "\\" in raw_name:
            raise ClientError(400, f"Unsafe archive entry path: '{raw_name}'.")
        parts = Path(raw_name).parts
        if ".." in parts or "." in parts:
            raise ClientError(400, f"Path traversal detected in archive entry: '{raw_name}'.")
        if info.file_size < 0:
            raise ClientError(400, f"Invalid uncompressed size in archive entry: '{raw_name}'.")
        total_uncompressed += info.file_size
        if total_uncompressed > MAX_ARCHIVE_TOTAL_BYTES:
            raise ClientError(413, "Workspace archive exceeds maximum total uncompressed size.")
        if raw_name == "manifest.json" and info.file_size > MAX_MANIFEST_BYTES:
            raise ClientError(413, "Archive manifest exceeds maximum allowed size.")
        elif raw_name in {"library.sqlite3", "screening.sqlite3"}:
            if info.file_size > MAX_SQLITE_BYTES:
                raise ClientError(413, f"Database entry '{raw_name}' exceeds maximum allowed size.")
            with zf.open(info, "r") as stream:
                header = stream.read(len(SQLITE_MAGIC))
            if header != SQLITE_MAGIC:
                raise ClientError(400, f"Invalid SQLite header in archive entry '{raw_name}'.")
        elif raw_name.startswith("pdfs/") and not info.is_dir():
            if len(parts) != 2 or parts[0] != "pdfs" or not parts[1]:
                raise ClientError(400, f"Invalid PDF entry path in archive: '{raw_name}'.")
            if info.file_size > MAX_PDF_ENTRY_BYTES:
                raise ClientError(413, f"PDF entry '{raw_name}' exceeds maximum allowed size.")
            with zf.open(info, "r") as stream:
                header = stream.read(len(PDF_MAGIC))
            if header != PDF_MAGIC:
                raise ClientError(400, f"Invalid PDF header in archive entry '{raw_name}'.")


def export_workspace_archive(output_path=None, directory=None, include_pdfs=True):
    root = _config_dir(directory)
    lib_path = root / 'library.sqlite3'
    screening_path = root / 'screening.sqlite3'
    pdf_dir = root / 'pdfs'

    with LIBRARY_WRITE_LOCK:
        # Checkpoint WAL files to ensure clean SQLite snapshots
        for db_path in (lib_path, screening_path):
            if db_path.exists():
                try:
                    with contextlib.closing(sqlite3.connect(db_path, timeout=5)) as conn:
                        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except Exception:
                    pass

        # Collect metadata for manifest
        paper_count = 0
        tags = set()
        saved_searches = []
        if lib_path.exists():
            try:
                with contextlib.closing(sqlite3.connect(lib_path, timeout=5)) as conn:
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
                with contextlib.closing(sqlite3.connect(screening_path, timeout=5)) as conn:
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
    path = _validate_archive_path(archive_path)

    try:
        with zipfile.ZipFile(path, "r") as zf:
            _validate_archive_entries(zf)
            namelist = set(zf.namelist())
            if "manifest.json" not in namelist:
                raise ClientError(400, "Invalid archive: manifest.json is missing.")
            raw_manifest = _read_bounded_bytes(zf, "manifest.json", MAX_MANIFEST_BYTES)
            manifest = json.loads(raw_manifest.decode("utf-8"))
            if not isinstance(manifest, dict) or manifest.get("format") != "pulse-workspace":
                raise ClientError(400, "File is not a valid Pulse workspace archive.")

            pdf_entries = [name for name in namelist if name.startswith("pdfs/") and len(name) > 5 and not name.endswith("/")]
            manifest["archivePdfCount"] = len(pdf_entries)
            manifest["hasLibrary"] = "library.sqlite3" in namelist
            manifest["hasScreening"] = "screening.sqlite3" in namelist
            manifest["fileSizeBytes"] = path.stat().st_size
            return manifest
    except zipfile.BadZipFile as exc:
        raise ClientError(400, "The archive file is corrupted or not a valid zip archive.") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ClientError(400, "Invalid archive: manifest.json is not valid JSON.") from exc


def restore_workspace_archive(archive_path, directory=None, mode="replace"):
    if mode not in {"replace", "merge"}:
        raise ClientError(400, "Unsupported workspace restore mode.")
    path = _validate_archive_path(archive_path)
    manifest = inspect_workspace_archive(path)
    root = _config_dir(directory)
    root.mkdir(parents=True, exist_ok=True)

    with LIBRARY_WRITE_LOCK:
        backup_dir = root / "backups" / f"pre_restore_{time.strftime('%Y%m%d_%H%M%S')}"
        backup_dir.mkdir(parents=True, exist_ok=True)

        # Checkpoint and backup current databases while holding LIBRARY_WRITE_LOCK
        for db_name in ("library.sqlite3", "screening.sqlite3"):
            db_path = root / db_name
            if db_path.exists():
                try:
                    with contextlib.closing(sqlite3.connect(db_path, timeout=5)) as conn:
                        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except Exception:
                    pass
        for fname in ("library.sqlite3", "library.sqlite3-wal", "screening.sqlite3", "screening.sqlite3-wal"):
            src = root / fname
            if src.exists():
                shutil.copy2(src, backup_dir / fname)

        restored = {"papers": 0, "pdfs": 0, "screening": 0}
        with zipfile.ZipFile(path, "r") as zf:
            namelist = set(zf.namelist())

            if mode == "replace":
                if "library.sqlite3" in namelist:
                    target = root / "library.sqlite3"
                    _extract_bounded_file(
                        zf, "library.sqlite3", target, MAX_SQLITE_BYTES,
                        required_magic=SQLITE_MAGIC, verify_sqlite=True
                    )
                    for wal_ext in ("-wal", "-shm"):
                        Path(str(target) + wal_ext).unlink(missing_ok=True)
                    restored["papers"] = manifest.get("paperCount", 0)

                if "screening.sqlite3" in namelist:
                    target = root / "screening.sqlite3"
                    _extract_bounded_file(
                        zf, "screening.sqlite3", target, MAX_SQLITE_BYTES,
                        required_magic=SQLITE_MAGIC, verify_sqlite=True
                    )
                    for wal_ext in ("-wal", "-shm"):
                        Path(str(target) + wal_ext).unlink(missing_ok=True)
                    restored["screening"] = manifest.get("screeningProjectCount", 0)

                # Restore PDFs
                pdf_dir = root / "pdfs"
                pdf_dir.mkdir(parents=True, exist_ok=True)
                for name in sorted(namelist):
                    if name.startswith("pdfs/") and len(name) > 5 and not name.endswith("/"):
                        basename = Path(name).name
                        dest = pdf_dir / basename
                        _extract_bounded_file(zf, name, dest, MAX_PDF_ENTRY_BYTES, required_magic=PDF_MAGIC)
                        restored["pdfs"] += 1
            elif mode == "merge":
                # Merge library papers (including two-tier papers_content if present)
                if "library.sqlite3" in namelist:
                    tmp_dir = Path(tempfile.mkdtemp(prefix="pulse-merge-", dir=str(root)))
                    try:
                        tmp_lib = tmp_dir / "incoming_library.sqlite3"
                        _extract_bounded_file(
                            zf, "library.sqlite3", tmp_lib, MAX_SQLITE_BYTES,
                            required_magic=SQLITE_MAGIC, verify_sqlite=True
                        )
                        with contextlib.closing(sqlite3.connect(tmp_lib, timeout=5)) as incoming_conn:
                            has_content_table = bool(
                                incoming_conn.execute(
                                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='papers_content'"
                                ).fetchone()
                            )
                            content_by_id = {}
                            if has_content_table:
                                for pid, c_raw in incoming_conn.execute(
                                    "SELECT paper_id, content FROM papers_content"
                                ).fetchall():
                                    content_by_id[pid] = json.loads(c_raw)
                            incoming_papers = []
                            for (raw_json,) in incoming_conn.execute("SELECT data FROM papers").fetchall():
                                paper = json.loads(raw_json)
                                pid = paper.get("id")
                                if pid in content_by_id and isinstance(content_by_id[pid], dict):
                                    paper.update(content_by_id[pid])
                                incoming_papers.append(paper)
                    finally:
                        shutil.rmtree(tmp_dir, ignore_errors=True)

                    if directory is not None:
                        from pulse_core.library_store import LibraryStore
                        store = LibraryStore(root / "library.json", lambda: {"papers": []}, lambda d, r: None)
                    else:
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
                for name in sorted(namelist):
                    if name.startswith("pdfs/") and len(name) > 5 and not name.endswith("/"):
                        basename = Path(name).name
                        dest = pdf_dir / basename
                        if not dest.exists():
                            _extract_bounded_file(zf, name, dest, MAX_PDF_ENTRY_BYTES, required_magic=PDF_MAGIC)
                            restored["pdfs"] += 1

    return {
        "ok": True,
        "mode": mode,
        "restored": restored,
        "backupPath": str(backup_dir),
    }
