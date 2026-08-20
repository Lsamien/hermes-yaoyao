"""Stable in-process adapter for the Hermes TUI Gateway JSON-RPC API."""

from __future__ import annotations

import copy
import inspect
import logging
import math
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import Any, Callable


logger = logging.getLogger(__name__)

_DELTA_EVENTS = frozenset({
    "message.delta",
    "reasoning.delta",
    "thinking.delta",
})
_APPROVAL_CHOICES = frozenset({"once", "session", "always", "deny"})

MAX_DELTA_BUFFER_BYTES = 64 * 1024
MAX_CONTROL_PAYLOAD_BYTES = 256 * 1024
MAX_TERMINAL_TEXT_BYTES = 64 * 1024
MAX_SAFE_JSON_INTEGER = (1 << 53) - 1
_MAX_DELTA_METADATA_BYTES = 16 * 1024
_MAX_CONTROL_STRING_BYTES = 32 * 1024
_MAX_DIAGNOSTIC_BYTES = 12 * 1024
_MAX_SUMMARY_BYTES = 12 * 1024
_MAX_PREVIEW_BYTES = 32 * 1024
_MAX_TOOL_PREVIEW_BYTES = 16 * 1024
_MAX_ROUTE_FIELD_BYTES = 4096
_MAX_EVENT_TYPE_BYTES = 256
_MAX_RUNTIME_ID_BYTES = 4096
_MAX_JSON_DEPTH = 64
_MAX_JSON_NODES = 100_000
_MAX_JSON_INSPECTION_BYTES = 4 * 1024 * 1024
_MAX_FINITE_JSON_FLOAT = 1.7976931348623157e308
_SESSION_INFO_STRING_LIMITS = {
    "model": _MAX_ROUTE_FIELD_BYTES,
    "provider": _MAX_ROUTE_FIELD_BYTES,
    "reasoning_effort": _MAX_ROUTE_FIELD_BYTES,
    "service_tier": _MAX_ROUTE_FIELD_BYTES,
    "approval_mode": _MAX_ROUTE_FIELD_BYTES,
    "cwd": _MAX_CONTROL_STRING_BYTES,
    "branch": _MAX_ROUTE_FIELD_BYTES,
    "personality": _MAX_ROUTE_FIELD_BYTES,
    "title": _MAX_DIAGNOSTIC_BYTES,
    "stored_session_id": _MAX_ROUTE_FIELD_BYTES,
    "version": _MAX_ROUTE_FIELD_BYTES,
    "release_date": _MAX_ROUTE_FIELD_BYTES,
    "update_command": _MAX_DIAGNOSTIC_BYTES,
    "credential_warning": _MAX_DIAGNOSTIC_BYTES,
    "profile_name": _MAX_ROUTE_FIELD_BYTES,
}
_SESSION_INFO_PREVIEW_LIMITS = {
    "tools": _MAX_TOOL_PREVIEW_BYTES,
    "skills": _MAX_TOOL_PREVIEW_BYTES,
    "project": _MAX_SUMMARY_BYTES,
    "usage": _MAX_SUMMARY_BYTES,
    "mcp_servers": _MAX_TOOL_PREVIEW_BYTES,
}
_SESSION_INFO_BOOLEAN_FIELDS = ("running", "fast", "yolo")
_SESSION_INFO_INTEGER_FIELDS = ("desktop_contract",)
_SESSION_INFO_OPTIONAL_INTEGER_FIELDS = ("update_behind",)
_SESSION_INFO_DROPPED_FIELDS = frozenset({"system_prompt"})
_SESSION_INFO_EXACT_ROUTE_FIELDS = frozenset({
    "stored_session_id",
    "profile_name",
    "cwd",
})


class GatewayError(RuntimeError):
    """Base exception for the plugin's stable Gateway boundary."""


class GatewayValidationError(GatewayError):
    """A caller supplied an invalid Gateway argument."""


class GatewayTransportClosed(GatewayError):
    """The in-process transport was closed while a request was pending."""


class GatewayTimeoutError(GatewayError):
    """A Gateway request did not receive a response before its deadline."""

    def __init__(self, method: str) -> None:
        self.method = method
        super().__init__(f"{method} timed out")


class GatewayDispatchError(GatewayError):
    """The core dispatcher failed synchronously."""

    def __init__(self, method: str) -> None:
        self.method = method
        super().__init__(f"{method} dispatcher failed")


class GatewayProtocolError(GatewayError):
    """The core dispatcher returned a response outside the stable contract."""

    def __init__(self, method: str, detail: str) -> None:
        self.method = method
        self.detail = detail
        super().__init__(f"{method}: {detail}")


class GatewayRPCError(GatewayError):
    """A well-formed JSON-RPC error returned by the core Gateway."""

    def __init__(
        self,
        method: str,
        code: int,
        rpc_message: str,
        data: Any = None,
    ) -> None:
        self.method = method
        self.code = code
        self.rpc_message = rpc_message
        self.data = data
        # Do not place core-provided text/data in the display string. HTTP callers
        # can safely surface this exception without disclosing internal details.
        super().__init__(f"{method} RPC failed ({code})")


@dataclass(frozen=True)
class SessionIdentity:
    """Persistent and process-local identities returned by session operations."""

    stored_id: str
    runtime_id: str
    running: bool


@dataclass
class _ResponseWaiter:
    request_id: str
    method: str
    on_late_response: Callable[[str, dict[str, Any]], None] | None = None
    event: threading.Event = field(default_factory=threading.Event)
    response: dict[str, Any] | None = None
    error: BaseException | None = None


@dataclass(frozen=True)
class _LateResponseTombstone:
    method: str
    expires_at: float
    callback: Callable[[str, dict[str, Any]], None]


@dataclass(frozen=True)
class _LateSessionContext:
    request_id: str
    method: str
    profile: str
    requested_stored_id: str | None
    adoption_generation: int


@dataclass(frozen=True)
class _JsonInspection:
    valid: bool
    encoded_bytes: int
    reason: str = ""


@dataclass
class _QueuedEvent:
    runtime_id: str
    event_type: str
    payload: dict[str, Any]
    delta_key: tuple[str, str] | None = None
    delta_bytes: int = 0


EventCallback = Callable[..., None]
Dispatcher = Callable[[dict[str, Any], "GroupGatewayTransport"], dict[str, Any] | None]


def _is_safe_json_integer(value: Any) -> bool:
    """Return whether an exact integer round-trips through IEEE-754 JSON peers."""

    return (
        type(value) is int
        and value.bit_length() <= MAX_SAFE_JSON_INTEGER.bit_length()
        and -MAX_SAFE_JSON_INTEGER <= value <= MAX_SAFE_JSON_INTEGER
    )


def _is_safe_json_float(value: Any) -> bool:
    """Return whether an exact float is a finite JSON-interoperable scalar."""

    return (
        type(value) is float
        and math.isfinite(value)
        and abs(value) <= _MAX_FINITE_JSON_FLOAT
    )


def _is_safe_json_scalar(value: Any) -> bool:
    return (
        value is None
        or type(value) is bool
        or _is_safe_json_integer(value)
        or _is_safe_json_float(value)
    )


