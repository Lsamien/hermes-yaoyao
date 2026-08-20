"""Yaoyao plugin backend routes for files, settings, voice, and group chat.

Auto-mounted at /api/plugins/yaoyao/ by the dashboard plugin loader
(web_server.py:17277). HTTP routes run behind the dashboard's session-token
auth middleware just like core /api routes - no explicit auth dependency is
needed (see the kanban plugin_api.py docstring for the authoritative note).

Response field naming is camelCase to match iOS FileLibraryModels.swift
CodingKeys (itemId / messageId / displayName / contentType / ...). The
``message-files/query`` payload shape matches the existing ArchivedMessageFile
contract so iOS keeps working with only a path-string change.

This file is loaded by path as a standalone module (web_server.py:17256
spec_from_file_location), so it puts its own directory on sys.path and imports
its companions (store, poller) as top-level modules.
"""

from __future__ import annotations

import hashlib
import importlib.util
import logging
import os
import sys
import tempfile
import json
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from urllib.parse import quote

log = logging.getLogger("yaoyao.plugin_api")

# Make sibling modules importable when this file is loaded by path.
_THIS_DIR = str(Path(__file__).resolve().parent)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

import store  # noqa: E402
import poller  # noqa: E402
import voice_store  # noqa: E402


def _load_group_plugin_api():
    module_path = Path(_THIS_DIR) / "group_plugin_api.py"
    module_name = (
        "_hermes_yaoyao_group_api_"
        + hashlib.sha256(str(module_path).encode("utf-8")).hexdigest()[:24]
    )
    loaded = sys.modules.get(module_name)
    if loaded is not None:
        loaded_path = getattr(loaded, "__file__", None)
        if loaded_path is None or Path(loaded_path).resolve() != module_path.resolve():
            raise ImportError("Yaoyao group API module identity is invalid")
        return loaded

    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError("Unable to load Yaoyao group API")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


group_plugin_api = _load_group_plugin_api()
group_plugin_api.set_agent_name_resolver(
    lambda profile: str(store.load_agent_settings(profile).get("agentName") or "")
)


def _store_for(profile: Optional[str]):
    """Resolve the Store for ``profile`` (default if None). Raises 404 if the
    profile is unknown. Validates against the live profile set so a typo or a
    not-yet-created profile returns 404 instead of silently creating an empty
    data dir."""
    if not profile or profile == "default":
        return store.get_store(store.DEFAULT_DATA_ROOT)
    # Validate: the profile must exist on disk. Use profiles_to_serve to avoid
    # importing hermes_cli.profiles when not needed, but fall back to a path
    # check.
    try:
        from hermes_cli.profiles import profile_exists  # type: ignore

        if not profile_exists(profile):
            raise HTTPException(status_code=404, detail=f"unknown profile: {profile}")
    except HTTPException:
        raise
    except Exception:
        # hermes_cli not importable (standalone runtime): best-effort path check.
        data_root = store.data_root_for_profile(profile)
        if not data_root.parent.parent.parent.is_dir():  # <home>/plugins/yaoyao
            raise HTTPException(status_code=404, detail=f"unknown profile: {profile}")
    return store.get_store(store.data_root_for_profile(profile))


router = APIRouter()
router.include_router(group_plugin_api.router)

# Start the background archiver as soon as the module loads (the dashboard
# loader imports this file once at server startup). Idempotent.
try:
    poller.start()
except Exception:
    log.exception("yaoyao: poller failed to start (routes still serve existing data)")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class MessageFileQueryRequest(BaseModel):
    # Field names mirror iOS FileLibraryModels.swift MessageFileArchiveQueryRequest
    # CodingKeys: contextType / contextId / messageIds (camelCase).
    context_type: str = Field(default="session", alias="contextType")
    context_id: Optional[str] = Field(default=None, alias="contextId")
    message_ids: list[int] = Field(default_factory=list, alias="messageIds")

    model_config = {"populate_by_name": True}


class UploadBody(BaseModel):
    # Reserved for the future upload endpoint; kept here for schema stability.
    display_name: Optional[str] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _kind_of(item: dict) -> str:
    return store.infer_kind(item["displayName"], item["contentType"])


