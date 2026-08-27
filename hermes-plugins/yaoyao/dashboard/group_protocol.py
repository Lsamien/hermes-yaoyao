"""Shared protocol limits and input normalization for YaoYao Group Chat."""

from __future__ import annotations

import base64
import binascii
import re
import unicodedata
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)


PROTOCOL_VERSION = 12
MAX_AGENTS_PER_ROOM = 8
MAX_MESSAGE_BYTES = 64 * 1024
MAX_TOOL_STATE_BYTES = 256 * 1024
MAX_INTERACTION_PAYLOAD_BYTES = 64 * 1024
MAX_MESSAGE_PAGE_SIZE = 100
MAX_EVENT_BATCH_SIZE = 200
MAX_EVENT_FRAME_BYTES = 2 * 1024 * 1024
MAX_AGENT_DEPTH = 2
DEFAULT_MAX_REPLY_ROUNDS = 3
UNLIMITED_REPLY_ROUNDS = -1
MAX_FINITE_REPLY_ROUNDS = 100
MAX_AGENT_DISPLAY_NAME_LENGTH = 100
MAX_ROOM_INSTRUCTIONS_LENGTH = 4_000
MAX_ROOM_AVATAR_LENGTH = 512 * 1024
MAX_ROOM_CONCURRENCY = 3
MAX_PLUGIN_CONCURRENCY = 4
INITIAL_CONTEXT_MESSAGE_LIMIT = 50
CONTEXT_CHARACTER_BUDGET = 32_000
REASONING_EFFORTS = frozenset({
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"
})
ORCHESTRATION_MODES = frozenset({"free", "host"})
_ROOM_AVATAR_PATTERN = re.compile(
    r"^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$",
    re.IGNORECASE,
)

# These literals address the room as a whole and must never become a member
# display-name or alias target.  Keep the stable wire spelling for existing
# clients while accepting the localized spelling shown by the iOS UI.
ALL_MENTION_ALIASES = ("所有人", "all")
_ALL_MENTION_ALIAS_KEYS = frozenset(
    alias.casefold() for alias in ALL_MENTION_ALIASES
)

EVENT_TYPES = frozenset({
    "room.created",
    "room.updated",
    "room.deleted",
    "room.restored",
    "agent.created",
    "agent.updated",
    "agent.deleted",
    "agent.status",
    "message.upsert",
    "topic.updated",
    "topic.archived",
    "topic.restored",
    "room.activity",
    "interaction.requested",
    "interaction.resolved",
    "run.updated",
})


def limits_payload() -> dict[str, int]:
    """Return the public, lower-camel protocol limits advertised to clients."""
    return {
        "maxAgentsPerRoom": MAX_AGENTS_PER_ROOM,
        "maxMessageBytes": MAX_MESSAGE_BYTES,
        "maxToolStateBytes": MAX_TOOL_STATE_BYTES,
        "maxInteractionPayloadBytes": MAX_INTERACTION_PAYLOAD_BYTES,
        "maxMessagePageSize": MAX_MESSAGE_PAGE_SIZE,
        "maxEventBatchSize": MAX_EVENT_BATCH_SIZE,
        "maxEventFrameBytes": MAX_EVENT_FRAME_BYTES,
        "maxAgentDepth": MAX_AGENT_DEPTH,
        "defaultMaxReplyRounds": DEFAULT_MAX_REPLY_ROUNDS,
        "unlimitedReplyRoundsValue": UNLIMITED_REPLY_ROUNDS,
        "maxAgentDisplayNameLength": MAX_AGENT_DISPLAY_NAME_LENGTH,
        "maxRoomInstructionsLength": MAX_ROOM_INSTRUCTIONS_LENGTH,
        "maxRoomAvatarLength": MAX_ROOM_AVATAR_LENGTH,
        "maxRoomConcurrency": MAX_ROOM_CONCURRENCY,
        "maxPluginConcurrency": MAX_PLUGIN_CONCURRENCY,
    }