def _inspect_json_payload(value: Any) -> _JsonInspection:
    """Validate strict JSON and measure its UTF-8 encoding without serializing."""

    encoded_bytes = 0
    nodes = 0
    ancestors: set[int] = set()
    failure_reason = ""

    def consume(size: int) -> bool:
        nonlocal encoded_bytes, failure_reason
        encoded_bytes += size
        if encoded_bytes > _MAX_JSON_INSPECTION_BYTES:
            failure_reason = "payload exceeds inspection budget"
            return False
        return True

    def string_size(text: str) -> int | None:
        nonlocal failure_reason
        if len(text) > _MAX_JSON_INSPECTION_BYTES:
            failure_reason = "string exceeds inspection budget"
            return None
        size = 2
        for character in text:
            codepoint = ord(character)
            if 0xD800 <= codepoint <= 0xDFFF:
                failure_reason = "string contains an invalid Unicode surrogate"
                return None
            if character in {'"', "\\"}:
                size += 2
            elif codepoint <= 0x1F:
                size += 6
            else:
                size += len(character.encode("utf-8"))
            if size > _MAX_JSON_INSPECTION_BYTES:
                failure_reason = "string exceeds inspection budget"
                return None
        return size

    def walk(item: Any, depth: int) -> bool:
        nonlocal nodes, failure_reason
        nodes += 1
        if nodes > _MAX_JSON_NODES:
            failure_reason = "payload contains too many JSON nodes"
            return False
        if depth > _MAX_JSON_DEPTH:
            failure_reason = "payload exceeds the JSON depth limit"
            return False
        if item is None:
            return consume(4)
        if type(item) is bool:
            return consume(4 if item else 5)
        if type(item) is int:
            if not _is_safe_json_integer(item):
                failure_reason = "integer exceeds the interoperable JSON range"
                return False
            return consume(len(str(item)))
        if type(item) is float:
            if not _is_safe_json_float(item):
                failure_reason = "float is outside the finite JSON range"
                return False
            return consume(len(repr(item)))
        if isinstance(item, str):
            encoded_size = string_size(item)
            return encoded_size is not None and consume(encoded_size)
        if isinstance(item, list):
            identity = id(item)
            if identity in ancestors:
                failure_reason = "cyclic list is not JSON"
                return False
            if not consume(2 + max(0, len(item) - 1)):
                return False
            ancestors.add(identity)
            try:
                return all(walk(child, depth + 1) for child in item)
            finally:
                ancestors.remove(identity)
        if isinstance(item, dict):
            identity = id(item)
            if identity in ancestors:
                failure_reason = "cyclic object is not JSON"
                return False
            if not consume(2 + max(0, len(item) - 1)):
                return False
            ancestors.add(identity)
            try:
                for key, child in item.items():
                    if not isinstance(key, str):
                        failure_reason = "JSON object keys must be strings"
                        return False
                    encoded_size = string_size(key)
                    if encoded_size is None or not consume(encoded_size + 1):
                        return False
                    if not walk(child, depth + 1):
                        return False
                return True
            finally:
                ancestors.remove(identity)
        failure_reason = "payload contains a non-JSON value"
        return False

    try:
        valid = walk(value, 0)
    except Exception:  # noqa: BLE001 - malformed core payloads are rejected
        return _JsonInspection(False, encoded_bytes, "payload validation failed")
    return _JsonInspection(valid, encoded_bytes, failure_reason)


def _json_payload_within_limit(value: Any, limit: int) -> bool:
    inspection = _inspect_json_payload(value)
    return inspection.valid and inspection.encoded_bytes <= limit


def _utf8_chunks(text: str, limit: int):
    """Yield non-empty codepoint-safe chunks no larger than ``limit`` bytes."""

    if not text:
        yield "", 0
        return
    characters: list[str] = []
    encoded_bytes = 0
    for character in text:
        character_bytes = len(character.encode("utf-8"))
        if characters and encoded_bytes + character_bytes > limit:
            yield "".join(characters), encoded_bytes
            characters = []
            encoded_bytes = 0
        characters.append(character)
        encoded_bytes += character_bytes
    if characters:
        yield "".join(characters), encoded_bytes


def _bounded_utf8(text: str, limit: int) -> bool:
    if len(text) > limit:
        return False
    try:
        return len(text.encode("utf-8")) <= limit
    except UnicodeError:
        return False


def _utf8_prefix(text: str, limit: int) -> tuple[str, bool]:
    characters: list[str] = []
    encoded_bytes = 0
    try:
        for character in text:
            character_bytes = len(character.encode("utf-8"))
            if encoded_bytes + character_bytes > limit:
                return "".join(characters), True
            characters.append(character)
            encoded_bytes += character_bytes
    except UnicodeError:
        return "".join(characters), True
    return text, False


def _json_string_prefix(text: str, limit: int) -> tuple[str, bool]:
    """Bound a string by its strict UTF-8 JSON encoding, including escapes."""

    characters: list[str] = []
    encoded_bytes = 2  # Opening and closing quotes.
    for character in text:
        codepoint = ord(character)
        if 0xD800 <= codepoint <= 0xDFFF:
            return "".join(characters), True
        if character in {'"', "\\"}:
            character_bytes = 2
        elif codepoint <= 0x1F:
            character_bytes = 6
        else:
            character_bytes = len(character.encode("utf-8"))
        if encoded_bytes + character_bytes > limit:
            return "".join(characters), True
        characters.append(character)
        encoded_bytes += character_bytes
    return text, False


def _contains_control_character(text: str) -> bool:
    return any(
        ord(character) <= 0x1F or ord(character) == 0x7F
        for character in text
    )


@dataclass
class _PreviewBudget:
    remaining_bytes: int
    remaining_nodes: int = 128
    truncated: bool = False


def _bounded_json_preview(value: Any, limit: int) -> tuple[Any, bool]:
    if _json_payload_within_limit(value, limit):
        try:
            return copy.deepcopy(value), False
        except Exception:  # noqa: BLE001 - fall through to the safe projector
            pass

    budget = _PreviewBudget(limit)

    def walk(item: Any, depth: int) -> Any:
        budget.remaining_nodes -= 1
        if budget.remaining_nodes < 0 or depth > 4:
            budget.truncated = True
            return "<truncated>"
        if item is None or type(item) is bool:
            return item
        if type(item) is int:
            if _is_safe_json_integer(item):
                return item
            budget.truncated = True
            return "<integer outside safe JSON range>"
        if type(item) is float:
            if _is_safe_json_float(item):
                return item
            budget.truncated = True
            return "<float outside finite JSON range>"
        if isinstance(item, str):
            per_string_limit = min(8192, max(0, budget.remaining_bytes))
            projected, truncated = _utf8_prefix(item, per_string_limit)
            budget.remaining_bytes -= len(projected.encode("utf-8"))
            budget.truncated = budget.truncated or truncated
            return projected
        if isinstance(item, list):
            projected_items = []
            for child in item[:32]:
                projected_items.append(walk(child, depth + 1))
            if len(item) > len(projected_items):
                budget.truncated = True
            return projected_items
        if isinstance(item, dict):
            projected_object: dict[str, Any] = {}
            for index, (key, child) in enumerate(item.items()):
                if index >= 32 or budget.remaining_nodes <= 0:
                    budget.truncated = True
                    break
                if not isinstance(key, str):
                    budget.truncated = True
                    continue
                projected_key, key_truncated = _utf8_prefix(key, 256)
                if not projected_key or projected_key in projected_object:
                    budget.truncated = True
                    continue
                budget.truncated = budget.truncated or key_truncated
                projected_object[projected_key] = walk(child, depth + 1)
            return projected_object
        budget.truncated = True
        return "<invalid value>"

    projected = walk(value, 0)
    if not _json_payload_within_limit(projected, limit):
        return "<preview omitted>", True
    return projected, True


def _copy_bounded_string(
    source: dict[str, Any],
    target: dict[str, Any],
    field_name: str,
    limit: int,
    truncated_fields: list[str],
) -> None:
    if field_name not in source:
        return
    value = source[field_name]
    if not isinstance(value, str):
        truncated_fields.append(field_name)
        return
    projected, truncated = _utf8_prefix(value, limit)
    target[field_name] = projected
    if truncated:
        truncated_fields.append(field_name)


def _copy_bounded_preview(
    source: dict[str, Any],
    target: dict[str, Any],
    field_name: str,
    limit: int,
    truncated_fields: list[str],
) -> None:
    if field_name not in source:
        return
    projected, truncated = _bounded_json_preview(source[field_name], limit)
    target[field_name] = projected
    if truncated:
        truncated_fields.append(field_name)


def _copy_scalar_fields(
    source: dict[str, Any],
    target: dict[str, Any],
    fields: tuple[str, ...],
    invalid_fields: list[str],
) -> None:
    for field_name in fields:
        if field_name not in source:
            continue
        value = source[field_name]
        if _is_safe_json_scalar(value):
            target[field_name] = value
        else:
            invalid_fields.append(field_name)


def _is_session_info_scalar_valid(field_name: str, value: Any) -> bool:
    if field_name in _SESSION_INFO_BOOLEAN_FIELDS:
        return type(value) is bool
    if field_name in _SESSION_INFO_INTEGER_FIELDS:
        return _is_safe_json_integer(value)
    if field_name in _SESSION_INFO_OPTIONAL_INTEGER_FIELDS:
        return value is None or _is_safe_json_integer(value)
    return False