def _to_file_library_item(it: dict) -> dict:
    """Render an attachment row as an iOS FileLibraryItem-compatible payload.

    Field names match FileLibraryItem.CodingKeys (FileLibraryModels.swift):
    id / fileId / path / name / extension / mimeType / size / modifiedAt /
    exists / firstSeenAt / lastSeenAt / messageTimestamp / origins. The origin
    block matches FileLibraryOrigin.CodingKeys.
    """
    name = it["displayName"]
    ext = os.path.splitext(name)[1]  # includes the leading "."
    ts = it["discoveredAt"]
    sender = it.get("sender") or "agent"
    author_kind = "user" if sender == "user" else "agent"
    source_kind = "agent_generated" if sender == "agent" else "upload"
    event_kind = "generated" if sender == "agent" else "uploaded"
    session_id = it.get("sessionId") or ""
    origin = {
        "id": it["id"],
        "sourceKind": source_kind,
        "eventKind": event_kind,
        "userId": None,
        "username": "",
        "profile": "",
        "agent": "",
        "agentProfile": None,
        "agentDisplayName": None,
        "authorKind": author_kind,
        "authorId": None,
        "authorName": None,
        "contextType": "session",
        "sessionId": session_id,
        "sessionTitle": "",
        "roomId": "",
        "roomName": "",
        "messageId": str(it["sourceMessageId"])
        if it.get("sourceMessageId") is not None
        else "",
        "runId": "",
        "workspace": "",
        "originalPath": "",
        "observedAt": ts,
        "messageTimestamp": ts,
        "messageSequence": None,
        "messageOrdinal": None,
    }
    return {
        "id": it["id"],
        "fileId": None,
        "path": f"yaoyao-file-library://archive/{it['id']}?name={quote(name, safe='')}",
        "name": name,
        "extension": ext,
        "mimeType": it.get("contentType") or "application/octet-stream",
        "size": it.get("byteCount", 0),
        "modifiedAt": ts,
        "exists": True,
        "firstSeenAt": ts,
        "lastSeenAt": ts,
        "messageTimestamp": ts,
        "origins": [origin],
    }


@router.get("/profiles")
def list_profiles():
    """Profiles with an existing state.db (i.e. ones the poller watches).

    Returns ``[{name, label, isDefault}]``. Used by the dashboard's profile
    dropdown. ``default`` is always first when present.
    """
    pairs = poller._discover_profiles()
    out = []
    for name, home in pairs:
        agent_settings = store.load_agent_settings(name)
        agent_name = agent_settings["agentName"]
        out.append(
            {
                "name": name,
                "label": agent_name or ("默认" if name == "default" else name),
                "agentName": agent_name,
                "isDefault": name == "default",
            }
        )
    return {"profiles": out}


@router.get("/files")
def list_files(
    sender: Optional[str] = Query(None, description="agent | user"),
    kind: Optional[str] = Query(None, description="image | video | text | file"),
    session_id: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    profile: Optional[str] = Query(
        None, description="which agent's library to read (default if omitted)"
    ),
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[int] = Query(
        None, description="last item id seen, for pagination"
    ),
):
    """Page over the archive, newest first. Powers both iOS list and the dashboard tab.

    Each item is shaped as an iOS FileLibraryItem so the iOS list service can
    decode the response directly. ``profile`` selects which agent's library to
    read; omitted -> the default profile.
    """
    st = _store_for(profile)
    items, next_cursor, total = st.query_attachments(
        sender=sender,
        kind=kind,
        session_id=session_id,
        search=search,
        limit=limit,
        cursor=cursor,
    )
    return {
        "items": [_to_file_library_item(it) for it in items],
        "nextCursor": str(next_cursor) if next_cursor is not None else None,
        "total": total,
        "profile": profile or "default",
    }


@router.get("/stats")
def get_stats(
    profile: Optional[str] = Query(
        None, description="which agent's library to read (default if omitted)"
    ),
):
    """Archive summary: counts and total bytes for one profile."""
    return _store_for(profile).stats()


@router.get("/{item_id}")
def get_item(
    item_id: int,
    profile: Optional[str] = Query(
        None, description="which agent's library holds this item"
    ),
):
    att = _store_for(profile).get_attachment(item_id)
    if att is None:
        raise HTTPException(status_code=404, detail="attachment not found")
    return {**att, "kind": _kind_of(att)}