def normalize_room_avatar(value: object) -> str:
    """Validate a persisted custom avatar; an empty string selects auto mode."""
    if not isinstance(value, str):
        raise ValueError("avatar must be a data image URL or an empty string")
    normalized = value.strip()
    if not normalized:
        return ""
    if len(normalized) > MAX_ROOM_AVATAR_LENGTH:
        raise ValueError("avatar is too large")
    match = _ROOM_AVATAR_PATTERN.fullmatch(normalized)
    if match is None:
        raise ValueError("avatar must be a PNG, JPEG, or WebP data image URL")
    try:
        decoded = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("avatar contains invalid base64 data") from error
    if not decoded:
        raise ValueError("avatar image is empty")
    return normalized


class GroupModel(BaseModel):
    """Public request base with lower-camel aliases and forbidden extras."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class AgentSeed(GroupModel):
    profile: str = Field(min_length=1, max_length=100)
    node_id: str = Field(default="local", alias="nodeId", min_length=1, max_length=64)
    node_label: str = Field(default="", alias="nodeLabel", max_length=100)
    display_name: str | None = Field(
        default=None, alias="displayName", max_length=MAX_AGENT_DISPLAY_NAME_LENGTH
    )
    description: str = Field(default="", max_length=500)
    reply_without_mention: StrictBool = Field(
        default=False, alias="replyWithoutMention"
    )
    is_host: StrictBool = Field(default=False, alias="isHost")
    model: str | None = Field(default=None, max_length=4096)
    provider: str | None = Field(default=None, max_length=4096)
    reasoning_effort: str | None = Field(
        default=None, alias="reasoningEffort", max_length=32
    )
    fast_mode: StrictBool | None = Field(default=None, alias="fastMode")

    @field_validator("model", "provider", "reasoning_effort")
    @classmethod
    def normalize_optional_configuration(cls, value: str | None) -> str | None:
        return normalize_optional_agent_configuration(value)

    @field_validator("reasoning_effort")
    @classmethod
    def validate_reasoning_effort(cls, value: str | None) -> str | None:
        return validate_reasoning_override(value)

    @model_validator(mode="after")
    def validate_model_selection(self) -> "AgentSeed":
        validate_model_provider_pair(self.model, self.provider)
        return self

    @field_validator("display_name")
    @classmethod
    def reject_reserved_display_name(cls, value: str | None) -> str | None:
        return validate_optional_display_name(value)

    @field_validator("node_id")
    @classmethod
    def validate_node_id(cls, value: str) -> str:
        return normalize_node_id(value)

    @field_validator("node_label")
    @classmethod
    def normalize_node_label(cls, value: str) -> str:
        return " ".join(value.split())


class CreateRoomRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    name: str = Field(min_length=1, max_length=100)
    cwd: str = Field(default="", max_length=4096)
    instructions: str = Field(default="", max_length=MAX_ROOM_INSTRUCTIONS_LENGTH)
    avatar: str = Field(default="", max_length=MAX_ROOM_AVATAR_LENGTH)
    max_reply_rounds: StrictInt = Field(
        default=DEFAULT_MAX_REPLY_ROUNDS, alias="maxReplyRounds"
    )
    orchestration_mode: Literal["free", "host"] = Field(
        default="free", alias="orchestrationMode"
    )
    agents: list[AgentSeed] = Field(min_length=1, max_length=MAX_AGENTS_PER_ROOM)

    @field_validator("max_reply_rounds")
    @classmethod
    def validate_max_reply_rounds(cls, value: int) -> int:
        return normalize_max_reply_rounds(value)

    @field_validator("instructions")
    @classmethod
    def normalize_instructions(cls, value: str) -> str:
        return normalize_room_instructions(value)

    @field_validator("avatar")
    @classmethod
    def normalize_avatar(cls, value: str) -> str:
        return normalize_room_avatar(value)

    @model_validator(mode="after")
    def validate_unique_host(self) -> "CreateRoomRequest":
        if sum(agent.is_host for agent in self.agents) > 1:
            raise ValueError("Room may contain only one host Agent")
        return self


class UpdateRoomRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    name: str | None = Field(default=None, min_length=1, max_length=100)
    cwd: str | None = Field(default=None, max_length=4096)
    instructions: str | None = Field(
        default=None, max_length=MAX_ROOM_INSTRUCTIONS_LENGTH
    )
    avatar: str | None = Field(default=None, max_length=MAX_ROOM_AVATAR_LENGTH)
    max_reply_rounds: StrictInt | None = Field(default=None, alias="maxReplyRounds")
    orchestration_mode: Literal["free", "host"] | None = Field(
        default=None, alias="orchestrationMode"
    )

    @field_validator(
        "name", "cwd", "instructions", "avatar", "max_reply_rounds", "orchestration_mode",
        mode="before"
    )
    @classmethod
    def reject_explicit_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("field must not be null")
        return value

    @model_validator(mode="after")
    def require_change(self) -> "UpdateRoomRequest":
        if not (
            {"name", "cwd", "instructions", "avatar", "max_reply_rounds", "orchestration_mode"}
            & self.model_fields_set
        ):
            raise ValueError(
                "Room update requires name, cwd, instructions, avatar, maxReplyRounds, or orchestrationMode"
            )
        return self

    @field_validator("instructions")
    @classmethod
    def normalize_instructions(cls, value: str | None) -> str | None:
        return None if value is None else normalize_room_instructions(value)

    @field_validator("avatar")
    @classmethod
    def normalize_avatar(cls, value: str | None) -> str | None:
        return None if value is None else normalize_room_avatar(value)

    @field_validator("max_reply_rounds")
    @classmethod
    def validate_max_reply_rounds(cls, value: int | None) -> int | None:
        return None if value is None else normalize_max_reply_rounds(value)


class UpdateTopicRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    title: str | None = Field(default=None, min_length=1, max_length=120)
    pinned: StrictBool | None = None

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split()).strip()
        if not normalized:
            raise ValueError("title must not be blank")
        return normalized

    @model_validator(mode="after")
    def require_change(self) -> "UpdateTopicRequest":
        if not ({"title", "pinned"} & self.model_fields_set):
            raise ValueError("Topic update requires title or pinned")
        return self


class MarkTopicReadRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    through_seq: StrictInt = Field(alias="throughSeq", ge=0)


class AddAgentRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    profile: str = Field(min_length=1, max_length=100)
    node_id: str = Field(default="local", alias="nodeId", min_length=1, max_length=64)
    node_label: str = Field(default="", alias="nodeLabel", max_length=100)
    display_name: str | None = Field(
        default=None, alias="displayName", max_length=MAX_AGENT_DISPLAY_NAME_LENGTH
    )
    description: str = Field(default="", max_length=500)
    reply_without_mention: StrictBool = Field(
        default=False, alias="replyWithoutMention"
    )
    is_host: StrictBool = Field(default=False, alias="isHost")
    model: str | None = Field(default=None, max_length=4096)
    provider: str | None = Field(default=None, max_length=4096)
    reasoning_effort: str | None = Field(
        default=None, alias="reasoningEffort", max_length=32
    )
    fast_mode: StrictBool | None = Field(default=None, alias="fastMode")

    @field_validator("model", "provider", "reasoning_effort")
    @classmethod
    def normalize_optional_configuration(cls, value: str | None) -> str | None:
        return normalize_optional_agent_configuration(value)

    @field_validator("reasoning_effort")
    @classmethod
    def validate_reasoning_effort(cls, value: str | None) -> str | None:
        return validate_reasoning_override(value)

    @model_validator(mode="after")
    def validate_model_selection(self) -> "AddAgentRequest":
        validate_model_provider_pair(self.model, self.provider)
        return self

    @field_validator("display_name")
    @classmethod
    def reject_reserved_display_name(cls, value: str | None) -> str | None:
        return validate_optional_display_name(value)

    @field_validator("node_id")
    @classmethod
    def validate_node_id(cls, value: str) -> str:
        return normalize_node_id(value)

    @field_validator("node_label")
    @classmethod
    def normalize_node_label(cls, value: str) -> str:
        return " ".join(value.split())


class UpdateAgentRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    display_name: str | None = Field(
        default=None, alias="displayName", max_length=MAX_AGENT_DISPLAY_NAME_LENGTH
    )
    description: str | None = Field(default=None, max_length=500)
    enabled: StrictBool | None = None
    reply_without_mention: StrictBool | None = Field(
        default=None, alias="replyWithoutMention"
    )
    is_host: StrictBool | None = Field(default=None, alias="isHost")
    model: str | None = Field(default=None, max_length=4096)
    provider: str | None = Field(default=None, max_length=4096)
    reasoning_effort: str | None = Field(
        default=None, alias="reasoningEffort", max_length=32
    )
    fast_mode: StrictBool | None = Field(default=None, alias="fastMode")

    @field_validator(
        "display_name", "description", "enabled", "reply_without_mention", "is_host",
        mode="before"
    )
    @classmethod
    def reject_explicit_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("field must not be null")
        return value

    @field_validator("display_name")
    @classmethod
    def reject_reserved_display_name(cls, value: str | None) -> str | None:
        return validate_optional_display_name(value)

    @field_validator("model", "provider", "reasoning_effort")
    @classmethod
    def normalize_optional_configuration(cls, value: str | None) -> str | None:
        return normalize_optional_agent_configuration(value)

    @field_validator("reasoning_effort")
    @classmethod
    def validate_reasoning_effort(cls, value: str | None) -> str | None:
        return validate_reasoning_override(value)

    @model_validator(mode="after")
    def require_change(self) -> "UpdateAgentRequest":
        if not (
            {
                "display_name", "description", "enabled", "reply_without_mention",
                "is_host",
                "model", "provider", "reasoning_effort", "fast_mode",
            }
            & self.model_fields_set
        ):
            raise ValueError(
                "Agent update requires a mutable agent field"
            )
        model_fields = {"model", "provider"} & self.model_fields_set
        if model_fields and model_fields != {"model", "provider"}:
            raise ValueError("model and provider must be updated together")
        if model_fields:
            validate_model_provider_pair(self.model, self.provider)
        return self


def normalize_optional_agent_configuration(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        raise ValueError("configuration value must not be blank")
    return normalized


def normalize_node_id(value: str) -> str:
    normalized = value.strip().lower()
    if normalized == "local":
        return normalized
    try:
        canonical = str(UUID(normalized))
    except ValueError as error:
        raise ValueError("nodeId must be local or a canonical UUID") from error
    if canonical != normalized:
        raise ValueError("nodeId must be local or a canonical UUID")
    return canonical


def validate_reasoning_override(value: str | None) -> str | None:
    if value is not None and value not in REASONING_EFFORTS:
        raise ValueError("reasoningEffort is invalid")
    return value


def validate_model_provider_pair(model: str | None, provider: str | None) -> None:
    if (model is None) != (provider is None):
        raise ValueError("model and provider must both be set or both be null")


class RequestIDRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")


class SendMessageRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    client_message_id: UUID = Field(alias="clientMessageId")
    topic_id: UUID | None = Field(default=None, alias="topicId")
    content: str
    mention_agent_ids: list[UUID] = Field(
        alias="mentionAgentIds", max_length=MAX_AGENTS_PER_ROOM
    )

    @field_validator("content")
    @classmethod
    def validate_content_bytes(cls, value: str) -> str:
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("content must be valid UTF-8") from error
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise ValueError("content exceeds maximum size")
        if not value.strip():
            raise ValueError("content must not be blank")
        return value


class ApprovalRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    choice: Literal["once", "session", "always", "deny"]
    permanent: StrictBool = False

    @model_validator(mode="after")
    def validate_choice(self) -> "ApprovalRequest":
        if (self.choice == "always") != self.permanent:
            raise ValueError("permanent must be true exactly for choice=always")
        return self


class ClarificationRequest(GroupModel):
    request_id: UUID = Field(alias="requestId")
    response: str

    @field_validator("response")
    @classmethod
    def validate_response_bytes(cls, value: str) -> str:
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("response must be valid UTF-8") from error
        if not value.strip():
            raise ValueError("response must not be blank")
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise ValueError("response exceeds maximum size")
        return value


def normalize_room_name(value: str) -> str:
    """Return a trimmed room name within the protocol's character limit."""
    normalized = value.strip()
    if not 1 <= len(normalized) <= 100:
        raise ValueError("Room name must contain 1 to 100 characters")
    return normalized


