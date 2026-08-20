"""Background poller that archives files observed in hermes state.db messages.

This is the "save everything that passes between agent and user" mechanism.
It reads each profile's ``state.db`` read-only (WAL safe, ``query_only=1``)
and copies any ``MEDIA:<path>`` referenced in assistant/user messages, plus
any local file paths in tool results (``image_generate``, ``tts_tool``, ...)
into the plugin's content-addressed store.

Profile isolation
-----------------
Each profile (agent) - ``default``, ``yaoyao``, ``yaoer``, ``gril``,
``succubus`` ... - has its OWN ``state.db`` and its OWN plugin data dir
(``<profile_home>/plugins/yaoyao/data``). The poller keeps one watcher state
per profile: a separate RO connection to that profile's state.db, its own
mtime watermark, and its own waterline. Files are ingested into that
profile's store with ``owner_profile=<profile name>``.

Profiles are discovered via ``profiles_to_serve(multiplex=True)`` and
re-scanned periodically so newly created profiles are picked up.

Lightweight polling (no full-content scan every cycle)
------------------------------------------------------
Each cycle, per profile:
  1. ``stat(state.db)`` - if mtime unchanged since last cycle, SKIP entirely
     (no SQL). Near-zero cost. [unchanged from the original poller]
  2. ``SELECT id FROM messages WHERE id > <waterline> LIMIT N`` - reads only
     the rowid, never the content blob. Cheap even on a huge messages table.
  3. Drop ids already in the plugin's ``processed_messages`` side table
     (in-process set lookup) so a replayed/re-flushed row isn't re-read.
  4. Only for the remaining NEW ids: ``SELECT id, session_id, role, content,
     tool_name FROM messages WHERE id IN (...)``. This is the only place we
     touch message content, and only for genuinely new rows.

Why a side table instead of state.db triggers: we never modify state.db
(cross-process safety; state.db is owned by the gateway). The
``processed_messages`` table lives in the plugin's OWN index.sqlite3, which
the dashboard process owns exclusively.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

import sys

# When loaded by the dashboard plugin loader (web_server.py:17256) this file is
# imported by path as a standalone module, so __package__ is None and relative
# imports fail. Make this directory importable so `import store` works both
# here and from plugin_api.py.
_THIS_DIR = str(Path(__file__).resolve().parent)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

import store  # noqa: E402

log = logging.getLogger("yaoyao.poller")

POLL_INTERVAL = 2.0  # seconds between cycles (per profile: stat-first, so cheap)
BATCH_LIMIT = 1000
PROFILE_RESCAN_EVERY = 30  # cycles between profile re-discovery passes
# Bump this whenever extraction learns a new persisted message shape.  Each
# profile then replays its complete history once; Store deduplication keeps the
# archive idempotent while newly-recognized references are added.
SCANNER_CONTRACT_VERSION = 1

# MEDIA paths are normally bare tokens.  Quoted paths additionally support
# spaces.  A quote terminates the bare form so MEDIA references embedded in a
# GROUP_CONTEXT_JSON string do not swallow the following JSON fields.
MEDIA_RE = re.compile(
    r"MEDIA:\s*(?:\"(?P<double>[^\"]+)\"|'(?P<single>[^']+)'|"
    r"(?P<plain>[^\s\"'\\]+))"
)

# Tools whose result JSON carries a local file path we should archive.
# Keys are the tool_name; values are the candidate JSON fields that may hold
# a local path (URLs are skipped - only real local files get archived).
MEDIA_TOOL_FIELDS = {
    "image_generate": ("image", "host_image", "agent_visible_image", "outputpath", "filepath"),
    "video_generate": ("video", "outputpath", "filepath", "path"),
    "text_to_speech": ("audio", "outputpath", "filepath", "path"),
    "tts_tool": ("audio", "outputpath", "filepath", "path"),
    "write_file": (
        "path",
        "filepath",
        "file_path",
        "output_path",
        "resolved_path",
    ),
}

# Roles we inspect. 'session_meta'/'system' carry no user-visible files.
TRACKED_ROLES = ("assistant", "tool", "user")


# ---------------------------------------------------------------------------
# state.db resolution
# ---------------------------------------------------------------------------

def _profile_state_db(profile_home: Path) -> Path:
    """Path to a profile's state.db (profile_home / state.db)."""
    return profile_home / "state.db"