def _copy_session_info_scalars(
    source: dict[str, Any],
    target: dict[str, Any],
    invalid_fields: list[str],
) -> None:
    scalar_fields = (
        *_SESSION_INFO_BOOLEAN_FIELDS,
        *_SESSION_INFO_INTEGER_FIELDS,
        *_SESSION_INFO_OPTIONAL_INTEGER_FIELDS,
    )
    for field_name in scalar_fields:
        if field_name not in source:
            continue
        value = source[field_name]
        if _is_session_info_scalar_valid(field_name, value):
            target[field_name] = value
        else:
            invalid_fields.append(field_name)


def _copy_session_info_string(
    source: dict[str, Any],
    target: dict[str, Any],
    field_name: str,
    limit: int,
    truncated_fields: list[str],
    invalid_fields: list[str],
) -> None:
    if field_name not in source:
        return
    value = source[field_name]
    if not isinstance(value, str):
        invalid_fields.append(field_name)
        return
    if field_name in _SESSION_INFO_EXACT_ROUTE_FIELDS:
        if _contains_control_character(value):
            invalid_fields.append(field_name)
            return
        if not _json_payload_within_limit(value, limit):
            truncated_fields.append(field_name)
            return
        target[field_name] = value
        return
    projected, truncated = _json_string_prefix(value, limit)
    target[field_name] = projected
    if truncated:
        truncated_fields.append(field_name)


def _append_dropped_fields(
    source: dict[str, Any],
    selected: set[str],
    truncated_fields: list[str],
) -> None:
    for field_name in source:
        if not isinstance(field_name, str) or field_name in selected:
            continue
        if len(truncated_fields) >= 64:
            break
        projected_name, _truncated = _utf8_prefix(field_name, 256)
        if projected_name:
            truncated_fields.append(projected_name)


def _mark_projected_control(
    payload: dict[str, Any],
    inspection: _JsonInspection,
    truncated_fields: list[str],
    invalid_fields: list[str],
) -> dict[str, Any]:
    if inspection.valid:
        payload["transportTruncated"] = True
        payload["originalBytes"] = inspection.encoded_bytes
        payload["transportWarning"] = "Gateway control payload was safely truncated"
    else:
        payload["transportInvalidPayload"] = True
        payload["transportWarning"] = (
            "Gateway control payload was invalid and safely projected"
        )
    unique_fields = list(dict.fromkeys(truncated_fields))[:64]
    if unique_fields:
        payload["truncatedFields"] = unique_fields
    unique_invalid_fields = list(dict.fromkeys(invalid_fields))[:64]
    if unique_invalid_fields:
        payload["invalidFields"] = unique_invalid_fields
    return payload


def _project_message_control(
    source: dict[str, Any],
    inspection: _JsonInspection,
) -> dict[str, Any]:
    projected: dict[str, Any] = {}
    truncated_fields: list[str] = []
    invalid_fields: list[str] = []
    string_limits = {
        "status": 256,
        "text": MAX_TERMINAL_TEXT_BYTES,
        "reasoning": MAX_TERMINAL_TEXT_BYTES,
        "error": _MAX_DIAGNOSTIC_BYTES,
        "failure_reason": _MAX_DIAGNOSTIC_BYTES,
        "warning": _MAX_DIAGNOSTIC_BYTES,
        "message": _MAX_DIAGNOSTIC_BYTES,
    }
    for field_name, limit in string_limits.items():
        _copy_bounded_string(source, projected, field_name, limit, truncated_fields)
    _copy_scalar_fields(
        source,
        projected,
        ("recoverable", "partial", "response_previewed"),
        invalid_fields,
    )
    for field_name in ("usage", "billing"):
        _copy_bounded_preview(
            source, projected, field_name, _MAX_SUMMARY_BYTES, truncated_fields
        )
    selected = set(string_limits) | {
        "recoverable",
        "partial",
        "response_previewed",
        "usage",
        "billing",
    }
    _append_dropped_fields(source, selected, truncated_fields)
    return _mark_projected_control(
        projected, inspection, truncated_fields, invalid_fields
    )


def _project_interaction_control(
    source: dict[str, Any],
    inspection: _JsonInspection,
) -> dict[str, Any]:
    projected: dict[str, Any] = {}
    truncated_fields: list[str] = []
    invalid_fields: list[str] = []
    string_limits = {
        "request_id": _MAX_ROUTE_FIELD_BYTES,
        "interaction_id": _MAX_ROUTE_FIELD_BYTES,
        "question": _MAX_CONTROL_STRING_BYTES,
        "command": _MAX_CONTROL_STRING_BYTES,
        "reason": _MAX_DIAGNOSTIC_BYTES,
        "message": _MAX_DIAGNOSTIC_BYTES,
        "description": _MAX_DIAGNOSTIC_BYTES,
        "tool": _MAX_ROUTE_FIELD_BYTES,
        "name": _MAX_ROUTE_FIELD_BYTES,
    }
    for field_name, limit in string_limits.items():
        _copy_bounded_string(source, projected, field_name, limit, truncated_fields)
    for field_name in ("choices", "flags"):
        _copy_bounded_preview(
            source, projected, field_name, _MAX_PREVIEW_BYTES, truncated_fields
        )
    scalar_fields = (
        "allow_permanent",
        "smart_denied",
        "multi_select",
        "redacted",
        "all",
    )
    _copy_scalar_fields(source, projected, scalar_fields, invalid_fields)
    selected = set(string_limits) | {"choices", "flags", *scalar_fields}
    _append_dropped_fields(source, selected, truncated_fields)
    return _mark_projected_control(
        projected, inspection, truncated_fields, invalid_fields
    )


def _project_tool_control(
    source: dict[str, Any],
    inspection: _JsonInspection,
) -> dict[str, Any]:
    projected: dict[str, Any] = {}
    truncated_fields: list[str] = []
    invalid_fields: list[str] = []
    string_limits = {
        "tool_id": _MAX_ROUTE_FIELD_BYTES,
        "id": _MAX_ROUTE_FIELD_BYTES,
        "name": _MAX_ROUTE_FIELD_BYTES,
        "status": 256,
        "risk": _MAX_ROUTE_FIELD_BYTES,
        "summary": _MAX_SUMMARY_BYTES,
        "context": _MAX_SUMMARY_BYTES,
        "error": _MAX_DIAGNOSTIC_BYTES,
        "warning": _MAX_DIAGNOSTIC_BYTES,
        "args_text": _MAX_TOOL_PREVIEW_BYTES,
        "result_text": _MAX_TOOL_PREVIEW_BYTES,
        "inline_diff": _MAX_TOOL_PREVIEW_BYTES,
    }
    for field_name, limit in string_limits.items():
        _copy_bounded_string(source, projected, field_name, limit, truncated_fields)
    for field_name in ("args", "result", "findings", "todos", "metadata"):
        _copy_bounded_preview(
            source, projected, field_name, _MAX_TOOL_PREVIEW_BYTES, truncated_fields
        )
    scalar_fields = ("redacted", "duration_s", "progress")
    _copy_scalar_fields(source, projected, scalar_fields, invalid_fields)
    selected = set(string_limits) | {
        "args",
        "result",
        "findings",
        "todos",
        "metadata",
        *scalar_fields,
    }
    _append_dropped_fields(source, selected, truncated_fields)
    return _mark_projected_control(
        projected, inspection, truncated_fields, invalid_fields
    )


