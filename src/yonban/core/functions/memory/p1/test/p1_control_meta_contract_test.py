from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from starlette.requests import Request


SERVICE_DIR = Path(__file__).resolve().parents[1] / "service"
sys.path.insert(0, str(SERVICE_DIR))

import p1_server as server  # noqa: E402


async def _receive_empty_json() -> dict[str, object]:
    return {"type": "http.request", "body": b"{}", "more_body": False}


async def _get_node_data() -> dict[str, object]:
    request = Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/getData",
        "raw_path": b"/getData",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 0),
        "server": ("127.0.0.1", 0),
    }, _receive_empty_json)

    original_get_user_config = server.get_user_config
    original_process_running = server._process_running
    original_warmup_snapshot = server._warmup_snapshot
    try:
        server.get_user_config = lambda _username: {**server.DEFAULTS, "engine": "node"}
        server._process_running = lambda _proc: False
        server._warmup_snapshot = lambda engine: {
            "state": "cold", "engine": engine, "readyForRecall": False,
        }
        return await server.get_data(request)
    finally:
        server.get_user_config = original_get_user_config
        server._process_running = original_process_running
        server._warmup_snapshot = original_warmup_snapshot


data = asyncio.run(_get_node_data())
control = next(item for item in data["meta"] if item["key"] == "copyJaccardThreshold")

assert server.DEFAULTS["copyJaccardThreshold"] == 0.7
assert data["copyJaccardThreshold"] == server.DEFAULTS["copyJaccardThreshold"]
assert control["type"] == "number"
assert control["scope"] == "node"
assert (control["min"], control["max"], control["step"]) == (0, 1, 0.01)
assert "[待实验定]" in control["desc"]
assert "copyJaccardThreshold" in data["metaScope"]["engineKeys"]
assert "copyJaccardThreshold" not in data["metaScope"]["commonKeys"]
assert all(item["key"] != "copyJaccardThreshold" for item in server._control_meta_for_engine("python"))

print(json.dumps({
    "pass": True,
    "key": control["key"],
    "default": data["copyJaccardThreshold"],
    "scope": control["scope"],
    "range": [control["min"], control["max"]],
    "step": control["step"],
}))
