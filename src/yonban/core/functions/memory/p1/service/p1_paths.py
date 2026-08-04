"""P1 filesystem contract.

Code/resources live below the P1 package. Authoritative P1 settings and usage
state live below ``storage/p1``. ``data/p1`` is disposable runtime state only.
Host memory remains a read-only input and may be outside the repository.
"""
from __future__ import annotations

import os
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parent
P1_ROOT = SERVICE_ROOT.parent


def _discover_repo_root() -> Path:
    configured = os.environ.get("P1_REPO_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    for candidate in P1_ROOT.parents:
        if (candidate / "package.json").is_file() and (candidate / "src").is_dir():
            return candidate
    raise RuntimeError(f"P1 repository root not found from {P1_ROOT}")


def _env_path(name: str, fallback: Path) -> Path:
    value = os.environ.get(name, "").strip()
    return (Path(value).expanduser() if value else fallback).resolve()


REPO_ROOT = _discover_repo_root()
RESOURCE_ROOT = _env_path("P1_RESOURCE_DIR", P1_ROOT / "resources")
STORAGE_ROOT = _env_path("P1_STORAGE_DIR", REPO_ROOT / "storage" / "p1")
RUNTIME_ROOT = _env_path("P1_RUNTIME_DIR", REPO_ROOT / "data" / "p1")
HOST_DATA_ROOT = _env_path("BEILU_DATA_DIR", REPO_ROOT / "data")
HOST_USERS_ROOT = HOST_DATA_ROOT / "users"
SETTINGS_ROOT = STORAGE_ROOT / "settings"
USERS_ROOT = STORAGE_ROOT / "users"
RUNS_ROOT = STORAGE_ROOT / "runs"
EXPERIMENTS_ROOT = STORAGE_ROOT / "experiments"
MIGRATIONS_ROOT = STORAGE_ROOT / "migrations"


def _safe_segment(value: str, fallback: str) -> str:
    segment = str(value or fallback).strip()
    if not segment or segment in {".", ".."} or any(ch in segment for ch in ("/", "\\", "\x00")):
        raise ValueError(f"invalid P1 path segment: {value!r}")
    return segment


def user_state_root(username: str) -> Path:
    return USERS_ROOT / _safe_segment(username, "_default")


def char_state_root(username: str, char_name: str) -> Path:
    return user_state_root(username) / "characters" / _safe_segment(char_name, "_global")


def scope_state_root(username: str, char_name: str, chat_id: str, mode: str) -> Path:
    """Return the writable runtime-state root for one host window binding.

    Host memory remains shared at the character + window-layer read scope, but
    mutable P1 observations (novelty usage and experiment records) must not leak
    between two conversations/windows.  The host is authoritative for both the
    bound ``chat_id`` and ``mode``; P1 only preserves that four-dimensional
    identity in its own writable state tree.
    """
    normalized_mode = "code" if str(mode or "chat").strip().lower() == "ide" else str(mode or "chat").strip().lower()
    return (char_state_root(username, char_name)
            / "scopes"
            / _safe_segment(normalized_mode, "chat")
            / _safe_segment(chat_id, "_default"))


def user_memory_root(username: str, explicit_root: str | None = None) -> Path:
    if explicit_root:
        return Path(explicit_root).expanduser().resolve()
    return HOST_USERS_ROOT / _safe_segment(username, "_default")
