"""Route native group sessions to local or paired remote Hermes nodes."""

from __future__ import annotations

import json
import base64
import mimetypes
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode
from urllib.request import build_opener, ProxyHandler, Request
import uuid

from .group_gateway import GroupGatewayAdapter, SessionIdentity
from .group_node_registry import PairedNodeRegistry


EventCallback = Callable[[str, str, dict[str, object]], None]
_ATTACHMENT_PATTERN = re.compile(r"(!?\[[^\]]*\]\(<([^>]+)>\))")


class RemoteGatewayError(RuntimeError):
    pass


class _DrainFacade:
    def drain(self, timeout: float | None = None) -> bool:
        _ = timeout
        return True


class RemoteNodeGatewayAdapter:
    """Blocking Gateway-compatible client over the paired Web node proxy."""

    def __init__(
        self,
        node: Mapping[str, object],
        on_event: EventCallback,
        *,
        poll_interval: float = 0.2,
        attachment_root: Path | None = None,
    ) -> None:
        server_url = node.get("serverUrl")
        access_token = node.get("accessToken")
        if not isinstance(server_url, str) or not isinstance(access_token, str):
            raise RemoteGatewayError("Paired node route is invalid")
        self.server_url = server_url.rstrip("/")
        self.access_token = access_token
        self._on_event = on_event
        self._poll_interval = poll_interval
        self._cursor = 0
        self._condition = threading.Condition(threading.RLock())
        self._active_runtimes: set[str] = set()
        self._clarification_ids: set[str] = set()
        self._closed = False
        self._opener = build_opener(ProxyHandler({}))
        hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
        self._attachment_root = (
            attachment_root
            or hermes_home / "plugins" / "yaoyao" / "data" / "group-uploads"
        ).resolve()
        self.transport = _DrainFacade()
        self._poller = threading.Thread(
            target=self._poll_events,
            name="yaoyao-remote-node-events",
            daemon=True,
        )
        self._poller.start()

    def create_session(
        self,
        profile: str,
        title: str,
        cwd: str,
        seed_messages: list[dict[str, Any]],
        configuration: dict[str, Any] | None = None,
    ) -> SessionIdentity:
        if seed_messages:
            raise RemoteGatewayError("Remote node seed messages are unsupported")
        body: dict[str, object] = {
            "profile": profile,
            "title": title,
            "cwd": cwd,
        }
        configuration = configuration or {}
        for source, target in (
            ("model", "model"),
            ("provider", "provider"),
            ("reasoning_effort", "reasoningEffort"),
            ("fast", "fastMode"),
        ):
            if configuration.get(source) is not None:
                body[target] = configuration[source]
        return self._open(body)

    def resume_session(self, profile: str, stored_id: str) -> SessionIdentity:
        return self._open(
            {
                "profile": profile,
                "title": "恢复跨节点群聊",
                "cwd": "",
                "storedSessionId": stored_id,
            }
        )

    def submit_prompt(self, runtime_id: str, text: str) -> None:
        text = self._mirror_attachments(runtime_id, text)
        self._request(
            "POST",
            f"/sessions/{quote(runtime_id, safe='')}/prompt",
            {"text": text},
        )

    def _mirror_attachments(self, runtime_id: str, text: str) -> str:
        mirrored: dict[str, str] = {}

        def replace(match: re.Match[str]) -> str:
            raw_path = unquote(match.group(2))
            candidate = Path(raw_path)
            if not candidate.is_absolute():
                return match.group(1)
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(self._attachment_root)
            except (OSError, RuntimeError, ValueError):
                return match.group(1)
            if not resolved.is_file():
                return match.group(1)
            key = str(resolved)
            if key not in mirrored:
                if resolved.stat().st_size > 25 * 1024 * 1024:
                    raise RemoteGatewayError("Group attachment exceeds 25 MiB")
                self._upload_attachment(runtime_id, resolved)
                mirrored[key] = resolved.name
            return match.group(1).replace(
                f"<{match.group(2)}>",
                f"<attachment://{quote(mirrored[key])}>",
            )

        return _ATTACHMENT_PATTERN.sub(replace, text)

    def _upload_attachment(self, runtime_id: str, path: Path) -> None:
        content = path.read_bytes()
        encoded_name = base64.urlsafe_b64encode(
            path.name.encode("utf-8")
        ).decode("ascii").rstrip("=")
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        request = Request(
            self.server_url
            + "/api/plugins/yaoyao/v1/node-worker/sessions/"
            + quote(runtime_id, safe="")
            + "/attachments",
            data=content,
            method="POST",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.access_token}",
                "Content-Type": "application/octet-stream",
                "X-File-Name-B64": encoded_name,
                "X-Mime-Type": mime_type,
            },
        )
        try:
            with self._opener.open(request, timeout=120) as response:
                raw = response.read(1024 * 1024 + 1)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise RemoteGatewayError("Remote attachment transfer failed") from error
        if len(raw) > 1024 * 1024:
            raise RemoteGatewayError("Remote attachment response is too large")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as error:
            raise RemoteGatewayError("Remote attachment response is invalid") from error
        if not isinstance(result, dict):
            raise RemoteGatewayError("Remote attachment response is invalid")

    def interrupt(self, runtime_id: str) -> None:
        self._request(
            "POST", f"/sessions/{quote(runtime_id, safe='')}/interrupt", {}
        )

    def close(self, runtime_id: str) -> bool:
        response = self._request(
            "DELETE", f"/sessions/{quote(runtime_id, safe='')}", None
        )
        with self._condition:
            self._active_runtimes.discard(runtime_id)
        return response.get("closed") is True

    def respond_approval(self, runtime_id: str, choice: str) -> int:
        response = self._request(
            "POST",
            f"/sessions/{quote(runtime_id, safe='')}/approval",
            {"choice": choice},
        )
        value = response.get("resolved")
        if isinstance(value, bool) or not isinstance(value, int):
            raise RemoteGatewayError("Remote approval response is invalid")
        return value

    def respond_clarification(self, request_id: str, answer: str) -> str:
        response = self._request(
            "POST",
            "/clarification",
            {"requestId": request_id, "answer": answer},
        )
        status = response.get("status")
        if status not in {"ok", "expired"}:
            raise RemoteGatewayError("Remote clarification response is invalid")
        with self._condition:
            self._clarification_ids.discard(request_id)
        return str(status)

    def owns_clarification(self, request_id: str) -> bool:
        with self._condition:
            return request_id in self._clarification_ids

    def shutdown(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._closed = True
            self._condition.notify_all()
        if threading.current_thread() is not self._poller:
            self._poller.join(timeout=5)

    def _open(self, body: dict[str, object]) -> SessionIdentity:
        response = self._request("POST", "/sessions", body)
        stored = response.get("storedSessionId")
        runtime = response.get("runtimeSessionId")
        running = response.get("running", False)
        if (
            not isinstance(stored, str)
            or not stored
            or not isinstance(runtime, str)
            or not runtime
            or not isinstance(running, bool)
        ):
            raise RemoteGatewayError("Remote session identity is invalid")
        with self._condition:
            self._active_runtimes.add(runtime)
            self._condition.notify_all()
        return SessionIdentity(stored, runtime, running)

    def _poll_events(self) -> None:
        failures = 0
        while True:
            with self._condition:
                while not self._active_runtimes and not self._closed:
                    self._condition.wait()
                if self._closed:
                    return
            try:
                response = self._request(
                    "GET",
                    "/events?" + urlencode({"after": self._cursor, "limit": 256}),
                    None,
                )
                latest = response.get("latestCursor")
                items = response.get("items")
                if isinstance(latest, bool) or not isinstance(latest, int):
                    raise RemoteGatewayError("Remote event cursor is invalid")
                if not isinstance(items, list):
                    raise RemoteGatewayError("Remote event page is invalid")
                if response.get("reset") is True:
                    raise RemoteGatewayError("Remote event history was truncated")
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    cursor = item.get("cursor")
                    runtime_id = item.get("runtimeSessionId")
                    event_type = item.get("type")
                    payload = item.get("payload")
                    if (
                        isinstance(cursor, int)
                        and not isinstance(cursor, bool)
                        and isinstance(runtime_id, str)
                        and isinstance(event_type, str)
                        and isinstance(payload, dict)
                    ):
                        if event_type == "clarify.request":
                            request_id = payload.get("request_id") or payload.get(
                                "requestId"
                            )
                            if isinstance(request_id, str):
                                with self._condition:
                                    self._clarification_ids.add(request_id)
                        self._on_event(runtime_id, event_type, payload)
                        self._cursor = max(self._cursor, cursor)
                self._cursor = max(self._cursor, latest)
                failures = 0
                time.sleep(self._poll_interval)
            except Exception:
                failures += 1
                time.sleep(min(5.0, self._poll_interval * (2 ** min(failures, 5))))

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, object] | None,
    ) -> dict[str, object]:
        if self._closed:
            raise RemoteGatewayError("Remote node adapter is closed")
        encoded = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            self.server_url
            + "/api/plugins/yaoyao/v1/node-worker"
            + path,
            data=encoded,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.access_token}",
                **({"Content-Type": "application/json"} if encoded is not None else {}),
            },
        )
        try:
            with self._opener.open(request, timeout=35) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise RemoteGatewayError("Remote Hermes node request failed") from error
        if len(raw) > 4 * 1024 * 1024:
            raise RemoteGatewayError("Remote Hermes node response is too large")
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as error:
            raise RemoteGatewayError("Remote Hermes node response is invalid") from error
        if not isinstance(value, dict):
            raise RemoteGatewayError("Remote Hermes node response is invalid")
        return value


