"""Encrypted registry for Hermes nodes delegated by the iOS pairing flow."""

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Mapping
from urllib.parse import urlsplit, urlunsplit
import uuid

try:
    from .data_paths import ensure_durable_data_root
except ImportError:  # Loaded by the Dashboard plugin loader as a top-level module.
    from data_paths import ensure_durable_data_root


class NodeRegistryError(RuntimeError):
    pass


class NodeNotFoundError(NodeRegistryError):
    pass


class PairedNodeRegistry:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.path = self.root / "paired-group-nodes.json"
        self.key_path = self.root / "paired-group-nodes.key"
        self._lock = threading.RLock()
        self._fernet = self._load_fernet()

    @classmethod
    def from_environment(cls) -> "PairedNodeRegistry":
        hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
        return cls(ensure_durable_data_root(hermes_home).data_root)

    def register(self, command: Mapping[str, object]) -> dict[str, object]:
        allowed = {
            "nodeId", "name", "serverUrl", "fingerprint", "accessToken",
            "profiles",
        }
        if not {"nodeId", "name", "serverUrl", "fingerprint", "accessToken"} <= set(command) or not set(command) <= allowed:
            raise ValueError("Node registration fields are invalid")
        node_id = self._node_id(command.get("nodeId"))
        name = self._text(command.get("name"), "name", 100)
        server_url = self._server_url(command.get("serverUrl"))
        fingerprint = self._text(
            command.get("fingerprint"), "fingerprint", 256
        )
        token = self._text(command.get("accessToken"), "accessToken", 4096)
        profiles = self._profiles(command.get("profiles", []))
        now = time.time()
        with self._lock:
            state = self._load()
            existing = next(
                (item for item in state if item.get("nodeId") == node_id), None
            )
            created_at = (
                float(existing.get("createdAt", now))
                if isinstance(existing, dict)
                else now
            )
            record = {
                "nodeId": node_id,
                "name": name,
                "serverUrl": server_url,
                "fingerprint": fingerprint,
                "accessToken": self._fernet.encrypt(token.encode()).decode(),
                "profiles": profiles,
                "createdAt": created_at,
                "updatedAt": now,
            }
            state = [item for item in state if item.get("nodeId") != node_id]
            state.append(record)
            self._save(state)
            return self._public(record)

    def list(self) -> list[dict[str, object]]:
        with self._lock:
            return sorted(
                (self._public(record) for record in self._load()),
                key=lambda item: (-float(item["updatedAt"]), str(item["nodeId"])),
            )

    def get(self, node_id: str) -> dict[str, object]:
        canonical = self._node_id(node_id)
        with self._lock:
            record = next(
                (
                    item for item in self._load()
                    if item.get("nodeId") == canonical
                ),
                None,
            )
            if record is None:
                raise NodeNotFoundError("Paired Hermes node was not found")
            token = record.get("accessToken")
            if not isinstance(token, str):
                raise NodeRegistryError("Paired Hermes node credential is corrupt")
            try:
                access_token = self._fernet.decrypt(token.encode()).decode()
            except Exception as error:
                raise NodeRegistryError(
                    "Paired Hermes node credential is unavailable"
                ) from error
            return {**self._public(record), "accessToken": access_token}

    def revoke(self, node_id: str) -> bool:
        canonical = self._node_id(node_id)
        with self._lock:
            state = self._load()
            retained = [
                item for item in state if item.get("nodeId") != canonical
            ]
            if len(retained) == len(state):
                return False
            self._save(retained)
            return True

    def _load_fernet(self):
        try:
            from cryptography.fernet import Fernet
        except ImportError as error:
            raise NodeRegistryError(
                "Hermes runtime does not provide encrypted node storage"
            ) from error
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            key = self.key_path.read_bytes()
        except FileNotFoundError:
            key = Fernet.generate_key()
            try:
                descriptor = os.open(
                    self.key_path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(key)
            except FileExistsError:
                key = self.key_path.read_bytes()
        return Fernet(key)

    def _load(self) -> list[dict[str, object]]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError, UnicodeDecodeError) as error:
            raise NodeRegistryError("Paired Hermes node registry is corrupt") from error
        if not isinstance(value, dict) or value.get("version") != 1:
            raise NodeRegistryError("Paired Hermes node registry is corrupt")
        nodes = value.get("nodes")
        if not isinstance(nodes, list) or not all(
            isinstance(item, dict) for item in nodes
        ):
            raise NodeRegistryError("Paired Hermes node registry is corrupt")
        return nodes

    def _save(self, nodes: list[dict[str, object]]) -> None:
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(
            prefix="paired-group-nodes.", suffix=".tmp", dir=self.root
        )
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(
                    {"version": 1, "nodes": nodes},
                    stream,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    @staticmethod
    def _node_id(value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("nodeId must be a canonical UUID")
        try:
            canonical = str(uuid.UUID(value))
        except ValueError as error:
            raise ValueError("nodeId must be a canonical UUID") from error
        if canonical != value:
            raise ValueError("nodeId must be a canonical UUID")
        return canonical

    @staticmethod
    def _text(value: object, field: str, maximum: int) -> str:
        if not isinstance(value, str):
            raise ValueError(f"{field} must be a string")
        normalized = value.strip()
        if not normalized or len(normalized) > maximum:
            raise ValueError(f"{field} is invalid")
        return normalized

    @staticmethod
    def _server_url(value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("serverUrl must be a string")
        parsed = urlsplit(value.strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("serverUrl must be an HTTP or HTTPS node URL")
        path = parsed.path.rstrip("/")
        if not path.startswith("/node/"):
            raise ValueError("serverUrl must identify a paired node path")
        return urlunsplit((parsed.scheme, parsed.netloc.lower(), path, "", ""))

    @staticmethod
    def _public(record: Mapping[str, object]) -> dict[str, object]:
        return {
            "nodeId": record["nodeId"],
            "name": record["name"],
            "serverUrl": record["serverUrl"],
            "fingerprint": record["fingerprint"],
            "createdAt": record["createdAt"],
            "updatedAt": record["updatedAt"],
            "profiles": record.get("profiles", []),
        }

    @classmethod
    def _profiles(cls, value: object) -> list[dict[str, str]]:
        if not isinstance(value, list) or len(value) > 100:
            raise ValueError("profiles must be a list of at most 100 items")
        result: list[dict[str, str]] = []
        seen: set[str] = set()
        for raw in value:
            if not isinstance(raw, Mapping):
                raise ValueError("profiles entries must be objects")
            name = cls._text(raw.get("name"), "profiles.name", 100)
            if name in seen:
                raise ValueError("profiles names must be unique")
            seen.add(name)
            display_name = raw.get("displayName", "")
            model = raw.get("model", "")
            if not isinstance(display_name, str) or len(display_name) > 100:
                raise ValueError("profiles.displayName is invalid")
            if not isinstance(model, str) or len(model) > 4096:
                raise ValueError("profiles.model is invalid")
            result.append({
                "name": name,
                "displayName": display_name.strip(),
                "model": model.strip(),
            })
        return result


__all__ = [
    "NodeNotFoundError",
    "NodeRegistryError",
    "PairedNodeRegistry",
]