def _project_session_info_control(
    source: dict[str, Any],
    inspection: _JsonInspection,
) -> dict[str, Any]:
    """Keep session routing and settle state when diagnostics exceed the wire cap."""

    projected: dict[str, Any] = {}
    truncated_fields: list[str] = []
    invalid_fields: list[str] = []
    for field_name, limit in _SESSION_INFO_STRING_LIMITS.items():
        _copy_session_info_string(
            source,
            projected,
            field_name,
            limit,
            truncated_fields,
            invalid_fields,
        )
    _copy_session_info_scalars(source, projected, invalid_fields)
    for field_name, limit in _SESSION_INFO_PREVIEW_LIMITS.items():
        _copy_bounded_preview(
            source, projected, field_name, limit, truncated_fields
        )
    for field_name in _SESSION_INFO_DROPPED_FIELDS:
        if field_name in source:
            truncated_fields.append(field_name)
    selected = (
        set(_SESSION_INFO_STRING_LIMITS)
        | set(_SESSION_INFO_PREVIEW_LIMITS)
        | set(_SESSION_INFO_BOOLEAN_FIELDS)
        | set(_SESSION_INFO_INTEGER_FIELDS)
        | set(_SESSION_INFO_OPTIONAL_INTEGER_FIELDS)
        | set(_SESSION_INFO_DROPPED_FIELDS)
    )
    _append_dropped_fields(source, selected, truncated_fields)
    marked = _mark_projected_control(
        projected, inspection, truncated_fields, invalid_fields
    )
    if invalid_fields:
        marked["transportInvalidPayload"] = True
    return marked


def _control_payload_sentinel(inspection: _JsonInspection) -> dict[str, Any]:
    if not inspection.valid:
        return {
            "transportInvalidPayload": True,
            "transportWarning": "Gateway control payload was invalid and replaced",
        }
    return {
        "transportTruncated": True,
        "originalBytes": inspection.encoded_bytes,
        "transportWarning": "Gateway control payload was replaced at the size limit",
    }


def _sanitize_control_payload(
    event_type: str,
    source: Any,
    inspection: _JsonInspection,
) -> dict[str, Any]:
    if not isinstance(source, dict):
        return _control_payload_sentinel(inspection)
    if event_type == "session.info":
        projected = _project_session_info_control(source, inspection)
    elif (
        event_type == "message.complete"
        or event_type == "error"
        or event_type.endswith((".error", ".failed"))
    ):
        projected = _project_message_control(source, inspection)
    elif event_type == "approval.request" or event_type in {
        "clarify.request",
        "clarify.expire",
    }:
        projected = _project_interaction_control(source, inspection)
    elif event_type.startswith("tool."):
        projected = _project_tool_control(source, inspection)
    else:
        return _control_payload_sentinel(inspection)

    if _json_payload_within_limit(projected, MAX_CONTROL_PAYLOAD_BYTES):
        return projected
    logger.error("Gateway control projection exceeded its hard byte limit")
    return _control_payload_sentinel(
        _JsonInspection(False, inspection.encoded_bytes, "projection exceeded limit")
    )


def _control_requires_projection(
    event_type: str,
    source: Any,
    inspection: _JsonInspection,
) -> bool:
    if (
        not isinstance(source, dict)
        or not inspection.valid
        or inspection.encoded_bytes > MAX_CONTROL_PAYLOAD_BYTES
    ):
        return True
    limits: dict[str, int] = {}
    preview_limits: dict[str, int] = {}
    scalar_fields: tuple[str, ...] = ()
    typed_session_info_scalars = False
    if event_type == "session.info":
        limits = _SESSION_INFO_STRING_LIMITS
        preview_limits = _SESSION_INFO_PREVIEW_LIMITS
        typed_session_info_scalars = True
    elif (
        event_type == "message.complete"
        or event_type == "error"
        or event_type.endswith((".error", ".failed"))
    ):
        limits = {
            "status": 256,
            "text": MAX_TERMINAL_TEXT_BYTES,
            "reasoning": MAX_TERMINAL_TEXT_BYTES,
            "error": _MAX_DIAGNOSTIC_BYTES,
            "failure_reason": _MAX_DIAGNOSTIC_BYTES,
            "warning": _MAX_DIAGNOSTIC_BYTES,
            "message": _MAX_DIAGNOSTIC_BYTES,
        }
        preview_limits = {"usage": _MAX_SUMMARY_BYTES, "billing": _MAX_SUMMARY_BYTES}
        scalar_fields = ("recoverable", "partial", "response_previewed")
    elif event_type == "approval.request" or event_type in {
        "clarify.request",
        "clarify.expire",
    }:
        limits = {
            "request_id": _MAX_ROUTE_FIELD_BYTES,
            "interaction_id": _MAX_ROUTE_FIELD_BYTES,
            "question": _MAX_CONTROL_STRING_BYTES,
            "command": _MAX_CONTROL_STRING_BYTES,
            "reason": _MAX_DIAGNOSTIC_BYTES,
            "message": _MAX_DIAGNOSTIC_BYTES,
            "description": _MAX_DIAGNOSTIC_BYTES,
            "tool": _MAX_ROUTE_FIELD_BYTES,
            "name": _MAX_ROUTE_FIELD_BYTES,
        }
        preview_limits = {
            "choices": _MAX_PREVIEW_BYTES,
            "flags": _MAX_PREVIEW_BYTES,
        }
        scalar_fields = (
            "allow_permanent",
            "smart_denied",
            "multi_select",
            "redacted",
            "all",
        )
    elif event_type.startswith("tool."):
        limits = {
            "tool_id": _MAX_ROUTE_FIELD_BYTES,
            "id": _MAX_ROUTE_FIELD_BYTES,
            "name": _MAX_ROUTE_FIELD_BYTES,
            "status": 256,
            "risk": _MAX_ROUTE_FIELD_BYTES,
            "summary": _MAX_SUMMARY_BYTES,
            "context": _MAX_SUMMARY_BYTES,
            "error": _MAX_DIAGNOSTIC_BYTES,
            "warning": _MAX_DIAGNOSTIC_BYTES,
            "args_text": _MAX_TOOL_PREVIEW_BYTES,
            "result_text": _MAX_TOOL_PREVIEW_BYTES,
            "inline_diff": _MAX_TOOL_PREVIEW_BYTES,
        }
        preview_limits = {
            field_name: _MAX_TOOL_PREVIEW_BYTES
            for field_name in ("args", "result", "findings", "todos", "metadata")
        }
        scalar_fields = ("redacted", "duration_s", "progress")
    for field_name, limit in limits.items():
        if field_name not in source:
            continue
        value = source[field_name]
        if not isinstance(value, str):
            return True
        if event_type == "session.info":
            if (
                field_name in _SESSION_INFO_EXACT_ROUTE_FIELDS
                and _contains_control_character(value)
            ):
                return True
            if not _json_payload_within_limit(value, limit):
                return True
        elif not _bounded_utf8(value, limit):
            return True
    if any(
        field_name in source
        and not _json_payload_within_limit(source[field_name], limit)
        for field_name, limit in preview_limits.items()
    ):
        return True
    if typed_session_info_scalars:
        typed_fields = (
            *_SESSION_INFO_BOOLEAN_FIELDS,
            *_SESSION_INFO_INTEGER_FIELDS,
            *_SESSION_INFO_OPTIONAL_INTEGER_FIELDS,
        )
        return any(
            field_name in source
            and not _is_session_info_scalar_valid(field_name, source[field_name])
            for field_name in typed_fields
        )
    return any(
        field_name in source and not _is_safe_json_scalar(source[field_name])
        for field_name in scalar_fields
    )