def _open_state_db(path: Path) -> Optional[sqlite3.Connection]:
    """Open a read-only connection. Returns None if the db doesn't exist."""
    if not path.is_file():
        return None
    try:
        conn = sqlite3.connect(
            f"file:{path}?mode=ro", uri=True, timeout=5.0, check_same_thread=False
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=1")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn
    except sqlite3.Error as e:
        log.warning("poller: cannot open %s: %s", path, e)
        return None


# ---------------------------------------------------------------------------
# Path extraction (profile-independent)
# ---------------------------------------------------------------------------

def _is_local_path(s: str) -> bool:
    """True if s looks like a real local file path (not a URL, not empty)."""
    if not s or len(s) < 2:
        return False
    if "://" in s[:12]:  # http:// https:// file:// oss url etc.
        return False
    if s.startswith("data:"):
        return False
    # Must have a path-ish shape: absolute, or has an extension.
    if s.startswith("/"):
        return True
    if "." in os.path.basename(s):
        return True
    return False


def _paths_from_assistant(content: str) -> list[str]:
    """MEDIA: tags in assistant/user text content."""
    found: list[str] = []
    for match in MEDIA_RE.finditer(content):
        path = next((value for value in match.groups() if value is not None), "")
        if _is_local_path(path):
            found.append(path)
    return found


def _paths_from_tool(content: str, tool_name: str) -> list[str]:
    """Local paths buried in a tool result JSON body."""
    fields = MEDIA_TOOL_FIELDS.get(tool_name)
    if not fields:
        return []
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return []
    found: list[str] = []
    if isinstance(data, dict):
        for f in fields:
            v = data.get(f)
            if isinstance(v, str) and _is_local_path(v):
                found.append(v)
            elif isinstance(v, list):
                for item in v:
                    if isinstance(item, str) and _is_local_path(item):
                        found.append(item)
            elif isinstance(v, dict):
                for sub in v.values():
                    if isinstance(sub, str) and _is_local_path(sub):
                        found.append(sub)
    return found


# ---------------------------------------------------------------------------
# Profile discovery
# ---------------------------------------------------------------------------

def _discover_profiles() -> list[tuple[str, Path]]:
    """Return ``(profile_name, profile_home)`` for every profile whose
    ``state.db`` exists.

    Always includes ``default`` (-> ``~/.hermes``) when its state.db exists.
    Named profiles come from ``profiles_to_serve(multiplex=True)``; if that
    import is unavailable (e.g. stripped-down runtime), falls back to a
    directory scan of ``~/.hermes/profiles/``.
    """
    try:
        from hermes_cli.profiles import profiles_to_serve  # type: ignore
        pairs = profiles_to_serve(multiplex=True)
    except Exception:
        # Fallback: directory scan of ~/.hermes/profiles/ + default.
        try:
            env = os.environ.get("HERMES_HOME", "").strip()
            root = Path(env) if env else Path.home() / ".hermes"
        except Exception:
            root = Path.home() / ".hermes"
        pairs = [("default", root)]
        prof_root = root / "profiles"
        if prof_root.is_dir():
            for entry in sorted(prof_root.iterdir()):
                if entry.is_dir() and re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", entry.name):
                    pairs.append((entry.name, entry))

    # Keep only profiles whose state.db exists (a profile dir may exist but
    # never have been started -> no state.db -> nothing to watch).
    out: list[tuple[str, Path]] = []
    for name, home in pairs:
        try:
            home = Path(home)
        except Exception:
            continue
        if _profile_state_db(home).is_file():
            out.append((name, home))
    if not out:
        log.debug("poller: no profiles with an existing state.db found")
    return out


# ---------------------------------------------------------------------------
# Per-profile watcher state
# ---------------------------------------------------------------------------

class _ProfileWatcher:
    """State for one profile: RO state.db conn + waterline + mtime."""

    __slots__ = ("profile", "home", "db_path", "data_root", "store",
                 "conn", "last_id", "last_mtime", "max_known_id")

    def __init__(self, profile: str, home: Path):
        self.profile = profile
        self.home = Path(home)
        self.db_path = _profile_state_db(self.home)
        self.data_root = store.data_root_for_profile(profile)
        self.store = store.get_store(self.data_root)
        self.conn: Optional[sqlite3.Connection] = None
        self.last_id = 0
        self.last_mtime: int = -1
        # Highest message id known to exist at connect time. While last_id <
        # max_known_id we're still backfilling history and must NOT short-circuit
        # on mtime (the db isn't changing during a historical catch-up, but
        # there's still work to do).
        self.max_known_id: int = 0

    def ensure_connection(self) -> Optional[sqlite3.Connection]:
        if self.conn is not None:
            return self.conn
        conn = _open_state_db(self.db_path)
        if conn is None:
            return None
        self.conn = conn
        self._establish_baseline()
        log.info("poller[%s]: connected to %s, waterline=%d",
                 self.profile, self.db_path, self.last_id)
        return conn

    def _establish_baseline(self) -> None:
        """Set the starting waterline for this profile.

        On a fresh profile we start at id=0 so the ENTIRE history is archived
        - existing files referenced by old messages are exactly what users
        expect to see in the library ("谁的文件" includes files exchanged in
        past conversations). The ``processed_messages`` side table keeps this
        idempotent: a one-time backfill, after which each cycle only touches
        genuinely new ids.

        If we already scanned some messages (resumed after a restart), the
        waterline is taken from ``processed_messages`` so we never re-read
        content for already-archived rows.
        """
        if self.store.prepare_scanner_version(SCANNER_CONTRACT_VERSION):
            log.info(
                "poller[%s]: scanner contract v%d requires a full-session replay",
                self.profile,
                SCANNER_CONTRACT_VERSION,
            )
        wl = self.store.processed_waterline()
        if wl > 0:
            self.last_id = wl
            # Even on resume we need max_known_id to detect catch-up. Probe it
            # lazily on first poll if it's still 0.
            try:
                row = self.conn.execute("SELECT MAX(id) FROM messages").fetchone()
                self.max_known_id = int(row[0] or 0)
            except Exception:
                self.max_known_id = 0
            log.info("poller[%s]: resumed at message id=%d (from processed_messages, max=%d)",
                     self.profile, wl, self.max_known_id)
            return
        # Fresh: start from 0 to backfill history.
        try:
            row = self.conn.execute("SELECT MAX(id) FROM messages").fetchone()
            total = int(row[0] or 0)
        except Exception:
            total = 0
        self.last_id = 0
        self.max_known_id = total
        log.info("poller[%s]: backfill from id=0 (history has %d messages)",
                 self.profile, total)

    def close(self) -> None:
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None


# ---------------------------------------------------------------------------
# Poll loop (one cycle, one profile)
# ---------------------------------------------------------------------------

def _process_rows(watcher: _ProfileWatcher, rows: list[sqlite3.Row]) -> None:
    """Extract + ingest every file path in ``rows``; mark them processed."""
    profile = watcher.profile
    st = watcher.store
    for row in rows:
        mid = int(row["id"])
        role = row["role"]
        content = row["content"] or ""
        session_id = row["session_id"]
        tool_name = row["tool_name"]

        if role == "tool":
            paths = _paths_from_tool(content, tool_name or "")
            sender = "agent"
            kind = "tool_result"
        else:
            paths = _paths_from_assistant(content)
            sender = "user" if role == "user" else "agent"
            kind = "media_tag"

        for p in paths:
            try:
                st.ingest(
                    p,
                    sender=sender,
                    source_kind=kind,
                    source_message_id=mid,
                    session_id=session_id,
                    tool_name=tool_name,
                    display_name=os.path.basename(p) or Path(p).name,
                    owner_profile=profile,
                )
            except Exception as e:
                log.debug("poller[%s]: ingest %s failed: %s", profile, p, e)
        # Mark processed even if no paths were found, so we never re-read it.
        st.mark_processed(mid)


def _poll_profile(watcher: _ProfileWatcher) -> None:
    """One poll cycle for one profile. Lightweight: stat -> id-only probe ->
    fetch content only for genuinely new, unprocessed rows."""
    conn = watcher.ensure_connection()
    if conn is None:
        return

    # mtime short-circuit: if state.db hasn't changed since last cycle, skip
    # the SQL entirely. This is the common steady-state case (no new messages).
    # BUT only when we've finished the historical backfill (last_id >=
    # max_known_id). While catching up on history the db isn't changing, yet
    # there's still work to do, so we must keep probing.
    try:
        mtime = int(watcher.db_path.stat().st_mtime)
    except OSError:
        return
    backfilling = watcher.last_id < watcher.max_known_id
    if not backfilling and mtime == watcher.last_mtime:
        return

    # id-only probe: read just rowids for messages past the waterline. Never
    # touches the content blob, so it's cheap even on a huge messages table.
    try:
        id_rows = conn.execute(
            "SELECT id FROM messages "
            "WHERE id > ? AND role IN ('assistant','tool','user') "
            "ORDER BY id LIMIT ?",
            (watcher.last_id, BATCH_LIMIT),
        ).fetchall()
    except sqlite3.Error as e:
        log.warning("poller[%s]: id probe failed: %s; reopening", watcher.profile, e)
        watcher.close()
        return

    if not id_rows:
        watcher.last_mtime = mtime
        return

    new_ids = [int(r["id"]) for r in id_rows]
    # Drop ids we've already scanned (replayed / re-flushed rows).
    already = watcher.store.processed_set(new_ids)
    fresh = [i for i in new_ids if i not in already]
    if not fresh:
        # All already processed; just advance waterline + mtime.
        watcher.last_id = max(new_ids)
        watcher.last_mtime = mtime
        return

    # Fetch content ONLY for genuinely new rows.
    placeholders = ",".join("?" * len(fresh))
    try:
        rows = conn.execute(
            f"SELECT id, session_id, role, content, tool_name FROM messages "
            f"WHERE id IN ({placeholders})",
            fresh,
        ).fetchall()
    except sqlite3.Error as e:
        log.warning("poller[%s]: content fetch failed: %s", watcher.profile, e)
        return

    _process_rows(watcher, rows)
    watcher.last_id = max(new_ids)
    watcher.last_mtime = mtime
    log.debug("poller[%s]: processed %d new messages, waterline %d",
              watcher.profile, len(fresh), watcher.last_id)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_watchers: dict[str, _ProfileWatcher] = {}
_cycle_count = 0
_stop_event: Optional[threading.Event] = None
_thread: Optional[threading.Thread] = None


def _refresh_profiles() -> None:
    """Reconcile the watcher set with the on-disk profiles.

    Adds watchers for newly-seen profiles; leaves removed profiles' watchers
    in place (their state.db still exists on disk - we keep reading it until
    the dir is gone, then they just never get new data).
    """
    discovered = _discover_profiles()
    for name, home in discovered:
        if name not in _watchers:
            try:
                w = _ProfileWatcher(name, home)
                # init the store so the data dir exists immediately
                w.store.init()
                _watchers[name] = w
                log.info("poller[%s]: watching %s", name, w.db_path)
            except Exception as e:
                log.warning("poller[%s]: failed to set up watcher: %s", name, e)


def poll_now() -> None:
    """Run one poll cycle across all profiles. Idempotent / thread-safe."""
    global _cycle_count
    with _lock:
        _cycle_count += 1
        if _cycle_count % PROFILE_RESCAN_EVERY == 0:
            _refresh_profiles()
        elif not _watchers:
            _refresh_profiles()
        for name, watcher in list(_watchers.items()):
            try:
                _poll_profile(watcher)
            except Exception as e:
                log.debug("poller[%s]: cycle error: %s", name, e)


def _loop(stop_event: threading.Event) -> None:
    log.info("poller: started (interval=%.1fs)", POLL_INTERVAL)
    while not stop_event.is_set():
        try:
            poll_now()
        except Exception as e:
            log.exception("poller: unexpected error: %s", e)
        stop_event.wait(POLL_INTERVAL)
    # Clean up connections on stop.
    for watcher in _watchers.values():
        watcher.close()
    _watchers.clear()
    log.info("poller: stopped")


def start() -> None:
    """Start the poller daemon thread. Idempotent."""
    global _stop_event, _thread
    if _thread is not None and _thread.is_alive():
        return
    with _lock:
        _refresh_profiles()
    _stop_event = threading.Event()
    _thread = threading.Thread(
        target=_loop, args=(_stop_event,), name="yaoyao-poller", daemon=True
    )
    _thread.start()
    log.info("poller: starting (profiles=%s)", sorted(_watchers.keys()))


def stop() -> None:
    """Signal the poller to stop (for tests / clean shutdown)."""
    global _stop_event
    if _stop_event is not None:
        _stop_event.set()
