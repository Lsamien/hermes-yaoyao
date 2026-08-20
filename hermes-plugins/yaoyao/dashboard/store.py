"""Content-addressed file store + SQLite index for the yaoyao file library.

One row in ``attachments`` == one file observed in one message. Identical
file bodies are deduplicated via the ``objects`` table (keyed by sha256), so
storing the same image N times costs one copy on disk.

Profile isolation
-----------------
Each profile (agent) gets its OWN data directory resolved from the profile's
HERMES_HOME: ``<profile_home>/plugins/yaoyao/data/{index.sqlite3, objects/}``.
The default profile uses ``~/.hermes/plugins/yaoyao/data/`` (back-compat with
the pre-profile layout). A ``Store`` instance owns one connection per
``data_root``; the module keeps a small cache keyed by resolved path so
callers passing the same ``data_root`` share a connection.

This store never touches the hermes ``state.db`` - it is fully isolated.
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import mimetypes
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

try:
    from .group_protocol import is_reserved_mention_alias
except ImportError:  # Loaded by the Dashboard plugin loader as a top-level module.
    from group_protocol import is_reserved_mention_alias

log = logging.getLogger("yaoyao.store")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PLUGIN_ROOT = Path(__file__).resolve().parent.parent  # ~/.hermes/plugins/yaoyao
# Default profile's data dir (back-compat: <plugin>/data). Named profiles use
# <profile_home>/plugins/yaoyao/data, resolved at call time.
DEFAULT_DATA_ROOT = PLUGIN_ROOT / "data"

# Subpath of a profile home where this plugin's per-profile data lives.
PLUGIN_DATA_SUBPATH = Path("plugins") / "yaoyao" / "data"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS objects (
    sha256        TEXT PRIMARY KEY,
    storage_name  TEXT NOT NULL,
    byte_count    INTEGER NOT NULL,
    content_type  TEXT,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    object_sha256      TEXT NOT NULL REFERENCES objects(sha256),
    display_name       TEXT NOT NULL,
    content_type       TEXT,
    byte_count         INTEGER NOT NULL,
    sender             TEXT NOT NULL,
    source_kind        TEXT NOT NULL,
    source_message_id  INTEGER,
    session_id         TEXT,
    tool_name          TEXT,
    owner_profile      TEXT NOT NULL DEFAULT 'default',
    discovered_at      INTEGER NOT NULL,
    UNIQUE(source_message_id, display_name, object_sha256)
);

CREATE INDEX IF NOT EXISTS idx_att_sender     ON attachments(sender);
CREATE INDEX IF NOT EXISTS idx_att_session    ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_att_discovered ON attachments(discovered_at);
CREATE INDEX IF NOT EXISTS idx_att_kind       ON attachments(source_kind);

-- Outbox-style side table: which message ids have already been scanned.
-- Lets the poller do a cheap `SELECT id FROM messages WHERE id > ?` against
-- state.db and skip rows already here, instead of re-reading content for
-- every message on each cycle. Lives in THIS db (the plugin's own), never in
-- state.db.
CREATE TABLE IF NOT EXISTS processed_messages (
    message_id    INTEGER PRIMARY KEY,
    processed_at  INTEGER NOT NULL
);

-- Version the extraction contract separately from the database schema.  When
-- the poller learns how to recognize a new file-reference shape, it can clear
-- only the cheap processed-message waterline and replay history without
-- deleting archived objects or attachment metadata.
CREATE TABLE IF NOT EXISTS scanner_metadata (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
"""

# Additive migrations run once per data_root at init time. Each is idempotent:
# ALTER TABLE ... ADD COLUMN errors if the column exists, so we catch it.
#
# These run BEFORE the owner_profile INDEX is created (below), so an existing
# DB that predates the column gets it added before we try to index it.
_MIGRATIONS = [
    "ALTER TABLE attachments ADD COLUMN owner_profile TEXT NOT NULL DEFAULT 'default'",
]