def normalize_room_instructions(value: str) -> str:
    """Normalize optional multiline room rules without changing their structure."""
    if not isinstance(value, str):
        raise ValueError("Room instructions must be a string")
    normalized = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(normalized) > MAX_ROOM_INSTRUCTIONS_LENGTH:
        raise ValueError(
            f"Room instructions must contain at most {MAX_ROOM_INSTRUCTIONS_LENGTH} characters"
        )
    if any(
        unicodedata.category(character) == "Cc" and character not in {"\n", "\t"}
        for character in normalized
    ):
        raise ValueError("Room instructions contain unsupported control characters")
    return normalized


def normalize_display_name(value: str) -> tuple[str, str]:
    """Return a trimmed display name and its case-insensitive uniqueness key."""
    normalized = value.strip()
    if not 1 <= len(normalized) <= MAX_AGENT_DISPLAY_NAME_LENGTH:
        raise ValueError(
            f"Display name must contain 1 to {MAX_AGENT_DISPLAY_NAME_LENGTH} characters"
        )
    uniqueness_key = normalized.casefold()
    if uniqueness_key in _ALL_MENTION_ALIAS_KEYS:
        raise ValueError("Display name is reserved")
    return normalized, uniqueness_key


def is_reserved_mention_alias(value: str) -> bool:
    """Return whether a member-facing name would claim a room-wide Mention."""
    return value.strip().casefold() in _ALL_MENTION_ALIAS_KEYS


