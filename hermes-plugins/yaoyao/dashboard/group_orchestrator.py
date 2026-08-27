"""Async scheduler for durable YaoYao group Agent runs.

The store is the concurrency authority.  This module only owns process-local
Gateway generations and moves every blocking SQLite/Gateway call off the
Dashboard event loop.
"""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
import json
import logging
import math
import re
import threading
import uuid
from typing import Any, Awaitable, Callable, Mapping, Protocol

from .group_gateway import SessionIdentity
from .group_remote_gateway import GroupGatewayRouter
from .group_protocol import MAX_MESSAGE_BYTES, MAX_TOOL_STATE_BYTES


logger = logging.getLogger(__name__)

DEFAULT_EVENT_QUEUE_SIZE = 256
DEFAULT_COMPLETION_TIMEOUT = 15 * 60.0
STREAM_FLUSH_INTERVAL = 0.05
_ERROR_TEXT_LIMIT = 4096
_TOOL_VALUE_LIMIT = 16 * 1024
_TOOL_TEXT_LIMIT = 4096
_TOOL_FINDING_LIMIT = 32
_TOOL_COUNT_LIMIT = 128
_TOOL_TRUNCATION_ID = "__hermes_group_tool_state_truncated__"
_TOOL_STATE_INTERNAL_LIMIT = min(MAX_TOOL_STATE_BYTES, 192 * 1024)
_PERSISTED_EVENTS = frozenset(
    {
        "message.start",
        "message.delta",
        "message.complete",
        "reasoning.delta",
        "tool.start",
        "tool.complete",
        "tool.output_risk",
        "approval.request",
        "clarify.request",
        "clarify.expire",
        "session.info",
        "error",
    }
)
_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "interrupted"})
_APPROVAL_CHOICES = frozenset({"once", "session", "always", "deny"})
_STORE_RETRY_DELAYS = (0.01, 0.02, 0.04)
_CLAIM_RETRY_MAX_SECONDS = 1.0
_WORK_DISABLED_RETRY_SECONDS = 1.0
_NO_REPLY_TOKEN = "[[YAOYAO_NO_REPLY_V1]]"
_NO_REPLY_RESERVED_PATTERN = re.compile(r"\[\[YAOYAO_[A-Z0-9_]*(?:\]\])?")
_HOST_FALLBACK_REPLY = (
    "我还不能确定你希望我处理什么，请补充具体目标、范围，或明确需要我协调的 Agent。"
)


def _is_no_reply_content(value: object) -> bool:
    return isinstance(value, str) and value.strip() == _NO_REPLY_TOKEN


def _sanitize_no_reply_text(value: str) -> str:
    return _NO_REPLY_RESERVED_PATTERN.sub("", value)


def _log_failure_type(message: str, error: BaseException) -> None:
    """Log stable context without persisting Gateway or Store exception text."""

    logger.error("%s [errorType=%s]", message, type(error).__name__)


class GroupOrchestratorError(RuntimeError):
    """Raised for an invalid scheduler lifecycle or local runtime collision."""


