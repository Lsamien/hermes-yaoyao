"""Authenticated remote-execution facade for a paired Hermes node.

The public HTTP authentication boundary lives in the YaoYao Web node proxy.
This module deliberately exposes only the same stable Gateway operations used
by the native group orchestrator and keeps a bounded, cursor-based event journal
so an owning Hermes can drive a remote Agent without holding an inbound socket.
"""

from __future__ import annotations

from collections import deque
import base64
import copy
import threading
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .group_gateway import GroupGatewayAdapter, SessionIdentity


MAX_NODE_EVENTS = 4096
MAX_NODE_EVENT_PAGE = 256
MAX_NODE_STRING = 4096


class NodeWorkerModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class NodeWorkerOpenRequest(NodeWorkerModel):
    profile: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=500)
    cwd: str = Field(default="", max_length=MAX_NODE_STRING)
    stored_session_id: str | None = Field(
        default=None, alias="storedSessionId", max_length=MAX_NODE_STRING
    )
    model: str | None = Field(default=None, max_length=MAX_NODE_STRING)
    provider: str | None = Field(default=None, max_length=MAX_NODE_STRING)
    reasoning_effort: str | None = Field(
        default=None, alias="reasoningEffort", max_length=32
    )
    fast_mode: bool | None = Field(default=None, alias="fastMode")

    @field_validator(
        "profile", "title", "stored_session_id", "model", "provider",
        "reasoning_effort",
    )
    @classmethod
    def normalize_strings(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("string value must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_model_pair(self) -> "NodeWorkerOpenRequest":
        if (self.model is None) != (self.provider is None):
            raise ValueError("model and provider must be set together")
        return self


class NodeWorkerPromptRequest(NodeWorkerModel):
    text: str = Field(min_length=1, max_length=1_000_000)

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must not be blank")
        return value


class NodeWorkerApprovalRequest(NodeWorkerModel):
    choice: Literal["once", "session", "always", "deny"]


class NodeWorkerClarificationRequest(NodeWorkerModel):
    request_id: str = Field(alias="requestId", min_length=1, max_length=MAX_NODE_STRING)
    answer: str = Field(min_length=1, max_length=1_000_000)


class NodeWorkerError(RuntimeError):
    """Raised when the worker lifecycle or cursor contract is invalid."""


class NodeGatewayWorker:
    """Own one local Gateway adapter and a bounded replayable event journal."""

    def __init__(self, *, gateway: GroupGatewayAdapter | None = None) -> None:
        self._condition = threading.Condition(threading.RLock())
        self._cursor = 0
        self._events: deque[dict[str, object]] = deque(maxlen=MAX_NODE_EVENTS)
        self._runtime_clients: dict[str, str] = {}
        self._clarification_clients: dict[str, str] = {}
        self._closed = False
        self._gateway = gateway or GroupGatewayAdapter(on_event=self._on_event)

    def open_session(
        self, request: NodeWorkerOpenRequest, client_id: str = "local"
    ) -> dict[str, object]:
        self._require_open()
        configuration = {
            "model": request.model,
            "provider": request.provider,
            "reasoning_effort": request.reasoning_effort,
            "fast": request.fast_mode,
        }
        if request.stored_session_id is None:
            identity = self._gateway.create_session(
                request.profile,
                request.title,
                request.cwd,
                [],
                configuration,
            )
        else:
            identity = self._gateway.resume_session(
                request.profile, request.stored_session_id
            )
        with self._condition:
            client = self._client_id(client_id)
            self._runtime_clients[identity.runtime_id] = client
            for event in self._events:
                if event.get("runtimeSessionId") == identity.runtime_id:
                    event["clientId"] = client
                    if event.get("type") == "clarify.request":
                        payload = event.get("payload")
                        if isinstance(payload, dict):
                            request_id = payload.get("request_id") or payload.get(
                                "requestId"
                            )
                            if isinstance(request_id, str):
                                self._clarification_clients[request_id] = client
        return self._identity(identity)

    def submit_prompt(
        self,
        runtime_id: str,
        request: NodeWorkerPromptRequest,
        client_id: str = "local",
    ) -> None:
        self._require_open()
        self._gateway.submit_prompt(
            self._owned_runtime(runtime_id, client_id), request.text
        )

    def interrupt(self, runtime_id: str, client_id: str = "local") -> None:
        self._require_open()
        self._gateway.interrupt(self._owned_runtime(runtime_id, client_id))

    def close_session(self, runtime_id: str, client_id: str = "local") -> bool:
        self._require_open()
        return self._gateway.close(self._owned_runtime(runtime_id, client_id))

    def respond_approval(
        self,
        runtime_id: str,
        request: NodeWorkerApprovalRequest,
        client_id: str = "local",
    ) -> int:
        self._require_open()
        return self._gateway.respond_approval(
            self._owned_runtime(runtime_id, client_id), request.choice
        )

    def respond_clarification(
        self,
        request: NodeWorkerClarificationRequest,
        client_id: str = "local",
    ) -> str:
        self._require_open()
        client = self._client_id(client_id)
        with self._condition:
            if self._clarification_clients.get(request.request_id) != client:
                raise NodeWorkerError("Clarification does not belong to this client")
        return self._gateway.respond_clarification(request.request_id, request.answer)

    def attach_file(
        self,
        runtime_id: str,
        *,
        name: str,
        mime_type: str,
        content: bytes,
        client_id: str = "local",
    ) -> dict[str, object]:
        self._require_open()
        runtime = self._owned_runtime(runtime_id, client_id)
        if not isinstance(name, str) or not name.strip() or len(name) > 240:
            raise NodeWorkerError("Attachment name is invalid")
        if not isinstance(mime_type, str) or not mime_type.strip() or len(mime_type) > 200:
            raise NodeWorkerError("Attachment MIME type is invalid")
        if not isinstance(content, bytes) or not content or len(content) > 25 * 1024 * 1024:
            raise NodeWorkerError("Attachment content is invalid")
        result = self._gateway.request(
            "file.attach",
            {
                "session_id": runtime,
                "name": name.strip(),
                "data_url": (
                    f"data:{mime_type.strip()};base64,"
                    + base64.b64encode(content).decode("ascii")
                ),
            },
        )
        if not isinstance(result, dict):
            raise NodeWorkerError("Gateway attachment response is invalid")
        return result

    def events(
        self,
        *,
        after: int,
        runtime_id: str | None,
        limit: int,
        client_id: str = "local",
    ) -> dict[str, object]:
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise NodeWorkerError("after must be a non-negative integer")
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise NodeWorkerError("limit must be an integer")
        bounded_limit = max(1, min(limit, MAX_NODE_EVENT_PAGE))
        selected_runtime = (
            None if runtime_id is None else self._runtime_id(runtime_id)
        )
        client = self._client_id(client_id)
        with self._condition:
            client_events = [
                event for event in self._events
                if event.get("clientId") == client
            ]
            oldest = (
                int(client_events[0]["cursor"])
                if client_events else self._cursor + 1
            )
            reset = bool(client_events) and after > 0 and after < oldest - 1
            selected = [
                copy.deepcopy(event)
                for event in client_events
                if int(event["cursor"]) > after
                and (
                    selected_runtime is None
                    or event["runtimeSessionId"] == selected_runtime
                )
            ][:bounded_limit]
            items = []
            for event in selected:
                event.pop("clientId", None)
                items.append(event)
            return {
                "items": items,
                "latestCursor": self._cursor,
                "oldestCursor": oldest,
                "reset": reset,
            }

    def shutdown(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._closed = True
        self._gateway.shutdown()

    def _on_event(
        self, runtime_id: str, event_type: str, payload: dict[str, Any]
    ) -> None:
        with self._condition:
            if self._closed:
                return
            self._cursor += 1
            self._events.append(
                {
                    "cursor": self._cursor,
                    "runtimeSessionId": runtime_id,
                    "type": event_type,
                    "payload": copy.deepcopy(payload),
                    "clientId": self._runtime_clients.get(runtime_id, "local"),
                }
            )
            if event_type == "clarify.request":
                request_id = payload.get("request_id") or payload.get("requestId")
                if isinstance(request_id, str):
                    self._clarification_clients[request_id] = (
                        self._runtime_clients.get(runtime_id, "local")
                    )
            self._condition.notify_all()

    def _require_open(self) -> None:
        with self._condition:
            if self._closed:
                raise NodeWorkerError("Node worker is closed")

    @staticmethod
    def _runtime_id(value: str) -> str:
        if not isinstance(value, str):
            raise NodeWorkerError("runtimeSessionId must be a string")
        normalized = value.strip()
        if not normalized or len(normalized) > MAX_NODE_STRING:
            raise NodeWorkerError("runtimeSessionId is invalid")
        return normalized

    @staticmethod
    def _client_id(value: str) -> str:
        if not isinstance(value, str):
            raise NodeWorkerError("Node client identity is invalid")
        normalized = value.strip().lower()
        if not normalized or len(normalized) > 128:
            raise NodeWorkerError("Node client identity is invalid")
        return normalized

    def _owned_runtime(self, runtime_id: str, client_id: str) -> str:
        runtime = self._runtime_id(runtime_id)
        client = self._client_id(client_id)
        with self._condition:
            if self._runtime_clients.get(runtime) != client:
                raise NodeWorkerError("Runtime does not belong to this client")
        return runtime

    @staticmethod
    def _identity(identity: SessionIdentity) -> dict[str, object]:
        if not isinstance(identity, SessionIdentity):
            raise NodeWorkerError("Gateway returned an invalid session identity")
        return {
            "storedSessionId": identity.stored_id,
            "runtimeSessionId": identity.runtime_id,
            "running": identity.running,
        }


__all__ = [
    "MAX_NODE_EVENT_PAGE",
    "NodeGatewayWorker",
    "NodeWorkerApprovalRequest",
    "NodeWorkerClarificationRequest",
    "NodeWorkerError",
    "NodeWorkerOpenRequest",
    "NodeWorkerPromptRequest",
]