def _dedup_attachments(conn: sqlite3.Connection) -> None:
    """Remove duplicate attachment rows, keeping the lowest-id row per
    (owner_profile, display_name, object_sha256).

    Runs once per DB after the owner_profile column exists. Idempotent: if no
    duplicates remain it's a no-op. Needed because the original dedup key was
    (source_message_id, ...) so a file referenced by N messages left N rows;
    the new dedup key is (owner_profile, display_name, sha256) so the same
    file is archived once regardless of how many messages reference it.
    """
    try:
        conn.execute(
            "DELETE FROM attachments WHERE id IN ("
            "  SELECT a.id FROM attachments a "
            "  JOIN ("
            "    SELECT owner_profile, display_name, object_sha256, MIN(id) AS keep_id "
            "    FROM attachments "
            "    GROUP BY owner_profile, display_name, object_sha256"
            "  ) k ON a.owner_profile=k.owner_profile "
            "       AND a.display_name=k.display_name "
            "       AND a.object_sha256=k.object_sha256 "
            "  WHERE a.id <> k.keep_id"
            ")"
        )
        conn.commit()
    except sqlite3.Error as e:
        log.warning("dedup_attachments failed: %s", e)


# Indexes that depend on a migrated column. Created after migrations so the
# column is guaranteed present on both fresh and pre-existing DBs. The unique
# index enforces the new dedup key (owner_profile, display_name, sha256) so the
# same file is never archived twice in one profile.
_POST_MIGRATION_SCHEMA = """
CREATE INDEX IF NOT EXISTS idx_att_profile ON attachments(owner_profile);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_dedup
    ON attachments(owner_profile, display_name, object_sha256);
"""


def _ensure_dirs(data_root: Optional[Path] = None) -> None:
    """Ensure the data dir + objects/ exist. Defaults to the default profile."""
    root = data_root if data_root is not None else DEFAULT_DATA_ROOT
    root.mkdir(parents=True, exist_ok=True)
    (root / "objects").mkdir(parents=True, exist_ok=True)


# Back-compat: the pre-profile module exposed a module-level DATA_ROOT. Some
# companions (voice_store) still import it. Keep it pointing at the default
# profile's data dir.
DATA_ROOT = DEFAULT_DATA_ROOT


