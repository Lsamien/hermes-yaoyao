"""Durable SQLite storage primitives for the YaoYao Group Chat plugin."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import os
import re
import sqlite3
import time
import unicodedata
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Mapping

from .group_protocol import (
    ALL_MENTION_ALIASES,
    CONTEXT_CHARACTER_BUDGET,
    DEFAULT_MAX_REPLY_ROUNDS,
    INITIAL_CONTEXT_MESSAGE_LIMIT,
    MAX_AGENTS_PER_ROOM,
    MAX_EVENT_BATCH_SIZE,
    MAX_FINITE_REPLY_ROUNDS,
    MAX_INTERACTION_PAYLOAD_BYTES,
    MAX_MESSAGE_BYTES,
    MAX_MESSAGE_PAGE_SIZE,
    MAX_PLUGIN_CONCURRENCY,
    MAX_ROOM_CONCURRENCY,
    MAX_TOOL_STATE_BYTES,
    is_reserved_mention_alias,
    normalize_display_name,
    normalize_interaction_id,
    normalize_max_reply_rounds,
    normalize_room_cwd,
    normalize_room_name,
)


SCHEMA_VERSION = 7
_WAL_RETRY_DELAYS = (0.01, 0.02, 0.04, 0.08)
EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60
MIN_RETAINED_EVENTS = 100_000
UNSET = object()

RUN_TRANSITIONS = {
    "queued": frozenset({"running", "interrupted", "failed"}),
    "running": frozenset({"awaiting_input", "completed", "failed", "interrupted"}),
    "awaiting_input": frozenset({"running", "failed", "interrupted"}),
    "completed": frozenset(),
    "failed": frozenset(),
    "interrupted": frozenset(),
}
_MESSAGE_STATUSES = frozenset(
    {"queued", "streaming", "completed", "failed", "interrupted"}
)
_AGENT_MESSAGE_STATUSES_BY_RUN = {
    "queued": frozenset({"queued"}),
    "running": frozenset({"queued", "streaming", "completed"}),
    "awaiting_input": frozenset({"queued", "streaming"}),
    "completed": frozenset(),
    "failed": frozenset(),
    "interrupted": frozenset(),
}
_AGENT_MESSAGE_TRANSITIONS = {
    "queued": frozenset({"queued", "streaming", "completed"}),
    "streaming": frozenset({"streaming", "completed"}),
    "completed": frozenset(),
    "failed": frozenset(),
    "interrupted": frozenset(),
}
_MESSAGE_STATUSES_BY_RUN = {
    "queued": frozenset({"queued"}),
    "running": frozenset({"queued", "streaming", "completed"}),
    "awaiting_input": frozenset({"queued", "streaming"}),
    "completed": frozenset({"completed"}),
    "failed": frozenset({"failed", "completed"}),
    "interrupted": frozenset({"interrupted", "completed"}),
}
_INTERACTION_KINDS = frozenset({"approval", "clarification"})
_INTERACTION_TERMINAL_STATUSES = frozenset({"resolved", "cancelled"})
_CASCADE_PENDING_OPERATION = "internal.cascade.pending"
_CASCADE_COMPLETED_OPERATION = "internal.cascade.completed"
_CASCADE_DISCARDED_OPERATION = "internal.cascade.discarded"
_CASCADE_OPERATIONS = frozenset(
    {
        _CASCADE_PENDING_OPERATION,
        _CASCADE_COMPLETED_OPERATION,
        _CASCADE_DISCARDED_OPERATION,
    }
)
_CASCADE_PARSE_VERSION = 3
_MAX_CASCADE_PAGE_SIZE = 32
_MAX_CASCADE_PLAN_BYTES = 16 * 1024
_TOPIC_TITLE_LENGTH = 120
_TOPIC_PREVIEW_LENGTH = 240
_DEFAULT_SESSION_CONFIGURATION_JSON = (
    '{"fast":null,"model":null,"provider":null,"reasoning_effort":null}'
)

_SCHEMA_STATEMENTS = (
    """CREATE TABLE IF NOT EXISTS group_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS group_rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        max_reply_rounds INTEGER NOT NULL DEFAULT 3,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS group_topics (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        UNIQUE(room_id, id)
    )""",
    """CREATE TABLE IF NOT EXISTS group_agents (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        profile TEXT NOT NULL,
        display_name TEXT NOT NULL,
        display_name_key TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        stored_session_id TEXT,
        last_context_message_seq INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        reply_without_mention INTEGER NOT NULL DEFAULT 0,
        is_host INTEGER NOT NULL DEFAULT 0,
        model_override TEXT,
        provider_override TEXT,
        reasoning_effort_override TEXT,
        fast_mode_override INTEGER,
        session_config_json TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        UNIQUE(room_id, profile),
        UNIQUE(room_id, display_name_key)
    )""",
    """CREATE TABLE IF NOT EXISTS group_agent_topic_state (
        agent_id TEXT NOT NULL REFERENCES group_agents(id) ON DELETE CASCADE,
        topic_id TEXT NOT NULL REFERENCES group_topics(id) ON DELETE CASCADE,
        last_context_message_seq INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY(agent_id, topic_id)
    )""",
    """CREATE TABLE IF NOT EXISTS group_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        topic_id TEXT NOT NULL,
        sender_kind TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        root_message_id TEXT NOT NULL,
        reply_to_message_id TEXT,
        client_message_id TEXT UNIQUE,
        content TEXT NOT NULL DEFAULT '',
        reasoning TEXT NOT NULL DEFAULT '',
        tool_state_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        visible INTEGER NOT NULL DEFAULT 1,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY(room_id, topic_id)
            REFERENCES group_topics(room_id, id) ON DELETE CASCADE
    )""",
    """CREATE TABLE IF NOT EXISTS group_agent_runs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        response_message_id TEXT NOT NULL,
        root_message_id TEXT NOT NULL,
        depth INTEGER NOT NULL,
        reply_mode TEXT NOT NULL DEFAULT 'mentioned',
        required_reply INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        runtime_session_id TEXT,
        requested_model TEXT,
        requested_provider TEXT,
        requested_reasoning_effort TEXT,
        requested_fast_mode INTEGER,
        actual_model TEXT,
        actual_provider TEXT,
        actual_reasoning_effort TEXT,
        actual_fast_mode INTEGER,
        error TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY(room_id, topic_id)
            REFERENCES group_topics(room_id, id) ON DELETE CASCADE
    )""",
    """CREATE TABLE IF NOT EXISTS group_interactions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at REAL NOT NULL,
        resolved_at REAL,
        FOREIGN KEY(room_id, topic_id)
            REFERENCES group_topics(room_id, id) ON DELETE CASCADE
    )""",
    """CREATE TABLE IF NOT EXISTS group_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch TEXT NOT NULL,
        room_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS group_idempotency (
        request_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at REAL NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_group_rooms_ordering ON group_rooms(archived, updated_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_group_topics_room_ordering ON group_topics(room_id, updated_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_group_messages_room_seq ON group_messages(room_id, seq)",
    "CREATE INDEX IF NOT EXISTS idx_group_messages_topic_seq ON group_messages(topic_id, seq)",
    "CREATE INDEX IF NOT EXISTS idx_group_agent_runs_room ON group_agent_runs(room_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_agent_runs_topic ON group_agent_runs(topic_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_agent_runs_agent_status ON group_agent_runs(agent_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_group_agent_runs_room_status ON group_agent_runs(room_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_group_agent_runs_status_order ON group_agent_runs(status, created_at, id)",
    """CREATE UNIQUE INDEX IF NOT EXISTS idx_group_agents_room_host
    ON group_agents(room_id) WHERE is_host = 1""",
    """CREATE UNIQUE INDEX IF NOT EXISTS idx_group_agent_runs_active_runtime
    ON group_agent_runs(runtime_session_id)
    WHERE runtime_session_id IS NOT NULL
      AND status IN ('running', 'awaiting_input')""",
    "CREATE INDEX IF NOT EXISTS idx_group_interactions_room_agent ON group_interactions(room_id, agent_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_interactions_topic ON group_interactions(topic_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_interactions_run_status_kind ON group_interactions(run_id, status, kind)",
    "CREATE INDEX IF NOT EXISTS idx_group_events_room_created_at ON group_events(room_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_group_events_created_at ON group_events(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_group_idempotency_operation ON group_idempotency(operation)",
)

_EXPECTED_TABLES = frozenset(
    {
        "group_meta",
        "group_rooms",
        "group_topics",
        "group_agents",
        "group_agent_topic_state",
        "group_messages",
        "group_agent_runs",
        "group_interactions",
        "group_events",
        "group_idempotency",
    }
)

_LEGACY_TABLES = _EXPECTED_TABLES - {"group_topics", "group_agent_topic_state"}


class GroupStoreError(RuntimeError):
    """Raised when the group-chat database is uninitialized or corrupt."""


class GroupNotFoundError(GroupStoreError):
    """Raised when a room or agent is absent, or unavailable because it is archived."""


class GroupConflictError(GroupStoreError):
    """Raised when a requested room-member invariant would be violated."""


class IdempotencyConflict(GroupStoreError):
    """Raised when a request ID is reused for a different operation or payload."""


@dataclass(frozen=True)
class CursorPage:
    """A page of room summaries and the opaque cursor for its successor."""

    items: list[dict[str, object]]
    next_cursor: str | None


class GroupStore:
    """The versioned SQLite authority for public group-chat state."""

    def __init__(
        self,
        path: Path,
        *,
        agent_name_resolver: Callable[[str], str] | None = None,
    ):
        self.path = Path(path)
        self._agent_name_resolver = agent_name_resolver or (lambda _profile: "")

    @classmethod
    def from_environment(
        cls, *, agent_name_resolver: Callable[[str], str] | None = None
    ) -> "GroupStore":
        hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
        return cls(
            hermes_home / "plugins" / "yaoyao" / "data" / "group-chat.db",
            agent_name_resolver=agent_name_resolver,
        )

    def connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        """Yield a raw SQLite connection and always close it afterwards."""
        connection = self.connect()
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        """Create or validate the versioned schema without changing its epoch."""
        for attempt, delay in enumerate(_WAL_RETRY_DELAYS):
            try:
                self._initialize_once()
                return
            except sqlite3.OperationalError as error:
                if (
                    not self._is_busy_or_locked(error)
                    or attempt == len(_WAL_RETRY_DELAYS) - 1
                ):
                    raise
                time.sleep(delay)

    def _initialize_once(self) -> None:
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("BEGIN IMMEDIATE")
            try:
                table_names = self._user_table_names(connection)
                if not table_names:
                    self._create_fresh_schema(connection)
                else:
                    self._validate_existing_schema(connection, table_names)
                self._ensure_indexes(connection)
                self._sync_legacy_fallback_agent_names(connection)
            except Exception:
                connection.execute("ROLLBACK")
                raise
            else:
                connection.execute("COMMIT")

    def _sync_legacy_fallback_agent_names(
        self, connection: sqlite3.Connection
    ) -> None:
        """Adopt configured names for active legacy members without overriding edits."""
        rows = connection.execute(
            """SELECT group_agents.* FROM group_agents
            JOIN group_rooms ON group_rooms.id = group_agents.room_id
            WHERE group_agents.display_name = group_agents.profile
              AND group_rooms.archived = 0
            ORDER BY group_rooms.created_at ASC, group_rooms.id ASC,
                     group_agents.created_at ASC, group_agents.id ASC"""
        ).fetchall()
        for row in rows:
            configured = self._resolved_agent_name(row["profile"])
            if not configured:
                continue
            try:
                display_name, display_name_key = normalize_display_name(configured)
            except ValueError:
                continue
            if (
                display_name == row["display_name"]
                and display_name_key == row["display_name_key"]
            ):
                continue
            conflict = connection.execute(
                """SELECT 1 FROM group_agents
                WHERE room_id = ? AND display_name_key = ? AND id != ?
                LIMIT 1""",
                (row["room_id"], display_name_key, row["id"]),
            ).fetchone()
            if conflict is not None:
                continue

            now = self._now()
            connection.execute(
                """UPDATE group_agents
                SET display_name = ?, display_name_key = ?, updated_at = ?
                WHERE id = ? AND room_id = ?""",
                (display_name, display_name_key, now, row["id"], row["room_id"]),
            )
            connection.execute(
                "UPDATE group_rooms SET updated_at = ? WHERE id = ?",
                (now, row["room_id"]),
            )
            agent = self._agent_detail(connection, row["room_id"], row["id"])
            self._append_event(
                connection,
                row["room_id"],
                "agent.updated",
                agent,
                created_at=now,
            )
            self._append_room_updated_summary(
                connection, row["room_id"], created_at=now
            )

    def schema_version(self) -> int:
        value = self._metadata_value("schema_version")
        return self._validated_schema_version(value)

    def journal_epoch(self) -> str:
        value = self._metadata_value("journal_epoch")
        try:
            canonical = str(uuid.UUID(value))
        except (ValueError, AttributeError) as error:
            raise GroupStoreError("GroupStore journal_epoch is corrupt") from error
        if value != canonical:
            raise GroupStoreError("GroupStore journal_epoch is corrupt")
        return canonical

    def _create_fresh_schema(self, connection: sqlite3.Connection) -> None:
        for statement in _SCHEMA_STATEMENTS:
            connection.execute(statement)
        connection.execute(
            "INSERT INTO group_meta(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        connection.execute(
            "INSERT INTO group_meta(key, value) VALUES ('journal_epoch', ?)",
            (str(uuid.uuid4()),),
        )

    def _validate_existing_schema(
        self, connection: sqlite3.Connection, table_names: set[str]
    ) -> None:
        if table_names not in {_EXPECTED_TABLES, _LEGACY_TABLES}:
            raise GroupStoreError("GroupStore schema is partial or corrupt")
        raw_version = self._metadata_value_from_connection(connection, "schema_version")
        if raw_version == "1":
            self._migrate_v1_to_v2(connection)
            raw_version = "2"
        if raw_version == "2":
            self._migrate_v2_to_v3(connection)
            raw_version = "3"
        if raw_version == "3":
            self._migrate_v3_to_v4(connection)
            raw_version = "4"
        if raw_version == "4":
            self._repair_early_v4(connection)
            self._migrate_v4_to_v5(connection)
            raw_version = "5"
        if raw_version == "5":
            self._migrate_v5_to_v6(connection)
            raw_version = "6"
        if raw_version == "6":
            self._migrate_v6_to_v7(connection)
        self._validated_schema_version(
            self._metadata_value_from_connection(connection, "schema_version")
        )
        self._validated_epoch(
            self._metadata_value_from_connection(connection, "journal_epoch")
        )
        self._validate_v7_columns(connection)
        self._validate_v7_values(connection)

    @staticmethod
    def _migrate_v1_to_v2(connection: sqlite3.Connection) -> None:
        connection.execute(
            "ALTER TABLE group_rooms ADD COLUMN max_reply_rounds INTEGER NOT NULL DEFAULT 3"
        )
        connection.execute(
            "ALTER TABLE group_agents ADD COLUMN reply_without_mention INTEGER NOT NULL DEFAULT 0"
        )
        connection.execute(
            "ALTER TABLE group_messages ADD COLUMN visible INTEGER NOT NULL DEFAULT 1"
        )
        connection.execute(
            "ALTER TABLE group_agent_runs ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'mentioned'"
        )
        connection.execute(
            "UPDATE group_meta SET value = '2' WHERE key = 'schema_version'"
        )

    @staticmethod
    def _migrate_v2_to_v3(connection: sqlite3.Connection) -> None:
        connection.execute("ALTER TABLE group_agents ADD COLUMN model_override TEXT")
        connection.execute("ALTER TABLE group_agents ADD COLUMN provider_override TEXT")
        connection.execute(
            "ALTER TABLE group_agents ADD COLUMN reasoning_effort_override TEXT"
        )
        connection.execute(
            "ALTER TABLE group_agents ADD COLUMN fast_mode_override INTEGER"
        )
        connection.execute(
            "ALTER TABLE group_agents ADD COLUMN session_config_json TEXT"
        )
        connection.execute(
            """UPDATE group_agents SET session_config_json = ?
            WHERE stored_session_id IS NOT NULL""",
            (_DEFAULT_SESSION_CONFIGURATION_JSON,),
        )
        connection.execute(
            "UPDATE group_meta SET value = '3' WHERE key = 'schema_version'"
        )

    @staticmethod
    def _migrate_v3_to_v4(connection: sqlite3.Connection) -> None:
        """Split legacy root chains into writable topics without touching rooms/Agents."""
        orphan_run = connection.execute(
            """SELECT run.id FROM group_agent_runs AS run
            LEFT JOIN group_messages AS trigger ON trigger.id = run.trigger_message_id
            LEFT JOIN group_messages AS response ON response.id = run.response_message_id
            WHERE trigger.id IS NULL OR response.id IS NULL LIMIT 1"""
        ).fetchone()
        if orphan_run is not None:
            raise GroupStoreError("GroupStore run messages are orphaned")
        orphan_interaction = connection.execute(
            """SELECT interaction.id FROM group_interactions AS interaction
            LEFT JOIN group_agent_runs AS run ON run.id = interaction.run_id
            WHERE run.id IS NULL LIMIT 1"""
        ).fetchone()
        if orphan_interaction is not None:
            raise GroupStoreError("GroupStore interaction run is orphaned")
        connection.execute(
            """CREATE TABLE group_topics (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(room_id, id)
            )"""
        )
        roots = connection.execute(
            """SELECT messages.room_id, messages.root_message_id,
                      MIN(messages.created_at) AS created_at,
                      COALESCE(
                        MAX(CASE WHEN messages.visible = 1
                                 THEN messages.updated_at END),
                        MAX(messages.updated_at)
                      ) AS updated_at,
                      COALESCE(
                        (SELECT human.content FROM group_messages AS human
                         WHERE human.room_id = messages.room_id
                           AND human.root_message_id = messages.root_message_id
                           AND human.sender_kind = 'human'
                         ORDER BY human.seq ASC LIMIT 1),
                        (SELECT visible.content FROM group_messages AS visible
                         WHERE visible.room_id = messages.room_id
                           AND visible.root_message_id = messages.root_message_id
                           AND visible.visible = 1
                         ORDER BY visible.seq ASC LIMIT 1),
                        '话题'
                      ) AS title
               FROM group_messages AS messages
               GROUP BY messages.room_id, messages.root_message_id
               ORDER BY MIN(messages.seq) ASC"""
        ).fetchall()
        for root in roots:
            title = " ".join(str(root["title"]).split()).strip()
            if not title:
                title = "话题"
            connection.execute(
                """INSERT INTO group_topics
                (id, room_id, title, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)""",
                (
                    root["root_message_id"],
                    root["room_id"],
                    title[:_TOPIC_TITLE_LENGTH],
                    root["created_at"],
                    root["updated_at"],
                ),
            )

        connection.execute(
            """CREATE TABLE group_messages_v4 (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
                topic_id TEXT NOT NULL,
                sender_kind TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                reply_to_message_id TEXT,
                client_message_id TEXT UNIQUE,
                content TEXT NOT NULL DEFAULT '',
                reasoning TEXT NOT NULL DEFAULT '',
                tool_state_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                visible INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(room_id, topic_id)
                    REFERENCES group_topics(room_id, id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            """INSERT INTO group_messages_v4
            (seq, id, room_id, topic_id, sender_kind, sender_id, sender_name,
             root_message_id, reply_to_message_id, client_message_id, content,
             reasoning, tool_state_json, status, error, visible, created_at, updated_at)
            SELECT seq, id, room_id, root_message_id, sender_kind, sender_id,
                   sender_name, root_message_id, reply_to_message_id,
                   client_message_id, content, reasoning, tool_state_json,
                   status, error, visible, created_at, updated_at
            FROM group_messages ORDER BY seq ASC"""
        )
        connection.execute(
            """CREATE TABLE group_agent_runs_v4 (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                topic_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                trigger_message_id TEXT NOT NULL,
                response_message_id TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                depth INTEGER NOT NULL,
                reply_mode TEXT NOT NULL DEFAULT 'mentioned',
                status TEXT NOT NULL,
                runtime_session_id TEXT,
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(room_id, topic_id)
                    REFERENCES group_topics(room_id, id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            """INSERT INTO group_agent_runs_v4
            (id, room_id, topic_id, agent_id, trigger_message_id,
             response_message_id, root_message_id, depth, reply_mode, status,
             runtime_session_id, error, created_at, updated_at)
            SELECT id, room_id, root_message_id, agent_id, trigger_message_id,
                   response_message_id, root_message_id, depth, reply_mode,
                   status, runtime_session_id, error, created_at, updated_at
            FROM group_agent_runs"""
        )
        connection.execute(
            """CREATE TABLE group_interactions_v4 (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                topic_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                resolved_at REAL,
                FOREIGN KEY(room_id, topic_id)
                    REFERENCES group_topics(room_id, id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            """INSERT INTO group_interactions_v4
            (id, room_id, topic_id, agent_id, run_id, kind, payload_json,
             status, created_at, resolved_at)
            SELECT interaction.id, interaction.room_id, run.topic_id,
                   interaction.agent_id, interaction.run_id, interaction.kind,
                   interaction.payload_json, interaction.status,
                   interaction.created_at, interaction.resolved_at
            FROM group_interactions AS interaction
            JOIN group_agent_runs_v4 AS run ON run.id = interaction.run_id"""
        )
        connection.execute("DROP TABLE group_interactions")
        connection.execute("DROP TABLE group_agent_runs")
        connection.execute("DROP TABLE group_messages")
        connection.execute("ALTER TABLE group_messages_v4 RENAME TO group_messages")
        connection.execute(
            "ALTER TABLE group_agent_runs_v4 RENAME TO group_agent_runs"
        )
        connection.execute(
            "ALTER TABLE group_interactions_v4 RENAME TO group_interactions"
        )
        connection.execute(
            """CREATE TABLE group_agent_topic_state (
                agent_id TEXT NOT NULL REFERENCES group_agents(id) ON DELETE CASCADE,
                topic_id TEXT NOT NULL REFERENCES group_topics(id) ON DELETE CASCADE,
                last_context_message_seq INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(agent_id, topic_id)
            )"""
        )
        connection.execute(
            """INSERT INTO group_agent_topic_state
            (agent_id, topic_id, last_context_message_seq, created_at, updated_at)
            SELECT agent.id, topic.id,
                   COALESCE((
                     SELECT MAX(message.seq) FROM group_messages AS message
                     WHERE message.topic_id = topic.id
                       AND message.seq <= agent.last_context_message_seq
                   ), 0),
                   topic.created_at,
                   CASE WHEN agent.updated_at > topic.updated_at
                        THEN agent.updated_at ELSE topic.updated_at END
            FROM group_agents AS agent
            JOIN group_topics AS topic ON topic.room_id = agent.room_id"""
        )

        def add_topic_ids(value: object) -> object:
            if isinstance(value, list):
                return [add_topic_ids(item) for item in value]
            if not isinstance(value, dict):
                return value
            rewritten = {key: add_topic_ids(item) for key, item in value.items()}
            identity = rewritten.get("id")
            table: str | None = None
            if isinstance(identity, str):
                if "senderKind" in rewritten:
                    table = "group_messages"
                elif "triggerMessageId" in rewritten:
                    table = "group_agent_runs"
                elif "runId" in rewritten and "kind" in rewritten:
                    table = "group_interactions"
            if table is not None and "topicId" not in rewritten:
                row = connection.execute(
                    f"SELECT topic_id FROM {table} WHERE id = ?", (identity,)
                ).fetchone()
                if row is not None:
                    rewritten["topicId"] = row["topic_id"]
            return rewritten

        for ledger in connection.execute(
            "SELECT request_id, operation, response_json FROM group_idempotency"
        ).fetchall():
            try:
                response = json.loads(ledger["response_json"])
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                raise GroupStoreError("Stored idempotency response is corrupt") from error
            rewritten_value = add_topic_ids(response)
            if (
                GroupStore._interaction_response_operation(ledger["operation"])
                is not None
                and isinstance(rewritten_value, dict)
                and rewritten_value.get("state") == "failed"
                and isinstance(rewritten_value.get("run"), dict)
            ):
                rewritten_value["run"].pop("topicId", None)
            rewritten = GroupStore._canonical_json(rewritten_value)
            if rewritten != ledger["response_json"]:
                connection.execute(
                    "UPDATE group_idempotency SET response_json = ? WHERE request_id = ?",
                    (rewritten, ledger["request_id"]),
                )
        for event in connection.execute(
            """SELECT cursor, payload_json FROM group_events
            WHERE event_type IN ('message.upsert', 'run.updated',
                                 'interaction.requested', 'interaction.resolved')"""
        ).fetchall():
            try:
                payload = json.loads(event["payload_json"])
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                raise GroupStoreError("Stored event is corrupt") from error
            rewritten = GroupStore._canonical_json(add_topic_ids(payload))
            if rewritten != event["payload_json"]:
                connection.execute(
                    "UPDATE group_events SET payload_json = ? WHERE cursor = ?",
                    (rewritten, event["cursor"]),
                )
        connection.execute(
            "UPDATE group_meta SET value = '4' WHERE key = 'schema_version'"
        )

    @staticmethod
    def _topic_foreign_key_kind(
        connection: sqlite3.Connection, table: str
    ) -> str:
        foreign_keys = list(connection.execute(f"PRAGMA foreign_key_list({table})"))
        grouped: dict[int, list[sqlite3.Row]] = {}
        for foreign_key in foreign_keys:
            grouped.setdefault(int(foreign_key["id"]), []).append(foreign_key)
        for foreign_key_rows in grouped.values():
            if foreign_key_rows[0]["table"] != "group_topics" or not all(
                row["on_delete"] == "CASCADE" for row in foreign_key_rows
            ):
                continue
            columns = [
                (row["from"], row["to"])
                for row in sorted(foreign_key_rows, key=lambda item: item["seq"])
            ]
            if columns == [("room_id", "room_id"), ("topic_id", "id")]:
                return "final"
            if columns == [("topic_id", "id")]:
                return "early"
        return "invalid"

    @classmethod
    def _repair_early_v4(cls, connection: sqlite3.Connection) -> None:
        """Upgrade the unpublished single-topic-FK v4 draft in one transaction."""
        tables = ("group_messages", "group_agent_runs", "group_interactions")
        foreign_key_kinds = {
            table: cls._topic_foreign_key_kind(connection, table) for table in tables
        }
        if all(kind == "final" for kind in foreign_key_kinds.values()):
            return
        if any(kind not in {"early", "final"} for kind in foreign_key_kinds.values()):
            raise GroupStoreError("GroupStore early v4 topic ownership is corrupt")

        invalid_queries = (
            """SELECT message.id FROM group_messages AS message
               LEFT JOIN group_topics AS topic ON topic.id = message.topic_id
               WHERE topic.id IS NULL OR topic.room_id != message.room_id LIMIT 1""",
            """SELECT run.id FROM group_agent_runs AS run
               LEFT JOIN group_topics AS topic ON topic.id = run.topic_id
               LEFT JOIN group_messages AS trigger
                 ON trigger.id = run.trigger_message_id
               LEFT JOIN group_messages AS response
                 ON response.id = run.response_message_id
               WHERE topic.id IS NULL OR topic.room_id != run.room_id
                  OR trigger.id IS NULL OR response.id IS NULL
                  OR trigger.room_id != run.room_id
                  OR response.room_id != run.room_id
                  OR trigger.topic_id != run.topic_id
                  OR response.topic_id != run.topic_id
               LIMIT 1""",
            """SELECT interaction.id FROM group_interactions AS interaction
               LEFT JOIN group_topics AS topic ON topic.id = interaction.topic_id
               LEFT JOIN group_agent_runs AS run ON run.id = interaction.run_id
               WHERE topic.id IS NULL OR topic.room_id != interaction.room_id
                  OR run.id IS NULL OR run.room_id != interaction.room_id
                  OR run.topic_id != interaction.topic_id
               LIMIT 1""",
        )
        if any(connection.execute(query).fetchone() is not None for query in invalid_queries):
            raise GroupStoreError("GroupStore early v4 ownership is corrupt")

        counts = {
            table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in tables
        }
        connection.execute(
            """CREATE TABLE group_messages_v4_repair (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
                topic_id TEXT NOT NULL,
                sender_kind TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                reply_to_message_id TEXT,
                client_message_id TEXT UNIQUE,
                content TEXT NOT NULL DEFAULT '',
                reasoning TEXT NOT NULL DEFAULT '',
                tool_state_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                visible INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(room_id, topic_id)
                    REFERENCES group_topics(room_id, id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            """INSERT INTO group_messages_v4_repair
            (seq, id, room_id, topic_id, sender_kind, sender_id, sender_name,
             root_message_id, reply_to_message_id, client_message_id, content,
             reasoning, tool_state_json, status, error, visible, created_at, updated_at)
            SELECT seq, id, room_id, topic_id, sender_kind, sender_id, sender_name,
                   root_message_id, reply_to_message_id, client_message_id, content,
                   reasoning, tool_state_json, status, error, visible,
                   created_at, updated_at
            FROM group_messages ORDER BY seq ASC"""
        )
        connection.execute(
            """CREATE TABLE group_agent_runs_v4_repair (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                topic_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                trigger_message_id TEXT NOT NULL,
                response_message_id TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                depth INTEGER NOT NULL,
                reply_mode TEXT NOT NULL DEFAULT 'mentioned',
                status TEXT NOT NULL,
                runtime_session_id TEXT,
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(room_id, topic_id)
                    REFERENCES group_topics(room_id, id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            """INSERT INTO group_agent_runs_v4_repair
            (id, room_id, topic_id, agent_id, trigger_message_id,
             response_message_id, root_message_id, depth, reply_mode, status,
             runtime_session_id, error, created_at, updated_at)
            SELECT id, room_id, topic_id, agent_id, trigger_message_id,
                   response_message_id, root_message_id, depth, reply_mode,
                   status, runtime_session_id, error, created_at, updated_at
            FROM group_agent_runs"""
        )
        connection.execute(
            """CREATE TABLE group_interactions_v4_repair (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                topic_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                resolved_at REAL,
                FOREIGN KEY(room_id, topic_id)
                    REFERENCES group_topics(room_id, id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            """INSERT INTO group_interactions_v4_repair
            (id, room_id, topic_id, agent_id, run_id, kind, payload_json,
             status, created_at, resolved_at)
            SELECT id, room_id, topic_id, agent_id, run_id, kind, payload_json,
                   status, created_at, resolved_at
            FROM group_interactions"""
        )
        connection.execute("DROP TABLE group_interactions")
        connection.execute("DROP TABLE group_agent_runs")
        connection.execute("DROP TABLE group_messages")
        connection.execute(
            "ALTER TABLE group_messages_v4_repair RENAME TO group_messages"
        )
        connection.execute(
            "ALTER TABLE group_agent_runs_v4_repair RENAME TO group_agent_runs"
        )
        connection.execute(
            "ALTER TABLE group_interactions_v4_repair RENAME TO group_interactions"
        )
        repaired_counts = {
            table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in tables
        }
        if repaired_counts != counts:
            raise GroupStoreError("GroupStore early v4 repair lost rows")

        for event in connection.execute(
            """SELECT cursor, payload_json FROM group_events
            WHERE event_type = 'agent.status'"""
        ).fetchall():
            try:
                payload = cls._load_json(event["payload_json"])
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                raise GroupStoreError("Stored event is corrupt") from error
            if not isinstance(payload, dict):
                raise GroupStoreError("Stored event is corrupt")
            payload.pop("topicId", None)
            encoded = cls._canonical_json(payload)
            if encoded != event["payload_json"]:
                connection.execute(
                    "UPDATE group_events SET payload_json = ? WHERE cursor = ?",
                    (encoded, event["cursor"]),
                )
        for ledger in connection.execute(
            "SELECT request_id, operation, response_json FROM group_idempotency"
        ).fetchall():
            if cls._interaction_response_operation(ledger["operation"]) is None:
                continue
            try:
                response = cls._load_json(ledger["response_json"])
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                raise GroupStoreError("Stored interaction response is corrupt") from error
            if not isinstance(response, dict):
                raise GroupStoreError("Stored interaction response is corrupt")
            run = response.get("run")
            if response.get("state") != "failed" or not isinstance(run, dict):
                continue
            run.pop("topicId", None)
            encoded = cls._canonical_json(response)
            if encoded != ledger["response_json"]:
                connection.execute(
                    """UPDATE group_idempotency SET response_json = ?
                    WHERE request_id = ?""",
                    (encoded, ledger["request_id"]),
                )
        connection.execute(
            """UPDATE group_topics AS topic
            SET updated_at = COALESCE(
                (SELECT MAX(message.updated_at) FROM group_messages AS message
                 WHERE message.room_id = topic.room_id
                   AND message.topic_id = topic.id AND message.visible = 1),
                (SELECT MAX(message.updated_at) FROM group_messages AS message
                 WHERE message.room_id = topic.room_id
                   AND message.topic_id = topic.id),
                topic.created_at
            )"""
        )

    @classmethod
    def _migrate_v4_to_v5(cls, connection: sqlite3.Connection) -> None:
        """Assign one durable host per room and freeze required-reply run state."""
        connection.execute(
            "ALTER TABLE group_agents ADD COLUMN is_host INTEGER NOT NULL DEFAULT 0"
        )
        connection.execute(
            """ALTER TABLE group_agent_runs
            ADD COLUMN required_reply INTEGER NOT NULL DEFAULT 0"""
        )
        for room in connection.execute(
            "SELECT id FROM group_rooms ORDER BY created_at ASC, id ASC"
        ).fetchall():
            host = connection.execute(
                """SELECT id FROM group_agents WHERE room_id = ?
                ORDER BY CASE
                    WHEN enabled = 1 AND reply_without_mention = 1 THEN 0
                    WHEN enabled = 1 THEN 1
                    ELSE 2
                END, created_at ASC, id ASC
                LIMIT 1""",
                (room["id"],),
            ).fetchone()
            if host is None:
                raise GroupStoreError("GroupStore room has no host candidate")
            connection.execute(
                "UPDATE group_agents SET is_host = 1 WHERE id = ? AND room_id = ?",
                (host["id"], room["id"]),
            )

        def add_host_flags(value: object) -> object:
            if isinstance(value, list):
                return [add_host_flags(item) for item in value]
            if not isinstance(value, dict):
                return value
            rewritten = {key: add_host_flags(item) for key, item in value.items()}
            identity = rewritten.get("id")
            room_id = rewritten.get("roomId")
            if (
                isinstance(identity, str)
                and isinstance(room_id, str)
                and {"profile", "displayName", "replyWithoutMention"}
                <= rewritten.keys()
            ):
                agent = connection.execute(
                    "SELECT is_host FROM group_agents WHERE id = ? AND room_id = ?",
                    (identity, room_id),
                ).fetchone()
                rewritten["isHost"] = bool(agent["is_host"]) if agent else False
            return rewritten

        for ledger in connection.execute(
            "SELECT request_id, response_json FROM group_idempotency"
        ).fetchall():
            try:
                response = cls._load_json(ledger["response_json"])
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                raise GroupStoreError("Stored idempotency response is corrupt") from error
            rewritten = cls._canonical_json(add_host_flags(response))
            if rewritten != ledger["response_json"]:
                connection.execute(
                    """UPDATE group_idempotency SET response_json = ?
                    WHERE request_id = ?""",
                    (rewritten, ledger["request_id"]),
                )
        for event in connection.execute(
            "SELECT cursor, payload_json FROM group_events"
        ).fetchall():
            try:
                payload = cls._load_json(event["payload_json"])
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                raise GroupStoreError("Stored event is corrupt") from error
            rewritten = cls._canonical_json(add_host_flags(payload))
            if rewritten != event["payload_json"]:
                connection.execute(
                    "UPDATE group_events SET payload_json = ? WHERE cursor = ?",
                    (rewritten, event["cursor"]),
                )
        connection.execute(
            "UPDATE group_meta SET value = '5' WHERE key = 'schema_version'"
        )

    @staticmethod
    def _migrate_v5_to_v6(connection: sqlite3.Connection) -> None:
        """Add immutable configured and terminal effective model attribution."""
        for column in (
            "requested_model",
            "requested_provider",
            "actual_model",
            "actual_provider",
        ):
            connection.execute(
                f"ALTER TABLE group_agent_runs ADD COLUMN {column} TEXT"
            )
        connection.execute(
            "UPDATE group_meta SET value = '6' WHERE key = 'schema_version'"
        )

    @staticmethod
    def _migrate_v6_to_v7(connection: sqlite3.Connection) -> None:
        """Add requested and effective reasoning/fast execution attribution."""
        for definition in (
            "requested_reasoning_effort TEXT",
            "requested_fast_mode INTEGER",
            "actual_reasoning_effort TEXT",
            "actual_fast_mode INTEGER",
        ):
            connection.execute(
                f"ALTER TABLE group_agent_runs ADD COLUMN {definition}"
            )
        connection.execute(
            "UPDATE group_meta SET value = '7' WHERE key = 'schema_version'"
        )

    @staticmethod
    def _validate_v7_columns(connection: sqlite3.Connection) -> None:
        expected_columns = {
            "group_meta": {"key", "value"},
            "group_rooms": {"id", "name", "cwd", "max_reply_rounds", "created_at", "updated_at", "archived"},
            "group_topics": {"id", "room_id", "title", "created_at", "updated_at"},
            "group_agents": {"id", "room_id", "profile", "display_name", "display_name_key", "description", "stored_session_id", "last_context_message_seq", "enabled", "reply_without_mention", "is_host", "model_override", "provider_override", "reasoning_effort_override", "fast_mode_override", "session_config_json", "created_at", "updated_at"},
            "group_agent_topic_state": {"agent_id", "topic_id", "last_context_message_seq", "created_at", "updated_at"},
            "group_messages": {"seq", "id", "room_id", "topic_id", "sender_kind", "sender_id", "sender_name", "root_message_id", "reply_to_message_id", "client_message_id", "content", "reasoning", "tool_state_json", "status", "error", "visible", "created_at", "updated_at"},
            "group_agent_runs": {"id", "room_id", "topic_id", "agent_id", "trigger_message_id", "response_message_id", "root_message_id", "depth", "reply_mode", "required_reply", "status", "runtime_session_id", "requested_model", "requested_provider", "requested_reasoning_effort", "requested_fast_mode", "actual_model", "actual_provider", "actual_reasoning_effort", "actual_fast_mode", "error", "created_at", "updated_at"},
            "group_interactions": {"id", "room_id", "topic_id", "agent_id", "run_id", "kind", "payload_json", "status", "created_at", "resolved_at"},
            "group_events": {"cursor", "epoch", "room_id", "event_type", "payload_json", "created_at"},
            "group_idempotency": {"request_id", "operation", "request_hash", "response_json", "created_at"},
        }
        exact_specs = {
            ("group_rooms", "max_reply_rounds"): ("INTEGER", 1, "3"),
            ("group_agents", "reply_without_mention"): ("INTEGER", 1, "0"),
            ("group_agents", "is_host"): ("INTEGER", 1, "0"),
            ("group_messages", "visible"): ("INTEGER", 1, "1"),
            ("group_agent_runs", "reply_mode"): ("TEXT", 1, "'mentioned'"),
            ("group_agent_runs", "required_reply"): ("INTEGER", 1, "0"),
            ("group_messages", "topic_id"): ("TEXT", 1, None),
            ("group_agent_runs", "topic_id"): ("TEXT", 1, None),
            ("group_interactions", "topic_id"): ("TEXT", 1, None),
            ("group_agent_topic_state", "last_context_message_seq"): ("INTEGER", 1, "0"),
        }
        for table, required in expected_columns.items():
            rows = list(connection.execute(f"PRAGMA table_info({table})"))
            columns = {row["name"]: row for row in rows}
            if set(columns) != required:
                raise GroupStoreError("GroupStore schema is partial or corrupt")
            for (target_table, name), spec in exact_specs.items():
                if target_table != table:
                    continue
                row = columns[name]
                actual = (str(row["type"]).upper(), int(row["notnull"]), row["dflt_value"])
                if actual != spec:
                    raise GroupStoreError("GroupStore schema is partial or corrupt")
        for table in ("group_messages", "group_agent_runs", "group_interactions"):
            if GroupStore._topic_foreign_key_kind(connection, table) != "final":
                raise GroupStoreError("GroupStore schema is partial or corrupt")

    @staticmethod
    def _validate_v7_values(connection: sqlite3.Connection) -> None:
        invalid_value_queries = (
            f"""SELECT 1 FROM group_rooms
                WHERE typeof(max_reply_rounds) != 'integer'
                   OR (max_reply_rounds != -1 AND
                       (max_reply_rounds < 1 OR
                        max_reply_rounds > {MAX_FINITE_REPLY_ROUNDS}))
                LIMIT 1""",
            """SELECT 1 FROM group_agents
                WHERE typeof(reply_without_mention) != 'integer'
                   OR reply_without_mention NOT IN (0, 1)
                LIMIT 1""",
            """SELECT 1 FROM group_agents
                WHERE typeof(is_host) != 'integer' OR is_host NOT IN (0, 1)
                LIMIT 1""",
            """SELECT 1 FROM group_rooms AS room
                LEFT JOIN group_agents AS agent ON agent.room_id = room.id
                GROUP BY room.id
                HAVING SUM(CASE WHEN agent.is_host = 1 THEN 1 ELSE 0 END) != 1
                LIMIT 1""",
            """SELECT 1 FROM group_agents AS host
                WHERE host.is_host = 1 AND host.enabled = 0
                  AND EXISTS (
                    SELECT 1 FROM group_agents AS candidate
                    WHERE candidate.room_id = host.room_id
                      AND candidate.enabled = 1 AND candidate.id != host.id
                  )
                LIMIT 1""",
            """SELECT 1 FROM group_agents
                WHERE fast_mode_override IS NOT NULL
                  AND (typeof(fast_mode_override) != 'integer'
                       OR fast_mode_override NOT IN (0, 1))
                LIMIT 1""",
            """SELECT 1 FROM group_agents
                WHERE reasoning_effort_override IS NOT NULL
                  AND reasoning_effort_override NOT IN
                    ('none','minimal','low','medium','high','xhigh','max','ultra')
                LIMIT 1""",
            """SELECT 1 FROM group_messages
                WHERE typeof(visible) != 'integer'
                   OR visible NOT IN (0, 1)
                LIMIT 1""",
            """SELECT 1 FROM group_agent_runs
                WHERE typeof(reply_mode) != 'text'
                   OR reply_mode NOT IN ('mentioned', 'automatic')
                LIMIT 1""",
            """SELECT 1 FROM group_agent_runs
                WHERE typeof(required_reply) != 'integer'
                   OR required_reply NOT IN (0, 1)
                   OR (required_reply = 1 AND reply_mode != 'automatic')
                LIMIT 1""",
            """SELECT 1 FROM group_agent_runs
                WHERE (requested_model IS NULL) != (requested_provider IS NULL)
                   OR (actual_model IS NULL) != (actual_provider IS NULL)
                   OR length(COALESCE(requested_model, '')) > 4096
                   OR length(COALESCE(requested_provider, '')) > 4096
                   OR length(COALESCE(actual_model, '')) > 4096
                   OR length(COALESCE(actual_provider, '')) > 4096
                LIMIT 1""",
            """SELECT 1 FROM group_agent_runs
                WHERE (requested_reasoning_effort IS NOT NULL
                       AND requested_reasoning_effort NOT IN
                         ('none','minimal','low','medium','high','xhigh','max','ultra'))
                   OR (actual_reasoning_effort IS NOT NULL
                       AND actual_reasoning_effort NOT IN
                         ('none','minimal','low','medium','high','xhigh','max','ultra'))
                   OR (requested_fast_mode IS NOT NULL
                       AND (typeof(requested_fast_mode) != 'integer'
                            OR requested_fast_mode NOT IN (0, 1)))
                   OR (actual_fast_mode IS NOT NULL
                       AND (typeof(actual_fast_mode) != 'integer'
                            OR actual_fast_mode NOT IN (0, 1)))
                LIMIT 1""",
            """SELECT 1 FROM group_agent_runs AS run
                JOIN group_messages AS response
                  ON response.id = run.response_message_id
                WHERE run.required_reply = 1 AND response.visible != 1
                LIMIT 1""",
            """SELECT 1 FROM group_agent_topic_state
                WHERE typeof(last_context_message_seq) != 'integer'
                   OR last_context_message_seq < 0
                LIMIT 1""",
            """SELECT 1 FROM group_messages AS message
                LEFT JOIN group_topics AS topic ON topic.id = message.topic_id
                WHERE topic.id IS NULL OR topic.room_id != message.room_id
                LIMIT 1""",
            """SELECT 1 FROM group_agent_runs AS run
                LEFT JOIN group_topics AS topic ON topic.id = run.topic_id
                LEFT JOIN group_messages AS trigger ON trigger.id = run.trigger_message_id
                LEFT JOIN group_messages AS response ON response.id = run.response_message_id
                WHERE topic.id IS NULL OR topic.room_id != run.room_id
                   OR trigger.id IS NULL OR response.id IS NULL
                   OR trigger.topic_id != run.topic_id
                   OR response.topic_id != run.topic_id
                LIMIT 1""",
            """SELECT 1 FROM group_interactions AS interaction
                LEFT JOIN group_agent_runs AS run ON run.id = interaction.run_id
                WHERE run.id IS NULL OR interaction.topic_id != run.topic_id
                   OR interaction.room_id != run.room_id
                LIMIT 1""",
            """SELECT 1 FROM group_agent_topic_state AS state
                LEFT JOIN group_agents AS agent ON agent.id = state.agent_id
                LEFT JOIN group_topics AS topic ON topic.id = state.topic_id
                WHERE agent.id IS NULL OR topic.id IS NULL
                   OR agent.room_id != topic.room_id
                LIMIT 1""",
        )
        for query in invalid_value_queries:
            if connection.execute(query).fetchone() is not None:
                raise GroupStoreError("GroupStore stored values are corrupt")
        for table, column in (
            ("group_topics", "id"),
            ("group_topics", "room_id"),
            ("group_messages", "topic_id"),
            ("group_agent_runs", "topic_id"),
            ("group_interactions", "topic_id"),
        ):
            for row in connection.execute(f"SELECT {column} AS value FROM {table}"):
                try:
                    canonical = str(uuid.UUID(row["value"]))
                except (TypeError, ValueError, AttributeError) as error:
                    raise GroupStoreError("GroupStore stored values are corrupt") from error
                if row["value"] != canonical:
                    raise GroupStoreError("GroupStore stored values are corrupt")

    @staticmethod
    def _ensure_indexes(connection: sqlite3.Connection) -> None:
        """Repair v1 operational indexes without a schema-version migration."""

        def canonical_index_sql(value: str) -> str:
            without_guard = re.sub(
                r"\bIF\s+NOT\s+EXISTS\b", "", value, flags=re.IGNORECASE
            )
            return " ".join(without_guard.split()).casefold()

        indexes = {
            "idx_group_rooms_ordering": (
                [("archived", 0), ("updated_at", 1), ("id", 1)],
                "group_rooms(archived, updated_at DESC, id DESC)",
            ),
            "idx_group_topics_room_ordering": (
                [("room_id", 0), ("updated_at", 1), ("id", 1)],
                "group_topics(room_id, updated_at DESC, id DESC)",
            ),
            "idx_group_messages_room_seq": (
                [("room_id", 0), ("seq", 0)],
                "group_messages(room_id, seq)",
            ),
            "idx_group_messages_topic_seq": (
                [("topic_id", 0), ("seq", 0)],
                "group_messages(topic_id, seq)",
            ),
            "idx_group_agent_runs_room": (
                [("room_id", 0)],
                "group_agent_runs(room_id)",
            ),
            "idx_group_agent_runs_topic": (
                [("topic_id", 0)],
                "group_agent_runs(topic_id)",
            ),
            "idx_group_agent_runs_agent_status": (
                [("agent_id", 0), ("status", 0)],
                "group_agent_runs(agent_id, status)",
            ),
            "idx_group_agent_runs_room_status": (
                [("room_id", 0), ("status", 0)],
                "group_agent_runs(room_id, status)",
            ),
            "idx_group_agent_runs_status_order": (
                [("status", 0), ("created_at", 0), ("id", 0)],
                "group_agent_runs(status, created_at, id)",
            ),
            "idx_group_idempotency_operation": (
                [("operation", 0)],
                "group_idempotency(operation)",
            ),
            "idx_group_interactions_run_status_kind": (
                [("run_id", 0), ("status", 0), ("kind", 0)],
                "group_interactions(run_id, status, kind)",
            ),
            "idx_group_interactions_room_agent": (
                [("room_id", 0), ("agent_id", 0)],
                "group_interactions(room_id, agent_id)",
            ),
            "idx_group_interactions_topic": (
                [("topic_id", 0)],
                "group_interactions(topic_id)",
            ),
        }
        for name, (expected, definition) in indexes.items():
            columns = [
                (row["name"], row["desc"])
                for row in connection.execute(f"PRAGMA index_xinfo({name})")
                if row["key"]
            ]
            stored = connection.execute(
                """SELECT sql FROM sqlite_master
                WHERE type = 'index' AND name = ?""",
                (name,),
            ).fetchone()
            expected_sql = canonical_index_sql(f"CREATE INDEX {name} ON {definition}")
            stored_sql = (
                None
                if stored is None or stored["sql"] is None
                else canonical_index_sql(stored["sql"])
            )
            if columns == expected and stored_sql == expected_sql:
                continue
            connection.execute(f"DROP INDEX IF EXISTS {name}")
            connection.execute(f"CREATE INDEX {name} ON {definition}")
        host_definition = """CREATE UNIQUE INDEX idx_group_agents_room_host
            ON group_agents(room_id) WHERE is_host = 1"""
        stored = connection.execute(
            """SELECT sql FROM sqlite_master
            WHERE type = 'index' AND name = ?""",
            ("idx_group_agents_room_host",),
        ).fetchone()
        expected_sql = canonical_index_sql(host_definition)
        stored_sql = (
            None
            if stored is None or stored["sql"] is None
            else canonical_index_sql(stored["sql"])
        )
        if stored_sql != expected_sql:
            connection.execute("DROP INDEX IF EXISTS idx_group_agents_room_host")
            try:
                connection.execute(host_definition)
            except sqlite3.IntegrityError as error:
                raise GroupStoreError("Room hosts are not unique") from error
        active_runtime_definition = """CREATE UNIQUE INDEX
            idx_group_agent_runs_active_runtime
            ON group_agent_runs(runtime_session_id)
            WHERE runtime_session_id IS NOT NULL
              AND status IN ('running', 'awaiting_input')"""
        stored = connection.execute(
            """SELECT sql FROM sqlite_master
            WHERE type = 'index' AND name = ?""",
            ("idx_group_agent_runs_active_runtime",),
        ).fetchone()
        expected_sql = canonical_index_sql(active_runtime_definition)
        stored_sql = (
            None
            if stored is None or stored["sql"] is None
            else canonical_index_sql(stored["sql"])
        )
        if stored_sql == expected_sql:
            return
        connection.execute("DROP INDEX IF EXISTS idx_group_agent_runs_active_runtime")
        try:
            connection.execute(active_runtime_definition)
        except sqlite3.IntegrityError as error:
            raise GroupStoreError("Active runtime sessions are not unique") from error

    @staticmethod
    def _user_table_names(connection: sqlite3.Connection) -> set[str]:
        return {
            row["name"]
            for row in connection.execute(
                """SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"""
            )
        }

    @staticmethod
    def _is_busy_or_locked(error: sqlite3.OperationalError) -> bool:
        message = str(error).lower()
        return "locked" in message or "busy" in message

    @staticmethod
    def _validated_schema_version(value: str) -> int:
        try:
            version = int(value)
        except (TypeError, ValueError) as error:
            raise GroupStoreError("GroupStore schema_version is corrupt") from error
        if value != str(SCHEMA_VERSION) or version != SCHEMA_VERSION:
            raise GroupStoreError("Unsupported or corrupt GroupStore schema_version")
        return version

    def _metadata_value(self, key: str) -> str:
        try:
            with self.connection() as connection:
                return self._metadata_value_from_connection(connection, key)
        except sqlite3.OperationalError as error:
            raise GroupStoreError("GroupStore is not initialized") from error

    @staticmethod
    def _metadata_value_from_connection(
        connection: sqlite3.Connection, key: str
    ) -> str:
        row = connection.execute(
            "SELECT value FROM group_meta WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            raise GroupStoreError(f"GroupStore metadata is missing {key}")
        return row["value"]

    @staticmethod
    def _validated_epoch(value: str) -> str:
        try:
            canonical = str(uuid.UUID(value))
        except (ValueError, AttributeError) as error:
            raise GroupStoreError("GroupStore journal_epoch is corrupt") from error
        if value != canonical:
            raise GroupStoreError("GroupStore journal_epoch is corrupt")
        return canonical

    @contextmanager
    def read_transaction(self) -> Iterator[sqlite3.Connection]:
        """Yield one consistent read snapshot and always close its connection."""
        with self.connection() as connection:
            connection.execute("BEGIN")
            try:
                yield connection
            except Exception:
                connection.execute("ROLLBACK")
                raise
            else:
                connection.execute("COMMIT")

    @contextmanager
    def write_transaction(self) -> Iterator[sqlite3.Connection]:
        """Yield one immediately-locked write transaction and always close it."""
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
            except Exception:
                connection.execute("ROLLBACK")
                raise
            else:
                connection.execute("COMMIT")

    def execute_idempotent(
        self,
        operation: str,
        request_id: str,
        payload: Mapping[str, object],
        action: Callable[[sqlite3.Connection], dict[str, object]],
    ) -> dict[str, object]:
        """Execute a mutation exactly once for the canonical request and payload."""
        canonical_request_id = self._canonical_uuid(request_id, "requestId")
        request_hash = hashlib.sha256(
            self._canonical_json(payload).encode()
        ).hexdigest()
        try:
            with self.write_transaction() as connection:
                existing = connection.execute(
                    """SELECT operation, request_hash, response_json FROM group_idempotency
                    WHERE request_id = ?""",
                    (canonical_request_id,),
                ).fetchone()
                if existing is not None:
                    if (
                        existing["operation"] != operation
                        or existing["request_hash"] != request_hash
                    ):
                        raise IdempotencyConflict(
                            "requestId was already used for a different request"
                        )
                    stored_response = existing["response_json"]
                    try:
                        response = self._load_json(stored_response)
                    except (ValueError, json.JSONDecodeError, TypeError) as error:
                        raise GroupStoreError(
                            "Stored idempotency response is corrupt"
                        ) from error
                    if (
                        not isinstance(response, dict)
                        or self._canonical_json(response) != stored_response
                    ):
                        raise GroupStoreError("Stored idempotency response is corrupt")
                    return response
                response = action(connection)
                response_json = self._canonical_json(response)
                connection.execute(
                    """INSERT INTO group_idempotency
                    (request_id, operation, request_hash, response_json, created_at)
                    VALUES (?, ?, ?, ?, ?)""",
                    (
                        canonical_request_id,
                        operation,
                        request_hash,
                        response_json,
                        self._now(),
                    ),
                )
                return response
        except sqlite3.IntegrityError as error:
            raise self._integrity_conflict(error) from error

    def create_room(self, command: Mapping[str, object]) -> dict[str, object]:
        command = self._command(
            command, {"requestId", "name", "cwd", "maxReplyRounds", "agents"}
        )
        request_id = self._command_request_id(command)

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            name = normalize_room_name(self._string(command, "name"))
            cwd = normalize_room_cwd(self._string(command, "cwd"))
            max_reply_rounds = normalize_max_reply_rounds(
                command.get("maxReplyRounds", DEFAULT_MAX_REPLY_ROUNDS)
            )
            agents = self._new_agents(command.get("agents"))
            now = self._now()
            room_id = str(uuid.uuid4())
            connection.execute(
                """INSERT INTO group_rooms
                (id, name, cwd, max_reply_rounds, created_at, updated_at, archived)
                VALUES (?, ?, ?, ?, ?, ?, 0)""",
                (room_id, name, cwd, max_reply_rounds, now, now),
            )
            for agent in agents:
                self._insert_agent(connection, room_id, agent, now)
            room = self._room_detail(connection, room_id, include_archived=True)
            self._append_event(
                connection, room_id, "room.created", room, created_at=now
            )
            return room

        return self.execute_idempotent("room.created", request_id, command, action)

    def get_room(
        self, room_id: str, *, include_archived: bool = False
    ) -> dict[str, object]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        with self.read_transaction() as connection:
            return self._room_detail(
                connection, canonical_room_id, include_archived=include_archived
            )

    def room_snapshot(self, room_id: str) -> dict[str, object]:
        """Read all state needed to recover one active room in one snapshot."""
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        with self.read_transaction() as connection:
            result = self._room_detail(
                connection, canonical_room_id, include_archived=False
            )
            run_rows = connection.execute(
                """SELECT * FROM group_agent_runs
                WHERE room_id = ? AND status IN ('queued', 'running', 'awaiting_input')
                ORDER BY created_at ASC, id ASC""",
                (canonical_room_id,),
            ).fetchall()
            interaction_rows = connection.execute(
                """SELECT * FROM group_interactions
                WHERE room_id = ? AND status = 'pending'
                ORDER BY created_at ASC, id ASC""",
                (canonical_room_id,),
            ).fetchall()
            cursor_row = connection.execute(
                "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM group_events"
            ).fetchone()

            status_priority = {
                "queued": 1,
                "running": 2,
                "awaiting_input": 3,
            }
            statuses: dict[str, str] = {}
            for run in run_rows:
                previous = statuses.get(run["agent_id"], "idle")
                if status_priority[run["status"]] > status_priority.get(previous, 0):
                    statuses[run["agent_id"]] = run["status"]
            for agent in result["agents"]:
                agent["status"] = statuses.get(agent["id"], "idle")

            result["runs"] = [self._run_wire(row) for row in run_rows]
            result["pendingInteractions"] = [
                self._interaction_wire(row) for row in interaction_rows
            ]
            result["latestCursor"] = int(cursor_row["cursor"])
            return result

    def list_rooms(self, *, limit: int, cursor: str | None) -> CursorPage:
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 100
        ):
            raise ValueError("limit must be an integer from 1 to 100")
        cursor_values = self._decode_cursor(cursor) if cursor is not None else None
        query = """SELECT id, name, cwd, max_reply_rounds, created_at, updated_at, archived,
            (SELECT COUNT(*) FROM group_agents WHERE room_id = group_rooms.id) AS agent_count,
            (SELECT COUNT(*) FROM group_topics WHERE room_id = group_rooms.id) AS topic_count
            FROM group_rooms WHERE archived = 0"""
        params: list[object] = []
        if cursor_values is not None:
            query += " AND ((updated_at < ?) OR (updated_at = ? AND id < ?))"
            params.extend((cursor_values[0], cursor_values[0], cursor_values[1]))
        query += " ORDER BY updated_at DESC, id DESC LIMIT ?"
        params.append(limit + 1)
        with self.connection() as connection:
            rows = connection.execute(query, params).fetchall()
        has_more = len(rows) > limit
        items = [self._room_summary(row) for row in rows[:limit]]
        next_cursor = None
        if has_more and items:
            last = rows[limit - 1]
            next_cursor = self._encode_cursor(last["updated_at"], last["id"])
        return CursorPage(items=items, next_cursor=next_cursor)

    def list_topics(
        self, room_id: str, *, limit: int, cursor: str | None
    ) -> CursorPage:
        """Return one room's topics in stable most-recently-active order."""
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 100
        ):
            raise ValueError("limit must be an integer from 1 to 100")
        cursor_values = (
            self._decode_topic_cursor(cursor, canonical_room_id)
            if cursor is not None
            else None
        )
        query = """SELECT topic.*,
            (SELECT COUNT(*) FROM group_messages AS counted
             WHERE counted.topic_id = topic.id AND counted.visible = 1)
                AS message_count,
            COALESCE((SELECT CASE WHEN TRIM(latest.content) != ''
                                  THEN latest.content ELSE latest.error END
             FROM group_messages AS latest
             WHERE latest.topic_id = topic.id AND latest.visible = 1
               AND (TRIM(latest.content) != '' OR TRIM(latest.error) != '')
             ORDER BY latest.seq DESC LIMIT 1), '') AS preview
            FROM group_topics AS topic WHERE topic.room_id = ?"""
        params: list[object] = [canonical_room_id]
        if cursor_values is not None:
            query += " AND ((topic.updated_at < ?) OR (topic.updated_at = ? AND topic.id < ?))"
            params.extend((cursor_values[0], cursor_values[0], cursor_values[1]))
        query += " ORDER BY topic.updated_at DESC, topic.id DESC LIMIT ?"
        params.append(limit + 1)
        with self.read_transaction() as connection:
            self._room_detail(connection, canonical_room_id, include_archived=True)
            rows = connection.execute(query, params).fetchall()
        has_more = len(rows) > limit
        items = [self._topic_summary(row) for row in rows[:limit]]
        next_cursor = None
        if has_more and items:
            last = rows[limit - 1]
            next_cursor = self._encode_topic_cursor(
                canonical_room_id, last["updated_at"], last["id"]
            )
        return CursorPage(items=items, next_cursor=next_cursor)

    def update_room(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        command = self._command(
            command, {"requestId", "name", "cwd", "maxReplyRounds"}
        )
        request_id = self._command_request_id(command)
        changes = {
            key for key in ("name", "cwd", "maxReplyRounds") if key in command
        }
        if not changes:
            raise ValueError("Room update requires name, cwd, or maxReplyRounds")

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            self._active_room(connection, canonical_room_id)
            values: list[object] = []
            assignments: list[str] = []
            if "name" in changes:
                assignments.append("name = ?")
                values.append(normalize_room_name(self._string(command, "name")))
            if "cwd" in changes:
                assignments.append("cwd = ?")
                values.append(normalize_room_cwd(self._string(command, "cwd")))
            if "maxReplyRounds" in changes:
                assignments.append("max_reply_rounds = ?")
                values.append(normalize_max_reply_rounds(command["maxReplyRounds"]))
            assignments.append("updated_at = ?")
            values.extend((self._now(), canonical_room_id))
            connection.execute(
                f"UPDATE group_rooms SET {', '.join(assignments)} WHERE id = ?", values
            )
            room = self._room_detail(
                connection, canonical_room_id, include_archived=True
            )
            self._append_event(connection, canonical_room_id, "room.updated", room)
            return room

        return self.execute_idempotent(
            "room.updated",
            request_id,
            self._scoped_payload(command, canonical_room_id),
            action,
        )

    def archive_room(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        return self.archive_room_with_runtime_targets(room_id, command)["result"]

    def archive_room_with_runtime_targets(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        command = self._command(command, {"requestId"})
        request_id = self._command_request_id(command)

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            self._active_room(connection, canonical_room_id)
            now = self._now()
            interrupted = self._interrupt_runs_for_scope(
                connection,
                room_id=canonical_room_id,
                reason="Room archived",
                now=now,
            )
            connection.execute(
                "UPDATE group_rooms SET archived = 1, updated_at = ? WHERE id = ?",
                (now, canonical_room_id),
            )
            room = self._room_detail(
                connection, canonical_room_id, include_archived=True
            )
            self._append_event(
                connection, canonical_room_id, "room.deleted", room, created_at=now
            )
            return {
                "result": room,
                "runtimeSessionIds": interrupted["runtimeSessionIds"],
            }

        response = self.execute_idempotent(
            "room.deleted",
            request_id,
            self._scoped_payload(command, canonical_room_id),
            action,
        )
        return self._runtime_envelope(response)

    def add_agent(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        command = self._command(
            command,
            {
                "requestId",
                "profile",
                "displayName",
                "description",
                "replyWithoutMention",
                "isHost",
                "model",
                "provider",
                "reasoningEffort",
                "fastMode",
            },
        )
        request_id = self._command_request_id(command)

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            self._active_room(connection, canonical_room_id)
            count = connection.execute(
                "SELECT COUNT(*) FROM group_agents WHERE room_id = ?",
                (canonical_room_id,),
            ).fetchone()[0]
            if count >= MAX_AGENTS_PER_ROOM:
                raise GroupConflictError(
                    "Room has reached the maximum number of agents"
                )
            agent = self._new_agent(
                {
                    key: command[key]
                    for key in (
                        "profile",
                        "displayName",
                        "description",
                        "replyWithoutMention",
                        "isHost",
                        "model",
                        "provider",
                        "reasoningEffort",
                        "fastMode",
                    )
                    if key in command
                }
            )
            now = self._now()
            requested_host = bool(agent["is_host"])
            agent["is_host"] = False
            agent_id = self._insert_agent(connection, canonical_room_id, agent, now)
            current_host = self._room_host(connection, canonical_room_id)
            switched: tuple[dict[str, object], dict[str, object]] | None = None
            if requested_host or not bool(current_host["enabled"]):
                switched = self._switch_host(
                    connection, canonical_room_id, agent_id, now=now
                )
            result = self._agent_detail(connection, canonical_room_id, agent_id)
            connection.execute(
                "UPDATE group_rooms SET updated_at = ? WHERE id = ?",
                (now, canonical_room_id),
            )
            if switched is not None:
                self._append_event(
                    connection,
                    canonical_room_id,
                    "agent.updated",
                    switched[0],
                    created_at=now,
                )
            self._append_event(
                connection,
                canonical_room_id,
                "agent.created",
                result,
                created_at=now,
            )
            self._append_room_updated_summary(
                connection, canonical_room_id, created_at=now
            )
            return result

        return self.execute_idempotent(
            "agent.created",
            request_id,
            self._scoped_payload(command, canonical_room_id),
            action,
        )

    def update_agent(
        self, room_id: str, agent_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        return self.update_agent_with_runtime_targets(room_id, agent_id, command)[
            "result"
        ]

    def update_agent_with_runtime_targets(
        self, room_id: str, agent_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        canonical_agent_id = self._canonical_uuid(agent_id, "agentId")
        command = self._command(
            command,
            {
                "requestId",
                "displayName",
                "description",
                "enabled",
                "replyWithoutMention",
                "isHost",
                "model",
                "provider",
                "reasoningEffort",
                "fastMode",
            },
        )
        request_id = self._command_request_id(command)
        changes = {
            key
            for key in (
                "displayName",
                "description",
                "enabled",
                "replyWithoutMention",
                "isHost",
                "model",
                "provider",
                "reasoningEffort",
                "fastMode",
            )
            if key in command
        }
        if not changes:
            raise ValueError(
                "Agent update requires a mutable agent field"
            )
        model_changes = changes & {"model", "provider"}
        if model_changes and model_changes != {"model", "provider"}:
            raise ValueError("model and provider must be updated together")
        if model_changes and (
            (command["model"] is None) != (command["provider"] is None)
        ):
            raise ValueError("model and provider must both be set or both be null")

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            self._active_room(connection, canonical_room_id)
            previous = self._owned_agent(
                connection, canonical_room_id, canonical_agent_id
            )
            requested_host = command.get("isHost")
            if requested_host is not None and not isinstance(requested_host, bool):
                raise ValueError("isHost must be a boolean")
            if requested_host is False and bool(previous["is_host"]):
                raise GroupConflictError(
                    "Current host cannot be cleared without selecting a replacement"
                )
            if requested_host is True and command.get("enabled") is False:
                raise GroupConflictError("Host Agent must be enabled")
            replacement_id: str | None = None
            if (
                bool(previous["is_host"])
                and command.get("enabled") is False
                and bool(previous["enabled"])
            ):
                replacement = self._first_enabled_host_candidate(
                    connection,
                    canonical_room_id,
                    exclude_agent_id=canonical_agent_id,
                )
                if replacement is None:
                    raise GroupConflictError(
                        "Host Agent cannot be disabled without an enabled replacement"
                    )
                replacement_id = str(replacement["id"])
            assignments: list[str] = []
            values: list[object] = []
            if "displayName" in changes:
                raw_name = command.get("displayName")
                configured = self._resolved_agent_name(previous["profile"])
                effective = (
                    raw_name.strip()
                    if isinstance(raw_name, str) and raw_name.strip()
                    else configured or previous["profile"]
                )
                display_name, display_key = normalize_display_name(effective)
                self._check_agent_conflicts(
                    connection,
                    canonical_room_id,
                    display_key,
                    exclude_agent_id=canonical_agent_id,
                )
                assignments.extend(("display_name = ?", "display_name_key = ?"))
                values.extend((display_name, display_key))
            if "description" in changes:
                assignments.append("description = ?")
                values.append(self._description(command.get("description")))
            if "enabled" in changes:
                enabled = command["enabled"]
                if not isinstance(enabled, bool):
                    raise ValueError("enabled must be a boolean")
                assignments.append("enabled = ?")
                values.append(int(enabled))
            if "replyWithoutMention" in changes:
                reply_without_mention = command["replyWithoutMention"]
                if not isinstance(reply_without_mention, bool):
                    raise ValueError("replyWithoutMention must be a boolean")
                assignments.append("reply_without_mention = ?")
                values.append(int(reply_without_mention))
            configuration_columns = {
                "model": "model_override",
                "provider": "provider_override",
                "reasoningEffort": "reasoning_effort_override",
            }
            for key, column in configuration_columns.items():
                if key in changes:
                    assignments.append(f"{column} = ?")
                    values.append(self._agent_configuration_value(command[key], key))
            if "fastMode" in changes:
                fast_mode = command["fastMode"]
                if fast_mode is not None and not isinstance(fast_mode, bool):
                    raise ValueError("fastMode must be a boolean or null")
                assignments.append("fast_mode_override = ?")
                values.append(None if fast_mode is None else int(fast_mode))
            if changes & {"model", "provider", "reasoningEffort", "fastMode"}:
                # The active run keeps its current session. The next scheduler
                # pass sees this stale marker and rotates before submitting.
                assignments.append("session_config_json = NULL")
            now = self._now()
            interrupted = {"runIds": [], "runtimeSessionIds": []}
            if (
                "enabled" in changes
                and bool(previous["enabled"])
                and command["enabled"] is False
            ):
                interrupted = self._interrupt_runs_for_scope(
                    connection,
                    room_id=canonical_room_id,
                    agent_id=canonical_agent_id,
                    reason="Agent disabled",
                    now=now,
                )
            assignments.append("updated_at = ?")
            values.extend((now, canonical_agent_id, canonical_room_id))
            connection.execute(
                f"UPDATE group_agents SET {', '.join(assignments)} WHERE id = ? AND room_id = ?",
                values,
            )
            switched: tuple[dict[str, object], dict[str, object]] | None = None
            if replacement_id is not None:
                switched = self._switch_host(
                    connection, canonical_room_id, replacement_id, now=now
                )
            elif requested_host is True:
                switched = self._switch_host(
                    connection, canonical_room_id, canonical_agent_id, now=now
                )
            elif command.get("enabled") is True:
                current_host = self._room_host(connection, canonical_room_id)
                if not bool(current_host["enabled"]):
                    switched = self._switch_host(
                        connection, canonical_room_id, canonical_agent_id, now=now
                    )
            connection.execute(
                "UPDATE group_rooms SET updated_at = ? WHERE id = ?",
                (now, canonical_room_id),
            )
            result = self._agent_detail(
                connection, canonical_room_id, canonical_agent_id
            )
            if switched is None:
                self._append_event(
                    connection,
                    canonical_room_id,
                    "agent.updated",
                    result,
                    created_at=now,
                )
            else:
                self._append_event(
                    connection,
                    canonical_room_id,
                    "agent.updated",
                    switched[0],
                    created_at=now,
                )
                self._append_event(
                    connection,
                    canonical_room_id,
                    "agent.updated",
                    switched[1],
                    created_at=now,
                )
            self._append_room_updated_summary(
                connection, canonical_room_id, created_at=now
            )
            if interrupted["runIds"]:
                self._append_agent_status(
                    connection, canonical_room_id, canonical_agent_id, now
                )
            return {
                "result": result,
                "runtimeSessionIds": interrupted["runtimeSessionIds"],
            }

        response = self.execute_idempotent(
            "agent.updated",
            request_id,
            self._scoped_payload(command, canonical_room_id, canonical_agent_id),
            action,
        )
        return self._runtime_envelope(response)

    def delete_agent(
        self, room_id: str, agent_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        return self.delete_agent_with_runtime_targets(room_id, agent_id, command)[
            "result"
        ]

    def delete_agent_with_runtime_targets(
        self, room_id: str, agent_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        canonical_agent_id = self._canonical_uuid(agent_id, "agentId")
        command = self._command(command, {"requestId"})
        request_id = self._command_request_id(command)

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            self._active_room(connection, canonical_room_id)
            result = self._agent_detail(
                connection, canonical_room_id, canonical_agent_id
            )
            agent_count = connection.execute(
                "SELECT COUNT(*) FROM group_agents WHERE room_id = ?",
                (canonical_room_id,),
            ).fetchone()[0]
            if agent_count <= 1:
                raise GroupConflictError("Room must retain at least one agent")
            now = self._now()
            switched: tuple[dict[str, object], dict[str, object]] | None = None
            if result["isHost"] is True:
                replacement = self._first_enabled_host_candidate(
                    connection,
                    canonical_room_id,
                    exclude_agent_id=canonical_agent_id,
                )
                if replacement is None:
                    raise GroupConflictError(
                        "Host Agent cannot be removed without an enabled replacement"
                    )
                switched = self._switch_host(
                    connection,
                    canonical_room_id,
                    str(replacement["id"]),
                    now=now,
                )
            interrupted = self._interrupt_runs_for_scope(
                connection,
                room_id=canonical_room_id,
                agent_id=canonical_agent_id,
                reason="Agent removed",
                now=now,
            )
            connection.execute(
                "DELETE FROM group_agents WHERE id = ? AND room_id = ?",
                (canonical_agent_id, canonical_room_id),
            )
            connection.execute(
                "UPDATE group_rooms SET updated_at = ? WHERE id = ?",
                (now, canonical_room_id),
            )
            if switched is not None:
                self._append_event(
                    connection,
                    canonical_room_id,
                    "agent.updated",
                    switched[1],
                    created_at=now,
                )
            self._append_event(
                connection, canonical_room_id, "agent.deleted", result, created_at=now
            )
            self._append_room_updated_summary(
                connection, canonical_room_id, created_at=now
            )
            return {
                "result": result,
                "runtimeSessionIds": interrupted["runtimeSessionIds"],
            }

        response = self.execute_idempotent(
            "agent.deleted",
            request_id,
            self._scoped_payload(command, canonical_room_id, canonical_agent_id),
            action,
        )
        return self._runtime_envelope(response)

    def interrupt_agent_with_runtime_targets(
        self, room_id: str, agent_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        canonical_agent_id = self._canonical_uuid(agent_id, "agentId")
        command = self._command(command, {"requestId"})
        request_id = self._command_request_id(command)

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            self._active_room(connection, canonical_room_id)
            self._owned_agent(connection, canonical_room_id, canonical_agent_id)
            now = self._now()
            interrupted = self._interrupt_runs_for_scope(
                connection,
                room_id=canonical_room_id,
                agent_id=canonical_agent_id,
                reason="Agent interrupted",
                now=now,
                include_queued=False,
            )
            if interrupted["runIds"]:
                self._append_agent_status(
                    connection, canonical_room_id, canonical_agent_id, now
                )
            return {
                "result": {
                    "roomId": canonical_room_id,
                    "agentId": canonical_agent_id,
                    "interruptedRunIds": interrupted["runIds"],
                },
                "runtimeSessionIds": interrupted["runtimeSessionIds"],
            }

        response = self.execute_idempotent(
            "agent.interrupted",
            request_id,
            self._scoped_payload(command, canonical_room_id, canonical_agent_id),
            action,
        )
        return self._runtime_envelope(response)

    def create_human_message(
        self,
        room_id: str,
        *,
        request_id: str,
        client_message_id: str,
        content: str,
        mention_agent_ids: object,
        topic_id: str | None = None,
    ) -> dict[str, object]:
        """Persist one human turn and the deterministic agent work it starts."""
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        canonical_request_id = self._canonical_uuid(request_id, "requestId")
        canonical_client_id = self._canonical_uuid(client_message_id, "clientMessageId")
        canonical_topic_id = (
            self._compatibility_topic_id(canonical_room_id)
            if topic_id is None
            else self._canonical_uuid(topic_id, "topicId")
        )
        message_content = self._message_text(
            content, "content", max_bytes=MAX_MESSAGE_BYTES, nonblank=True
        )
        agent_ids = self._mention_agent_ids(mention_agent_ids)
        payload = {
            "roomId": canonical_room_id,
            "clientMessageId": canonical_client_id,
            "content": message_content,
            "mentionAgentIds": agent_ids,
        }
        if topic_id is not None:
            payload["topicId"] = canonical_topic_id

        def action(connection: sqlite3.Connection) -> dict[str, object]:
            self._active_room(connection, canonical_room_id)
            agents: list[tuple[sqlite3.Row, str, bool]] = []
            room_agents = connection.execute(
                """SELECT * FROM group_agents WHERE room_id = ?
                ORDER BY created_at ASC, id ASC""",
                (canonical_room_id,),
            ).fetchall()
            parsed_ids, _warnings = self._plan_cascade_mentions(
                message_content,
                room_agents,
                source_agent_id="human",
                include_automatic=False,
            )
            agents_by_id = {str(agent["id"]): agent for agent in room_agents}
            explicit_agent_ids = [
                agent_id
                for agent_id in dict.fromkeys([*agent_ids, *parsed_ids])
                if agent_id in agents_by_id and agents_by_id[agent_id]["enabled"]
            ]
            if explicit_agent_ids:
                agents.extend(
                    (agents_by_id[agent_id], "mentioned", False)
                    for agent_id in explicit_agent_ids
                )
            else:
                host = self._room_host(connection, canonical_room_id)
                scheduled_ids: set[str] = set()
                if host["enabled"]:
                    agents.append((host, "automatic", True))
                    scheduled_ids.add(str(host["id"]))
                agents.extend(
                    (agent, "automatic", False)
                    for agent in room_agents
                    if agent["enabled"]
                    and agent["reply_without_mention"]
                    and agent["id"] not in scheduled_ids
                )
            now = self._now()
            self._ensure_topic(
                connection,
                canonical_room_id,
                canonical_topic_id,
                message_content,
                now,
            )
            human_id = str(uuid.uuid4())
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, topic_id, sender_kind, sender_id, sender_name, root_message_id,
                 reply_to_message_id, client_message_id, content, reasoning, tool_state_json,
                 status, error, created_at, updated_at)
                VALUES (?, ?, ?, 'human', 'human', '你', ?, NULL, ?, ?, '', '[]', 'completed', '', ?, ?)""",
                (
                    human_id,
                    canonical_room_id,
                    canonical_topic_id,
                    human_id,
                    canonical_client_id,
                    message_content,
                    now,
                    now,
                ),
            )
            message = self._message_wire(self._message_row(connection, human_id))
            self._append_event(
                connection, canonical_room_id, "message.upsert", message, created_at=now
            )
            runs: list[dict[str, object]] = []
            for agent, reply_mode, required_reply in agents:
                visible = reply_mode == "mentioned" or required_reply
                response_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
                connection.execute(
                    """INSERT INTO group_messages
                    (id, room_id, topic_id, sender_kind, sender_id, sender_name, root_message_id,
                     reply_to_message_id, client_message_id, content, reasoning, tool_state_json,
                     status, error, visible, created_at, updated_at)
                    VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, NULL, '', '', '[]', 'queued', '', ?, ?, ?)""",
                    (
                        response_id,
                        canonical_room_id,
                        canonical_topic_id,
                        agent["id"],
                        agent["display_name"],
                        human_id,
                        human_id,
                        int(visible),
                        now,
                        now,
                    ),
                )
                connection.execute(
                    """INSERT INTO group_agent_runs
                    (id, room_id, topic_id, agent_id, trigger_message_id, response_message_id, root_message_id,
                     depth, reply_mode, required_reply, status, runtime_session_id,
                     requested_model, requested_provider,
                     requested_reasoning_effort, requested_fast_mode,
                     actual_model, actual_provider, actual_reasoning_effort,
                     actual_fast_mode, error, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'queued', NULL,
                            ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', ?, ?)""",
                    (
                        run_id,
                        canonical_room_id,
                        canonical_topic_id,
                        agent["id"],
                        human_id,
                        response_id,
                        human_id,
                        reply_mode,
                        int(required_reply),
                        agent["model_override"],
                        agent["provider_override"],
                        agent["reasoning_effort_override"],
                        agent["fast_mode_override"],
                        now,
                        now,
                    ),
                )
                response = self._message_wire(
                    self._message_row(connection, response_id)
                )
                run = self._run_wire(self._run_row(connection, run_id))
                if visible:
                    self._append_event(
                        connection,
                        canonical_room_id,
                        "message.upsert",
                        response,
                        created_at=now,
                    )
                self._append_event(
                    connection, canonical_room_id, "run.updated", run, created_at=now
                )
                runs.append(run)
            return {"message": message, "runs": runs}

        try:
            return self.execute_idempotent(
                "message.create", canonical_request_id, payload, action
            )
        except sqlite3.IntegrityError as error:
            raise self._integrity_conflict(error) from error

    def get_message(self, message_id: str) -> dict[str, object]:
        canonical_message_id = self._canonical_uuid(message_id, "messageId")
        with self.read_transaction() as connection:
            return self._message_wire(
                self._message_with_execution_row(connection, canonical_message_id)
            )

    def get_run(self, run_id: str) -> dict[str, object]:
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        with self.read_transaction() as connection:
            return self._run_wire(self._run_row(connection, canonical_run_id))

    def get_interaction(self, interaction_id: str) -> dict[str, object]:
        canonical_interaction_id = self._interaction_id(interaction_id)
        with self.read_transaction() as connection:
            return self._interaction_wire(
                self._interaction_row(connection, canonical_interaction_id)
            )

    def list_messages(
        self,
        room_id: str,
        *,
        topic_id: str | None = None,
        before_seq: int | None = None,
        after_seq: int | None = None,
        limit: int = MAX_MESSAGE_PAGE_SIZE,
    ) -> list[dict[str, object]]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        canonical_topic_id = (
            None
            if topic_id is None
            else self._canonical_uuid(topic_id, "topicId")
        )
        self._page_limit(limit, MAX_MESSAGE_PAGE_SIZE, "limit")
        if before_seq is not None and after_seq is not None:
            raise ValueError("before_seq and after_seq are mutually exclusive")
        before = (
            self._positive_int(before_seq, "before_seq")
            if before_seq is not None
            else None
        )
        after = (
            self._positive_int(after_seq, "after_seq")
            if after_seq is not None
            else None
        )
        with self.read_transaction() as connection:
            self._room_detail(connection, canonical_room_id, include_archived=True)
            if canonical_topic_id is not None:
                self._topic_row(connection, canonical_room_id, canonical_topic_id)
            scope = "message.room_id = ?"
            scope_params: tuple[object, ...] = (canonical_room_id,)
            if canonical_topic_id is not None:
                scope += " AND message.topic_id = ?"
                scope_params = (canonical_room_id, canonical_topic_id)
            select = """SELECT message.*,
                run.requested_model AS execution_requested_model,
                run.requested_provider AS execution_requested_provider,
                run.requested_reasoning_effort AS execution_requested_reasoning_effort,
                run.requested_fast_mode AS execution_requested_fast_mode,
                run.actual_model AS execution_actual_model,
                run.actual_provider AS execution_actual_provider,
                run.actual_reasoning_effort AS execution_actual_reasoning_effort,
                run.actual_fast_mode AS execution_actual_fast_mode
                FROM group_messages AS message
                LEFT JOIN group_agent_runs AS run
                  ON run.response_message_id = message.id"""
            if before is not None:
                rows = connection.execute(
                    f"{select} WHERE {scope} AND message.visible = 1 AND message.seq < ? ORDER BY message.seq DESC LIMIT ?",
                    (*scope_params, before, limit),
                ).fetchall()
                rows = list(reversed(rows))
            elif after is not None:
                rows = connection.execute(
                    f"{select} WHERE {scope} AND message.visible = 1 AND message.seq > ? ORDER BY message.seq ASC LIMIT ?",
                    (*scope_params, after, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    f"{select} WHERE {scope} AND message.visible = 1 ORDER BY message.seq DESC LIMIT ?",
                    (*scope_params, limit),
                ).fetchall()
                rows = list(reversed(rows))
            return [self._message_wire(row) for row in rows]

    def claim_next_runnable_run(self) -> dict[str, object] | None:
        """Atomically claim the oldest eligible queued run."""
        with self.write_transaction() as connection:
            active_count = int(
                connection.execute(
                    """SELECT COUNT(*) FROM group_agent_runs
                    WHERE status IN ('running', 'awaiting_input')"""
                ).fetchone()[0]
            )
            if active_count >= MAX_PLUGIN_CONCURRENCY:
                return None
            run = connection.execute(
                """SELECT candidate.* FROM group_agent_runs AS candidate
                JOIN group_rooms AS room ON room.id = candidate.room_id
                JOIN group_agents AS agent
                  ON agent.id = candidate.agent_id
                 AND agent.room_id = candidate.room_id
                JOIN group_messages AS trigger_message
                  ON trigger_message.id = candidate.trigger_message_id
                WHERE candidate.status = 'queued'
                  AND room.archived = 0
                  AND agent.enabled = 1
                  AND NOT EXISTS (
                    SELECT 1 FROM group_agent_runs AS occupied_agent
                    WHERE occupied_agent.agent_id = candidate.agent_id
                      AND occupied_agent.status IN ('running', 'awaiting_input')
                  )
                  AND (
                    SELECT COUNT(*) FROM group_agent_runs AS occupied_room
                    WHERE occupied_room.room_id = candidate.room_id
                      AND occupied_room.status IN ('running', 'awaiting_input')
                  ) < ?
                ORDER BY trigger_message.seq ASC,
                         candidate.created_at ASC,
                         candidate.id ASC
                LIMIT 1""",
                (MAX_ROOM_CONCURRENCY,),
            ).fetchone()
            if run is None:
                return None
            response = self._message_row(connection, run["response_message_id"])
            self._validate_run_message_state(run, response)
            now = self._now()
            result = self._update_run(connection, run, "running", now, UNSET, UNSET)
            self._append_event(
                connection,
                run["room_id"],
                "run.updated",
                result,
                created_at=now,
            )
            self._append_agent_status(connection, run["room_id"], run["agent_id"], now)
            return result

    def read_run_projection(self, run_id: str) -> dict[str, object]:
        """Return a stable, bounded context projection for one claimed run."""
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        with self.read_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            if run["status"] not in {"running", "awaiting_input"}:
                raise GroupConflictError("Run is not claimed")
            room = self._active_room(connection, run["room_id"])
            agent = self._enabled_agent(connection, run["room_id"], run["agent_id"])
            trigger = self._message_row(connection, run["trigger_message_id"])
            if (
                trigger["room_id"] != run["room_id"]
                or trigger["topic_id"] != run["topic_id"]
            ):
                raise GroupStoreError("Run trigger message is corrupt")
            topic_state = self._agent_topic_state(
                connection, run["agent_id"], run["topic_id"]
            )
            lower_seq = int(topic_state["last_context_message_seq"])
            trigger_seq = int(trigger["seq"])
            through_seq = self._safe_context_seq(
                connection,
                run["room_id"],
                run["topic_id"],
                lower_seq,
                trigger_seq,
            )
            eligibility = """FROM group_messages
                WHERE room_id = ? AND topic_id = ? AND seq > ? AND seq <= ?
                  AND visible = 1
                  AND status IN ('completed', 'failed', 'interrupted')
                  AND NOT (sender_kind = 'agent' AND sender_id = ?)"""
            parameters = (
                run["room_id"],
                run["topic_id"],
                lower_seq,
                trigger_seq,
                run["agent_id"],
            )
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) {eligibility}", parameters
                ).fetchone()[0]
            )
            rows = connection.execute(
                f"""SELECT * {eligibility}
                ORDER BY seq DESC LIMIT ?""",
                (*parameters, INITIAL_CONTEXT_MESSAGE_LIMIT),
            ).fetchall()
            rows = list(reversed(rows))
            omitted = total - len(rows)
            omitted_through_seq: int | None = None
            if omitted:
                omitted_through_seq = int(
                    connection.execute(
                        f"""SELECT MAX(seq) {eligibility}
                        AND seq < ?""",
                        (*parameters, rows[0]["seq"]),
                    ).fetchone()[0]
                )
            initial = agent["stored_session_id"] is None
            projected_agent = self._agent_wire(agent)
            projected_agent["lastContextMessageSeq"] = lower_seq
            messages = [self._projection_message(row) for row in rows]
            messages, omitted, omitted_through_seq, omitted_summary = (
                self._bound_projection_messages(
                    messages,
                    omitted_count=omitted,
                    omitted_through_seq=omitted_through_seq,
                )
            )
            projected_run = self._run_wire(run)
            projected_run["requiredReply"] = bool(run["required_reply"])
            return {
                "run": projected_run,
                "room": self._room_wire(room),
                "agent": projected_agent,
                "messages": messages,
                "initial": initial,
                "triggerSeq": trigger_seq,
                "throughSeq": through_seq,
                "omittedMessageCount": omitted,
                "omittedThroughSeq": omitted_through_seq,
                "omittedSummary": omitted_summary,
                "characterBudget": CONTEXT_CHARACTER_BUDGET,
            }

    def bind_run_session(
        self,
        run_id: str,
        *,
        expected_stored_session_id: str | None,
        stored_session_id: str,
        runtime_session_id: str,
    ) -> dict[str, object]:
        """CAS-bind stored and runtime identities for the current generation."""
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        expected_stored = self._runtime_session_id(expected_stored_session_id)
        stored = self._runtime_session_id(stored_session_id)
        runtime = self._runtime_session_id(runtime_session_id)
        if stored is None:
            raise ValueError("storedSessionId is invalid")
        if runtime is None:
            raise ValueError("runtimeSessionId is invalid")
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            self._active_room(connection, run["room_id"])
            agent = self._enabled_agent(connection, run["room_id"], run["agent_id"])
            response = self._message_row(connection, run["response_message_id"])
            self._validate_run_message_state(run, response)
            if run["status"] not in {"running", "awaiting_input"}:
                raise GroupConflictError("Run does not accept a session binding")
            if agent["stored_session_id"] != expected_stored:
                raise GroupConflictError("stored session generation changed")
            if run["runtime_session_id"] not in {None, runtime}:
                raise GroupConflictError("Run runtime is already bound")
            self._require_available_runtime(connection, runtime, canonical_run_id)
            now = self._now()
            if agent["stored_session_id"] != stored:
                connection.execute(
                    """UPDATE group_agents
                    SET stored_session_id = ?, updated_at = ? WHERE id = ?""",
                    (stored, now, agent["id"]),
                )
                agent = self._owned_agent(connection, run["room_id"], run["agent_id"])
                self._append_event(
                    connection,
                    run["room_id"],
                    "agent.updated",
                    self._agent_wire(agent),
                    created_at=now,
                )
            if run["runtime_session_id"] != runtime:
                changed = self._update_run(
                    connection, run, run["status"], now, runtime, UNSET
                )
                self._append_event(
                    connection,
                    run["room_id"],
                    "run.updated",
                    changed,
                    created_at=now,
                )
            else:
                changed = self._run_wire(run)
            return {"run": changed, "agent": self._agent_wire(agent)}

    def advance_run_context(
        self,
        run_id: str,
        *,
        runtime_session_id: str,
        expected_context_seq: int,
        through_seq: int,
    ) -> dict[str, object]:
        """Advance one Agent context watermark with generation and hole CAS checks."""
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        runtime = self._runtime_session_id(runtime_session_id)
        if runtime is None:
            raise ValueError("runtimeSessionId is invalid")
        expected = self._nonnegative_int(expected_context_seq, "expectedContextSeq")
        through = self._nonnegative_int(through_seq, "throughSeq")
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            self._active_room(connection, run["room_id"])
            agent = self._enabled_agent(connection, run["room_id"], run["agent_id"])
            if run["status"] not in {"running", "awaiting_input"}:
                raise GroupConflictError("Run no longer accepts context")
            if run["runtime_session_id"] != runtime:
                raise GroupConflictError("Run runtime generation changed")
            topic_state = self._agent_topic_state(
                connection, run["agent_id"], run["topic_id"]
            )
            if int(topic_state["last_context_message_seq"]) != expected:
                raise GroupConflictError("Agent context generation changed")
            trigger = self._message_row(connection, run["trigger_message_id"])
            safe = self._safe_context_seq(
                connection,
                run["room_id"],
                run["topic_id"],
                expected,
                int(trigger["seq"]),
            )
            if through < expected or through > safe:
                raise GroupConflictError("throughSeq exceeds safe projection")
            now = self._now()
            connection.execute(
                """UPDATE group_agent_topic_state
                SET last_context_message_seq = ?, updated_at = ?
                WHERE agent_id = ? AND topic_id = ?""",
                (through, now, agent["id"], run["topic_id"]),
            )
            changed = self._agent_wire(agent)
            changed["lastContextMessageSeq"] = through
            return changed

    def commit_prompt_submission(
        self,
        run_id: str,
        *,
        expected_stored_session_id: str | None,
        stored_session_id: str,
        runtime_session_id: str,
        expected_context_seq: int,
        through_seq: int,
    ) -> dict[str, object]:
        """Commit a successful prompt submission and its durable context CAS."""
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        expected_stored = self._runtime_session_id(expected_stored_session_id)
        stored = self._runtime_session_id(stored_session_id)
        runtime = self._runtime_session_id(runtime_session_id)
        expected = self._nonnegative_int(expected_context_seq, "expectedContextSeq")
        through = self._nonnegative_int(through_seq, "throughSeq")
        if stored is None:
            raise ValueError("storedSessionId is invalid")
        if runtime is None:
            raise ValueError("runtimeSessionId is invalid")
        operation = f"run.prompt.submitted:{canonical_run_id}"
        legacy_ledger_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"hermes://yaoyao-group/{canonical_run_id}/prompt-submission",
            )
        )
        ledger_id = f"internal:prompt:{canonical_run_id}"
        payload = {
            "runId": canonical_run_id,
            "expectedStoredSessionId": expected_stored,
            "storedSessionId": stored,
            "runtimeSessionId": runtime,
            "expectedContextSeq": expected,
            "throughSeq": through,
        }
        request_hash = hashlib.sha256(
            self._canonical_json(payload).encode()
        ).hexdigest()
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            self._active_room(connection, run["room_id"])
            agent = self._enabled_agent(connection, run["room_id"], run["agent_id"])
            response = self._message_row(connection, run["response_message_id"])
            self._validate_run_message_state(run, response)
            if run["status"] != "running":
                raise GroupConflictError("Run no longer accepts a prompt submission")
            if run["runtime_session_id"] != runtime:
                raise GroupConflictError("Run runtime generation changed")
            current_stored = agent["stored_session_id"]
            topic_state = self._agent_topic_state(
                connection, run["agent_id"], run["topic_id"]
            )
            current_context = int(topic_state["last_context_message_seq"])
            existing = connection.execute(
                """SELECT request_id, operation, request_hash, response_json
                FROM group_idempotency WHERE request_id = ?""",
                (ledger_id,),
            ).fetchone()
            legacy_existing = None
            if existing is None:
                candidate = connection.execute(
                    """SELECT operation, request_hash, response_json
                    FROM group_idempotency WHERE request_id = ?""",
                    (legacy_ledger_id,),
                ).fetchone()
                if candidate is not None and candidate["operation"] == operation:
                    existing = candidate
                    legacy_existing = candidate
            if existing is not None:
                if (
                    existing["operation"] != operation
                    or existing["request_hash"] != request_hash
                ):
                    raise GroupConflictError("Prompt submission generation changed")
                if current_stored != stored or current_context != through:
                    raise GroupConflictError("Prompt submission generation changed")
                stored_response = existing["response_json"]
                try:
                    replay = self._load_json(stored_response)
                except (TypeError, ValueError, json.JSONDecodeError) as error:
                    raise GroupStoreError(
                        "Stored prompt submission is corrupt"
                    ) from error
                if (
                    not isinstance(replay, dict)
                    or self._canonical_json(replay) != stored_response
                ):
                    raise GroupStoreError("Stored prompt submission is corrupt")
                if legacy_existing is not None:
                    connection.execute(
                        """UPDATE group_idempotency SET request_id = ?
                        WHERE request_id = ?""",
                        (ledger_id, legacy_ledger_id),
                    )
                return replay
            if current_stored != expected_stored:
                raise GroupConflictError("stored session generation changed")
            if current_context != expected:
                raise GroupConflictError("Agent context generation changed")
            trigger = self._message_row(connection, run["trigger_message_id"])
            safe = self._safe_context_seq(
                connection,
                run["room_id"],
                run["topic_id"],
                expected,
                int(trigger["seq"]),
            )
            if through < expected or through > safe:
                raise GroupConflictError("throughSeq exceeds safe projection")
            now = self._now()
            if current_stored != stored:
                connection.execute(
                    """UPDATE group_agents
                    SET stored_session_id = ?, updated_at = ? WHERE id = ?""",
                    (stored, now, agent["id"]),
                )
                agent = self._owned_agent(connection, run["room_id"], run["agent_id"])
                self._append_event(
                    connection,
                    run["room_id"],
                    "agent.updated",
                    self._agent_wire(agent),
                    created_at=now,
                )
            if current_context != through:
                connection.execute(
                    """UPDATE group_agent_topic_state
                    SET last_context_message_seq = ?, updated_at = ?
                    WHERE agent_id = ? AND topic_id = ?""",
                    (through, now, agent["id"], run["topic_id"]),
                )
            result_agent = self._agent_wire(agent)
            result_agent["lastContextMessageSeq"] = through
            result = {
                "run": self._run_wire(run),
                "agent": result_agent,
            }
            connection.execute(
                """INSERT INTO group_idempotency
                (request_id, operation, request_hash, response_json, created_at)
                VALUES (?, ?, ?, ?, ?)""",
                (
                    ledger_id,
                    operation,
                    request_hash,
                    self._canonical_json(result),
                    now,
                ),
            )
            return result

    def settle_run(
        self,
        run_id: str,
        *,
        runtime_session_id: str | None,
        expected_stored_session_id: str | None,
        stored_session_id: str | None,
        outcome: str,
        actual_model: str | None = None,
        actual_provider: str | None = None,
        actual_reasoning_effort: str | None = None,
        actual_fast_mode: bool | None = None,
        error: str = "",
    ) -> dict[str, object]:
        """Settle message, run, session rotation, and status in one transaction."""
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        runtime = self._runtime_session_id(runtime_session_id)
        expected_stored = self._runtime_session_id(expected_stored_session_id)
        stored = self._runtime_session_id(stored_session_id)
        effective_model = self._agent_configuration_value(actual_model, "model")
        effective_provider = self._agent_configuration_value(
            actual_provider, "provider"
        )
        if (effective_model is None) != (effective_provider is None):
            raise ValueError("actual model and provider must both be set or both be null")
        effective_reasoning = self._agent_configuration_value(
            actual_reasoning_effort, "reasoningEffort"
        )
        if actual_fast_mode is not None and not isinstance(actual_fast_mode, bool):
            raise ValueError("actual fast mode must be a boolean or null")
        run_error = self._message_text(error, "error", max_bytes=4096)
        if outcome not in {"completed", "failed", "interrupted"}:
            raise ValueError("outcome is invalid")
        if runtime is None and outcome != "failed":
            raise ValueError("A runtime-less settle only supports failed")
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            self._active_room(connection, run["room_id"])
            agent = self._enabled_agent(connection, run["room_id"], run["agent_id"])
            response = self._message_row(connection, run["response_message_id"])
            self._validate_run_message_state(run, response)
            if run["status"] not in {"running", "awaiting_input"}:
                raise GroupConflictError("Run is already settled")
            if run["runtime_session_id"] != runtime:
                raise GroupConflictError("Run runtime generation changed")
            if agent["stored_session_id"] != expected_stored:
                raise GroupConflictError("stored session generation changed")
            if outcome == "completed" and response["status"] != "completed":
                raise GroupConflictError("Response message must be completed first")
            now = self._now()
            if stored != agent["stored_session_id"]:
                connection.execute(
                    """UPDATE group_agents
                    SET stored_session_id = ?, updated_at = ? WHERE id = ?""",
                    (stored, now, agent["id"]),
                )
                agent = self._owned_agent(connection, run["room_id"], run["agent_id"])
                self._append_event(
                    connection,
                    run["room_id"],
                    "agent.updated",
                    self._agent_wire(agent),
                    created_at=now,
                )
            connection.execute(
                """UPDATE group_agent_runs
                SET actual_model = ?, actual_provider = ?,
                    actual_reasoning_effort = ?, actual_fast_mode = ?
                WHERE id = ?""",
                (
                    effective_model,
                    effective_provider,
                    effective_reasoning,
                    None if actual_fast_mode is None else int(actual_fast_mode),
                    run["id"],
                ),
            )
            run = self._run_row(connection, run["id"])
            self._cancel_pending_interactions(connection, run, now)
            changed = self._update_run(connection, run, outcome, now, None, run_error)
            self._fail_claimed_interaction_ledgers(
                connection,
                run_id=run["id"],
                reason=run_error or f"Run {outcome}",
                runtime_session_ids=[] if runtime is None else [runtime],
                run=changed,
            )
            self._append_event(
                connection,
                run["room_id"],
                "run.updated",
                changed,
                created_at=now,
            )
            if (
                outcome in {"failed", "interrupted"}
                and response["status"] != "completed"
            ):
                connection.execute(
                    """UPDATE group_messages
                    SET status = ?, error = ?, updated_at = ? WHERE id = ?""",
                    (outcome, run_error, now, response["id"]),
                )
                response = self._message_row(connection, response["id"])
                if response["visible"]:
                    self._append_event(
                        connection,
                        run["room_id"],
                        "message.upsert",
                        self._message_wire(
                            self._message_with_execution_row(
                                connection, response["id"]
                            )
                        ),
                        created_at=now,
                    )
            elif (
                effective_model is not None
                or effective_reasoning is not None
                or actual_fast_mode is not None
            ) and response["visible"]:
                self._append_event(
                    connection,
                    run["room_id"],
                    "message.upsert",
                    self._message_wire(
                        self._message_with_execution_row(connection, response["id"])
                    ),
                    created_at=now,
                )
            if outcome == "completed":
                self._record_cascade_plan(
                    connection,
                    source=run,
                    source_message=response,
                    created_at=now,
                )
            self._append_agent_status(connection, run["room_id"], run["agent_id"], now)
            return {
                "run": changed,
                "message": self._message_wire(
                    self._message_with_execution_row(connection, response["id"])
                ),
                "agent": self._agent_wire(agent),
            }

    @classmethod
    def _cascade_request_id(cls, source_run_id: str) -> str:
        return f"internal:cascade:{source_run_id}"

    @classmethod
    def _cascade_request_hash(
        cls, source_run_id: str, *, parse_version: int = _CASCADE_PARSE_VERSION
    ) -> str:
        payload = {
            "parseVersion": parse_version,
            "sourceRunId": source_run_id,
            "version": 1,
        }
        return hashlib.sha256(cls._canonical_json(payload).encode()).hexdigest()

    def _record_cascade_plan(
        self,
        connection: sqlite3.Connection,
        *,
        source: sqlite3.Row,
        source_message: sqlite3.Row,
        created_at: float,
    ) -> None:
        request_id = self._cascade_request_id(source["id"])
        existing = connection.execute(
            "SELECT 1 FROM group_idempotency WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if existing is not None:
            raise GroupStoreError("Cascade ledger already exists")
        agents = connection.execute(
            "SELECT * FROM group_agents WHERE room_id = ? "
            "ORDER BY created_at ASC, id ASC",
            (source["room_id"],),
        ).fetchall()
        if source_message["visible"]:
            target_ids, warnings = self._plan_cascade_mentions(
                source_message["content"],
                agents,
                source_agent_id=source["agent_id"],
            )
            explicit_ids, _ = self._plan_cascade_mentions(
                source_message["content"],
                agents,
                source_agent_id=source["agent_id"],
                include_automatic=False,
            )
        else:
            target_ids, warnings = [], []
            explicit_ids = []
        explicit_set = set(explicit_ids)
        plan = {
            "parseVersion": _CASCADE_PARSE_VERSION,
            "sourceMessageId": source_message["id"],
            "sourceRunId": source["id"],
            "state": "pending",
            "targets": [
                {
                    "agentId": agent_id,
                    "replyMode": (
                        "mentioned" if agent_id in explicit_set else "automatic"
                    ),
                }
                for agent_id in target_ids
            ],
            "warnings": warnings,
            "version": 1,
        }
        encoded = self._canonical_json(plan)
        if len(encoded.encode("utf-8")) > _MAX_CASCADE_PLAN_BYTES:
            raise GroupStoreError("Cascade plan exceeds the internal limit")
        connection.execute(
            """INSERT INTO group_idempotency
            (request_id, operation, request_hash, response_json, created_at)
            VALUES (?, ?, ?, ?, ?)""",
            (
                request_id,
                _CASCADE_PENDING_OPERATION,
                self._cascade_request_hash(source["id"]),
                encoded,
                created_at,
            ),
        )

    @classmethod
    def _plan_cascade_mentions(
        cls,
        content: str,
        agents: list[sqlite3.Row],
        *,
        source_agent_id: str,
        include_automatic: bool = True,
    ) -> tuple[list[str], list[dict[str, str]]]:
        searchable = cls._mention_search_text(content)
        entries: list[tuple[str, int, sqlite3.Row]] = []
        for agent in agents:
            aliases = (
                (agent["id"], 0),
                (agent["profile"], 1),
                (agent["display_name"], 2),
            )
            seen: set[str] = set()
            for alias, priority in aliases:
                key = alias.casefold()
                if key in seen or is_reserved_mention_alias(key):
                    continue
                seen.add(key)
                entries.append((key, priority, agent))
        entries.sort(key=lambda item: (-len(item[0]), item[1], item[0], item[2]["id"]))
        targets: list[str] = []
        warning_names: list[str] = []
        index = 0
        while index < len(searchable):
            if searchable[index] != "@" or (
                index > 0 and cls._mention_word_char(searchable[index - 1])
            ):
                index += 1
                continue
            room_wide_match = next(
                (
                    match
                    for alias in ALL_MENTION_ALIASES
                    if (match := cls._casefold_prefix(searchable, index + 1, alias))
                    is not None
                    and cls._mention_end(searchable, match)
                ),
                None,
            )
            if room_wide_match is not None:
                for agent in agents:
                    if (
                        agent["enabled"]
                        and agent["id"] != source_agent_id
                        and agent["id"] not in targets
                    ):
                        targets.append(agent["id"])
                index = room_wide_match
                continue
            matched = False
            for key, _priority, agent in entries:
                end = cls._casefold_prefix(searchable, index + 1, key)
                if end is None or not cls._mention_end(searchable, end):
                    continue
                matched = True
                if not agent["enabled"]:
                    warning_names.append(f"Agent disabled: {agent['display_name']}")
                elif agent["id"] != source_agent_id and agent["id"] not in targets:
                    targets.append(agent["id"])
                index = end
                break
            if matched:
                continue
            token = re.match(
                r"[^\s@,，。！？!?;；:：()（）\[\]{}]{1,100}",
                searchable[index + 1 :],
            )
            if token is not None:
                warning_names.append(f"Unknown Mention: @{token.group(0)}")
                index += 1 + len(token.group(0))
            else:
                index += 1
        if include_automatic and not targets:
            for agent in agents:
                if (
                    agent["enabled"]
                    and agent["reply_without_mention"]
                    and agent["id"] != source_agent_id
                    and agent["id"] not in targets
                ):
                    targets.append(agent["id"])
        warnings = [
            {"code": "mention", "message": value}
            for value in list(dict.fromkeys(warning_names))[:MAX_AGENTS_PER_ROOM]
        ]
        return targets[:MAX_AGENTS_PER_ROOM], warnings

    @staticmethod
    def _casefold_prefix(content: str, start: int, expected: str) -> int | None:
        folded = ""
        index = start
        while index < len(content) and len(folded) < len(expected):
            folded += content[index].casefold()
            index += 1
        return index if folded == expected else None

    @staticmethod
    def _mention_search_text(content: str) -> str:
        lines = content.splitlines(keepends=True)
        visible: list[str] = []
        fence: tuple[str, int] | None = None
        for line in lines:
            leading_spaces = len(line) - len(line.lstrip(" "))
            candidate = line[leading_spaces:] if leading_spaces <= 3 else ""
            marker_character = (
                candidate[0]
                if candidate.startswith("`") or candidate.startswith("~")
                else None
            )
            marker_length = 0
            if marker_character is not None:
                while (
                    marker_length < len(candidate)
                    and candidate[marker_length] == marker_character
                ):
                    marker_length += 1
            if fence is None and marker_length >= 3:
                fence = (marker_character, marker_length)
                continue
            if fence is not None:
                fence_character, fence_length = fence
                remainder = candidate[marker_length:]
                if (
                    marker_character == fence_character
                    and marker_length >= fence_length
                    and not remainder.strip()
                ):
                    fence = None
                continue
            visible.append(line)
        searchable = "".join(visible)
        inline_visible: list[str] = []
        for line in searchable.splitlines(keepends=True):
            index = 0
            while index < len(line):
                if line[index] != "`":
                    inline_visible.append(line[index])
                    index += 1
                    continue
                end = index + 1
                while end < len(line) and line[end] == "`":
                    end += 1
                delimiter = line[index:end]
                close = line.find(delimiter, end)
                if close < 0:
                    if line.endswith("\n"):
                        inline_visible.append("\n")
                    break
                index = close + len(delimiter)
        searchable = "".join(inline_visible)
        searchable = re.sub(
            r"(?:[A-Za-z][A-Za-z0-9+.-]*://|www\.)"
            r"[^\s，。！？；：()（）\[\]{}]+",
            "",
            searchable,
            flags=re.IGNORECASE,
        )
        return re.sub(r"\\@", "", searchable)

    @staticmethod
    def _mention_word_char(value: str) -> bool:
        return value.isalnum() or value in {"_", ".", "-", "+", "@"}

    @classmethod
    def _mention_end(cls, value: str, end: int) -> bool:
        return end >= len(value) or not cls._mention_word_char(value[end])

    def list_pending_cascades(
        self, *, limit: int = _MAX_CASCADE_PAGE_SIZE, after: int | None = None
    ) -> dict[str, object]:
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not (1 <= limit <= _MAX_CASCADE_PAGE_SIZE)
        ):
            raise ValueError("limit must be between 1 and 32")
        if after is None:
            after_value = 0
        elif isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be a non-negative integer")
        else:
            after_value = after
        with self.read_transaction() as connection:
            rows = connection.execute(
                """SELECT rowid, request_id, operation, request_hash, response_json
                FROM group_idempotency
                WHERE operation = ? AND rowid > ?
                ORDER BY rowid ASC LIMIT ?""",
                (_CASCADE_PENDING_OPERATION, after_value, limit + 1),
            ).fetchall()
        validated = [
            (int(row["rowid"]), self._cascade_plan_from_ledger(row)) for row in rows
        ]
        has_more = len(validated) > limit
        validated = validated[:limit]
        items = [{"sourceRunId": plan["sourceRunId"]} for _rowid, plan in validated]
        return {
            "items": items,
            "nextCursor": (validated[-1][0] if has_more and validated else None),
        }

    def _cascade_plan_from_ledger(
        self, ledger: Mapping[str, object]
    ) -> dict[str, object]:
        try:
            request_id = ledger["request_id"]
            operation = ledger["operation"]
            request_hash = ledger["request_hash"]
            encoded = ledger["response_json"]
        except (KeyError, IndexError, TypeError) as error:
            raise GroupStoreError("Stored cascade ledger is corrupt") from error
        prefix = "internal:cascade:"
        if (
            not isinstance(request_id, str)
            or not request_id.startswith(prefix)
            or operation != _CASCADE_PENDING_OPERATION
            or not isinstance(encoded, str)
            or len(encoded.encode("utf-8")) > _MAX_CASCADE_PLAN_BYTES
        ):
            raise GroupStoreError("Stored cascade ledger is corrupt")
        raw_source_id = request_id[len(prefix) :]
        try:
            source_id = self._canonical_uuid(raw_source_id, "sourceRunId")
        except ValueError as error:
            raise GroupStoreError("Stored cascade ledger is corrupt") from error
        if raw_source_id != source_id:
            raise GroupStoreError("Stored cascade ledger is corrupt")
        try:
            plan = self._load_json(encoded)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise GroupStoreError("Stored cascade plan is corrupt") from error
        if not isinstance(plan, dict) or self._canonical_json(plan) != encoded:
            raise GroupStoreError("Stored cascade plan is corrupt")
        parse_version = plan.get("parseVersion")
        if (
            parse_version not in {1, 2, 3}
            or request_hash
            != self._cascade_request_hash(source_id, parse_version=parse_version)
        ):
            raise GroupStoreError("Stored cascade ledger is corrupt")
        common_invalid = (
            plan.get("state") != "pending"
            or plan.get("version") != 1
            or plan.get("sourceRunId") != source_id
            or not isinstance(plan.get("warnings"), list)
            or not all(isinstance(item, dict) for item in plan["warnings"])
            or len(plan["warnings"]) > MAX_AGENTS_PER_ROOM
        )
        if common_invalid:
            raise GroupStoreError("Stored cascade plan is corrupt")
        if parse_version == 1:
            expected_keys = {
                "parseVersion",
                "sourceMessageId",
                "sourceRunId",
                "state",
                "targetAgentIds",
                "version",
                "warnings",
            }
            target_ids = plan.get("targetAgentIds")
            if (
                set(plan) != expected_keys
                or not isinstance(target_ids, list)
                or not all(isinstance(item, str) for item in target_ids)
            ):
                raise GroupStoreError("Stored cascade plan is corrupt")
            targets = [
                {"agentId": item, "replyMode": "mentioned"} for item in target_ids
            ]
        else:
            expected_keys = {
                "parseVersion",
                "sourceMessageId",
                "sourceRunId",
                "state",
                "targets",
                "version",
                "warnings",
            }
            targets = plan.get("targets")
            if (
                set(plan) != expected_keys
                or not isinstance(targets, list)
                or not all(isinstance(item, dict) for item in targets)
            ):
                raise GroupStoreError("Stored cascade plan is corrupt")
        if (
            len(targets) > MAX_AGENTS_PER_ROOM
            or any(set(item) != {"agentId", "replyMode"} for item in targets)
            or any(not isinstance(item.get("agentId"), str) for item in targets)
            or any(item.get("replyMode") not in {"mentioned", "automatic"} for item in targets)
            or len({item.get("agentId") for item in targets}) != len(targets)
        ):
            raise GroupStoreError("Stored cascade plan is corrupt")
        try:
            if (
                self._canonical_uuid(plan["sourceMessageId"], "sourceMessageId")
                != plan["sourceMessageId"]
            ):
                raise ValueError
            for target in targets:
                if (
                    self._canonical_uuid(target["agentId"], "targetAgentId")
                    != target["agentId"]
                ):
                    raise ValueError
            for warning in plan["warnings"]:
                if set(warning) != {"code", "message"} or warning.get("code") != "mention":
                    raise ValueError
                self._message_text(
                    warning.get("message"),
                    "warning.message",
                    max_bytes=MAX_MESSAGE_BYTES,
                    nonblank=True,
                )
        except (KeyError, TypeError, ValueError) as error:
            raise GroupStoreError("Stored cascade plan is corrupt") from error
        return {
            "parseVersion": parse_version,
            "sourceMessageId": plan["sourceMessageId"],
            "sourceRunId": source_id,
            "state": "pending",
            "targets": targets,
            "version": 1,
            "warnings": plan["warnings"],
        }

    def enqueue_cascade_runs(
        self,
        source_run_id: str,
        *,
        agent_ids: list[str],
        warnings: list[Mapping[str, object]],
    ) -> dict[str, object]:
        """Create bounded, deduplicated Agent cascades and visible warnings."""
        canonical_source_id = self._canonical_uuid(source_run_id, "sourceRunId")
        canonical_agent_ids, requested_warnings = self._validated_cascade_inputs(
            agent_ids, warnings
        )
        with self.write_transaction() as connection:
            source = self._run_row(connection, canonical_source_id)
            self._active_room(connection, source["room_id"])
            self._enabled_agent(connection, source["room_id"], source["agent_id"])
            if source["status"] != "completed":
                raise GroupConflictError("Cascade source run must be completed")
            source_message = self._message_row(
                connection, source["response_message_id"]
            )
            if source_message["status"] != "completed":
                raise GroupConflictError("Cascade source message must be completed")
            return self._enqueue_cascade_runs_transaction(
                connection,
                source=source,
                canonical_agent_ids=canonical_agent_ids,
                requested_warnings=requested_warnings,
                now=self._now(),
            )

    def _validated_cascade_inputs(
        self,
        agent_ids: object,
        warnings: object,
    ) -> tuple[list[str], list[str]]:
        if not isinstance(agent_ids, list):
            raise ValueError("agent_ids must be a list")
        if len(agent_ids) > MAX_AGENTS_PER_ROOM:
            raise ValueError(
                f"agent_ids must contain at most {MAX_AGENTS_PER_ROOM} entries"
            )
        canonical_agent_ids: list[str] = []
        seen_agent_ids: set[str] = set()
        for value in agent_ids:
            agent_id = self._canonical_uuid(value, "agentId")
            if agent_id not in seen_agent_ids:
                seen_agent_ids.add(agent_id)
                canonical_agent_ids.append(agent_id)
        if not isinstance(warnings, list):
            raise ValueError("warnings must be a list of objects")
        if len(warnings) > MAX_AGENTS_PER_ROOM:
            raise ValueError(
                f"warnings must contain at most {MAX_AGENTS_PER_ROOM} entries"
            )
        if not all(isinstance(item, Mapping) for item in warnings):
            raise ValueError("warnings must be a list of objects")
        warnings_json = self._strict_json(
            [dict(warning) for warning in warnings], "warnings"
        )
        if len(warnings_json.encode("utf-8")) > MAX_MESSAGE_BYTES:
            raise ValueError("warnings exceed maximum size")
        requested_warnings: list[str] = []
        for warning in warnings:
            message = warning.get("message")
            requested_warnings.append(
                self._message_text(
                    message,
                    "warning.message",
                    max_bytes=MAX_MESSAGE_BYTES,
                    nonblank=True,
                )
            )
        return canonical_agent_ids, requested_warnings

    def complete_cascade(self, source_run_id: str) -> dict[str, object]:
        """Execute one frozen Mention plan exactly once and terminalize it."""
        canonical_source_id = self._canonical_uuid(source_run_id, "sourceRunId")
        request_id = self._cascade_request_id(canonical_source_id)
        expected_hashes = {
            self._cascade_request_hash(canonical_source_id, parse_version=1),
            self._cascade_request_hash(canonical_source_id, parse_version=2),
            self._cascade_request_hash(canonical_source_id, parse_version=3),
        }
        with self.write_transaction() as connection:
            ledger = connection.execute(
                """SELECT request_id, operation, request_hash, response_json
                FROM group_idempotency WHERE request_id = ?""",
                (request_id,),
            ).fetchone()
            if ledger is None:
                raise GroupNotFoundError("Cascade source not found")
            if (
                ledger["operation"] not in _CASCADE_OPERATIONS
                or ledger["request_hash"] not in expected_hashes
            ):
                raise GroupStoreError("Stored cascade ledger is corrupt")
            if ledger["operation"] != _CASCADE_PENDING_OPERATION:
                return self._cascade_result(
                    ledger["response_json"], ledger["operation"]
                )
            plan = self._cascade_plan_from_ledger(ledger)
            source = connection.execute(
                "SELECT * FROM group_agent_runs WHERE id = ?",
                (canonical_source_id,),
            ).fetchone()
            if source is None:
                raise GroupStoreError("Stored cascade source is missing")
            room = connection.execute(
                "SELECT archived FROM group_rooms WHERE id = ?",
                (source["room_id"],),
            ).fetchone()
            source_agent = connection.execute(
                "SELECT enabled FROM group_agents WHERE id = ? AND room_id = ?",
                (source["agent_id"], source["room_id"]),
            ).fetchone()
            if room is None:
                raise GroupStoreError("Stored cascade ownership is corrupt")
            if source["status"] != "completed":
                raise GroupStoreError("Stored cascade source is not completed")
            source_message = self._message_row(
                connection, source["response_message_id"]
            )
            if (
                source_message["id"] != plan["sourceMessageId"]
                or source_message["status"] != "completed"
            ):
                raise GroupStoreError("Stored cascade message is corrupt")
            if room["archived"] or source_agent is None or not source_agent["enabled"]:
                result = self._cascade_summary([], [], state="discarded")
                connection.execute(
                    """UPDATE group_idempotency
                    SET operation = ?, response_json = ? WHERE request_id = ?""",
                    (
                        _CASCADE_DISCARDED_OPERATION,
                        self._canonical_json(result),
                        request_id,
                    ),
                )
                return result
            try:
                canonical_ids, warning_texts = self._validated_cascade_inputs(
                    [target["agentId"] for target in plan["targets"]],
                    plan["warnings"],
                )
                reply_modes = {
                    target["agentId"]: target["replyMode"]
                    for target in plan["targets"]
                }
            except ValueError as error:
                raise GroupStoreError("Stored cascade plan is corrupt") from error
            created = self._enqueue_cascade_runs_transaction(
                connection,
                source=source,
                canonical_agent_ids=canonical_ids,
                requested_warnings=warning_texts,
                reply_modes=reply_modes,
                now=self._now(),
            )
            result = self._cascade_summary(
                created["runs"], created["systemMessages"], state="completed"
            )
            connection.execute(
                """UPDATE group_idempotency
                SET operation = ?, response_json = ? WHERE request_id = ?""",
                (
                    _CASCADE_COMPLETED_OPERATION,
                    self._canonical_json(result),
                    request_id,
                ),
            )
            return result

    @classmethod
    def _cascade_result(cls, encoded: object, operation: str) -> dict[str, object]:
        try:
            result = cls._load_json(encoded)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise GroupStoreError("Stored cascade result is corrupt") from error
        expected_state = (
            "completed" if operation == _CASCADE_COMPLETED_OPERATION else "discarded"
        )
        expected_keys = {
            "runCount",
            "runIds",
            "state",
            "systemMessageCount",
            "systemMessageIds",
        }
        if expected_state == "discarded":
            expected_keys.add("discarded")
        if (
            not isinstance(result, dict)
            or cls._canonical_json(result) != encoded
            or set(result) != expected_keys
            or result.get("state") != expected_state
            or not isinstance(result.get("runIds"), list)
            or not all(isinstance(item, str) for item in result["runIds"])
            or len(result["runIds"]) > MAX_AGENTS_PER_ROOM
            or len(result["runIds"]) != len(set(result["runIds"]))
            or type(result.get("runCount")) is not int
            or result.get("runCount") != len(result["runIds"])
            or not isinstance(result.get("systemMessageIds"), list)
            or not all(isinstance(item, str) for item in result["systemMessageIds"])
            or len(result["systemMessageIds"]) > MAX_AGENTS_PER_ROOM
            or len(result["systemMessageIds"]) != len(set(result["systemMessageIds"]))
            or type(result.get("systemMessageCount")) is not int
            or result.get("systemMessageCount") != len(result["systemMessageIds"])
            or (expected_state == "discarded") != (result.get("discarded") is True)
        ):
            raise GroupStoreError("Stored cascade result is corrupt")
        try:
            if any(
                cls._canonical_uuid(item, "runId") != item for item in result["runIds"]
            ) or any(
                cls._canonical_uuid(item, "messageId") != item
                for item in result["systemMessageIds"]
            ):
                raise ValueError
        except ValueError as error:
            raise GroupStoreError("Stored cascade result is corrupt") from error
        return result

    @staticmethod
    def _cascade_summary(
        runs: list[Mapping[str, object]],
        messages: list[Mapping[str, object]],
        *,
        state: str,
    ) -> dict[str, object]:
        result: dict[str, object] = {
            "runCount": len(runs),
            "runIds": [run["id"] for run in runs],
            "state": state,
            "systemMessageCount": len(messages),
            "systemMessageIds": [message["id"] for message in messages],
        }
        if state == "discarded":
            result["discarded"] = True
        return result

    def _enqueue_cascade_runs_transaction(
        self,
        connection: sqlite3.Connection,
        *,
        source: sqlite3.Row,
        canonical_agent_ids: list[str],
        requested_warnings: list[str],
        now: float,
        reply_modes: Mapping[str, str] | None = None,
    ) -> dict[str, list[dict[str, object]]]:
        room = self._active_room(connection, source["room_id"])
        room_agents = connection.execute(
            """SELECT * FROM group_agents WHERE room_id = ?
            ORDER BY created_at ASC, id ASC""",
            (source["room_id"],),
        ).fetchall()
        agents_by_id = {agent["id"]: agent for agent in room_agents}
        warning_texts = list(requested_warnings)
        next_depth = int(source["depth"]) + 1
        max_reply_rounds = int(room["max_reply_rounds"])
        if max_reply_rounds != -1 and next_depth >= max_reply_rounds:
            warning_texts.append("Cascade depth limit reached")
            canonical_agent_ids = []
        source_message = self._message_row(connection, source["response_message_id"])
        explicit_ids, _ = self._plan_cascade_mentions(
            source_message["content"],
            room_agents,
            source_agent_id=source["agent_id"],
            include_automatic=False,
        )
        explicit_set = set(explicit_ids)
        created_runs: list[dict[str, object]] = []
        for agent_id in canonical_agent_ids:
            agent = agents_by_id.get(agent_id)
            if agent is None:
                warning_texts.append(f"Unknown Agent: {agent_id}")
                continue
            if not agent["enabled"]:
                warning_texts.append(f"Agent disabled: {agent['display_name']}")
                continue
            duplicate = connection.execute(
                """SELECT 1 FROM group_agent_runs
                WHERE room_id = ? AND topic_id = ? AND root_message_id = ?
                  AND agent_id = ? AND depth = ? LIMIT 1""",
                (
                    source["room_id"],
                    source["topic_id"],
                    source["root_message_id"],
                    agent_id,
                    next_depth,
                ),
            ).fetchone()
            if duplicate is not None:
                continue
            reply_mode = (
                reply_modes.get(agent_id, "mentioned")
                if reply_modes is not None
                else ("mentioned" if agent_id in explicit_set else "automatic")
            )
            if reply_mode not in {"mentioned", "automatic"}:
                raise GroupStoreError("Stored cascade plan is corrupt")
            visible = reply_mode == "mentioned"
            response_id = str(uuid.uuid4())
            run_id = str(uuid.uuid4())
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                 root_message_id, reply_to_message_id, client_message_id,
                 content, reasoning, tool_state_json, status, error, visible,
                 created_at, updated_at)
                VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, NULL,
                        '', '', '[]', 'queued', '', ?, ?, ?)""",
                (
                    response_id,
                    source["room_id"],
                    source["topic_id"],
                    agent_id,
                    agent["display_name"],
                    source["root_message_id"],
                    source["response_message_id"],
                    int(visible),
                    now,
                    now,
                ),
            )
            connection.execute(
                """INSERT INTO group_agent_runs
                (id, room_id, topic_id, agent_id, trigger_message_id,
                 response_message_id, root_message_id, depth, reply_mode,
                 required_reply, status, runtime_session_id, requested_model,
                 requested_provider, requested_reasoning_effort,
                 requested_fast_mode, actual_model, actual_provider,
                 actual_reasoning_effort, actual_fast_mode, error, created_at,
                 updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', NULL,
                        ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', ?, ?)""",
                (
                    run_id,
                    source["room_id"],
                    source["topic_id"],
                    agent_id,
                    source["response_message_id"],
                    response_id,
                    source["root_message_id"],
                    next_depth,
                    reply_mode,
                    agent["model_override"],
                    agent["provider_override"],
                    agent["reasoning_effort_override"],
                    agent["fast_mode_override"],
                    now,
                    now,
                ),
            )
            message = self._message_wire(self._message_row(connection, response_id))
            run = self._run_wire(self._run_row(connection, run_id))
            if visible:
                self._append_event(
                    connection,
                    source["room_id"],
                    "message.upsert",
                    message,
                    created_at=now,
                )
            self._append_event(
                connection,
                source["room_id"],
                "run.updated",
                run,
                created_at=now,
            )
            created_runs.append(run)
        system_messages: list[dict[str, object]] = []
        for warning_text in list(dict.fromkeys(warning_texts))[:MAX_AGENTS_PER_ROOM]:
            duplicate = connection.execute(
                """SELECT * FROM group_messages
                WHERE room_id = ? AND topic_id = ? AND sender_kind = 'system'
                  AND root_message_id = ? AND reply_to_message_id = ?
                  AND content = ? AND status = 'completed'
                ORDER BY seq ASC LIMIT 1""",
                (
                    source["room_id"],
                    source["topic_id"],
                    source["root_message_id"],
                    source["response_message_id"],
                    warning_text,
                ),
            ).fetchone()
            if duplicate is not None:
                continue
            message_id = str(uuid.uuid4())
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                 root_message_id, reply_to_message_id, client_message_id,
                 content, reasoning, tool_state_json, status, error,
                 created_at, updated_at)
                VALUES (?, ?, ?, 'system', 'system', '系统', ?, ?, NULL,
                        ?, '', '[]', 'completed', '', ?, ?)""",
                (
                    message_id,
                    source["room_id"],
                    source["topic_id"],
                    source["root_message_id"],
                    source["response_message_id"],
                    warning_text,
                    now,
                    now,
                ),
            )
            message = self._message_wire(self._message_row(connection, message_id))
            self._append_event(
                connection,
                source["room_id"],
                "message.upsert",
                message,
                created_at=now,
            )
            system_messages.append(message)
        return {"runs": created_runs, "systemMessages": system_messages}

    def upsert_agent_message(
        self,
        run_id: str,
        *,
        content: str,
        reasoning: str,
        tool_state: object,
        status: str,
        error: str = "",
        publish: bool = True,
    ) -> dict[str, object]:
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        content = self._message_text(content, "content", max_bytes=MAX_MESSAGE_BYTES)
        reasoning = self._message_text(
            reasoning, "reasoning", max_bytes=MAX_MESSAGE_BYTES
        )
        error = self._message_text(error, "error", max_bytes=4096)
        if not isinstance(status, str) or status not in _MESSAGE_STATUSES:
            raise ValueError("status is invalid")
        tool_json = self._tool_state_json(tool_state)
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            self._active_room(connection, run["room_id"])
            self._enabled_agent(connection, run["room_id"], run["agent_id"])
            response = self._message_row(connection, run["response_message_id"])
            if (
                response["room_id"] != run["room_id"]
                or response["sender_id"] != run["agent_id"]
            ):
                raise GroupStoreError("Run response message is corrupt")
            self._validate_run_message_state(run, response)
            if status not in _AGENT_MESSAGE_STATUSES_BY_RUN[run["status"]]:
                raise GroupConflictError("Message status is invalid for run state")
            if status not in _AGENT_MESSAGE_TRANSITIONS.get(
                response["status"], frozenset()
            ):
                raise GroupConflictError("Message status cannot move backwards")
            now = self._now()
            visible = bool(response["visible"]) or publish
            connection.execute(
                """UPDATE group_messages SET content = ?, reasoning = ?, tool_state_json = ?,
                status = ?, error = ?, visible = ?, updated_at = ? WHERE id = ?""",
                (
                    content,
                    reasoning,
                    tool_json,
                    status,
                    error,
                    int(visible),
                    now,
                    run["response_message_id"],
                ),
            )
            message = self._message_wire(
                self._message_row(connection, run["response_message_id"])
            )
            if visible:
                self._append_event(
                    connection,
                    run["room_id"],
                    "message.upsert",
                    message,
                    created_at=now,
                )
            return message

    def transition_run(
        self,
        run_id: str,
        status: str,
        *,
        runtime_session_id: object = UNSET,
        error: object = UNSET,
    ) -> dict[str, object]:
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        if not isinstance(status, str) or status not in RUN_TRANSITIONS:
            raise ValueError("status is invalid")
        runtime_value = (
            self._runtime_session_id(runtime_session_id)
            if runtime_session_id is not UNSET
            else UNSET
        )
        error_value = (
            self._message_text(error, "error", max_bytes=4096)
            if error is not UNSET
            else UNSET
        )
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            self._active_room(connection, run["room_id"])
            self._enabled_agent(connection, run["room_id"], run["agent_id"])
            response = self._message_row(connection, run["response_message_id"])
            if (
                response["room_id"] != run["room_id"]
                or response["sender_id"] != run["agent_id"]
            ):
                raise GroupStoreError("Run response message is corrupt")
            self._validate_run_message_state(run, response)
            if status == run["status"]:
                if status == "running":
                    if (
                        runtime_value is not UNSET
                        and runtime_value is not None
                        and run["runtime_session_id"] is not None
                        and runtime_value == run["runtime_session_id"]
                    ):
                        return self._run_wire(run)
                    raise GroupConflictError("Run is already claimed")
                return self._run_wire(run)
            if status not in RUN_TRANSITIONS[run["status"]]:
                raise GroupConflictError("Illegal run status transition")
            if status == "completed" and response["status"] != "completed":
                raise GroupConflictError("Response message must be completed first")
            if status not in {"failed", "interrupted"}:
                self._validate_run_message_status(status, response["status"])
            now = self._now()
            if status in {"completed", "failed", "interrupted"}:
                self._cancel_pending_interactions(connection, run, now)
            result = self._update_run(
                connection, run, status, now, runtime_value, error_value
            )
            if status in {"completed", "failed", "interrupted"}:
                self._fail_claimed_interaction_ledgers(
                    connection,
                    run_id=run["id"],
                    reason=result["error"] or f"Run {status}",
                    runtime_session_ids=(
                        []
                        if run["runtime_session_id"] is None
                        else [run["runtime_session_id"]]
                    ),
                    run=result,
                )
            self._append_event(
                connection, result["roomId"], "run.updated", result, created_at=now
            )
            if status in {"failed", "interrupted"}:
                if response["status"] == "completed":
                    self._validate_run_message_status(status, response["status"])
                else:
                    terminal_error = result["error"]
                    connection.execute(
                        """UPDATE group_messages
                        SET status = ?, error = ?, updated_at = ? WHERE id = ?""",
                        (status, terminal_error, now, run["response_message_id"]),
                    )
                    message = self._message_wire(
                        self._message_row(connection, run["response_message_id"])
                    )
                    self._validate_run_message_status(
                        result["status"], message["status"]
                    )
                    if message["visible"]:
                        self._append_event(
                            connection,
                            result["roomId"],
                            "message.upsert",
                            message,
                            created_at=now,
                        )
            return result

    def bind_run_runtime(
        self, run_id: str, runtime_session_id: str
    ) -> dict[str, object]:
        """Bind the first real runtime identity without reopening the run claim."""
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        runtime_value = self._runtime_session_id(runtime_session_id)
        if runtime_value is None:
            raise ValueError("runtimeSessionId is invalid")
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            self._active_room(connection, run["room_id"])
            self._enabled_agent(connection, run["room_id"], run["agent_id"])
            response = self._message_row(connection, run["response_message_id"])
            self._validate_run_message_state(run, response)
            if run["status"] not in {"running", "awaiting_input"}:
                raise GroupConflictError("Run does not accept a runtime binding")
            if run["runtime_session_id"] == runtime_value:
                return self._run_wire(run)
            if run["runtime_session_id"] is not None:
                raise GroupConflictError("Run runtime is already bound")
            self._require_available_runtime(connection, runtime_value, canonical_run_id)
            now = self._now()
            result = self._update_run(
                connection, run, run["status"], now, runtime_value, UNSET
            )
            self._append_event(
                connection, run["room_id"], "run.updated", result, created_at=now
            )
            return result

    def create_interaction(
        self,
        interaction_id: str,
        run_id: str,
        *,
        kind: str,
        payload: object,
    ) -> dict[str, object]:
        return self._create_gateway_interaction(
            run_id,
            kind=kind,
            gateway_interaction_id=interaction_id,
            payload=payload,
            allow_awaiting=False,
        )

    def create_gateway_interaction(
        self,
        run_id: str,
        *,
        kind: str,
        gateway_interaction_id: str | None,
        payload: object,
    ) -> dict[str, object]:
        return self._create_gateway_interaction(
            run_id,
            kind=kind,
            gateway_interaction_id=gateway_interaction_id,
            payload=payload,
            allow_awaiting=True,
        )

    def _create_gateway_interaction(
        self,
        run_id: str,
        *,
        kind: str,
        gateway_interaction_id: str | None,
        payload: object,
        allow_awaiting: bool,
    ) -> dict[str, object]:
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        if not isinstance(kind, str) or kind not in _INTERACTION_KINDS:
            raise ValueError("kind is invalid")
        payload_json = self._json_object(payload, "payload")
        payload_value = self._load_json(payload_json)
        clarification_gateway_id: str | None = None
        if kind == "approval" and gateway_interaction_id is None:
            interaction_id = f"approval-{uuid.uuid4()}"
        elif gateway_interaction_id is None:
            raise ValueError("Gateway clarification interactionId is required")
        else:
            gateway_id = self._interaction_id(gateway_interaction_id)
            if kind == "clarification" and allow_awaiting:
                if "gatewayRequestId" in payload_value:
                    raise ValueError("payload.gatewayRequestId is reserved")
                payload_value["gatewayRequestId"] = gateway_id
                payload_json = self._json_object(payload_value, "payload")
                clarification_gateway_id = gateway_id
                interaction_id = None
            else:
                interaction_id = gateway_id
        try:
            with self.write_transaction() as connection:
                run = self._run_row(connection, canonical_run_id)
                self._active_room(connection, run["room_id"])
                self._enabled_agent(connection, run["room_id"], run["agent_id"])
                response = self._message_row(connection, run["response_message_id"])
                self._validate_run_message_state(run, response)
                accepted_statuses = (
                    {"running", "awaiting_input"} if allow_awaiting else {"running"}
                )
                if run["status"] not in accepted_statuses:
                    raise GroupConflictError("Interaction requires a running run")
                self._validate_run_message_status("awaiting_input", response["status"])
                if clarification_gateway_id is not None:
                    pending = connection.execute(
                        """SELECT * FROM group_interactions
                        WHERE run_id = ? AND kind = 'clarification'
                          AND status = 'pending' ORDER BY rowid ASC""",
                        (canonical_run_id,),
                    ).fetchall()
                    matching = []
                    for candidate in pending:
                        candidate_wire = self._interaction_wire(candidate)
                        if (
                            candidate_wire["payload"].get("gatewayRequestId")
                            == clarification_gateway_id
                        ):
                            matching.append(candidate)
                    if len(matching) > 1:
                        raise GroupStoreError(
                            "Stored clarification identities are not unique"
                        )
                    if matching:
                        existing = matching[0]
                        if existing["payload_json"] != payload_json:
                            raise GroupConflictError("Interaction already exists")
                        return self._interaction_wire(existing)
                    interaction_id = f"clarification-{uuid.uuid4()}"
                if interaction_id is None:
                    raise GroupStoreError("Interaction identity is missing")
                existing = connection.execute(
                    "SELECT * FROM group_interactions WHERE id = ?",
                    (interaction_id,),
                ).fetchone()
                if existing is not None:
                    if (
                        existing["room_id"] != run["room_id"]
                        or existing["agent_id"] != run["agent_id"]
                        or existing["run_id"] != canonical_run_id
                        or existing["kind"] != kind
                        or existing["payload_json"] != payload_json
                    ):
                        raise GroupConflictError("Interaction already exists")
                    return self._interaction_wire(existing)
                now = self._now()
                connection.execute(
                    """INSERT INTO group_interactions
                    (id, room_id, topic_id, agent_id, run_id, kind, payload_json, status, created_at, resolved_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)""",
                    (
                        interaction_id,
                        run["room_id"],
                        run["topic_id"],
                        run["agent_id"],
                        canonical_run_id,
                        kind,
                        payload_json,
                        now,
                    ),
                )
                interaction = self._interaction_wire(
                    self._interaction_row(connection, interaction_id)
                )
                self._append_event(
                    connection,
                    run["room_id"],
                    "interaction.requested",
                    interaction,
                    created_at=now,
                )
                if run["status"] == "running":
                    changed = self._update_run(
                        connection, run, "awaiting_input", now, UNSET, UNSET
                    )
                    self._append_event(
                        connection,
                        run["room_id"],
                        "run.updated",
                        changed,
                        created_at=now,
                    )
                return interaction
        except sqlite3.IntegrityError as error:
            if "group_interactions.id" in str(error):
                raise GroupConflictError("Interaction already exists") from error
            raise self._integrity_conflict(error) from error

    def resolve_interaction(
        self, interaction_id: str, *, status: str = "resolved"
    ) -> dict[str, object]:
        interaction_id = self._interaction_id(interaction_id)
        if not isinstance(status, str) or status not in _INTERACTION_TERMINAL_STATUSES:
            raise ValueError("status must be resolved or cancelled")
        with self.write_transaction() as connection:
            interaction = self._interaction_row(connection, interaction_id)
            if interaction["status"] != "pending":
                raise GroupConflictError("Interaction is already resolved")
            run = self._run_row(connection, interaction["run_id"])
            self._active_room(connection, run["room_id"])
            self._enabled_agent(connection, run["room_id"], run["agent_id"])
            response = self._message_row(connection, run["response_message_id"])
            self._validate_run_message_state(run, response)
            now = self._now()
            connection.execute(
                "UPDATE group_interactions SET status = ?, resolved_at = ? WHERE id = ?",
                (status, now, interaction_id),
            )
            result = self._interaction_wire(
                self._interaction_row(connection, interaction_id)
            )
            self._append_event(
                connection,
                result["roomId"],
                "interaction.resolved",
                result,
                created_at=now,
            )
            if status == "resolved":
                if run["status"] != "awaiting_input":
                    raise GroupConflictError("Interaction run is not awaiting input")
                remaining = connection.execute(
                    """SELECT 1 FROM group_interactions
                    WHERE run_id = ? AND status = 'pending' LIMIT 1""",
                    (run["id"],),
                ).fetchone()
                if remaining is None:
                    self._validate_run_message_status("running", response["status"])
                    changed = self._update_run(
                        connection, run, "running", now, UNSET, UNSET
                    )
                    self._append_event(
                        connection,
                        changed["roomId"],
                        "run.updated",
                        changed,
                        created_at=now,
                    )
                    run_result = changed
                else:
                    run_result = self._run_wire(run)
            else:
                run_result = self._run_wire(run)
            self._fail_claimed_interaction_ledgers(
                connection,
                run_id=run["id"],
                interaction_id=interaction_id,
                reason=f"Interaction {status}",
                runtime_session_ids=(
                    []
                    if run["runtime_session_id"] is None
                    else [run["runtime_session_id"]]
                ),
                run=run_result,
            )
            return result

    def begin_interaction_response(
        self,
        room_id: str,
        interaction_id: str,
        *,
        request_id: str,
        kind: str,
        response: Mapping[str, object],
    ) -> dict[str, object]:
        """Durably claim one FIFO Gateway response without a public status."""
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        interaction_id = self._interaction_id(interaction_id)
        canonical_request_id = self._canonical_uuid(request_id, "requestId")
        if kind not in _INTERACTION_KINDS:
            raise ValueError("kind is invalid")
        response_json = self._json_object(response, "response")
        response_value = self._load_json(response_json)
        legacy_operation = f"interaction.{kind}.response"
        operation = self._interaction_operation(kind, interaction_id)
        payload = {
            "roomId": canonical_room_id,
            "interactionId": interaction_id,
            "kind": kind,
            "response": response_value,
        }
        request_hash = hashlib.sha256(
            self._canonical_json(payload).encode()
        ).hexdigest()
        with self.write_transaction() as connection:
            existing = connection.execute(
                """SELECT operation, request_hash, response_json
                FROM group_idempotency WHERE request_id = ?""",
                (canonical_request_id,),
            ).fetchone()
            if existing is not None:
                if (
                    existing["operation"] not in {operation, legacy_operation}
                    or existing["request_hash"] != request_hash
                ):
                    raise IdempotencyConflict(
                        "requestId was already used for a different request"
                    )
                state = self._idempotency_state(existing["response_json"])
                if state["state"] == "claimed":
                    raise GroupConflictError(
                        "Interaction response is already in progress"
                    )
                if state["state"] == "completed":
                    return {"state": "replay", "response": state["response"]}
                if state["state"] == "failed":
                    return state
                raise GroupStoreError("Stored interaction response is corrupt")
            competing = connection.execute(
                """SELECT operation, response_json FROM group_idempotency
                WHERE operation IN (?, ?)""",
                (operation, legacy_operation),
            ).fetchall()
            for candidate in competing:
                state = self._idempotency_state(candidate["response_json"])
                if (
                    state["state"] == "claimed"
                    and state["interactionId"] == interaction_id
                ):
                    raise GroupConflictError("Interaction response is already claimed")
            interaction = self._interaction_row(connection, interaction_id)
            if interaction["room_id"] != canonical_room_id:
                raise GroupNotFoundError("Interaction not found")
            if interaction["kind"] != kind:
                raise GroupConflictError("Interaction kind does not match")
            if interaction["status"] != "pending":
                raise GroupConflictError("Interaction is already resolved")
            run = self._run_row(connection, interaction["run_id"])
            self._active_room(connection, canonical_room_id)
            self._enabled_agent(connection, canonical_room_id, run["agent_id"])
            if run["status"] != "awaiting_input":
                raise GroupConflictError("Interaction run is not awaiting input")
            if run["runtime_session_id"] is None:
                raise GroupConflictError("Interaction run has no runtime session")
            first = connection.execute(
                """SELECT id FROM group_interactions
                WHERE run_id = ? AND kind = ? AND status = 'pending'
                ORDER BY rowid ASC LIMIT 1""",
                (run["id"], kind),
            ).fetchone()
            if first is None or first["id"] != interaction_id:
                raise GroupConflictError(
                    "Interaction responses must preserve FIFO order"
                )
            sentinel = {
                "state": "claimed",
                "interactionId": interaction_id,
                "kind": kind,
            }
            connection.execute(
                """INSERT INTO group_idempotency
                (request_id, operation, request_hash, response_json, created_at)
                VALUES (?, ?, ?, ?, ?)""",
                (
                    canonical_request_id,
                    operation,
                    request_hash,
                    self._canonical_json(sentinel),
                    self._now(),
                ),
            )
            return {
                "state": "claimed",
                "interaction": self._interaction_wire(interaction),
                "run": self._run_wire(run),
            }

    def finish_interaction_response(
        self,
        request_id: str,
        *,
        response: Mapping[str, object],
        interaction_status: str = "resolved",
    ) -> dict[str, object]:
        """Commit a known Gateway response and release the run when possible."""
        if interaction_status not in _INTERACTION_TERMINAL_STATUSES:
            raise ValueError("interaction_status must be resolved or cancelled")
        canonical_request_id = self._canonical_uuid(request_id, "requestId")
        response_json = self._json_object(response, "response")
        public_response = self._load_json(response_json)
        with self.write_transaction() as connection:
            claim = connection.execute(
                """SELECT operation, response_json FROM group_idempotency
                WHERE request_id = ?""",
                (canonical_request_id,),
            ).fetchone()
            operation = (
                None
                if claim is None
                else self._interaction_response_operation(claim["operation"])
            )
            if claim is None or operation is None:
                raise GroupNotFoundError("Interaction response claim not found")
            state = self._idempotency_state(claim["response_json"])
            if state["state"] == "claimed" and (
                operation[0] != state["kind"]
                or (operation[1] is not None and operation[1] != state["interactionId"])
            ):
                raise GroupStoreError("Stored interaction response is corrupt")
            if state["state"] == "completed":
                stored_status = state.get("interactionStatus", "resolved")
                if stored_status != interaction_status:
                    raise GroupConflictError(
                        "Interaction response terminal status changed"
                    )
                return state["response"]
            if state["state"] != "claimed":
                raise GroupConflictError("Interaction response claim is terminal")
            interaction = self._interaction_row(connection, state["interactionId"])
            if interaction["status"] != "pending":
                raise GroupConflictError("Interaction is already resolved")
            run = self._run_row(connection, interaction["run_id"])
            self._active_room(connection, run["room_id"])
            self._enabled_agent(connection, run["room_id"], run["agent_id"])
            if run["status"] != "awaiting_input":
                raise GroupConflictError("Interaction run is not awaiting input")
            now = self._now()
            connection.execute(
                """UPDATE group_interactions
                SET status = ?, resolved_at = ? WHERE id = ?""",
                (interaction_status, now, interaction["id"]),
            )
            resolved = self._interaction_wire(
                self._interaction_row(connection, interaction["id"])
            )
            self._append_event(
                connection,
                run["room_id"],
                "interaction.resolved",
                resolved,
                created_at=now,
            )
            pending = connection.execute(
                """SELECT 1 FROM group_interactions
                WHERE run_id = ? AND status = 'pending' LIMIT 1""",
                (run["id"],),
            ).fetchone()
            if pending is None:
                response_row = self._message_row(connection, run["response_message_id"])
                self._validate_run_message_status("running", response_row["status"])
                changed = self._update_run(
                    connection, run, "running", now, UNSET, UNSET
                )
                self._append_event(
                    connection,
                    run["room_id"],
                    "run.updated",
                    changed,
                    created_at=now,
                )
            final = {
                "state": "completed",
                "interactionStatus": interaction_status,
                "response": public_response,
            }
            connection.execute(
                """UPDATE group_idempotency SET response_json = ?
                WHERE request_id = ?""",
                (self._canonical_json(final), canonical_request_id),
            )
            return public_response

    def fail_interaction_response(
        self, request_id: str, *, reason: str, uncertain: bool
    ) -> dict[str, object]:
        """Fail closed on an unknown Gateway outcome or release a retryable claim."""
        canonical_request_id = self._canonical_uuid(request_id, "requestId")
        failure_reason = self._message_text(
            reason, "reason", max_bytes=4096, nonblank=True
        )
        if not isinstance(uncertain, bool):
            raise ValueError("uncertain must be a boolean")
        with self.write_transaction() as connection:
            claim = connection.execute(
                """SELECT operation, response_json FROM group_idempotency
                WHERE request_id = ?""",
                (canonical_request_id,),
            ).fetchone()
            operation = (
                None
                if claim is None
                else self._interaction_response_operation(claim["operation"])
            )
            if claim is None or operation is None:
                raise GroupNotFoundError("Interaction response claim not found")
            state = self._idempotency_state(claim["response_json"])
            if state["state"] == "claimed" and (
                operation[0] != state["kind"]
                or (operation[1] is not None and operation[1] != state["interactionId"])
            ):
                raise GroupStoreError("Stored interaction response is corrupt")
            if state["state"] == "failed":
                return state
            if state["state"] != "claimed":
                raise GroupConflictError("Interaction response claim is terminal")
            interaction = self._interaction_row(connection, state["interactionId"])
            run = self._run_row(connection, interaction["run_id"])
            self._active_room(connection, run["room_id"])
            self._enabled_agent(connection, run["room_id"], run["agent_id"])
            if run["status"] != "awaiting_input":
                raise GroupConflictError("Interaction run is not awaiting input")
            if not uncertain:
                connection.execute(
                    "DELETE FROM group_idempotency WHERE request_id = ?",
                    (canonical_request_id,),
                )
                return {"state": "retryable"}
            runtime_ids = (
                [] if run["runtime_session_id"] is None else [run["runtime_session_id"]]
            )
            now = self._now()
            self._cancel_pending_interactions(connection, run, now)
            response_row = self._message_row(connection, run["response_message_id"])
            changed = self._update_run(
                connection, run, "failed", now, None, failure_reason
            )
            self._append_event(
                connection,
                run["room_id"],
                "run.updated",
                changed,
                created_at=now,
            )
            if response_row["status"] != "completed":
                connection.execute(
                    """UPDATE group_messages
                    SET status = 'failed', error = ?, updated_at = ? WHERE id = ?""",
                    (failure_reason, now, response_row["id"]),
                )
                message = self._message_wire(
                    self._message_row(connection, response_row["id"])
                )
                if message["visible"]:
                    self._append_event(
                        connection,
                        run["room_id"],
                        "message.upsert",
                        message,
                        created_at=now,
                    )
            self._append_agent_status(connection, run["room_id"], run["agent_id"], now)
            final = {
                "state": "failed",
                "reason": failure_reason,
                "runtimeSessionIds": runtime_ids,
                "run": self._legacy_interaction_failure_run(changed),
            }
            self._fail_claimed_interaction_ledgers(
                connection,
                run_id=run["id"],
                reason=failure_reason,
                runtime_session_ids=runtime_ids,
                run=changed,
            )
            connection.execute(
                """UPDATE group_idempotency SET response_json = ?
                WHERE request_id = ?""",
                (self._canonical_json(final), canonical_request_id),
            )
            return final

    def expire_interaction(self, interaction_id: str) -> dict[str, object]:
        """Idempotently cancel a stale interaction and resume when it was last."""
        interaction_id = self._interaction_id(interaction_id)
        with self.write_transaction() as connection:
            interaction = self._interaction_row(connection, interaction_id)
            if interaction["status"] != "pending":
                return self._interaction_wire(interaction)
            run = self._run_row(connection, interaction["run_id"])
            self._active_room(connection, run["room_id"])
            self._enabled_agent(connection, run["room_id"], run["agent_id"])
            now = self._now()
            connection.execute(
                """UPDATE group_interactions
                SET status = 'cancelled', resolved_at = ? WHERE id = ?""",
                (now, interaction_id),
            )
            result = self._interaction_wire(
                self._interaction_row(connection, interaction_id)
            )
            self._append_event(
                connection,
                run["room_id"],
                "interaction.resolved",
                result,
                created_at=now,
            )
            remaining = connection.execute(
                """SELECT 1 FROM group_interactions
                WHERE run_id = ? AND status = 'pending' LIMIT 1""",
                (run["id"],),
            ).fetchone()
            if run["status"] == "awaiting_input" and remaining is None:
                response = self._message_row(connection, run["response_message_id"])
                self._validate_run_message_status("running", response["status"])
                changed = self._update_run(
                    connection, run, "running", now, UNSET, UNSET
                )
                self._append_event(
                    connection,
                    run["room_id"],
                    "run.updated",
                    changed,
                    created_at=now,
                )
                run_result = changed
            else:
                run_result = self._run_wire(run)
            self._fail_claimed_interaction_ledgers(
                connection,
                run_id=run["id"],
                interaction_id=interaction_id,
                reason="Interaction expired",
                runtime_session_ids=(
                    []
                    if run["runtime_session_id"] is None
                    else [run["runtime_session_id"]]
                ),
                run=run_result,
            )
            return result

    def events_after(
        self, cursor: int, limit: int = MAX_EVENT_BATCH_SIZE
    ) -> list[dict[str, object]]:
        cursor = self._nonnegative_int(cursor, "cursor")
        self._page_limit(limit, MAX_EVENT_BATCH_SIZE, "limit")
        with self.read_transaction() as connection:
            current_epoch = self._validated_epoch(
                self._metadata_value_from_connection(connection, "journal_epoch")
            )
            rows = connection.execute(
                "SELECT * FROM group_events WHERE cursor > ? ORDER BY cursor ASC LIMIT ?",
                (cursor, limit),
            ).fetchall()
            return [self._event_wire(row, current_epoch) for row in rows]

    def cursor_status(self, epoch: str, cursor: int) -> str:
        canonical_epoch = self._canonical_uuid(epoch, "epoch")
        cursor = self._nonnegative_int(cursor, "cursor")
        with self.read_transaction() as connection:
            if canonical_epoch != self._validated_epoch(
                self._metadata_value_from_connection(connection, "journal_epoch")
            ):
                return "epoch_mismatch"
            bounds = connection.execute(
                "SELECT MIN(cursor) AS oldest, MAX(cursor) AS latest FROM group_events"
            ).fetchone()
            latest = int(bounds["latest"] or 0)
            if cursor > latest:
                return "cursor_expired"
            oldest = bounds["oldest"]
            if oldest is not None and cursor < int(oldest) - 1:
                return "cursor_expired"
            return "ok"

    def prune_events(self, now: float | None = None) -> int:
        prune_now = self._now() if now is None else self._finite_timestamp(now, "now")
        with self.write_transaction() as connection:
            threshold = connection.execute(
                "SELECT cursor FROM group_events ORDER BY cursor DESC LIMIT 1 OFFSET ?",
                (MIN_RETAINED_EVENTS - 1,),
            ).fetchone()
            if threshold is None:
                return 0
            result = connection.execute(
                "DELETE FROM group_events WHERE created_at < ? AND cursor < ?",
                (prune_now - EVENT_RETENTION_SECONDS, threshold["cursor"]),
            )
            return result.rowcount

    def _interrupt_runs_for_scope(
        self,
        connection: sqlite3.Connection,
        *,
        room_id: str,
        reason: str,
        now: float,
        agent_id: str | None = None,
        include_queued: bool = True,
    ) -> dict[str, list[str]]:
        statuses = (
            "('queued', 'running', 'awaiting_input')"
            if include_queued
            else "('running', 'awaiting_input')"
        )
        query = f"""SELECT run.* FROM group_agent_runs AS run
            JOIN group_messages AS response
              ON response.id = run.response_message_id
            WHERE run.room_id = ? AND run.status IN {statuses}"""
        params: list[object] = [room_id]
        if agent_id is not None:
            query += " AND run.agent_id = ?"
            params.append(agent_id)
        query += " ORDER BY response.seq ASC, run.id ASC"
        runs = connection.execute(query, params).fetchall()
        changed_ids: list[str] = []
        runtime_ids: list[str] = []
        for run in runs:
            run_runtime_ids = (
                [] if run["runtime_session_id"] is None else [run["runtime_session_id"]]
            )
            if (
                run["runtime_session_id"] is not None
                and run["runtime_session_id"] not in runtime_ids
            ):
                runtime_ids.append(run["runtime_session_id"])
            response = self._message_row(connection, run["response_message_id"])
            if (
                response["room_id"] != run["room_id"]
                or response["sender_id"] != run["agent_id"]
            ):
                raise GroupStoreError("Run response message is corrupt")
            self._validate_run_message_state(run, response)
            changed = self._update_run(
                connection, run, "interrupted", now, None, reason
            )
            self._append_event(
                connection, room_id, "run.updated", changed, created_at=now
            )
            if response["status"] == "completed":
                self._validate_run_message_status(changed["status"], response["status"])
            else:
                connection.execute(
                    """UPDATE group_messages
                    SET status = 'interrupted', error = ?, updated_at = ? WHERE id = ?""",
                    (reason, now, run["response_message_id"]),
                )
                message = self._message_wire(
                    self._message_row(connection, run["response_message_id"])
                )
                self._validate_run_message_status(changed["status"], message["status"])
                if message["visible"]:
                    self._append_event(
                        connection,
                        room_id,
                        "message.upsert",
                        message,
                        created_at=now,
                    )
            self._cancel_pending_interactions(
                connection, run, now, order_by_created_at=True
            )
            self._fail_claimed_interaction_ledgers(
                connection,
                run_id=run["id"],
                reason=reason,
                runtime_session_ids=run_runtime_ids,
                run=changed,
            )
            changed_ids.append(run["id"])
        return {"runIds": changed_ids, "runtimeSessionIds": runtime_ids}

    def recover_after_restart(self) -> list[str]:
        with self.write_transaction() as connection:
            runs = connection.execute(
                "SELECT * FROM group_agent_runs WHERE status IN ('running', 'awaiting_input') ORDER BY created_at ASC, id ASC"
            ).fetchall()
            if not runs:
                return []
            now = self._now()
            changed_ids: list[str] = []
            for run in runs:
                runtime_ids = (
                    []
                    if run["runtime_session_id"] is None
                    else [run["runtime_session_id"]]
                )
                response = self._message_row(connection, run["response_message_id"])
                if (
                    response["room_id"] != run["room_id"]
                    or response["sender_id"] != run["agent_id"]
                ):
                    raise GroupStoreError("Run response message is corrupt")
                self._validate_run_message_state(run, response)
                changed = self._update_run(
                    connection, run, "interrupted", now, None, "Dashboard restarted"
                )
                self._append_event(
                    connection, run["room_id"], "run.updated", changed, created_at=now
                )
                if response["status"] == "completed":
                    self._validate_run_message_status(
                        changed["status"], response["status"]
                    )
                else:
                    connection.execute(
                        """UPDATE group_messages
                        SET status = 'interrupted', error = 'Dashboard restarted',
                            updated_at = ? WHERE id = ?""",
                        (now, run["response_message_id"]),
                    )
                    message = self._message_wire(
                        self._message_row(connection, run["response_message_id"])
                    )
                    self._validate_run_message_status(
                        changed["status"], message["status"]
                    )
                    if message["visible"]:
                        self._append_event(
                            connection,
                            run["room_id"],
                            "message.upsert",
                            message,
                            created_at=now,
                        )
                self._cancel_pending_interactions(
                    connection, run, now, order_by_created_at=True
                )
                self._fail_claimed_interaction_ledgers(
                    connection,
                    run_id=run["id"],
                    reason="Dashboard restarted",
                    runtime_session_ids=runtime_ids,
                    run=changed,
                )
                changed_ids.append(run["id"])
            return changed_ids

    def _cancel_pending_interactions(
        self,
        connection: sqlite3.Connection,
        run: sqlite3.Row,
        now: float,
        *,
        order_by_created_at: bool = False,
    ) -> list[dict[str, object]]:
        """Cancel a run's pending cards and publish their durable resolutions."""
        ordering = "created_at ASC, id ASC" if order_by_created_at else "rowid ASC"
        interactions = connection.execute(
            f"""SELECT id FROM group_interactions
            WHERE run_id = ? AND status = 'pending' ORDER BY {ordering}""",
            (run["id"],),
        ).fetchall()
        cancelled: list[dict[str, object]] = []
        for interaction in interactions:
            connection.execute(
                """UPDATE group_interactions
                SET status = 'cancelled', resolved_at = ? WHERE id = ?""",
                (now, interaction["id"]),
            )
            resolved = self._interaction_wire(
                self._interaction_row(connection, interaction["id"])
            )
            self._append_event(
                connection,
                run["room_id"],
                "interaction.resolved",
                resolved,
                created_at=now,
            )
            cancelled.append(resolved)
        return cancelled

    def _fail_claimed_interaction_ledgers(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        reason: str,
        runtime_session_ids: list[str],
        run: Mapping[str, object],
        interaction_id: str | None = None,
    ) -> None:
        interactions = connection.execute(
            """SELECT id, kind FROM group_interactions
            WHERE run_id = ? ORDER BY rowid ASC""",
            (run_id,),
        ).fetchall()
        if interaction_id is not None:
            interactions = [
                item for item in interactions if item["id"] == interaction_id
            ]
        if not interactions:
            return
        target_ids = {item["id"] for item in interactions}
        scoped_operations = [
            self._interaction_operation(item["kind"], item["id"])
            for item in interactions
        ]
        placeholders = ", ".join("?" for _ in scoped_operations)
        ledgers = connection.execute(
            f"""SELECT request_id, operation, response_json
            FROM group_idempotency WHERE operation IN ({placeholders})""",
            scoped_operations,
        ).fetchall()
        legacy = connection.execute(
            """SELECT request_id, operation, response_json
            FROM group_idempotency WHERE operation IN (
                'interaction.approval.response',
                'interaction.clarification.response'
            )"""
        ).fetchall()
        seen: set[str] = set()
        terminal = {
            "state": "failed",
            "reason": reason,
            "runtimeSessionIds": list(runtime_session_ids),
            "run": self._legacy_interaction_failure_run(run),
        }
        encoded = self._canonical_json(terminal)
        for ledger in (*ledgers, *legacy):
            if ledger["request_id"] in seen:
                continue
            seen.add(ledger["request_id"])
            operation = self._interaction_response_operation(ledger["operation"])
            state = self._idempotency_state(ledger["response_json"])
            if operation is None or state["state"] != "claimed":
                continue
            claimed_id = state["interactionId"]
            if claimed_id not in target_ids:
                continue
            if operation[0] != state["kind"] or (
                operation[1] is not None and operation[1] != claimed_id
            ):
                raise GroupStoreError("Stored interaction response is corrupt")
            connection.execute(
                """UPDATE group_idempotency SET response_json = ?
                WHERE request_id = ?""",
                (encoded, ledger["request_id"]),
            )

    def queued_run_count(self) -> int:
        with self.connection() as connection:
            return int(
                connection.execute(
                    "SELECT COUNT(*) FROM group_agent_runs WHERE status = 'queued'"
                ).fetchone()[0]
            )

    def list_pending_interactions(self, room_id: str) -> list[dict[str, object]]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        with self.read_transaction() as connection:
            self._room_detail(connection, canonical_room_id, include_archived=True)
            rows = connection.execute(
                "SELECT * FROM group_interactions WHERE room_id = ? AND status = 'pending' ORDER BY created_at, id",
                (canonical_room_id,),
            ).fetchall()
            return [self._interaction_wire(row) for row in rows]

    def list_queued_runs(self, room_id: str) -> list[dict[str, object]]:
        canonical_room_id = self._canonical_uuid(room_id, "roomId")
        with self.read_transaction() as connection:
            self._room_detail(connection, canonical_room_id, include_archived=True)
            rows = connection.execute(
                "SELECT * FROM group_agent_runs WHERE room_id = ? AND status = 'queued' ORDER BY created_at, id",
                (canonical_room_id,),
            ).fetchall()
            return [self._run_wire(row) for row in rows]

    def latest_cursor(self) -> int:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM group_events"
            ).fetchone()
            return int(row["cursor"])

    @staticmethod
    def _safe_context_seq(
        connection: sqlite3.Connection,
        room_id: str,
        topic_id: str,
        after_seq: int,
        trigger_seq: int,
    ) -> int:
        hole = connection.execute(
            """SELECT MIN(seq) AS seq FROM group_messages
            WHERE room_id = ? AND topic_id = ? AND seq > ? AND seq <= ?
              AND status NOT IN ('completed', 'failed', 'interrupted')""",
            (room_id, topic_id, after_seq, trigger_seq),
        ).fetchone()["seq"]
        if hole is None:
            return max(after_seq, trigger_seq)
        return max(after_seq, int(hole) - 1)

    def _append_agent_status(
        self,
        connection: sqlite3.Connection,
        room_id: str,
        agent_id: str,
        now: float,
    ) -> None:
        row = connection.execute(
            """SELECT id, status FROM group_agent_runs
            WHERE room_id = ? AND agent_id = ?
              AND status IN ('queued', 'running', 'awaiting_input')
            ORDER BY CASE status
                WHEN 'awaiting_input' THEN 3
                WHEN 'running' THEN 2
                ELSE 1 END DESC,
                created_at ASC, id ASC
            LIMIT 1""",
            (room_id, agent_id),
        ).fetchone()
        payload: dict[str, object] = {
            "roomId": room_id,
            "agentId": agent_id,
            "status": "idle" if row is None else row["status"],
            "runId": None if row is None else row["id"],
        }
        self._append_event(connection, room_id, "agent.status", payload, created_at=now)

    def _append_event(
        self,
        connection: sqlite3.Connection,
        room_id: str,
        event_type: str,
        payload: Mapping[str, object],
        *,
        created_at: float | None = None,
    ) -> int:
        epoch = self._metadata_value_from_connection(connection, "journal_epoch")
        event_time = self._now() if created_at is None else created_at
        cursor = connection.execute(
            """INSERT INTO group_events(epoch, room_id, event_type, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?) RETURNING cursor""",
            (
                epoch,
                room_id,
                event_type,
                self._canonical_json(payload),
                event_time,
            ),
        ).fetchone()["cursor"]
        if event_type == "message.upsert":
            topic_id = payload.get("topicId")
            if not isinstance(topic_id, str):
                raise GroupStoreError("Message event topic identity is missing")
            connection.execute(
                """UPDATE group_topics
                SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
                WHERE id = ? AND room_id = ?""",
                (event_time, event_time, topic_id, room_id),
            )
            topic = self._topic_summary_by_id(connection, room_id, topic_id)
            connection.execute(
                """INSERT INTO group_events
                (epoch, room_id, event_type, payload_json, created_at)
                VALUES (?, ?, 'topic.updated', ?, ?)""",
                (epoch, room_id, self._canonical_json(topic), event_time),
            )
        return int(cursor)

    def _append_room_updated_summary(
        self,
        connection: sqlite3.Connection,
        room_id: str,
        *,
        created_at: float,
    ) -> None:
        room = connection.execute(
            """SELECT id, name, cwd, max_reply_rounds, created_at, updated_at, archived,
            (SELECT COUNT(*) FROM group_agents WHERE room_id = group_rooms.id)
                AS agent_count,
            (SELECT COUNT(*) FROM group_topics WHERE room_id = group_rooms.id)
                AS topic_count
            FROM group_rooms WHERE id = ? AND archived = 0""",
            (room_id,),
        ).fetchone()
        if room is None:
            raise GroupNotFoundError("Room not found")
        self._append_event(
            connection,
            room_id,
            "room.updated",
            self._room_summary(room),
            created_at=created_at,
        )

    def _room_detail(
        self, connection: sqlite3.Connection, room_id: str, *, include_archived: bool
    ) -> dict[str, object]:
        room = connection.execute(
            "SELECT * FROM group_rooms WHERE id = ?", (room_id,)
        ).fetchone()
        if room is None or (room["archived"] and not include_archived):
            raise GroupNotFoundError("Room not found")
        agents = connection.execute(
            "SELECT * FROM group_agents WHERE room_id = ? ORDER BY created_at ASC, id ASC",
            (room_id,),
        ).fetchall()
        result = self._room_wire(room)
        result["agents"] = [self._agent_wire(agent) for agent in agents]
        return result

    def prepare_run_session_configuration(
        self, run_id: str, configuration: Mapping[str, object]
    ) -> bool:
        """Detach a stale stored session before this claimed run is bound.

        Configuration changes never interrupt the currently bound run. A later
        claimed run reaches this method only after agent serialization, so it
        can safely rotate the dormant stored session and rebuild full context.
        """
        canonical_run_id = self._canonical_uuid(run_id, "runId")
        normalized = {
            "model": configuration.get("model"),
            "provider": configuration.get("provider"),
            "reasoning_effort": configuration.get("reasoning_effort"),
            "fast": configuration.get("fast"),
        }
        serialized = self._canonical_json(normalized)
        with self.write_transaction() as connection:
            run = self._run_row(connection, canonical_run_id)
            if run["status"] != "running" or run["runtime_session_id"] is not None:
                raise GroupConflictError("Run does not accept configuration rotation")
            agent = self._owned_agent(connection, run["room_id"], run["agent_id"])
            if agent["session_config_json"] == serialized:
                return False
            now = self._now()
            connection.execute(
                """UPDATE group_agents
                SET stored_session_id = NULL,
                    last_context_message_seq = 0,
                    session_config_json = ?,
                    updated_at = ?
                WHERE id = ? AND room_id = ?""",
                (serialized, now, agent["id"], run["room_id"]),
            )
            connection.execute(
                """UPDATE group_agent_topic_state
                SET last_context_message_seq = 0, updated_at = ?
                WHERE agent_id = ?""",
                (now, agent["id"]),
            )
            refreshed = self._owned_agent(connection, run["room_id"], run["agent_id"])
            self._append_event(
                connection,
                run["room_id"],
                "agent.updated",
                self._agent_wire(refreshed),
                created_at=now,
            )
            return True

    @staticmethod
    def _compatibility_topic_id(room_id: str) -> str:
        return str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"hermes://yaoyao-group/{room_id}/compatibility-topic",
            )
        )

    @staticmethod
    def _topic_title(content: str) -> str:
        normalized = " ".join(content.split()).strip()
        return (normalized or "话题")[:_TOPIC_TITLE_LENGTH]

    @staticmethod
    def _topic_row(
        connection: sqlite3.Connection, room_id: str, topic_id: str
    ) -> sqlite3.Row:
        topic = connection.execute(
            "SELECT * FROM group_topics WHERE id = ? AND room_id = ?",
            (topic_id, room_id),
        ).fetchone()
        if topic is None:
            raise GroupNotFoundError("Topic not found in room")
        return topic

    @classmethod
    def _topic_summary_by_id(
        cls, connection: sqlite3.Connection, room_id: str, topic_id: str
    ) -> dict[str, object]:
        row = connection.execute(
            """SELECT topic.*,
            (SELECT COUNT(*) FROM group_messages AS counted
             WHERE counted.topic_id = topic.id AND counted.visible = 1)
                AS message_count,
            COALESCE((SELECT CASE WHEN TRIM(latest.content) != ''
                                  THEN latest.content ELSE latest.error END
             FROM group_messages AS latest
             WHERE latest.topic_id = topic.id AND latest.visible = 1
               AND (TRIM(latest.content) != '' OR TRIM(latest.error) != '')
             ORDER BY latest.seq DESC LIMIT 1), '') AS preview
            FROM group_topics AS topic
            WHERE topic.id = ? AND topic.room_id = ?""",
            (topic_id, room_id),
        ).fetchone()
        if row is None:
            raise GroupNotFoundError("Topic not found in room")
        return cls._topic_summary(row)

    def _ensure_topic(
        self,
        connection: sqlite3.Connection,
        room_id: str,
        topic_id: str,
        title_source: str,
        now: float,
    ) -> sqlite3.Row:
        existing = connection.execute(
            "SELECT * FROM group_topics WHERE id = ?", (topic_id,)
        ).fetchone()
        if existing is not None:
            if existing["room_id"] != room_id:
                raise GroupConflictError("Topic does not belong to room")
            return existing
        connection.execute(
            """INSERT INTO group_topics
            (id, room_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)""",
            (topic_id, room_id, self._topic_title(title_source), now, now),
        )
        connection.execute(
            """INSERT INTO group_agent_topic_state
            (agent_id, topic_id, last_context_message_seq, created_at, updated_at)
            SELECT id, ?, 0, ?, ? FROM group_agents WHERE room_id = ?""",
            (topic_id, now, now, room_id),
        )
        return self._topic_row(connection, room_id, topic_id)

    @staticmethod
    def _agent_topic_state(
        connection: sqlite3.Connection, agent_id: str, topic_id: str
    ) -> sqlite3.Row:
        state = connection.execute(
            """SELECT * FROM group_agent_topic_state
            WHERE agent_id = ? AND topic_id = ?""",
            (agent_id, topic_id),
        ).fetchone()
        if state is None:
            raise GroupStoreError("Agent topic context state is missing")
        return state

    def _active_room(self, connection: sqlite3.Connection, room_id: str) -> sqlite3.Row:
        room = connection.execute(
            "SELECT * FROM group_rooms WHERE id = ? AND archived = 0", (room_id,)
        ).fetchone()
        if room is None:
            raise GroupNotFoundError("Room not found")
        return room

    def _owned_agent(
        self, connection: sqlite3.Connection, room_id: str, agent_id: str
    ) -> sqlite3.Row:
        agent = connection.execute(
            "SELECT * FROM group_agents WHERE id = ? AND room_id = ?",
            (agent_id, room_id),
        ).fetchone()
        if agent is None:
            raise GroupNotFoundError("Agent not found in room")
        return agent

    @staticmethod
    def _room_host(
        connection: sqlite3.Connection, room_id: str
    ) -> sqlite3.Row:
        host = connection.execute(
            "SELECT * FROM group_agents WHERE room_id = ? AND is_host = 1",
            (room_id,),
        ).fetchone()
        if host is None:
            raise GroupStoreError("Room host is missing")
        return host

    @staticmethod
    def _first_enabled_host_candidate(
        connection: sqlite3.Connection,
        room_id: str,
        *,
        exclude_agent_id: str,
    ) -> sqlite3.Row | None:
        return connection.execute(
            """SELECT * FROM group_agents
            WHERE room_id = ? AND enabled = 1 AND id != ?
            ORDER BY created_at ASC, id ASC LIMIT 1""",
            (room_id, exclude_agent_id),
        ).fetchone()

    def _switch_host(
        self,
        connection: sqlite3.Connection,
        room_id: str,
        agent_id: str,
        *,
        now: float,
    ) -> tuple[dict[str, object], dict[str, object]] | None:
        current = self._room_host(connection, room_id)
        if current["id"] == agent_id:
            return None
        replacement = self._owned_agent(connection, room_id, agent_id)
        if not replacement["enabled"]:
            raise GroupConflictError("Host Agent must be enabled")
        connection.execute(
            """UPDATE group_agents SET is_host = 0, updated_at = ?
            WHERE id = ? AND room_id = ?""",
            (now, current["id"], room_id),
        )
        connection.execute(
            """UPDATE group_agents SET is_host = 1, updated_at = ?
            WHERE id = ? AND room_id = ?""",
            (now, replacement["id"], room_id),
        )
        return (
            self._agent_detail(connection, room_id, str(current["id"])),
            self._agent_detail(connection, room_id, str(replacement["id"])),
        )

    def _enabled_agent(
        self, connection: sqlite3.Connection, room_id: str, agent_id: str
    ) -> sqlite3.Row:
        agent = self._owned_agent(connection, room_id, agent_id)
        if not agent["enabled"]:
            raise GroupConflictError("Agent is disabled")
        return agent

    @staticmethod
    def _require_available_runtime(
        connection: sqlite3.Connection, runtime_session_id: str, run_id: str
    ) -> None:
        occupied = connection.execute(
            """SELECT id FROM group_agent_runs
            WHERE runtime_session_id = ?
              AND status IN ('running', 'awaiting_input')
              AND id != ? LIMIT 1""",
            (runtime_session_id, run_id),
        ).fetchone()
        if occupied is not None:
            raise GroupConflictError("Runtime session is already in use")

    def _agent_detail(
        self, connection: sqlite3.Connection, room_id: str, agent_id: str
    ) -> dict[str, object]:
        return self._agent_wire(self._owned_agent(connection, room_id, agent_id))

    @staticmethod
    def _message_row(connection: sqlite3.Connection, message_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM group_messages WHERE id = ?", (message_id,)
        ).fetchone()
        if row is None:
            raise GroupNotFoundError("Message not found")
        return row

    @staticmethod
    def _message_with_execution_row(
        connection: sqlite3.Connection, message_id: str
    ) -> sqlite3.Row:
        row = connection.execute(
            """SELECT message.*,
                run.requested_model AS execution_requested_model,
                run.requested_provider AS execution_requested_provider,
                run.requested_reasoning_effort AS execution_requested_reasoning_effort,
                run.requested_fast_mode AS execution_requested_fast_mode,
                run.actual_model AS execution_actual_model,
                run.actual_provider AS execution_actual_provider,
                run.actual_reasoning_effort AS execution_actual_reasoning_effort,
                run.actual_fast_mode AS execution_actual_fast_mode
            FROM group_messages AS message
            LEFT JOIN group_agent_runs AS run
              ON run.response_message_id = message.id
            WHERE message.id = ?""",
            (message_id,),
        ).fetchone()
        if row is None:
            raise GroupNotFoundError("Message not found")
        return row

    @staticmethod
    def _run_row(connection: sqlite3.Connection, run_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM group_agent_runs WHERE id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise GroupNotFoundError("Run not found")
        return row

    @staticmethod
    def _interaction_row(
        connection: sqlite3.Connection, interaction_id: str
    ) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM group_interactions WHERE id = ?", (interaction_id,)
        ).fetchone()
        if row is None:
            raise GroupNotFoundError("Interaction not found")
        return row

    @classmethod
    def _validate_run_message_state(
        cls, run: sqlite3.Row, message: sqlite3.Row
    ) -> None:
        if (
            run["room_id"] != message["room_id"]
            or run["topic_id"] != message["topic_id"]
        ):
            raise GroupStoreError("Run response message is corrupt")
        cls._validate_run_message_status(run["status"], message["status"])

    @staticmethod
    def _validate_run_message_status(run_status: str, message_status: str) -> None:
        if message_status not in _MESSAGE_STATUSES_BY_RUN.get(run_status, frozenset()):
            raise GroupConflictError("Run and response message states conflict")

    def _update_run(
        self,
        connection: sqlite3.Connection,
        run: sqlite3.Row,
        status: str,
        now: float,
        runtime_session_id: object,
        error: object,
    ) -> dict[str, object]:
        runtime = (
            run["runtime_session_id"]
            if runtime_session_id is UNSET
            else runtime_session_id
        )
        run_error = run["error"] if error is UNSET else error
        try:
            connection.execute(
                "UPDATE group_agent_runs SET status = ?, runtime_session_id = ?, error = ?, updated_at = ? WHERE id = ?",
                (status, runtime, run_error, now, run["id"]),
            )
        except sqlite3.IntegrityError as conflict:
            if "group_agent_runs.runtime_session_id" in str(conflict):
                raise GroupConflictError(
                    "Runtime session is already in use"
                ) from conflict
            raise
        return self._run_wire(self._run_row(connection, run["id"]))

    @staticmethod
    def _message_wire(row: sqlite3.Row) -> dict[str, object]:
        try:
            tool_state = GroupStore._load_json(row["tool_state_json"])
        except (
            TypeError,
            ValueError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise GroupStoreError("Stored message tool state is corrupt") from error
        if not isinstance(tool_state, list) or not all(
            isinstance(item, dict) for item in tool_state
        ):
            raise GroupStoreError("Stored message tool state is corrupt")
        result = {
            "seq": row["seq"],
            "id": row["id"],
            "roomId": row["room_id"],
            "topicId": row["topic_id"],
            "senderKind": row["sender_kind"],
            "senderId": row["sender_id"],
            "senderName": row["sender_name"],
            "rootMessageId": row["root_message_id"],
            "replyToMessageId": row["reply_to_message_id"],
            "clientMessageId": row["client_message_id"],
            "content": row["content"],
            "reasoning": row["reasoning"],
            "toolState": tool_state,
            "status": row["status"],
            "error": row["error"],
            "visible": bool(row["visible"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
        keys = set(row.keys())
        if "execution_actual_model" in keys:
            values = {
                "requestedModel": row["execution_requested_model"],
                "requestedProvider": row["execution_requested_provider"],
                "requestedReasoningEffort": row[
                    "execution_requested_reasoning_effort"
                ],
                "requestedFastMode": (
                    None
                    if row["execution_requested_fast_mode"] is None
                    else bool(row["execution_requested_fast_mode"])
                ),
                "actualModel": row["execution_actual_model"],
                "actualProvider": row["execution_actual_provider"],
                "actualReasoningEffort": row["execution_actual_reasoning_effort"],
                "actualFastMode": (
                    None
                    if row["execution_actual_fast_mode"] is None
                    else bool(row["execution_actual_fast_mode"])
                ),
            }
            if any(value is not None for value in values.values()):
                result["execution"] = values
        return result

    @classmethod
    def _projection_message(cls, row: sqlite3.Row) -> dict[str, object]:
        try:
            tool_state = cls._load_json(row["tool_state_json"])
        except (
            TypeError,
            ValueError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise GroupStoreError("Stored message tool state is corrupt") from error
        if not isinstance(tool_state, list) or not all(
            isinstance(item, dict) for item in tool_state
        ):
            raise GroupStoreError("Stored message tool state is corrupt")
        tool_names: list[str] = []
        tool_names_truncated = False
        for item in tool_state:
            name = None
            for key in ("name", "toolName"):
                candidate = item.get(key)
                if not isinstance(candidate, str) or not candidate:
                    continue
                if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", candidate) is None:
                    tool_names_truncated = True
                    continue
                name = candidate
                break
            if name is None or name in tool_names:
                continue
            if len(tool_names) >= 16:
                tool_names_truncated = True
                break
            tool_names.append(name)
        return {
            "seq": int(row["seq"]),
            "senderKind": row["sender_kind"],
            "senderId": row["sender_id"],
            "senderName": row["sender_name"],
            "content": row["content"],
            "reasoning": row["reasoning"],
            "toolNames": tool_names,
            "status": row["status"],
            "summary": row["error"],
            "truncated": tool_names_truncated,
        }

    @classmethod
    def _bound_projection_messages(
        cls,
        messages: list[dict[str, object]],
        *,
        omitted_count: int,
        omitted_through_seq: int | None,
    ) -> tuple[list[dict[str, object]], int, int | None, dict[str, object] | None]:
        while len(messages) > 1:
            omitted_summary = cls._projection_omitted_summary(
                omitted_count, omitted_through_seq
            )
            if (
                cls._projection_size(messages, omitted_summary)
                <= CONTEXT_CHARACTER_BUDGET
            ):
                break
            removed = messages.pop(0)
            omitted_count += 1
            omitted_through_seq = int(removed["seq"])
        omitted_summary = cls._projection_omitted_summary(
            omitted_count, omitted_through_seq
        )
        if (
            messages
            and cls._projection_size(messages, omitted_summary)
            > CONTEXT_CHARACTER_BUDGET
        ):
            cls._truncate_projection_message(messages[0], omitted_summary)
        if cls._projection_size(messages, omitted_summary) > CONTEXT_CHARACTER_BUDGET:
            raise GroupStoreError("Projection metadata exceeds the character budget")
        return messages, omitted_count, omitted_through_seq, omitted_summary

    @staticmethod
    def _projection_omitted_summary(
        count: int, through_seq: int | None
    ) -> dict[str, object] | None:
        if count == 0:
            return None
        if through_seq is None:
            raise GroupStoreError("Projection omission metadata is corrupt")
        return {
            "messageCount": count,
            "throughSeq": through_seq,
            "text": f"Omitted {count} earlier messages through seq {through_seq}.",
        }

    @classmethod
    def _projection_size(
        cls,
        messages: list[dict[str, object]],
        omitted_summary: dict[str, object] | None,
    ) -> int:
        return len(
            cls._canonical_json(
                {"messages": messages, "omittedSummary": omitted_summary}
            ).encode("utf-8")
        )

    @classmethod
    def _truncate_projection_message(
        cls,
        message: dict[str, object],
        omitted_summary: dict[str, object] | None,
    ) -> None:
        marker = "…[truncated]"
        originals = {
            field: message[field]
            for field in ("content", "reasoning", "summary")
            if isinstance(message[field], str) and message[field]
        }
        message["truncated"] = True
        for field in originals:
            message[field] = marker
        wrapper = [message]
        if cls._projection_size(wrapper, omitted_summary) > CONTEXT_CHARACTER_BUDGET:
            raise GroupStoreError("Projection identity exceeds the character budget")
        for field in ("content", "reasoning", "summary"):
            original = originals.get(field)
            if original is None:
                continue
            low = 0
            high = len(original)
            while low < high:
                candidate = (low + high + 1) // 2
                message[field] = (
                    original
                    if candidate == len(original)
                    else f"{original[:candidate]}{marker}"
                )
                if (
                    cls._projection_size(wrapper, omitted_summary)
                    <= CONTEXT_CHARACTER_BUDGET
                ):
                    low = candidate
                else:
                    high = candidate - 1
            message[field] = (
                original if low == len(original) else f"{original[:low]}{marker}"
            )

    @staticmethod
    def _run_wire(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "roomId": row["room_id"],
            "topicId": row["topic_id"],
            "agentId": row["agent_id"],
            "triggerMessageId": row["trigger_message_id"],
            "responseMessageId": row["response_message_id"],
            "rootMessageId": row["root_message_id"],
            "depth": row["depth"],
            "replyMode": row["reply_mode"],
            "status": row["status"],
            "runtimeSessionId": row["runtime_session_id"],
            "requestedModel": row["requested_model"],
            "requestedProvider": row["requested_provider"],
            "requestedReasoningEffort": row["requested_reasoning_effort"],
            "requestedFastMode": (
                None
                if row["requested_fast_mode"] is None
                else bool(row["requested_fast_mode"])
            ),
            "actualModel": row["actual_model"],
            "actualProvider": row["actual_provider"],
            "actualReasoningEffort": row["actual_reasoning_effort"],
            "actualFastMode": (
                None
                if row["actual_fast_mode"] is None
                else bool(row["actual_fast_mode"])
            ),
            "error": row["error"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _legacy_interaction_failure_run(
        run: Mapping[str, object],
    ) -> dict[str, object]:
        """Keep the pre-v4 strict HTTP replay shape for failed interactions."""
        result = dict(run)
        result.pop("topicId", None)
        for field in (
            "requestedModel",
            "requestedProvider",
            "requestedReasoningEffort",
            "requestedFastMode",
            "actualModel",
            "actualProvider",
            "actualReasoningEffort",
            "actualFastMode",
        ):
            result.pop(field, None)
        return result

    @staticmethod
    def _interaction_wire(row: sqlite3.Row) -> dict[str, object]:
        try:
            payload = GroupStore._load_json(row["payload_json"])
        except (
            TypeError,
            ValueError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise GroupStoreError("Stored interaction payload is corrupt") from error
        if not isinstance(payload, dict):
            raise GroupStoreError("Stored interaction payload is corrupt")
        return {
            "id": row["id"],
            "roomId": row["room_id"],
            "topicId": row["topic_id"],
            "agentId": row["agent_id"],
            "runId": row["run_id"],
            "kind": row["kind"],
            "payload": payload,
            "status": row["status"],
            "createdAt": row["created_at"],
            "resolvedAt": row["resolved_at"],
        }

    def _event_wire(self, row: sqlite3.Row, current_epoch: str) -> dict[str, object]:
        try:
            epoch = self._validated_epoch(row["epoch"])
            payload = self._load_json(row["payload_json"])
        except (
            TypeError,
            ValueError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise GroupStoreError("Stored event is corrupt") from error
        if epoch != current_epoch or not isinstance(payload, dict):
            raise GroupStoreError("Stored event is corrupt")
        return {
            "cursor": row["cursor"],
            "epoch": epoch,
            "roomId": row["room_id"],
            "eventType": row["event_type"],
            "payload": payload,
            "createdAt": row["created_at"],
        }

    @staticmethod
    def _message_text(
        value: object, field: str, *, max_bytes: int, nonblank: bool = False
    ) -> str:
        if not isinstance(value, str):
            raise ValueError(f"{field} must be a string")
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError(f"{field} must be valid UTF-8") from error
        if len(encoded) > max_bytes:
            raise ValueError(f"{field} exceeds maximum size")
        if nonblank and not value.strip():
            raise ValueError(f"{field} must not be blank")
        return value

    @classmethod
    def _mention_agent_ids(cls, value: object) -> list[str]:
        if not isinstance(value, list):
            raise ValueError("mentionAgentIds must be a list")
        result = [
            cls._canonical_uuid(agent_id, "mentionAgentIds") for agent_id in value
        ]
        if len(result) != len(set(result)):
            raise GroupConflictError("mentionAgentIds must be unique")
        return result

    @staticmethod
    def _interaction_id(value: object) -> str:
        return normalize_interaction_id(value)

    @staticmethod
    def _runtime_session_id(value: object) -> str | None:
        if value is None:
            return None
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 200
            or any(unicodedata.category(character) == "Cc" for character in value)
        ):
            raise ValueError("runtimeSessionId is invalid")
        return value

    @classmethod
    def _tool_state_json(cls, value: object) -> str:
        if not isinstance(value, list):
            raise ValueError("tool_state must be a list")
        if not all(isinstance(item, Mapping) for item in value):
            raise ValueError("tool_state entries must be objects")
        encoded = cls._strict_json(value, "tool_state")
        if len(encoded.encode("utf-8")) > MAX_TOOL_STATE_BYTES:
            raise ValueError("tool_state exceeds maximum size")
        return encoded

    @classmethod
    def _json_object(cls, value: object, field: str) -> str:
        if not isinstance(value, Mapping):
            raise ValueError(f"{field} must be an object")
        encoded = cls._strict_json(dict(value), field)
        if (
            field == "payload"
            and len(encoded.encode("utf-8")) > MAX_INTERACTION_PAYLOAD_BYTES
        ):
            raise ValueError("payload exceeds maximum size")
        return encoded

    @staticmethod
    def _strict_json(value: object, field: str) -> str:
        try:
            encoded = json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            encoded.encode("utf-8")
            return encoded
        except (TypeError, ValueError, UnicodeEncodeError) as error:
            raise ValueError(f"{field} must be JSON-serializable") from error

    @staticmethod
    def _load_json(value: object) -> object:
        if not isinstance(value, str):
            raise ValueError("JSON must be a string")
        return json.loads(
            value,
            parse_constant=lambda constant: (_ for _ in ()).throw(ValueError(constant)),
        )

    @staticmethod
    def _page_limit(value: object, maximum: int, field: str) -> int:
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 1 <= value <= maximum
        ):
            raise ValueError(f"{field} must be an integer from 1 to {maximum}")
        return value

    @staticmethod
    def _positive_int(value: object, field: str) -> int:
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f"{field} must be a positive integer")
        return value

    @staticmethod
    def _nonnegative_int(value: object, field: str) -> int:
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError(f"{field} must be a nonnegative integer")
        return value

    @staticmethod
    def _finite_timestamp(value: object, field: str) -> float:
        try:
            finite = (
                math.isfinite(value)
                if isinstance(value, (int, float)) and not isinstance(value, bool)
                else False
            )
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError(f"{field} must be finite")
        return float(value)

    def _new_agents(self, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list) or not 1 <= len(value) <= MAX_AGENTS_PER_ROOM:
            raise ValueError(f"agents must contain 1 to {MAX_AGENTS_PER_ROOM} members")
        agents = [self._new_agent(agent) for agent in value]
        profiles = [agent["profile"] for agent in agents]
        display_keys = [agent["display_name_key"] for agent in agents]
        if len(profiles) != len(set(profiles)):
            raise GroupConflictError("Agent profile must be unique within a room")
        if len(display_keys) != len(set(display_keys)):
            raise GroupConflictError("Agent display name must be unique within a room")
        host_count = sum(bool(agent["is_host"]) for agent in agents)
        if host_count > 1:
            raise GroupConflictError("Room may contain only one host Agent")
        if host_count == 0:
            agents[0]["is_host"] = True
        return agents

    def _new_agent(self, command: object) -> dict[str, object]:
        command = self._command(
            command,
            {
                "profile", "displayName", "description", "replyWithoutMention",
                "isHost",
                "model", "provider", "reasoningEffort", "fastMode",
            },
        )
        profile = self._profile(command.get("profile"))
        raw_name = command.get("displayName")
        explicit_name = (
            raw_name.strip()
            if isinstance(raw_name, str) and raw_name.strip()
            else ""
        )
        display_name, display_name_key = normalize_display_name(
            explicit_name or self._resolved_agent_name(profile) or profile
        )
        reply_without_mention = command.get("replyWithoutMention", False)
        if not isinstance(reply_without_mention, bool):
            raise ValueError("replyWithoutMention must be a boolean")
        is_host = command.get("isHost", False)
        if not isinstance(is_host, bool):
            raise ValueError("isHost must be a boolean")
        fast_mode = command.get("fastMode")
        if fast_mode is not None and not isinstance(fast_mode, bool):
            raise ValueError("fastMode must be a boolean or null")
        if (command.get("model") is None) != (command.get("provider") is None):
            raise ValueError("model and provider must both be set or both be null")
        return {
            "profile": profile,
            "display_name": display_name,
            "display_name_key": display_name_key,
            "description": self._description(command.get("description", "")),
            "reply_without_mention": reply_without_mention,
            "is_host": is_host,
            "model_override": self._agent_configuration_value(
                command.get("model"), "model"
            ),
            "provider_override": self._agent_configuration_value(
                command.get("provider"), "provider"
            ),
            "reasoning_effort_override": self._agent_configuration_value(
                command.get("reasoningEffort"), "reasoningEffort"
            ),
            "fast_mode_override": fast_mode,
        }

    @staticmethod
    def _agent_configuration_value(value: object, field: str) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field} must be a non-empty string or null")
        normalized = value.strip()
        if field == "reasoningEffort" and normalized not in {
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"
        }:
            raise ValueError("reasoningEffort is invalid")
        return normalized

    def _resolved_agent_name(self, profile: str) -> str:
        try:
            value = self._agent_name_resolver(profile)
        except Exception as error:
            raise GroupStoreError("Agent name settings could not be read") from error
        if not isinstance(value, str):
            raise GroupStoreError("Agent name settings are invalid")
        normalized = value.strip()
        return "" if is_reserved_mention_alias(normalized) else normalized

    def _insert_agent(
        self,
        connection: sqlite3.Connection,
        room_id: str,
        agent: Mapping[str, object],
        now: float,
    ) -> str:
        self._check_agent_conflicts(
            connection, room_id, agent["display_name_key"], profile=agent["profile"]
        )
        agent_id = str(uuid.uuid4())
        connection.execute(
            """INSERT INTO group_agents
            (id, room_id, profile, display_name, display_name_key, description,
             reply_without_mention, is_host, model_override, provider_override,
             reasoning_effort_override, fast_mode_override, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                agent_id,
                room_id,
                agent["profile"],
                agent["display_name"],
                agent["display_name_key"],
                agent["description"],
                int(bool(agent["reply_without_mention"])),
                int(bool(agent["is_host"])),
                agent["model_override"],
                agent["provider_override"],
                agent["reasoning_effort_override"],
                None if agent["fast_mode_override"] is None
                else int(bool(agent["fast_mode_override"])),
                now,
                now,
            ),
        )
        connection.execute(
            """INSERT INTO group_agent_topic_state
            (agent_id, topic_id, last_context_message_seq, created_at, updated_at)
            SELECT ?, id, 0, ?, ? FROM group_topics WHERE room_id = ?""",
            (agent_id, now, now, room_id),
        )
        return agent_id

    @staticmethod
    def _check_agent_conflicts(
        connection: sqlite3.Connection,
        room_id: str,
        display_name_key: str,
        *,
        profile: str | None = None,
        exclude_agent_id: str | None = None,
    ) -> None:
        exclusion = " AND id != ?" if exclude_agent_id is not None else ""
        suffix: tuple[object, ...] = (
            (exclude_agent_id,) if exclude_agent_id is not None else ()
        )
        if (
            profile is not None
            and connection.execute(
                f"SELECT 1 FROM group_agents WHERE room_id = ? AND profile = ?{exclusion}",
                (room_id, profile, *suffix),
            ).fetchone()
            is not None
        ):
            raise GroupConflictError("Agent profile must be unique within a room")
        if (
            connection.execute(
                f"SELECT 1 FROM group_agents WHERE room_id = ? AND display_name_key = ?{exclusion}",
                (room_id, display_name_key, *suffix),
            ).fetchone()
            is not None
        ):
            raise GroupConflictError("Agent display name must be unique within a room")

    @staticmethod
    def _room_wire(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "name": row["name"],
            "cwd": row["cwd"],
            "maxReplyRounds": row["max_reply_rounds"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "archived": bool(row["archived"]),
        }

    @staticmethod
    def _room_summary(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "name": row["name"],
            "cwd": row["cwd"],
            "maxReplyRounds": row["max_reply_rounds"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "archived": False,
            "agentCount": row["agent_count"],
            "topicCount": row["topic_count"],
        }

    @staticmethod
    def _topic_summary(row: sqlite3.Row) -> dict[str, object]:
        preview = str(row["preview"] or "")
        return {
            "id": row["id"],
            "roomId": row["room_id"],
            "title": row["title"],
            "preview": preview[:_TOPIC_PREVIEW_LENGTH],
            "messageCount": int(row["message_count"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _agent_wire(row: sqlite3.Row) -> dict[str, object]:
        return {
            "id": row["id"],
            "roomId": row["room_id"],
            "profile": row["profile"],
            "displayName": row["display_name"],
            "description": row["description"],
            "storedSessionId": row["stored_session_id"],
            "lastContextMessageSeq": row["last_context_message_seq"],
            "enabled": bool(row["enabled"]),
            "replyWithoutMention": bool(row["reply_without_mention"]),
            "isHost": bool(row["is_host"]),
            "model": row["model_override"],
            "provider": row["provider_override"],
            "reasoningEffort": row["reasoning_effort_override"],
            "fastMode": None if row["fast_mode_override"] is None
            else bool(row["fast_mode_override"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _canonical_uuid(value: object, field: str) -> str:
        if not isinstance(value, str):
            raise ValueError(f"{field} must be a canonical UUID")
        try:
            canonical = str(uuid.UUID(value))
        except ValueError as error:
            raise ValueError(f"{field} must be a canonical UUID") from error
        if value != canonical:
            raise ValueError(f"{field} must be a canonical UUID")
        return canonical

    @staticmethod
    def _canonical_json(value: object) -> str:
        try:
            encoded = json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            encoded.encode("utf-8")
            return encoded
        except (TypeError, ValueError, UnicodeEncodeError) as error:
            raise ValueError("value must be strict JSON") from error

    @classmethod
    def _interaction_response_operation(
        cls, value: object
    ) -> tuple[str, str | None] | None:
        if not isinstance(value, str):
            return None
        base, separator, interaction_id = value.partition(":")
        operations = {
            "interaction.approval.response": "approval",
            "interaction.clarification.response": "clarification",
        }
        kind = operations.get(base)
        if kind is None:
            return None
        if not separator:
            return kind, None
        try:
            canonical_interaction_id = cls._interaction_id(interaction_id)
        except ValueError:
            return None
        if canonical_interaction_id != interaction_id:
            return None
        return kind, canonical_interaction_id

    @classmethod
    def _interaction_operation(cls, kind: str, interaction_id: str) -> str:
        if kind not in _INTERACTION_KINDS:
            raise GroupStoreError("Stored interaction kind is corrupt")
        canonical_interaction_id = cls._interaction_id(interaction_id)
        if canonical_interaction_id != interaction_id:
            raise GroupStoreError("Stored interaction identity is corrupt")
        return f"interaction.{kind}.response:{canonical_interaction_id}"

    @classmethod
    def _idempotency_state(cls, value: object) -> dict[str, object]:
        try:
            state = cls._load_json(value)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise GroupStoreError("Stored interaction response is corrupt") from error
        if not isinstance(state, dict) or cls._canonical_json(state) != value:
            raise GroupStoreError("Stored interaction response is corrupt")
        status = state.get("state")
        if status == "claimed":
            if (
                not isinstance(state.get("interactionId"), str)
                or state.get("kind") not in _INTERACTION_KINDS
            ):
                raise GroupStoreError("Stored interaction response is corrupt")
        elif status == "completed":
            if not isinstance(state.get("response"), dict):
                raise GroupStoreError("Stored interaction response is corrupt")
            interaction_status = state.get("interactionStatus", "resolved")
            if interaction_status not in _INTERACTION_TERMINAL_STATUSES:
                raise GroupStoreError("Stored interaction response is corrupt")
        elif status == "failed":
            runtime_ids = state.get("runtimeSessionIds")
            if (
                not isinstance(state.get("reason"), str)
                or not isinstance(runtime_ids, list)
                or not all(isinstance(item, str) for item in runtime_ids)
                or len(runtime_ids) != len(set(runtime_ids))
                or not isinstance(state.get("run"), dict)
            ):
                raise GroupStoreError("Stored interaction response is corrupt")
        else:
            raise GroupStoreError("Stored interaction response is corrupt")
        return state

    @staticmethod
    def _runtime_envelope(response: dict[str, object]) -> dict[str, object]:
        if "result" not in response and "runtimeSessionIds" not in response:
            return {"result": response, "runtimeSessionIds": []}
        result = response.get("result")
        runtime_ids = response.get("runtimeSessionIds")
        if not isinstance(result, dict) or not isinstance(runtime_ids, list):
            raise GroupStoreError("Stored lifecycle response is corrupt")
        if not all(isinstance(value, str) for value in runtime_ids):
            raise GroupStoreError("Stored lifecycle response is corrupt")
        if len(runtime_ids) != len(set(runtime_ids)):
            raise GroupStoreError("Stored lifecycle response is corrupt")
        return {"result": result, "runtimeSessionIds": runtime_ids}

    @staticmethod
    def _scoped_payload(
        command: Mapping[str, object], room_id: str, agent_id: str | None = None
    ) -> dict[str, object]:
        payload: dict[str, object] = {"body": dict(command), "roomId": room_id}
        if agent_id is not None:
            payload["agentId"] = agent_id
        return payload

    @staticmethod
    def _integrity_conflict(error: sqlite3.IntegrityError) -> GroupStoreError:
        message = str(error)
        if "group_agents.room_id, group_agents.profile" in message:
            return GroupConflictError("Agent profile must be unique within a room")
        if "group_agents.room_id, group_agents.display_name_key" in message:
            return GroupConflictError("Agent display name must be unique within a room")
        if "group_messages.client_message_id" in message:
            return GroupConflictError("clientMessageId already exists")
        if "group_agent_runs.runtime_session_id" in message:
            return GroupConflictError("Runtime session is already in use")
        return GroupStoreError("Group storage constraint failed")

    @staticmethod
    def _command(value: object, allowed: set[str]) -> dict[str, object]:
        if not isinstance(value, Mapping) or not all(
            isinstance(key, str) for key in value
        ):
            raise ValueError("command must be an object")
        unexpected = set(value) - allowed
        if unexpected:
            raise ValueError(
                f"Unexpected command fields: {', '.join(sorted(unexpected))}"
            )
        return dict(value)

    def _command_request_id(self, command: Mapping[str, object]) -> str:
        if "requestId" not in command:
            raise ValueError("requestId is required")
        return self._canonical_uuid(command["requestId"], "requestId")

    @staticmethod
    def _string(command: Mapping[str, object], key: str) -> str:
        value = command.get(key)
        if not isinstance(value, str):
            raise ValueError(f"{key} must be a string")
        return value

    @staticmethod
    def _profile(value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("profile must be a string")
        profile = value.strip()
        if not 1 <= len(profile) <= 100:
            raise ValueError("profile must contain 1 to 100 characters")
        return profile

    @staticmethod
    def _description(value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("description must be a string")
        description = value.strip()
        if len(description) > 500:
            raise ValueError("description must contain at most 500 characters")
        return description

    @staticmethod
    def _now() -> float:
        return time.time()

    @staticmethod
    def _encode_cursor(updated_at: float, room_id: str) -> str:
        raw = json.dumps([updated_at, room_id], separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @classmethod
    def _decode_cursor(cls, cursor: str) -> tuple[float, str]:
        if (
            not isinstance(cursor, str)
            or not cursor
            or not re.fullmatch(r"[A-Za-z0-9_-]+", cursor)
        ):
            raise ValueError("cursor is malformed")
        try:
            raw = base64.b64decode(
                cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True
            )
            decoded = json.loads(raw.decode("utf-8"))
            if (
                not isinstance(decoded, list)
                or len(decoded) != 2
                or isinstance(decoded[0], bool)
                or not isinstance(decoded[0], (int, float))
                or not math.isfinite(decoded[0])
            ):
                raise ValueError
            updated_at = float(decoded[0])
            room_id = cls._canonical_uuid(decoded[1], "cursor room id")
            if cursor != cls._encode_cursor(updated_at, room_id):
                raise ValueError
            return updated_at, room_id
        except (
            ValueError,
            TypeError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            binascii.Error,
            OverflowError,
        ) as error:
            raise ValueError("cursor is malformed") from error

    @staticmethod
    def _encode_topic_cursor(
        room_id: str, updated_at: float, topic_id: str
    ) -> str:
        raw = json.dumps(
            ["topic", room_id, updated_at, topic_id], separators=(",", ":")
        ).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @classmethod
    def _decode_topic_cursor(
        cls, cursor: str, expected_room_id: str
    ) -> tuple[float, str]:
        if (
            not isinstance(cursor, str)
            or not cursor
            or not re.fullmatch(r"[A-Za-z0-9_-]+", cursor)
        ):
            raise ValueError("cursor is malformed")
        try:
            raw = base64.b64decode(
                cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True
            )
            decoded = json.loads(raw.decode("utf-8"))
            if (
                not isinstance(decoded, list)
                or len(decoded) != 4
                or decoded[0] != "topic"
                or isinstance(decoded[2], bool)
                or not isinstance(decoded[2], (int, float))
                or not math.isfinite(decoded[2])
            ):
                raise ValueError
            room_id = cls._canonical_uuid(decoded[1], "cursor room id")
            updated_at = float(decoded[2])
            topic_id = cls._canonical_uuid(decoded[3], "cursor topic id")
            if cursor != cls._encode_topic_cursor(room_id, updated_at, topic_id):
                raise ValueError
        except (
            ValueError,
            TypeError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            binascii.Error,
            OverflowError,
        ) as error:
            raise ValueError("cursor is malformed") from error
        if room_id != expected_room_id:
            raise ValueError("cursor does not belong to room")
        return updated_at, topic_id
