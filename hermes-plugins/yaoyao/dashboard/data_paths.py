"""Durable storage paths and one-time migration for the YaoYao plugin.

Plugin installers replace ``<profile_home>/plugins/yaoyao`` atomically. Runtime
state therefore lives under ``<profile_home>/plugin-data/yaoyao`` so installs,
updates, and removals cannot delete user data.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


DURABLE_DATA_SUBPATH = Path("plugin-data") / "yaoyao"
LEGACY_DATA_SUBPATH = Path("plugins") / "yaoyao" / "data"


@dataclass(frozen=True)
class DataPathStatus:
    data_root: Path
    ready: bool
    migrated: bool
    legacy_present: bool
    conflict: bool


def _has_entries(path: Path) -> bool:
    try:
        return next(path.iterdir(), None) is not None
    except FileNotFoundError:
        return False


def ensure_durable_data_root(profile_home: Path) -> DataPathStatus:
    """Move the legacy data directory once, without merging ambiguous trees.

    The durable tree is always the runtime authority once it exists. When both
    locations contain data, keep both untouched and report a conflict so the
    install coordinator can refuse a full plugin replace without making the
    application silently fall back to stale legacy state.
    """

    home = Path(profile_home).expanduser().resolve()
    durable = home / DURABLE_DATA_SUBPATH
    legacy = home / LEGACY_DATA_SUBPATH

    legacy_present = legacy.exists()
    if not legacy_present:
        return DataPathStatus(durable, True, False, False, False)

    if legacy.is_symlink() or durable.is_symlink():
        return DataPathStatus(durable, False, False, True, True)

    if durable.exists():
        if _has_entries(legacy):
            return DataPathStatus(durable, False, False, True, True)
        return DataPathStatus(durable, True, False, True, False)

    durable.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.replace(legacy, durable)
    return DataPathStatus(durable, True, True, False, False)
