from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

from starlette.requests import Request


SERVICE_DIR = Path(__file__).resolve().parents[1] / "service"
sys.path.insert(0, str(SERVICE_DIR))

import p1_server as server  # noqa: E402


SECRET_PATH = r"C:\private-host\users\alice\storage\p1\runs\p1_runs_2026-08-03.jsonl"
SCOPE = {
    "username": "run-log-user",
    "charName": "run-log-char",
    "chatId": "run-log-chat",
    "mode": "chat",
}


def _request(path: str, body: dict[str, Any]) -> Request:
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
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "headers": [(b"content-type", b"application/json; charset=utf-8")],
        "client": ("127.0.0.1", 0),
        "server": ("127.0.0.1", 0),
    }, receive)


def _public_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        strings: list[str] = []
        for key, item in value.items():
            strings.extend(_public_strings(key))
            strings.extend(_public_strings(item))
        return strings
    if isinstance(value, (list, tuple)):
        strings = []
        for item in value:
            strings.extend(_public_strings(item))
        return strings
    return []


def _assert_no_host_path(payload: Any) -> None:
    public = "\n".join(_public_strings(payload)).lower()
    assert SECRET_PATH.lower() not in public, payload
    assert "private-host" not in public, payload
    assert "[errno 13]" not in public, payload
    assert "[winerror 13]" not in public, payload


def _assert_receipt_base(receipt: dict[str, Any]) -> None:
    assert {"enabled", "written", "code", "error", "file"} <= set(receipt)
    assert "path" not in receipt
    assert receipt["file"] is None or server._RUN_LOG_NAME_RE.fullmatch(receipt["file"])
    _assert_no_host_path(receipt)


class _GlobFailureRuns:
    def glob(self, _pattern: str):
        raise PermissionError(13, "denied", SECRET_PATH)

    def __str__(self) -> str:
        return SECRET_PATH


class _StatCandidate:
    def __init__(self, name: str, *, fail: bool = False):
        self.name = name
        self.fail = fail

    def stat(self):
        if self.fail:
            raise PermissionError(13, "denied", SECRET_PATH)
        return SimpleNamespace(st_size=123, st_mtime=456.0)

    def __str__(self) -> str:
        return SECRET_PATH


class _StatRuns:
    def glob(self, _pattern: str):
        return [
            _StatCandidate("p1_runs_2026-08-02.jsonl"),
            _StatCandidate("p1_runs_2026-08-03.jsonl", fail=True),
        ]


class _ReadFailureFile:
    def read_text(self, *, encoding: str):
        assert encoding == "utf-8"
        raise PermissionError(13, "denied", SECRET_PATH)

    def __str__(self) -> str:
        return SECRET_PATH


class _ReadFailureRuns:
    def __truediv__(self, _file: str):
        return _ReadFailureFile()


def _management_body(**extra: Any) -> dict[str, Any]:
    return {**SCOPE, **extra}