class GroupGatewayTransport:
    """Thread-safe response router and bounded serial event transport."""

    def __init__(
        self,
        on_event: EventCallback,
        *,
        max_control_frames: int = 128,
        late_response_ttl: float = 30.0,
        max_late_responses: int = 128,
    ) -> None:
        if not callable(on_event):
            raise GatewayValidationError("on_event must be callable")
        if (
            isinstance(max_control_frames, bool)
            or not isinstance(max_control_frames, int)
            or max_control_frames < 1
        ):
            raise GatewayValidationError(
                "max_control_frames must be a positive integer"
            )
        if (
            isinstance(late_response_ttl, bool)
            or not isinstance(late_response_ttl, (int, float))
            or not math.isfinite(late_response_ttl)
            or late_response_ttl <= 0
        ):
            raise GatewayValidationError("late_response_ttl must be positive")
        if (
            isinstance(max_late_responses, bool)
            or not isinstance(max_late_responses, int)
            or max_late_responses < 1
        ):
            raise GatewayValidationError(
                "max_late_responses must be a positive integer"
            )

        self._on_event = self._normalize_callback(on_event)
        self._max_queued_frames = max_control_frames
        self._late_response_ttl = float(late_response_ttl)
        self._max_late_responses = max_late_responses
        self._condition = threading.Condition(threading.RLock())
        self._closed = False
        self._waiters: dict[str, _ResponseWaiter] = {}
        self._tombstones: dict[str, _LateResponseTombstone] = {}
        self._events: deque[_QueuedEvent] = deque()
        self._callback_active = False
        self._worker = threading.Thread(
            target=self._event_worker,
            name="yaoyao-group-gateway-events",
            daemon=True,
        )
        self._worker.start()

    @staticmethod
    def _normalize_callback(on_event: EventCallback) -> EventCallback:
        try:
            signature = inspect.signature(on_event)
        except (TypeError, ValueError):
            return on_event
        try:
            signature.bind("runtime", "event.type", {})
        except TypeError:
            try:
                signature.bind("runtime", {"type": "event.type", "payload": {}})
            except TypeError as exc:
                raise GatewayValidationError(
                    "on_event must accept either two or three positional arguments"
                ) from exc

            def design_callback(
                runtime_id: str, event_type: str, payload: dict[str, Any]
            ) -> None:
                on_event(runtime_id, {"type": event_type, "payload": payload})

            return design_callback
        return on_event

    @property
    def closed(self) -> bool:
        with self._condition:
            return self._closed

    @property
    def pending_waiter_count(self) -> int:
        with self._condition:
            return len(self._waiters)

    @property
    def pending_tombstone_count(self) -> int:
        with self._condition:
            self._prune_tombstones_locked(time.monotonic())
            return len(self._tombstones)

    def register_waiter(
        self,
        request_id: str,
        *,
        method: str = "request",
        on_late_response: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> _ResponseWaiter:
        if on_late_response is not None and not callable(on_late_response):
            raise GatewayValidationError("on_late_response must be callable")
        waiter = _ResponseWaiter(
            request_id=request_id,
            method=method,
            on_late_response=on_late_response,
        )
        with self._condition:
            if self._closed:
                raise GatewayTransportClosed("Gateway transport is closed")
            self._prune_tombstones_locked(time.monotonic())
            if request_id in self._waiters or request_id in self._tombstones:
                raise GatewayProtocolError("request", "duplicate request id")
            self._waiters[request_id] = waiter
        return waiter

    def cancel_waiter(self, waiter: _ResponseWaiter) -> None:
        with self._condition:
            current = self._waiters.get(waiter.request_id)
            if current is waiter:
                del self._waiters[waiter.request_id]

    def wait_for_response(
        self,
        waiter: _ResponseWaiter,
        *,
        timeout: float,
        method: str,
    ) -> dict[str, Any]:
        if not waiter.event.wait(timeout):
            with self._condition:
                current = self._waiters.get(waiter.request_id)
                if current is waiter:
                    del self._waiters[waiter.request_id]
                    if waiter.on_late_response is not None:
                        self._add_tombstone_locked(waiter, time.monotonic())
                    raise GatewayTimeoutError(method)
                # A response or close won the timeout race while this thread
                # was acquiring the condition. Its waiter state is complete.

        if waiter.error is not None:
            raise waiter.error
        if waiter.response is None:
            raise GatewayProtocolError(
                method, "response waiter completed without a response"
            )
        return waiter.response

    def write(self, obj: dict[str, Any]) -> bool:
        """Route a core response or event; return false after close."""

        with self._condition:
            if self._closed:
                return False

        if not isinstance(obj, dict):
            return True

        if "id" in obj and obj.get("method") != "event":
            self._write_response(obj)
            return True
        if obj.get("method") == "event":
            event = self._parse_event(obj)
            if event is not None:
                return self._enqueue_event(event)
        return True

    def _write_response(self, response: dict[str, Any]) -> None:
        request_id = response.get("id")
        if not isinstance(request_id, str):
            return
        late_callback: Callable[[str, dict[str, Any]], None] | None = None
        late_method = ""
        late_response: dict[str, Any] | None = None
        with self._condition:
            if self._closed:
                return
            self._prune_tombstones_locked(time.monotonic())
            waiter = self._waiters.pop(request_id, None)
            if waiter is not None:
                try:
                    waiter.response = copy.deepcopy(response)
                except Exception:  # noqa: BLE001 - malformed core objects are ignored safely
                    waiter.response = dict(response)
                waiter.event.set()
                return
            tombstone = self._tombstones.pop(request_id, None)
            if tombstone is not None:
                late_callback = tombstone.callback
                late_method = tombstone.method
                try:
                    late_response = copy.deepcopy(response)
                except Exception:  # noqa: BLE001 - malformed late results are ignored
                    late_response = dict(response)

        if late_callback is not None and late_response is not None:
            try:
                late_callback(late_method, late_response)
            except Exception:  # noqa: BLE001 - never bind core response writers
                logger.exception("YaoYao group late Gateway response callback failed")

    def _prune_tombstones_locked(self, now: float) -> None:
        expired = [
            request_id
            for request_id, tombstone in self._tombstones.items()
            if tombstone.expires_at <= now
        ]
        for request_id in expired:
            self._tombstones.pop(request_id, None)

    def _add_tombstone_locked(self, waiter: _ResponseWaiter, now: float) -> None:
        callback = waiter.on_late_response
        if callback is None:
            return
        self._prune_tombstones_locked(now)
        while len(self._tombstones) >= self._max_late_responses:
            oldest = next(iter(self._tombstones))
            del self._tombstones[oldest]
            logger.warning("Evicted an expired-session cleanup tombstone at capacity")
        self._tombstones[waiter.request_id] = _LateResponseTombstone(
            method=waiter.method,
            expires_at=now + self._late_response_ttl,
            callback=callback,
        )
        self._condition.notify_all()

    @staticmethod
    def _parse_event(frame: dict[str, Any]) -> _QueuedEvent | None:
        params = frame.get("params")
        if not isinstance(params, dict):
            return None
        runtime_id = params.get("session_id")
        event_type = params.get("type")
        if not isinstance(runtime_id, str) or not runtime_id:
            return None
        if not isinstance(event_type, str) or not event_type:
            return None
        if not _bounded_utf8(runtime_id, _MAX_RUNTIME_ID_BYTES) or not _bounded_utf8(
            event_type, _MAX_EVENT_TYPE_BYTES
        ):
            logger.warning("Rejected oversized YaoYao group Gateway event identity")
            return None
        raw_payload = params.get("payload", {})
        if raw_payload is None:
            raw_payload = {}
        delta_key: tuple[str, str] | None = None
        if event_type in _DELTA_EVENTS:
            if not isinstance(raw_payload, dict):
                return None
            text = raw_payload.get("text")
            if not isinstance(text, str):
                return None
            if any(0xD800 <= ord(character) <= 0xDFFF for character in text):
                logger.warning("Rejected non-UTF-8 Gateway delta text")
                return None
            metadata = dict(raw_payload)
            metadata["text"] = ""
            if not _json_payload_within_limit(metadata, _MAX_DELTA_METADATA_BYTES):
                logger.warning("Rejected oversized or non-JSON Gateway delta metadata")
                return None
            delta_key = (runtime_id, event_type)
            try:
                payload = copy.deepcopy(raw_payload)
            except Exception:  # noqa: BLE001 - malformed delta objects are ignored safely
                return None
        else:
            inspection = _inspect_json_payload(raw_payload)
            if inspection.valid and not isinstance(raw_payload, dict):
                inspection = _JsonInspection(
                    False,
                    inspection.encoded_bytes,
                    "event payload must be a JSON object",
                )
            if (
                isinstance(raw_payload, dict)
                and inspection.valid
                and not _control_requires_projection(
                    event_type,
                    raw_payload,
                    inspection,
                )
            ):
                try:
                    payload = copy.deepcopy(raw_payload)
                except Exception:  # noqa: BLE001 - deliver an invalid sentinel instead
                    payload = _control_payload_sentinel(
                        _JsonInspection(False, 0, "payload copy failed")
                    )
            else:
                payload = _sanitize_control_payload(
                    event_type,
                    raw_payload,
                    inspection,
                )
        return _QueuedEvent(runtime_id, event_type, payload, delta_key)

    def _enqueue_event(self, event: _QueuedEvent) -> bool:
        if event.delta_key is not None:
            return self._enqueue_delta(event)
        return self._enqueue_control(event)

    def _enqueue_delta(self, event: _QueuedEvent) -> bool:
        source_text = event.payload["text"]
        for chunk, chunk_bytes in _utf8_chunks(source_text, MAX_DELTA_BUFFER_BYTES):
            payload = dict(event.payload)
            payload["text"] = chunk
            queued = _QueuedEvent(
                event.runtime_id,
                event.event_type,
                payload,
                event.delta_key,
                chunk_bytes,
            )
            with self._condition:
                while True:
                    if self._closed:
                        return False
                    previous = self._events[-1] if self._events else None
                    if (
                        previous is not None
                        and previous.delta_key == queued.delta_key
                        and previous.delta_bytes + queued.delta_bytes
                        <= MAX_DELTA_BUFFER_BYTES
                    ):
                        merged_text = previous.payload["text"] + queued.payload["text"]
                        previous.payload.update(queued.payload)
                        previous.payload["text"] = merged_text
                        previous.delta_bytes += queued.delta_bytes
                        break
                    if len(self._events) < self._max_queued_frames:
                        self._events.append(queued)
                        self._condition.notify_all()
                        break
                    self._condition.wait()
        return True

    def _enqueue_control(self, event: _QueuedEvent) -> bool:
        with self._condition:
            if self._closed:
                return False
            while len(self._events) >= self._max_queued_frames and not self._closed:
                self._condition.wait()
            if self._closed:
                return False
            self._events.append(event)
            self._condition.notify_all()
            return True

    def _event_worker(self) -> None:
        while True:
            with self._condition:
                while not self._events and not self._closed:
                    now = time.monotonic()
                    self._prune_tombstones_locked(now)
                    if self._tombstones:
                        next_expiry = min(
                            tombstone.expires_at
                            for tombstone in self._tombstones.values()
                        )
                        self._condition.wait(max(0.0, next_expiry - now))
                    else:
                        self._condition.wait()
                if self._closed:
                    return
                event = self._events.popleft()
                self._callback_active = True
                self._condition.notify_all()

            try:
                self._on_event(event.runtime_id, event.event_type, event.payload)
            except Exception:  # noqa: BLE001 - isolate plugin consumer failures
                logger.exception("YaoYao group Gateway event callback failed")
            finally:
                with self._condition:
                    self._callback_active = False
                    self._condition.notify_all()

    def drain(self, timeout: float | None = None) -> bool:
        """Wait until queued callbacks finish; intended for orderly shutdown/tests."""

        if timeout is not None and timeout < 0:
            raise GatewayValidationError("drain timeout must be non-negative")
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            if threading.current_thread() is self._worker:
                return not self._events
            while self._events or self._callback_active:
                if deadline is None:
                    self._condition.wait()
                    continue
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True

    def close(self) -> None:
        waiters: list[_ResponseWaiter]
        with self._condition:
            if not self._closed:
                self._closed = True
                waiters = list(self._waiters.values())
                self._waiters.clear()
                self._tombstones.clear()
                self._events.clear()
                for waiter in waiters:
                    waiter.error = GatewayTransportClosed("Gateway transport is closed")
                    waiter.event.set()
                self._condition.notify_all()

        if threading.current_thread() is not self._worker:
            self._worker.join()


def _default_dispatcher(
    request: dict[str, Any],
    transport: GroupGatewayTransport,
) -> dict[str, Any] | None:
    # tui_gateway.server is intentionally private and expensive. Keep the import
    # inside this one boundary and defer it until the first actual request.
    from tui_gateway.server import dispatch

    return dispatch(request, transport)


def _nonempty_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GatewayValidationError(f"{field_name} must be a non-empty string")
    return value


def _response_string(result: dict[str, Any], field_name: str, method: str) -> str:
    value = result.get(field_name)
    if not isinstance(value, str) or not value:
        raise GatewayProtocolError(method, f"missing or invalid {field_name}")
    return value


def _response_bool(
    result: dict[str, Any],
    field_name: str,
    method: str,
    *,
    default: bool | None = None,
) -> bool:
    if field_name not in result and default is not None:
        return default
    value = result.get(field_name)
    if not isinstance(value, bool):
        raise GatewayProtocolError(method, f"missing or invalid {field_name}")
    return value


class GroupGatewayAdapter:
    """Stable plugin facade over ``tui_gateway.server.dispatch``."""

    def __init__(
        self,
        *,
        dispatcher: Dispatcher | None = None,
        on_event: EventCallback | None = None,
        request_timeout: float = 30.0,
        max_control_frames: int = 128,
        late_response_ttl: float = 30.0,
        max_late_responses: int = 128,
    ) -> None:
        if dispatcher is not None and not callable(dispatcher):
            raise GatewayValidationError("dispatcher must be callable")
        if (
            isinstance(request_timeout, bool)
            or not isinstance(request_timeout, (int, float))
            or not math.isfinite(request_timeout)
            or request_timeout <= 0
        ):
            raise GatewayValidationError("request_timeout must be positive")
        self._dispatcher = _default_dispatcher if dispatcher is None else dispatcher
        self._request_timeout = float(request_timeout)
        self._dispatch_condition = threading.Condition(threading.RLock())
        self._lifecycle_state = "open"
        self._dispatch_inflight = 0
        self._cleanup_timeout = min(self._request_timeout, 5.0)
        self._cleanup_condition = threading.Condition(threading.RLock())
        self._cleanup_queue: deque[tuple[str, int]] = deque()
        self._cleanup_pending: set[str] = set()
        self._cleanup_claimed: set[str] = set()
        self._cleanup_active: str | None = None
        self._adoption_generation = 0
        self._cleanup_closed = False
        self._max_cleanup_queue = max_late_responses
        self.transport = GroupGatewayTransport(
            on_event
            if on_event is not None
            else (lambda _runtime_id, _event_type, _payload: None),
            max_control_frames=max_control_frames,
            late_response_ttl=late_response_ttl,
            max_late_responses=max_late_responses,
        )
        self._cleanup_worker = threading.Thread(
            target=self._late_cleanup_worker,
            name="yaoyao-group-gateway-late-cleanup",
            daemon=True,
        )
        self._cleanup_worker.start()

    def _call_dispatcher(
        self,
        request: dict[str, Any],
        transport: GroupGatewayTransport,
    ) -> dict[str, Any] | None:
        with self._dispatch_condition:
            if self._lifecycle_state != "open":
                raise GatewayTransportClosed("Gateway adapter is shutting down")
            self._dispatch_inflight += 1
        try:
            return self._dispatcher(request, transport)
        finally:
            with self._dispatch_condition:
                self._dispatch_inflight -= 1
                self._dispatch_condition.notify_all()

    def request(
        self,
        method: str,
        params: dict[str, Any],
        timeout: float | None = None,
    ) -> Any:
        method = _nonempty_string(method, "method")
        if not isinstance(params, dict):
            raise GatewayValidationError("params must be an object")
        effective_timeout = self._request_timeout if timeout is None else timeout
        if (
            isinstance(effective_timeout, bool)
            or not isinstance(effective_timeout, (int, float))
            or not math.isfinite(effective_timeout)
            or effective_timeout <= 0
        ):
            raise GatewayValidationError("timeout must be positive")

        try:
            request_params = copy.deepcopy(params)
        except Exception:  # noqa: BLE001 - reject caller objects at the boundary
            raise GatewayValidationError(
                "params must contain copyable values"
            ) from None

        request_id = str(uuid.uuid4())
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": request_params,
        }
        late_context = self._late_session_context(request_id, method, request_params)
        late_callback = (
            partial(self._handle_late_session_response, late_context)
            if late_context is not None
            else None
        )

        waiter = self.transport.register_waiter(
            request_id,
            method=method,
            on_late_response=late_callback,
        )
        try:
            inline_response = self._call_dispatcher(request, self.transport)
        except GatewayTransportClosed:
            self.transport.cancel_waiter(waiter)
            raise
        except Exception as exc:
            self.transport.cancel_waiter(waiter)
            raise GatewayDispatchError(method) from exc

        if inline_response is not None:
            if not isinstance(inline_response, dict):
                self.transport.cancel_waiter(waiter)
                raise GatewayProtocolError(
                    method, "dispatcher returned a non-object response"
                )
            if (
                inline_response.get("jsonrpc") != "2.0"
                or inline_response.get("id") != request_id
                or "method" in inline_response
            ):
                self.transport.cancel_waiter(waiter)
                raise GatewayProtocolError(
                    method, "dispatcher returned an unrelated or invalid response"
                )
            accepted = self.transport.write(inline_response)
            if not accepted:
                # close() has already completed the registered waiter.
                return self._parse_response(
                    self.transport.wait_for_response(
                        waiter,
                        timeout=float(effective_timeout),
                        method=method,
                    ),
                    request_id,
                    method,
                )

        response = self.transport.wait_for_response(
            waiter,
            timeout=float(effective_timeout),
            method=method,
        )
        return self._parse_response(response, request_id, method)

    @staticmethod
    def _parse_response(
        response: dict[str, Any],
        request_id: str,
        method: str,
    ) -> Any:
        if response.get("jsonrpc") != "2.0" or response.get("id") != request_id:
            raise GatewayProtocolError(method, "invalid JSON-RPC response envelope")
        has_result = "result" in response
        has_error = "error" in response
        if has_result == has_error:
            raise GatewayProtocolError(
                method, "response must contain exactly one of result or error"
            )
        if has_error:
            error = response["error"]
            if not isinstance(error, dict):
                raise GatewayProtocolError(method, "invalid JSON-RPC error")
            code = error.get("code")
            message = error.get("message")
            if (
                isinstance(code, bool)
                or not isinstance(code, int)
                or not isinstance(message, str)
            ):
                raise GatewayProtocolError(method, "invalid JSON-RPC error")
            raise GatewayRPCError(method, code, message, error.get("data"))
        return response["result"]

    @staticmethod
    def _result_object(result: Any, method: str) -> dict[str, Any]:
        if not isinstance(result, dict):
            raise GatewayProtocolError(method, "result must be an object")
        return result

    def _late_session_context(
        self,
        request_id: str,
        method: str,
        params: dict[str, Any],
    ) -> _LateSessionContext | None:
        if method not in {"session.create", "session.resume"}:
            return None
        profile = params.get("profile")
        if not isinstance(profile, str) or not profile:
            return None
        requested_stored_id: str | None = None
        if method == "session.resume":
            requested_stored_id = params.get("session_id")
            if not isinstance(requested_stored_id, str) or not requested_stored_id:
                return None
        with self._cleanup_condition:
            adoption_generation = self._adoption_generation
        return _LateSessionContext(
            request_id=request_id,
            method=method,
            profile=profile,
            requested_stored_id=requested_stored_id,
            adoption_generation=adoption_generation,
        )

    def _handle_late_session_response(
        self,
        context: _LateSessionContext,
        tombstone_method: str,
        response: dict[str, Any],
    ) -> None:
        if tombstone_method != context.method:
            return
        # session.resume may legitimately reuse a runtime that another request or
        # device already owns. Its response has no core-authenticated "created"
        # bit, so a timeout can never prove that the returned runtime is an orphan.
        if context.method == "session.resume":
            return
        if (
            response.get("jsonrpc") != "2.0"
            or response.get("id") != context.request_id
            or "method" in response
            or ("result" in response) == ("error" in response)
        ):
            return
        result = response.get("result")
        if not isinstance(result, dict):
            return
        runtime_id = result.get("session_id")
        if not isinstance(runtime_id, str) or not runtime_id:
            return
        info = result.get("info")
        if not isinstance(info, dict):
            return
        profile_name = info.get("profile_name")
        if profile_name != context.profile:
            return
        stored_id = result.get("stored_session_id")
        if not isinstance(stored_id, str) or not stored_id:
            return
        running = result.get("running", False)
        # A running runtime may already be serving another device. Cleanup is
        # deliberately skipped even though that can leave a timed-out create
        # behind; leaking an uncertain orphan is safer than killing active work.
        if not isinstance(running, bool) or running:
            return
        self._schedule_late_cleanup(runtime_id, context.adoption_generation)

    def _schedule_late_cleanup(
        self, runtime_id: str, adoption_generation: int
    ) -> None:
        with self._cleanup_condition:
            if (
                self._cleanup_closed
                or adoption_generation != self._adoption_generation
                or runtime_id in self._cleanup_claimed
                or runtime_id in self._cleanup_pending
                or len(self._cleanup_claimed) >= self._max_cleanup_queue
            ):
                return
            while (
                len(self._cleanup_queue) >= self._max_cleanup_queue
                and not self._cleanup_closed
            ):
                self._cleanup_condition.wait()
            if (
                self._cleanup_closed
                or adoption_generation != self._adoption_generation
                or runtime_id in self._cleanup_claimed
                or runtime_id in self._cleanup_pending
                or len(self._cleanup_claimed) >= self._max_cleanup_queue
            ):
                return
            self._cleanup_pending.add(runtime_id)
            self._cleanup_queue.append((runtime_id, adoption_generation))
            self._cleanup_condition.notify_all()

    def _adopt_runtime(self, runtime_id: str, method: str) -> None:
        """Atomically adopt a runtime or reject one already claimed for cleanup."""

        with self._cleanup_condition:
            if self._cleanup_closed:
                raise GatewayTransportClosed("Gateway adapter is shutting down")
            if runtime_id in self._cleanup_claimed:
                raise GatewayProtocolError(
                    method, "runtime cleanup won the adoption race"
                )
            self._adoption_generation += 1
            queued_runtime_ids = {
                queued_runtime_id for queued_runtime_id, _generation in self._cleanup_queue
            }
            self._cleanup_queue.clear()
            self._cleanup_pending.difference_update(queued_runtime_ids)
            self._cleanup_condition.notify_all()

    def _late_cleanup_worker(self) -> None:
        while True:
            with self._cleanup_condition:
                while not self._cleanup_queue and not self._cleanup_closed:
                    self._cleanup_condition.wait()
                if self._cleanup_closed:
                    return
                runtime_id, adoption_generation = self._cleanup_queue.popleft()
                if (
                    adoption_generation != self._adoption_generation
                    or runtime_id in self._cleanup_claimed
                    or len(self._cleanup_claimed) >= self._max_cleanup_queue
                ):
                    self._cleanup_pending.discard(runtime_id)
                    self._cleanup_condition.notify_all()
                    continue
                # Claimed IDs are terminal for this adapter's lifetime. A core
                # dispatcher can remain blocked for an arbitrary duration, so
                # expiring this proof would allow an ABA adoption of a runtime
                # already handed to session.close. The hard capacity above
                # bounds memory; once full, later orphans are leaked safely.
                self._cleanup_claimed.add(runtime_id)
                self._cleanup_active = runtime_id
                self._cleanup_condition.notify_all()
            try:
                self._best_effort_close_late_session(runtime_id)
            finally:
                with self._cleanup_condition:
                    self._cleanup_active = None
                    self._cleanup_pending.discard(runtime_id)
                    self._cleanup_condition.notify_all()

    def _best_effort_close_late_session(self, runtime_id: str) -> None:
        method = "session.close"
        request_id = str(uuid.uuid4())
        cleanup_transport = GroupGatewayTransport(
            lambda _runtime_id, _event_type, _payload: None,
            max_control_frames=1,
            late_response_ttl=max(self._cleanup_timeout, 0.001),
            max_late_responses=1,
        )
        waiter = cleanup_transport.register_waiter(request_id, method=method)
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": {"session_id": runtime_id},
        }
        try:
            inline_response = self._call_dispatcher(request, cleanup_transport)
            if inline_response is not None:
                if (
                    not isinstance(inline_response, dict)
                    or inline_response.get("jsonrpc") != "2.0"
                    or inline_response.get("id") != request_id
                    or "method" in inline_response
                ):
                    raise GatewayProtocolError(
                        method, "cleanup dispatcher returned an invalid response"
                    )
                cleanup_transport.write(inline_response)
            response = cleanup_transport.wait_for_response(
                waiter,
                timeout=self._cleanup_timeout,
                method=method,
            )
            result = self._result_object(
                self._parse_response(response, request_id, method), method
            )
            _response_bool(result, "closed", method)
        except Exception:  # noqa: BLE001 - cleanup is deliberately best-effort
            logger.warning(
                "Best-effort close of a late YaoYao group session failed",
                exc_info=True,
            )
        finally:
            cleanup_transport.close()

    @staticmethod
    def _cwd(value: str) -> str:
        if not isinstance(value, str):
            raise GatewayValidationError("cwd must be a string")
        if not value.strip():
            return ""
        path = Path(value)
        if not path.is_absolute():
            raise GatewayValidationError(
                "cwd must be empty or an existing absolute directory"
            )
        try:
            resolved = path.resolve(strict=True)
            is_directory = resolved.is_dir()
        except (OSError, RuntimeError, ValueError) as exc:
            raise GatewayValidationError(
                "cwd must be empty or an existing absolute directory"
            ) from exc
        if not is_directory:
            raise GatewayValidationError(
                "cwd must be empty or an existing absolute directory"
            )
        return value

    def create_session(
        self,
        profile: str,
        title: str,
        cwd: str,
        seed_messages: list[dict[str, Any]],
        configuration: dict[str, Any] | None = None,
    ) -> SessionIdentity:
        method = "session.create"
        profile = _nonempty_string(profile, "profile")
        title = _nonempty_string(title, "title")
        if not isinstance(seed_messages, list) or not all(
            isinstance(message, dict) for message in seed_messages
        ):
            raise GatewayValidationError("seed_messages must be a list of objects")
        parameters: dict[str, Any] = {
            "profile": profile,
            "title": title,
            "cwd": self._cwd(cwd),
            "messages": seed_messages,
            "source": "ios_group",
            "close_on_disconnect": False,
        }
        for key in ("model", "provider", "reasoning_effort", "fast"):
            if configuration is not None and configuration.get(key) is not None:
                parameters[key] = configuration[key]
        result = self._result_object(
            self.request(
                method,
                parameters,
            ),
            method,
        )
        runtime_id = _response_string(result, "session_id", method)
        stored_id = _response_string(result, "stored_session_id", method)
        running = _response_bool(result, "running", method, default=False)
        info = result.get("info")
        if not isinstance(info, dict):
            raise GatewayProtocolError(method, "missing or invalid info.profile_name")
        response_profile = info.get("profile_name")
        if not isinstance(response_profile, str) or not response_profile:
            raise GatewayProtocolError(method, "missing or invalid info.profile_name")
        if response_profile != profile:
            raise GatewayProtocolError(method, "profile does not match the request")
        self._adopt_runtime(runtime_id, method)
        return SessionIdentity(stored_id, runtime_id, running)

    def resume_session(self, profile: str, stored_id: str) -> SessionIdentity:
        method = "session.resume"
        profile = _nonempty_string(profile, "profile")
        stored_id = _nonempty_string(stored_id, "stored_id")
        result = self._result_object(
            self.request(
                method,
                {
                    "profile": profile,
                    "session_id": stored_id,
                    "omit_messages": True,
                    "source": "ios_group",
                    "close_on_disconnect": False,
                },
            ),
            method,
        )
        runtime_id = _response_string(result, "session_id", method)
        session_key = result.get("session_key")
        resumed = result.get("resumed")
        if session_key is not None and (
            not isinstance(session_key, str) or not session_key
        ):
            raise GatewayProtocolError(method, "missing or invalid session_key")
        if resumed is not None and (not isinstance(resumed, str) or not resumed):
            raise GatewayProtocolError(method, "missing or invalid resumed")
        if session_key is not None and resumed is not None and session_key != resumed:
            raise GatewayProtocolError(method, "ambiguous stored session identity")
        current_stored_id = session_key or resumed
        if current_stored_id is None:
            raise GatewayProtocolError(method, "missing session_key or resumed")
        running = _response_bool(result, "running", method)
        info = result.get("info")
        if not isinstance(info, dict):
            raise GatewayProtocolError(method, "missing or invalid info.profile_name")
        response_profile = info.get("profile_name")
        if not isinstance(response_profile, str) or not response_profile:
            raise GatewayProtocolError(method, "missing or invalid info.profile_name")
        if response_profile != profile:
            raise GatewayProtocolError(method, "profile does not match the request")
        self._adopt_runtime(runtime_id, method)
        return SessionIdentity(current_stored_id, runtime_id, running)

    def submit_prompt(self, runtime_id: str, text: str) -> None:
        method = "prompt.submit"
        result = self._result_object(
            self.request(
                method,
                {
                    "session_id": _nonempty_string(runtime_id, "runtime_id"),
                    "text": _nonempty_string(text, "text"),
                },
            ),
            method,
        )
        if result.get("status") != "streaming":
            raise GatewayProtocolError(method, "expected streaming status")

    def interrupt_session(self, runtime_id: str) -> None:
        method = "session.interrupt"
        result = self._result_object(
            self.request(
                method, {"session_id": _nonempty_string(runtime_id, "runtime_id")}
            ),
            method,
        )
        if result.get("status") != "interrupted":
            raise GatewayProtocolError(method, "expected interrupted status")

    def interrupt(self, runtime_id: str) -> None:
        self.interrupt_session(runtime_id)

    def close_session(self, runtime_id: str) -> bool:
        method = "session.close"
        result = self._result_object(
            self.request(
                method, {"session_id": _nonempty_string(runtime_id, "runtime_id")}
            ),
            method,
        )
        return _response_bool(result, "closed", method)

    def respond_approval(self, runtime_id: str, choice: str) -> int:
        method = "approval.respond"
        runtime_id = _nonempty_string(runtime_id, "runtime_id")
        choice = _nonempty_string(choice, "choice")
        if choice not in _APPROVAL_CHOICES:
            raise GatewayValidationError(
                "choice must be once, session, always, or deny"
            )
        result = self._result_object(
            self.request(
                method,
                {"session_id": runtime_id, "choice": choice, "all": False},
            ),
            method,
        )
        resolved = result.get("resolved")
        if isinstance(resolved, bool) or not isinstance(resolved, int) or resolved < 0:
            raise GatewayProtocolError(method, "missing or invalid resolved count")
        return resolved

    def respond_clarification(self, request_id: str, answer: str) -> str:
        method = "clarify.respond"
        result = self._result_object(
            self.request(
                method,
                {
                    "request_id": _nonempty_string(request_id, "request_id"),
                    "answer": _nonempty_string(answer, "answer"),
                },
            ),
            method,
        )
        status = result.get("status")
        if status not in {"ok", "expired"}:
            raise GatewayProtocolError(method, "expected ok or expired status")
        return status

    def shutdown(self) -> None:
        with self._dispatch_condition:
            if self._lifecycle_state == "closed":
                return
            if self._lifecycle_state == "closing":
                if threading.current_thread() in {
                    self.transport._worker,
                    self._cleanup_worker,
                }:
                    return
                while self._lifecycle_state != "closed":
                    self._dispatch_condition.wait()
                return
            self._lifecycle_state = "closing"

        with self._cleanup_condition:
            if not self._cleanup_closed:
                self._cleanup_closed = True
                self._cleanup_queue.clear()
                if self._cleanup_active is None:
                    self._cleanup_pending.clear()
                else:
                    self._cleanup_pending.intersection_update(
                        {self._cleanup_active}
                    )
                self._cleanup_condition.notify_all()
        self.transport.close()

        with self._dispatch_condition:
            while self._dispatch_inflight:
                self._dispatch_condition.wait()
        if threading.current_thread() is not self._cleanup_worker:
            self._cleanup_worker.join()
        with self._cleanup_condition:
            self._cleanup_claimed.clear()
            self._cleanup_active = None
        with self._dispatch_condition:
            self._lifecycle_state = "closed"
            self._dispatch_condition.notify_all()

    def close(self, runtime_id: str) -> bool:
        """Close one core session; ``shutdown`` owns transport lifecycle."""

        return self.close_session(runtime_id)


# The shorter name is the stable design-level spelling used by the orchestrator.
GroupTransport = GroupGatewayTransport


__all__ = [
    "GatewayDispatchError",
    "GatewayError",
    "GatewayProtocolError",
    "GatewayRPCError",
    "GatewayTimeoutError",
    "GatewayTransportClosed",
    "GatewayValidationError",
    "GroupGatewayAdapter",
    "GroupGatewayTransport",
    "GroupTransport",
    "MAX_CONTROL_PAYLOAD_BYTES",
    "MAX_DELTA_BUFFER_BYTES",
    "MAX_SAFE_JSON_INTEGER",
    "MAX_TERMINAL_TEXT_BYTES",
    "SessionIdentity",
]
