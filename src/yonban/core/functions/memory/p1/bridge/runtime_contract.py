"""P1 集群运行契约；值只来自上层 runtime_contract.json。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_BRIDGE_DIR = Path(__file__).resolve().parent
_CONTRACT_FILE = _BRIDGE_DIR.parent / "runtime_contract.json"
RUNTIME_CONTRACT: dict[str, Any] = json.loads(_CONTRACT_FILE.read_text(encoding="utf-8"))
CLUSTER_CONTRACT = str(RUNTIME_CONTRACT["cluster"]["id"])


def service_health(name: str) -> dict[str, Any]:
    return {
        "ok": True,
        "service": name,
        "contract": CLUSTER_CONTRACT,
        "runtimeRoot": str(_BRIDGE_DIR),
    }