@router.get("/{item_id}/download")
def download_item(
    item_id: int,
    profile: Optional[str] = Query(
        None, description="which agent's library holds this item"
    ),
):
    """Stream the archived file body. Arbitrary extension; behind dashboard auth.

    The static /dashboard-plugins/<name>/<file> route rejects non-browser
    suffixes (.pdf/.zip/...) and is unauthenticated, so arbitrary file
    downloads must live here as a FileResponse under /api/plugins/yaoyao/.
    """
    st = _store_for(profile)
    att = st.get_attachment(item_id)
    if att is None:
        raise HTTPException(status_code=404, detail="attachment not found")
    storage_name = st.get_object_storage_name(att["objectSha256"])
    if storage_name is None:
        raise HTTPException(status_code=404, detail="object body missing")
    path = st.objects_dir / storage_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="object body not on disk")
    return FileResponse(
        path=str(path),
        filename=att["displayName"],
        media_type=att["contentType"] or "application/octet-stream",
    )


@router.post("/message-files/query")
def query_message_files(
    req: MessageFileQueryRequest,
    profile: Optional[str] = Query(
        None, description="which agent's library to read (default if omitted)"
    ),
):
    """Batch-resolve archived files for a set of message ids.

    Mirrors the legacy /api/hermes/file-library/message-files/query contract:
    request {contextType, contextId, messageIds}, response
    {messages: {<messageId>: [file, ...]}} where each file's fields match
    iOS ArchivedMessageFile (camelCase) so a path-string change is the only
    iOS delta needed.

    ``profile`` selects which agent's library to read; omitted -> the default
    profile. Read from the query string so iOS callers that route through the
    shared HermesRESTClient (which sends profile via the X-Hermes-Profile
    header) can pass it explicitly as a query item.
    """
    st = _store_for(profile)
    grouped = st.query_message_files(req.message_ids)
    out: dict[str, list[dict]] = {}
    for mid, files in grouped.items():
        out[str(mid)] = [
            {
                "itemId": f["id"],
                "messageId": str(f["sourceMessageId"])
                if f["sourceMessageId"] is not None
                else "",
                "ordinal": idx,
                "originalPath": "",
                "referencePath": f"/api/plugins/yaoyao/{f['id']}/download",
                "name": f["displayName"],
                "size": f["byteCount"],
                "mimeType": f["contentType"],
                "archiveStatus": "ready",
                "archivedAt": f["discoveredAt"],
                "availability": "archived",
            }
            for idx, f in enumerate(files)
        ]
    return {"messages": out}


@router.post("/rescan")
def rescan():
    """Force one immediate poll cycle (handy after a big agent run)."""
    try:
        poller.poll_now()
    except Exception:
        log.debug("rescan: poll_now failed", exc_info=True)
    return store.stats()


# ===========================================================================
# Agent display-name settings
#
# The profile id stays the stable routing key. ``agentName`` is an optional,
# per-profile presentation value used by Dashboard and Yaoyao clients.
#
#   GET /agent/settings?profile=<profile>
#   PUT /agent/settings?profile=<profile>  <- {"agentName": "..."}
# ===========================================================================


@router.get("/agent/settings")
def get_agent_settings(
    profile: Optional[str] = Query(
        None, description="Hermes profile (default if omitted)"
    ),
):
    """Read one profile's configured Agent display name."""
    _store_for(profile)
    return store.load_agent_settings(profile)


@router.put("/agent/settings")
def put_agent_settings(
    body: dict,
    profile: Optional[str] = Query(
        None, description="Hermes profile (default if omitted)"
    ),
):
    """Set or clear one profile's Agent display name."""
    _store_for(profile)
    try:
        return store.save_agent_settings(profile, body)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