class GroupGatewayRouter:
    """One process-local Gateway plus lazily connected remote node adapters."""

    def __init__(
        self,
        on_event: EventCallback,
        *,
        registry: PairedNodeRegistry | None = None,
        local: GroupGatewayAdapter | None = None,
        remote_factory: Callable[
            [Mapping[str, object], EventCallback], RemoteNodeGatewayAdapter
        ] | None = None,
    ) -> None:
        self._on_event = on_event
        self._registry = registry
        self._local = local or GroupGatewayAdapter(on_event=on_event)
        self._remote_factory = remote_factory or (
            lambda node, callback: RemoteNodeGatewayAdapter(node, callback)
        )
        self._lock = threading.RLock()
        self._remotes: dict[str, RemoteNodeGatewayAdapter] = {}
        self._runtime_routes: dict[str, tuple[str, str]] = {}
        self.transport = self

    def create_session(self, *args: object, **kwargs: object) -> SessionIdentity:
        return self._local.create_session(*args, **kwargs)

    def resume_session(self, *args: object, **kwargs: object) -> SessionIdentity:
        return self._local.resume_session(*args, **kwargs)

    def create_session_for_node(
        self,
        node_id: str,
        profile: str,
        title: str,
        cwd: str,
        seed_messages: list[dict[str, Any]],
        configuration: dict[str, Any] | None = None,
    ) -> SessionIdentity:
        adapter = self._remote(node_id)
        return self._adopt_remote(
            node_id,
            adapter.create_session(
                profile, title, cwd, seed_messages, configuration
            ),
        )

    def resume_session_for_node(
        self, node_id: str, profile: str, stored_id: str
    ) -> SessionIdentity:
        adapter = self._remote(node_id)
        return self._adopt_remote(
            node_id, adapter.resume_session(profile, stored_id)
        )

    def submit_prompt(self, runtime_id: str, text: str) -> None:
        adapter, remote_id = self._route(runtime_id)
        adapter.submit_prompt(remote_id, text)

    def interrupt(self, runtime_id: str) -> None:
        adapter, remote_id = self._route(runtime_id)
        adapter.interrupt(remote_id)

    def close(self, runtime_id: str) -> bool:
        adapter, remote_id = self._route(runtime_id)
        result = adapter.close(remote_id)
        with self._lock:
            self._runtime_routes.pop(runtime_id, None)
        return result

    def respond_approval(self, runtime_id: str, choice: str) -> int:
        adapter, remote_id = self._route(runtime_id)
        return adapter.respond_approval(remote_id, choice)

    def respond_clarification(self, request_id: str, answer: str) -> str:
        with self._lock:
            remotes = list(self._remotes.values())
        for remote in remotes:
            if remote.owns_clarification(request_id):
                return remote.respond_clarification(request_id, answer)
        return self._local.respond_clarification(request_id, answer)

    def drain(self, timeout: float | None = None) -> bool:
        local_transport = getattr(self._local, "transport", None)
        drain = getattr(local_transport, "drain", None)
        return True if not callable(drain) else bool(drain(timeout=timeout))

    def shutdown(self) -> None:
        with self._lock:
            remotes = list(self._remotes.values())
            self._remotes.clear()
            self._runtime_routes.clear()
        for remote in remotes:
            remote.shutdown()
        self._local.shutdown()

    def _remote(self, node_id: str) -> RemoteNodeGatewayAdapter:
        with self._lock:
            existing = self._remotes.get(node_id)
            if existing is not None:
                return existing
            if self._registry is None:
                self._registry = PairedNodeRegistry.from_environment()
            node = self._registry.get(node_id)

            def callback(
                remote_runtime_id: str,
                event_type: str,
                payload: dict[str, object],
            ) -> None:
                with self._lock:
                    opaque = next(
                        (
                            key for key, route in self._runtime_routes.items()
                            if route == (node_id, remote_runtime_id)
                        ),
                        None,
                    )
                if opaque is not None:
                    self._on_event(opaque, event_type, payload)

            created = self._remote_factory(node, callback)
            self._remotes[node_id] = created
            return created

    def _adopt_remote(
        self, node_id: str, identity: SessionIdentity
    ) -> SessionIdentity:
        opaque = f"remote:{uuid.uuid4()}"
        with self._lock:
            self._runtime_routes[opaque] = (node_id, identity.runtime_id)
        return SessionIdentity(identity.stored_id, opaque, identity.running)

    def _route(self, runtime_id: str):
        with self._lock:
            route = self._runtime_routes.get(runtime_id)
            if route is None:
                return self._local, runtime_id
            node_id, remote_id = route
            remote = self._remotes.get(node_id)
        if remote is None:
            raise RemoteGatewayError("Remote runtime route is unavailable")
        return remote, remote_id


__all__ = [
    "GroupGatewayRouter",
    "RemoteGatewayError",
    "RemoteNodeGatewayAdapter",
]