def validate_optional_display_name(value: str | None) -> str | None:
    """Reject only non-empty reserved names; blank still means use the fallback."""
    if value is not None and value.strip() and is_reserved_mention_alias(value):
        raise ValueError("Display name is reserved")
    return value


def normalize_max_reply_rounds(value: object) -> int:
    """Validate a finite reply-round ceiling or the explicit unlimited marker."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("maxReplyRounds must be an integer")
    if value == UNLIMITED_REPLY_ROUNDS:
        return value
    if not 1 <= value <= MAX_FINITE_REPLY_ROUNDS:
        raise ValueError(
            f"maxReplyRounds must be -1 or 1 to {MAX_FINITE_REPLY_ROUNDS}"
        )
    return value


def normalize_interaction_id(value: object) -> str:
    """Canonicalize an opaque Gateway interaction identity for URL use."""
    if not isinstance(value, str):
        raise ValueError("interactionId must be a string")
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > 200
        or any(unicodedata.category(character) == "Cc" for character in normalized)
    ):
        raise ValueError("interactionId is invalid")
    return normalized


def normalize_room_cwd(value: str) -> str:
    """Validate and canonicalize an optional room working directory."""
    if not isinstance(value, str):
        raise ValueError("Room cwd must be a string")
    if value and any(unicodedata.category(character) == "Cc" for character in value):
        raise ValueError("Room cwd must not contain control characters")
    normalized = value.strip()
    if not normalized:
        return ""
    path = Path(normalized)
    if not path.is_absolute():
        raise ValueError("Room cwd must be an absolute path")
    try:
        resolved = path.resolve()
        is_directory = resolved.is_dir()
    except (OSError, RuntimeError) as error:
        raise ValueError("Room cwd could not be resolved") from error
    if not is_directory:
        raise ValueError("Room cwd must exist and be a directory")
    return str(resolved)
