"""Authenticated, cursor-based event streaming for Yaoyao Group Chat."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Callable, Mapping
from typing import Any
from uuid import UUID

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .group_protocol import MAX_EVENT_BATCH_SIZE, MAX_EVENT_FRAME_BYTES


HEARTBEAT_SECONDS = 20
EVENT_POLL_SECONDS = 0.1
IDLE_POLL_SECONDS = 0.5
PLUGIN_STATE_POLL_SECONDS = 1.0
MAX_CURSOR = 2**63 - 1
FRAME_TOO_LARGE_CLOSE_CODE = 1009
PLUGIN_DISABLED_CLOSE_CODE = 4404

_ASCII_DECIMAL = re.compile(r"[0-9]+", flags=re.ASCII)
_DISCONNECT_RUNTIME_MESSAGES = frozenset(
    {
        'cannot call "receive" once a disconnect message has been received.',
        'cannot call "send" once a close message has been sent.',
        'websocket is not connected. need to call "accept" first.',
    }
)


def websocket_upgrade_allowed(websocket: WebSocket) -> tuple[bool, int]:
    """Apply the core Dashboard WebSocket guards, in their required order."""
    try:
        from hermes_cli import web_server
    except Exception:
        return False, 4401

    try:
        if not web_server._ws_auth_ok(websocket):
            return False, 4401
    except Exception:
        return False, 4401

    try:
        if not web_server._ws_request_is_allowed(websocket):
            return False, 4403
    except Exception:
        return False, 4403
    return True, 1000


def parse_cursor(value: str | None) -> int:
    """Parse an unsigned 63-bit ASCII decimal cursor without coercion."""
    raw = "0" if value is None else value
    if not isinstance(raw, str) or _ASCII_DECIMAL.fullmatch(raw) is None:
        raise ValueError("cursor is malformed")
    cursor = int(raw, 10)
    if cursor > MAX_CURSOR:
        raise ValueError("cursor is out of range")
    return cursor


def _canonical_epoch(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        canonical = str(UUID(value))
    except ValueError:
        return None
    return canonical if value == canonical else None


def _epoch_matches(value: str | None, current_epoch: str) -> bool:
    return _canonical_epoch(value) == current_epoch


async def _store_call(
    store_provider: Callable[[], object],
    method: str,
    *args: object,
) -> Any:
    """Resolve the shared store and perform one complete read off-loop."""

    def invoke() -> Any:
        store = store_provider()
        return getattr(store, method)(*args)

    return await asyncio.to_thread(invoke)


def event_frame(event: Mapping[str, object]) -> dict[str, object]:
    """Project a persisted Store event onto the exact public WS envelope."""
    return {
        "type": "group.event",
        "epoch": event["epoch"],
        "cursor": event["cursor"],
        "roomId": event["roomId"],
        "event": event["eventType"],
        "payload": event["payload"],
    }


def _encode_frame_json(frame: object) -> str:
    """Match Starlette's text-frame JSON encoding for byte-limit checks."""
    return json.dumps(frame, separators=(",", ":"), ensure_ascii=False)


async def _send_json_bounded(
    websocket: WebSocket,
    frame: dict[str, object],
) -> bool:
    """Send one v1 frame, or close without advancing a replay cursor."""
    encoded = _encode_frame_json(frame)
    if len(encoded.encode("utf-8")) > MAX_EVENT_FRAME_BYTES:
        await websocket.close(code=FRAME_TOO_LARGE_CLOSE_CODE)
        return False
    await websocket.send_json(frame)
    return True


def _batch_has_different_epoch(events: object, *, epoch: str) -> bool:
    """Return whether a shaped event belongs to another journal epoch."""
    if not isinstance(events, list):
        return False
    for event in events:
        if not isinstance(event, Mapping):
            continue
        event_epoch = _canonical_epoch(event.get("epoch"))
        if event_epoch is not None and event_epoch != epoch:
            return True
    return False


def _batch_is_contiguous(
    events: object,
    *,
    cursor: int,
    epoch: str,
) -> bool:
    if not isinstance(events, list):
        return False
    expected = cursor + 1
    for event in events:
        if not isinstance(event, Mapping):
            return False
        event_cursor = event.get("cursor")
        if (
            not isinstance(event_cursor, int)
            or isinstance(event_cursor, bool)
            or event_cursor != expected
            or event.get("epoch") != epoch
            or "roomId" not in event
            or not isinstance(event.get("eventType"), str)
            or not isinstance(event.get("payload"), Mapping)
        ):
            return False
        expected += 1
    return True


async def _send_reset(
    websocket: WebSocket,
    store_provider: Callable[[], object],
    *,
    reason: str,
    epoch: str,
    accepted: bool,
) -> None:
    latest_cursor = await _store_call(store_provider, "latest_cursor")
    if not accepted:
        await websocket.accept()
    if not await _send_json_bounded(
        websocket,
        {
            "type": "group.reset_required",
            "reason": reason,
            "epoch": epoch,
            "cursor": latest_cursor,
        },
    ):
        return
    await websocket.close(code=4409)


async def _send_status_reset(
    websocket: WebSocket,
    store_provider: Callable[[], object],
    *,
    status: object,
    current_epoch: str,
    accepted: bool,
) -> None:
    reason = "epoch_mismatch" if status == "epoch_mismatch" else "cursor_expired"
    epoch = current_epoch
    if reason == "epoch_mismatch":
        epoch = await _store_call(store_provider, "journal_epoch")
    await _send_reset(
        websocket,
        store_provider,
        reason=reason,
        epoch=epoch,
        accepted=accepted,
    )


