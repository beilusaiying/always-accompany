"""p1_server.py — P1 召回独立服务（单独/可插拔/可独立运行，002 2026-07-31 拍板）。

功能链：
    启动: python p1_server.py [--port N]   ← 完全脱离本体，独立启动即全功能（拉线测试入口）
    本体侧: shells/p1/main.mjs 薄壳把 /api/parts/shells:p1/service/<action> 代理到这里
    路由: GET /health | POST /runP1 /clearCaches /unloadCaches /getConfig /setConfig /updateConfig
          /getStats /getData
          POST /listVocabs /atSearch /atBrowse /getUserVocab /saveUserVocab /toggleUserVocab /deleteUserVocab
          POST /getP9Prompts /saveP9Prompts /resetP9Prompts
          POST /getRunLogInfo /getRunLog（运行记录：每次真实召回输出落盘 JSONL，前端展示位置+点击打开）
    管线: pipeline/ 包（p1_pipeline_py.run_pipeline 入口）——零本体依赖，词库/记忆路径全走 p1_config

why FastAPI：环境已装（0.135），JSON 契约自动校验；只绑 127.0.0.1，鉴权由本体薄壳做，
    直连场景（拉线测试）本机信任。username 取 X-P1-Username header（薄壳注入）或 body.username（直连测试）。
影响范围：新服务，不改任何本体文件。返回字段形状与旧插件 SetData 各 action 逐字段一致（前端零改动）。
"""
from __future__ import annotations

import argparse
import asyncio
import ctypes
import errno
import json
import os as _nos
import re
import time
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from p1_config import (
    DEFAULTS,
    SERVICE_KEYS,
    get_config,
    get_user_config,
    update_config,
    update_user_config,
)
from p1_paths import P1_ROOT, scope_state_root, user_memory_root, user_state_root

app = FastAPI(title="P1 Recall Service", docs_url=None, redoc_url=None)

_SERVICE_DIR = Path(__file__).resolve().parent
_uvicorn_server: Any | None = None
_lifecycle_stopping = False
_lifecycle_task: asyncio.Task | None = None
_warmup_task: asyncio.Task | None = None
_warmup_state: dict[str, Any] = {
    "state": "cold",
    "engine": None,
    "startedAt": None,
    "finishedAt": None,
    "ms": None,
    "error": None,
    "code": None,
    "resources": None,
}


def _safe_log(message: str) -> None:
    """运行日志是旁路观测，输出句柄失效时绝不能反噬业务或生命周期。"""
    try:
        print(message, flush=True)
    except (OSError, ValueError):
        pass


def _set_warmup_progress(stage: str, completed: int, total: int = 5) -> None:
    """Publish first-boot resource progress through the existing warmup snapshot."""
    global _warmup_state
    if _warmup_state.get("state") != "warming":
        return
    safe_total = max(1, int(total))
    safe_completed = max(0, min(int(completed), safe_total))
    _warmup_state = {
        **_warmup_state,
        "progress": {
            "stage": str(stage),
            "completed": safe_completed,
            "total": safe_total,
            "percent": round(safe_completed * 100 / safe_total),
        },
    }


def _ensure_resources(report_progress=None):
    """大文件自解压，并生成运行时有界加载的派生索引。

    ConceptNet 原件是 22MB/128MB 单行 JSON 对象，禁止运行时整表 JSON.parse。
    启动前用低内存流式构建器生成 256 分片；源文件 mtime/size 不变则秒级跳过。
    """
    cfg = get_config()
    res_root = Path(cfg.get("resourceDir") or "")
    derived = res_root / "p1v2_derived"
    total_steps = 5

    def report(stage: str, completed: int) -> None:
        if callable(report_progress):
            report_progress(stage, completed, total_steps)

    report("检查首启资源", 0)
    if not derived.is_dir():
        report("P1 资源目录不存在", total_steps)
        return
    import zipfile
    _UNPACK = [
        {"target": "nb_vec_int8.npy", "zips": ["nb_vec_int8.part0.zip", "nb_vec_int8.part1.zip"], "merge": True},
        {"target": "userdict_domain_full.txt", "zips": ["userdict_domain_full.zip"], "merge": False},
        {"target": "conceptnet_en.json", "zips": ["conceptnet_en.zip"], "merge": False},
    ]
    for index, item in enumerate(_UNPACK, start=1):
        target = derived / item["target"]
        report(f"检查 {item['target']}", index - 1)
        if target.exists() and target.stat().st_size > 0:
            report(f"{item['target']} 已就绪", index)
            continue
        zips = [derived / z for z in item["zips"]]
        if not all(z.exists() for z in zips):
            report(f"{item['target']} 压缩包缺失", index)
            continue
        total_mb = sum(z.stat().st_size for z in zips) // 1048576
        _safe_log(f"[p1_server] 首次启动解压: {item['target']}（{len(zips)} 个 zip, {total_mb}MB 压缩）...")
        try:
            if item["merge"]:
                with open(target, "wb") as out:
                    for zp in zips:
                        with zipfile.ZipFile(zp, "r") as zf:
                            name = zf.namelist()[0]
                            out.write(zf.read(name))
            else:
                with zipfile.ZipFile(zips[0], "r") as zf:
                    zf.extractall(derived)
            _safe_log(f"[p1_server] ✓ {item['target']} ({target.stat().st_size // 1048576}MB)")
            report(f"{item['target']} 已就绪", index)
        except Exception as e:
            _safe_log(f"[p1_server] ✗ {item['target']} 解压失败: {e}")
            if target.exists():
                target.unlink()
            report(f"{item['target']} 解压失败", index)

    conceptnet_sources = [derived / "conceptnet_zh.json", derived / "conceptnet_en.json"]
    report("校验 ConceptNet 分片", 3)
    if all(path.is_file() for path in conceptnet_sources):
        import subprocess
        import sys
        builder = P1_ROOT / "bridge" / "build_conceptnet_shards.py"
        if not builder.is_file():
            raise RuntimeError(f"ConceptNet 分片构建器缺失: {builder}")
        _safe_log("[p1_server] 校验 ConceptNet 有界加载分片...")
        built = subprocess.run(
            [sys.executable, str(builder), "--derived", str(derived)],
            text=True, encoding="utf-8", capture_output=True, check=False,
        )
        if built.returncode != 0:
            raise RuntimeError(f"ConceptNet 分片构建失败: {(built.stderr or built.stdout)[-2000:]}")
        _safe_log("[p1_server] ConceptNet 分片契约已就绪")
    report("ConceptNet 分片已就绪", 4)

    # DomainWordsDict 的 455 万有效词只允许部署期生成确定性分片。运行时 loader
    # 仅验证 manifest 并按查询词加载一个 shard；绝不能在首个 work 请求里同步扫 68 个源文件。
    # [0804 根因修] 原「manifest 不存在才构建」使 stale（发布复制改 mtime → 旧 v1 指纹恒失配）
    #   永久 fail-closed（E 现场 E_P1_DOMAIN_WORDS_INDEX_STALE → warmup 失败 → runP1 503）。
    #   改为恒调 ensure 入口：有效→毫秒级快返；缺失→构建；stale/损坏→原子重建（备份旁移）。
    #   stale 判定与重建逻辑单源在 resources2.mjs（与 loader 校验同一实现），python 侧零第二实现。
    domain_source = res_root / "DomainWordsDict"
    report("校验 DomainWords 分片", 4)
    if domain_source.is_dir():
        import subprocess
        builder = P1_ROOT / "bridge" / "build_domainwords_shards.mjs"
        if not builder.is_file():
            raise RuntimeError(f"DomainWords 分片构建器缺失: {builder}")
        _safe_log("[p1_server] 校验 DomainWords 有界查询分片（缺失/过期自动重建）...")
        built = subprocess.run(
            ["node", str(builder)],
            text=True, encoding="utf-8", capture_output=True, check=False,
        )
        if built.returncode != 0:
            raise RuntimeError(f"DomainWords 分片构建失败: {(built.stderr or built.stdout)[-2000:]}")
        _safe_log(f"[p1_server] DomainWords 分片契约已就绪: {built.stdout.strip()[-1000:]}")
    report("P1 首启资源已就绪", total_steps)
_started_at = time.time()
_pipeline_mod = None
_pipeline_err: str | None = None
_active_runs = 0
_last_run_activity = time.time()


def _positive_int_env(name: str, fallback: int) -> int:
    try:
        value = int(_nos.environ.get(name) or fallback)
    except (TypeError, ValueError):
        return fallback
    return value if value > 0 else fallback


_host_pid = _positive_int_env("P1_HOST_PID", 0)
_host_missing_since: float | None = None
_host_orphan_grace_sec = _positive_int_env("P1_HOST_ORPHAN_GRACE_SEC", 120)


def _host_process_alive(pid: int) -> bool:
    """Check the bound host without signalling it; signal 0 is unsafe on Windows."""
    if pid <= 0:
        return False
    if _nos.name != "nt":
        try:
            _nos.kill(pid, 0)
            return True
        except PermissionError:
            return True
        except ProcessLookupError:
            return False
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(
        process_query_limited_information, False, pid,
    )
    if not handle:
        return ctypes.get_last_error() == 5  # access denied still proves the PID exists
    exit_code = wintypes.DWORD()
    try:
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


@app.middleware("http")
async def _track_run_activity(req: Request, call_next):
    """真实召回和专用预热都持有重资源；两者共同刷新空闲生命周期。"""
    global _active_runs, _last_run_activity
    if req.url.path not in {"/runP1", "/warmup"}:
        return await call_next(req)
    _active_runs += 1
    _last_run_activity = time.time()
    try:
        return await call_next(req)
    finally:
        _active_runs = max(0, _active_runs - 1)
        _last_run_activity = time.time()


async def _idle_shutdown_monitor() -> None:
    global _lifecycle_stopping, _lifecycle_task, _host_missing_since
    while not _lifecycle_stopping:
        await asyncio.sleep(1)
        if _lifecycle_stopping:
            return
        if _host_pid > 0:
            if _host_process_alive(_host_pid):
                _host_missing_since = None
            else:
                if _host_missing_since is None:
                    _host_missing_since = time.monotonic()
                    _safe_log(
                        f"[p1_server] 本体 PID {_host_pid} 失联，保留 {_host_orphan_grace_sec}s 等待重连"
                    )
                missing_sec = time.monotonic() - _host_missing_since
                if missing_sec < _host_orphan_grace_sec:
                    continue
                _lifecycle_stopping = True
                _lifecycle_task = asyncio.current_task()
                _safe_log(
                    f"[p1_server] 本体连续失联 {int(missing_sec)}s，停止 P1 进程树释放重资源"
                )
                await _finish_lifecycle_stop()
                return
        idle_sec = int(get_config().get("idleShutdownSec") or 0)
        if idle_sec <= 0 or _active_runs > 0:
            continue
        if time.time() - _last_run_activity < idle_sec:
            continue
        _lifecycle_stopping = True
        _lifecycle_task = asyncio.current_task()
        _safe_log(f"[p1_server] 空闲 {idle_sec}s，停止 P1 进程树释放重资源")
        await _finish_lifecycle_stop()
        return


@app.on_event("startup")
async def _start_idle_shutdown_monitor() -> None:
    asyncio.create_task(_idle_shutdown_monitor())

# runP1 运行态统计（旧插件 main.mjs _lastRunTime/_lastRunMs/_lastDirWordCount 平移；
# 独立服务无 idle 卸载/activeRuns 并发计数概念，getStats/getData 里那几个字段诚实给 null，不编造）
_last_run_time: int | None = None
_last_run_ms: float | None = None
_last_dir_word_count: int | None = None

AT_MODES = ("chat", "code", "work", "airp")
_P1_RUN_MODE_MAP = {
    "chat": "chat",
    "code": "code",
    "work": "work",
    "airp": "chat",
    "smart": "chat",
    "ide": "code",
}
_VOCAB_NAME_RE = re.compile(r"^[\w\-. 一-鿿]+\.json$")
_at_cache: dict[str, tuple[float, dict]] = {}  # mode -> (mtime, parsed)；atSearch/atBrowse 共用，对照旧插件 globalThis.__p1AtSearchCache

_P9_DEFAULT_FILE = _SERVICE_DIR / "p9_prompts_default.json"

# 运行记录（0731 002"每次输出都需要进行文件记录"）：每次真实召回（打字联想轻量路除外——
# 400ms 防抖高频会刷盘）按天追加 JSONL 到 storage/p1 用户状态根；前端 p1run「运行记录」卡片经
# /getRunLogInfo /getRunLog 只读消费（记录文件位置+点击打开）。保留天数可配，跨天首写自动清过期。
_RUN_LOG_NAME_RE = re.compile(r"^p1_runs_\d{4}-\d{2}-\d{2}\.jsonl$")


def _run_log_diagnostics() -> dict[str, list[dict[str, Any]]]:
    return {"warnings": [], "errors": []}


def _run_log_diagnostic(
    level: str, stage: str, code: str, error: BaseException, *, file: str | None = None,
) -> dict[str, Any]:
    """Build a public diagnostic without copying exception paths into HTTP JSON."""
    diagnostic: dict[str, Any] = {
        "level": level,
        "stage": stage,
        "code": code,
        "exception": type(error).__name__,
    }
    error_number = getattr(error, "errno", None)
    if isinstance(error_number, int):
        diagnostic["errno"] = errno.errorcode.get(error_number, str(error_number))
    if isinstance(error, UnicodeDecodeError):
        diagnostic.update({
            "encoding": error.encoding,
            "start": error.start,
            "end": error.end,
            "reason": error.reason,
        })
    if file is not None and _RUN_LOG_NAME_RE.fullmatch(file):
        diagnostic["file"] = file
    return diagnostic