class _Store(Protocol):
    def initialize(self) -> None: ...

    def recover_after_restart(self) -> list[str]: ...

    def claim_next_runnable_run(self) -> dict[str, object] | None: ...

    def read_run_projection(self, run_id: str) -> dict[str, object]: ...

    def prepare_run_session_configuration(
        self, run_id: str, configuration: Mapping[str, object]
    ) -> bool: ...

    def bind_run_runtime(
        self, run_id: str, runtime_session_id: str
    ) -> dict[str, object]: ...

    def commit_prompt_submission(
        self, run_id: str, **kwargs: object
    ) -> dict[str, object]: ...

    def upsert_agent_message(
        self, run_id: str, **kwargs: object
    ) -> dict[str, object]: ...

    def settle_run(self, run_id: str, **kwargs: object) -> dict[str, object]: ...

    def transition_run(
        self, run_id: str, status: str, **kwargs: object
    ) -> dict[str, object]: ...

    def get_run(self, run_id: str) -> dict[str, object]: ...

    def get_message(self, message_id: str) -> dict[str, object]: ...

    def get_room(self, room_id: str) -> dict[str, object]: ...

    def get_interaction(self, interaction_id: str) -> dict[str, object]: ...

    def list_pending_cascades(self, **kwargs: object) -> dict[str, object]: ...

    def complete_cascade(self, source_run_id: str) -> dict[str, object]: ...

    def interrupt_agent_with_runtime_targets(
        self, room_id: str, agent_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def archive_room_with_runtime_targets(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def restore_room(self, room_id: str, command: Mapping[str, object]) -> dict[str, object]: ...

    def archive_topic(
        self, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def restore_topic(
        self, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def create_room(self, command: Mapping[str, object]) -> dict[str, object]: ...

    def update_room(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def update_topic(
        self, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def mark_topic_read(
        self, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def add_agent(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]: ...

    def update_agent_with_runtime_targets(
        self,
        room_id: str,
        agent_id: str,
        command: Mapping[str, object],
    ) -> dict[str, object]: ...

    def delete_agent_with_runtime_targets(
        self,
        room_id: str,
        agent_id: str,
        command: Mapping[str, object],
    ) -> dict[str, object]: ...

    def create_human_message(
        self,
        room_id: str,
        *,
        request_id: str,
        client_message_id: str,
        content: str,
        mention_agent_ids: list[str],
        topic_id: str | None = None,
    ) -> dict[str, object]: ...

    def create_gateway_interaction(
        self, run_id: str, **kwargs: object
    ) -> dict[str, object]: ...

    def expire_interaction(self, interaction_id: str) -> dict[str, object]: ...

    def begin_interaction_response(
        self, room_id: str, interaction_id: str, **kwargs: object
    ) -> dict[str, object]: ...

    def finish_interaction_response(
        self, request_id: str, **kwargs: object
    ) -> dict[str, object]: ...

    def fail_interaction_response(
        self, request_id: str, **kwargs: object
    ) -> dict[str, object]: ...


class _Gateway(Protocol):
    transport: Any

    def create_session(
        self,
        profile: str,
        title: str,
        cwd: str,
        seed_messages: list[dict[str, Any]],
        configuration: dict[str, Any] | None = None,
    ) -> SessionIdentity: ...

    def resume_session(self, profile: str, stored_id: str) -> SessionIdentity: ...

    def submit_prompt(self, runtime_id: str, text: str) -> None: ...

    def interrupt(self, runtime_id: str) -> None: ...

    def close(self, runtime_id: str) -> bool: ...

    def respond_approval(self, runtime_id: str, choice: str) -> int: ...

    def respond_clarification(self, request_id: str, answer: str) -> str: ...

    def shutdown(self) -> None: ...


GatewayFactory = Callable[[Callable[[str, str, dict[str, object]], None]], _Gateway]


@dataclass(frozen=True)
class _GatewayEvent:
    runtime_id: str
    generation: int
    event_type: str
    payload: dict[str, object]


@dataclass
class _RuntimeState:
    run_id: str
    room_id: str
    topic_id: str
    agent_id: str
    runtime_id: str
    generation: int
    expected_stored_id: str | None
    session_stored_id: str
    expected_context_seq: int
    through_seq: int
    profile: str = ""
    reply_mode: str = "mentioned"
    required_reply: bool = False
    automatic_published: bool = False
    had_visible_interaction: bool = False
    prompt_ready: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    terminal_info_received: asyncio.Event = field(default_factory=asyncio.Event)
    finalize_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    mutation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pending_events: asyncio.Queue[_GatewayEvent | None] = field(
        default_factory=lambda: asyncio.Queue(maxsize=64)
    )
    event_task: asyncio.Task[None] | None = None
    grace_task: asyncio.Task[None] | None = None
    inflight_calls: set[asyncio.Task[object]] = field(default_factory=set)
    mutation_tasks: set[asyncio.Task[dict[str, object]]] = field(default_factory=set)
    content: str = ""
    reasoning: str = ""
    tool_state: list[dict[str, object]] = field(default_factory=list)
    tool_indexes: dict[str, int] = field(default_factory=dict)
    clarification_ids: dict[str, str] = field(default_factory=dict)
    pending_interaction_ids: set[str] = field(default_factory=set)
    stream_dirty: bool = False
    last_stream_flush: float = 0.0
    approval_ordinal: int = 0
    complete_seen: bool = False
    complete_index: int = 0
    event_index: int = 0
    terminal_status: str | None = None
    terminal_error: str = ""
    actual_model: str | None = None
    actual_provider: str | None = None
    actual_reasoning_effort: str | None = None
    actual_fast_mode: bool | None = None
    settle_error: BaseException | None = None
    prompt_committed: bool = False
    overflowed: bool = False
    finalizing: bool = False


@dataclass
class _AgentLockState:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0


def _required_mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise GroupOrchestratorError(f"{field_name} must be an object")
    return value


def _required_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise GroupOrchestratorError(f"{field_name} must be a non-empty string")
    return value


def _required_string_allowing_empty(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise GroupOrchestratorError(f"{field_name} must be a string")
    return value


def _optional_string(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _required_string(value, field_name)


def _required_nonnegative_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GroupOrchestratorError(f"{field_name} must be a non-negative integer")
    return value


def _required_bool(value: object, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise GroupOrchestratorError(f"{field_name} must be a boolean")
    return value


def _strict_json_copy(value: object, field_name: str) -> object:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        encoded.encode("utf-8")
        return json.loads(encoded)
    except (TypeError, ValueError, UnicodeEncodeError, json.JSONDecodeError) as error:
        raise GroupOrchestratorError(f"{field_name} must be strict JSON") from error


def build_run_prompt(
    projection: Mapping[str, object],
    room_agents: list[Mapping[str, object]] | None = None,
) -> str:
    """Build a deterministic prompt from the Store's bounded projection."""

    run = _required_mapping(projection.get("run"), "projection.run")
    room = _required_mapping(projection.get("room"), "projection.room")
    agent = _required_mapping(projection.get("agent"), "projection.agent")
    messages = projection.get("messages")
    if not isinstance(messages, list) or not all(
        isinstance(message, Mapping) for message in messages
    ):
        raise GroupOrchestratorError("projection.messages must be a list of objects")
    envelope = {
        "agent": {
            "displayName": _required_string(
                agent.get("displayName"), "projection.agent.displayName"
            ),
            "id": _required_string(agent.get("id"), "projection.agent.id"),
            "description": _required_string_allowing_empty(
                agent.get("description", ""), "projection.agent.description"
            ),
            "isHost": _required_bool(
                agent.get("isHost", False), "projection.agent.isHost"
            ),
        },
        "messages": _strict_json_copy(messages, "projection.messages"),
        "omittedSummary": _strict_json_copy(
            projection.get("omittedSummary"), "projection.omittedSummary"
        ),
        "room": {
            "id": _required_string(room.get("id"), "projection.room.id"),
            "name": _required_string(room.get("name"), "projection.room.name"),
            "instructions": _required_string_allowing_empty(
                room.get("instructions", ""), "projection.room.instructions"
            ),
            "maxReplyRounds": room.get("maxReplyRounds", 3),
            "orchestrationMode": _required_string(
                room.get("orchestrationMode", "free"),
                "projection.room.orchestrationMode",
            ),
        },
        "run": {
            "id": _required_string(run.get("id"), "projection.run.id"),
            "topicId": _required_string(
                run.get("topicId"), "projection.run.topicId"
            ),
            "rootMessageId": _required_string(
                run.get("rootMessageId"), "projection.run.rootMessageId"
            ),
            "triggerMessageId": _required_string(
                run.get("triggerMessageId"), "projection.run.triggerMessageId"
            ),
            "replyMode": _required_string(
                run.get("replyMode", "mentioned"), "projection.run.replyMode"
            ),
            "requiredReply": _required_bool(
                run.get("requiredReply", False), "projection.run.requiredReply"
            ),
        },
        "throughSeq": _required_nonnegative_int(
            projection.get("throughSeq"), "projection.throughSeq"
        ),
        "version": 1,
    }
    members: list[dict[str, str]] = []
    for candidate in room_agents or []:
        if candidate.get("enabled") is not True:
            continue
        members.append(
            {
                "displayName": _required_string(
                    candidate.get("displayName"), "roomAgent.displayName"
                ),
                "id": _required_string(candidate.get("id"), "roomAgent.id"),
            }
        )
    members.sort(key=lambda item: (item["displayName"].casefold(), item["id"]))
    envelope["roomAgents"] = members
    encoded = json.dumps(
        envelope,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    automatic_rule = ""
    host_flow = envelope["room"]["orchestrationMode"] == "host"
    if envelope["run"]["requiredReply"] and host_flow:
        automatic_rule = (
            "你持有本话题当前唯一发言令牌，必须公开处理。请根据最新上下文动态决定下一步："
            "有依赖关系时只 @下一位成员；任务相互独立时可以同时使用多个精确 @显示名 或 @all，"
            "系统会并列执行并在整批结束后统一交还给你复核；"
            "若任务已经完成，直接给出最终答复且不要 @任何成员；也可以发起澄清请求。"
            "禁止保持静默，禁止输出任何 YAOYAO_NO_REPLY 标记。"
        )
    elif envelope["run"]["requiredReply"]:
        automatic_rule = (
            "你是本房间唯一管理员。该用户消息没有有效 @，你必须公开处理；"
            "禁止保持静默，禁止输出任何 YAOYAO_NO_REPLY 标记。必须三选一："
            "直接回答；使用成员列表中的精确 @显示名 转派；或发起澄清请求。"
        )
    elif envelope["run"]["replyMode"] == "automatic":
        automatic_rule = (
            f"若触发内容与自己的职责无关，禁止调用工具、禁止@成员，且完整答复只能是"
            f"{_NO_REPLY_TOKEN}；正常答复绝不能包含该标记。"
        )
    elif host_flow and not envelope["agent"]["isHost"]:
        automatic_rule = (
            "你正在执行管理员委派的当前步骤。只回答本步骤，不要 @任何成员；"
            "完成后系统会把结果交还管理员复核并决定下一步。"
        )
    collaboration_rule = (
        "管理员协调中只有管理员可以调度成员；成员可以按依赖串行，也可以成批并列执行。"
        if host_flow
        else "仅在确实需要成员协作时，使用成员列表中的精确 @显示名 或 @all 发起下一轮。"
    )
    instructions_rule = (
        "GROUP_CONTEXT_JSON.room.instructions 是本房间的长期说明、协作规则和形式准则；"
        "必须在本次答复和工具使用中遵守。\n"
        if envelope["room"]["instructions"]
        else ""
    )
    return (
        "你正在 Hermes 多设备群聊中回复。只输出要发送到公共房间的答复；"
        f"{collaboration_rule}\n"
        f"{instructions_rule}"
        f"{automatic_rule}\n"
        f"runId={envelope['run']['id']} roomId={envelope['room']['id']} "
        f"agentId={envelope['agent']['id']}\n"
        f"GROUP_CONTEXT_JSON={encoded}"
    )


class GroupOrchestrator:
    """Drive Store-claimed runs through one process-local Gateway adapter."""

    def __init__(
        self,
        store: _Store,
        *,
        gateway_factory: GatewayFactory | None = None,
        work_enabled: Callable[[], bool] | None = None,
        event_queue_size: int = DEFAULT_EVENT_QUEUE_SIZE,
        completion_timeout: float = DEFAULT_COMPLETION_TIMEOUT,
    ) -> None:
        if (
            isinstance(event_queue_size, bool)
            or not isinstance(event_queue_size, int)
            or event_queue_size < 1
        ):
            raise ValueError("event_queue_size must be a positive integer")
        if (
            isinstance(completion_timeout, bool)
            or not isinstance(completion_timeout, (int, float))
            or not math.isfinite(completion_timeout)
            or completion_timeout <= 0
        ):
            raise ValueError("completion_timeout must be positive")
        self.store = store
        self._gateway_factory: GatewayFactory = (
            gateway_factory
            if gateway_factory is not None
            else lambda callback: GroupGatewayRouter(callback)
        )
        if work_enabled is not None and not callable(work_enabled):
            raise ValueError("work_enabled must be callable")
        self._work_enabled = work_enabled if work_enabled is not None else lambda: True
        self._event_queue_size = event_queue_size
        self._completion_timeout = float(completion_timeout)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread_id: int | None = None
        self._gateway: _Gateway | None = None
        self._event_queue: asyncio.Queue[_GatewayEvent | None] | None = None
        self._event_task: asyncio.Task[None] | None = None
        self._scheduler_task: asyncio.Task[None] | None = None
        self._run_tasks: set[asyncio.Task[None]] = set()
        self._control_tasks: set[asyncio.Task[dict[str, object]]] = set()
        self._wake_event: asyncio.Event | None = None
        self._shutdown_event: asyncio.Event | None = None
        self._shutdown_complete: asyncio.Event | None = None
        self._shutdown_error: BaseException | None = None
        self._durable_failures: list[GroupOrchestratorError] = []
        self._run_failures: list[BaseException] = []
        self._failure_lock = threading.Lock()
        self._lifecycle_lock: asyncio.Lock | None = None
        self._started = False
        self._closing = False
        self._scheduler_busy = False
        self._mapping_lock = threading.RLock()
        self._runtime_states: dict[str, tuple[int, _RuntimeState]] = {}
        self._next_generation = 0
        self._agent_locks: dict[str, _AgentLockState] = {}
        self._submission_locks: dict[str, _AgentLockState] = {}
        self._room_locks: dict[str, _AgentLockState] = {}

    @property
    def event_queue_capacity(self) -> int:
        return self._event_queue_size

    @property
    def active_run_count(self) -> int:
        return len(self._run_tasks)

    async def start(self) -> None:
        """Initialize/recover durable state before exposing any scheduler work."""

        if self._lifecycle_lock is None:
            self._lifecycle_lock = asyncio.Lock()
        async with self._lifecycle_lock:
            if self._started:
                return
            if self._closing:
                raise GroupOrchestratorError("Orchestrator is shutting down")
            self._loop = asyncio.get_running_loop()
            self._loop_thread_id = threading.get_ident()
            try:
                await self._run_owned_start_worker(
                    self.store.initialize,
                    task_name="yaoyao-group-store-initialize",
                )
                await self._run_owned_start_worker(
                    self.store.recover_after_restart,
                    task_name="yaoyao-group-store-recover",
                )
                self._event_queue = asyncio.Queue(maxsize=self._event_queue_size)
                self._wake_event = asyncio.Event()
                self._shutdown_event = asyncio.Event()
                self._shutdown_complete = asyncio.Event()
                self._shutdown_error = None
                self._durable_failures = []
                self._run_failures = []
                await self._run_owned_start_worker(
                    self._gateway_factory,
                    self._gateway_event_callback,
                    task_name="yaoyao-group-gateway-create",
                    adopt=lambda gateway: setattr(self, "_gateway", gateway),
                )
                self._event_task = asyncio.create_task(
                    self._consume_events(), name="yaoyao-group-events"
                )
                await asyncio.sleep(0)
                self._scheduler_task = asyncio.create_task(
                    self._scheduler(), name="yaoyao-group-scheduler"
                )
                await asyncio.sleep(0)
                self._started = True
                self.wake()
            except BaseException:
                await self._rollback_failed_start()
                raise

    async def _run_owned_start_worker(
        self,
        callback: Callable[..., object],
        *args: object,
        task_name: str,
        adopt: Callable[[object], None] | None = None,
    ) -> object:
        """Wait out cancellation so a startup worker cannot outlive ownership."""

        worker = asyncio.get_running_loop().create_task(
            asyncio.to_thread(callback, *args), name=task_name
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
        if adopt is not None:
            adopt(result)
        if cancellation is not None:
            raise cancellation
        return result

    async def _rollback_failed_start(self) -> None:
        """Reverse a partial start without invoking normal settlement paths."""

        for task in (self._scheduler_task, self._event_task):
            if task is not None and not task.done():
                task.cancel()
        tasks = tuple(
            task
            for task in (self._scheduler_task, self._event_task)
            if task is not None
        )
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        gateway = self._gateway
        if gateway is not None:
            drain: Callable[[float | None], object] | None = None
            try:
                transport = getattr(gateway, "transport", None)
                candidate = getattr(transport, "drain", None)
                if callable(candidate):
                    drain = candidate
            except BaseException as error:  # noqa: BLE001 - shutdown still runs
                _log_failure_type("Failed to inspect a partial Gateway startup", error)
            if callable(drain):
                try:
                    await self._run_owned_start_worker(
                        drain,
                        None,
                        task_name="yaoyao-group-gateway-rollback-drain",
                    )
                except BaseException as error:  # noqa: BLE001 - keep primary
                    _log_failure_type(
                        "Failed to drain a partial Gateway startup", error
                    )
            try:
                await self._run_owned_start_worker(
                    gateway.shutdown,
                    task_name="yaoyao-group-gateway-rollback-shutdown",
                )
            except BaseException as error:  # noqa: BLE001 - preserve primary
                _log_failure_type(
                    "Failed to roll back YaoYao group Gateway startup", error
                )
        self._started = False
        self._gateway = None
        self._event_task = None
        self._scheduler_task = None
        self._event_queue = None
        self._wake_event = None
        self._shutdown_event = None
        self._shutdown_complete = None
        self._loop = None
        self._loop_thread_id = None

    def wake(self) -> None:
        """Idempotently signal that queued durable work may now be runnable."""

        loop = self._loop
        wake_event = self._wake_event
        if loop is None or wake_event is None or self._closing:
            return
        if threading.get_ident() == self._loop_thread_id:
            wake_event.set()
            return
        try:
            loop.call_soon_threadsafe(wake_event.set)
        except RuntimeError:
            return

    async def drain_once(self, *, timeout: float = 5.0) -> None:
        """Wake the scheduler and wait until its current durable work is idle."""

        if not self._started:
            raise GroupOrchestratorError("Orchestrator is not started")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.wake()

        async def wait_idle() -> None:
            while True:
                wake_event = self._wake_event
                event_queue = self._event_queue
                if (
                    wake_event is not None
                    and event_queue is not None
                    and not wake_event.is_set()
                    and not self._scheduler_busy
                    and not self._run_tasks
                    and event_queue.empty()
                ):
                    return
                await asyncio.sleep(0.001)

        await asyncio.wait_for(wait_idle(), timeout=timeout)

    async def _tracked_control(
        self,
        operation: Callable[[], Awaitable[dict[str, object]]],
        *,
        task_name: str,
        failure_message: str,
    ) -> dict[str, object]:
        """Shield one accepted mutation and expose it to orderly shutdown."""

        if not self._started or self._closing:
            raise GroupOrchestratorError("Orchestrator is not accepting controls")
        task = asyncio.create_task(operation(), name=task_name)
        self._control_tasks.add(task)

        def finished(done: asyncio.Task[dict[str, object]]) -> None:
            self._control_tasks.discard(done)
            if done.cancelled():
                return
            try:
                error = done.exception()
            except asyncio.CancelledError:
                return
            if error is not None:
                _log_failure_type(failure_message, error)

        task.add_done_callback(finished)
        return await asyncio.shield(task)

    @staticmethod
    def _public_command(value: Mapping[str, object]) -> dict[str, object]:
        command = _strict_json_copy(value, "command")
        if not isinstance(command, dict):
            raise GroupOrchestratorError("command must be an object")
        _required_string(command.get("requestId"), "command.requestId")
        return command

    async def create_room(self, *, command: Mapping[str, object]) -> dict[str, object]:
        safe_command = self._public_command(command)
        request_id = str(safe_command["requestId"])
        return await self._tracked_control(
            lambda: self._create_room(safe_command),
            task_name=f"yaoyao-group-create-room-{request_id}",
            failure_message="YaoYao group room creation failed",
        )

    async def _create_room(self, command: Mapping[str, object]) -> dict[str, object]:
        result = await asyncio.to_thread(self.store.create_room, command)
        if not isinstance(result, Mapping):
            raise GroupOrchestratorError("Created room is invalid")
        self.wake()
        return dict(result)

    async def update_room(
        self, *, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        safe_command = self._public_command(command)
        request_id = str(safe_command["requestId"])
        return await self._tracked_control(
            lambda: self._update_room(room_id, safe_command),
            task_name=f"yaoyao-group-update-room-{request_id}",
            failure_message="YaoYao group room update failed",
        )

    async def _update_room(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        async with self._room_serial(room_id):
            result = await asyncio.to_thread(self.store.update_room, room_id, command)
            if not isinstance(result, Mapping):
                raise GroupOrchestratorError("Updated room is invalid")
            self.wake()
            return dict(result)

    async def update_topic(
        self, *, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(topic_id, "topicId")
        safe_command = self._public_command(command)
        request_id = str(safe_command["requestId"])
        return await self._tracked_control(
            lambda: self._update_topic(room_id, topic_id, safe_command),
            task_name=f"yaoyao-group-update-topic-{request_id}",
            failure_message="YaoYao group topic update failed",
        )

    async def _update_topic(
        self, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        async with self._room_serial(room_id):
            result = await asyncio.to_thread(
                self.store.update_topic, room_id, topic_id, command
            )
            if not isinstance(result, Mapping):
                raise GroupOrchestratorError("Updated topic is invalid")
            self.wake()
            return dict(result)

    async def archive_topic(
        self, *, room_id: str, topic_id: str, request_id: str
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(topic_id, "topicId")
        _required_string(request_id, "requestId")
        return await self._tracked_control(
            lambda: self._archive_topic(room_id, topic_id, request_id),
            task_name=f"yaoyao-group-archive-topic-{request_id}",
            failure_message="YaoYao group topic archive failed",
        )

    async def _archive_topic(
        self, room_id: str, topic_id: str, request_id: str
    ) -> dict[str, object]:
        async with self._room_serial(room_id):
            with self._mapping_lock:
                states = sorted(
                    (state for _generation, state in self._runtime_states.values()
                     if state.room_id == room_id and state.topic_id == topic_id),
                    key=lambda state: (state.agent_id, state.runtime_id, state.generation),
                )
            async with AsyncExitStack() as stack:
                for state in states:
                    await stack.enter_async_context(self._submission_serial(state.agent_id))
                    await stack.enter_async_context(state.mutation_lock)
                current_states = self._current_owned_states(states)
                envelope = await self._run_states_blocking(
                    current_states, self.store.archive_topic, room_id, topic_id,
                    {"requestId": request_id},
                )
                if not isinstance(envelope, Mapping):
                    raise GroupOrchestratorError("Archived topic is invalid")
                result = dict(envelope)
                if result.get("id") != topic_id or result.get("archived") is not True:
                    raise GroupOrchestratorError("Archived topic identity changed")
                self.wake()
                cleanup_errors = await self._cleanup_lifecycle_targets_locked(
                    current_states, tuple(), room_id=room_id, topic_id=topic_id,
                )
                if cleanup_errors:
                    raise GroupOrchestratorError(
                        "Topic was archived durably, but Gateway cleanup failed: "
                        + "; ".join(cleanup_errors)
                    )
                return result

    async def restore_topic(
        self, *, room_id: str, topic_id: str, request_id: str
    ) -> dict[str, object]:
        return await self._topic_lifecycle(
            room_id, topic_id, request_id, self.store.restore_topic, "restore"
        )

    async def restore_room(
        self, *, room_id: str, request_id: str
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(request_id, "requestId")
        async with self._room_serial(room_id):
            result = await asyncio.to_thread(
                self.store.restore_room, room_id, {"requestId": request_id}
            )
            if not isinstance(result, Mapping):
                raise GroupOrchestratorError("Restored room is invalid")
            self.wake()
            return dict(result)

    async def _topic_lifecycle(
        self, room_id: str, topic_id: str, request_id: str,
        function: Callable[..., object], label: str,
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(topic_id, "topicId")
        _required_string(request_id, "requestId")
        async with self._room_serial(room_id):
            result = await asyncio.to_thread(
                function, room_id, topic_id, {"requestId": request_id}
            )
            if not isinstance(result, Mapping):
                raise GroupOrchestratorError(f"{label.title()}d topic is invalid")
            self.wake()
            return dict(result)

    async def mark_topic_read(
        self, *, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(topic_id, "topicId")
        safe_command = self._public_command(command)
        request_id = str(safe_command["requestId"])
        return await self._tracked_control(
            lambda: self._mark_topic_read(room_id, topic_id, safe_command),
            task_name=f"yaoyao-group-mark-topic-read-{request_id}",
            failure_message="YaoYao group topic read update failed",
        )

    async def _mark_topic_read(
        self, room_id: str, topic_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        async with self._room_serial(room_id):
            result = await asyncio.to_thread(
                self.store.mark_topic_read, room_id, topic_id, command
            )
            if not isinstance(result, Mapping):
                raise GroupOrchestratorError("Topic read response is invalid")
            self.wake()
            return dict(result)

    async def add_agent(
        self, *, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        safe_command = self._public_command(command)
        request_id = str(safe_command["requestId"])
        return await self._tracked_control(
            lambda: self._add_agent(room_id, safe_command),
            task_name=f"yaoyao-group-add-agent-{request_id}",
            failure_message="YaoYao group Agent creation failed",
        )

    async def _add_agent(
        self, room_id: str, command: Mapping[str, object]
    ) -> dict[str, object]:
        async with self._room_serial(room_id):
            result = await asyncio.to_thread(self.store.add_agent, room_id, command)
            if not isinstance(result, Mapping):
                raise GroupOrchestratorError("Created Agent is invalid")
            self.wake()
            return dict(result)

    async def update_agent(
        self,
        *,
        room_id: str,
        agent_id: str,
        command: Mapping[str, object],
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(agent_id, "agentId")
        safe_command = self._public_command(command)
        request_id = str(safe_command["requestId"])
        return await self._tracked_control(
            lambda: self._mutate_agent(
                room_id=room_id,
                agent_id=agent_id,
                command=safe_command,
                operation="update",
            ),
            task_name=f"yaoyao-group-update-agent-{request_id}",
            failure_message="YaoYao group Agent update failed",
        )

    async def delete_agent(
        self,
        *,
        room_id: str,
        agent_id: str,
        request_id: str,
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(agent_id, "agentId")
        _required_string(request_id, "requestId")
        return await self._tracked_control(
            lambda: self._mutate_agent(
                room_id=room_id,
                agent_id=agent_id,
                command={"requestId": request_id},
                operation="delete",
            ),
            task_name=f"yaoyao-group-delete-agent-{request_id}",
            failure_message="YaoYao group Agent deletion failed",
        )

    async def _mutate_agent(
        self,
        *,
        room_id: str,
        agent_id: str,
        command: Mapping[str, object],
        operation: str,
    ) -> dict[str, object]:
        if operation == "update":
            store_method = self.store.update_agent_with_runtime_targets
        elif operation == "delete":
            store_method = self.store.delete_agent_with_runtime_targets
        else:
            raise GroupOrchestratorError("Unknown Agent mutation")
        async with self._room_serial(room_id):
            async with AsyncExitStack() as stack:
                await stack.enter_async_context(self._submission_serial(agent_id))
                with self._mapping_lock:
                    states = sorted(
                        (
                            state
                            for _generation, state in self._runtime_states.values()
                            if state.room_id == room_id and state.agent_id == agent_id
                        ),
                        key=lambda state: (state.runtime_id, state.generation),
                    )
                for state in states:
                    await stack.enter_async_context(state.mutation_lock)
                current_states = self._current_owned_states(states)
                envelope = await self._run_states_blocking(
                    current_states,
                    store_method,
                    room_id,
                    agent_id,
                    command,
                )
                result, runtime_ids = self._validated_lifecycle_envelope(
                    envelope, f"agent.{operation}"
                )
                if result.get("id") != agent_id or result.get("roomId") != room_id:
                    raise GroupOrchestratorError("Mutated Agent identity changed")
                if operation == "update":
                    requested_enabled = command.get("enabled")
                    if "enabled" in command and (
                        not isinstance(requested_enabled, bool)
                        or result.get("enabled") is not requested_enabled
                    ):
                        raise GroupOrchestratorError(
                            "Updated Agent enabled state changed"
                        )
                    if requested_enabled is not False and runtime_ids:
                        raise GroupOrchestratorError(
                            "Non-disabling Agent update returned runtime targets"
                        )
                self.wake()
                cleanup_errors = await self._cleanup_lifecycle_targets_locked(
                    current_states,
                    runtime_ids,
                    room_id=room_id,
                    agent_id=agent_id,
                )
                if cleanup_errors:
                    raise GroupOrchestratorError(
                        "Agent changed durably, but Gateway cleanup failed: "
                        + "; ".join(cleanup_errors)
                    )
                return result

    async def send_message(
        self,
        *,
        room_id: str,
        request_id: str,
        client_message_id: str,
        content: str,
        mention_agent_ids: list[str],
        topic_id: str | None = None,
    ) -> dict[str, object]:
        _required_string(room_id, "roomId")
        _required_string(request_id, "requestId")
        _required_string(client_message_id, "clientMessageId")
        if not isinstance(content, str):
            raise GroupOrchestratorError("content must be a string")
        if not isinstance(mention_agent_ids, list):
            raise GroupOrchestratorError("mentionAgentIds must be a list")
        if topic_id is not None:
            _required_string(topic_id, "topicId")
        safe_mentions = [
            _required_string(item, "mentionAgentIds") for item in mention_agent_ids
        ]
        return await self._tracked_control(
            lambda: self._send_message(
                room_id=room_id,
                request_id=request_id,
                client_message_id=client_message_id,
                content=content,
                mention_agent_ids=safe_mentions,
                topic_id=topic_id,
            ),
            task_name=f"yaoyao-group-send-{request_id}",
            failure_message="YaoYao group message submission failed",
        )

    async def _send_message(
        self,
        *,
        room_id: str,
        request_id: str,
        client_message_id: str,
        content: str,
        mention_agent_ids: list[str],
        topic_id: str | None,
    ) -> dict[str, object]:
        async with self._room_serial(room_id):
            async with AsyncExitStack() as stack:
                for agent_id in sorted(set(mention_agent_ids)):
                    await stack.enter_async_context(self._submission_serial(agent_id))
                result = await asyncio.to_thread(
                    self.store.create_human_message,
                    room_id,
                    request_id=request_id,
                    client_message_id=client_message_id,
                    content=content,
                    mention_agent_ids=mention_agent_ids,
                    topic_id=topic_id,
                )
                if not isinstance(result, Mapping):
                    raise GroupOrchestratorError("Created message is invalid")
            self.wake()
            return dict(result)

    async def interrupt_agent(
        self,
        *,
        room_id: str,
        agent_id: str,
        request_id: str,
    ) -> dict[str, object]:
        """Durably interrupt one Agent, then clean only owned Gateway generations."""

        _required_string(room_id, "roomId")
        _required_string(agent_id, "agentId")
        _required_string(request_id, "requestId")
        if not self._started or self._closing:
            raise GroupOrchestratorError("Orchestrator is not accepting controls")
        task = asyncio.create_task(
            self._interrupt_agent(
                room_id=room_id,
                agent_id=agent_id,
                request_id=request_id,
            ),
            name=f"yaoyao-group-interrupt-{request_id}",
        )
        self._control_tasks.add(task)

        def finished(done: asyncio.Task[dict[str, object]]) -> None:
            self._control_tasks.discard(done)
            if done.cancelled():
                return
            try:
                error = done.exception()
            except asyncio.CancelledError:
                return
            if error is not None:
                _log_failure_type("YaoYao group Agent interrupt failed", error)

        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def archive_room(
        self,
        *,
        room_id: str,
        request_id: str,
    ) -> dict[str, object]:
        """Archive one room durably before cleaning its owned runtimes."""

        _required_string(room_id, "roomId")
        _required_string(request_id, "requestId")
        return await self._tracked_control(
            lambda: self._archive_room(room_id=room_id, request_id=request_id),
            task_name=f"yaoyao-group-archive-{request_id}",
            failure_message="YaoYao group room archive failed",
        )

    async def _archive_room(
        self,
        *,
        room_id: str,
        request_id: str,
    ) -> dict[str, object]:
        async with self._room_serial(room_id):
            room = await asyncio.to_thread(
                self.store.get_room, room_id, include_archived=True
            )
            agents = room.get("agents") if isinstance(room, Mapping) else None
            if not isinstance(agents, list):
                raise GroupOrchestratorError("room.agents must be a list")
            agent_ids = sorted(
                {
                    _required_string(
                        agent.get("id") if isinstance(agent, Mapping) else None,
                        "room.agent.id",
                    )
                    for agent in agents
                }
            )
            async with AsyncExitStack() as stack:
                for agent_id in agent_ids:
                    await stack.enter_async_context(self._submission_serial(agent_id))
                with self._mapping_lock:
                    states = sorted(
                        (
                            state
                            for _generation, state in self._runtime_states.values()
                            if state.room_id == room_id
                        ),
                        key=lambda state: (
                            state.agent_id,
                            state.runtime_id,
                            state.generation,
                        ),
                    )
                for state in states:
                    await stack.enter_async_context(state.mutation_lock)
                current_states = self._current_owned_states(states)
                envelope = await self._run_states_blocking(
                    current_states,
                    self.store.archive_room_with_runtime_targets,
                    room_id,
                    {"requestId": request_id},
                )
                result, runtime_ids = self._validated_lifecycle_envelope(
                    envelope, "archive"
                )
                if result.get("id") != room_id or result.get("archived") is not True:
                    raise GroupOrchestratorError("Archived room identity changed")
                self.wake()
                cleanup_errors = await self._cleanup_lifecycle_targets_locked(
                    current_states,
                    runtime_ids,
                    room_id=room_id,
                )
                if cleanup_errors:
                    raise GroupOrchestratorError(
                        "Room was archived durably, but Gateway cleanup failed: "
                        + "; ".join(cleanup_errors)
                    )
                return result

    def _current_owned_states(self, states: list[_RuntimeState]) -> list[_RuntimeState]:
        current_states: list[_RuntimeState] = []
        with self._mapping_lock:
            for state in states:
                if self._runtime_states.get(state.runtime_id) == (
                    state.generation,
                    state,
                ):
                    current_states.append(state)
        return current_states

    @staticmethod
    def _validated_lifecycle_envelope(
        value: object, field_name: str
    ) -> tuple[dict[str, object], tuple[str, ...]]:
        envelope = _required_mapping(value, field_name)
        result = _required_mapping(envelope.get("result"), f"{field_name}.result")
        raw_runtime_ids = envelope.get("runtimeSessionIds")
        if not isinstance(raw_runtime_ids, list) or len(raw_runtime_ids) > 8:
            raise GroupOrchestratorError(
                f"{field_name}.runtimeSessionIds must be a bounded list"
            )
        runtime_ids = tuple(
            _required_string(item, f"{field_name}.runtimeSessionIds")
            for item in raw_runtime_ids
        )
        if len(set(runtime_ids)) != len(runtime_ids):
            raise GroupOrchestratorError(
                f"{field_name}.runtimeSessionIds contains duplicates"
            )
        return dict(result), runtime_ids

    async def _cleanup_lifecycle_targets_locked(
        self,
        states: list[_RuntimeState],
        runtime_ids: tuple[str, ...],
        *,
        room_id: str,
        agent_id: str | None = None,
        topic_id: str | None = None,
    ) -> list[str]:
        owned = {
            state.runtime_id: state
            for state in states
            if state.room_id == room_id
            and (agent_id is None or state.agent_id == agent_id)
            and (topic_id is None or state.topic_id == topic_id)
        }
        cleanup_errors: list[str] = []
        replay_runtime_ids = set(runtime_ids)
        ordered_runtime_ids = list(runtime_ids)
        ordered_runtime_ids.extend(
            runtime_id
            for runtime_id in sorted(owned)
            if runtime_id not in replay_runtime_ids
        )
        for runtime_id in ordered_runtime_ids:
            state = owned.get(runtime_id)
            if state is None:
                continue
            with self._mapping_lock:
                current = self._runtime_states.get(runtime_id)
            if current != (state.generation, state):
                continue
            try:
                durable_run = await self._run_state_blocking(
                    state, self.store.get_run, state.run_id
                )
            except Exception:  # noqa: BLE001 - never clean an unverified owner
                cleanup_errors.append(f"verify {runtime_id}")
                continue
            if (
                not isinstance(durable_run, Mapping)
                or durable_run.get("status") not in _TERMINAL_RUN_STATUSES
                or durable_run.get("runtimeSessionId") is not None
            ):
                # The idempotency replay may name a runtime id that has since
                # been reused by a newer generation.  Never clean that owner.
                continue
            error = await self._close_durably_interrupted_state_locked(state)
            if error:
                cleanup_errors.append(error)
        return cleanup_errors

    async def _interrupt_agent(
        self,
        *,
        room_id: str,
        agent_id: str,
        request_id: str,
    ) -> dict[str, object]:
        async with self._submission_serial(agent_id):
            with self._mapping_lock:
                states = sorted(
                    (
                        state
                        for _generation, state in self._runtime_states.values()
                        if state.room_id == room_id and state.agent_id == agent_id
                    ),
                    key=lambda state: (state.runtime_id, state.generation),
                )
            async with AsyncExitStack() as stack:
                for state in states:
                    await stack.enter_async_context(state.mutation_lock)
                current_states: list[_RuntimeState] = []
                with self._mapping_lock:
                    for state in states:
                        if self._runtime_states.get(state.runtime_id) == (
                            state.generation,
                            state,
                        ):
                            current_states.append(state)
                if any(
                    state.finalizing and state.settle_error is not None
                    for state in current_states
                ):
                    raise GroupOrchestratorError("Agent runtime is already finalizing")
                envelope = await self._run_states_blocking(
                    current_states,
                    self.store.interrupt_agent_with_runtime_targets,
                    room_id,
                    agent_id,
                    {"requestId": request_id},
                )
                result, run_ids, runtime_ids = self._validated_interrupt_envelope(
                    envelope,
                    room_id=room_id,
                    agent_id=agent_id,
                )
                cleanup_errors: list[str] = []
                for runtime_id in runtime_ids:
                    with self._mapping_lock:
                        current = self._runtime_states.get(runtime_id)
                    if current is None:
                        continue
                    generation, state = current
                    if (
                        state not in current_states
                        or generation != state.generation
                        or state.room_id != room_id
                        or state.agent_id != agent_id
                        or state.run_id not in run_ids
                    ):
                        # A replayed target must never affect a reused runtime id.
                        continue
                    error = await self._close_durably_interrupted_state_locked(state)
                    if error:
                        cleanup_errors.append(error)
                if cleanup_errors:
                    raise GroupOrchestratorError(
                        "Agent was interrupted durably, but Gateway cleanup failed: "
                        + "; ".join(cleanup_errors)
                    )
                return result

    @staticmethod
    def _validated_interrupt_envelope(
        value: object,
        *,
        room_id: str,
        agent_id: str,
    ) -> tuple[dict[str, object], set[str], tuple[str, ...]]:
        envelope = _required_mapping(value, "interrupt")
        result_value = _required_mapping(envelope.get("result"), "interrupt.result")
        if (
            result_value.get("roomId") != room_id
            or result_value.get("agentId") != agent_id
        ):
            raise GroupOrchestratorError("Interrupt scope changed")

        def string_list(raw: object, field_name: str) -> tuple[str, ...]:
            if not isinstance(raw, list) or len(raw) > 8:
                raise GroupOrchestratorError(f"{field_name} must be a bounded list")
            values = tuple(_required_string(item, field_name) for item in raw)
            if len(set(values)) != len(values):
                raise GroupOrchestratorError(f"{field_name} contains duplicates")
            return values

        run_ids = string_list(
            result_value.get("interruptedRunIds"),
            "interrupt.result.interruptedRunIds",
        )
        runtime_ids = string_list(
            envelope.get("runtimeSessionIds"),
            "interrupt.runtimeSessionIds",
        )
        return dict(result_value), set(run_ids), runtime_ids

    async def _close_durably_interrupted_state_locked(
        self, state: _RuntimeState
    ) -> str | None:
        async with state.finalize_lock:
            with self._mapping_lock:
                current = self._runtime_states.get(state.runtime_id)
            if current != (state.generation, state):
                return None
            state.finalizing = True
            failures: list[str] = []
            gateway = self._required_gateway()
            try:
                await self._run_state_blocking(
                    state, gateway.interrupt, state.runtime_id
                )
            except Exception:  # noqa: BLE001 - close is still required
                failures.append(f"interrupt {state.runtime_id}")
            closed = False
            try:
                closed = (
                    await self._run_state_blocking(
                        state, gateway.close, state.runtime_id
                    )
                    is True
                )
                if not closed:
                    failures.append(f"close {state.runtime_id}")
            except Exception:  # noqa: BLE001 - durable state already won
                failures.append(f"close {state.runtime_id}")
            if closed:
                self._remove_runtime(state)
            state.settle_error = None
            state.finished.set()
            state.terminal_info_received.set()
            state.pending_interaction_ids.clear()
            current_task = asyncio.current_task()
            for helper in (state.event_task, state.grace_task):
                if helper is None or helper is current_task:
                    continue
                if not helper.done():
                    helper.cancel()
                await asyncio.gather(helper, return_exceptions=True)
            return ", ".join(failures) or None

    async def respond_approval(
        self,
        *,
        room_id: str,
        interaction_id: str,
        request_id: str,
        choice: str,
        permanent: bool,
    ) -> dict[str, object]:
        if not self._started or self._closing:
            raise GroupOrchestratorError("Orchestrator is not accepting controls")
        if choice not in _APPROVAL_CHOICES:
            raise ValueError("choice must be once, session, always, or deny")
        if not isinstance(permanent, bool) or ((choice == "always") != permanent):
            raise ValueError("permanent must be true exactly for choice=always")
        replay = await self._terminal_interaction_replay(
            room_id=room_id,
            interaction_id=interaction_id,
            request_id=request_id,
            kind="approval",
            response={"choice": choice, "permanent": permanent},
        )
        if replay is not None:
            return replay
        state, interaction = await self._interaction_runtime(
            room_id, interaction_id, "approval"
        )
        task = asyncio.create_task(
            self._respond_approval_for_runtime(
                state=state,
                interaction=interaction,
                room_id=room_id,
                interaction_id=interaction_id,
                request_id=request_id,
                choice=choice,
                permanent=permanent,
            ),
            name=f"yaoyao-group-approval-{request_id}",
        )
        self._track_mutation_task(state, task)
        return await asyncio.shield(task)

    async def _respond_approval_for_runtime(
        self,
        *,
        state: _RuntimeState,
        interaction: Mapping[str, object],
        room_id: str,
        interaction_id: str,
        request_id: str,
        choice: str,
        permanent: bool,
    ) -> dict[str, object]:
        async with state.mutation_lock:
            self._require_current_runtime(state)
            claim = await self._run_state_blocking(
                state,
                self.store.begin_interaction_response,
                room_id,
                interaction_id,
                request_id=request_id,
                kind="approval",
                response={"choice": choice, "permanent": permanent},
            )
            if not isinstance(claim, Mapping):
                raise GroupOrchestratorError("Approval claim is invalid")
            if claim.get("state") in {"replay", "failed"}:
                response = claim.get("response")
                return dict(response) if isinstance(response, Mapping) else dict(claim)
            payload = interaction.get("payload")
            choices = payload.get("choices") if isinstance(payload, Mapping) else None
            if (
                not isinstance(choices, list)
                or choice not in choices
                or not all(item in _APPROVAL_CHOICES for item in choices)
            ):
                await self._run_state_blocking(
                    state,
                    self.store.fail_interaction_response,
                    request_id,
                    reason="Approval choice is not allowed by the pending card",
                    uncertain=False,
                )
                raise ValueError("choice is not allowed by the pending approval")
            try:
                resolved = await self._run_state_blocking(
                    state,
                    self._required_gateway().respond_approval,
                    state.runtime_id,
                    choice,
                )
            except Exception:
                await self._fail_unknown_interaction_response_locked(
                    state, request_id, "Gateway approval outcome is unknown"
                )
                raise GroupOrchestratorError("Gateway approval outcome is unknown")
            if (
                isinstance(resolved, bool)
                or not isinstance(resolved, int)
                or resolved not in {0, 1}
            ):
                await self._fail_unknown_interaction_response_locked(
                    state, request_id, "Gateway approval result is invalid"
                )
                raise GroupOrchestratorError("Gateway approval result is invalid")
            public = {
                "accepted": resolved == 1,
                "interactionId": interaction_id,
            }
            try:
                result = await self._store_retry(
                    state,
                    self.store.finish_interaction_response,
                    request_id,
                    response=public,
                    interaction_status=("resolved" if resolved == 1 else "cancelled"),
                )
            except Exception:
                await self._finalize_state_locked(
                    state,
                    outcome="failed",
                    error="Durable approval response could not be completed",
                    interrupt=True,
                )
                raise
            state.pending_interaction_ids.discard(interaction_id)
            return dict(result)

    async def respond_clarification(
        self,
        *,
        room_id: str,
        interaction_id: str,
        request_id: str,
        response: str,
    ) -> dict[str, object]:
        if not self._started or self._closing:
            raise GroupOrchestratorError("Orchestrator is not accepting controls")
        if not isinstance(response, str) or not response.strip():
            raise ValueError("response must not be blank")
        self._bounded_text(response, "clarification response")
        replay = await self._terminal_interaction_replay(
            room_id=room_id,
            interaction_id=interaction_id,
            request_id=request_id,
            kind="clarification",
            response={"response": response},
        )
        if replay is not None:
            return replay
        state, interaction = await self._interaction_runtime(
            room_id, interaction_id, "clarification"
        )
        task = asyncio.create_task(
            self._respond_clarification_for_runtime(
                state=state,
                interaction=interaction,
                room_id=room_id,
                interaction_id=interaction_id,
                request_id=request_id,
                response=response,
            ),
            name=f"yaoyao-group-clarification-{request_id}",
        )
        self._track_mutation_task(state, task)
        return await asyncio.shield(task)

    @staticmethod
    def _track_mutation_task(
        state: _RuntimeState, task: asyncio.Task[dict[str, object]]
    ) -> None:
        state.mutation_tasks.add(task)

        def finished(done: asyncio.Task[dict[str, object]]) -> None:
            state.mutation_tasks.discard(done)
            if done.cancelled():
                return
            try:
                done.exception()
            except asyncio.CancelledError:
                return

        task.add_done_callback(finished)

    async def _respond_clarification_for_runtime(
        self,
        *,
        state: _RuntimeState,
        interaction: Mapping[str, object],
        room_id: str,
        interaction_id: str,
        request_id: str,
        response: str,
    ) -> dict[str, object]:
        async with state.mutation_lock:
            self._require_current_runtime(state)
            claim = await self._run_state_blocking(
                state,
                self.store.begin_interaction_response,
                room_id,
                interaction_id,
                request_id=request_id,
                kind="clarification",
                response={"response": response},
            )
            if not isinstance(claim, Mapping):
                raise GroupOrchestratorError("Clarification claim is invalid")
            if claim.get("state") in {"replay", "failed"}:
                replay = claim.get("response")
                return dict(replay) if isinstance(replay, Mapping) else dict(claim)
            payload = interaction.get("payload")
            gateway_request_id = (
                payload.get("gatewayRequestId")
                if isinstance(payload, Mapping)
                else None
            )
            gateway_request_id = _required_string(
                gateway_request_id, "interaction.payload.gatewayRequestId"
            )
            try:
                status = await self._run_state_blocking(
                    state,
                    self._required_gateway().respond_clarification,
                    gateway_request_id,
                    response,
                )
            except Exception:
                await self._fail_unknown_interaction_response_locked(
                    state, request_id, "Gateway clarification outcome is unknown"
                )
                raise GroupOrchestratorError("Gateway clarification outcome is unknown")
            if status not in {"ok", "expired"}:
                await self._fail_unknown_interaction_response_locked(
                    state, request_id, "Gateway clarification result is invalid"
                )
                raise GroupOrchestratorError("Gateway clarification result is invalid")
            public = {
                "accepted": status == "ok",
                "interactionId": interaction_id,
            }
            try:
                result = await self._store_retry(
                    state,
                    self.store.finish_interaction_response,
                    request_id,
                    response=public,
                    interaction_status=("resolved" if status == "ok" else "cancelled"),
                )
            except Exception:
                await self._finalize_state_locked(
                    state,
                    outcome="failed",
                    error="Durable clarification response could not be completed",
                    interrupt=True,
                )
                raise
            state.pending_interaction_ids.discard(interaction_id)
            return dict(result)

    async def _terminal_interaction_replay(
        self,
        *,
        room_id: str,
        interaction_id: str,
        request_id: str,
        kind: str,
        response: Mapping[str, object],
    ) -> dict[str, object] | None:
        interaction = await asyncio.to_thread(
            self.store.get_interaction, interaction_id
        )
        if (
            not isinstance(interaction, Mapping)
            or interaction.get("roomId") != room_id
            or interaction.get("kind") != kind
        ):
            raise GroupOrchestratorError("Interaction is not in this room")
        if interaction.get("status") == "pending":
            return None
        result = await asyncio.to_thread(
            self.store.begin_interaction_response,
            room_id,
            interaction_id,
            request_id=request_id,
            kind=kind,
            response=response,
        )
        if not isinstance(result, Mapping):
            raise GroupOrchestratorError("Interaction replay is invalid")
        replay = result.get("response")
        if result.get("state") == "replay" and isinstance(replay, Mapping):
            return dict(replay)
        if result.get("state") == "failed":
            return dict(result)
        raise GroupOrchestratorError("Interaction is already terminal")

    async def _interaction_runtime(
        self, room_id: str, interaction_id: str, kind: str
    ) -> tuple[_RuntimeState, Mapping[str, object]]:
        interaction = await asyncio.to_thread(
            self.store.get_interaction, interaction_id
        )
        if (
            not isinstance(interaction, Mapping)
            or interaction.get("roomId") != room_id
            or interaction.get("kind") != kind
            or interaction.get("status") != "pending"
        ):
            raise GroupOrchestratorError("Interaction is not pending in this room")
        run_id = _required_string(interaction.get("runId"), "interaction.runId")
        run = await asyncio.to_thread(self.store.get_run, run_id)
        runtime_id = _required_string(
            run.get("runtimeSessionId") if isinstance(run, Mapping) else None,
            "run.runtimeSessionId",
        )
        with self._mapping_lock:
            current = self._runtime_states.get(runtime_id)
        if current is None or current[1].run_id != run_id:
            raise GroupOrchestratorError("Interaction runtime is not active")
        return current[1], interaction

    def _require_current_runtime(self, state: _RuntimeState) -> None:
        with self._mapping_lock:
            current = self._runtime_states.get(state.runtime_id)
        if (
            current != (state.generation, state)
            or state.finished.is_set()
            or state.finalizing
        ):
            raise GroupOrchestratorError("Interaction runtime generation changed")

    async def _fail_unknown_interaction_response_locked(
        self, state: _RuntimeState, request_id: str, reason: str
    ) -> None:
        try:
            await self._store_retry(
                state,
                self.store.fail_interaction_response,
                request_id,
                reason=reason,
                uncertain=True,
            )
        except Exception:
            logger.error("Failed to persist unknown interaction outcome")
        await self._finalize_state_locked(
            state, outcome="failed", error=reason, interrupt=True
        )

    async def shutdown(self) -> None:
        """Stop claims, settle every owned runtime, drain, then close Gateway."""

        if self._lifecycle_lock is None:
            self._lifecycle_lock = asyncio.Lock()
        wait_for_owner: asyncio.Event | None = None
        completed_shutdown = False
        async with self._lifecycle_lock:
            if not self._started:
                self._closing = True
                completed_shutdown = bool(
                    self._shutdown_complete is not None
                    and self._shutdown_complete.is_set()
                )
                if not completed_shutdown:
                    return
                scheduler = None
            elif self._closing:
                wait_for_owner = self._shutdown_complete
                scheduler = None
            else:
                self._closing = True
                if self._shutdown_event is not None:
                    self._shutdown_event.set()
                if self._wake_event is not None:
                    self._wake_event.set()
                scheduler = self._scheduler_task
        if completed_shutdown:
            if self._shutdown_error is not None:
                raise self._shutdown_error
            return
        if wait_for_owner is not None:
            await wait_for_owner.wait()
            if self._shutdown_error is not None:
                raise self._shutdown_error
            return

        first_error: BaseException | None = None

        def remember(error: BaseException) -> None:
            nonlocal first_error
            if first_error is None:
                first_error = error

        if scheduler is not None:
            try:
                await scheduler
            except BaseException as error:  # noqa: BLE001 - cleanup continues
                remember(error)

        while self._run_tasks:
            tasks = tuple(self._run_tasks)
            try:
                results = await asyncio.gather(*tasks, return_exceptions=True)
            except BaseException as error:  # noqa: BLE001 - cleanup continues
                remember(error)
            else:
                self._remember_task_results(results, remember)

        while self._control_tasks:
            tasks = tuple(self._control_tasks)
            try:
                results = await asyncio.gather(*tasks, return_exceptions=True)
            except BaseException as error:  # noqa: BLE001 - cleanup continues
                remember(error)
            else:
                self._remember_task_results(results, remember)

        with self._failure_lock:
            run_failures = tuple(self._run_failures)
            durable_failures = tuple(self._durable_failures)
        for error in (*run_failures, *durable_failures):
            remember(error)

        with self._mapping_lock:
            remaining_states = [
                state for _generation, state in self._runtime_states.values()
            ]
        for state in remaining_states:
            if state.settle_error is not None:
                remember(state.settle_error)
            current_task = asyncio.current_task()
            for helper in (state.event_task, state.grace_task):
                if helper is None or helper is current_task:
                    continue
                if not helper.done():
                    helper.cancel()
                try:
                    results = await asyncio.gather(helper, return_exceptions=True)
                except BaseException as error:  # noqa: BLE001 - cleanup continues
                    remember(error)
                else:
                    self._remember_task_results(results, remember)
            pending_calls = tuple(state.inflight_calls)
            if pending_calls:
                try:
                    results = await asyncio.gather(
                        *pending_calls, return_exceptions=True
                    )
                except BaseException as error:  # noqa: BLE001 - cleanup continues
                    remember(error)
                else:
                    self._remember_task_results(results, remember)
            self._remove_runtime(state)
            try:
                await asyncio.to_thread(
                    self._required_gateway().close, state.runtime_id
                )
            except BaseException as error:  # noqa: BLE001 - cleanup continues
                remember(error)
            state.finished.set()

        gateway = self._gateway
        if gateway is not None:
            drain: Callable[[float | None], object] | None = None
            try:
                transport = getattr(gateway, "transport", None)
                candidate = getattr(transport, "drain", None)
                if callable(candidate):
                    drain = candidate
            except BaseException as error:  # noqa: BLE001 - shutdown still runs
                remember(error)
            if drain is not None:
                try:
                    await asyncio.to_thread(drain, None)
                except BaseException as error:  # noqa: BLE001 - cleanup continues
                    remember(error)
            try:
                await asyncio.to_thread(gateway.shutdown)
            except BaseException as error:  # noqa: BLE001 - cleanup continues
                remember(error)

        try:
            event_queue = self._event_queue
            event_task = self._event_task
            if event_queue is not None:
                try:
                    await event_queue.join()
                    await event_queue.put(None)
                except BaseException as error:  # noqa: BLE001 - completion must signal
                    remember(error)
            if event_task is not None:
                try:
                    await event_task
                except BaseException as error:  # noqa: BLE001 - completion must signal
                    remember(error)
        finally:
            async with self._lifecycle_lock:
                self._started = False
                self._gateway = None
                self._scheduler_task = None
                self._event_task = None
                self._shutdown_error = first_error
                if self._shutdown_complete is not None:
                    self._shutdown_complete.set()
        if first_error is not None:
            raise first_error

    @staticmethod
    def _remember_task_results(
        results: list[object], remember: Callable[[BaseException], None]
    ) -> None:
        for result in results:
            if isinstance(result, BaseException) and not isinstance(
                result, asyncio.CancelledError
            ):
                remember(result)

    async def _scheduler(self) -> None:
        wake_event = self._wake_event
        shutdown_event = self._shutdown_event
        if wake_event is None or shutdown_event is None:
            raise GroupOrchestratorError("Scheduler started without lifecycle state")
        claim_failure_count = 0
        while True:
            await wake_event.wait()
            wake_event.clear()
            if shutdown_event.is_set():
                return
            self._scheduler_busy = True
            try:
                if not await self._work_is_enabled():
                    if await self._wait_for_disabled_work(shutdown_event, wake_event):
                        return
                    continue
                try:
                    more_cascades = await self._drain_pending_cascades()
                except Exception:  # noqa: BLE001 - durable ledger remains pending
                    claim_failure_count += 1
                    delay = min(
                        _STORE_RETRY_DELAYS[0]
                        * (2 ** min(claim_failure_count - 1, 10)),
                        _CLAIM_RETRY_MAX_SECONDS,
                    )
                    logger.error("Pending YaoYao group cascade temporarily failed")
                    try:
                        await asyncio.wait_for(shutdown_event.wait(), timeout=delay)
                    except asyncio.TimeoutError:
                        wake_event.set()
                        continue
                    return
                if more_cascades:
                    wake_event.set()
                    continue
                while not shutdown_event.is_set():
                    if not await self._work_is_enabled():
                        if await self._wait_for_disabled_work(
                            shutdown_event, wake_event
                        ):
                            return
                        break
                    try:
                        claimed = await asyncio.to_thread(
                            self.store.claim_next_runnable_run
                        )
                    except Exception:  # noqa: BLE001 - keep scheduler alive
                        claim_failure_count += 1
                        delay = min(
                            _STORE_RETRY_DELAYS[0]
                            * (2 ** min(claim_failure_count - 1, 10)),
                            _CLAIM_RETRY_MAX_SECONDS,
                        )
                        logger.error("YaoYao group run claim temporarily failed")
                        try:
                            await asyncio.wait_for(shutdown_event.wait(), timeout=delay)
                        except asyncio.TimeoutError:
                            continue
                        return
                    claim_failure_count = 0
                    if claimed is None:
                        break
                    task = asyncio.create_task(
                        self._run_claimed(claimed),
                        name=f"yaoyao-group-run-{claimed.get('id', 'invalid')}",
                    )
                    self._run_tasks.add(task)
                    task.add_done_callback(self._run_finished)
            finally:
                self._scheduler_busy = False

    async def _work_is_enabled(self) -> bool:
        try:
            return await asyncio.to_thread(self._work_enabled) is True
        except Exception as error:  # noqa: BLE001 - fail closed on config errors
            _log_failure_type("YaoYao group work gate temporarily failed", error)
            return False

    @staticmethod
    async def _wait_for_disabled_work(
        shutdown_event: asyncio.Event,
        wake_event: asyncio.Event,
    ) -> bool:
        try:
            await asyncio.wait_for(
                shutdown_event.wait(), timeout=_WORK_DISABLED_RETRY_SECONDS
            )
        except asyncio.TimeoutError:
            wake_event.set()
            return False
        return True

    async def _drain_pending_cascades(self) -> bool:
        page = await asyncio.to_thread(self.store.list_pending_cascades, limit=32)
        if not isinstance(page, Mapping):
            raise GroupOrchestratorError("Pending cascade page is invalid")
        items = page.get("items")
        if not isinstance(items, list) or not all(
            isinstance(item, Mapping) for item in items
        ):
            raise GroupOrchestratorError("Pending cascade items are invalid")
        created = False
        for item in items:
            source_run_id = _required_string(
                item.get("sourceRunId"), "cascade.sourceRunId"
            )
            result = await asyncio.to_thread(self.store.complete_cascade, source_run_id)
            if not isinstance(result, Mapping):
                raise GroupOrchestratorError("Cascade completion is invalid")
            run_count = result.get("runCount")
            if isinstance(run_count, bool) or not isinstance(run_count, int):
                raise GroupOrchestratorError("Cascade run count is invalid")
            created = created or run_count > 0
        if created:
            self.wake()
        return page.get("nextCursor") is not None

    def _run_finished(self, task: asyncio.Task[None]) -> None:
        self._run_tasks.discard(task)
        try:
            error = task.exception()
        except asyncio.CancelledError:
            error = None
        if error is not None:
            with self._failure_lock:
                self._run_failures.append(error)
            _log_failure_type("YaoYao group run task failed", error)
        self.wake()

    async def _run_claimed(self, claimed: Mapping[str, object]) -> None:
        run_id_value = claimed.get("id")
        if not isinstance(run_id_value, str) or not run_id_value:
            logger.error("Claimed YaoYao group run has no usable identity")
            return
        run_id = run_id_value
        try:
            claimed_agent_id = _required_string(claimed.get("agentId"), "run.agentId")
            async with self._agent_serial(claimed_agent_id):
                try:
                    await self._run_claimed_for_agent(claimed, run_id)
                except Exception:  # noqa: BLE001 - never strand a durable claim
                    logger.exception("YaoYao group claimed run preparation failed")
                    await self._fail_claim_without_projection(run_id)
        except Exception:  # noqa: BLE001 - malformed claim still has run ID
            logger.exception("YaoYao group claimed run identity is invalid")
            await self._fail_claim_without_projection(run_id)

    @asynccontextmanager
    async def _agent_serial(self, agent_id: str):
        async with self._keyed_serial(self._agent_locks, agent_id):
            yield

    @asynccontextmanager
    async def _submission_serial(self, agent_id: str):
        async with self._keyed_serial(self._submission_locks, agent_id):
            yield

    @asynccontextmanager
    async def _room_serial(self, room_id: str):
        async with self._keyed_serial(self._room_locks, room_id):
            yield

    @staticmethod
    @asynccontextmanager
    async def _keyed_serial(locks: dict[str, _AgentLockState], key: str):
        entry = locks.get(key)
        if entry is None:
            entry = _AgentLockState()
            locks[key] = entry
        entry.users += 1
        try:
            async with entry.lock:
                yield
        finally:
            entry.users -= 1
            if entry.users == 0 and locks.get(key) is entry:
                locks.pop(key, None)

    async def _run_claimed_for_agent(
        self, claimed: Mapping[str, object], run_id: str
    ) -> None:
        try:
            projection = await asyncio.to_thread(self.store.read_run_projection, run_id)
        except Exception:  # noqa: BLE001 - durable claim must be terminal
            logger.exception("Failed to read YaoYao group run projection")
            await self._fail_claim_without_projection(run_id)
            return

        run = _required_mapping(projection.get("run"), "projection.run")
        room = _required_mapping(projection.get("room"), "projection.room")
        agent = _required_mapping(projection.get("agent"), "projection.agent")
        room_id = _required_string(room.get("id"), "projection.room.id")
        topic_id = _required_string(run.get("topicId"), "projection.run.topicId")
        agent_id = _required_string(agent.get("id"), "projection.agent.id")
        if _required_string(run.get("id"), "projection.run.id") != run_id:
            raise GroupOrchestratorError("projection run identity changed")
        if agent_id != _required_string(claimed.get("agentId"), "run.agentId"):
            raise GroupOrchestratorError("projection Agent identity changed")
        configuration = {
            "model": agent.get("model"),
            "provider": agent.get("provider"),
            "reasoning_effort": agent.get("reasoningEffort"),
            "fast": agent.get("fastMode"),
        }
        try:
            rotated = await asyncio.to_thread(
                self.store.prepare_run_session_configuration,
                run_id,
                configuration,
            )
            if rotated:
                projection = await asyncio.to_thread(
                    self.store.read_run_projection, run_id
                )
                run = _required_mapping(projection.get("run"), "projection.run")
                room = _required_mapping(projection.get("room"), "projection.room")
                agent = _required_mapping(projection.get("agent"), "projection.agent")
        except Exception:
            logger.exception("Failed to prepare YaoYao group Agent configuration")
            await self._fail_claim_without_projection(run_id)
            return
        profile = _required_string(agent.get("profile"), "projection.agent.profile")
        node_id = _required_string(
            agent.get("nodeId", "local"), "projection.agent.nodeId"
        )
        reply_mode = _required_string(run.get("replyMode"), "projection.run.replyMode")
        if reply_mode not in {"mentioned", "automatic"}:
            raise GroupOrchestratorError("projection.run.replyMode is invalid")
        required_reply = _required_bool(
            run.get("requiredReply", False), "projection.run.requiredReply"
        )
        if required_reply and reply_mode != "automatic":
            raise GroupOrchestratorError(
                "projection.run.requiredReply requires automatic replyMode"
            )
        display_name = _required_string(
            agent.get("displayName"), "projection.agent.displayName"
        )
        room_name = _required_string(room.get("name"), "projection.room.name")
        cwd_value = room.get("cwd", "")
        if not isinstance(cwd_value, str):
            raise GroupOrchestratorError("projection.room.cwd must be a string")
        expected_stored_id = _optional_string(
            agent.get("storedSessionId"), "projection.agent.storedSessionId"
        )
        expected_context_seq = _required_nonnegative_int(
            agent.get("lastContextMessageSeq"),
            "projection.agent.lastContextMessageSeq",
        )
        through_seq = _required_nonnegative_int(
            projection.get("throughSeq"), "projection.throughSeq"
        )
        room_detail = await asyncio.to_thread(self.store.get_room, room_id)
        room_agents = room_detail.get("agents")
        if not isinstance(room_agents, list) or not all(
            isinstance(item, Mapping) for item in room_agents
        ):
            raise GroupOrchestratorError("room.agents must be a list of objects")
        prompt = build_run_prompt(projection, room_agents)
        gateway = self._required_gateway()
        try:
            if expected_stored_id is None:
                if node_id == "local":
                    identity = await asyncio.to_thread(
                        gateway.create_session,
                        profile,
                        f"[群聊] {room_name} · {display_name}",
                        cwd_value,
                        [],
                        configuration,
                    )
                else:
                    create_remote = getattr(
                        gateway, "create_session_for_node", None
                    )
                    if not callable(create_remote):
                        raise GroupOrchestratorError(
                            "Gateway does not support remote nodes"
                        )
                    identity = await asyncio.to_thread(
                        create_remote,
                        node_id,
                        profile,
                        f"[群聊] {room_name} · {display_name}",
                        "",
                        [],
                        configuration,
                    )
            else:
                if node_id == "local":
                    identity = await asyncio.to_thread(
                        gateway.resume_session, profile, expected_stored_id
                    )
                else:
                    resume_remote = getattr(
                        gateway, "resume_session_for_node", None
                    )
                    if not callable(resume_remote):
                        raise GroupOrchestratorError(
                            "Gateway does not support remote nodes"
                        )
                    identity = await asyncio.to_thread(
                        resume_remote,
                        node_id,
                        profile,
                        expected_stored_id,
                    )
        except Exception:  # noqa: BLE001 - never create a fallback session
            logger.error("YaoYao group session create/resume failed")
            await self._settle_unbound_failed(
                run_id,
                expected_stored_id=expected_stored_id,
                stored_session_id=expected_stored_id,
                error="Agent session setup failed",
            )
            return

        identity = self._validated_identity(identity)
        if identity.running:
            # A busy resume may belong to another consumer.  Persist rotation,
            # but never adopt, submit to, interrupt, or close that runtime.
            await self._settle_unbound_failed(
                run_id,
                expected_stored_id=expected_stored_id,
                stored_session_id=identity.stored_id,
                error="Agent stored session is already running",
            )
            return

        bound = False
        for delay in (*_STORE_RETRY_DELAYS, None):
            try:
                await asyncio.to_thread(
                    self.store.bind_run_runtime, run_id, identity.runtime_id
                )
                bound = True
                break
            except Exception:  # noqa: BLE001 - exact bind replay is idempotent
                if delay is None:
                    try:
                        durable = await asyncio.to_thread(self.store.get_run, run_id)
                    except Exception:  # noqa: BLE001 - identity remains unknown
                        durable = None
                    bound = (
                        isinstance(durable, Mapping)
                        and durable.get("status") in {"running", "awaiting_input"}
                        and durable.get("runtimeSessionId") == identity.runtime_id
                    )
                    break
                await asyncio.sleep(delay)
        if not bound:
            logger.error("Failed to bind YaoYao group runtime")
            await self._close_unbound_runtime(identity.runtime_id)
            await self._settle_unbound_failed(
                run_id,
                expected_stored_id=expected_stored_id,
                stored_session_id=identity.stored_id,
                error="Agent runtime binding failed",
            )
            return

        async with self._room_serial(room_id):
            async with self._submission_serial(agent_id):
                durable = None
                for delay in (*_STORE_RETRY_DELAYS, None):
                    try:
                        durable = await asyncio.to_thread(self.store.get_run, run_id)
                        break
                    except Exception:  # noqa: BLE001 - unknown owner cannot submit
                        if delay is None:
                            break
                        await asyncio.sleep(delay)
                if (
                    not isinstance(durable, Mapping)
                    or durable.get("status") not in {"running", "awaiting_input"}
                    or durable.get("runtimeSessionId") != identity.runtime_id
                ):
                    logger.error("Bound YaoYao group runtime lost durable ownership")
                    await self._close_unbound_runtime(identity.runtime_id)
                    if not (
                        isinstance(durable, Mapping)
                        and durable.get("status") in _TERMINAL_RUN_STATUSES
                    ):
                        await self._settle_unbound_failed(
                            run_id,
                            expected_stored_id=expected_stored_id,
                            stored_session_id=identity.stored_id,
                            error="Agent runtime ownership check failed",
                        )
                    return

                state = self._install_runtime(
                    run_id=run_id,
                    room_id=room_id,
                    topic_id=topic_id,
                    agent_id=agent_id,
                    identity=identity,
                    expected_stored_id=expected_stored_id,
                    expected_context_seq=expected_context_seq,
                    through_seq=through_seq,
                    profile=profile,
                    reply_mode=reply_mode,
                    required_reply=required_reply,
                )
                if self._closing:
                    state.prompt_ready.set()
                    await self._finalize_state(
                        state,
                        outcome="interrupted",
                        error="Group orchestrator stopped",
                        interrupt=True,
                    )
                    return

                try:
                    await self._run_state_blocking(
                        state, gateway.submit_prompt, identity.runtime_id, prompt
                    )
                except Exception:  # noqa: BLE001 - ACK is intentionally unknown
                    logger.error("YaoYao group prompt submission failed")
                    state.prompt_ready.set()
                    await self._finalize_state(
                        state,
                        outcome="failed",
                        error="Prompt submission result is unknown",
                        interrupt=True,
                    )
                    return

                try:
                    for delay in (*_STORE_RETRY_DELAYS, None):
                        try:
                            await self._run_state_blocking(
                                state,
                                self.store.commit_prompt_submission,
                                run_id,
                                expected_stored_session_id=expected_stored_id,
                                stored_session_id=identity.stored_id,
                                runtime_session_id=identity.runtime_id,
                                expected_context_seq=expected_context_seq,
                                through_seq=through_seq,
                            )
                            state.prompt_committed = True
                            break
                        except Exception:
                            if delay is None:
                                raise
                            await asyncio.sleep(delay)
                except Exception:  # noqa: BLE001 - prompts are never retried
                    logger.error("Failed to commit YaoYao group prompt ACK")
                    state.prompt_ready.set()
                    await self._finalize_state(
                        state,
                        outcome="failed",
                        error="Prompt acknowledgement could not be committed",
                        interrupt=True,
                    )
                    return
                finally:
                    state.prompt_ready.set()

        if state.overflowed:
            await self._finalize_state(
                state,
                outcome="failed",
                error="Runtime control event buffer exceeded capacity",
                interrupt=True,
            )
            return

        shutdown_event = self._shutdown_event
        if shutdown_event is None:
            raise GroupOrchestratorError("Run started without shutdown state")
        finished_wait = asyncio.create_task(state.finished.wait())
        shutdown_wait = asyncio.create_task(shutdown_event.wait())
        try:
            done, pending = await asyncio.wait(
                {finished_wait, shutdown_wait},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for waiter in pending:
                waiter.cancel()
            if finished_wait in done and state.finished.is_set():
                return
            if shutdown_wait in done and shutdown_event.is_set():
                outcome = "interrupted"
                error = "Group orchestrator stopped"
            await self._finalize_state(
                state, outcome=outcome, error=error, interrupt=True
            )
        finally:
            for waiter in (finished_wait, shutdown_wait):
                if not waiter.done():
                    waiter.cancel()

    async def _fail_claim_without_projection(self, run_id: str) -> None:
        for delay in (*_STORE_RETRY_DELAYS, None):
            try:
                await asyncio.to_thread(
                    self.store.transition_run,
                    run_id,
                    "failed",
                    error="Agent context projection failed",
                )
                return
            except Exception:  # noqa: BLE001 - reconcile before retrying
                if await self._run_is_durably_terminal(run_id):
                    return
                if delay is None:
                    logger.exception("Failed to settle malformed YaoYao group claim")
                    self._record_durable_failure(
                        "Durable claimed run settlement failed"
                    )
                    return
                await asyncio.sleep(delay)

    async def _settle_unbound_failed(
        self,
        run_id: str,
        *,
        expected_stored_id: str | None,
        stored_session_id: str | None,
        error: str,
    ) -> None:
        for delay in (*_STORE_RETRY_DELAYS, None):
            try:
                await asyncio.to_thread(
                    self.store.settle_run,
                    run_id,
                    runtime_session_id=None,
                    expected_stored_session_id=expected_stored_id,
                    stored_session_id=stored_session_id,
                    outcome="failed",
                    error=self._bounded_error(error),
                )
                return
            except Exception:  # noqa: BLE001 - reconcile before retrying
                if await self._run_is_durably_terminal(run_id):
                    return
                if delay is None:
                    logger.exception("Failed to settle unbound YaoYao group run")
                    self._record_durable_failure(
                        "Durable unbound run settlement failed"
                    )
                    return
                await asyncio.sleep(delay)

    def _record_durable_failure(self, message: str) -> None:
        failure = GroupOrchestratorError(message)
        with self._failure_lock:
            self._durable_failures.append(failure)

    async def _run_is_durably_terminal(self, run_id: str) -> bool:
        try:
            durable = await asyncio.to_thread(self.store.get_run, run_id)
        except Exception:  # noqa: BLE001 - missing is safe only for local cleanup
            return False
        return (
            isinstance(durable, Mapping)
            and durable.get("status") in _TERMINAL_RUN_STATUSES
        )

    async def _close_unbound_runtime(self, runtime_id: str) -> None:
        try:
            await asyncio.to_thread(self._required_gateway().close, runtime_id)
        except Exception:  # noqa: BLE001 - best effort after failed durable bind
            logger.exception("Failed to close unbound YaoYao group runtime")

    @staticmethod
    def _validated_identity(identity: object) -> SessionIdentity:
        stored_id = _required_string(
            getattr(identity, "stored_id", None), "session.stored_id"
        )
        runtime_id = _required_string(
            getattr(identity, "runtime_id", None), "session.runtime_id"
        )
        running = getattr(identity, "running", None)
        if not isinstance(running, bool):
            raise GroupOrchestratorError("session.running must be a boolean")
        return SessionIdentity(stored_id, runtime_id, running)

    def _install_runtime(
        self,
        *,
        run_id: str,
        room_id: str,
        topic_id: str,
        agent_id: str,
        identity: SessionIdentity,
        expected_stored_id: str | None,
        expected_context_seq: int,
        through_seq: int,
        profile: str,
        reply_mode: str,
        required_reply: bool,
    ) -> _RuntimeState:
        with self._mapping_lock:
            if identity.runtime_id in self._runtime_states:
                raise GroupOrchestratorError(
                    "Gateway runtime is already mapped to an active generation"
                )
            self._next_generation += 1
            state = _RuntimeState(
                run_id=run_id,
                room_id=room_id,
                topic_id=topic_id,
                agent_id=agent_id,
                runtime_id=identity.runtime_id,
                generation=self._next_generation,
                expected_stored_id=expected_stored_id,
                session_stored_id=identity.stored_id,
                expected_context_seq=expected_context_seq,
                through_seq=through_seq,
                profile=profile,
                reply_mode=reply_mode,
                required_reply=required_reply,
                automatic_published=required_reply,
            )
            self._runtime_states[identity.runtime_id] = (
                state.generation,
                state,
            )
            state.event_task = asyncio.create_task(
                self._consume_runtime_events(state),
                name=f"yaoyao-group-runtime-{state.generation}",
            )
            return state

    def _remove_runtime(self, state: _RuntimeState) -> None:
        with self._mapping_lock:
            current = self._runtime_states.get(state.runtime_id)
            if current == (state.generation, state):
                self._runtime_states.pop(state.runtime_id, None)

    def _gateway_event_callback(
        self,
        runtime_id: str,
        event_type: str,
        payload: dict[str, object],
    ) -> None:
        """Bridge the Gateway callback thread into one bounded asyncio queue."""

        if event_type not in _PERSISTED_EVENTS:
            return

        with self._mapping_lock:
            current = self._runtime_states.get(runtime_id)
        if current is None:
            logger.debug("Ignored event for an unmapped group runtime")
            return
        generation, _state = current
        loop = self._loop
        queue = self._event_queue
        if loop is None or queue is None or loop.is_closed():
            return
        try:
            safe_payload = _strict_json_copy(payload, "gateway.payload")
        except GroupOrchestratorError:
            logger.warning("Ignored malformed group Gateway payload")
            return
        if not isinstance(safe_payload, dict):
            return
        envelope = _GatewayEvent(
            runtime_id=runtime_id,
            generation=generation,
            event_type=event_type,
            payload=safe_payload,
        )
        if threading.get_ident() == self._loop_thread_id:
            # The production transport uses a dedicated worker.  Supporting a
            # loop-local test callback is still safe while the queue has room.
            try:
                queue.put_nowait(envelope)
            except asyncio.QueueFull:
                logger.error("Loop-local group Gateway callback exceeded capacity")
            return
        try:
            future = asyncio.run_coroutine_threadsafe(queue.put(envelope), loop)
            future.result()
        except (RuntimeError, asyncio.CancelledError):
            return

    async def _consume_events(self) -> None:
        queue = self._event_queue
        if queue is None:
            raise GroupOrchestratorError("Event consumer has no queue")
        while True:
            event = await queue.get()
            try:
                if event is None:
                    return
                await self._handle_event(event)
            except Exception:  # noqa: BLE001 - isolate all Gateway callbacks
                logger.exception("Failed to consume YaoYao group Gateway event")
            finally:
                queue.task_done()

    async def _handle_event(self, event: _GatewayEvent) -> None:
        if event.event_type not in _PERSISTED_EVENTS:
            return
        with self._mapping_lock:
            current = self._runtime_states.get(event.runtime_id)
        if current is None or current[0] != event.generation:
            logger.debug("Ignored stale group Gateway generation")
            return
        state = current[1]
        if state.finished.is_set() or state.finalizing:
            return
        try:
            state.pending_events.put_nowait(event)
        except asyncio.QueueFull:
            # The transport already applies global backpressure. A per-runtime
            # overflow is an invariant breach: fail that run without blocking
            # unrelated sessions in the one global router.
            state.overflowed = True
            state.prompt_ready.set()

    async def _consume_runtime_events(self, state: _RuntimeState) -> None:
        """Serialize one runtime without head-of-line blocking other sessions."""

        await state.prompt_ready.wait()
        while not state.finished.is_set():
            if state.finalizing:
                return
            if state.overflowed and state.prompt_committed:
                await self._finalize_state(
                    state,
                    outcome="failed",
                    error="Runtime control event buffer exceeded capacity",
                    interrupt=True,
                )
                return
            timeout: float | None = None
            if state.stream_dirty and not (
                state.reply_mode == "automatic" and not state.automatic_published
            ):
                timeout = max(
                    0.0,
                    STREAM_FLUSH_INTERVAL
                    - (asyncio.get_running_loop().time() - state.last_stream_flush),
                )
            try:
                if timeout is None:
                    event = await state.pending_events.get()
                else:
                    event = await asyncio.wait_for(
                        state.pending_events.get(), timeout=timeout
                    )
            except asyncio.TimeoutError:
                async with state.mutation_lock:
                    if state.finished.is_set() or state.finalizing:
                        return
                    with self._mapping_lock:
                        current = self._runtime_states.get(state.runtime_id)
                    if current != (state.generation, state):
                        continue
                    try:
                        await self._flush_streaming(state)
                    except Exception:  # noqa: BLE001 - fail this runtime durably
                        logger.error("Failed to persist YaoYao group streaming message")
                        await self._finalize_state_locked(
                            state,
                            outcome="failed",
                            error="Streaming Agent message could not be persisted",
                            interrupt=True,
                        )
                continue
            try:
                if event is None:
                    return
                if not state.prompt_committed:
                    continue
                with self._mapping_lock:
                    current = self._runtime_states.get(event.runtime_id)
                if current != (event.generation, state):
                    continue
                state.event_index += 1
                async with state.mutation_lock:
                    try:
                        await self._apply_runtime_event(state, event)
                    except Exception:  # noqa: BLE001 - fail this runtime only
                        logger.error("Failed to process YaoYao group runtime event")
                        await self._finalize_state_locked(
                            state,
                            outcome="failed",
                            error="Gateway control event could not be persisted",
                            interrupt=True,
                        )
            except Exception:  # noqa: BLE001 - isolate this runtime only
                logger.error("Failed to lock YaoYao group runtime event")
                await self._finalize_state(
                    state,
                    outcome="failed",
                    error="Gateway control event could not be persisted",
                    interrupt=True,
                )
            finally:
                state.pending_events.task_done()

    async def _apply_runtime_event(
        self, state: _RuntimeState, event: _GatewayEvent
    ) -> None:
        event_type = event.event_type
        payload = event.payload
        if state.finalizing:
            return
        self._require_safe_control_payload(event_type, payload)
        if state.complete_seen and event_type != "session.info":
            return
        if event_type == "message.start":
            if state.reply_mode == "mentioned" or state.automatic_published:
                await self._persist_message_snapshot(state, status="streaming")
            return
        if event_type in {"message.delta", "reasoning.delta"}:
            text = payload.get("text")
            if not isinstance(text, str):
                raise GroupOrchestratorError("Gateway delta text is invalid")
            if event_type == "message.delta":
                state.content = self._append_bounded_text(
                    state.content, text, "content"
                )
            else:
                state.reasoning = self._append_bounded_text(
                    state.reasoning, text, "reasoning"
                )
            state.stream_dirty = True
            now = asyncio.get_running_loop().time()
            if state.last_stream_flush == 0.0 or (
                now - state.last_stream_flush >= STREAM_FLUSH_INTERVAL
            ):
                await self._flush_streaming(state)
            return
        if event_type.startswith("tool."):
            await self._publish_automatic_state(state)
            await self._flush_streaming(state)
            self._merge_tool_event(state, event_type, payload)
            await self._persist_message_snapshot(state, status="streaming")
            return
        if event_type == "approval.request":
            await self._publish_automatic_state(state)
            await self._flush_streaming(state)
            await self._persist_approval(state, payload)
            return
        if event_type == "clarify.request":
            await self._publish_automatic_state(state)
            await self._flush_streaming(state)
            await self._persist_clarification(state, payload)
            return
        if event_type == "clarify.expire":
            await self._publish_automatic_state(state)
            await self._flush_streaming(state)
            await self._expire_clarification(state, payload)
            return
        if event_type == "message.complete":
            if state.complete_seen:
                return
            await self._flush_streaming(state)
            await self._expire_pending_interactions(state)
            status = payload.get("status")
            outcomes = {
                "complete": "completed",
                "error": "failed",
                "interrupted": "interrupted",
            }
            outcome = outcomes.get(status) if isinstance(status, str) else None
            if outcome is None:
                outcome = "failed"
                state.terminal_error = "Invalid message.complete status"
            else:
                raw_error = payload.get("error")
                if outcome != "completed" and isinstance(raw_error, str):
                    state.terminal_error = self._bounded_error(raw_error)
            for tool in state.tool_state:
                if tool.get("status") == "running":
                    tool["status"] = "completed" if outcome == "completed" else "failed"
            final_text = payload.get("text", payload.get("content"))
            if isinstance(final_text, str):
                state.content = self._bounded_text(final_text, "content")
            final_reasoning = payload.get("reasoning")
            if isinstance(final_reasoning, str):
                state.reasoning = self._bounded_text(final_reasoning, "reasoning")
            automatic_unpublished = (
                state.reply_mode == "automatic" and not state.automatic_published
            )
            if state.reply_mode == "automatic":
                state.content = _sanitize_no_reply_text(state.content)
                state.reasoning = _sanitize_no_reply_text(state.reasoning)
            if (
                state.required_reply
                and outcome == "completed"
                and not state.content.strip()
                and not state.had_visible_interaction
            ):
                state.content = _HOST_FALLBACK_REPLY
            suppress_automatic = automatic_unpublished and (
                outcome != "completed" or not state.content.strip()
            )
            if suppress_automatic:
                state.content = ""
                state.reasoning = ""
                state.tool_state = []
            elif automatic_unpublished:
                state.automatic_published = True
            # GroupStore only accepts completed as a direct running-run
            # terminal upsert. Failure/interruption must first persist the
            # partial body as streaming; settle_run atomically maps both run
            # and response message to the final failed/interrupted status.
            message_status = "completed" if outcome == "completed" else "streaming"
            try:
                await self._persist_message_snapshot(
                    state,
                    status=message_status,
                    error=state.terminal_error,
                    publish=not suppress_automatic,
                )
                state.stream_dirty = False
            except Exception:
                await self._finalize_state_locked(
                    state,
                    outcome="failed",
                    error="Terminal Agent message could not be persisted",
                    interrupt=True,
                )
                return
            state.terminal_status = outcome
            state.complete_seen = True
            state.complete_index = state.event_index
            state.grace_task = asyncio.create_task(
                self._await_terminal_info(state),
                name=f"yaoyao-group-grace-{state.generation}",
            )
            return
        if event_type == "session.info":
            await self._flush_streaming(state)
            if (
                payload.get("running") is not False
                or not state.complete_seen
                or state.event_index <= state.complete_index
            ):
                return
            profile_name = payload.get("profile_name")
            if profile_name != state.profile:
                await self._finalize_state_locked(
                    state,
                    outcome="failed",
                    error="Final session profile is missing",
                    stored_session_id=state.session_stored_id,
                    interrupt=True,
                )
                return
            rotated = payload.get("stored_session_id")
            if not isinstance(rotated, str) or not rotated:
                await self._finalize_state_locked(
                    state,
                    outcome="failed",
                    error="Final session identity is missing",
                    stored_session_id=state.session_stored_id,
                    interrupt=True,
                )
                return
            actual_model = payload.get("model")
            actual_provider = payload.get("provider")
            if (
                isinstance(actual_model, str)
                and actual_model.strip()
                and isinstance(actual_provider, str)
                and actual_provider.strip()
            ):
                state.actual_model = actual_model.strip()
                state.actual_provider = actual_provider.strip()
            actual_reasoning = payload.get("reasoning_effort")
            if isinstance(actual_reasoning, str) and actual_reasoning.strip():
                state.actual_reasoning_effort = actual_reasoning.strip()
            actual_fast = payload.get("fast")
            if isinstance(actual_fast, bool):
                state.actual_fast_mode = actual_fast
            state.terminal_info_received.set()
            await self._finalize_state_locked(
                state,
                outcome=state.terminal_status or "failed",
                error=state.terminal_error,
                stored_session_id=rotated,
                interrupt=False,
            )
            return
        if event_type == "error":
            await self._flush_streaming(state)
            await self._finalize_state_locked(
                state,
                outcome="failed",
                error="Agent Gateway reported a failure",
                interrupt=True,
            )

    @staticmethod
    def _require_safe_control_payload(
        event_type: str, payload: Mapping[str, object]
    ) -> None:
        truncated = payload.get("truncatedFields")
        invalid = payload.get("invalidFields")
        truncated_fields = (
            {item for item in truncated if isinstance(item, str)}
            if isinstance(truncated, list)
            else set()
        )
        invalid_fields = (
            {item for item in invalid if isinstance(item, str)}
            if isinstance(invalid, list)
            else set()
        )
        if payload.get("transportInvalidPayload") is True and not invalid_fields:
            raise GroupOrchestratorError("Gateway control payload is invalid")
        critical: set[str]
        if event_type == "message.complete":
            critical = {"status", "text", "reasoning"}
        elif event_type == "session.info":
            critical = {"running", "stored_session_id", "profile_name"}
        elif event_type in {"approval.request", "clarify.request"}:
            if payload.get("transportTruncated") is True:
                raise GroupOrchestratorError(
                    "Gateway interaction request was truncated"
                )
            critical = {
                "request_id",
                "question",
                "command",
                "choices",
                "tool",
                "name",
            }
        elif event_type == "clarify.expire":
            critical = {"request_id"}
        elif event_type.startswith("tool."):
            critical = {"tool_id", "id"}
            if event_type == "tool.output_risk":
                critical |= {"risk", "redacted"}
        elif event_type == "error":
            critical = {"message", "error", "reason"}
        else:
            critical = set()
        if critical & (truncated_fields | invalid_fields):
            raise GroupOrchestratorError(
                "Gateway control payload lost a critical field"
            )
        if payload.get("transportInvalidPayload") is True:
            # Known-invalid non-critical diagnostics never justify trusting an
            # approval/tool/terminal control frame as authoritative.
            if event_type != "session.info":
                raise GroupOrchestratorError("Gateway control payload is invalid")
        if (
            payload.get("transportTruncated") is True
            and not truncated_fields
            and event_type
            in {
                "message.complete",
                "session.info",
                "approval.request",
                "clarify.request",
                "clarify.expire",
            }
        ):
            raise GroupOrchestratorError("Gateway control payload was replaced")

    async def _flush_streaming(self, state: _RuntimeState) -> None:
        if not state.stream_dirty:
            return
        if state.reply_mode == "automatic" and not state.automatic_published:
            return
        await self._persist_message_snapshot(state, status="streaming")
        state.stream_dirty = False
        state.last_stream_flush = asyncio.get_running_loop().time()

    async def _persist_message_snapshot(
        self,
        state: _RuntimeState,
        *,
        status: str,
        error: str = "",
        publish: bool | None = None,
    ) -> None:
        should_publish = (
            state.reply_mode == "mentioned" or state.automatic_published
            if publish is None
            else publish
        )
        content = (
            _sanitize_no_reply_text(state.content)
            if state.reply_mode == "automatic"
            else state.content
        )
        reasoning = (
            _sanitize_no_reply_text(state.reasoning)
            if state.reply_mode == "automatic"
            else state.reasoning
        )
        persisted = False
        for delay in (*_STORE_RETRY_DELAYS, None):
            try:
                await self._run_state_blocking(
                    state,
                    self.store.upsert_agent_message,
                    state.run_id,
                    content=content,
                    reasoning=reasoning,
                    tool_state=state.tool_state,
                    status=status,
                    error=error,
                    publish=should_publish,
                )
                persisted = True
                break
            except Exception:  # noqa: BLE001 - reconcile a lost Store reply
                try:
                    persisted = bool(
                        await self._run_state_blocking(
                            state,
                            self._terminal_message_is_durable,
                            state,
                            content=content,
                            reasoning=reasoning,
                            tool_state=state.tool_state,
                            status=status,
                            error=error,
                        )
                    )
                except Exception:  # noqa: BLE001 - retry the exact snapshot
                    persisted = False
                if persisted:
                    break
                if delay is None:
                    break
                await asyncio.sleep(delay)
        if not persisted:
            raise GroupOrchestratorError("Agent message snapshot is not durable")

    async def _publish_automatic_state(self, state: _RuntimeState) -> None:
        if state.reply_mode != "automatic" or state.automatic_published:
            return
        state.automatic_published = True
        await self._persist_message_snapshot(state, status="streaming", publish=True)
        state.stream_dirty = False
        state.last_stream_flush = asyncio.get_running_loop().time()

    @staticmethod
    def _bounded_text(value: str, field_name: str) -> str:
        try:
            size = len(value.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise GroupOrchestratorError(
                f"Gateway {field_name} is not valid UTF-8"
            ) from error
        if size > MAX_MESSAGE_BYTES:
            raise GroupOrchestratorError(
                f"Gateway {field_name} exceeds the group message limit"
            )
        return value

    @classmethod
    def _append_bounded_text(cls, existing: str, delta: str, field_name: str) -> str:
        return cls._bounded_text(existing + delta, field_name)

    def _merge_tool_event(
        self,
        state: _RuntimeState,
        event_type: str,
        payload: Mapping[str, object],
    ) -> None:
        if payload.get("transportInvalidPayload") is True:
            raise GroupOrchestratorError("Gateway tool payload is invalid")
        tool_id = payload.get("tool_id", payload.get("id"))
        tool_id = _required_string(tool_id, "tool.tool_id")
        if tool_id == _TOOL_TRUNCATION_ID:
            raise GroupOrchestratorError("Gateway tool id is reserved")
        if len(tool_id.encode("utf-8")) > _TOOL_TEXT_LIMIT:
            raise GroupOrchestratorError("Gateway tool id exceeds the limit")
        name_value = payload.get("name")
        name = (
            self._bounded_tool_text(name_value)
            if isinstance(name_value, str) and name_value
            else None
        )
        existing = self._tool_state_for_id(state, tool_id)
        tool: dict[str, object] = (
            dict(existing)
            if existing is not None
            else {"id": tool_id, "name": name or "unknown", "status": "running"}
        )
        if name is not None:
            tool["name"] = name
        if "args" in payload:
            tool["arguments"] = self._bounded_tool_value(payload["args"], "tool.args")
        elif "args_text" in payload:
            args_text = payload["args_text"]
            if not isinstance(args_text, str):
                raise GroupOrchestratorError("Gateway tool args_text is invalid")
            tool["arguments"] = self._bounded_tool_text(args_text)
        if event_type == "tool.output_risk":
            output_risk, risk_preview = self._project_output_risk(payload)
            tool["outputRisk"] = output_risk
            tool["preview"] = risk_preview
        preview = next(
            (
                value
                for key in ("summary", "context", "result_text", "args_text")
                if isinstance((value := payload.get(key)), str) and value
            ),
            None,
        )
        if preview is not None and event_type != "tool.output_risk":
            tool["preview"] = self._bounded_tool_text(preview)
        if "result" in payload:
            tool["result"] = self._bounded_tool_value(payload["result"], "tool.result")
        error = payload.get("error")
        if isinstance(error, str) and error:
            tool["error"] = self._bounded_tool_text(error)
        duration = payload.get("duration_s")
        if (
            isinstance(duration, (int, float))
            and not isinstance(duration, bool)
            and math.isfinite(duration)
            and duration >= 0
        ):
            tool["durationSeconds"] = float(duration)
        if event_type == "tool.complete":
            raw_status = payload.get("status")
            tool["status"] = (
                "failed"
                if tool.get("error")
                or raw_status in {"error", "failed", "cancelled", "canceled"}
                else "completed"
            )
        elif existing is None:
            tool["status"] = "running"
        self._upsert_tool_state(state, tool)

    @staticmethod
    def _bounded_tool_text(value: str, limit: int = _TOOL_TEXT_LIMIT) -> str:
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise GroupOrchestratorError(
                "Gateway tool text is not valid UTF-8"
            ) from error
        if len(encoded) <= limit:
            return value
        suffix = "..."
        prefix = encoded[: limit - len(suffix)]
        while prefix:
            try:
                return prefix.decode("utf-8") + suffix
            except UnicodeDecodeError:
                prefix = prefix[:-1]
        return suffix

    @classmethod
    def _bounded_tool_value(cls, value: object, field_name: str) -> object:
        copied = _strict_json_copy(value, field_name)
        encoded = json.dumps(
            copied,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        if len(encoded) <= _TOOL_VALUE_LIMIT:
            return copied
        return {"originalBytes": len(encoded), "truncated": True}

    @classmethod
    def _project_output_risk(
        cls, payload: Mapping[str, object]
    ) -> tuple[dict[str, object], str]:
        risk_value = payload.get("risk")
        findings_value = payload.get("findings")
        redacted = payload.get("redacted")
        if not isinstance(risk_value, str) or not risk_value:
            raise GroupOrchestratorError("Gateway tool output risk is invalid")
        if not isinstance(findings_value, list) or not all(
            isinstance(item, str) for item in findings_value
        ):
            raise GroupOrchestratorError("Gateway tool output findings are invalid")
        if not isinstance(redacted, bool):
            raise GroupOrchestratorError("Gateway tool output redaction is invalid")
        risk = cls._bounded_tool_text(risk_value, 256)
        findings = [
            cls._bounded_tool_text(item, 512)
            for item in findings_value[:_TOOL_FINDING_LIMIT]
        ]
        truncated = (
            len(findings_value) > len(findings)
            or risk != risk_value
            or any(
                projected != original
                for projected, original in zip(findings, findings_value)
            )
        )
        transport_truncated = payload.get("truncatedFields")
        if isinstance(transport_truncated, list) and "findings" in transport_truncated:
            truncated = True
        output_risk: dict[str, object] = {
            "risk": risk,
            "findings": findings,
            "redacted": redacted,
        }
        if truncated:
            output_risk["truncated"] = True
        preview = f"Output risk: {risk}"
        if findings:
            preview += "; findings: " + ", ".join(findings)
        preview += f"; redacted: {'true' if redacted else 'false'}"
        return output_risk, cls._bounded_tool_text(preview)

    @staticmethod
    def _tool_state_for_id(
        state: _RuntimeState, tool_id: str
    ) -> dict[str, object] | None:
        index = state.tool_indexes.get(tool_id)
        return None if index is None else state.tool_state[index]

    @classmethod
    def _upsert_tool_state(cls, state: _RuntimeState, tool: dict[str, object]) -> None:
        tool_id = str(tool["id"])
        index = state.tool_indexes.get(tool_id)
        candidate = [dict(item) for item in state.tool_state]
        if index is None:
            candidate.append(dict(tool))
        else:
            candidate[index] = dict(tool)
        candidate = cls._fit_tool_state(candidate, newest_tool_id=tool_id)
        state.tool_state = candidate
        state.tool_indexes = {
            str(item["id"]): offset for offset, item in enumerate(candidate)
        }

    @classmethod
    def _fit_tool_state(
        cls,
        candidate: list[dict[str, object]],
        *,
        newest_tool_id: str,
    ) -> list[dict[str, object]]:
        def encoded_size(items: list[dict[str, object]]) -> int:
            try:
                return len(
                    json.dumps(
                        items,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    ).encode("utf-8")
                )
            except (TypeError, ValueError, UnicodeEncodeError) as error:
                raise GroupOrchestratorError("Gateway tool state is invalid") from error

        if (
            len(candidate) <= _TOOL_COUNT_LIMIT
            and encoded_size(candidate) <= _TOOL_STATE_INTERNAL_LIMIT
        ):
            return candidate

        newest = next(
            (item for item in candidate if item.get("id") == newest_tool_id), None
        )
        if newest is None:
            raise GroupOrchestratorError("Gateway tool state merge lost its tool")
        retained = [
            item
            for item in candidate
            if item.get("id") not in {newest_tool_id, _TOOL_TRUNCATION_ID}
        ]
        marker = {
            "id": _TOOL_TRUNCATION_ID,
            "name": "hermes",
            "status": "completed",
            "preview": "Earlier tool state omitted by the group size limit",
        }
        fitted = [*retained, marker, newest]
        while (
            len(fitted) > _TOOL_COUNT_LIMIT
            or encoded_size(fitted) > _TOOL_STATE_INTERNAL_LIMIT
        ):
            if not retained:
                break
            retained.pop(0)
            fitted = [*retained, marker, newest]
        if (
            len(fitted) > _TOOL_COUNT_LIMIT
            or encoded_size(fitted) > _TOOL_STATE_INTERNAL_LIMIT
        ):
            compact_newest: dict[str, object] = {
                "id": newest_tool_id,
                "name": cls._bounded_tool_text(
                    str(newest.get("name") or "unknown"), 256
                ),
                "status": str(newest.get("status") or "running"),
                "preview": cls._bounded_tool_text(
                    str(newest.get("preview") or "Tool state truncated"), 4096
                ),
            }
            output_risk = newest.get("outputRisk")
            if isinstance(output_risk, Mapping):
                compact_newest["outputRisk"] = {
                    "risk": cls._bounded_tool_text(
                        str(output_risk.get("risk") or "unknown"), 256
                    ),
                    "findings": [
                        cls._bounded_tool_text(item, 512)
                        for item in output_risk.get("findings", [])[
                            :_TOOL_FINDING_LIMIT
                        ]
                        if isinstance(item, str)
                    ],
                    "redacted": output_risk.get("redacted") is True,
                    "truncated": True,
                }
            fitted = [marker, compact_newest]
        if encoded_size(fitted) > MAX_TOOL_STATE_BYTES:
            raise GroupOrchestratorError("Gateway tool state exceeds the limit")
        return fitted

    async def _store_retry(
        self,
        state: _RuntimeState,
        function: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        last_error: Exception | None = None
        for delay in (*_STORE_RETRY_DELAYS, None):
            try:
                return await self._run_state_blocking(state, function, *args, **kwargs)
            except Exception as error:  # noqa: BLE001 - exact Store APIs replay
                last_error = error
                if delay is None:
                    break
                await asyncio.sleep(delay)
        if last_error is None:
            raise GroupOrchestratorError("Store operation failed")
        raise last_error

    async def _persist_approval(
        self, state: _RuntimeState, payload: Mapping[str, object]
    ) -> None:
        if payload.get("transportInvalidPayload") is True:
            raise GroupOrchestratorError("Gateway approval payload is invalid")
        raw_choices = payload.get("choices")
        if raw_choices is None:
            choices = ["deny"]
        elif (
            not isinstance(raw_choices, list)
            or not raw_choices
            or not all(
                isinstance(choice, str) and choice in _APPROVAL_CHOICES
                for choice in raw_choices
            )
        ):
            raise GroupOrchestratorError("Gateway approval choices are invalid")
        else:
            choices = list(dict.fromkeys(raw_choices))
        safe_payload = dict(payload)
        safe_payload["choices"] = choices
        state.approval_ordinal += 1
        interaction_id = "approval-" + str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"{state.run_id}:{state.generation}:approval:{state.approval_ordinal}",
            )
        )
        interaction = await self._store_retry(
            state,
            self.store.create_gateway_interaction,
            state.run_id,
            kind="approval",
            gateway_interaction_id=interaction_id,
            payload=safe_payload,
        )
        if not isinstance(interaction, Mapping):
            raise GroupOrchestratorError("Stored approval is invalid")
        local_id = _required_string(interaction.get("id"), "interaction.id")
        state.had_visible_interaction = True
        state.pending_interaction_ids.add(local_id)

    async def _persist_clarification(
        self, state: _RuntimeState, payload: Mapping[str, object]
    ) -> None:
        if payload.get("transportInvalidPayload") is True:
            raise GroupOrchestratorError("Gateway clarification payload is invalid")
        request_id = _required_string(
            payload.get("request_id"), "clarification.request_id"
        )
        interaction = await self._store_retry(
            state,
            self.store.create_gateway_interaction,
            state.run_id,
            kind="clarification",
            gateway_interaction_id=request_id,
            payload=dict(payload),
        )
        if not isinstance(interaction, Mapping):
            raise GroupOrchestratorError("Stored clarification is invalid")
        local_id = _required_string(interaction.get("id"), "interaction.id")
        state.had_visible_interaction = True
        state.clarification_ids[request_id] = local_id
        state.pending_interaction_ids.add(local_id)

    async def _expire_clarification(
        self, state: _RuntimeState, payload: Mapping[str, object]
    ) -> None:
        request_id = _required_string(
            payload.get("request_id"), "clarification.request_id"
        )
        local_id = state.clarification_ids.get(request_id)
        if local_id is None:
            return
        await self._store_retry(state, self.store.expire_interaction, local_id)
        state.pending_interaction_ids.discard(local_id)

    async def _expire_pending_interactions(self, state: _RuntimeState) -> None:
        for interaction_id in tuple(sorted(state.pending_interaction_ids)):
            await self._store_retry(
                state, self.store.expire_interaction, interaction_id
            )
            state.pending_interaction_ids.discard(interaction_id)

    def _terminal_message_is_durable(
        self,
        state: _RuntimeState,
        *,
        content: str,
        reasoning: str,
        tool_state: list[dict[str, object]],
        status: str,
        error: str,
    ) -> bool:
        """Reconcile a lost Store reply without accepting another run's write."""

        run = self.store.get_run(state.run_id)
        if not isinstance(run, Mapping):
            return False
        response_message_id = run.get("responseMessageId")
        if not isinstance(response_message_id, str) or not response_message_id:
            return False
        if (
            run.get("id") != state.run_id
            or run.get("roomId") != state.room_id
            or run.get("agentId") != state.agent_id
            or run.get("runtimeSessionId") != state.runtime_id
            or run.get("status") not in {"running", "awaiting_input"}
        ):
            return False
        message = self.store.get_message(response_message_id)
        if not isinstance(message, Mapping):
            return False
        return (
            message.get("id") == response_message_id
            and message.get("roomId") == state.room_id
            and message.get("senderKind") == "agent"
            and message.get("senderId") == state.agent_id
            and message.get("content") == content
            and message.get("reasoning") == reasoning
            and message.get("toolState") == tool_state
            and message.get("status") == status
            and message.get("error") == error
        )

    async def _run_state_blocking(
        self,
        state: _RuntimeState,
        function: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        """Track a blocking call so shutdown never abandons its worker thread."""

        return await self._run_states_blocking([state], function, *args, **kwargs)

    @staticmethod
    async def _run_states_blocking(
        states: list[_RuntimeState],
        function: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        """Shield one worker call and expose it to every affected runtime."""

        task: asyncio.Task[object] = asyncio.create_task(
            asyncio.to_thread(function, *args, **kwargs)
        )
        unique_states = tuple({id(state): state for state in states}.values())
        for state in unique_states:
            state.inflight_calls.add(task)

        def finished(done: asyncio.Task[object]) -> None:
            for state in unique_states:
                state.inflight_calls.discard(done)

        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def _await_terminal_info(self, state: _RuntimeState) -> None:
        """Apply the grace timeout only after a terminal message.complete."""

        terminal_wait = asyncio.create_task(state.terminal_info_received.wait())
        finished_wait = asyncio.create_task(state.finished.wait())
        try:
            done, pending = await asyncio.wait(
                {terminal_wait, finished_wait},
                timeout=self._completion_timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for waiter in pending:
                waiter.cancel()
            if terminal_wait in done or finished_wait in done:
                return
            await self._finalize_state(
                state,
                outcome=(
                    state.terminal_status
                    if state.terminal_status in {"failed", "interrupted"}
                    else "interrupted"
                ),
                error=state.terminal_error or "Final session state timed out",
                interrupt=True,
            )
        finally:
            for waiter in (terminal_wait, finished_wait):
                if not waiter.done():
                    waiter.cancel()

    async def _finalize_state(
        self,
        state: _RuntimeState,
        *,
        outcome: str,
        error: str,
        interrupt: bool,
        stored_session_id: str | None = None,
    ) -> None:
        async with state.mutation_lock:
            await self._finalize_state_locked(
                state,
                outcome=outcome,
                error=error,
                interrupt=interrupt,
                stored_session_id=stored_session_id,
            )

    async def _finalize_state_locked(
        self,
        state: _RuntimeState,
        *,
        outcome: str,
        error: str,
        interrupt: bool,
        stored_session_id: str | None = None,
    ) -> None:
        async with state.finalize_lock:
            if state.finished.is_set():
                return
            state.finalizing = True
            current_task = asyncio.current_task()
            pending_calls = tuple(state.inflight_calls)
            if pending_calls:
                await asyncio.gather(*pending_calls, return_exceptions=True)
            gateway = self._required_gateway()
            if interrupt:
                try:
                    await self._run_state_blocking(
                        state, gateway.interrupt, state.runtime_id
                    )
                except Exception:  # noqa: BLE001 - settle remains mandatory
                    logger.exception("Failed to interrupt YaoYao group runtime")
            expected_stored = (
                state.session_stored_id
                if state.prompt_committed
                else state.expected_stored_id
            )
            rotated_stored = stored_session_id or state.session_stored_id
            settled = False
            for delay in (*_STORE_RETRY_DELAYS, None):
                try:
                    await self._run_state_blocking(
                        state,
                        self.store.settle_run,
                        state.run_id,
                        runtime_session_id=state.runtime_id,
                        expected_stored_session_id=expected_stored,
                        stored_session_id=rotated_stored,
                        outcome=outcome,
                        actual_model=state.actual_model,
                        actual_provider=state.actual_provider,
                        actual_reasoning_effort=state.actual_reasoning_effort,
                        actual_fast_mode=state.actual_fast_mode,
                        error=self._bounded_error(error),
                    )
                    settled = True
                    break
                except Exception:  # noqa: BLE001 - reconcile before retrying
                    if await self._run_is_durably_terminal(state.run_id):
                        settled = True
                        break
                    if delay is None:
                        logger.exception("Failed to settle YaoYao group runtime")
                        break
                    await asyncio.sleep(delay)
            if not settled:
                state.settle_error = GroupOrchestratorError(
                    "Durable runtime settlement failed"
                )
                return

            state.settle_error = None
            self._remove_runtime(state)
            try:
                await self._run_state_blocking(state, gateway.close, state.runtime_id)
            except Exception:  # noqa: BLE001 - durable state is already terminal
                logger.exception("Failed to close settled YaoYao group runtime")
            if outcome == "completed":
                try:
                    cascade = await self._run_state_blocking(
                        state, self.store.complete_cascade, state.run_id
                    )
                except Exception:  # noqa: BLE001 - source is already durably complete
                    logger.error("Pending YaoYao group cascade remains durable")
                    self.wake()
                else:
                    if (
                        isinstance(cascade, Mapping)
                        and isinstance(cascade.get("runCount"), int)
                        and not isinstance(cascade.get("runCount"), bool)
                        and cascade["runCount"] > 0
                    ):
                        self.wake()
            state.finished.set()
            state.terminal_info_received.set()
            if state.event_task is not None and state.event_task is not current_task:
                if not state.event_task.done():
                    state.event_task.cancel()
                await asyncio.gather(state.event_task, return_exceptions=True)
            if state.grace_task is not None and state.grace_task is not current_task:
                if not state.grace_task.done():
                    state.grace_task.cancel()
                await asyncio.gather(state.grace_task, return_exceptions=True)

    def _required_gateway(self) -> _Gateway:
        if self._gateway is None:
            raise GroupOrchestratorError("Gateway adapter is not started")
        return self._gateway

    @staticmethod
    def _bounded_error(value: str) -> str:
        encoded = value.encode("utf-8", errors="replace")
        if len(encoded) <= _ERROR_TEXT_LIMIT:
            return value
        shortened = encoded[: _ERROR_TEXT_LIMIT - 3]
        while shortened:
            try:
                return shortened.decode("utf-8") + "..."
            except UnicodeDecodeError:
                shortened = shortened[:-1]
        return "..."


__all__ = [
    "DEFAULT_COMPLETION_TIMEOUT",
    "DEFAULT_EVENT_QUEUE_SIZE",
    "GroupOrchestrator",
    "GroupOrchestratorError",
    "build_run_prompt",
]
