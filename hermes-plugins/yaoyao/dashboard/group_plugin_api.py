"""Authenticated REST adapter for the authoritative Yaoyao Group store."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import inspect
import logging
import os
import re
import sqlite3
import sys
import threading
from collections.abc import Callable
from contextlib import asynccontextmanager
from importlib.machinery import ModuleSpec
from pathlib import Path
from types import ModuleType
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Query, Request, UploadFile, WebSocket
from fastapi import Path as APIPath
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

logger = logging.getLogger(__name__)
_PLUGIN_NAME = "yaoyao"
_agent_name_resolver: Callable[[str], str] = lambda _profile: ""

_MAX_GROUP_UPLOAD_FILES = 8
_MAX_GROUP_UPLOAD_FILE_BYTES = 25 * 1_024 * 1_024
_MAX_GROUP_UPLOAD_REQUEST_BYTES = 50 * 1_024 * 1_024
_GROUP_UPLOAD_CHUNK_BYTES = 1_024 * 1_024

_DASHBOARD_DIR = Path(__file__).resolve().parent
_LOCAL_PACKAGE = (
    "_hermes_yaoyao_group_"
    + hashlib.sha256(str(_DASHBOARD_DIR).encode("utf-8")).hexdigest()[:24]
)


def _log_runtime_failure(message: str, error: BaseException) -> None:
    """Log lifecycle context and type without attacker-controlled exception text."""

    logger.error("%s [errorType=%s]", message, type(error).__name__)


def _plugin_runtime_enabled() -> bool:
    """Mirror the core HTTP plugin gate for the group WebSocket channel."""

    try:
        from hermes_cli import web_server
        from hermes_cli.plugins_cmd import _get_disabled_set, _get_enabled_set

        enabled_set = _get_enabled_set()
        disabled_set = _get_disabled_set()
        plugin = next(
            (
                candidate
                for candidate in web_server._get_dashboard_plugins()
                if candidate.get("name") == _PLUGIN_NAME
            ),
            None,
        )
    except Exception:
        return False

    if plugin is None:
        return False
    source = plugin.get("source")
    if source == "bundled":
        return _PLUGIN_NAME not in disabled_set
    if source == "user":
        return _PLUGIN_NAME in enabled_set and _PLUGIN_NAME not in disabled_set
    return False


def _ensure_local_package() -> ModuleType:
    """Return the stable private package assigned to this resolved directory."""
    package = ModuleType(_LOCAL_PACKAGE)
    package.__package__ = _LOCAL_PACKAGE
    package.__path__ = [str(_DASHBOARD_DIR)]
    package_spec = ModuleSpec(_LOCAL_PACKAGE, loader=None, is_package=True)
    package_spec.submodule_search_locations = [str(_DASHBOARD_DIR)]
    package.__spec__ = package_spec
    shared = sys.modules.setdefault(_LOCAL_PACKAGE, package)
    paths = getattr(shared, "__path__", None)
    if (
        not isinstance(shared, ModuleType)
        or not paths
        or Path(paths[0]).resolve() != _DASHBOARD_DIR
    ):
        raise ImportError("Yaoyao Group private package identity is invalid")
    return shared


_package = _ensure_local_package()
_protocol = importlib.import_module(f"{_LOCAL_PACKAGE}.group_protocol")
_store_module = importlib.import_module(f"{_LOCAL_PACKAGE}.group_store")
_stream_module = importlib.import_module(f"{_LOCAL_PACKAGE}.group_stream")


PROTOCOL_VERSION = _protocol.PROTOCOL_VERSION
EVENT_TYPES = _protocol.EVENT_TYPES
MAX_MESSAGE_PAGE_SIZE = _protocol.MAX_MESSAGE_PAGE_SIZE
limits_payload = _protocol.limits_payload
normalize_interaction_id = _protocol.normalize_interaction_id

AddAgentRequest = _protocol.AddAgentRequest
ApprovalRequest = _protocol.ApprovalRequest
ClarificationRequest = _protocol.ClarificationRequest
CreateRoomRequest = _protocol.CreateRoomRequest
RequestIDRequest = _protocol.RequestIDRequest
SendMessageRequest = _protocol.SendMessageRequest
UpdateAgentRequest = _protocol.UpdateAgentRequest
UpdateRoomRequest = _protocol.UpdateRoomRequest

GroupStore = _store_module.GroupStore
GroupStoreError = _store_module.GroupStoreError
GroupNotFoundError = _store_module.GroupNotFoundError
GroupConflictError = _store_module.GroupConflictError
IdempotencyConflict = _store_module.IdempotencyConflict


class GroupAPIError(RuntimeError):
    """A stable public REST failure independent of internal exception text."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


