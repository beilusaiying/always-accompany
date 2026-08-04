"""p1_pool_stub.py — 分身A p1_pool.py 未就绪时的最小测试 stub（禁与正式文件同名）。

build_recall_pool: 池内仅 SWOW 一路直通（对应 JS S1 行为等价语义——swowPool 原对象透传），
names/nb300/modeRes/user 词库四路缺席；poolMap=None → node0 交集分回退 +1 旧行为（JS Guard Clause 同款）。
"""
from __future__ import annotations

STUB = True


def build_recall_pool(args=None):
    args = args or {}
    swow_pool = args.get("swowPool")
    if swow_pool is None:
        swow_pool = set(args.get("inputWords") or [])
    return {
        "swowPool": swow_pool,
        "poolMap": None,
        "trace": {"stub": True, "poolSize": len(swow_pool), "multiSource": False},
    }


def get_recall_pool_cache_stats():
    return {"stub": True}


def clear_recall_pool_caches():
    return {"stub": True}
