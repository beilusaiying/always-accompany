from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from starlette.requests import Request


SERVICE_DIR = Path(__file__).resolve().parents[1] / "service"
sys.path.insert(0, str(SERVICE_DIR))

import p1_server as server  # noqa: E402


def _request(body: dict[str, Any]) -> Request:
    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": encoded, "more_body": False}

    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/runP1",
        "raw_path": b"/runP1",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json; charset=utf-8")],
        "client": ("127.0.0.1", 0),
        "server": ("127.0.0.1", 0),
    }, receive)


def _body(**mode_fields: Any) -> dict[str, Any]:
    return {
        "inputText": "mode boundary contract",
        "username": "mode-test-user",
        "charName": "mode-test-char",
        "chatId": "mode-test-chat",
        "historyChatId": "mode-test-chat",
        "chatHistory": [],
        **mode_fields,
    }


async def _run() -> dict[str, Any]:
    calls: dict[str, list[Any]] = {
        "warmup": [],
        "cluster": [],
        "scope": [],
        "node": [],
        "runLog": [],
    }
    original = {
        "get_user_config": server.get_user_config,
        "ensure_recall_warmup": server._ensure_recall_warmup,
        "ensure_cluster": server._ensure_cluster,
        "scope_state_root": server.scope_state_root,
        "node_call": server._node_call,
        "append_run_log": server._append_run_log,
    }

    async def fake_warmup(engine: str, _cfg: dict[str, Any]) -> dict[str, Any]:
        calls["warmup"].append(engine)
        return {"state": "ready", "engine": engine, "readyForRecall": True}

    def fake_cluster() -> None:
        calls["cluster"].append(True)

    with tempfile.TemporaryDirectory(prefix="p1-mode-boundary-") as temp_dir:
        state_base = Path(temp_dir) / "state-must-not-be-created"

        def fake_scope(username: str, char_name: str, chat_id: str, mode: str) -> Path:
            calls["scope"].append({
                "username": username,
                "charName": char_name,
                "chatId": chat_id,
                "mode": mode,
            })
            return state_base / mode / chat_id

        def fake_node_call(payload: dict[str, Any], timeout_sec: float = 60) -> dict[str, Any]:
            calls["node"].append({**payload, "_timeout": timeout_sec})
            return {
                "success": True,
                "p1_act": [],
                "recalledRecords": [],
                "directionWords": [],
                "trace": {
                    "request": {
                        "mode": payload["mode"],
                        "historyChatId": payload["historyChatId"],
                        "requestScope": {"mode": payload["mode"]},
                    },
                },
            }

        def fake_run_log(
            entry: dict[str, Any], _cfg: dict[str, Any], *, should_write: bool = True,
        ) -> dict[str, Any]:
            calls["runLog"].append({**entry, "shouldWrite": should_write})
            return {
                "enabled": True,
                "written": True,
                "code": "P1_RUN_LOG_WRITTEN",
                "error": None,
                "file": "p1_runs_2026-08-03.jsonl",
            }

        try:
            server.get_user_config = lambda _username: {
                **server.DEFAULTS,
                "enabled": True,
                "engine": "node",
            }
            server._ensure_recall_warmup = fake_warmup
            server._ensure_cluster = fake_cluster
            server.scope_state_root = fake_scope
            server._node_call = fake_node_call
            server._append_run_log = fake_run_log

            cases = {
                "chat": "chat",
                "code": "code",
                "work": "work",
                "airp": "chat",
                "smart": "chat",
                "ide": "code",
            }
            accepted: list[dict[str, Any]] = []
            for requested, canonical in cases.items():
                before = {key: len(value) for key, value in calls.items()}
                response = await server.run_p1(_request(_body(mode=requested)))
                payload = json.loads(response.body)
                assert response.status_code == 200, payload
                assert payload["requestedMode"] == requested
                assert payload["canonicalMode"] == canonical
                assert len(calls["warmup"]) == before["warmup"] + 1
                assert len(calls["cluster"]) == before["cluster"] + 1
                assert len(calls["scope"]) == before["scope"] + 1
                assert len(calls["node"]) == before["node"] + 1
                assert len(calls["runLog"]) == before["runLog"] + 1

                scope = calls["scope"][-1]
                node = calls["node"][-1]
                run_log = calls["runLog"][-1]
                request_trace = payload["trace"]["request"]
                transport_trace = payload["trace"]["transport"]
                assert scope["mode"] == canonical
                assert node["mode"] == canonical
                assert node["activeMode"] == canonical
                assert Path(node["stateRoot"]) == state_base / canonical / "mode-test-chat"
                assert node["historyChatId"] == "mode-test-chat"
                assert run_log["mode"] == canonical
                assert run_log["requestedMode"] == requested
                assert run_log["canonicalMode"] == canonical
                assert payload["runLog"]["file"] == "p1_runs_2026-08-03.jsonl"
                assert "path" not in payload["runLog"]
                assert request_trace["mode"] == canonical
                assert request_trace["requestScope"]["mode"] == canonical
                assert request_trace["requestedMode"] == requested
                assert request_trace["canonicalMode"] == canonical
                assert transport_trace["mode"] == canonical
                assert transport_trace["requestedMode"] == requested
                assert transport_trace["canonicalMode"] == canonical
                accepted.append({"requested": requested, "canonical": canonical})

            # Two host fields may use different aliases only when they resolve
            # to the same semantic layer; the primary requested value remains auditable.
            equivalent = await server.run_p1(_request(_body(mode="airp", activeMode="smart")))
            equivalent_payload = json.loads(equivalent.body)
            assert equivalent.status_code == 200, equivalent_payload
            assert equivalent_payload["requestedMode"] == "airp"
            assert equivalent_payload["canonicalMode"] == "chat"
            assert calls["node"][-1]["mode"] == calls["node"][-1]["activeMode"] == "chat"

            # Nullish precedence: mode=None delegates to activeMode, while an
            # explicitly empty mode remains an incomplete primary scope.
            active_only = await server.run_p1(_request(_body(mode=None, activeMode="ide")))
            active_only_payload = json.loads(active_only.body)
            assert active_only.status_code == 200, active_only_payload
            assert active_only_payload["requestedMode"] == "ide"
            assert active_only_payload["canonicalMode"] == "code"

            rejected: list[dict[str, Any]] = []
            unknown_values: list[Any] = ["bot", "live", "game", "${dynamicMode}", {"dynamic": "mode"}]
            for unknown in unknown_values:
                before = {key: len(value) for key, value in calls.items()}
                response = await server.run_p1(_request(_body(mode=unknown)))
                payload = json.loads(response.body)
                assert response.status_code == 400, payload
                assert payload["code"] == "E_P1_MODE_UNSUPPORTED"
                assert payload["trace"]["request"]["requestedMode"] == unknown
                assert payload["trace"]["request"]["canonicalMode"] is None
                assert {key: len(value) for key, value in calls.items()} == before
                assert not state_base.exists()
                rejected.append({"requested": unknown, "code": payload["code"]})

            unsupported_secondary_before = {key: len(value) for key, value in calls.items()}
            unsupported_secondary = await server.run_p1(
                _request(_body(mode="chat", activeMode="bot")),
            )
            unsupported_secondary_payload = json.loads(unsupported_secondary.body)
            assert unsupported_secondary.status_code == 400, unsupported_secondary_payload
            assert unsupported_secondary_payload["code"] == "E_P1_MODE_UNSUPPORTED"
            assert {key: len(value) for key, value in calls.items()} == unsupported_secondary_before

            mismatch_before = {key: len(value) for key, value in calls.items()}
            mismatch = await server.run_p1(_request(_body(mode="chat", activeMode="ide")))
            mismatch_payload = json.loads(mismatch.body)
            assert mismatch.status_code == 400, mismatch_payload
            assert mismatch_payload["code"] == "E_P1_MODE_MISMATCH"
            assert mismatch_payload["trace"]["request"]["canonicalMode"] is None
            assert mismatch_payload["trace"]["request"]["mode"]["canonical"] == "chat"
            assert mismatch_payload["trace"]["request"]["activeMode"]["canonical"] == "code"
            assert {key: len(value) for key, value in calls.items()} == mismatch_before
            assert not state_base.exists()

            for incomplete_body in (_body(), _body(mode="", activeMode="chat")):
                incomplete_before = {key: len(value) for key, value in calls.items()}
                incomplete = await server.run_p1(_request(incomplete_body))
                incomplete_payload = json.loads(incomplete.body)
                assert incomplete.status_code == 400, incomplete_payload
                assert incomplete_payload["code"] == "E_P1_SCOPE_INCOMPLETE"
                assert {key: len(value) for key, value in calls.items()} == incomplete_before
                assert not state_base.exists()

            return {
                "pass": True,
                "accepted": accepted,
                "equivalentDualField": {"mode": "airp", "activeMode": "smart", "canonical": "chat"},
                "activeModeOnly": {"requested": "ide", "canonical": "code"},
                "rejected": rejected,
                "mismatch": "E_P1_MODE_MISMATCH",
                "missing": "E_P1_SCOPE_INCOMPLETE",
                "nodeStartsOnRejected": 0,
                "stateDirectoriesCreated": state_base.exists(),
            }
        finally:
            server.get_user_config = original["get_user_config"]
            server._ensure_recall_warmup = original["ensure_recall_warmup"]
            server._ensure_cluster = original["ensure_cluster"]
            server.scope_state_root = original["scope_state_root"]
            server._node_call = original["node_call"]
            server._append_run_log = original["append_run_log"]


print(json.dumps(asyncio.run(_run()), ensure_ascii=False))