class RuntimeUnavailableError(GroupAPIError):
    def __init__(self) -> None:
        super().__init__(
            "runtime_unavailable",
            "Group runtime is unavailable",
            503,
        )


class GroupInvalidRequest(GroupAPIError):
    """A trusted Store or protocol input validator rejected the request."""

    def __init__(self, message: str) -> None:
        super().__init__("invalid_request", message, 400)


class GroupStorageAPIError(GroupAPIError):
    """A raw SQLite failure hidden behind the public storage boundary."""

    def __init__(self) -> None:
        super().__init__("storage_error", "Group storage failed", 500)


class GroupInternalAPIError(GroupAPIError):
    """An unexpected implementation failure safe for public serialization."""

    def __init__(self) -> None:
        super().__init__("internal_error", "Internal server error", 500)


def _group_upload_root() -> Path:
    store_path = getattr(_store_instance(), "path", None)
    if not isinstance(store_path, Path):
        raise GroupStorageAPIError()
    return store_path.parent / "group-uploads"


def _safe_upload_name(value: str | None) -> str:
    candidate = (value or "attachment").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join(
        character
        for character in candidate
        if ord(character) >= 32 and ord(character) != 127
    ).strip()[:240]
    return cleaned or "attachment"


def _safe_upload_extension(name: str) -> str:
    suffix = Path(name).suffix.lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,10}", suffix) else ""