async def _watch_disconnect(websocket: WebSocket) -> None:
    """Wait for peer disconnect without consuming or mutating runtime state."""
    while True:
        message = await websocket.receive()
        if message.get("type") == "websocket.disconnect":
            return


async def _pause_until_poll(
    disconnect_task: asyncio.Task[None], seconds: float
) -> bool:
    done, _ = await asyncio.wait({disconnect_task}, timeout=seconds)
    if disconnect_task not in done:
        return True
    await disconnect_task
    return False


def _is_disconnect_runtime_error(error: RuntimeError) -> bool:
    return str(error).lower() in _DISCONNECT_RUNTIME_MESSAGES


async def _stream_authorized(
    websocket: WebSocket,
    store_provider: Callable[[], object],
    *,
    availability_provider: Callable[[], bool] | None = None,
) -> None:
    if availability_provider is not None and not await asyncio.to_thread(
        availability_provider
    ):
        await websocket.close(code=PLUGIN_DISABLED_CLOSE_CODE)
        return

    current_epoch = await _store_call(store_provider, "journal_epoch")
    requested_epoch = websocket.query_params.get("epoch")
    if not _epoch_matches(requested_epoch, current_epoch):
        await _send_reset(
            websocket,
            store_provider,
            reason="epoch_mismatch",
            epoch=current_epoch,
            accepted=False,
        )
        return

    try:
        cursor = parse_cursor(websocket.query_params.get("cursor"))
    except ValueError:
        await _send_reset(
            websocket,
            store_provider,
            reason="cursor_expired",
            epoch=current_epoch,
            accepted=False,
        )
        return

    status = await _store_call(store_provider, "cursor_status", current_epoch, cursor)
    if status != "ok":
        await _send_status_reset(
            websocket,
            store_provider,
            status=status,
            current_epoch=current_epoch,
            accepted=False,
        )
        return

    await websocket.accept()
    if not await _send_json_bounded(
        websocket,
        {
            "type": "group.ready",
            "epoch": current_epoch,
            "cursor": cursor,
            "heartbeatSeconds": HEARTBEAT_SECONDS,
        },
    ):
        return
    last_activity = time.monotonic()
    last_availability_check = last_activity
    disconnect_task = asyncio.create_task(_watch_disconnect(websocket))
    try:
        while not disconnect_task.done():
            now = time.monotonic()
            if (
                availability_provider is not None
                and now - last_availability_check >= PLUGIN_STATE_POLL_SECONDS
            ):
                if not await asyncio.to_thread(availability_provider):
                    await websocket.close(code=PLUGIN_DISABLED_CLOSE_CODE)
                    return
                last_availability_check = now

            status = await _store_call(
                store_provider, "cursor_status", current_epoch, cursor
            )
            if status != "ok":
                await _send_status_reset(
                    websocket,
                    store_provider,
                    status=status,
                    current_epoch=current_epoch,
                    accepted=True,
                )
                return

            events = await _store_call(
                store_provider,
                "events_after",
                cursor,
                MAX_EVENT_BATCH_SIZE,
            )
            observed_epoch = await _store_call(store_provider, "journal_epoch")
            if observed_epoch != current_epoch or _batch_has_different_epoch(
                events, epoch=current_epoch
            ):
                await _send_reset(
                    websocket,
                    store_provider,
                    reason="epoch_mismatch",
                    epoch=observed_epoch,
                    accepted=True,
                )
                return
            if not _batch_is_contiguous(events, cursor=cursor, epoch=current_epoch):
                await _send_reset(
                    websocket,
                    store_provider,
                    reason="cursor_expired",
                    epoch=current_epoch,
                    accepted=True,
                )
                return

            if disconnect_task.done():
                await disconnect_task
                return

            for event in events:
                next_cursor = int(event["cursor"])
                if not await _send_json_bounded(websocket, event_frame(event)):
                    return
                cursor = next_cursor
                last_activity = time.monotonic()

            now = time.monotonic()
            if not events and now - last_activity >= HEARTBEAT_SECONDS:
                if not await _send_json_bounded(
                    websocket,
                    {"type": "group.heartbeat", "cursor": cursor},
                ):
                    return
                last_activity = time.monotonic()

            delay = EVENT_POLL_SECONDS if events else IDLE_POLL_SECONDS
            if not await _pause_until_poll(disconnect_task, delay):
                return
    finally:
        disconnect_task.cancel()
        try:
            await disconnect_task
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except RuntimeError as error:
            if not _is_disconnect_runtime_error(error):
                raise


async def stream_group_events(
    websocket: WebSocket,
    store_provider: Callable[[], object],
) -> None:
    """Authenticate and stream persisted events without touching Agent runtime."""
    allowed, close_code = websocket_upgrade_allowed(websocket)
    if not allowed:
        await websocket.close(code=close_code)
        return

    await stream_authorized_group_events(websocket, store_provider)


async def stream_authorized_group_events(
    websocket: WebSocket,
    store_provider: Callable[[], object],
    *,
    availability_provider: Callable[[], bool] | None = None,
) -> None:
    """Stream after the caller has consumed auth and request guards exactly once."""

    try:
        await _stream_authorized(
            websocket,
            store_provider,
            availability_provider=availability_provider,
        )
    except WebSocketDisconnect:
        return
    except RuntimeError as error:
        if not _is_disconnect_runtime_error(error):
            raise