def _run_log_public_error(message: str, error: BaseException) -> str:
    """Expose the failure class and stable operation, never the host filesystem path."""
    return f"{type(error).__name__}: {message}"


def _run_log_receipt(
    *, enabled: bool, written: bool, code: str, error: str | None, file: str | None,
    diagnostics: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    receipt: dict[str, Any] = {
        "enabled": enabled,
        "written": written,
        "code": code,
        "error": error,
        "file": file if file is not None and _RUN_LOG_NAME_RE.fullmatch(file) else None,
    }
    if diagnostics and (diagnostics["warnings"] or diagnostics["errors"]):
        receipt["diagnostics"] = diagnostics
    return receipt


def _runs_dir_for(username: str = "", char_name: str = "", mode: str = "chat", chat_id: str = "") -> Path:
    """四维运行记录目录；始终写 P1 storage，不污染或复制宿主 memory。"""
    d = scope_state_root(username, char_name, chat_id, mode) / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _append_run_log(
    entry: dict[str, Any], cfg: dict[str, Any], *, should_write: bool = True,
) -> dict[str, Any]:
    """追加运行记录并返回可随 runP1 响应传递的结构化回执。"""
    enabled = cfg.get("runLogEnabled") is not False
    if not enabled:
        return _run_log_receipt(
            enabled=False, written=False, code="P1_RUN_LOG_DISABLED", error=None, file=None,
        )
    if not should_write:
        return _run_log_receipt(
            enabled=True, written=False, code="P1_RUN_LOG_SKIPPED_LIGHTWEIGHT", error=None, file=None,
        )
    file_token = f"p1_runs_{time.strftime('%Y-%m-%d')}.jsonl"
    fp: Path | None = None
    try:
        runs = _runs_dir_for(
            entry.get("user") or "",
            entry.get("char") or "",
            entry.get("mode") or "chat",
            entry.get("chatId") or "",
        )
        fp = runs / file_token
        is_new_file = not fp.exists()
        with fp.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        diagnostics = None
        if is_new_file:
            try:
                diagnostics = _prune_run_logs(runs, cfg)
            except Exception as prune_error:  # noqa: BLE001 — 已写入的召回记录不能被清理旁路反转
                _safe_log(
                    f"[p1_server] 运行记录清理异常（记录已写入）: "
                    f"{type(prune_error).__name__}: {prune_error}; runs={runs}"
                )
                diagnostics = _run_log_diagnostics()
                diagnostics["errors"].append(_run_log_diagnostic(
                    "error", "prune", "E_P1_RUN_LOG_PRUNE", prune_error,
                ))
        return _run_log_receipt(
            enabled=True, written=True, code="P1_RUN_LOG_WRITTEN", error=None,
            file=file_token, diagnostics=diagnostics,
        )
    except Exception as error:  # noqa: BLE001 — 日志是旁路分量，失败必须可见但不得反噬召回
        _safe_log(
            f"[p1_server] 运行记录写入失败（不影响召回）: "
            f"{type(error).__name__}: {error}; file={fp}"
        )
        return _run_log_receipt(
            enabled=True, written=False, code="E_P1_RUN_LOG_WRITE",
            error=_run_log_public_error("P1 run log write failed", error),
            file=file_token,
        )


def _prune_run_logs(
    runs_dir: Path, cfg: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    """Prune old files without hiding cleanup failures or invalid names."""
    diagnostics = _run_log_diagnostics()
    try:
        keep_days = int(cfg.get("runLogKeepDays") or 0)
    except (TypeError, ValueError) as error:
        _safe_log(f"[p1_server] 运行记录清理配置无效: {type(error).__name__}: {error}")
        diagnostics["errors"].append(_run_log_diagnostic(
            "error", "prune-config", "E_P1_RUN_LOG_PRUNE_CONFIG", error,
        ))
        return diagnostics
    if keep_days <= 0:
        return diagnostics
    cutoff = time.time() - keep_days * 86400
    try:
        for p in runs_dir.glob("p1_runs_*.jsonl"):
            if not _RUN_LOG_NAME_RE.match(p.name):
                continue
            try:
                day_ts = time.mktime(time.strptime(p.name[8:18], "%Y-%m-%d")) + 86399
            except ValueError as error:
                _safe_log(
                    f"[p1_server] 运行记录清理跳过无效日期文件: {p}; "
                    f"{type(error).__name__}: {error}"
                )
                diagnostics["warnings"].append(_run_log_diagnostic(
                    "warning", "prune-name", "P1_RUN_LOG_PRUNE_INVALID_DATE", error, file=p.name,
                ))
                continue
            if day_ts >= cutoff:
                continue
            try:
                p.unlink()
            except OSError as error:
                _safe_log(
                    f"[p1_server] 运行记录过期文件删除失败: {p}; "
                    f"{type(error).__name__}: {error}"
                )
                diagnostics["errors"].append(_run_log_diagnostic(
                    "error", "prune-delete", "E_P1_RUN_LOG_PRUNE_DELETE", error, file=p.name,
                ))
    except OSError as error:
        _safe_log(
            f"[p1_server] 运行记录清理枚举失败: {runs_dir}; "
            f"{type(error).__name__}: {error}"
        )
        diagnostics["errors"].append(_run_log_diagnostic(
            "error", "prune-list", "E_P1_RUN_LOG_PRUNE_LIST", error,
        ))
    return diagnostics


def _pipeline():
    """延迟加载管线（首次 runP1 才付词库初始化成本；加载失败记录原因，响亮报错不吞）。"""
    global _pipeline_mod, _pipeline_err
    if _pipeline_mod is None and _pipeline_err is None:
        try:
            from pipeline import p1_pipeline_py  # noqa: PLC0415
            _pipeline_mod = p1_pipeline_py
        except Exception as e:  # noqa: BLE001 — 启动期缺件要完整报因
            _pipeline_err = f"{type(e).__name__}: {e}"
    return _pipeline_mod


def _username(req: Request, body: dict) -> str:
    raw = req.headers.get("x-p1-username") or ""
    # main.mjs 用 encodeURIComponent 编码 username（非 ASCII 安全过 HTTP header），这里对称解码
    return urllib.parse.unquote(raw) if raw else str(body.get("username") or "")


def _memory_root(req: Request, body: dict, username: str) -> str:
    """宿主记忆是只读输入；优先用本体鉴权层传入的精确 UserDictionary。"""
    raw = req.headers.get("x-p1-memory-root") or ""
    explicit = urllib.parse.unquote(raw) if raw else str(body.get("memoryRoot") or "")
    return str(user_memory_root(username, explicit or None))


async def _json_object_or_empty(req: Request) -> dict[str, Any]:
    """GET 薄壳转发到 POST 路由时允许空 body；非空 body 仍严格按 JSON 对象解析。"""
    raw = await req.body()
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("request body must be a JSON object")
    return parsed


def _normalize_chat_history(raw_history: Any) -> list[dict[str, Any]]:
    """Normalize the Beilu message contract once at the HTTP ingress boundary.

    Beilu persists character replies as ``role="char"`` while both P1 engines
    consume the canonical ``assistant`` role.  Copy every record so the request
    body is not mutated, and preserve all fields other than that role mapping.
    Invalid shapes are rejected instead of silently turning a broken request
    into an empty-history recall.
    """
    if raw_history is None:
        return []
    if not isinstance(raw_history, list):
        raise ValueError("chatHistory must be an array of message objects")
    normalized: list[dict[str, Any]] = []
    for index, message in enumerate(raw_history):
        if not isinstance(message, dict):
            raise ValueError(f"chatHistory[{index}] must be a message object")
        item = dict(message)
        if item.get("role") == "char":
            item["role"] = "assistant"
        normalized.append(item)
    return normalized


class _HistoryOwnershipError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.public_message = message


def _resolve_history_ownership(
    body: dict[str, Any], chat_id: str, chat_history: list[dict[str, Any]],
) -> tuple[str, str]:
    """Bind chatHistory to the host window without guessing ownership for non-empty history."""
    raw_history_chat_id = body.get("historyChatId")
    if raw_history_chat_id is not None and not isinstance(raw_history_chat_id, str):
        raise _HistoryOwnershipError(
            "E_P1_HISTORY_CHAT_ID_TYPE", "P1 historyChatId 必须是 string",
        )
    history_chat_id = str(raw_history_chat_id or "").strip()
    if chat_history and not history_chat_id:
        raise _HistoryOwnershipError(
            "E_P1_HISTORY_CHAT_ID_REQUIRED",
            "P1 非空 chatHistory 必须显式提供 historyChatId",
        )
    if history_chat_id and history_chat_id != chat_id:
        raise _HistoryOwnershipError(
            "E_P1_HISTORY_SCOPE_MISMATCH",
            "P1 historyChatId 与请求 chatId 不一致",
        )
    if history_chat_id:
        return history_chat_id, "verified-explicit"
    # 空历史没有可串窗的消息；仍将本次“空历史”明确归属到已校验的四维 chatId，供 stdio/log/trace 审计。
    return chat_id, "empty-history-bound-to-chatId"


def _effective_data_recall(cfg: dict[str, Any], body: dict[str, Any]) -> bool:
    """Materialize the request-level Data recall switch for either engine."""
    override = body.get("dataRecallOverride")
    if override is None:
        return cfg.get("dataRecall") is not False
    if not isinstance(override, bool):
        raise ValueError("dataRecallOverride must be a boolean when provided")
    return override


def _canonical_run_mode(raw_mode: Any) -> str | None:
    """Resolve the only supported /runP1 mode domain without guessing a fallback."""
    if not isinstance(raw_mode, str):
        return None
    return _P1_RUN_MODE_MAP.get(raw_mode.strip())


class _RunModeResolutionError(ValueError):
    def __init__(self, code: str, message: str, audit: dict[str, Any]):
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.audit = audit


def _requested_run_mode(raw_mode: Any, raw_active_mode: Any) -> Any:
    return raw_mode if raw_mode is not None else raw_active_mode


def _run_mode_present(requested_mode: Any) -> bool:
    return (
        requested_mode is not None
        and (not isinstance(requested_mode, str) or bool(requested_mode.strip()))
    )


def _resolve_run_mode_contract(raw_mode: Any, raw_active_mode: Any) -> dict[str, Any]:
    """Resolve aliases and dual-field conflicts once for run and run-log routes."""
    requested_mode = _requested_run_mode(raw_mode, raw_active_mode)
    resolved_modes: dict[str, str] = {}
    for field, value in (("mode", raw_mode), ("activeMode", raw_active_mode)):
        if value is None:
            continue
        resolved = _canonical_run_mode(value)
        if resolved is None:
            raise _RunModeResolutionError(
                "E_P1_MODE_UNSUPPORTED",
                f"P1 {field} 不支持；只允许 chat|code|work 及 airp|smart|ide 别名",
                {
                    "requestedMode": requested_mode,
                    "canonicalMode": None,
                    "unsupportedField": field,
                    "unsupportedValue": value,
                },
            )
        resolved_modes[field] = resolved
    if ("mode" in resolved_modes and "activeMode" in resolved_modes
            and resolved_modes["mode"] != resolved_modes["activeMode"]):
        raise _RunModeResolutionError(
            "E_P1_MODE_MISMATCH",
            "P1 mode 与 activeMode 指向不同 canonical mode",
            {
                "requestedMode": requested_mode,
                "canonicalMode": None,
                "mode": {"requested": raw_mode, "canonical": resolved_modes["mode"]},
                "activeMode": {"requested": raw_active_mode, "canonical": resolved_modes["activeMode"]},
            },
        )
    canonical_mode = _canonical_run_mode(requested_mode)
    if canonical_mode is None:
        raise _RunModeResolutionError(
            "E_P1_MODE_UNSUPPORTED",
            "P1 mode 不支持；只允许 chat|code|work 及 airp|smart|ide 别名",
            {"requestedMode": requested_mode, "canonicalMode": None},
        )
    return {
        "mode": canonical_mode,
        "requestedMode": requested_mode,
        "canonicalMode": canonical_mode,
    }


_P1_PUBLIC_ERROR_CODE_RE = re.compile(r"^E_P1_[A-Z0-9_]+$")


def _stable_p1_error_code(raw_code: Any, fallback: str) -> str:
    code = raw_code if isinstance(raw_code, str) else ""
    return code if _P1_PUBLIC_ERROR_CODE_RE.fullmatch(code) else fallback


def _public_warmup_failure(engine: str, code: str) -> dict[str, Any]:
    """Return only stable scalar state; internal error/resources may contain host paths."""
    return {
        "state": "failed",
        "engine": engine,
        "startedAt": _warmup_state.get("startedAt"),
        "finishedAt": _warmup_state.get("finishedAt"),
        "ms": _warmup_state.get("ms"),
        "error": "P1 warmup failed",
        "code": code,
        "readyForRecall": False,
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    cfg = get_config()
    engine = str(cfg.get("engine") or "node")
    if engine == "node":
        loaded = _process_running(_node_state.get("proc"))
        pipeline_error = _node_state.get("err")
    else:
        loaded = _pipeline_mod is not None
        pipeline_error = _pipeline_err
    warmup = await asyncio.to_thread(_warmup_snapshot, engine)
    return {
        "ok": True,
        "liveness": True,
        "service": "p1-recall",
        "pid": _nos.getpid(),
        "uptimeSec": round(time.time() - _started_at, 1),
        "engine": engine,
        "pipelineLoaded": loaded,
        "pipelineError": pipeline_error,
        "readyForRecall": warmup["readyForRecall"],
        "warmup": warmup,
        "enabled": cfg.get("enabled", True),
    }


# ── P1v2 node 常驻子进程(0801: runP1 引擎切到 node 白盒新管线;config.engine="python" 可切回旧管线) ──
# why 常驻: node 侧词库+HanLP 加载秒级,每请求 spawn 不可用
# 多路复用: requestId 标识并发请求, Node 侧 async 处理, 响应行带 _rid 对应回调
import json as _njson
import subprocess as _nsp
import sys as _nsys
import threading as _nth
import uuid as _uuid

_cluster_children: dict[str, Any] = {}
_cluster_start_lock = _nth.Lock()
_cluster_autostart = True

_NODE_STDIO = str(P1_ROOT / "p1_service_stdio.mjs")
_P1_RUNTIME_CONTRACT_FILE = _nos.path.join(_nos.path.dirname(_NODE_STDIO), "runtime_contract.json")
with open(_P1_RUNTIME_CONTRACT_FILE, encoding="utf-8") as _contract_stream:
    _P1_RUNTIME_CONTRACT = _njson.load(_contract_stream)
_CLUSTER_SERVICES = tuple({
    "name": svc["name"],
    "script": svc["script"],
    "port": svc["port"],
    "env_port": svc["envPort"],
} for svc in _P1_RUNTIME_CONTRACT["cluster"]["services"])
_node_state: dict[str, Any] = {"proc": None, "err": None}
_node_write_lock = _nth.Lock()
_node_pending: dict[str, _nth.Event] = {}
_node_results: dict[str, dict] = {}
_node_reader_started = False


def _probe_cluster_service(name: str, port: int, timeout: float = 2.0) -> tuple[str, dict[str, Any] | None]:
    """单一集群探测契约，启动器和 readyForRecall 共同消费。"""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as response:
            health = _njson.loads(response.read().decode("utf-8"))
    except Exception:
        return "offline", None
    expected_contract = _P1_RUNTIME_CONTRACT["cluster"]["id"]
    if (health.get("ok") is True and health.get("service") == name
            and health.get("contract") == expected_contract):
        return "ready", health
    return "mismatch", health


def _cluster_resource_status() -> dict[str, Any]:
    services: dict[str, Any] = {}
    all_ready = True
    for svc in _CLUSTER_SERVICES:
        name = svc["name"]
        port = int(_nos.environ.get(svc["env_port"]) or svc["port"])
        state, health = _probe_cluster_service(name, port, timeout=0.75)
        resource_ready = state == "ready"
        if name == "tokenize":
            resource_ready = resource_ready and health.get("onnx") is True
        elif name == "vector":
            resource_ready = resource_ready and health.get("nb_loaded") is True and health.get("wn_loaded") is True
        elif name == "llmtok":
            resource_ready = resource_ready and health.get("loaded") is True
        services[name] = {
            "state": state,
            "ready": resource_ready,
            "port": port,
            "health": health,
        }
        all_ready = all_ready and resource_ready
    return {"ready": all_ready, "services": services}


def _recall_resource_status(engine: str) -> dict[str, Any]:
    if engine != "node":
        return {"ready": _pipeline_mod is not None and _pipeline_err is None, "pipelineLoaded": _pipeline_mod is not None}
    cluster = _cluster_resource_status()
    node_ready = _process_running(_node_state.get("proc"))
    return {"ready": node_ready and cluster["ready"], "nodeStdio": node_ready, "cluster": cluster}


def _warmup_snapshot(engine: str) -> dict[str, Any]:
    state = dict(_warmup_state)
    same_engine = state.get("engine") == engine
    stored_resources = state.get("resources")
    if same_engine and state.get("state") == "ready":
        # 每次 health 都重验实时存活，但不能因此丢掉 warmup 时记录的各资源加载耗时/供应方。
        # live 字段覆盖同名状态，stdioWarmup 等一次性证据继续保留在快照里。
        live_resources = _recall_resource_status(engine)
        resources = ({**stored_resources, **live_resources}
                     if isinstance(stored_resources, dict) else live_resources)
    else:
        resources = stored_resources
    ready = bool(same_engine and state.get("state") == "ready" and isinstance(resources, dict) and resources.get("ready") is True)
    return {**state, "engine": state.get("engine") or engine, "readyForRecall": ready, "resources": resources}


def _process_running(proc: Any | None) -> bool:
    if proc is None:
        return False
    try:
        return proc.poll() is None
    except (OSError, ValueError):
        return False


def _stop_node_stdio() -> None:
    """停止本服务自己创建的 Node 常驻管线；不枚举或误杀外部进程。"""
    p = _node_state.get("proc")
    if p is None:
        return
    try:
        p.terminate()
        p.wait(timeout=2)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
    finally:
        _node_state["proc"] = None


def _stop_cluster_services() -> None:
    """请求每个辅助服务自行退出，并仅终止本实例记录过的子进程兜底。"""
    import urllib.request
    for svc in _CLUSTER_SERVICES:
        port = int(_nos.environ.get(svc["env_port"]) or svc["port"])
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/lifecycle/stop", method="POST", data=b"{}",
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            pass  # 未运行、旧版本无停止路由均不阻断本服务退出；下一启动会如实重新探测
    for p in tuple(_cluster_children.values()):
        try:
            p.terminate()
        except Exception:
            pass
    _cluster_children.clear()


async def _finish_lifecycle_stop() -> None:
    """让停止响应先返回，再依序回收子服务和本 Uvicorn 实例。"""
    await asyncio.sleep(0.1)
    try:
        await asyncio.to_thread(_stop_node_stdio)
    finally:
        try:
            await asyncio.to_thread(_stop_cluster_services)
        finally:
            if _uvicorn_server is not None:
                _uvicorn_server.should_exit = True


@app.post("/lifecycle/stop", response_model=None)
async def lifecycle_stop(req: Request) -> JSONResponse | dict[str, Any]:
    """供本机更新/宿主生命周期协调器调用；可用 expectedPid 防止跨实例误停。"""
    global _lifecycle_stopping, _lifecycle_task
    body = await _json_object_or_empty(req)
    expected_pid = body.get("expectedPid")
    current_pid = _nos.getpid()
    if expected_pid is not None and expected_pid != current_pid:
        return JSONResponse({
            "success": False,
            "stopping": False,
            "code": "E_P1_OWNER_MISMATCH",
            "error": "expectedPid does not match the current P1 service",
            "expectedPid": expected_pid,
            "pid": current_pid,
        }, status_code=409)
    if not _lifecycle_stopping or _lifecycle_task is None or _lifecycle_task.done():
        _lifecycle_stopping = True
        _lifecycle_task = asyncio.create_task(_finish_lifecycle_stop())
    return {"success": True, "stopping": True, "pid": current_pid}


def _node_ensure():
    global _node_reader_started
    p = _node_state["proc"]
    if _process_running(p):
        return p
    try:
        p = _nsp.Popen(["node", _NODE_STDIO], stdin=_nsp.PIPE, stdout=_nsp.PIPE, stderr=_nsp.DEVNULL,
                       text=True, encoding="utf-8", bufsize=1,
                       cwd=_nos.path.dirname(_NODE_STDIO))
        handshake_line = p.stdout.readline()
        handshake = _njson.loads(handshake_line)
        if (handshake.get("ready") is not True
                or handshake.get("service") != _P1_RUNTIME_CONTRACT["stdioService"]
                or handshake.get("contract") != _P1_RUNTIME_CONTRACT["id"]):
            p.terminate()
            raise RuntimeError(f"node 子进程启动契约不匹配: {handshake}")
        _node_state["proc"] = p
        _node_state["err"] = None
        if not _node_reader_started:
            _node_reader_started = True
            _nth.Thread(target=_node_reader_loop, daemon=True).start()
        return p
    except Exception as e:  # noqa: BLE001
        _node_state["err"] = f"{type(e).__name__}: {e}"
        return None


def _node_reader_loop():
    """后台线程: 持续读 Node stdout, 按 _rid 分发响应到对应的等待者"""
    while True:
        p = _node_state.get("proc")
        if p is None or p.poll() is not None:
            import time; time.sleep(0.5)
            continue
        try:
            line = p.stdout.readline()
        except Exception:
            continue
        if not line:
            _node_state["proc"] = None
            for rid, ev in list(_node_pending.items()):
                _node_results[rid] = {"error": "node 子进程无响应(已标记重启)"}
                ev.set()
            _node_pending.clear()
            continue
        try:
            data = _njson.loads(line)
        except Exception:
            continue
        rid = data.pop("_rid", None)
        if rid and rid in _node_pending:
            _node_results[rid] = data
            _node_pending[rid].set()


def _node_call(payload: dict[str, Any], timeout_sec: float = 60) -> dict[str, Any]:
    with _node_write_lock:
        p = _node_ensure()
    if p is None:
        raise RuntimeError(f"node 子进程不可用: {_node_state['err']}")
    rid = _uuid.uuid4().hex[:12]
    payload["_rid"] = rid
    ev = _nth.Event()
    _node_pending[rid] = ev
    try:
        with _node_write_lock:
            p.stdin.write(_njson.dumps(payload, ensure_ascii=False) + "\n")
            p.stdin.flush()
        if not ev.wait(timeout=timeout_sec):
            raise RuntimeError(f"node 子进程响应超时({timeout_sec:g}s)")
        return _node_results.pop(rid, {"error": "response lost"})
    finally:
        _node_pending.pop(rid, None)
        _node_results.pop(rid, None)


def _clear_node_runtime_caches(tier: str) -> dict[str, Any]:
    """只清已经在运行的 Node 子进程；未启动时不为“清缓存”反向冷启动整条管线。"""
    p = _node_state.get("proc")
    if p is None or p.poll() is not None:
        return {"success": True, "skipped": "node process not running"}
    try:
        result = _node_call({"action": "clearCaches", "tier": tier})
        if result.get("success") is False:
            return {"success": False, "error": result.get("error") or "node cache clear failed"}
        return result
    except Exception as e:  # noqa: BLE001 — 清理失败必须回到接口调用方，不能伪报成功
        return {"success": False, "error": f"{type(e).__name__}: {e}"}


def _clear_runtime_caches(tier: str, engine: str) -> dict[str, Any]:
    """按当前引擎清主缓存；若 Node 已运行则始终同步清，覆盖运行中切换引擎的残留。"""
    reports: dict[str, Any] = {}
    if engine != "node":
        pl = _pipeline()
        if pl is None:
            return {"success": False, "error": f"管线未就绪: {_pipeline_err}"}
        reports["python"] = pl.clear_p1_runtime_caches({"tier": tier})
    node_report = _clear_node_runtime_caches(tier)
    if node_report.get("success") is False:
        return {"success": False, "error": node_report.get("error"), "report": {**reports, "node": node_report}}
    reports["node"] = node_report
    return {"success": True, "report": reports}


def _warmup_exception(message: str, code: str, details: Any = None) -> RuntimeError:
    error = RuntimeError(message)
    error.code = code  # type: ignore[attr-defined]
    error.details = details  # type: ignore[attr-defined]
    return error


async def _perform_recall_warmup(engine: str, cfg: dict[str, Any]) -> dict[str, Any]:
    global _warmup_state
    started = time.time()
    _warmup_state = {
        "state": "warming", "engine": engine,
        "startedAt": int(started * 1000), "finishedAt": None, "ms": None,
        "error": None, "code": None, "resources": None,
        "progress": {"stage": "等待首启资源", "completed": 0, "total": 5, "percent": 0},
    }
    try:
        # 首启解压/分片可持续数分钟；必须在已监听 HTTP 后、现有 warmup 单飞内运行，
        # 让 getData 先返回 cold/warming 快照，而不是把整个面板请求堵在 Python 进程启动前。
        await asyncio.to_thread(_ensure_resources, _set_warmup_progress)
        if engine == "node":
            if not _cluster_autostart:
                raise _warmup_exception("P1 cluster autostart is disabled", "E_P1_CLUSTER_AUTOSTART_OFF")
            await asyncio.to_thread(_ensure_cluster)
            node_result = await asyncio.to_thread(
                _node_call,
                {"action": "warmup", "config": cfg},
                180,
            )
            if node_result.get("success") is not True or node_result.get("readyForRecall") is not True:
                failure = node_result.get("trace", {}).get("failure", {}) if isinstance(node_result.get("trace"), dict) else {}
                raise _warmup_exception(
                    str(node_result.get("error") or "Node warmup returned an invalid ready contract"),
                    str(node_result.get("code") or failure.get("code") or "E_P1_NODE_WARMUP_FAILED"),
                    node_result,
                )
            resources = await asyncio.to_thread(_recall_resource_status, engine)
            if resources.get("ready") is not True:
                raise _warmup_exception(
                    "P1 resources did not remain ready after Node warmup",
                    "E_P1_WARMUP_READINESS_MISMATCH",
                    resources,
                )
            resources["stdioWarmup"] = node_result.get("resources")
        else:
            pipeline = _pipeline()
            if pipeline is None:
                raise _warmup_exception(f"管线未就绪: {_pipeline_err}", "E_P1_PYTHON_WARMUP_FAILED")
            resources = _recall_resource_status(engine)
            if resources.get("ready") is not True:
                raise _warmup_exception("Python pipeline import did not become ready", "E_P1_PYTHON_WARMUP_FAILED", resources)

        finished = time.time()
        _warmup_state = {
            "state": "ready", "engine": engine,
            "startedAt": int(started * 1000), "finishedAt": int(finished * 1000),
            "ms": round((finished - started) * 1000, 1),
            "error": None, "code": None, "resources": resources,
            "progress": {"stage": "P1 召回已就绪", "completed": 5, "total": 5, "percent": 100},
        }
        return await asyncio.to_thread(_warmup_snapshot, engine)
    except Exception as error:  # noqa: BLE001 — failed 必须成为可观察状态并回到调用方
        finished = time.time()
        _warmup_state = {
            "state": "failed", "engine": engine,
            "startedAt": int(started * 1000), "finishedAt": int(finished * 1000),
            "ms": round((finished - started) * 1000, 1),
            "error": f"{type(error).__name__}: {error}",
            "code": getattr(error, "code", "E_P1_WARMUP_FAILED"),
            "resources": getattr(error, "details", None),
            "progress": _warmup_state.get("progress"),
        }
        raise


async def _ensure_recall_warmup(engine: str, cfg: dict[str, Any]) -> dict[str, Any]:
    """同一引擎的 warmup 单飞；runP1 与 /warmup 等待同一个任务。"""
    global _warmup_task, _warmup_state
    while True:
        snapshot = await asyncio.to_thread(_warmup_snapshot, engine)
        if snapshot.get("readyForRecall") is True:
            return snapshot
        if _warmup_state.get("state") == "ready" and _warmup_state.get("engine") == engine:
            _warmup_state = {**_warmup_state, "state": "cold", "error": "warm resources are no longer live"}

        task = _warmup_task
        task_engine = str(_warmup_state.get("engine") or "")
        if task is None or task.done():
            task = asyncio.create_task(_perform_recall_warmup(engine, cfg))
            _warmup_task = task
            task_engine = engine
        try:
            await asyncio.shield(task)
        except Exception:
            if task_engine == engine:
                raise
        if task_engine == engine:
            result = await asyncio.to_thread(_warmup_snapshot, engine)
            if result.get("readyForRecall") is not True:
                raise _warmup_exception("warmup completed without recall readiness", "E_P1_WARMUP_INCOMPLETE", result)
            return result


@app.post("/warmup")
async def warmup(req: Request) -> JSONResponse:
    try:
        body = await _json_object_or_empty(req)
    except (ValueError, json.JSONDecodeError) as error:
        return JSONResponse({"success": False, "code": "E_P1_WARMUP_BAD_REQUEST", "error": str(error)}, status_code=400)
    username = _username(req, body)
    cfg = get_user_config(username)
    if not cfg.get("enabled", True):
        return JSONResponse({"success": False, "code": "E_P1_DISABLED", "error": "P1 服务已禁用"}, status_code=409)
    engine = str(cfg.get("engine") or "node")
    try:
        state = await _ensure_recall_warmup(engine, cfg)
        return JSONResponse({"success": True, "readyForRecall": True, "warmup": state})
    except Exception as error:  # noqa: BLE001
        return JSONResponse({
            "success": False,
            "readyForRecall": False,
            "code": getattr(error, "code", _warmup_state.get("code") or "E_P1_WARMUP_FAILED"),
            "error": str(error),
            "warmup": await asyncio.to_thread(_warmup_snapshot, engine),
        }, status_code=503)


@app.post("/runP1")
async def run_p1(req: Request) -> JSONResponse:
    content_type = str(req.headers.get("content-type") or "")
    transport_trace: dict[str, Any] = {
        "protocol": "http-json",
        "contentType": content_type,
        "jsonTextEncoding": "utf-8",
        "jsonDecoded": False,
    }
    try:
        body = await req.json()
    except Exception as e:  # noqa: BLE001 — HTTP JSON 边界必须返回可见错误而不是框架 500
        _safe_log(f"[p1_server] runP1 HTTP JSON 解码失败: {type(e).__name__}: {e}")
        transport_trace["decodeError"] = {
            "code": "E_P1_HTTP_JSON_INVALID", "exception": type(e).__name__,
        }
        return JSONResponse({
            "success": False,
            "p1_act": [],
            "code": "E_P1_HTTP_JSON_INVALID",
            "error": "P1 HTTP 请求体不是有效 UTF-8 JSON",
            "trace": {"transport": transport_trace},
        }, status_code=400)
    transport_trace["jsonDecoded"] = True
    transport_trace["bodyType"] = type(body).__name__
    if not isinstance(body, dict):
        return JSONResponse({
            "success": False,
            "p1_act": [],
            "code": "E_P1_HTTP_BODY_TYPE",
            "error": "P1 HTTP JSON 顶层必须是 object",
            "trace": {"transport": transport_trace},
        }, status_code=400)
    input_text = body.get("inputText", "")
    transport_trace["inputTextType"] = type(input_text).__name__
    if not isinstance(input_text, str):
        return JSONResponse({
            "success": False,
            "p1_act": [],
            "code": "E_P1_INPUT_TEXT_TYPE",
            "error": "P1 inputText 必须是 string",
            "trace": {"transport": transport_trace},
        }, status_code=400)
    transport_trace["inputTextChars"] = len(input_text)
    username = _username(req, body)
    char_name = str(body.get("charName") or "").strip()
    chat_id = str(body.get("chatId") or body.get("chatid") or "").strip()
    # /runP1 is the single normalization owner. Preserve the host value with
    # nullish (not truthy) precedence, then let only the canonical three-mode
    # domain cross into warmup/state paths/Node/Python/logging.
    raw_mode = body.get("mode")
    raw_active_mode = body.get("activeMode")
    requested_mode = _requested_run_mode(raw_mode, raw_active_mode)
    requested_mode_present = _run_mode_present(requested_mode)
    missing_scope = [name for name, value in (
        ("username", username), ("charName", char_name), ("chatId", chat_id),
        ("mode", requested_mode_present),
    ) if not value]
    if missing_scope:
        return JSONResponse({
            "success": False, "p1_act": [], "code": "E_P1_SCOPE_INCOMPLETE",
            "error": f"P1 可写状态需要完整 username×charName×chatId×mode；缺少: {', '.join(missing_scope)}",
            "trace": {"transport": transport_trace, "scope": {
                "username": username, "charName": char_name, "chatId": chat_id, "mode": None,
            }},
        }, status_code=400)
    try:
        mode_audit = _resolve_run_mode_contract(raw_mode, raw_active_mode)
    except _RunModeResolutionError as error:
        transport_trace.update({"requestedMode": requested_mode, "canonicalMode": None})
        return JSONResponse({
            "success": False, "p1_act": [], "code": error.code,
            "error": error.public_message,
            "trace": {
                "transport": transport_trace,
                "request": error.audit,
            },
        }, status_code=400)
    canonical_mode = mode_audit["canonicalMode"]
    transport_trace.update(mode_audit)
    try:
        cfg = get_user_config(username)
    except Exception as error:  # noqa: BLE001 — 配置 IO/解析故障必须成为稳定 HTTP 契约
        _safe_log(
            f"[p1_server] runP1 配置读取失败: {type(error).__name__}: {error}; user={username}"
        )
        return JSONResponse({
            "success": False, "p1_act": [], "code": "E_P1_CONFIG_READ",
            "error": _run_log_public_error("P1 configuration read failed", error),
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
        }, status_code=500)
    # 历史归属必须在 warmup/管线前校验：非空历史不得在不知道来源窗口时进入任何召回状态。
    dro = body.get("dataRecallOverride")
    try:
        chat_history = _normalize_chat_history(body.get("chatHistory"))
        history_chat_id, history_ownership = _resolve_history_ownership(body, chat_id, chat_history)
        effective_data_recall = _effective_data_recall(cfg, body)
    except _HistoryOwnershipError as error:
        transport_trace.update({
            "chatId": chat_id,
            "historyChatId": str(body.get("historyChatId") or ""),
            "historyCount": len(body.get("chatHistory")) if isinstance(body.get("chatHistory"), list) else None,
            "historyOwnership": "rejected",
        })
        return JSONResponse({
            "success": False, "p1_act": [], "code": error.code, "error": error.public_message,
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
        }, status_code=400)
    except ValueError as error:
        _safe_log(f"[p1_server] runP1 请求校验失败: {type(error).__name__}: {error}")
        return JSONResponse({
            "success": False, "p1_act": [], "code": "E_P1_RUN_REQUEST_INVALID",
            "error": "P1 run request validation failed",
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
        }, status_code=400)
    transport_trace.update({
        "chatId": chat_id,
        "historyChatId": history_chat_id,
        "historyCount": len(chat_history),
        "historyOwnership": history_ownership,
    })
    if not cfg.get("enabled", True):
        return JSONResponse({
            "success": False, "p1_act": [], "code": "E_P1_DISABLED",
            "error": "P1 服务已禁用 (config.enabled=false)",
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
        }, status_code=409)
    _engine = str(cfg.get("engine") or "node")  # 0801: 默认 node 白盒新管线
    pl = None
    if _engine != "node":
        pl = _pipeline()
        if pl is None:
            _safe_log(f"[p1_server] runP1 Python 管线未就绪: {_pipeline_err}")
            return JSONResponse({
                "success": False, "p1_act": [], "code": "E_P1_PIPELINE_UNAVAILABLE",
                "error": "P1 Python pipeline is unavailable",
                "trace": {"request": dict(mode_audit), "transport": transport_trace},
            }, status_code=500)
    try:
        await _ensure_recall_warmup(_engine, cfg)
    except Exception as error:  # noqa: BLE001 — 首个 run 必须等待同一个 warmup，失败不可带病进管线
        code = _stable_p1_error_code(
            getattr(error, "code", _warmup_state.get("code")), "E_P1_WARMUP_FAILED",
        )
        _safe_log(
            f"[p1_server] runP1 warmup 失败: {type(error).__name__}: {error}; engine={_engine}"
        )
        return JSONResponse({
            "success": False,
            "p1_act": [],
            "code": code,
            "error": _run_log_public_error("P1 warmup failed", error),
            "warmup": _public_warmup_failure(_engine, code),
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
        }, status_code=503)
    try:
        memory_root = _memory_root(req, body, username)
        # 宿主记忆仍共享 user+char+mode 只读语料；可写 novelty/experiment 按四维窗口作用域隔离。
        state_root = str(scope_state_root(username, char_name, chat_id, canonical_mode))
        vocab_root = str(user_state_root(username) / "vocab")
    except Exception as error:  # noqa: BLE001 — state/memory path IO 失败不得变成框架 HTML 500
        _safe_log(
            f"[p1_server] runP1 状态路径解析失败: {type(error).__name__}: {error}; "
            f"scope={username}/{char_name}/{canonical_mode}/{chat_id}"
        )
        return JSONResponse({
            "success": False, "p1_act": [], "code": "E_P1_STATE_ACCESS",
            "error": _run_log_public_error("P1 state storage is unavailable", error),
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
        }, status_code=500)
    # recallConfig 组装（旧插件 _runP1 L221-251 职责平移）：config 平铺键 → runtime_config.recall；
    # dataRecallOverride=请求级轻量开关（打字联想传 false），不动全局 config
    # 运行记录来源标注：前端快测 payload 自带 source:"panel-test"；生产线 p1Bridge 不带=按 bridge 记
    _src_tag = str(body.get("source") or "bridge")
    _log_this = dro is not False  # 打字联想轻量路（dataRecallOverride=false 高频）不记录
    recall_cfg = {
        "recallOnly": True,
        "dataRecall": effective_data_recall,
        **{k: cfg[k] for k in (
            "entryTopK", "resonanceW", "combinedMin", "nbGlobalRoute", "deferNb300", "nbRerank",
            "sparseTopK", "bm25K1", "bm25B", "termTopK", "contextMessages", "inputMaxChars",
            "shortSegmentChars", "excludeExactAssistantCopies", "recentDataTopK", "recordTopK",
            "candidateMinHits", "collapseSameFileKeywordSet", "snippetMaxChars", "injectMaxChars",
            "recencyDecayBase", "blqRerank", "includeMarkdown", "indexCacheMax", "nbCacheMaxVectors",
        ) if k in cfg},
        "layerWeights": {  # [0731 配置通道] 三平铺键组装为对象 → node0 dImp 消费
            "hot": cfg.get("layerWeightHot", 1.0),
            "warm": cfg.get("layerWeightWarm", 0.85),
            "cold": cfg.get("layerWeightCold", 0.7),
        },
    }
    user_ctx = {
        "username": username,
        "charName": char_name,
        "memoryRoot": memory_root,
        "vocabRoot": vocab_root,
    } if (username or char_name) else None
    global _last_run_time, _last_run_ms, _last_dir_word_count
    t0 = time.time()
    try:
        if _engine == "node":
            if _cluster_autostart:
                await asyncio.to_thread(_ensure_cluster)
            result = await asyncio.to_thread(_node_call, {
                "action": "runP1",
                "inputText": input_text,
                "chatHistory": chat_history,
                "mode": canonical_mode,
                "activeMode": canonical_mode,
                "username": username,
                "charName": char_name,
                "chatId": chat_id,
                "historyChatId": history_chat_id,
                "historyOwnership": history_ownership,
                "source": _src_tag,
                "memoryRoot": memory_root,
                "stateRoot": state_root,
                "vocabRoot": vocab_root,
                "dataRecall": effective_data_recall,
                "config": {**cfg, "dataRecall": effective_data_recall},
                "whitebox": body.get("whitebox") is True,
            })
        else:
            result = await asyncio.to_thread(
                pl.run_pipeline,
                input_text,
                chat_history,
                canonical_mode,
                user_ctx=user_ctx,
                runtime_config={"recall": recall_cfg},
            )
    except Exception as e:  # noqa: BLE001 — 管线异常按契约回 error，调用方走降级链
        _last_run_ms = round((time.time() - t0) * 1000, 1)
        code = "E_P1_RUN_EXECUTION"
        public_error = _run_log_public_error("P1 recall pipeline execution failed", e)
        _safe_log(
            f"[p1_server] runP1 管线执行失败: {type(e).__name__}: {e}; "
            f"engine={_engine}; scope={username}/{char_name}/{canonical_mode}/{chat_id}"
        )
        run_log = _append_run_log({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": _src_tag,
            "mode": canonical_mode, "requestedMode": requested_mode, "canonicalMode": canonical_mode,
            "chatId": chat_id, "historyChatId": history_chat_id,
            "historyCount": len(chat_history), "ms": _last_run_ms, "success": False,
            "user": username or None, "char": char_name or None,
            "input": input_text[:500],
            "code": code,
            "error": public_error,
        }, cfg, should_write=_log_this)
        return JSONResponse({
            "success": False,
            "p1_act": [],
            "code": code,
            "error": public_error,
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
            "runLog": run_log,
        }, status_code=500)
    if not result:
        _last_run_ms = round((time.time() - t0) * 1000, 1)
        run_log = _append_run_log({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": _src_tag,
            "mode": canonical_mode, "requestedMode": requested_mode, "canonicalMode": canonical_mode,
            "chatId": chat_id, "historyChatId": history_chat_id,
            "historyCount": len(chat_history), "ms": _last_run_ms, "success": False,
            "user": username or None, "char": char_name or None,
            "input": input_text[:500],
            "code": "E_P1_RUN_RESULT_EMPTY", "error": "P1 recall pipeline returned no result",
        }, cfg, should_write=_log_this)
        return JSONResponse({
            "success": False,
            "p1_act": [],
            "code": "E_P1_RUN_RESULT_EMPTY",
            "error": "P1 recall pipeline returned no result",
            "trace": {"request": dict(mode_audit), "transport": transport_trace},
            "runLog": run_log,
        })
    result_trace = result.get("trace")
    if isinstance(result_trace, dict):
        request_trace = result_trace.get("request")
        if isinstance(request_trace, dict):
            request_trace.update(mode_audit)
        else:
            result_trace["request"] = dict(mode_audit)
        result_trace["transport"] = transport_trace
    else:
        result["trace"] = {
            "pipeline": result_trace,
            "request": dict(mode_audit),
            "transport": transport_trace,
        }
    # Node 行协议必须显式 success=true。失败封包和 error-only 封包都在这个 HTTP
    # 边界原样透传，不得进入成功统计、不得丢掉 error/trace。
    if result.get("success") is False or (_engine == "node" and result.get("success") is not True):
        _last_run_ms = round((time.time() - t0) * 1000, 1)
        code = _stable_p1_error_code(result.get("code"), "E_P1_PIPELINE_RESULT_FAILED")
        error = "P1 recall pipeline returned a failure"
        _safe_log(
            f"[p1_server] runP1 管线失败封包: code={code}; "
            f"error={result.get('error')}; trace={result.get('trace')}"
        )
        run_log = _append_run_log({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": _src_tag,
            "mode": canonical_mode, "requestedMode": requested_mode, "canonicalMode": canonical_mode,
            "chatId": chat_id, "historyChatId": history_chat_id,
            "historyCount": len(chat_history), "ms": _last_run_ms, "success": False,
            "user": username or None, "char": char_name or None,
            "input": input_text[:500],
            "code": code,
            "error": error,
        }, cfg, should_write=_log_this)
        failure = {
            "success": False, "p1_act": [], "code": code,
            "error": error,
            "trace": {
                "request": dict(mode_audit),
                "transport": transport_trace,
                "failure": {"code": code},
            },
            "runLog": run_log,
        }
        return JSONResponse(failure, status_code=500)
    # runP1 成功路径记录统计（旧插件 main.mjs _runP1 L269-271 平移）：getStats/getData 消费
    _last_run_time = int(time.time() * 1000)
    _last_run_ms = round((time.time() - t0) * 1000, 1)
    _last_dir_word_count = len(result.get("p1_act") or [])
    # 每次输出落盘记录（0731 002）：方向词+召回记忆全量（记忆 content 已经管线 snippet 截断）
    run_log = _append_run_log({
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": _src_tag,
        "mode": canonical_mode, "requestedMode": requested_mode, "canonicalMode": canonical_mode,
        "chatId": chat_id, "historyChatId": history_chat_id,
        "historyCount": len(chat_history), "ms": _last_run_ms, "success": True,
        "user": username or None, "char": char_name or None,
        "input": input_text[:500],
        "p1_act": result.get("p1_act") or [],
        "directionWords": result.get("directionWords") or [],
        # stdio 已按 snippetMaxChars 限长；运行记录保留 record/date/pinned/importance 与排序分解，
        # 否则 HTTP 白盒可见而落盘复盘证据被服务壳二次裁掉。
        "recalledRecords": [dict(record) for record in (result.get("recalledRecords") or []) if isinstance(record, dict)],
        # P9 CLI 以运行记录为证据做词库诊断/后期调参建议；保留结构化白盒包，
        # 不要求用户从前端复制渲染文本，也不让 P9 反向猜测主链路发生了什么。
        "feedbackPacket": result.get("feedbackPacket") if isinstance(result.get("feedbackPacket"), dict) else None,
    }, cfg, should_write=_log_this)
    # HTTP 壳不重组 Node 输出：保留 engine/memory/config/trace/whitebox 等运行证据，
    # 旧消费方依赖的字段仍由管线原样提供。Python 旧引擎没有 success 字段时在此补入。
    return JSONResponse({
        "success": True, **result,
        "requestedMode": requested_mode, "canonicalMode": canonical_mode,
        "runLog": run_log,
    })


@app.post("/clearCaches")
async def clear_caches(req: Request) -> dict[str, Any]:
    body = await req.json()
    tier = str(body.get("tier") or "light")
    cfg = get_user_config(_username(req, body))
    cleared = _clear_runtime_caches(tier, str(cfg.get("engine") or "node"))
    return {**cleared, "tier": tier}


@app.post("/getConfig")
async def get_config_action(_req: Request) -> dict[str, Any]:
    return {"success": True, "config": get_config(), "defaults": DEFAULTS}


@app.post("/setConfig")
async def set_config_action(req: Request) -> dict[str, Any]:
    body = await req.json()
    cfg = update_config({k: v for k, v in body.items() if k != "username"})
    return {"success": True, "config": cfg}


@app.post("/updateConfig")
async def update_config_action(req: Request) -> dict[str, Any]:
    """面板用户域更新：服务键写全局，其余已知键写鉴权用户 overlay。

    /setConfig 仍是独立服务的全局管理契约，不与面板 updateConfig 混用。
    """
    body = await req.json()
    username = _username(req, body)
    patch = {k: v for k, v in body.items() if k != "username"}
    service_patch = {k: v for k, v in patch.items() if k in SERVICE_KEYS}
    if service_patch:
        update_config(service_patch)
    cfg = update_user_config(username, patch)
    return {"success": True, "config": cfg}


@app.post("/getStats")
async def get_stats(_req: Request) -> dict[str, Any]:
    """对照旧插件 getStats，并回报独立服务的真实空闲停机状态。"""
    cfg = get_config()
    engine = str(cfg.get("engine") or "node")
    if engine == "node":
        pipeline_loaded = _process_running(_node_state.get("proc"))
    else:
        pipeline_loaded = _pipeline_mod is not None
    warmup = await asyncio.to_thread(_warmup_snapshot, engine)
    return {
        "enabled": cfg.get("enabled", True),
        "pipelineLoaded": pipeline_loaded,
        "readyForRecall": warmup["readyForRecall"],
        "warmup": warmup,
        "activeRuns": _active_runs,
        "clearing": None,
        "lastRunTime": _last_run_time,
        "lastRunMs": _last_run_ms,
        "lastDirWordCount": _last_dir_word_count,
        "idleUnloadMinutes": round(int(cfg.get("idleShutdownSec") or 0) / 60, 2),
        "lastCacheClear": None,
    }


@app.post("/unloadCaches")
async def unload_caches(req: Request) -> dict[str, Any]:
    """真卸载：清理可重建缓存后终止 Node/分词/向量/LLM tokenizer 进程。"""
    global _warmup_task, _warmup_state
    body = await req.json()
    tier = str(body.get("tier") or "deep")  # 旧插件手动清缓存默认走 deep（_clearCaches() 无 opts）
    cfg = get_user_config(_username(req, body))
    cleared = _clear_runtime_caches(tier, str(cfg.get("engine") or "node"))
    if not cleared.get("success"):
        return cleared
    _stop_node_stdio()
    _stop_cluster_services()
    _warmup_task = None
    _warmup_state = {
        "state": "cold", "engine": str(cfg.get("engine") or "node"),
        "startedAt": None, "finishedAt": None, "ms": None,
        "error": None, "code": None, "resources": None,
    }
    return {**cleared, "unloaded": True, "message": "P1 可重建缓存已清理，重资源进程已停止"}


# 控件元数据单源下发（0722 禁前端硬编码：min/max/desc 权威在后端）。旧插件 main.mjs GetData
# L340-369 平移并补齐独立服务的空闲停机生命周期。
_CONTROL_META: list[dict[str, Any]] = [
    {"key": "enabled", "group": "基础设置", "type": "toggle", "label": "启用 P1 自驱动召回", "desc": "开启后每次对话自动运行本地联想召回管线产出方向词；首次向量加载会明显较慢"},
    {"key": "idleShutdownSec", "group": "基础设置", "type": "number", "label": "空闲停机秒数", "desc": "无 runP1 活动达到该时间后停止整个 P1 进程树释放重资源；0=常驻", "min": 0, "max": 3600},
    {"key": "dataRecall", "group": "召回参数", "type": "toggle", "label": "记忆 Data 召回", "desc": "启用记忆三层（热/温/冷）擦边召回"},
    {"key": "entryTopK", "group": "召回参数", "type": "number", "label": "条目 Top-K", "desc": "多维排序后取前 K 个子条目提词", "min": 5, "max": 50},
    {"key": "resonanceW", "group": "召回参数", "type": "number", "label": "共振权重", "desc": "多路共振加分权重（0=关闭共振）", "min": 0, "max": 2, "step": 0.1},
    {"key": "combinedMin", "group": "召回参数", "type": "number", "label": "锚点最低门槛", "desc": "上下文锚点 combined 最低分（002 定档=4）", "min": 2, "max": 10},
    {"key": "nbRerank", "group": "召回参数", "type": "toggle", "label": "NB300 候选重排", "desc": "只对稀疏候选做语义复核，不扫描零字面命中的全库条目"},
    {"key": "sparseTopK", "group": "召回参数", "type": "number", "label": "稀疏候选 Top-K", "desc": "进入 NB300 末段前最多保留的条目数", "min": 20, "max": 500},
    {"key": "bm25K1", "group": "召回参数", "type": "number", "label": "BM25 K1", "desc": "词频饱和强度；标准默认 1.2", "min": 0.1, "max": 3, "step": 0.1},
    {"key": "bm25B", "group": "召回参数", "type": "number", "label": "BM25 B", "desc": "条目长度归一强度；标准默认 0.75", "min": 0, "max": 1, "step": 0.05},
    {"key": "termTopK", "group": "召回参数", "type": "number", "label": "条目提词 Top-K", "desc": "每条候选最多贡献的语义词和稀疏 OOV 词总数；不会用 NB 缺词做硬删除", "min": 1, "max": 20},
    {"key": "nbDedupThreshold", "group": "召回参数", "type": "number", "label": "NB 近义去重阈值", "desc": "候选词对的 NB300 cosine 超过此值才合并；框架默认0.85", "min": 0, "max": 1, "step": 0.01},
    {"key": "contextMessages", "group": "召回输入", "type": "number", "label": "用户上下文条数", "desc": "单位是 user 消息；框架默认最近5条，可配置0到5；当前输入单独传入，assistant 只用于复制检测、不进入召回单元", "min": 0, "max": 5},
    {"key": "inputMaxChars", "group": "召回输入", "type": "number", "label": "输入软上限", "desc": "超长输入优先保留完整尾句，默认沿用历史 80 字契约", "min": 20, "max": 500},
    {"key": "shortSegmentChars", "group": "召回输入", "type": "number", "label": "短句合并阈值", "desc": "超长消息中连续短句先合并再执行软上限", "min": 1, "max": 80},
    {"key": "excludeExactAssistantCopies", "group": "召回输入", "type": "toggle", "label": "排除整段 AI 复制", "desc": "用户文本与更早 assistant 完整规范化文本相同时不进入召回上下文"},
    {"key": "recentDataTopK", "group": "召回参数", "type": "number", "label": "最近 Data 数", "desc": '把最近 N 条记忆的名词并入召回上下文（记忆连续性）。0=关闭：检索只看当前输入，弱输入时不再召回"最近记忆"（英文/短句场景更准）', "min": 0, "max": 50},
    {"key": "recordTopK", "group": "召回参数", "type": "number", "label": "记录召回 Top-K", "desc": "最终返回并注入主 AI 的记忆记录数", "min": 1, "max": 50},
    {"key": "candidateMinHits", "group": "召回参数", "type": "number", "label": "候选最低命中数", "desc": "倒排候选至少命中的独立词数；最低为 2，避免单词暴力匹配", "min": 2, "max": 8},
    {"key": "layerWeightHot", "group": "召回参数", "type": "number", "label": "热层排序权重", "desc": '当天记忆(hot)在排序中的层级加权；调低可减少"最近的记忆压过更相关的记忆"', "min": 0, "max": 2, "step": 0.05},
    {"key": "layerWeightWarm", "group": "召回参数", "type": "number", "label": "温层排序权重", "desc": "近期记忆(warm)的层级加权", "min": 0, "max": 2, "step": 0.05},
    {"key": "layerWeightCold", "group": "召回参数", "type": "number", "label": "冷层排序权重", "desc": "归档记忆(cold)的层级加权", "min": 0, "max": 2, "step": 0.05},
    {"key": "collapseSameFileKeywordSet", "group": "召回参数", "type": "toggle", "label": "合并同文件同关键词版本", "desc": "同一文件、同一关键词集合且都有事件时间时，只保留排序更高的版本"},
    {"key": "snippetMaxChars", "group": "召回参数", "type": "number", "label": "记录摘要上限", "desc": "单条召回记录最多进入注入数据的字符数", "min": 40, "max": 2000},
    {"key": "injectMaxChars", "group": "召回参数", "type": "number", "label": "注入总字数上限", "desc": "输出线：按关联度从高到低保留，到达字数后低关联记录整条删除；0=不限制", "min": 0, "max": 20000},
    {"key": "recencyDecayBase", "group": "召回参数", "type": "number", "label": "时近衰减基数", "desc": "按小时计算的 recency 衰减；无时间记录不伪造为当前时间", "min": 0.9, "max": 1, "step": 0.001},
    {"key": "blqRerank", "group": "召回参数", "type": "toggle", "label": "BLQ 候选重排", "desc": "BLQ 始终输出分项；开启后只对已有候选做后置重排"},
    {"key": "includeMarkdown", "group": "召回参数", "type": "toggle", "label": "读取 Markdown 归档", "desc": "Markdown 与 JSON/JSONL 使用同一条倒排/BM25/NB 候选链"},
    {"key": "indexCacheMax", "group": "内存管理", "type": "number", "label": "倒排索引缓存上限", "desc": "最多保留多少个用户/角色/mode 的记忆索引；使用 LRU 淘汰", "min": 1, "max": 64},
    {"key": "nbCacheMaxVectors", "group": "内存管理", "type": "number", "label": "NB 子集向量缓存上限", "desc": "跨请求最多缓存多少个 300d 向量；0=每次只读、不跨请求缓存", "min": 0, "max": 200000},
    {"key": "vocabEditMaxChanges", "group": "词库管理", "type": "number", "label": "P9 单次改动上限", "desc": "AI 一次 <vocab_edit> 最多改动的词条数，超限拒绝（防失控大改）", "min": 1, "max": 200},
    {"key": "atSearchMaxHits", "group": "高级", "type": "number", "label": "AT 搜索命中上限", "desc": "AT 主词库搜索（atSearch）单次最多返回的命中条数，超出截断", "min": 1, "max": 500},
    {"key": "atBrowseLimitDefault", "group": "高级", "type": "number", "label": "AT 浏览分页默认条数", "desc": "atBrowse 未指定 limit 时每页默认返回的词条数", "min": 1, "max": 200},
    {"key": "atBrowseLimitMax", "group": "高级", "type": "number", "label": "AT 浏览分页上限", "desc": "atBrowse limit 参数的钳制上限，防止单页请求过大", "min": 50, "max": 1000},
    {"key": "typingDebounceMs", "group": "召回输入", "type": "number", "label": "打字联想防抖(ms)", "desc": "输入框停顿多久后触发一次打字式联想请求", "min": 100, "max": 3000},
    {"key": "typingMinChars", "group": "召回输入", "type": "number", "label": "打字联想触发门槛(字)", "desc": "输入不足该字数时不触发打字式联想", "min": 1, "max": 20},
    {"key": "runLogEnabled", "group": "运行记录", "type": "toggle", "label": "召回输出落盘记录", "desc": "每次真实召回把输出按天写入 JSONL 记录文件（打字联想轻量调用不记录）；文件位置见「运行记录」卡片"},
    {"key": "runLogKeepDays", "group": "运行记录", "type": "number", "label": "记录保留天数", "desc": "跨天写入时自动删除过期记录文件；0=永久保留", "min": 0, "max": 3650},
    # ── P1v2 白盒新管线(0801) ──
    {"key": "engine", "group": "引擎", "type": "select", "label": "召回引擎", "desc": "node=白盒新管线 / python=旧管线(回退通道)", "options": ["node", "python"]},
    {"key": "dataCount", "group": "召回输入", "type": "number", "label": "Data 召回条数", "desc": "data 记忆最近 N 条进召回语境", "min": 0, "max": 20},
    {"key": "memoryFileMaxBytes", "group": "召回输入", "type": "number", "label": "单个记忆文件上限(字节)", "desc": "P1 读取宿主记忆语料时允许的单文件最大字节数；超限会返回可诊断的存储状态", "min": 65536, "max": 67108864, "step": 65536},
    {"key": "inputMaxWords", "group": "召回输入", "type": "number", "label": "分词截断上限(词)", "desc": "分词后按词数截断,头尾保留", "min": 20, "max": 500},
    {"key": "truncHeadRatio", "group": "召回输入", "type": "number", "label": "截断头段占比", "desc": "0.5=头尾各半; 0.3=头30%尾70%", "min": 0.1, "max": 0.9, "step": 0.1},
    {"key": "ctxWordsPerUnit", "group": "召回输入", "type": "number", "label": "上下文每条取词数", "desc": "非当前输入的上下文/data 每条取 N 个低频词做锚", "min": 1, "max": 10},
    {"key": "concFloor", "group": "分词过滤", "type": "number", "label": "中文具体性下限", "desc": "具体性评分低于此值的虚化词过滤(1-5量表,5=最具体)", "min": 1.0, "max": 5.0, "step": 0.1},
    {"key": "enConcFloor", "group": "分词过滤", "type": "number", "label": "英文具体性下限", "desc": "同上(英文 brysbaert 量表)", "min": 1.0, "max": 5.0, "step": 0.1},
    {"key": "enFreqHigh", "group": "分词过滤", "type": "number", "label": "英文高频排除线", "desc": "ECDICT 词频超此值排除(0=只标注不过滤)", "min": 0, "max": 99999999},
    {"key": "englishPosBackend", "group": "分词过滤", "type": "select", "label": "英文词性后端", "desc": "wordnet=2GB预算下的词法POS并复用向量服务；stanza=上下文POS但会加载PyTorch重模型；none=不做英文词性过滤", "options": ["wordnet", "stanza", "none"]},
    {"key": "swowTopK", "group": "发散机制", "type": "number", "label": "SWOW 每词联想数", "desc": "每个输入词取前 K 个自由联想词", "min": 1, "max": 30},
    {"key": "swowMinSupZh", "group": "发散机制", "type": "number", "label": "SWOW 中文支持度", "desc": "多词输入时需 N 个词共同联想到才进池(1=宽松)", "min": 1, "max": 5},
    {"key": "cnTopK", "group": "发散机制", "type": "number", "label": "ConceptNet 每词取数", "desc": "ConceptNet 每词每关系取前 K 个", "min": 1, "max": 50},
    {"key": "cilinMaxL3", "group": "发散机制", "type": "number", "label": "词林同小类上限", "desc": "L3 层级扩展每词上限(0=关闭)", "min": 0, "max": 10},
    {"key": "cilinMaxL2", "group": "发散机制", "type": "number", "label": "词林同中类上限", "desc": "L2 层级扩展每词上限(0=关闭,默认关:噪声源)", "min": 0, "max": 10},
    {"key": "atomicTopK", "group": "发散机制", "type": "number", "label": "ATOMIC 事件推理数", "desc": "每个英文词的事件推理取前 K 条", "min": 1, "max": 20},
    {"key": "shortInputChars", "group": "召回参数", "type": "number", "label": "短输入字数门槛", "desc": "输入文本短于此字数时,1 个词命中即可召回(不按文档长度计算门槛)", "min": 1, "max": 100},
    {"key": "hitsDivisor", "group": "召回参数", "type": "number", "label": "命中除数", "desc": "标准门槛: 每 N 字需 1 个词命中;调大=更宽松(默认 10)", "min": 2, "max": 100},
    {"key": "mechDisable", "group": "发散机制", "type": "text", "label": "关停机制", "desc": "逗号分隔: swow_zh,conceptnet_zh,cilin,swow_en,atomic,conceptnet_en"},
    {"key": "ibAlpha", "group": "打分", "type": "number", "label": "IB 倒U α", "desc": "信息瓶颈意外性参数(峰值在 d*=1/√α)", "min": 0.5, "max": 8.0, "step": 0.1},
    {"key": "hitWeight", "group": "排序", "type": "number", "label": "关联词命中加分", "desc": "被检索文档每命中一个发散词的加分", "min": 0, "max": 5.0, "step": 0.1},
    {"key": "phraseWeight", "group": "排序", "type": "number", "label": "短语匹配加分", "desc": "LLM token 连续命中≥3 时每 token 加分", "min": 0, "max": 5.0, "step": 0.1},
    {"key": "phraseMinRun", "group": "排序", "type": "number", "label": "短语最小连续数", "desc": "连续 LLM token 命中≥N 才算短语级匹配", "min": 2, "max": 10},
    {"key": "topInputBonus", "group": "排序", "type": "number", "label": "Top词额外加成", "desc": "发散池 Top 词命中时的额外加分", "min": 0, "max": 2.0, "step": 0.1},
    {"key": "exactAnchorBonus", "group": "排序", "type": "number", "label": "专名精确直达加分", "desc": "专名或 metadata keyword 与输入锚点精确匹配、直接进入候选时的独立加分", "min": 0, "max": 5.0, "step": 0.05},
    {"key": "timeMatchBonus", "group": "排序", "type": "number", "label": "显式时间匹配加分", "desc": "输入中的显式时间锚与记录事件时间或文件日期匹配时的独立加分", "min": 0, "max": 5.0, "step": 0.05},
    {"key": "recordTopBonus", "group": "排序", "type": "number", "label": "置顶记录加分", "desc": "记录自身 pinned/top 标记的独立加分；不同于发散池 Top 词加成", "min": 0, "max": 5.0, "step": 0.05},
    {"key": "recordImportanceWeight", "group": "排序", "type": "number", "label": "记录重要度权重", "desc": "记录自身 weight/importance（0..1）参与排序时的加权系数", "min": 0, "max": 5.0, "step": 0.05},
    {"key": "fusion", "group": "排序", "type": "select", "label": "融合方式", "desc": "weighted=加权求和 / rrf=倒数排名融合", "options": ["weighted", "rrf"]},
    {"key": "experimentLog", "group": "实验", "type": "toggle", "label": "实验储存", "desc": "每次召回结果独立落盘 JSONL（按角色卡隔离，用于展示和问题收集，不存入对话）"},
    {"key": "copyJaccardThreshold", "group": "召回输入", "type": "number", "label": "复制排除 Jaccard 阈值", "desc": "上下文 user 与前一条 assistant 的字符 bigram Jaccard 大于此值时按复制文本排除；范围0到1，框架默认0.7 [待实验定]", "min": 0, "max": 1, "step": 0.01},
]

# Controls are classified by their real consumer, not by where their default is
# stored.  The panel renders only common + active-engine controls, so switching
# engines cannot expose knobs that the selected pipeline never reads.
_CONTROL_META_SCOPE_KEYS: dict[str, frozenset[str]] = {
    "common": frozenset({
        "enabled", "idleShutdownSec", "engine", "dataRecall", "entryTopK",
        "bm25K1", "bm25B", "contextMessages", "shortSegmentChars", "recordTopK",
        "layerWeightHot", "layerWeightWarm", "layerWeightCold", "snippetMaxChars",
        "injectMaxChars", "recencyDecayBase", "includeMarkdown", "indexCacheMax",
        "vocabEditMaxChanges", "atSearchMaxHits", "atBrowseLimitDefault",
        "atBrowseLimitMax", "typingDebounceMs", "typingMinChars", "runLogEnabled",
        "runLogKeepDays",
    }),
    "node": frozenset({
        "copyJaccardThreshold",
        "dataCount", "memoryFileMaxBytes", "inputMaxWords", "truncHeadRatio",
        "ctxWordsPerUnit", "concFloor", "enConcFloor", "enFreqHigh",
        "englishPosBackend", "swowTopK", "swowMinSupZh", "cnTopK", "cilinMaxL3",
        "cilinMaxL2", "atomicTopK", "shortInputChars", "hitsDivisor", "mechDisable",
        "ibAlpha", "hitWeight", "phraseWeight", "phraseMinRun", "topInputBonus",
        "exactAnchorBonus", "timeMatchBonus", "recordTopBonus", "recordImportanceWeight",
        "fusion", "experimentLog", "nbDedupThreshold",
    }),
    "python": frozenset({
        "resonanceW", "combinedMin", "nbRerank", "sparseTopK", "termTopK",
        "inputMaxChars", "excludeExactAssistantCopies", "recentDataTopK",
        "candidateMinHits", "collapseSameFileKeywordSet", "blqRerank",
        "nbCacheMaxVectors",
    }),
}


def _audit_control_meta_scopes() -> None:
    meta_keys = [str(item.get("key") or "") for item in _CONTROL_META]
    if not all(meta_keys) or len(meta_keys) != len(set(meta_keys)):
        raise RuntimeError("P1 control meta keys must be non-empty and unique")
    scope_names = set(_CONTROL_META_SCOPE_KEYS)
    if scope_names != {"common", "node", "python"}:
        raise RuntimeError(f"P1 control meta scopes are invalid: {sorted(scope_names)}")
    common = _CONTROL_META_SCOPE_KEYS["common"]
    node = _CONTROL_META_SCOPE_KEYS["node"]
    python = _CONTROL_META_SCOPE_KEYS["python"]
    overlaps = (common & node) | (common & python) | (node & python)
    classified = common | node | python
    actual = set(meta_keys)
    if overlaps:
        raise RuntimeError(f"P1 control meta keys have overlapping scopes: {sorted(overlaps)}")
    if classified != actual:
        missing = sorted(actual - classified)
        unknown = sorted(classified - actual)
        raise RuntimeError(f"P1 control meta scope mismatch: unclassified={missing}, unknown={unknown}")
    missing_defaults = sorted(actual - set(DEFAULTS))
    if missing_defaults:
        raise RuntimeError(f"P1 control meta keys have no config defaults: {missing_defaults}")


_audit_control_meta_scopes()


def _control_meta_for_engine(engine: str) -> list[dict[str, Any]]:
    if engine not in ("node", "python"):
        raise ValueError(f"unsupported P1 engine: {engine}")
    common = _CONTROL_META_SCOPE_KEYS["common"]
    active = _CONTROL_META_SCOPE_KEYS[engine]
    return [
        {**item, "scope": "common" if item["key"] in common else engine}
        for item in _CONTROL_META
        if item["key"] in common or item["key"] in active
    ]


@app.post("/getData")
async def get_data(req: Request) -> dict[str, Any]:
    """GetData 聚合：对照旧插件 main.mjs interfaces.config.GetData（L317-383）完整形状。
    config 平铺键：旧插件源码此处实际只平铺了 enabled/dataRecall/entryTopK/.../indexCacheMax/
    nbCacheMaxVectors 这 15 键（漏了 contextMessages/recordTopK/layerWeight*等 13 个 meta 引用到
    的键——前端渲染 d[m.key] 拿不到值，是旧插件真实存在的取值缺口，非本次臆造）；这里改为把
    DEFAULTS 中所有面向前端的键（排除 port/resourceDir/dataRoot/vocabDir 四个服务内部路径类配置）
    全量平铺，让当前引擎 meta 里每一条控件都能在顶层拿到初值。meta 仅下发
    common + 当前 engine 的真实消费项，metaScope 同步回显后端分类，前端不维护第二份硬编码清单。
    """
    body = await _json_object_or_empty(req)
    username = _username(req, body)
    cfg = get_user_config(username)
    engine = str(cfg.get("engine") or "node")
    pipeline_loaded = (_process_running(_node_state.get("proc"))
                       if engine == "node" else _pipeline_mod is not None)
    warmup = await asyncio.to_thread(_warmup_snapshot, engine)
    flat = {k: cfg[k] for k in DEFAULTS if k not in ("port", "resourceDir", "dataRoot", "vocabDir")}
    return {
        **flat,
        "engine": engine,
        "pipelineLoaded": pipeline_loaded,
        "readyForRecall": warmup["readyForRecall"],
        "warmup": warmup,
        "lastRunTime": _last_run_time,
        "lastRunMs": _last_run_ms,
        "lastDirWordCount": _last_dir_word_count,
        "meta": _control_meta_for_engine(engine),
        "metaScope": {
            "engine": engine,
            "commonKeys": [item["key"] for item in _CONTROL_META if item["key"] in _CONTROL_META_SCOPE_KEYS["common"]],
            "engineKeys": [item["key"] for item in _CONTROL_META if item["key"] in _CONTROL_META_SCOPE_KEYS[engine]],
        },
        "setdataWrap": "updateConfig",
        "scope": {"username": username, "config": "user-overlay" if username else "global"},
        "stats": {
            "pipelineLoaded": pipeline_loaded,
            "readyForRecall": warmup["readyForRecall"],
            "warmupState": warmup["state"],
            "activeRuns": _active_runs,
            "clearing": None,
            "lastRunMs": _last_run_ms,
            "lastDirWordCount": _last_dir_word_count,
            "idleUnloadMinutes": round(int(cfg.get("idleShutdownSec") or 0) / 60, 2),
            "lastCacheClear": None,
        },
        "description": "P1 自驱动召回 — 本地联想管线（SWOW+NB300+多路池），产出方向词注入主 AI 上下文",
    }


# ── 词库管理（P1 自持数据域；形状对照旧插件同名 action）──

def _vocab_dir(username: str = "") -> Path:
    """用户级词库是 P1 权威状态，固定落 storage/p1/users。"""
    cfg = get_config()
    if username:
        d = user_state_root(username) / "vocab"
    else:
        d = Path(cfg["vocabDir"])
    d.mkdir(parents=True, exist_ok=True)
    return d


def _invalidate_user_vocab_after_write(username: str) -> dict[str, Any]:
    """让用户级词库写入立即传到下一次召回；未加载管线时不存在旧缓存，视为已确认。"""
    if _pipeline_mod is None:
        return {"cacheInvalidated": True, "cacheInvalidation": "pipeline-not-loaded"}
    try:
        vocab_root = str(user_state_root(username) / "vocab")
        report = _pipeline_mod.invalidate_user_vocab_cache(vocab_root)
        if report.get("status") == "cleared":
            return {"cacheInvalidated": True, "cacheInvalidation": "python-user-vocab", "cacheReport": report}
        return {
            "cacheInvalidated": False,
            "cacheInvalidation": "python-user-vocab",
            "cacheWarning": f"词库已落盘，但运行缓存失效未确认: {report}",
        }
    except Exception as error:  # noqa: BLE001 — 落盘已成功，需把缓存半态如实回给 UI
        _safe_log(f"[p1_server] 用户词库缓存失效失败: {type(error).__name__}: {error}")
        return {
            "cacheInvalidated": False,
            "cacheInvalidation": "python-user-vocab",
            "cacheWarning": f"词库已落盘，但运行缓存失效失败: {type(error).__name__}: {error}",
        }


@app.post("/listVocabs")
async def list_vocabs(_req: Request) -> dict[str, Any]:
    """对照旧插件 main.mjs main._action==='listVocabs'（L451-478）：AT 主词库只读统计（4 固定模式，
    缺失文件标 missing）+ 用户插拔词库 CRUD 列表。vocab 文件结构 = {_meta:{name,modes,enabled}, entries:{...}}，
    entryCount=entries 键数（此前误把顶层非 _meta 键当 entries，词库真实结构是嵌套 entries 对象，已修正）。"""
    resource_dir = Path(get_config()["resourceDir"])
    at: list[dict[str, Any]] = []
    for m in AT_MODES:
        fp = resource_dir / f"activation_terms_{m}.json"
        try:
            st = fp.stat()
            at.append({"mode": m, "file": fp.name, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
        except OSError:
            at.append({"mode": m, "file": f"activation_terms_{m}.json", "size": 0, "mtime": None, "missing": True})

    user: list[dict[str, Any]] = []
    _u = _username(_req, {})
    for p in sorted(_vocab_dir(_u).glob("*.json")):
        try:
            j = json.loads(p.read_text(encoding="utf-8-sig"))
            meta = j.get("_meta", {}) if isinstance(j, dict) else {}
            entries = j.get("entries") if isinstance(j, dict) else None
            entries = entries if isinstance(entries, dict) else {}
            modes = meta.get("modes")
            user.append({
                "file": p.name,
                "name": meta.get("name") or p.name,
                "modes": modes if isinstance(modes, list) and modes else ["all"],
                "enabled": meta.get("enabled") is not False,
                "entryCount": len(entries),
                "mtime": int(p.stat().st_mtime * 1000),
            })
        except (OSError, json.JSONDecodeError):
            user.append({"file": p.name, "name": p.name, "broken": True})
    return {"success": True, "at": at, "user": user}


def _load_at_data(mode: str) -> dict:
    """AT 主词库按 mtime 缓存单 mode 解析结果，atSearch/atBrowse 共用（对照旧插件
    globalThis.__p1AtSearchCache，9MB 级文件避免每次请求重新解析）。文件不存在/损坏抛给调用方处理。"""
    fp = Path(get_config()["resourceDir"]) / f"activation_terms_{mode}.json"
    mt = fp.stat().st_mtime
    cached = _at_cache.get(mode)
    if cached and cached[0] == mt:
        return cached[1]
    data = json.loads(fp.read_text(encoding="utf-8"))
    _at_cache[mode] = (mt, data)
    return data


@app.post("/atSearch")
async def at_search(req: Request) -> dict[str, Any]:
    """AT 主词库搜索（只读，全维度 termName.includes(q) 扫描，命中上限 50）；对照旧插件
    main.mjs main._action==='atSearch'（L480-504）逐字段返回形状。"""
    body = await req.json()
    mode = body.get("mode") if body.get("mode") in AT_MODES else "chat"
    q = str(body.get("q") or "").strip()
    if not q:
        return {"success": False, "error": "搜索词为空"}
    try:
        at_data = _load_at_data(mode)
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": str(e)}
    max_hits = int(get_config()["atSearchMaxHits"])
    hits: list[dict[str, str]] = []
    for dim_key, terms in at_data.items():
        if not isinstance(terms, dict):
            continue
        for term_name in terms:
            if q in term_name:
                hits.append({"dim": dim_key, "term": term_name})
                if len(hits) >= max_hits:
                    break
        if len(hits) >= max_hits:
            break
    return {"success": True, "mode": mode, "q": q, "hits": hits, "truncated": len(hits) >= max_hits}


@app.post("/atBrowse")
async def at_browse(req: Request) -> dict[str, Any]:
    body = await req.json()
    mode = body.get("mode") if body.get("mode") in AT_MODES else "chat"
    try:
        at_data = _load_at_data(mode)
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": f"读取词库失败: {e}"}
    dim = str(body.get("dim") or "")
    if not dim:
        dims = [{"dim": k, "count": len(v)} for k, v in at_data.items() if isinstance(v, dict)]
        return {"success": True, "mode": mode, "dims": dims}
    terms = at_data.get(dim)
    if not isinstance(terms, dict):
        return {"success": False, "error": f"维度不存在: {dim}"}
    names = list(terms.keys())
    cfg = get_config()
    offset = max(0, int(body.get("offset") or 0))
    limit = min(int(cfg["atBrowseLimitMax"]), max(1, int(body.get("limit") or cfg["atBrowseLimitDefault"])))
    page = [{"term": t, "concepts": (terms[t] or {}).get("concepts", []) if isinstance(terms[t], dict) else []}
            for t in names[offset:offset + limit]]
    return {"success": True, "mode": mode, "dim": dim, "total": len(names), "offset": offset, "limit": limit, "entries": page}


def _safe_vocab_path(name: str, username: str = "") -> Path | None:
    fn = Path(str(name)).name  # 剥目录穿越
    if not _VOCAB_NAME_RE.match(fn):
        return None
    return _vocab_dir(username) / fn


@app.post("/getUserVocab")
async def get_user_vocab(req: Request) -> dict[str, Any]:
    body = await req.json()
    p = _safe_vocab_path(body.get("file") or "", _username(req, body))
    if p is None:
        return {"success": False, "code": "E_P1_VOCAB_INVALID_NAME", "error": "词库文件名非法"}
    if not p.exists():
        return {"success": False, "code": "E_P1_VOCAB_NOT_FOUND", "error": "词库不存在"}
    try:
        return {"success": True, "file": p.name, "content": json.loads(p.read_text(encoding="utf-8-sig"))}
    except json.JSONDecodeError as e:
        return {"success": False, "code": "E_P1_VOCAB_CORRUPT", "error": str(e)}
    except OSError as e:
        return {"success": False, "code": "E_P1_VOCAB_READ_FAILED", "error": str(e)}


@app.post("/saveUserVocab")
async def save_user_vocab(req: Request) -> dict[str, Any]:
    """新建/覆盖用户词库。校验规则对照旧插件 main.mjs main._action==='saveUserVocab'（L546-565）
    逐条照搬：文件名必须 .json 结尾；content 需 {_meta, entries:{词:[关联词,...]}}；entries 每个值
    必须是字符串数组；_meta 缺省时 name 用文件名/modes 用 ['all']/enabled 默认 true（盘为真相单源）。"""
    body = await req.json()
    fn = str(body.get("file") or "")
    if not fn.endswith(".json"):
        return {"success": False, "error": "文件名必须 .json 结尾"}
    username = _username(req, body)
    p = _safe_vocab_path(fn, username)
    if p is None:
        return {"success": False, "error": "文件名非法"}
    content = body.get("content")
    if not isinstance(content, dict) or not isinstance(content.get("entries"), dict):
        return {"success": False, "error": "格式错误：需要 {_meta, entries:{词:[关联词,...]}}"}
    entries = content["entries"]
    for k, v in entries.items():
        if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
            return {"success": False, "error": f'entries["{k}"] 必须是字符串数组'}
    meta = content.get("_meta") if isinstance(content.get("_meta"), dict) else {}
    modes = meta.get("modes")
    content["_meta"] = {
        "name": str(meta.get("name") or p.name),
        "modes": modes if isinstance(modes, list) and modes else ["all"],
        "enabled": meta.get("enabled") is not False,
    }
    try:
        tmp = p.with_suffix(f".tmp{int(time.time() * 1000)}")
        tmp.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
    except OSError as e:
        return {"success": False, "error": str(e)}
    return {"success": True, "file": p.name, "entryCount": len(entries), **_invalidate_user_vocab_after_write(username)}


@app.post("/toggleUserVocab")
async def toggle_user_vocab(req: Request) -> dict[str, Any]:
    body = await req.json()
    username = _username(req, body)
    p = _safe_vocab_path(body.get("file") or "", username)
    if p is None or not p.exists():
        return {"success": False, "error": "词库不存在或文件名非法"}
    try:
        j = json.loads(p.read_text(encoding="utf-8-sig"))
        j.setdefault("_meta", {})["enabled"] = bool(body.get("enabled", True))
        tmp = p.with_suffix(f".tmp{int(time.time() * 1000)}")
        tmp.write_text(json.dumps(j, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
        return {"success": True, "file": p.name, "enabled": j["_meta"]["enabled"], **_invalidate_user_vocab_after_write(username)}
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": str(e)}


@app.post("/deleteUserVocab")
async def delete_user_vocab(req: Request) -> dict[str, Any]:
    body = await req.json()
    username = _username(req, body)
    p = _safe_vocab_path(body.get("file") or "", username)
    if p is None or not p.exists():
        return {"success": False, "error": "词库不存在或文件名非法"}
    p.unlink()
    return {"success": True, "file": p.name, **_invalidate_user_vocab_after_write(username)}


# ── 运行记录（前端 p1run「运行记录」卡片消费；只读，写侧单点在 _append_run_log）──


def _run_log_endpoint_failure(
    code: str, message: str, stage: str, error: BaseException, *,
    file: str | None = None, extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    diagnostics = _run_log_diagnostics()
    diagnostics["errors"].append(_run_log_diagnostic(
        "error", stage, code, error, file=file,
    ))
    return {
        "success": False,
        "code": code,
        "error": _run_log_public_error(message, error),
        "diagnostics": diagnostics,
        **(extra or {}),
    }


def _run_log_query(body: dict[str, Any]) -> tuple[int, int]:
    values: dict[str, int] = {}
    for name, default in (("offset", 0), ("limit", 20)):
        raw = body.get(name, default)
        if isinstance(raw, bool):
            raise ValueError(f"{name} must be an integer")
        if isinstance(raw, int):
            parsed = raw
        elif isinstance(raw, str) and re.fullmatch(r"[+-]?\d+", raw.strip()):
            parsed = int(raw.strip())
        else:
            raise ValueError(f"{name} must be an integer")
        values[name] = parsed
    if values["offset"] < 0:
        raise ValueError("offset must be greater than or equal to 0")
    if not 1 <= values["limit"] <= 100:
        raise ValueError("limit must be between 1 and 100")
    return values["offset"], values["limit"]


def _run_log_read_scope(
    body: dict[str, Any], username: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Resolve the same canonical mode contract before any run-log directory access."""
    char_name = str(body.get("charName") or "").strip()
    chat_id = str(body.get("chatId") or body.get("chatid") or "").strip()
    raw_mode = body.get("mode")
    raw_active_mode = body.get("activeMode")
    requested_mode = _requested_run_mode(raw_mode, raw_active_mode)
    missing_scope = [name for name, value in (
        ("username", username), ("charName", char_name), ("chatId", chat_id),
        ("mode", _run_mode_present(requested_mode)),
    ) if not value]
    if missing_scope:
        return None, {
            "success": False,
            "code": "E_P1_SCOPE_INCOMPLETE",
            "error": "读取运行记录需要完整 username×charName×chatId×mode",
        }
    try:
        mode_audit = _resolve_run_mode_contract(raw_mode, raw_active_mode)
    except _RunModeResolutionError as error:
        return None, {
            "success": False,
            "code": error.code,
            "error": error.public_message,
            "mode": error.audit,
        }
    return {
        "username": username,
        "charName": char_name,
        "chatId": chat_id,
        **mode_audit,
    }, None


@app.post("/getRunLogInfo")
async def get_run_log_info(req: Request) -> dict[str, Any]:
    body = await req.json()
    username = _username(req, body)
    scope, scope_failure = _run_log_read_scope(body, username)
    if scope_failure is not None:
        return scope_failure
    assert scope is not None
    cfg = get_user_config(username)
    char_name = scope["charName"]
    mode = scope["canonicalMode"]
    chat_id = scope["chatId"]
    try:
        runs = _runs_dir_for(username, char_name, mode, chat_id)
    except OSError as error:
        _safe_log(
            f"[p1_server] 运行记录目录不可用: {type(error).__name__}: {error}; "
            f"scope={username}/{char_name}/{mode}/{chat_id}"
        )
        return _run_log_endpoint_failure(
            "E_P1_RUN_LOG_DIR", "P1 run log directory is unavailable", "directory", error,
        )
    files: list[dict[str, Any]] = []
    try:
        candidates = list(runs.glob("p1_runs_*.jsonl"))
    except OSError as error:
        _safe_log(
            f"[p1_server] 运行记录目录枚举失败: {type(error).__name__}: {error}; runs={runs}"
        )
        return _run_log_endpoint_failure(
            "E_P1_RUN_LOG_LIST", "P1 run log directory listing failed", "list", error,
        )
    stat_errors: list[dict[str, Any]] = []
    for p in candidates:
        if not _RUN_LOG_NAME_RE.match(p.name):
            continue
        try:
            st = p.stat()
            files.append({"file": p.name, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
        except OSError as error:
            _safe_log(
                f"[p1_server] 运行记录元数据读取失败: {type(error).__name__}: {error}; file={p}"
            )
            stat_errors.append(_run_log_diagnostic(
                "error", "stat", "E_P1_RUN_LOG_STAT", error, file=p.name,
            ))
    files.sort(key=lambda f: f["file"], reverse=True)
    if stat_errors:
        diagnostics = _run_log_diagnostics()
        diagnostics["errors"].extend(stat_errors)
        return {
            "success": False,
            "code": "E_P1_RUN_LOG_STAT",
            "error": "OSError: P1 run log metadata read failed",
            "diagnostics": diagnostics,
            "partial": True,
            "files": files,
        }
    return {"success": True, "dir": str(runs), "enabled": cfg.get("runLogEnabled") is not False,
            "keepDays": int(cfg.get("runLogKeepDays") or 0), "files": files,
            "scope": scope}


@app.post("/getRunLog")
async def get_run_log(req: Request) -> dict[str, Any]:
    body = await req.json()
    raw_file = body.get("file")
    fn = raw_file if isinstance(raw_file, str) else ""
    if not _RUN_LOG_NAME_RE.fullmatch(fn):
        return {"success": False, "code": "E_P1_RUN_LOG_FILE", "error": "运行记录文件 token 不合法"}
    username = _username(req, body)
    scope, scope_failure = _run_log_read_scope(body, username)
    if scope_failure is not None:
        return scope_failure
    assert scope is not None
    char_name = scope["charName"]
    mode = scope["canonicalMode"]
    chat_id = scope["chatId"]
    try:
        offset, limit = _run_log_query(body)
    except (TypeError, ValueError) as error:
        return _run_log_endpoint_failure(
            "E_P1_RUN_LOG_QUERY", "P1 run log pagination query is invalid", "query", error,
            file=fn,
        )
    try:
        runs = _runs_dir_for(username, char_name, mode, chat_id)
    except OSError as error:
        _safe_log(
            f"[p1_server] 运行记录目录不可用: {type(error).__name__}: {error}; "
            f"scope={username}/{char_name}/{mode}/{chat_id}"
        )
        return _run_log_endpoint_failure(
            "E_P1_RUN_LOG_DIR", "P1 run log directory is unavailable", "directory", error,
            file=fn,
        )
    fp = runs / fn
    try:
        lines = [ln for ln in fp.read_text(encoding="utf-8").splitlines() if ln.strip()]
    except (OSError, UnicodeDecodeError) as error:
        _safe_log(
            f"[p1_server] 运行记录读取失败: {type(error).__name__}: {error}; file={fp}"
        )
        return _run_log_endpoint_failure(
            "E_P1_RUN_LOG_READ", "P1 run log file read failed", "read", error, file=fn,
        )
    total = len(lines)
    # 记录按时间顺序追加，前端要最新在前：从尾部往前取一页再反转
    lo = max(0, total - offset - limit)
    hi = max(0, total - offset)
    entries: list[dict[str, Any]] = []
    diagnostics = _run_log_diagnostics()
    broken_count = 0
    for line_index in range(hi - 1, lo - 1, -1):
        ln = lines[line_index]
        try:
            entries.append(json.loads(ln))
        except json.JSONDecodeError as error:
            broken_count += 1
            entries.append({"broken": True, "raw": ln[:200]})
            diagnostic = _run_log_diagnostic(
                "warning", "jsonl", "P1_RUN_LOG_BROKEN_JSONL", error, file=fn,
            )
            diagnostic["line"] = line_index + 1
            diagnostics["warnings"].append(diagnostic)
    return {"success": True, "file": fn, "total": total, "offset": offset, "limit": limit, "entries": entries,
            "brokenCount": broken_count, "diagnostics": diagnostics,
            "scope": scope}


# ── P9 词库维护 AI 提示词：默认件随代码，用户副本落 storage/p1/users/<user>/ ──
# 对照旧插件 main.mjs main._action in {getP9Prompts,saveP9Prompts,resetP9Prompts}（L589-610）。
# P9 执行器（AI runner 接入）待 002 拍板，本服务先交付数据件机制（同旧插件口径）。

@app.post("/getP9Prompts")
async def get_p9_prompts(_req: Request) -> dict[str, Any]:
    try:
        default_data = json.loads(_P9_DEFAULT_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": str(e)}
    body = await _json_object_or_empty(_req)
    username = _username(_req, body)
    user_file = user_state_root(username) / "p9_prompts.json"
    user_data = None
    if user_file.exists():
        try:
            user_data = json.loads(user_file.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as e:
            return {"success": False, "code": "P1_P9_STATE_CORRUPT", "error": f"{user_file}: {e}"}
    prompts = user_data.get("prompts") if isinstance(user_data, dict) and user_data.get("prompts") else default_data.get("prompts")
    return {"success": True, "prompts": prompts, "isUserCopy": user_data is not None, "executorPending": True}


@app.post("/saveP9Prompts")
async def save_p9_prompts(req: Request) -> dict[str, Any]:
    body = await req.json()
    username = _username(req, body)
    user_file = user_state_root(username) / "p9_prompts.json"
    prompts = body.get("prompts")
    if not isinstance(prompts, list):
        return {"success": False, "error": "prompts 必须是数组"}
    try:
        user_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = user_file.with_suffix(f".tmp{int(time.time() * 1000)}")
        tmp.write_text(json.dumps({"_meta": {"savedAt": int(time.time() * 1000)}, "prompts": prompts}, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(user_file)
    except OSError as e:
        return {"success": False, "error": str(e)}
    return {"success": True, "count": len(prompts)}


@app.post("/resetP9Prompts")
async def reset_p9_prompts(req: Request) -> dict[str, Any]:
    body = await _json_object_or_empty(req)
    username = _username(req, body)
    user_file = user_state_root(username) / "p9_prompts.json"
    has_user_copy = user_file.is_file()
    if body.get("confirm") is not True:
        message = (
            "确定删除用户提示词副本并恢复核心默认件？"
            if has_user_copy else "当前没有用户提示词副本，已在使用核心默认件。"
        )
        return {
            "success": True,
            "action": "confirm_required",
            "hasUserCopy": has_user_copy,
            "message": message,
        }
    try:
        user_file.unlink()
        return {"success": True, "restored": True, "message": "已删除用户提示词副本并恢复核心默认件。"}
    except FileNotFoundError:
        return {"success": True, "restored": True, "message": "没有用户提示词副本，当前已是核心默认件。"}
    except OSError as e:
        return {"success": False, "error": str(e)}


def _ensure_cluster():
    with _cluster_start_lock:
        _ensure_cluster_locked()


def _ensure_cluster_locked():
    """集群服务按 runtime_contract.json 单源启动。

    端口存活不等于当前 P1 服务；必须同时校验 service+contract。旧仓库或错版本
    占端口时直接中止启动，不能带病进入字符分词降级。新拉起的服务等待就绪后才启动 HTTP 主服务。
    """
    _BRIDGE_DIR = str(P1_ROOT / "bridge")
    expected_contract = _P1_RUNTIME_CONTRACT["cluster"]["id"]

    for svc in _CLUSTER_SERVICES:
        port = int(_nos.environ.get(svc["env_port"]) or svc["port"])
        state, health = _probe_cluster_service(svc["name"], port)
        if state == "ready":
            _safe_log(f"[p1_server] 集群 {svc['name']}:{port} 已在运行")
            continue
        if state == "mismatch":
            raise RuntimeError(
                f"集群端口 {port} 被非当前 P1 服务占用: "
                f"expected={svc['name']}/{expected_contract}, actual={health}"
            )
        script = _nos.path.join(_BRIDGE_DIR, svc["script"])
        if not _nos.path.exists(script):
            raise RuntimeError(f"集群 {svc['name']} 脚本不存在: {script}")
        try:
            spawn_kwargs: dict[str, Any] = {}
            if _nos.name == "nt":
                spawn_kwargs["creationflags"] = _nsp.CREATE_NO_WINDOW
            p = _nsp.Popen(
                [_nsys.executable, script, "--port", str(port)],
                stdout=_nsp.DEVNULL, stderr=_nsp.DEVNULL, stdin=_nsp.DEVNULL,
                cwd=_BRIDGE_DIR,
                **spawn_kwargs,
            )
            _cluster_children[svc["name"]] = p
            deadline = time.time() + 20
            while time.time() < deadline:
                state, health = _probe_cluster_service(svc["name"], port)
                if state == "ready":
                    break
                if state == "mismatch":
                    raise RuntimeError(f"启动后契约不匹配: {health}")
                if not _process_running(p):
                    raise RuntimeError(f"进程已退出 code={p.returncode}")
                time.sleep(0.25)
            else:
                raise RuntimeError("20s 内未就绪")
            _safe_log(f"[p1_server] 集群 {svc['name']}:{port} 已启动并通过契约校验 (pid={p.pid})")
        except Exception as e:
            raise RuntimeError(f"集群 {svc['name']} 启动失败: {e}") from e


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="P1 召回独立服务（拉线测试入口：直接运行本文件）")
    parser.add_argument("--port", type=int, default=None, help="覆盖 config 端口（默认 13150）")
    parser.add_argument("--no-cluster", action="store_true", help="不自动启动集群服务")
    args = parser.parse_args()
    _cluster_autostart = not args.no_cluster
    import uvicorn  # noqa: PLC0415
    port = args.port or int(get_config()["port"])
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info")
    _uvicorn_server = uvicorn.Server(config)
    _uvicorn_server.run()