async def _persist_group_uploads(
    room_id: str,
    files: list[UploadFile],
    *,
    root: Path | None = None,
) -> list[dict[str, object]]:
    if not files:
        raise GroupInvalidRequest("At least one attachment is required")
    if len(files) > _MAX_GROUP_UPLOAD_FILES:
        raise GroupAPIError(
            "too_many_uploads",
            f"At most {_MAX_GROUP_UPLOAD_FILES} attachments are allowed",
            413,
        )
    upload_root = (root or _group_upload_root()).resolve()
    room_root = upload_root / room_id
    created: list[Path] = []
    temporary: list[Path] = []
    total_bytes = 0
    result: list[dict[str, object]] = []
    try:
        room_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(upload_root, 0o700)
        os.chmod(room_root, 0o700)
        for source in files:
            identifier = str(uuid4())
            name = _safe_upload_name(source.filename)
            destination = room_root / f"{identifier}{_safe_upload_extension(name)}"
            partial = room_root / f".{identifier}.part"
            temporary.append(partial)
            file_bytes = 0
            with partial.open("xb") as output:
                os.chmod(partial, 0o600)
                while True:
                    chunk = await source.read(_GROUP_UPLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    file_bytes += len(chunk)
                    total_bytes += len(chunk)
                    if file_bytes > _MAX_GROUP_UPLOAD_FILE_BYTES:
                        raise GroupAPIError(
                            "upload_too_large",
                            f"{name} exceeds 25 MiB",
                            413,
                        )
                    if total_bytes > _MAX_GROUP_UPLOAD_REQUEST_BYTES:
                        raise GroupAPIError(
                            "upload_request_too_large",
                            "Combined attachments exceed 50 MiB",
                            413,
                        )
                    output.write(chunk)
            partial.replace(destination)
            temporary.remove(partial)
            os.chmod(destination, 0o600)
            created.append(destination)
            media_type = (source.content_type or "application/octet-stream").strip()
            result.append(
                {
                    "id": identifier,
                    "name": name,
                    "path": str(destination),
                    "mimeType": media_type or "application/octet-stream",
                    "size": file_bytes,
                }
            )
        return result
    except GroupAPIError:
        for path in [*temporary, *created]:
            path.unlink(missing_ok=True)
        raise
    except (OSError, ValueError) as error:
        for path in [*temporary, *created]:
            path.unlink(missing_ok=True)
        _log_runtime_failure("Failed to persist a group attachment", error)
        raise GroupStorageAPIError() from error
    finally:
        for source in files:
            await source.close()


def _error_response(error: GroupAPIError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={
            "detail": {
                "code": error.code,
                "message": error.message,
                "details": error.details,
            }
        },
    )


def _validation_details(error: RequestValidationError) -> dict[str, object]:
    errors = [
        {
            "location": list(item.get("loc", ())),
            "message": item.get("msg", "Invalid value"),
            "type": item.get("type", "validation_error"),
        }
        for item in error.errors()
    ]
    return {"errors": errors}


def _public_error(error: Exception) -> GroupAPIError:
    if isinstance(error, GroupAPIError):
        return error
    if isinstance(error, RequestValidationError):
        return GroupAPIError(
            "validation_error",
            "Request validation failed",
            422,
            _validation_details(error),
        )
    if isinstance(error, IdempotencyConflict):
        return GroupAPIError("idempotency_conflict", str(error), 409)
    if isinstance(error, GroupNotFoundError):
        return GroupAPIError("not_found", str(error), 404)
    if isinstance(error, GroupConflictError):
        return GroupAPIError("conflict", str(error), 409)
    if isinstance(error, GroupStoreError):
        return GroupStorageAPIError()
    if isinstance(error, sqlite3.Error):
        return GroupStorageAPIError()
    return GroupInternalAPIError()


class GroupAPIRoute(APIRoute):
    """Apply the plugin error envelope to validation and endpoint failures."""

    def get_route_handler(self) -> Callable[[Request], Any]:
        original = super().get_route_handler()

        async def wrapped(request: Request):
            try:
                return await original(request)
            except Exception as error:
                public = _public_error(error)
                return _error_response(public)

        return wrapped


class _UnavailableRuntime:
    async def wake(self) -> None:
        """A missing orchestrator is harmless until Task 8 binds one."""

    async def create_room(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def update_room(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def archive_room(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def add_agent(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def update_agent(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def delete_agent(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def send_message(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def interrupt_agent(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def respond_approval(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()

    async def respond_clarification(self, **_: object) -> dict[str, object]:
        raise _package._yaoyao_group_runtime_unavailable_error()


def _default_orchestrator_factory(store: object) -> object:
    """Construct the runtime lazily so importing the plugin has no side effects."""

    module = importlib.import_module(f"{_LOCAL_PACKAGE}.group_orchestrator")
    return module.GroupOrchestrator(store, work_enabled=_plugin_runtime_enabled)


class _RuntimeManager:
    """Own exactly one orchestrator for one nested Router lifespan generation."""

    def __init__(self) -> None:
        self._lock: asyncio.Lock | None = None
        self._leases = 0
        self._orchestrator: object | None = None
        self._accepting = False
        self._starting = False
        self._releasing = False
        self._generation = 0
        self._inflight = 0
        self._inflight_zero: asyncio.Event | None = None
        self._start_done: asyncio.Event | None = None
        self._release_done: asyncio.Event | None = None
        self._release_task: asyncio.Task[None] | None = None

    def _current_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def acquire(self) -> None:
        lock = self._current_lock()
        while True:
            async with lock:
                if self._releasing:
                    wait_for = self._release_done
                elif self._starting:
                    wait_for = self._start_done
                elif self._leases:
                    self._leases += 1
                    return
                else:
                    wait_for = None
                    self._generation += 1
                    generation = self._generation
                    self._leases = 1
                    self._starting = True
                    self._accepting = False
                    self._inflight = 0
                    self._inflight_zero = asyncio.Event()
                    self._inflight_zero.set()
                    self._start_done = asyncio.Event()
                    if _package._yaoyao_group_runtime_override:
                        self._starting = False
                        self._accepting = True
                        self._start_done.set()
                        return
            if wait_for is not None:
                await wait_for.wait()
                continue
            break

        orchestrator: object | None = None
        try:
            store = _store_instance()
            factory = _package._yaoyao_group_orchestrator_factory

            def adopt(created: object) -> None:
                nonlocal orchestrator
                orchestrator = created

            await self._run_owned_start_worker(factory, store, adopt=adopt)
            start = getattr(orchestrator, "start")
            await self._run_owned_start(start(), cancel_worker=True)
        except asyncio.CancelledError as start_cancellation:
            cleanup_cancellation: asyncio.CancelledError | None = None
            try:
                await self._cleanup_failed_start(orchestrator)
            except asyncio.CancelledError as error:
                cleanup_cancellation = error
            finally:
                async with lock:
                    if self._generation == generation and self._starting:
                        self._leases = 0
                        self._starting = False
                        self._reset_generation()
                        if self._start_done is not None:
                            self._start_done.set()
                            self._start_done = None
            raise cleanup_cancellation or start_cancellation
        except BaseException as error:  # noqa: BLE001 - isolate plugin startup
            cleanup_cancellation = None
            try:
                await self._cleanup_failed_start(orchestrator)
            except asyncio.CancelledError as cancelled:
                cleanup_cancellation = cancelled
            async with lock:
                _log_runtime_failure("YaoYao group runtime startup failed", error)
                if self._generation == generation and self._starting:
                    if cleanup_cancellation is not None:
                        self._leases = 0
                        self._reset_generation()
                    else:
                        self._starting = False
                    if self._start_done is not None:
                        self._start_done.set()
                        self._start_done = None
            if cleanup_cancellation is not None:
                raise cleanup_cancellation
            return

        async with lock:
            if self._generation != generation or not self._starting:
                await self._cleanup_failed_start(orchestrator)
                return
            self._orchestrator = orchestrator
            with _package._yaoyao_group_store_lock:
                if _package._yaoyao_group_store is store:
                    _package._yaoyao_group_store_ready = True
            _publish_runtime(orchestrator)
            self._starting = False
            self._accepting = True
            if self._start_done is not None:
                self._start_done.set()
                self._start_done = None

    async def release(self) -> None:
        lock = self._current_lock()
        cancellation: asyncio.CancelledError | None = None
        while True:
            try:
                await lock.acquire()
                break
            except asyncio.CancelledError as error:
                if cancellation is None:
                    cancellation = error
                if not self._discard_current_cancellation():
                    raise
        release_task: asyncio.Task[None] | None = None
        try:
            if self._releasing:
                release_task = self._release_task
            elif self._leases:
                self._leases -= 1
                if self._leases == 0:
                    self._releasing = True
                    self._accepting = False
                    self._release_done = asyncio.Event()
                    generation = self._generation
                    orchestrator = self._orchestrator
                    release_done = self._release_done
                    if not _package._yaoyao_group_runtime_override:
                        _publish_runtime(_UnavailableRuntime())
                    release_task = asyncio.create_task(
                        self._release_generation(
                            generation=generation,
                            orchestrator=orchestrator,
                            inflight_zero=self._inflight_zero,
                            release_done=release_done,
                        ),
                        name=f"yaoyao-group-release-{generation}",
                    )
                    self._release_task = release_task
        finally:
            lock.release()
        if release_task is not None:
            try:
                await self._wait_for_owned_task(release_task)
            except BaseException:
                if cancellation is not None:
                    raise cancellation
                raise
        if cancellation is not None:
            raise cancellation

    async def _release_generation(
        self,
        *,
        generation: int,
        orchestrator: object | None,
        inflight_zero: asyncio.Event | None,
        release_done: asyncio.Event,
    ) -> None:
        try:
            await self._wait_for_inflight_release(inflight_zero)
            if orchestrator is not None:
                await self._shutdown_owned_runtime(orchestrator, generation)
        except BaseException as error:  # noqa: BLE001 - host shutdown must continue
            _log_runtime_failure("YaoYao group runtime shutdown failed", error)
        finally:
            await self._finish_owned_release(
                generation=generation,
                orchestrator=orchestrator,
                release_done=release_done,
            )

    @staticmethod
    async def _wait_for_owned_task(task: asyncio.Task[object]) -> object:
        """Return only after a manager-owned task, preserving caller cancellation."""

        cancellation: asyncio.CancelledError | None = None
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError as error:
                if task.done():
                    break
                if cancellation is None:
                    cancellation = error
        try:
            result = task.result()
        except BaseException:
            if cancellation is not None:
                raise cancellation
            raise
        if cancellation is not None:
            raise cancellation
        return result

    @staticmethod
    def _discard_current_cancellation() -> bool:
        """Clear cancellation counts only for cleanup tasks that intentionally persist."""

        task = asyncio.current_task()
        cancelling = getattr(task, "cancelling", None)
        uncancel = getattr(task, "uncancel", None)
        if not callable(cancelling) or not callable(uncancel):
            return False
        had_cancellation = bool(cancelling())
        while cancelling():
            uncancel()
        return had_cancellation

    async def _wait_for_inflight_release(
        self, inflight_zero: asyncio.Event | None
    ) -> None:
        if inflight_zero is None:
            return
        while not inflight_zero.is_set():
            try:
                await inflight_zero.wait()
            except asyncio.CancelledError:
                if not self._discard_current_cancellation():
                    raise

    async def _shutdown_owned_runtime(
        self, orchestrator: object, generation: int
    ) -> None:
        """Shield shutdown from release cancellation, including loop teardown."""

        shutdown_task = asyncio.create_task(
            self._run_owned_shutdown(orchestrator),
            name=f"yaoyao-group-runtime-shutdown-{generation}",
        )
        while not shutdown_task.done():
            try:
                await asyncio.shield(shutdown_task)
            except asyncio.CancelledError:
                self._discard_current_cancellation()
        shutdown_task.result()

    async def _run_owned_shutdown(self, orchestrator: object) -> None:
        while True:
            try:
                await getattr(orchestrator, "shutdown")()
                return
            except asyncio.CancelledError:
                if not self._discard_current_cancellation():
                    raise

    async def _finish_owned_release(
        self,
        *,
        generation: int,
        orchestrator: object | None,
        release_done: asyncio.Event,
    ) -> None:
        lock = self._current_lock()
        while True:
            try:
                await lock.acquire()
                break
            except asyncio.CancelledError:
                if not self._discard_current_cancellation():
                    raise
        try:
            if (
                self._generation == generation
                and self._orchestrator is orchestrator
                and self._releasing
            ):
                self._orchestrator = None
                self._releasing = False
                self._inflight = 0
                self._inflight_zero = None
                self._release_task = None
                self._reset_generation()
            if self._release_done is release_done:
                self._release_done = None
        finally:
            release_done.set()
            lock.release()

    async def dispatch(self, method: str, **kwargs: object) -> object:
        """Lease one published runtime through the complete request callback."""

        runtime = await self._begin_operation(require_runtime=True)

        async def invoke() -> object:
            callback = getattr(runtime, method)
            is_async = inspect.iscoroutinefunction(
                callback
            ) or inspect.iscoroutinefunction(getattr(callback, "__call__", None))
            if is_async:
                result = callback(**kwargs)
            else:
                result = await asyncio.to_thread(callback, **kwargs)
            if inspect.isawaitable(result):
                return await result
            return result

        return await self._run_owned_operation(
            invoke(), name=f"yaoyao-group-dispatch-{method}"
        )

    async def dispatch_store(
        self,
        method: str,
        *args: object,
        **kwargs: object,
    ) -> object:
        """Lease the complete blocking Store read through its worker return."""

        await self._begin_operation(require_runtime=False)
        return await self._run_owned_operation(
            asyncio.to_thread(_invoke_store, method, *args, **kwargs),
            name=f"yaoyao-group-store-{method}",
        )

    async def _begin_operation(self, *, require_runtime: bool) -> object | None:
        lock = self._current_lock()
        async with lock:
            override = bool(_package._yaoyao_group_runtime_override)
            if self._starting or self._releasing or not self._accepting:
                raise _package._yaoyao_group_runtime_unavailable_error()
            runtime = _package._yaoyao_group_runtime if override else self._orchestrator
            if require_runtime and (
                runtime is None or isinstance(runtime, _UnavailableRuntime)
            ):
                raise _package._yaoyao_group_runtime_unavailable_error()
            self._inflight += 1
            if self._inflight_zero is None:
                self._inflight_zero = asyncio.Event()
            self._inflight_zero.clear()
            return runtime

    async def _run_owned_operation(self, operation: object, *, name: str) -> object:
        if not inspect.isawaitable(operation):
            raise TypeError("leased operation must be awaitable")
        owned_task = asyncio.create_task(operation, name=name)

        def finished(done: asyncio.Task[object]) -> None:
            try:
                if not done.cancelled():
                    done.exception()
            except asyncio.CancelledError:
                pass
            self._inflight -= 1
            if self._inflight == 0 and self._inflight_zero is not None:
                self._inflight_zero.set()

        owned_task.add_done_callback(finished)
        return await asyncio.shield(owned_task)

    async def stream_store(
        self, websocket: WebSocket, stream: Callable[..., object]
    ) -> object:
        """Lease a complete stream; closing invalidates its Store provider."""

        await self._begin_operation(require_runtime=False)
        generation = self._generation

        async def invoke() -> object:
            try:
                result = stream(
                    websocket, lambda: self.store_for_generation(generation)
                )
                if inspect.isawaitable(result):
                    return await result
                return result
            except RuntimeUnavailableError:
                await websocket.close(code=1013, reason="Group runtime is unavailable")
                return None

        return await self._run_owned_operation(
            invoke(), name=f"yaoyao-group-stream-{generation}"
        )

    def store_for_generation(self, generation: int) -> object:
        """Resolve Store only while a WebSocket still belongs to this generation."""

        if (
            generation != self._generation
            or self._starting
            or self._releasing
            or not self._accepting
        ):
            raise _package._yaoyao_group_runtime_unavailable_error()
        return _initialized_store()

    @staticmethod
    async def _cleanup_failed_start(orchestrator: object | None) -> None:
        if orchestrator is None:
            return
        try:
            await _RuntimeManager._run_owned_start(getattr(orchestrator, "shutdown")())
        except asyncio.CancelledError:
            raise
        except BaseException as error:  # noqa: BLE001 - preserve startup isolation
            _log_runtime_failure("YaoYao group partial runtime cleanup failed", error)

    @staticmethod
    async def _run_owned_start(
        operation: object, *, cancel_worker: bool = False
    ) -> object:
        """Wait out caller cancellation before relinquishing startup ownership."""

        if not inspect.isawaitable(operation):
            raise TypeError("runtime start must be awaitable")
        worker = asyncio.create_task(operation, name="yaoyao-group-runtime-start")
        cancellation: asyncio.CancelledError | None = None
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError as error:
                if cancellation is None:
                    cancellation = error
                    if cancel_worker:
                        worker.cancel()
        try:
            result = worker.result()
        except BaseException:
            if cancellation is not None:
                raise cancellation
            raise
        if cancellation is not None:
            raise cancellation
        return result

    @staticmethod
    async def _run_owned_start_worker(
        callback: Callable[..., object],
        *args: object,
        adopt: Callable[[object], None],
    ) -> object:
        worker = asyncio.create_task(
            asyncio.to_thread(callback, *args),
            name="yaoyao-group-runtime-create",
        )
        cancellation: asyncio.CancelledError | None = None
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError as error:
                if cancellation is None:
                    cancellation = error
        try:
            result = worker.result()
        except BaseException:
            if cancellation is not None:
                raise cancellation
            raise
        adopt(result)
        if cancellation is not None:
            raise cancellation
        return result

    def _reset_generation(self) -> None:
        self._accepting = False
        self._starting = False
        if not _package._yaoyao_group_store_override:
            with _package._yaoyao_group_store_lock:
                _package._yaoyao_group_store = None
                _package._yaoyao_group_store_ready = False


@asynccontextmanager
async def _router_lifespan(_: object):
    manager = _package._yaoyao_group_runtime_manager
    await manager.acquire()
    try:
        yield
    finally:
        await manager.release()


_bootstrap_lock = vars(_package).setdefault(
    "_yaoyao_group_bootstrap_lock", threading.RLock()
)
with _bootstrap_lock:
    if not hasattr(_package, "_yaoyao_group_store_lock"):
        _package._yaoyao_group_runtime_unavailable_error = RuntimeUnavailableError
        _package._yaoyao_group_store_lock = threading.Lock()
        _package._yaoyao_group_store = None
        _package._yaoyao_group_store_ready = False
        _package._yaoyao_group_store_override = False
        _package._yaoyao_group_runtime = _UnavailableRuntime()
        _package._yaoyao_group_runtime_override = False
        _package._yaoyao_group_orchestrator_factory = _default_orchestrator_factory
        _package._yaoyao_group_runtime_manager = _RuntimeManager()


def set_store_for_testing(store: object | None) -> None:
    """Inject an isolated store; initialization remains lazy and off-loop."""
    with _package._yaoyao_group_store_lock:
        _package._yaoyao_group_store = store
        _package._yaoyao_group_store_ready = False
        _package._yaoyao_group_store_override = store is not None


def set_agent_name_resolver(resolver: Callable[[str], str]) -> None:
    """Use the plugin's existing per-profile agentName setting."""
    global _agent_name_resolver
    _agent_name_resolver = resolver


def set_runtime_facade(runtime: object | None) -> None:
    """Bind the narrow Task-8 runtime surface, or restore the safe default."""
    _package._yaoyao_group_runtime_override = runtime is not None
    _publish_runtime(_UnavailableRuntime() if runtime is None else runtime)
    manager = _package._yaoyao_group_runtime_manager
    if runtime is None:
        manager._accepting = False
    elif not manager._starting and not manager._releasing:
        manager._accepting = True


def set_orchestrator_factory_for_testing(
    factory: Callable[[object], object] | None,
) -> None:
    """Inject construction without importing the real Gateway runtime."""

    _package._yaoyao_group_orchestrator_factory = (
        _default_orchestrator_factory if factory is None else factory
    )


def _publish_runtime(runtime: object) -> None:
    _package._yaoyao_group_runtime = runtime


def _store_instance() -> object:
    with _package._yaoyao_group_store_lock:
        if _package._yaoyao_group_store is None:
            _package._yaoyao_group_store = GroupStore.from_environment(
                agent_name_resolver=_agent_name_resolver
            )
        return _package._yaoyao_group_store


def _initialized_store() -> object:
    with _package._yaoyao_group_store_lock:
        if _package._yaoyao_group_store is None:
            _package._yaoyao_group_store = GroupStore.from_environment(
                agent_name_resolver=_agent_name_resolver
            )
        store = _package._yaoyao_group_store
        if not _package._yaoyao_group_store_ready:
            store.initialize()
            _package._yaoyao_group_store_ready = True
        return store


def _invoke_store(method: str, *args: object, **kwargs: object) -> object:
    """Run one trusted Store operation and classify only its input failures."""
    try:
        store = _initialized_store()
    except sqlite3.Error as error:
        raise GroupStorageAPIError() from error
    try:
        return getattr(store, method)(*args, **kwargs)
    except ValueError as error:
        raise GroupInvalidRequest(str(error)) from error
    except sqlite3.Error as error:
        raise GroupStorageAPIError() from error


async def _store_call(method: str, *args: object, **kwargs: object) -> object:
    return await _package._yaoyao_group_runtime_manager.dispatch_store(
        method, *args, **kwargs
    )


async def _runtime_call(method: str, **kwargs: object) -> object:
    return await _package._yaoyao_group_runtime_manager.dispatch(method, **kwargs)


def _command(model: object, *, exclude_unset: bool = False) -> dict[str, object]:
    return model.model_dump(
        mode="json",
        by_alias=True,
        exclude_unset=exclude_unset,
    )


def _create_room_command(request: CreateRoomRequest) -> dict[str, object]:
    command = _command(request)
    if "max_reply_rounds" not in request.model_fields_set:
        command.pop("maxReplyRounds", None)
    agents = command.get("agents")
    if isinstance(agents, list):
        for seed, item in zip(request.agents, agents):
            if (
                isinstance(item, dict)
                and "reply_without_mention" not in seed.model_fields_set
            ):
                item.pop("replyWithoutMention", None)
            if isinstance(item, dict) and "is_host" not in seed.model_fields_set:
                item.pop("isHost", None)
            if isinstance(item, dict):
                for field, alias in (
                    ("model", "model"),
                    ("provider", "provider"),
                    ("reasoning_effort", "reasoningEffort"),
                    ("fast_mode", "fastMode"),
                ):
                    if field not in seed.model_fields_set:
                        item.pop(alias, None)
    return command


def _add_agent_command(request: AddAgentRequest) -> dict[str, object]:
    command = _command(request)
    if "reply_without_mention" not in request.model_fields_set:
        command.pop("replyWithoutMention", None)
    if "is_host" not in request.model_fields_set:
        command.pop("isHost", None)
    for field, alias in (
        ("model", "model"),
        ("provider", "provider"),
        ("reasoning_effort", "reasoningEffort"),
        ("fast_mode", "fastMode"),
    ):
        if field not in request.model_fields_set:
            command.pop(alias, None)
    return command


def _validated_interaction_id(value: str) -> str:
    try:
        return normalize_interaction_id(value)
    except ValueError as error:
        raise GroupInvalidRequest(str(error)) from error


async def capabilities() -> dict[str, object]:
    journal_epoch = await _store_call("journal_epoch")
    latest_cursor = await _store_call("latest_cursor")
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "journalEpoch": journal_epoch,
        "latestCursor": latest_cursor,
        "limits": limits_payload(),
        "eventTypes": sorted(EVENT_TYPES),
    }


async def list_rooms(
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=4096),
) -> dict[str, object]:
    page = await _store_call("list_rooms", limit=limit, cursor=cursor)
    return {"items": page.items, "nextCursor": page.next_cursor}


async def list_topics(
    room_id: UUID,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=4096),
) -> dict[str, object]:
    page = await _store_call(
        "list_topics", str(room_id), limit=limit, cursor=cursor
    )
    return {"items": page.items, "nextCursor": page.next_cursor}


async def create_room(request: CreateRoomRequest) -> dict[str, object]:
    return await _runtime_call("create_room", command=_create_room_command(request))


async def get_room(room_id: UUID) -> dict[str, object]:
    return await _store_call("room_snapshot", str(room_id))


async def update_room(room_id: UUID, request: UpdateRoomRequest) -> dict[str, object]:
    return await _runtime_call(
        "update_room",
        room_id=str(room_id),
        command=_command(request, exclude_unset=True),
    )


async def archive_room(room_id: UUID, request: RequestIDRequest) -> dict[str, object]:
    return await _runtime_call(
        "archive_room",
        room_id=str(room_id),
        request_id=str(request.request_id),
    )


async def add_agent(room_id: UUID, request: AddAgentRequest) -> dict[str, object]:
    return await _runtime_call(
        "add_agent", room_id=str(room_id), command=_add_agent_command(request)
    )


async def update_agent(
    room_id: UUID,
    agent_id: UUID,
    request: UpdateAgentRequest,
) -> dict[str, object]:
    return await _runtime_call(
        "update_agent",
        room_id=str(room_id),
        agent_id=str(agent_id),
        command=_command(request, exclude_unset=True),
    )


async def delete_agent(
    room_id: UUID,
    agent_id: UUID,
    request: RequestIDRequest,
) -> dict[str, object]:
    return await _runtime_call(
        "delete_agent",
        room_id=str(room_id),
        agent_id=str(agent_id),
        request_id=str(request.request_id),
    )


async def interrupt_agent(
    room_id: UUID,
    agent_id: UUID,
    request: RequestIDRequest,
) -> object:
    return await _runtime_call(
        "interrupt_agent",
        room_id=str(room_id),
        agent_id=str(agent_id),
        request_id=str(request.request_id),
    )


async def list_messages(
    room_id: UUID,
    topic_id: UUID | None = Query(default=None, alias="topicId"),
    before_seq: int | None = Query(default=None, alias="beforeSeq", ge=1),
    after_seq: int | None = Query(default=None, alias="afterSeq", ge=1),
    limit: int = Query(default=MAX_MESSAGE_PAGE_SIZE, ge=1, le=MAX_MESSAGE_PAGE_SIZE),
) -> dict[str, object]:
    items = await _store_call(
        "list_messages",
        str(room_id),
        topic_id=None if topic_id is None else str(topic_id),
        before_seq=before_seq,
        after_seq=after_seq,
        limit=limit,
    )
    return {"items": items}


async def upload_group_files(
    room_id: UUID,
    files: Annotated[list[UploadFile], File(alias="file")],
) -> dict[str, object]:
    canonical_room_id = str(room_id)
    await _store_call("room_snapshot", canonical_room_id)
    return {
        "files": await _persist_group_uploads(canonical_room_id, files),
    }


async def send_message(room_id: UUID, request: SendMessageRequest) -> dict[str, object]:
    return await _runtime_call(
        "send_message",
        room_id=str(room_id),
        request_id=str(request.request_id),
        client_message_id=str(request.client_message_id),
        topic_id=None if request.topic_id is None else str(request.topic_id),
        content=request.content,
        mention_agent_ids=[str(agent_id) for agent_id in request.mention_agent_ids],
    )


async def respond_approval(
    room_id: UUID,
    request: ApprovalRequest,
    interaction_id: str = APIPath(min_length=1, max_length=200),
) -> object:
    canonical_interaction_id = _validated_interaction_id(interaction_id)
    return await _runtime_call(
        "respond_approval",
        room_id=str(room_id),
        interaction_id=canonical_interaction_id,
        request_id=str(request.request_id),
        choice=request.choice,
        permanent=request.permanent,
    )


async def respond_clarification(
    room_id: UUID,
    request: ClarificationRequest,
    interaction_id: str = APIPath(min_length=1, max_length=200),
) -> object:
    canonical_interaction_id = _validated_interaction_id(interaction_id)
    return await _runtime_call(
        "respond_clarification",
        room_id=str(room_id),
        interaction_id=canonical_interaction_id,
        request_id=str(request.request_id),
        response=request.response,
    )


async def stream_events(websocket: WebSocket) -> None:
    """Delegate the read-only event channel to the authenticated streamer."""
    allowed, close_code = _stream_module.websocket_upgrade_allowed(websocket)
    if not allowed:
        await websocket.close(code=close_code)
        return
    if not await asyncio.to_thread(_plugin_runtime_enabled):
        await websocket.close(code=_stream_module.PLUGIN_DISABLED_CLOSE_CODE)
        return

    async def stream_authorized(
        websocket: WebSocket, store_provider: Callable[[], object]
    ) -> None:
        await _stream_module.stream_authorized_group_events(
            websocket,
            store_provider,
            availability_provider=_plugin_runtime_enabled,
        )

    try:
        manager = _package._yaoyao_group_runtime_manager
        await manager.stream_store(websocket, stream_authorized)
    except RuntimeUnavailableError:
        await websocket.close(code=1013, reason="Group runtime is unavailable")


def _build_router() -> APIRouter:
    """Build the immutable route table once per resolved plugin directory."""
    built = APIRouter(
        prefix="/v1",
        tags=["yaoyao-group"],
        route_class=GroupAPIRoute,
        lifespan=_router_lifespan,
    )
    built.add_api_route("/capabilities", capabilities, methods=["GET"])
    built.add_api_route("/rooms", list_rooms, methods=["GET"])
    built.add_api_route("/rooms", create_room, methods=["POST"])
    built.add_api_route("/rooms/{room_id}", get_room, methods=["GET"])
    built.add_api_route("/rooms/{room_id}", update_room, methods=["PATCH"])
    built.add_api_route("/rooms/{room_id}", archive_room, methods=["DELETE"])
    built.add_api_route("/rooms/{room_id}/agents", add_agent, methods=["POST"])
    built.add_api_route(
        "/rooms/{room_id}/agents/{agent_id}", update_agent, methods=["PATCH"]
    )
    built.add_api_route(
        "/rooms/{room_id}/agents/{agent_id}", delete_agent, methods=["DELETE"]
    )
    built.add_api_route(
        "/rooms/{room_id}/agents/{agent_id}/interrupt",
        interrupt_agent,
        methods=["POST"],
    )
    built.add_api_route("/rooms/{room_id}/topics", list_topics, methods=["GET"])
    built.add_api_route(
        "/rooms/{room_id}/uploads", upload_group_files, methods=["POST"]
    )
    built.add_api_route("/rooms/{room_id}/messages", list_messages, methods=["GET"])
    built.add_api_route("/rooms/{room_id}/messages", send_message, methods=["POST"])
    built.add_api_route(
        "/rooms/{room_id}/interactions/{interaction_id}/approval",
        respond_approval,
        methods=["POST"],
    )
    built.add_api_route(
        "/rooms/{room_id}/interactions/{interaction_id}/clarification",
        respond_clarification,
        methods=["POST"],
    )
    built.add_api_websocket_route("/events", stream_events)
    return built


with _bootstrap_lock:
    router = getattr(_package, "_yaoyao_group_router", None)
    if router is None:
        router = _build_router()
        _package._yaoyao_group_router = router
