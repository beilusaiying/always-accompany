"""p1_whitebox.py — P1 流程统一白盒可观测模块（JS 平移: p1/p1_whitebox.mjs）。

功能链：各节点 trace(node_id, lambda: payload) → _store → get_trace() → p1_pipeline_py 输出 whitebox 字段
why：P1 数值层无二元对错信号，必须每轮拿到真实中间数字供 Read 验证（002"白盒必须一直开着"铁律）；
     _enabled_all=True 常驻，live 路径读完即 clear_trace()。
关联链：
  ← p1_node0_anchor.py / p1_node0_data_recall.py / p1_node8_10_blq.py / p1_recall.py / p1_step1_bracket.py
  ← p1_pipeline_py.py（get_trace / clear_trace，每轮读完即清）
影响范围：进程内 _store dict 存各节点 trace 记录，无 I/O。
平移保真：接口/语义逐函数对照 p1_whitebox.mjs（trace/is_tracing/enable/disable/get_trace/clear_trace/dump_xml），
  payload 传 callable 时按 JS 同款"常开必求值"语义执行。
"""
from __future__ import annotations

import os
import time
import json
from typing import Any, Callable

_enabled: set[str] = set()          # 已开启观测的 node_id
_enabled_all: bool = True           # 常驻全开 [002 "白盒必须一直开着"]
_store: dict[str, list[dict]] = {}  # node_id -> [record, ...]
_seq: int = 0                       # 全局递增序号（跨节点可排出真实执行顺序）


def _init_from_env() -> None:
    """启动时读环境变量（单节点测试便捷开关）——同 JS _initFromEnv：不置假 _enabled_all。"""
    env = os.environ.get("P1_WHITEBOX")
    if not env:
        return
    global _enabled_all
    if env.strip() == "*":
        _enabled_all = True
        return
    for part in env.split(","):
        t = part.strip()
        if t:
            _enabled.add(t)


_init_from_env()


def _is_on(node_id: str) -> bool:
    return _enabled_all or node_id in _enabled


def trace(node_id: str, data: Any) -> None:
    """各节点在入口/出口调。disabled 时零开销直接返回；data 可为 dict 或无参 callable。"""
    global _seq
    if not _is_on(node_id):
        return
    payload = data() if callable(data) else data
    if not isinstance(payload, dict):
        payload = {"payload": payload}
    rec = {"seq": _seq, "ts": int(time.time() * 1000)}
    rec.update(payload)
    _seq += 1
    _store.setdefault(node_id, []).append(rec)


def is_tracing(node_id: str) -> bool:
    return _is_on(node_id)


def enable(node_id: str) -> None:
    global _enabled_all
    if node_id == "*":
        _enabled_all = True
        return
    _enabled.add(node_id)


def disable(node_id: str) -> None:
    global _enabled_all
    if node_id == "*":
        _enabled_all = False
        _enabled.clear()
        return
    _enabled.discard(node_id)


def enable_all() -> None:
    global _enabled_all
    _enabled_all = True


def disable_all() -> None:
    global _enabled_all
    _enabled_all = False
    _enabled.clear()


def get_trace(node_id: str | None = None):
    """get_trace() 返回 {node_id:[...]}; get_trace("node5") 返回列表。"""
    if node_id is None:
        return {k: v for k, v in _store.items()}
    return _store.get(node_id, [])


def clear_trace(node_id: str | None = None) -> None:
    global _seq
    if node_id is None:
        _store.clear()
        _seq = 0
    else:
        _store.pop(node_id, None)


def _esc(s: Any) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _fmt_value(v: Any, indent: str) -> str:
    if v is None:
        return _esc("None")
    if isinstance(v, (dict, list)):
        try:
            body = json.dumps(v, ensure_ascii=False, indent=2, default=str)
            return "\n" + indent + "  " + _esc(body.replace("\n", "\n" + indent + "  "))
        except (TypeError, ValueError):
            return _esc(str(v))
    return _esc(str(v))


def dump_xml(arg: Any = None) -> str:
    """把 trace 数据格式化为可读 XML（同 JS dumpXml，供 AI Read 四问）。"""
    if isinstance(arg, str):
        data = {arg: get_trace(arg)}
    elif isinstance(arg, list):
        data = {"trace": arg}
    else:
        data = arg or get_trace()

    lines = ["<whitebox>"]
    all_recs: list[dict] = []
    for node_id, recs in data.items():
        for r in recs:
            row = {"nodeId": node_id}
            row.update(r)
            all_recs.append(row)
    all_recs.sort(key=lambda r: r.get("seq", 0))

    for r in all_recs:
        node_id = r.get("nodeId")
        seq = r.get("seq", "")
        rest = {k: v for k, v in r.items() if k not in ("nodeId", "seq", "ts")}
        lines.append(f'  <node id="{_esc(node_id)}" seq="{seq}">')
        for k, v in rest.items():
            lines.append(f"    <{k}>{_fmt_value(v, '    ')}</{k}>")
        lines.append("  </node>")
    lines.append("</whitebox>")
    return "\n".join(lines)
