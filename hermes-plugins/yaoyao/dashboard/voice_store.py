"""TTS + STT provider settings store for the yaoyao plugin.

Mirrors yaoyao-webui's tts-settings-store.ts and stt-settings-store.ts:
- Multiple providers per profile, each with settings (baseUrl/model/voice/...)
  + secrets (apiKey).
- An "active provider" selection.
- baseUrl presets (recently used base URLs per provider).
- Secrets are masked as "[stored]" in public responses.

Storage: a single JSON file at
``<profile_home>/plugin-data/yaoyao/voice_providers.json`` (not SQLite - the
data is small and write frequency is low). The structure matches
yaoyao-webui's DB rows so the data is interchangeable.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from typing import Any, Optional

from store import DATA_ROOT, _ensure_dirs

log = logging.getLogger("yaoyao.voice_store")

_VOICE_PROVIDERS_FILE = DATA_ROOT / "voice_providers.json"
_VOICE_LOCK = threading.Lock()

STORED_MARKER = "[stored]"
MAX_TEXT_LENGTH = 2000
MAX_BASE_URL_PRESETS = 20
MAX_PROMPT_LENGTH = 1000
MAX_API_KEY_LENGTH = 4000

# ---------------------------------------------------------------------------
# Provider registries
# ---------------------------------------------------------------------------

TTS_PROVIDERS = ["edge", "openai", "custom", "mimo", "doubao"]
TTS_PROVIDER_LABELS = {
    "edge": "Edge TTS",
    "openai": "OpenAI TTS",
    "custom": "Custom TTS",
    "mimo": "MiMo TTS",
    "doubao": "Doubao TTS",
}
TTS_SETTINGS_KEYS = [
    "baseUrl", "baseUrlPresets", "model", "voice", "rate", "pitch",
    "authMode", "voiceMode", "voiceDesignDesc", "voiceCloneFormat", "stylePrompt",
]
TTS_SECRET_KEYS = ["apiKey"]

STT_STORED_PROVIDERS = ["openai", "custom", "doubao"]
STT_ACTIVE_PROVIDERS = ["browser"] + STT_STORED_PROVIDERS
STT_PROVIDER_LABELS = {
    "openai": "OpenAI STT",
    "custom": "Custom STT",
    "doubao": "Doubao STT",
    "browser": "Browser STT",
}
STT_SETTINGS_KEYS = ["baseUrl", "baseUrlPresets", "model", "language", "prompt", "audioTranscode"]
STT_SECRET_KEYS = ["apiKey"]

# Default provider configurations (used when no saved config exists).
_DEFAULT_TTS_PROVIDER_CONFIGS: dict[str, dict[str, Any]] = {
    "edge": {"voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%", "pitch": "+0Hz"},
    "openai": {"baseUrl": "https://api.openai.com/v1", "model": "tts-1", "voice": "alloy"},
    "custom": {"baseUrl": "", "model": "tts-1", "voice": "alloy"},
    "mimo": {"baseUrl": "", "model": "mimo-v2.5-tts", "voice": "冰糖"},
    "doubao": {"baseUrl": "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
               "model": "seed-tts-2.0", "voice": "zh_female_xiaohe_uranus_bigtts"},
}

_DEFAULT_STT_PROVIDER_CONFIGS: dict[str, dict[str, Any]] = {
    "openai": {"baseUrl": "https://api.openai.com/v1", "model": "whisper-1", "language": ""},
    "custom": {"baseUrl": "", "model": "whisper-1", "language": ""},
    "doubao": {"baseUrl": "", "model": "", "language": ""},
}

# ---------------------------------------------------------------------------
# File-level read / write
# ---------------------------------------------------------------------------

def _default_data() -> dict[str, Any]:
    return {
        "tts": {
            "activeProvider": "edge",
            "providers": {},
        },
        "stt": {
            "activeProvider": "browser",
            "providers": {},
        },
    }


def _load_all() -> dict[str, Any]:
    data = _default_data()
    try:
        if _VOICE_PROVIDERS_FILE.is_file():
            saved = json.loads(_VOICE_PROVIDERS_FILE.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                _deep_merge(data, saved)
    except Exception as e:
        log.warning("voice providers load failed: %s", e)
    return data


def _save_all(data: dict[str, Any]) -> None:
    _ensure_dirs()
    with _VOICE_LOCK:
        _VOICE_PROVIDERS_FILE.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )


def _deep_merge(base: dict, overlay: dict) -> None:
    for k, v in overlay.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v


# ---------------------------------------------------------------------------
# Settings / secrets sanitization
# ---------------------------------------------------------------------------

def _sanitize_settings(settings: Any, allowed_keys: list[str]) -> dict[str, Any]:
    if not isinstance(settings, dict):
        return {}
    out: dict[str, Any] = {}
    for k in allowed_keys:
        if k not in settings:
            continue
        v = settings[k]
        if k == "baseUrlPresets":
            if isinstance(v, list):
                presets: list[str] = []
                seen: set[str] = set()
                for url in v:
                    if isinstance(url, str) and url not in seen:
                        presets.append(url)
                        seen.add(url)
                    if len(presets) >= MAX_BASE_URL_PRESETS:
                        break
                out[k] = presets
            continue
        if not isinstance(v, str):
            continue
        max_len = MAX_PROMPT_LENGTH if k == "prompt" else MAX_TEXT_LENGTH
        v = v.strip()
        if v and len(v) <= max_len:
            out[k] = v
    return out


def _sanitize_secrets(secrets: Any, allowed_keys: list[str]) -> dict[str, str]:
    if not isinstance(secrets, dict):
        return {}
    out: dict[str, str] = {}
    for k in allowed_keys:
        v = secrets.get(k)
        if isinstance(v, str):
            v = v.strip()
            if v and v != STORED_MARKER and len(v) <= MAX_API_KEY_LENGTH:
                out[k] = v
    return out


def _mask_secrets(secrets: dict[str, str]) -> dict[str, str]:
    return {k: (STORED_MARKER if v else "") for k, v in secrets.items()}


def _merge_settings(existing: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for k, v in new.items():
        if k == "baseUrlPresets":
            presets = list(merged.get("baseUrlPresets", []))
            if isinstance(v, list):
                for url in v:
                    if isinstance(url, str) and url not in presets:
                        presets.insert(0, url)
                    if len(presets) >= MAX_BASE_URL_PRESETS:
                        break
            merged["baseUrlPresets"] = presets[:MAX_BASE_URL_PRESETS]
        else:
            merged[k] = v
    # If baseUrl is set and not in presets, add it.
    base_url = merged.get("baseUrl", "")
    if base_url and base_url not in merged.get("baseUrlPresets", []):
        presets = merged.get("baseUrlPresets", [])
        presets.insert(0, base_url)
        merged["baseUrlPresets"] = presets[:MAX_BASE_URL_PRESETS]
    return merged


def _merge_secrets(existing: dict[str, str], new: dict[str, str]) -> dict[str, str]:
    merged = dict(existing)
    for k, v in new.items():
        merged[k] = v
    return merged


# ---------------------------------------------------------------------------
# Provider row helpers
# ---------------------------------------------------------------------------

def _provider_row(kind: str, provider: str, data: dict, include_secrets: bool) -> dict[str, Any]:
    """Build a provider row for the API response."""
    section = data[kind]
    providers = section.get("providers", {})
    stored = providers.get(provider, {})
    defaults = _DEFAULT_TTS_PROVIDER_CONFIGS if kind == "tts" else _DEFAULT_STT_PROVIDER_CONFIGS
    default_cfg = defaults.get(provider, {})

    settings = dict(default_cfg)
    settings.update(stored.get("settings", {}))

    raw_secrets = stored.get("secrets", {})
    secrets = _mask_secrets(raw_secrets) if not include_secrets else dict(raw_secrets)

    now = int(time.time() * 1000)
    return {
        "profile": "default",
        "provider": provider,
        "settings": settings,
        "secrets": secrets,
        "createdAt": stored.get("createdAt", 0),
        "updatedAt": stored.get("updatedAt", now),
    }


def _list_provider_rows(kind: str, data: dict, include_secrets: bool) -> list[dict[str, Any]]:
    providers = data[kind].get("providers", {})
    provider_list = TTS_PROVIDERS if kind == "tts" else STT_STORED_PROVIDERS
    rows: list[dict[str, Any]] = []
    for p in provider_list:
        if p in providers:
            rows.append(_provider_row(kind, p, data, include_secrets))
    return rows


# ---------------------------------------------------------------------------
# TTS settings API
# ---------------------------------------------------------------------------

def tts_list_settings() -> dict[str, Any]:
    data = _load_all()
    active = data["tts"].get("activeProvider", "edge")
    # If only one non-edge provider is configured, prefer it.
    configured = list(data["tts"].get("providers", {}).keys())
    if active == "edge" and len(configured) == 1 and configured[0] != "edge":
        active = configured[0]
    return {
        "settings": _list_provider_rows("tts", data, include_secrets=False),
        "activeProvider": active,
    }


def tts_get_active() -> str:
    return _load_all()["tts"].get("activeProvider", "edge")


def tts_set_active(provider: str) -> str:
    if provider not in TTS_PROVIDERS:
        raise ValueError(f"unknown TTS provider: {provider}")
    data = _load_all()
    data["tts"]["activeProvider"] = provider
    _save_all(data)
    return provider


def tts_get_provider(provider: str, *, include_secrets: bool = False) -> Optional[dict[str, Any]]:
    if provider not in TTS_PROVIDERS:
        return None
    data = _load_all()
    return _provider_row("tts", provider, data, include_secrets)


def tts_save_provider(provider: str, settings: Any, secrets: Any) -> dict[str, Any]:
    if provider not in TTS_PROVIDERS:
        raise ValueError(f"unknown TTS provider: {provider}")
    data = _load_all()
    providers = data["tts"].setdefault("providers", {})
    existing = providers.get(provider, {})
    existing_settings = dict(existing.get("settings", {}))
    existing_settings.update(_DEFAULT_TTS_PROVIDER_CONFIGS.get(provider, {}))
    clean_settings = _sanitize_settings(settings, TTS_SETTINGS_KEYS)
    merged_settings = _merge_settings(existing_settings, clean_settings)
    clean_secrets = _sanitize_secrets(secrets, TTS_SECRET_KEYS)
    merged_secrets = _merge_secrets(existing.get("secrets", {}), clean_secrets)

    now = int(time.time() * 1000)
    providers[provider] = {
        "settings": merged_settings,
        "secrets": merged_secrets,
        "createdAt": existing.get("createdAt", now),
        "updatedAt": now,
    }
    _save_all(data)
    return _provider_row("tts", provider, data, include_secrets=False)


def tts_delete_provider(provider: str) -> bool:
    if provider == "edge":
        raise ValueError("edge provider cannot be deleted")
    data = _load_all()
    providers = data["tts"].get("providers", {})
    if provider not in providers:
        return False
    del providers[provider]
    if data["tts"].get("activeProvider") == provider:
        data["tts"]["activeProvider"] = "edge"
    _save_all(data)
    return True


def tts_delete_base_url_preset(provider: str, url: str) -> Optional[dict[str, Any]]:
    data = _load_all()
    providers = data["tts"].get("providers", {})
    stored = providers.get(provider, {})
    settings = stored.get("settings", {})
    presets = settings.get("baseUrlPresets", [])
    settings["baseUrlPresets"] = [u for u in presets if u != url]
    if settings.get("baseUrl") == url:
        settings["baseUrl"] = ""
    stored["settings"] = settings
    providers[provider] = stored
    _save_all(data)
    return _provider_row("tts", provider, data, include_secrets=False)


def tts_clear_secret(provider: str, secret_name: str) -> Optional[dict[str, Any]]:
    if secret_name != "apiKey":
        raise ValueError(f"unknown secret: {secret_name}")
    data = _load_all()
    providers = data["tts"].get("providers", {})
    stored = providers.get(provider, {})
    secrets = stored.get("secrets", {})
    secrets.pop(secret_name, None)
    stored["secrets"] = secrets
    providers[provider] = stored
    _save_all(data)
    return _provider_row("tts", provider, data, include_secrets=False)


# ---------------------------------------------------------------------------
# STT settings API
# ---------------------------------------------------------------------------

def stt_list_settings() -> dict[str, Any]:
    data = _load_all()
    active = data["stt"].get("activeProvider", "browser")
    return {
        "settings": _list_provider_rows("stt", data, include_secrets=False),
        "activeProvider": active,
    }


def stt_get_active() -> str:
    return _load_all()["stt"].get("activeProvider", "browser")


def stt_set_active(provider: str) -> str:
    if provider not in STT_ACTIVE_PROVIDERS:
        raise ValueError(f"unknown STT provider: {provider}")
    data = _load_all()
    data["stt"]["activeProvider"] = provider
    _save_all(data)
    return provider


def stt_get_provider(provider: str, *, include_secrets: bool = False) -> Optional[dict[str, Any]]:
    if provider not in STT_STORED_PROVIDERS:
        return None
    data = _load_all()
    return _provider_row("stt", provider, data, include_secrets)


def stt_save_provider(provider: str, settings: Any, secrets: Any) -> dict[str, Any]:
    if provider not in STT_STORED_PROVIDERS:
        raise ValueError(f"unknown STT provider: {provider}")
    data = _load_all()
    providers = data["stt"].setdefault("providers", {})
    existing = providers.get(provider, {})
    existing_settings = dict(existing.get("settings", {}))
    existing_settings.update(_DEFAULT_STT_PROVIDER_CONFIGS.get(provider, {}))
    clean_settings = _sanitize_settings(settings, STT_SETTINGS_KEYS)
    # audioTranscode only accepts 'ffmpeg' or 'none'
    if "audioTranscode" in clean_settings:
        if clean_settings["audioTranscode"] not in ("ffmpeg", "none"):
            del clean_settings["audioTranscode"]
    merged_settings = _merge_settings(existing_settings, clean_settings)
    clean_secrets = _sanitize_secrets(secrets, STT_SECRET_KEYS)
    merged_secrets = _merge_secrets(existing.get("secrets", {}), clean_secrets)

    now = int(time.time() * 1000)
    providers[provider] = {
        "settings": merged_settings,
        "secrets": merged_secrets,
        "createdAt": existing.get("createdAt", now),
        "updatedAt": now,
    }
    _save_all(data)
    return _provider_row("stt", provider, data, include_secrets=False)


def stt_delete_provider(provider: str) -> bool:
    data = _load_all()
    providers = data["stt"].get("providers", {})
    if provider not in providers:
        return False
    del providers[provider]
    if data["stt"].get("activeProvider") == provider:
        data["stt"]["activeProvider"] = "browser"
    _save_all(data)
    return True


def stt_delete_base_url_preset(provider: str, url: str) -> Optional[dict[str, Any]]:
    data = _load_all()
    providers = data["stt"].get("providers", {})
    stored = providers.get(provider, {})
    settings = stored.get("settings", {})
    presets = settings.get("baseUrlPresets", [])
    settings["baseUrlPresets"] = [u for u in presets if u != url]
    if settings.get("baseUrl") == url:
        settings["baseUrl"] = ""
    stored["settings"] = settings
    providers[provider] = stored
    _save_all(data)
    return _provider_row("stt", provider, data, include_secrets=False)


def stt_clear_secret(provider: str, secret_name: str) -> Optional[dict[str, Any]]:
    if secret_name != "apiKey":
        raise ValueError(f"unknown secret: {secret_name}")
    data = _load_all()
    providers = data["stt"].get("providers", {})
    stored = providers.get(provider, {})
    secrets = stored.get("secrets", {})
    secrets.pop(secret_name, None)
    stored["secrets"] = secrets
    providers[provider] = stored
    _save_all(data)
    return _provider_row("stt", provider, data, include_secrets=False)


# ---------------------------------------------------------------------------
# Provider info (for the frontend provider picker)
# ---------------------------------------------------------------------------

def provider_info() -> dict[str, Any]:
    """Static info about all providers: labels, settings keys, needs-key flags."""
    return {
        "tts": {
            "providers": [
                {
                    "id": p,
                    "label": TTS_PROVIDER_LABELS[p],
                    "settingsKeys": TTS_SETTINGS_KEYS,
                    "secretKeys": TTS_SECRET_KEYS,
                    "needsKey": p != "edge",
                    "defaults": _DEFAULT_TTS_PROVIDER_CONFIGS.get(p, {}),
                }
                for p in TTS_PROVIDERS
            ],
        },
        "stt": {
            "providers": [
                {
                    "id": p,
                    "label": STT_PROVIDER_LABELS[p],
                    "settingsKeys": STT_SETTINGS_KEYS,
                    "secretKeys": STT_SECRET_KEYS,
                    "needsKey": p != "browser",
                    "defaults": _DEFAULT_STT_PROVIDER_CONFIGS.get(p, {}),
                }
                for p in STT_ACTIVE_PROVIDERS if p in STT_PROVIDER_LABELS
            ],
        },
    }
