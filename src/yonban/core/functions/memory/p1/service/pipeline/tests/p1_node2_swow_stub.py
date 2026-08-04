"""p1_node2_swow_stub.py — 分身A p1_node2_swow.py 未就绪时的最小测试 stub（禁与正式文件同名）。

  - diverge_node2: 零发散（swowPool=inputWords 原样），deferNb300 语义下 inputCentroid/nbPool=None
    ——与 JS deferNb300 默认路径一致（NB 延迟到 node0-data 稀疏候选后再加载）。
  - swow_diverge: 空联想（正式版=SWOW 多词定位）。
  - get_concreteness: None（=词不在具体度词库，JS getConcreteness 未收录同款返回）。
  - infer_subword_polarity: "neutral"（召回链 polarity 恒 neutral 不触达）。
"""
from __future__ import annotations

STUB = True


def diverge_node2(input_words, is_noise=None, opts=None):
    return {
        "swowPool": set(input_words or []),
        "inputCentroid": None,
        "nbPool": None,
        "trace_": {"inputSwowSize": 0, "stub": True},
    }


def swow_diverge(word, top_k=4):
    return []


def get_concreteness(word):
    return None


def infer_subword_polarity(word):
    return "neutral"


def get_node2_swow_cache_stats():
    return {"stub": True}


def clear_node2_swow_caches():
    return {"stub": True}
