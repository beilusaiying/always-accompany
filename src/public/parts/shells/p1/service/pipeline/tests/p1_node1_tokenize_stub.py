"""p1_node1_tokenize_stub.py — 分身A p1_node1_tokenize.py 未就绪时的最小测试 stub（禁与正式文件同名）。

只为让分身B 召回层（node0/node0-data）可独立跑通：
  - soft_limit_recall_text: 直通不截断（正式版=0731 定档头尾双段截断 HEAD_RATIO 0.3）——
    >80 字输入的分词面会比 JS 生产宽，parity 结果差异属预期，报告已注明。
  - tokenize_node1 / tokenize_recall: 用 resources.run_step1_extract（真 jieba+BCC），无 POS 双词典/
    BCC 分级/单字降权/上下文名词回填。
  - is_noise_recall: 恒 False（无噪声词典）。
正式模块落盘后本 stub 仅供归档对照，不参与生产。
"""
from __future__ import annotations

import sys
from pathlib import Path

_PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_DIR))
from resources import run_step1_extract  # noqa: E402

STUB = True  # 供测试 _meta 识别


def soft_limit_recall_text(text, max_chars=None, short_segment_chars=None):
    t = str(text or "")
    return {
        "text": t,
        "originalLength": len(t),
        "processedLength": len(t),
        "truncated": False,
        "strategy": "stub-passthrough",
    }


def _is_noise_recall(word) -> bool:
    return False


is_noise_recall = _is_noise_recall


def tokenize_node1(text, context_text=None, config=None):
    words = run_step1_extract(text or "").get("words") or []
    return {"words": words, "intensifiers": [], "_trace": {"stub": True, "words": len(words)}}


def tokenize_recall(text):
    words = run_step1_extract(text or "").get("words") or []
    return {"inputWords": words, "_isNoise": is_noise_recall}


def get_node1_tokenize_cache_stats():
    return {"stub": True}


def clear_node1_tokenize_caches():
    return {"stub": True}