async def _run() -> dict[str, Any]:
    config = {**server.DEFAULTS, "runLogEnabled": True, "runLogKeepDays": 30}
    local_diagnostics: list[str] = []

    with tempfile.TemporaryDirectory(prefix="p1-run-log-contract-") as temp_dir:
        temp_root = Path(temp_dir)

        with mock.patch.object(server, "_runs_dir_for", return_value=temp_root):
            success_receipt = server._append_run_log({"success": True}, config)
        _assert_receipt_base(success_receipt)
        assert set(success_receipt) == {"enabled", "written", "code", "error", "file"}
        assert success_receipt["written"] is True

        write_error = PermissionError(13, "denied", SECRET_PATH)
        with (
            mock.patch.object(server, "_runs_dir_for", return_value=temp_root),
            mock.patch.object(Path, "open", side_effect=write_error),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        ):
            write_receipt = server._append_run_log({"success": True}, config)
        _assert_receipt_base(write_receipt)
        assert set(write_receipt) == {"enabled", "written", "code", "error", "file"}
        assert write_receipt["written"] is False
        assert write_receipt["code"] == "E_P1_RUN_LOG_WRITE"

        prune_report = server._run_log_diagnostics()
        prune_report["errors"].append({
            "level": "error",
            "stage": "prune-delete",
            "code": "E_P1_RUN_LOG_PRUNE_DELETE",
            "exception": "PermissionError",
            "file": "p1_runs_2000-01-01.jsonl",
        })
        prune_root = temp_root / "prune-receipt"
        prune_root.mkdir()
        with (
            mock.patch.object(server, "_runs_dir_for", return_value=prune_root),
            mock.patch.object(server, "_prune_run_logs", return_value=prune_report),
        ):
            prune_receipt = server._append_run_log({"success": True}, config)
        _assert_receipt_base(prune_receipt)
        assert prune_receipt["written"] is True
        assert prune_receipt["diagnostics"] == prune_report
        assert set(prune_receipt["diagnostics"]) == {"warnings", "errors"}
        assert prune_receipt["diagnostics"]["errors"][0]["code"] == "E_P1_RUN_LOG_PRUNE_DELETE"
        _assert_no_host_path(prune_receipt)

        old_log = temp_root / "p1_runs_2000-01-01.jsonl"
        old_log.write_text("{}\n", encoding="utf-8")
        with (
            mock.patch.object(Path, "unlink", side_effect=PermissionError(13, "denied", SECRET_PATH)),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        ):
            actual_prune = server._prune_run_logs(temp_root, config)
        assert actual_prune["errors"][0]["code"] == "E_P1_RUN_LOG_PRUNE_DELETE"
        _assert_no_host_path(actual_prune)

        with mock.patch.object(server, "get_user_config", return_value=config):
            mkdir_scope = temp_root / "mkdir-failure"
            with (
                mock.patch.object(server, "scope_state_root", return_value=mkdir_scope),
                mock.patch.object(Path, "mkdir", side_effect=PermissionError(13, "denied", SECRET_PATH)),
                mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
            ):
                directory_failure = await server.get_run_log_info(
                    _request("/getRunLogInfo", _management_body()),
                )
            assert directory_failure["success"] is False
            assert directory_failure["code"] == "E_P1_RUN_LOG_DIR"
            assert "dir" not in directory_failure
            _assert_no_host_path(directory_failure)

            with (
                mock.patch.object(server, "_runs_dir_for", return_value=_GlobFailureRuns()),
                mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
            ):
                list_failure = await server.get_run_log_info(
                    _request("/getRunLogInfo", _management_body()),
                )
            assert list_failure["success"] is False
            assert list_failure["code"] == "E_P1_RUN_LOG_LIST"
            assert "dir" not in list_failure
            _assert_no_host_path(list_failure)

            with (
                mock.patch.object(server, "_runs_dir_for", return_value=_StatRuns()),
                mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
            ):
                stat_failure = await server.get_run_log_info(
                    _request("/getRunLogInfo", _management_body()),
                )
            assert stat_failure["success"] is False
            assert stat_failure["code"] == "E_P1_RUN_LOG_STAT"
            assert stat_failure["partial"] is True
            assert stat_failure["files"] == [{
                "file": "p1_runs_2026-08-02.jsonl", "size": 123, "mtime": 456000,
            }]
            assert "dir" not in stat_failure
            _assert_no_host_path(stat_failure)

            good_log = temp_root / "p1_runs_2026-08-03.jsonl"
            good_log.write_text('{"id":1}\nnot-json\n{"id":3}\n', encoding="utf-8")
            with mock.patch.object(server, "_runs_dir_for", return_value=temp_root):
                info_success = await server.get_run_log_info(
                    _request("/getRunLogInfo", _management_body()),
                )
                broken = await server.get_run_log(
                    _request("/getRunLog", _management_body(file=good_log.name, offset=0, limit=20)),
                )
            assert info_success["success"] is True
            assert info_success["dir"] == str(temp_root)
            assert broken["success"] is True
            assert broken["brokenCount"] == 1
            assert sum(entry.get("broken") is True for entry in broken["entries"]) == 1
            assert broken["diagnostics"]["warnings"][0]["code"] == "P1_RUN_LOG_BROKEN_JSONL"

            with (
                mock.patch.object(server, "_runs_dir_for", return_value=_ReadFailureRuns()),
                mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
            ):
                read_failure = await server.get_run_log(
                    _request("/getRunLog", _management_body(file=good_log.name)),
                )
            assert read_failure["success"] is False
            assert read_failure["code"] == "E_P1_RUN_LOG_READ"
            _assert_no_host_path(read_failure)

            invalid_utf8 = temp_root / "p1_runs_2026-08-04.jsonl"
            invalid_utf8.write_bytes(b"\xff\xfe\n")
            with (
                mock.patch.object(server, "_runs_dir_for", return_value=temp_root),
                mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
            ):
                decode_failure = await server.get_run_log(
                    _request("/getRunLog", _management_body(file=invalid_utf8.name)),
                )
            assert decode_failure["success"] is False
            assert decode_failure["code"] == "E_P1_RUN_LOG_READ"
            assert decode_failure["diagnostics"]["errors"][0]["exception"] == "UnicodeDecodeError"
            _assert_no_host_path(decode_failure)

            with mock.patch.object(server, "_runs_dir_for", side_effect=AssertionError("filesystem touched")):
                invalid_query = await server.get_run_log(
                    _request("/getRunLog", _management_body(file=good_log.name, offset="not-a-number")),
                )
                invalid_token = await server.get_run_log(
                    _request("/getRunLog", _management_body(file=SECRET_PATH)),
                )
            assert invalid_query["success"] is False
            assert invalid_query["code"] == "E_P1_RUN_LOG_QUERY"
            assert invalid_token["success"] is False
            assert invalid_token["code"] == "E_P1_RUN_LOG_FILE"
            _assert_no_host_path(invalid_query)
            _assert_no_host_path(invalid_token)

        run_body = _management_body(
            inputText="successful recall survives log failure",
            historyChatId=SCOPE["chatId"],
            chatHistory=[],
        )
        node_result = {
            "success": True,
            "p1_act": ["direction"],
            "directionWords": ["direction"],
            "recalledRecords": [{"recordId": "record-1", "content": "recalled content"}],
            "trace": {"request": {}},
        }
        async def ready(_engine: str, _config: dict[str, Any]) -> dict[str, Any]:
            return {"state": "ready", "engine": "node", "readyForRecall": True}

        with (
            mock.patch.object(server, "get_user_config", return_value=config),
            mock.patch.object(server, "_ensure_recall_warmup", side_effect=ready),
            mock.patch.object(server, "_ensure_cluster", return_value=None),
            mock.patch.object(server, "scope_state_root", return_value=temp_root / "state"),
            mock.patch.object(server, "_node_call", return_value=node_result),
            mock.patch.object(server, "_runs_dir_for", return_value=temp_root),
            mock.patch.object(Path, "open", side_effect=PermissionError(13, "denied", SECRET_PATH)),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        ):
            response = await server.run_p1(_request("/runP1", run_body))
        payload = json.loads(response.body)
        assert response.status_code == 200, payload
        assert payload["success"] is True
        assert payload["directionWords"] == ["direction"]
        assert payload["recalledRecords"][0]["recordId"] == "record-1"
        assert payload["runLog"]["written"] is False
        assert payload["runLog"]["code"] == "E_P1_RUN_LOG_WRITE"
        _assert_receipt_base(payload["runLog"])

        canonical_calls: list[str] = []
        node_calls: list[dict[str, Any]] = []
        canonical_root = temp_root / "canonical-scopes"

        def tracked_scope(_user: str, _char: str, chat_id: str, mode: str) -> Path:
            canonical_calls.append(mode)
            return canonical_root / mode / chat_id

        def tracked_node(payload: dict[str, Any], _timeout: float = 60) -> dict[str, Any]:
            node_calls.append(dict(payload))
            return node_result

        alias_body = {
            **run_body,
            "mode": "airp",
            "inputText": "canonical run-log scope",
        }
        with (
            mock.patch.object(server, "get_user_config", return_value=config),
            mock.patch.object(server, "_ensure_recall_warmup", side_effect=ready),
            mock.patch.object(server, "_ensure_cluster", return_value=None),
            mock.patch.object(server, "_memory_root", return_value=str(temp_root / "memory")),
            mock.patch.object(server, "user_state_root", return_value=temp_root / "user-state"),
            mock.patch.object(server, "scope_state_root", side_effect=tracked_scope),
            mock.patch.object(server, "_node_call", side_effect=tracked_node),
        ):
            alias_response = await server.run_p1(_request("/runP1", alias_body))
            alias_payload = json.loads(alias_response.body)
            alias_read = await server.get_run_log(_request(
                "/getRunLog",
                _management_body(mode="airp", file=alias_payload["runLog"]["file"]),
            ))
            alias_info = await server.get_run_log_info(_request(
                "/getRunLogInfo", _management_body(mode="smart"),
            ))
        assert alias_response.status_code == 200, alias_payload
        assert alias_payload["canonicalMode"] == "chat"
        assert alias_read["success"] is True
        assert alias_read["scope"]["requestedMode"] == "airp"
        assert alias_read["scope"]["canonicalMode"] == "chat"
        assert alias_info["success"] is True
        assert alias_info["scope"]["requestedMode"] == "smart"
        assert node_calls[-1]["mode"] == "chat"
        assert canonical_calls and set(canonical_calls) == {"chat"}, canonical_calls

        read_mode_calls: list[str] = []

        def read_mode_runs(_user: str, _char: str, mode: str, _chat: str) -> Path:
            read_mode_calls.append(mode)
            return temp_root

        with (
            mock.patch.object(server, "get_user_config", return_value=config),
            mock.patch.object(server, "_runs_dir_for", side_effect=read_mode_runs),
        ):
            ide_info = await server.get_run_log_info(_request(
                "/getRunLogInfo", _management_body(mode=None, activeMode="ide"),
            ))
        assert ide_info["success"] is True
        assert ide_info["scope"]["canonicalMode"] == "code"
        assert read_mode_calls == ["code"]

        for bad_body, expected_code in (
            (_management_body(mode="chat", activeMode="ide"), "E_P1_MODE_MISMATCH"),
            (_management_body(mode="bot"), "E_P1_MODE_UNSUPPORTED"),
            (_management_body(mode="${unknownMode}"), "E_P1_MODE_UNSUPPORTED"),
        ):
            with mock.patch.object(server, "_runs_dir_for", side_effect=AssertionError("directory touched")):
                bad_info = await server.get_run_log_info(_request("/getRunLogInfo", bad_body))
                bad_read = await server.get_run_log(_request(
                    "/getRunLog", {**bad_body, "file": alias_payload["runLog"]["file"]},
                ))
            assert bad_info["code"] == expected_code
            assert bad_read["code"] == expected_code

        permission_error = PermissionError(13, "denied", SECRET_PATH)

        def assert_failure(response: Any, expected_code: str) -> dict[str, Any]:
            result = json.loads(response.body)
            assert result["success"] is False, result
            assert result["code"] == expected_code, result
            _assert_no_host_path(result)
            return result

        with (
            mock.patch.object(server, "get_user_config", side_effect=permission_error),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        ):
            config_response = await server.run_p1(_request("/runP1", run_body))
        assert_failure(config_response, "E_P1_CONFIG_READ")

        with (
            mock.patch.object(server, "get_user_config", return_value=config),
            mock.patch.object(server, "_ensure_recall_warmup", side_effect=ready),
            mock.patch.object(server, "_memory_root", side_effect=permission_error),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        ):
            state_response = await server.run_p1(_request("/runP1", run_body))
        assert_failure(state_response, "E_P1_STATE_ACCESS")

        sanitized_root = temp_root / "sanitized-failures"
        sanitized_root.mkdir()
        common_failure_patches = (
            mock.patch.object(server, "get_user_config", return_value=config),
            mock.patch.object(server, "_ensure_recall_warmup", side_effect=ready),
            mock.patch.object(server, "_ensure_cluster", return_value=None),
            mock.patch.object(server, "_memory_root", return_value=str(temp_root / "memory")),
            mock.patch.object(server, "user_state_root", return_value=temp_root / "user-state"),
            mock.patch.object(server, "scope_state_root", return_value=temp_root / "state"),
            mock.patch.object(server, "_runs_dir_for", return_value=sanitized_root),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        )
        with ExitStack() as stack:
            for patcher in common_failure_patches:
                stack.enter_context(patcher)
            stack.enter_context(mock.patch.object(server, "_node_call", side_effect=permission_error))
            node_exception_response = await server.run_p1(_request("/runP1", run_body))
        node_exception = assert_failure(node_exception_response, "E_P1_RUN_EXECUTION")
        assert node_exception["runLog"]["written"] is True

        raw_node_failure = {
            "success": False,
            "code": "E_P1_NODE_FAILED",
            "error": SECRET_PATH,
            "trace": {"exception": f"PermissionError: {SECRET_PATH}"},
        }
        common_failure_patches = (
            mock.patch.object(server, "get_user_config", return_value=config),
            mock.patch.object(server, "_ensure_recall_warmup", side_effect=ready),
            mock.patch.object(server, "_ensure_cluster", return_value=None),
            mock.patch.object(server, "_memory_root", return_value=str(temp_root / "memory")),
            mock.patch.object(server, "user_state_root", return_value=temp_root / "user-state"),
            mock.patch.object(server, "scope_state_root", return_value=temp_root / "state"),
            mock.patch.object(server, "_runs_dir_for", return_value=sanitized_root),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        )
        with ExitStack() as stack:
            for patcher in common_failure_patches:
                stack.enter_context(patcher)
            stack.enter_context(mock.patch.object(server, "_node_call", return_value=raw_node_failure))
            node_packet_response = await server.run_p1(_request("/runP1", run_body))
        assert_failure(node_packet_response, "E_P1_NODE_FAILED")

        class _FailingPythonPipeline:
            @staticmethod
            def run_pipeline(*_args: Any, **_kwargs: Any):
                raise PermissionError(13, "denied", SECRET_PATH)

        python_config = {**config, "engine": "python"}
        with (
            mock.patch.object(server, "get_user_config", return_value=python_config),
            mock.patch.object(server, "_pipeline", return_value=_FailingPythonPipeline()),
            mock.patch.object(server, "_ensure_recall_warmup", side_effect=ready),
            mock.patch.object(server, "_memory_root", return_value=str(temp_root / "memory")),
            mock.patch.object(server, "user_state_root", return_value=temp_root / "user-state"),
            mock.patch.object(server, "scope_state_root", return_value=temp_root / "state"),
            mock.patch.object(server, "_runs_dir_for", return_value=sanitized_root),
            mock.patch.object(server, "_safe_log", side_effect=local_diagnostics.append),
        ):
            python_response = await server.run_p1(_request("/runP1", run_body))
        assert_failure(python_response, "E_P1_RUN_EXECUTION")

        for log_file in sanitized_root.glob("p1_runs_*.jsonl"):
            persisted = log_file.read_text(encoding="utf-8")
            assert SECRET_PATH not in persisted
            assert "[Errno 13]" not in persisted

    assert local_diagnostics, "local _safe_log diagnostics were not emitted"
    assert any("private-host" in message for message in local_diagnostics)
    return {
        "pass": True,
        "faults": [
            "write-permission", "mkdir", "glob", "stat", "read-permission",
            "unicode-decode", "invalid-query", "invalid-file-token", "broken-jsonl", "prune-delete",
            "read-mode-canonical", "read-mode-mismatch", "run-config-path",
            "run-state-path", "node-exception-path", "node-packet-path", "python-exception-path",
        ],
        "stableCodes": [
            "E_P1_RUN_LOG_WRITE", "E_P1_RUN_LOG_DIR", "E_P1_RUN_LOG_LIST",
            "E_P1_RUN_LOG_STAT", "E_P1_RUN_LOG_READ", "E_P1_RUN_LOG_QUERY",
        ],
        "successfulRecallPreserved": True,
        "publicHostPathLeak": False,
    }


print(json.dumps(asyncio.run(_run()), ensure_ascii=False))