# ===========================================================================
# iOS duplex voice settings
#
# Mirrors the yaoyao-webui ``ios-duplex-voice`` contract: one shared API key,
# a voice list (id + name), and the currently selected voice. The iOS app
# connects directly to the TTS provider (e.g. Volcano/doubao) for low-latency
# duplex voice; this plugin stores the configuration it downloads.
#
# Endpoints (matching yaoyao-webui's /api/app/duplex-voice/* shape):
#   GET  /voice/settings        -> {hasApiKey, voices, currentVoiceId, updatedAt}
#   PUT  /voice/settings        <- {apiKey?, voices, currentVoiceId}
#   GET  /voice/runtime         -> {apiKey, voices, currentVoiceId, updatedAt}
#   PUT  /voice/current-voice   <- {currentVoiceId}
# ===========================================================================


@router.get("/voice/settings")
def get_duplex_settings():
    """Public settings for the dashboard UI (apiKey masked as hasApiKey)."""
    return store.public_duplex_voice()


@router.put("/voice/settings")
def put_duplex_settings(body: dict):
    """Update duplex voice settings. Partial: omit apiKey to keep existing.
    Returns public settings (apiKey masked as hasApiKey), matching
    yaoyao-webui's saveSettings controller."""
    try:
        store.save_duplex_voice(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return store.public_duplex_voice()


@router.get("/voice/runtime")
def get_duplex_runtime():
    """Runtime settings for the iOS app (includes the real apiKey)."""
    return store.runtime_duplex_voice()


@router.put("/voice/current-voice")
def put_duplex_current_voice(body: dict):
    """Quick-switch the current voice without re-sending the full list.
    Returns {voices, currentVoiceId, updatedAt} (no apiKey fields), matching
    yaoyao-webui's saveCurrentVoice controller."""
    try:
        store.save_duplex_voice({"currentVoiceId": body.get("currentVoiceId")})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    s = store.load_duplex_voice()
    return {
        "voices": s["voices"],
        "currentVoiceId": s["currentVoiceId"],
        "updatedAt": s["updatedAt"],
    }


# ===========================================================================
# TTS provider settings (mirrors yaoyao-webui's /api/hermes/tts/settings/*)
# ===========================================================================


@router.get("/tts/settings")
def tts_list_settings():
    """List all configured TTS providers + the active one."""
    return voice_store.tts_list_settings()


@router.put("/tts/settings/active")
def tts_set_active(body: dict):
    try:
        return {"activeProvider": voice_store.tts_set_active(body.get("provider", ""))}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/tts/settings/{provider}")
def tts_save_provider(provider: str, body: dict):
    try:
        row = voice_store.tts_save_provider(
            provider, body.get("settings"), body.get("secrets")
        )
        # Optionally set active
        if "activeProvider" in body:
            voice_store.tts_set_active(body["activeProvider"])
        return {"setting": row, "activeProvider": voice_store.tts_get_active()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/tts/settings/{provider}")
def tts_delete_provider(provider: str):
    try:
        deleted = voice_store.tts_delete_provider(provider)
        return {
            "success": True,
            "deleted": deleted,
            "activeProvider": voice_store.tts_get_active(),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/tts/settings/{provider}/base-url-preset")
def tts_delete_base_url_preset(provider: str, url: str = Query(...)):
    row = voice_store.tts_delete_base_url_preset(provider, url)
    if row is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return {"success": True, "setting": row}


@router.delete("/tts/settings/{provider}/secret/{secret_name}")
def tts_clear_secret(provider: str, secret_name: str):
    try:
        row = voice_store.tts_clear_secret(provider, secret_name)
        if row is None:
            raise HTTPException(status_code=404, detail="provider not found")
        return {"success": True, "setting": row}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ===========================================================================
# STT provider settings (mirrors yaoyao-webui's /api/hermes/stt/settings/*)
# ===========================================================================


@router.get("/stt/settings")
def stt_list_settings():
    """List all configured STT providers + the active one."""
    return voice_store.stt_list_settings()


@router.put("/stt/settings/active")
def stt_set_active(body: dict):
    try:
        return {"activeProvider": voice_store.stt_set_active(body.get("provider", ""))}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/stt/settings/{provider}")
def stt_save_provider(provider: str, body: dict):
    try:
        row = voice_store.stt_save_provider(
            provider, body.get("settings"), body.get("secrets")
        )
        if "activeProvider" in body:
            voice_store.stt_set_active(body["activeProvider"])
        return {"setting": row, "activeProvider": voice_store.stt_get_active()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/stt/settings/{provider}")
def stt_delete_provider(provider: str):
    deleted = voice_store.stt_delete_provider(provider)
    return {
        "success": True,
        "deleted": deleted,
        "activeProvider": voice_store.stt_get_active(),
    }


@router.delete("/stt/settings/{provider}/base-url-preset")
def stt_delete_base_url_preset(provider: str, url: str = Query(...)):
    row = voice_store.stt_delete_base_url_preset(provider, url)
    if row is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return {"success": True, "setting": row}


@router.delete("/stt/settings/{provider}/secret/{secret_name}")
def stt_clear_secret(provider: str, secret_name: str):
    try:
        row = voice_store.stt_clear_secret(provider, secret_name)
        if row is None:
            raise HTTPException(status_code=404, detail="provider not found")
        return {"success": True, "setting": row}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ===========================================================================
# Provider info + probe
# ===========================================================================


@router.get("/voice/providers-info")
def get_providers_info():
    """Static provider metadata for the frontend picker."""
    return voice_store.provider_info()


class ProbeRequest(BaseModel):
    kind: str  # 'tts' | 'stt'
    provider: Optional[str] = None
    compatibility: Optional[str] = None  # 'openai-compatible' | 'manual'
    baseUrl: Optional[str] = None
    apiKey: Optional[str] = None


@router.post("/voice/probe")
def probe_provider(req: ProbeRequest):
    """Probe a TTS/STT provider's /models endpoint to validate connectivity.

    Mirrors yaoyao-webui's /api/voice/providers/probe. For 'manual' mode,
    just validates the baseUrl. For 'openai-compatible', fetches <baseUrl>/models.
    """
    import urllib.request
    import urllib.error

    compatibility = req.compatibility or "openai-compatible"
    base_url = (req.baseUrl or "").strip()

    if not base_url:
        raise HTTPException(status_code=400, detail="baseUrl is required")

    if not (base_url.startswith("http://") or base_url.startswith("https://")):
        raise HTTPException(status_code=400, detail="baseUrl must be http(s)")

    if compatibility == "manual":
        return {
            "ok": True,
            "models": [],
            "recommendedModel": "",
            "errorSummary": "",
            "manualModelAllowed": True,
            "normalizedBaseUrl": base_url,
        }

    # openai-compatible: fetch /models
    api_key = req.apiKey or ""
    url = base_url.rstrip("/") + "/models"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        request = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(request, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            data = json.loads(body)
            raw_models = data.get("data", []) if isinstance(data, dict) else []
            models = []
            for m in raw_models[:100]:
                mid = m.get("id", "") if isinstance(m, dict) else str(m)
                if not mid:
                    continue
                mid_lower = mid.lower()
                # TTS vs STT preference
                if req.kind == "tts":
                    pref = any(
                        k in mid_lower
                        for k in (
                            "tts",
                            "speech",
                            "audio",
                            "voice",
                            "playai",
                            "orpheus",
                        )
                    )
                else:
                    pref = any(
                        k in mid_lower
                        for k in ("whisper", "transcrib", "stt", "speech-to-text")
                    )
                models.append(
                    {
                        "id": mid,
                        "label": mid,
                        "capability": "preferred" if pref else "other",
                    }
                )
            # Sort: preferred first
            models.sort(key=lambda m: 0 if m["capability"] == "preferred" else 1)
            recommended = models[0]["id"] if models else ""
            return {
                "ok": True,
                "models": models,
                "recommendedModel": recommended,
                "errorSummary": "",
                "manualModelAllowed": True,
                "normalizedBaseUrl": base_url,
            }
    except urllib.error.HTTPError as e:
        return {
            "ok": False,
            "models": [],
            "recommendedModel": "",
            "errorSummary": f"HTTP {e.code}",
            "errorDetails": e.read().decode("utf-8", errors="replace")[:500],
            "manualModelAllowed": True,
            "normalizedBaseUrl": base_url,
        }
    except Exception as e:
        return {
            "ok": False,
            "models": [],
            "recommendedModel": "",
            "errorSummary": str(e)[:200],
            "manualModelAllowed": True,
            "normalizedBaseUrl": base_url,
        }