def _connect(data_root: Path) -> sqlite3.Connection:
    """Open a read-write connection to a profile's own index database.

    This is NOT the hermes state.db - it is a separate SQLite file owned by
    this plugin. WAL mode + a short busy_timeout so the poller thread and the
    FastAPI request threads can interleave reads/writes without blocking.
    """
    _ensure_dirs(data_root)
    db_path = data_root / "index.sqlite3"
    conn = sqlite3.connect(str(db_path), timeout=5.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    for stmt in _MIGRATIONS:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass  # column already exists
    # Dedup BEFORE creating the unique index (the index would fail to build on
    # a DB that still has the old per-message duplicates).
    _dedup_attachments(conn)
    conn.executescript(_POST_MIGRATION_SCHEMA)
    return conn


# ---------------------------------------------------------------------------
# Per-data_root Store
# ---------------------------------------------------------------------------
# A single process (the dashboard) may talk to several profiles' data dirs.
# Keep one connection per resolved data_root, guarded by a per-root lock so
# the poller thread and request threads interleave cleanly.

class Store:
    """Content-addressed store bound to one ``data_root`` (one profile).

    Holds one SQLite connection (WAL) + a threading lock. Safe to call from
    multiple threads within the owning process. Each profile gets its own
    Store instance; the module caches them by resolved path.
    """

    __slots__ = ("data_root", "objects_dir", "_conn", "_lock")

    def __init__(self, data_root: Path):
        self.data_root = Path(data_root).resolve()
        self.objects_dir = self.data_root / "objects"
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.Lock()

    @property
    def state_file(self) -> Path:
        return self.data_root / "state.json"

    def init(self) -> sqlite3.Connection:
        """Lazily create the DB + tables. Returns the connection. Idempotent."""
        if self._conn is None:
            self._conn = _connect(self.data_root)
        return self._conn

    # -- content-type + kind inference -------------------------------------

    def ingest(
        self,
        src_path: str,
        *,
        sender: str,
        source_kind: str,
        source_message_id: Optional[int],
        session_id: Optional[str],
        tool_name: Optional[str] = None,
        display_name: Optional[str] = None,
        owner_profile: str = "default",
        discovered_at: Optional[int] = None,
    ) -> Optional[int]:
        """Archive one file. Returns the attachment id, or None on skip/failure.

        Skips (returns None) when:
          - the source file does not exist (agent wrote to /tmp then it was cleaned)
          - it's not a regular file (dir / socket / fifo)
          - it's already archived for this (message_id, display_name, sha256)

        The body is content-addressed: identical bytes are stored once.
        """
        p = Path(src_path)
        try:
            if not p.is_file():
                log.debug("ingest: skip non-file %s", src_path)
                return None
        except OSError as e:
            log.debug("ingest: cannot stat %s: %s", src_path, e)
            return None

        name = display_name or p.name
        try:
            sha256, size = _sha256_of_file(p)
        except OSError as e:
            log.warning("ingest: cannot read %s: %s", src_path, e)
            return None

        content_type = guess_content_type(src_path, name)
        ts = int(discovered_at if discovered_at is not None else time.time())

        conn = self.init()
        try:
            with self._lock:
                cur = conn.execute(
                    "SELECT 1 FROM objects WHERE sha256=?", (sha256,)
                )
                if cur.fetchone() is None:
                    storage_name = _copy_to_objects(p, sha256, name, self.objects_dir)
                    conn.execute(
                        "INSERT INTO objects(sha256, storage_name, byte_count, content_type, created_at) "
                        "VALUES(?,?,?,?,?)",
                        (sha256, storage_name, size, content_type, ts),
                    )
                conn.commit()
        except Exception as e:
            log.warning("ingest: object insert failed: %s", e)
            return None

        try:
            with self._lock:
                # Dedup by (owner_profile, display_name, sha256): the SAME file
                # (same bytes + same name in the same profile) is archived ONCE,
                # no matter how many messages reference it. This keeps the list
                # free of duplicates when an agent resends/replays an image
                # across multiple messages. The first occurrence wins; later
                # references just return the existing attachment id.
                cur = conn.execute(
                    "SELECT id FROM attachments "
                    "WHERE owner_profile=? AND display_name=? AND object_sha256=?",
                    (owner_profile, name, sha256),
                )
                existing = cur.fetchone()
                if existing:
                    return existing["id"]

                cur = conn.execute(
                    "INSERT INTO attachments("
                    "object_sha256, display_name, content_type, byte_count, sender, "
                    "source_kind, source_message_id, session_id, tool_name, "
                    "owner_profile, discovered_at"
                    ") VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (sha256, name, content_type, size, sender,
                     source_kind, source_message_id, session_id, tool_name,
                     owner_profile, ts),
                )
                conn.commit()
                return cur.lastrowid
        except sqlite3.IntegrityError:
            # UNIQUE race - fetch existing
            cur = conn.execute(
                "SELECT id FROM attachments "
                "WHERE owner_profile=? AND display_name=? AND object_sha256=?",
                (owner_profile, name, sha256),
            )
            row = cur.fetchone()
            return row["id"] if row else None
        except Exception as e:
            log.warning("ingest: attachment insert failed: %s", e)
            return None

    # -- processed-messages side table -------------------------------------

    def mark_processed(self, message_id: int) -> None:
        conn = self.init()
        with self._lock:
            conn.execute(
                "INSERT OR IGNORE INTO processed_messages(message_id, processed_at) "
                "VALUES(?,?)",
                (message_id, int(time.time())),
            )
            conn.commit()

    def processed_set(self, message_ids: list[int]) -> set[int]:
        """Return the subset of ``message_ids`` already in processed_messages."""
        if not message_ids:
            return set()
        conn = self.init()
        placeholders = ",".join("?" * len(message_ids))
        rows = conn.execute(
            f"SELECT message_id FROM processed_messages WHERE message_id IN ({placeholders})",
            message_ids,
        ).fetchall()
        return {int(r["message_id"]) for r in rows}

    def processed_waterline(self) -> int:
        """Highest message_id we've already scanned (0 if none)."""
        conn = self.init()
        row = conn.execute(
            "SELECT MAX(message_id) AS m FROM processed_messages"
        ).fetchone()
        return int(row["m"]) if row and row["m"] is not None else 0

    def prepare_scanner_version(self, version: int) -> bool:
        """Prepare ``processed_messages`` for the current extraction contract.

        Returns ``True`` exactly once for each new version.  The archived file
        rows and content-addressed objects stay intact; only the scan waterline
        is reset so every historical session is replayed with the new rules.
        """
        if version < 1:
            raise ValueError("scanner version must be positive")
        conn = self.init()
        requested = str(version)
        with self._lock:
            row = conn.execute(
                "SELECT value FROM scanner_metadata WHERE key='contract_version'"
            ).fetchone()
            if row is not None and row["value"] == requested:
                return False
            conn.execute("DELETE FROM processed_messages")
            conn.execute(
                "INSERT INTO scanner_metadata(key, value) VALUES('contract_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (requested,),
            )
            conn.commit()
        return True

    # -- queries -----------------------------------------------------------

    def get_attachment(self, attachment_id: int) -> Optional[dict[str, Any]]:
        conn = self.init()
        row = conn.execute(
            "SELECT * FROM attachments WHERE id=?", (attachment_id,)
        ).fetchone()
        return _row_to_attachment(row) if row else None

    def get_object_storage_name(self, sha256: str) -> Optional[str]:
        conn = self.init()
        row = conn.execute(
            "SELECT storage_name FROM objects WHERE sha256=?", (sha256,)
        ).fetchone()
        return row["storage_name"] if row else None

    def query_attachments(
        self,
        *,
        sender: Optional[str] = None,
        kind: Optional[str] = None,
        session_id: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 50,
        cursor: Optional[int] = None,
    ) -> tuple[list[dict[str, Any]], Optional[int], int]:
        """Page over filtered attachments newest-first.

        ``cursor`` is the last returned id. ``total`` is the full filtered
        count and therefore does not shrink as callers move through pages.
        """
        conn = self.init()
        where, params = _attachment_filter_sql(
            sender=sender,
            kind=kind,
            session_id=session_id,
            search=search,
        )
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        total = int(
            conn.execute(
                "SELECT COUNT(*) FROM attachments" + where_sql,
                params,
            ).fetchone()[0]
        )

        page_where = list(where)
        page_params = list(params)
        if cursor:
            page_where.append("id < ?")
            page_params.append(cursor)
        page_where_sql = (
            " WHERE " + " AND ".join(page_where) if page_where else ""
        )
        page_limit = max(1, int(limit))
        page_params.append(page_limit + 1)
        rows = conn.execute(
            "SELECT * FROM attachments"
            + page_where_sql
            + " ORDER BY id DESC LIMIT ?",
            page_params,
        ).fetchall()

        has_more = len(rows) > page_limit
        items = [_row_to_attachment(row) for row in rows[:page_limit]]
        next_cursor = items[-1]["id"] if has_more and items else None
        return items, next_cursor, total

    def query_message_files(self, message_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
        """Group attachments by source_message_id."""
        if not message_ids:
            return {}
        conn = self.init()
        placeholders = ",".join("?" * len(message_ids))
        rows = conn.execute(
            f"SELECT * FROM attachments WHERE source_message_id IN ({placeholders}) "
            "ORDER BY source_message_id, id",
            message_ids,
        ).fetchall()
        out: dict[int, list[dict[str, Any]]] = {}
        for r in rows:
            out.setdefault(r["source_message_id"], []).append(_row_to_attachment(r))
        return out

    def stats(self) -> dict[str, Any]:
        conn = self.init()
        total_att = conn.execute("SELECT COUNT(*) FROM attachments").fetchone()[0]
        total_obj = conn.execute("SELECT COUNT(*) FROM objects").fetchone()[0]
        total_bytes = conn.execute("SELECT COALESCE(SUM(byte_count),0) FROM objects").fetchone()[0]
        by_sender = {
            r["sender"]: r["c"]
            for r in conn.execute(
                "SELECT sender, COUNT(*) c FROM attachments GROUP BY sender"
            ).fetchall()
        }
        by_profile = {
            r["owner_profile"]: r["c"]
            for r in conn.execute(
                "SELECT owner_profile, COUNT(*) c FROM attachments GROUP BY owner_profile"
            ).fetchall()
        }
        return {
            "totalAttachments": total_att,
            "totalObjects": total_obj,
            "totalBytes": total_bytes,
            "bySender": by_sender,
            "byProfile": by_profile,
        }


# ---------------------------------------------------------------------------
# Module-level cache of per-data_root Store instances
# ---------------------------------------------------------------------------
_STORE_LOCK = threading.Lock()
_STORES: dict[str, Store] = {}


def get_store(data_root: Optional[Path] = None) -> Store:
    """Return the (cached) Store for ``data_root`` (default profile if None)."""
    root = Path(data_root) if data_root is not None else DEFAULT_DATA_ROOT
    key = str(root.resolve())
    with _STORE_LOCK:
        st = _STORES.get(key)
        if st is None:
            st = Store(root)
            _STORES[key] = st
        return st


def data_root_for_profile(profile: Optional[str]) -> Path:
    """Resolve the plugin data dir for a profile name.

    ``default`` (or None) -> ``~/.hermes/plugins/yaoyao/data`` (back-compat).
    Named profile -> ``<profile_home>/plugins/yaoyao/data``.
    """
    if not profile or profile == "default":
        return DEFAULT_DATA_ROOT
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore
    except Exception:
        get_default_hermes_root = None
    try:
        from hermes_cli.profiles import get_profile_dir  # type: ignore
        home = get_profile_dir(profile)
    except Exception:
        # Fallback: ~/.hermes/profiles/<name> (matches get_profile_dir's logic)
        try:
            if get_default_hermes_root is not None:
                base = get_default_hermes_root()
            else:
                env = os.environ.get("HERMES_HOME", "").strip()
                base = Path(env) if env else Path.home() / ".hermes"
        except Exception:
            base = Path.home() / ".hermes"
        home = base / "profiles" / profile
    return home / PLUGIN_DATA_SUBPATH


# ---------------------------------------------------------------------------
# Back-compat module-level functions (default profile).
#
# Keep the old call surface working for the duplex-voice section below and any
# stragglers. New code should use get_store(data_root).ingest(...).
# ---------------------------------------------------------------------------

def _default_store() -> Store:
    return get_store(DEFAULT_DATA_ROOT)


def init() -> sqlite3.Connection:
    """Back-compat: init the DEFAULT profile's store. Returns its connection."""
    return _default_store().init()


def ingest(
    src_path: str,
    *,
    sender: str,
    source_kind: str,
    source_message_id: Optional[int],
    session_id: Optional[str],
    tool_name: Optional[str] = None,
    display_name: Optional[str] = None,
    owner_profile: str = "default",
    discovered_at: Optional[int] = None,
) -> Optional[int]:
    """Back-compat: ingest into the DEFAULT profile's store."""
    return _default_store().ingest(
        src_path,
        sender=sender,
        source_kind=source_kind,
        source_message_id=source_message_id,
        session_id=session_id,
        tool_name=tool_name,
        display_name=display_name,
        owner_profile=owner_profile,
        discovered_at=discovered_at,
    )


def get_attachment(attachment_id: int) -> Optional[dict[str, Any]]:
    return _default_store().get_attachment(attachment_id)


def get_object_storage_name(sha256: str) -> Optional[str]:
    return _default_store().get_object_storage_name(sha256)


def query_attachments(
    *,
    sender: Optional[str] = None,
    kind: Optional[str] = None,
    session_id: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    cursor: Optional[int] = None,
) -> tuple[list[dict[str, Any]], Optional[int], int]:
    return _default_store().query_attachments(
        sender=sender, kind=kind, session_id=session_id,
        search=search, limit=limit, cursor=cursor,
    )


def query_message_files(message_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
    return _default_store().query_message_files(message_ids)


def stats() -> dict[str, Any]:
    return _default_store().stats()


# ---------------------------------------------------------------------------
# Content-type + kind inference (module-level, data_root-independent)
# ---------------------------------------------------------------------------

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tiff", ".tif"}
_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv"}
_TEXT_EXTS = {".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".log", ".py", ".js", ".ts", ".html", ".xml", ".rst"}


def _attachment_kind_sql() -> str:
    def suffixes(values: set[str]) -> str:
        return " OR ".join(
            f"lower(display_name) LIKE '%{extension}'"
            for extension in sorted(values)
        )

    image = (
        "lower(COALESCE(content_type, '')) LIKE 'image/%' OR "
        f"({suffixes(_IMAGE_EXTS)})"
    )
    video = (
        "lower(COALESCE(content_type, '')) LIKE 'video/%' OR "
        f"({suffixes(_VIDEO_EXTS)})"
    )
    text = (
        "lower(COALESCE(content_type, '')) LIKE 'text/%' OR "
        f"({suffixes(_TEXT_EXTS)})"
    )
    return (
        "CASE "
        f"WHEN ({image}) THEN 'image' "
        f"WHEN ({video}) THEN 'video' "
        f"WHEN ({text}) THEN 'text' "
        "ELSE 'file' END"
    )


def _attachment_filter_sql(
    *,
    sender: Optional[str],
    kind: Optional[str],
    session_id: Optional[str],
    search: Optional[str],
) -> tuple[list[str], list[Any]]:
    where: list[str] = []
    params: list[Any] = []
    if sender:
        where.append("sender = ?")
        params.append(sender)
    if session_id:
        where.append("session_id = ?")
        params.append(session_id)
    if search:
        where.append("instr(lower(display_name), lower(?)) > 0")
        params.append(search)
    if kind:
        where.append(f"({_attachment_kind_sql()}) = ?")
        params.append(kind)
    return where, params


def guess_content_type(path: str, display_name: str = "") -> str:
    name = display_name or os.path.basename(path)
    ct, _ = mimetypes.guess_type(name)
    if ct:
        return ct
    ext = Path(name).suffix.lower()
    if ext in _IMAGE_EXTS:
        return "image/png" if ext == ".png" else "application/octet-stream"
    return "application/octet-stream"


def infer_kind(display_name: str, content_type: str) -> str:
    """Return one of: image / video / text / file."""
    ext = Path(display_name).suffix.lower()
    if content_type.startswith("image/") or ext in _IMAGE_EXTS:
        return "image"
    if content_type.startswith("video/") or ext in _VIDEO_EXTS:
        return "video"
    if content_type.startswith("text/") or ext in _TEXT_EXTS:
        return "text"
    return "file"


# ---------------------------------------------------------------------------
# Content-addressed helpers (module-level, take objects_dir)
# ---------------------------------------------------------------------------

def _sha256_of_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def _storage_name(sha256: str, ext: str) -> str:
    return f"{sha256}{ext}"


def _copy_to_objects(src: Path, sha256: str, display_name: str, objects_dir: Path) -> str:
    """Copy ``src`` into objects/ as <sha256><ext>. Returns storage_name."""
    ext = Path(display_name).suffix.lower() or Path(src).suffix.lower()
    storage_name = _storage_name(sha256, ext)
    dest = objects_dir / storage_name
    if not dest.exists():
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        with src.open("rb") as r, tmp.open("wb") as w:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                w.write(chunk)
        os.replace(tmp, dest)
    return storage_name


def _row_to_attachment(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "objectSha256": row["object_sha256"],
        "displayName": row["display_name"],
        "contentType": row["content_type"] or "application/octet-stream",
        "byteCount": row["byte_count"],
        "sender": row["sender"],
        "sourceKind": row["source_kind"],
        "sourceMessageId": row["source_message_id"],
        "sessionId": row["session_id"],
        "toolName": row["tool_name"],
        "ownerProfile": row["owner_profile"] if "owner_profile" in row.keys() else "default",
        "discoveredAt": row["discovered_at"],
    }


# ---------------------------------------------------------------------------
# Agent display-name settings
# ---------------------------------------------------------------------------
# Names are isolated by Hermes profile and kept next to that profile's Yaoyao
# data.  The value is presentation-only: profile ids remain the stable routing
# identity everywhere else.

_AGENT_SETTINGS_FILE = "agent_settings.json"
_AGENT_SETTINGS_LOCK = threading.Lock()
MAX_AGENT_NAME_LENGTH = 100


def _agent_settings_path(profile: Optional[str]) -> Path:
    return data_root_for_profile(profile) / _AGENT_SETTINGS_FILE


def load_agent_settings(profile: Optional[str] = None) -> dict[str, Any]:
    """Read the configured display name for one Hermes profile."""
    profile_name = str(profile or "default").strip() or "default"
    result = {
        "profile": profile_name,
        "agentName": "",
        "updatedAt": 0,
    }
    path = _agent_settings_path(profile_name)
    try:
        if path.is_file():
            saved = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                name = str(saved.get("agentName") or "").strip()
                if len(name) <= MAX_AGENT_NAME_LENGTH and not any(
                    ord(character) < 32 or ord(character) == 127
                    for character in name
                ) and not is_reserved_mention_alias(name):
                    result["agentName"] = name
                result["updatedAt"] = int(saved.get("updatedAt") or 0)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        log.warning("agent settings load failed for %s: %s", profile_name, error)
    return result


def save_agent_settings(
    profile: Optional[str],
    input_data: dict[str, Any],
) -> dict[str, Any]:
    """Set or clear one profile's display name and return the saved value."""
    if not isinstance(input_data, dict) or "agentName" not in input_data:
        raise ValueError("agentName is required")
    candidate = input_data["agentName"]
    if not isinstance(candidate, str):
        raise ValueError("agentName must be a string")
    agent_name = candidate.strip()
    if len(agent_name) > MAX_AGENT_NAME_LENGTH:
        raise ValueError("agentName is too long")
    if any(ord(character) < 32 or ord(character) == 127 for character in agent_name):
        raise ValueError("agentName contains control characters")
    if is_reserved_mention_alias(agent_name):
        raise ValueError("agentName is reserved for group mentions")

    profile_name = str(profile or "default").strip() or "default"
    now = int(time.time() * 1000)
    saved = {
        "profile": profile_name,
        "agentName": agent_name,
        "updatedAt": now,
    }
    path = _agent_settings_path(profile_name)
    _ensure_dirs(path.parent)
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    with _AGENT_SETTINGS_LOCK:
        try:
            temporary.write_text(
                json.dumps(saved, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    return saved


# ---------------------------------------------------------------------------
# iOS duplex voice settings (mirrors yaoyao-webui's ios-duplex-voice contract)
# ---------------------------------------------------------------------------
# The iOS app connects directly to the TTS provider (e.g. Volcano/doubao) for
# low-latency duplex voice. This plugin stores the single shared API key +
# the voice list + the currently selected voice, exactly matching the
# IosDuplexVoiceSettings schema from yaoyao-webui so the iOS client can talk
# to either backend interchangeably.
#
# These settings are GLOBAL (not per-profile): one shared duplex-voice config
# for the whole installation. Kept in the default profile's data dir.

_DEFAULT_DUPLEX_VOICES: list[dict[str, str]] = [
    {"id": "zh_female_xiaohe_uranus_bigtts", "name": "小何 2.0"},
    {"id": "zh_female_vv_uranus_bigtts", "name": "Vivi 2.0"},
    {"id": "zh_male_m191_uranus_bigtts", "name": "云舟 2.0"},
    {"id": "zh_male_taocheng_uranus_bigtts", "name": "小天 2.0"},
    {"id": "zh_female_qingxinnvsheng_uranus_bigtts", "name": "清新女声 2.0"},
    {"id": "zh_female_cancan_uranus_bigtts", "name": "知性灿灿 2.0"},
    {"id": "zh_male_ruyayichen_uranus_bigtts", "name": "儒雅逸辰 2.0"},
    {"id": "en_female_dacey_uranus_bigtts", "name": "Dacey 2.0"},
]

_DUPLEX_VOICE_FILE = DEFAULT_DATA_ROOT / "duplex_voice.json"

_DUPLEX_LOCK = threading.Lock()

MAX_DUPLEX_VOICES = 100
MAX_DUPLEX_VOICE_TEXT = 200
MAX_DUPLEX_API_KEY = 4000


def _duplex_default() -> dict[str, Any]:
    return {
        "apiKey": "",
        "voices": [dict(v) for v in _DEFAULT_DUPLEX_VOICES],
        "currentVoiceId": _DEFAULT_DUPLEX_VOICES[0]["id"],
        "updatedAt": 0,
    }


def _normalize_duplex_voices(raw: Any) -> list[dict[str, str]]:
    """Validate + normalize a voice list (raises ValueError on bad input)."""
    if not isinstance(raw, list) or len(raw) == 0 or len(raw) > MAX_DUPLEX_VOICES:
        raise ValueError("voices must contain between 1 and 100 items")
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("invalid voice")
        vid = str(item.get("id", "")).strip()
        name = str(item.get("name", "")).strip()
        if not vid or len(vid) > MAX_DUPLEX_VOICE_TEXT:
            raise ValueError("invalid voice id")
        if not name or len(name) > MAX_DUPLEX_VOICE_TEXT:
            raise ValueError("invalid voice name")
        if vid in seen:
            raise ValueError(f"duplicate voice id: {vid}")
        seen.add(vid)
        out.append({"id": vid, "name": name})
    return out


def load_duplex_voice() -> dict[str, Any]:
    """Read duplex voice settings, deep-merged over defaults."""
    cfg = _duplex_default()
    try:
        if _DUPLEX_VOICE_FILE.is_file():
            saved = json.loads(_DUPLEX_VOICE_FILE.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                if "apiKey" in saved:
                    cfg["apiKey"] = str(saved["apiKey"])
                if "voices" in saved:
                    cfg["voices"] = _normalize_duplex_voices(saved["voices"])
                if "currentVoiceId" in saved:
                    cfg["currentVoiceId"] = str(saved["currentVoiceId"])
                if "updatedAt" in saved:
                    cfg["updatedAt"] = int(saved["updatedAt"])
    except Exception as e:
        log.warning("duplex voice load failed: %s", e)
    # Ensure currentVoiceId is valid
    if not any(v["id"] == cfg["currentVoiceId"] for v in cfg["voices"]):
        cfg["currentVoiceId"] = cfg["voices"][0]["id"] if cfg["voices"] else ""
    return cfg


def save_duplex_voice(input_data: dict[str, Any]) -> dict[str, Any]:
    """Partial update of duplex voice settings. Returns the full settings."""
    current = load_duplex_voice()

    voices = current["voices"]
    if "voices" in input_data:
        voices = _normalize_duplex_voices(input_data["voices"])

    current_voice_id = current["currentVoiceId"]
    if "currentVoiceId" in input_data:
        current_voice_id = str(input_data["currentVoiceId"]).strip()
        if not current_voice_id or len(current_voice_id) > MAX_DUPLEX_VOICE_TEXT:
            raise ValueError("invalid current voice id")
    # If current voice was removed, fall back to first
    if not any(v["id"] == current_voice_id for v in voices):
        current_voice_id = voices[0]["id"] if voices else ""

    api_key = current["apiKey"]
    if "apiKey" in input_data:
        candidate = input_data["apiKey"]
        if not isinstance(candidate, str):
            raise ValueError("apiKey must be a string")
        candidate = candidate.strip()
        if candidate and candidate != "[stored]":
            if len(candidate) > MAX_DUPLEX_API_KEY:
                raise ValueError("apiKey is too long")
            api_key = candidate

    import time as _time
    now = int(_time.time() * 1000)
    merged = {
        "apiKey": api_key,
        "voices": voices,
        "currentVoiceId": current_voice_id,
        "updatedAt": now,
    }
    _ensure_dirs(DEFAULT_DATA_ROOT)
    with _DUPLEX_LOCK:
        _DUPLEX_VOICE_FILE.write_text(
            json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return merged


def public_duplex_voice() -> dict[str, Any]:
    """Settings for the dashboard UI (apiKey masked as hasApiKey boolean)."""
    s = load_duplex_voice()
    return {
        "hasApiKey": bool(s["apiKey"]),
        "voices": s["voices"],
        "currentVoiceId": s["currentVoiceId"],
        "updatedAt": s["updatedAt"],
    }


def runtime_duplex_voice() -> dict[str, Any]:
    """Settings for the iOS app runtime (includes the real apiKey)."""
    s = load_duplex_voice()
    return {
        "apiKey": s["apiKey"],
        "voices": s["voices"],
        "currentVoiceId": s["currentVoiceId"],
        "updatedAt": s["updatedAt"],
    }
