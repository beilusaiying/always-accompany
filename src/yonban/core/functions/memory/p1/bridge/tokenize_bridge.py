# tokenize_bridge.py — 中文分词+词性桥(自驱动召回新管线 node1 的 Python 侧)
#
# 设计来源: P1_新管线设计_算法标注版.md §收集·分词
# 协议: stdin 收 JSON {"texts": ["...", ...]} → stdout 出 JSON
#   {"provider": {...}, "results": [[{"w","pos"}...], ...]}
# 强制 UTF-8 I/O(Windows 控制台默认 GBK 会毁中文)
#
# 词性提供者策略(白盒可追溯,provider 字段如实上报用的是谁):
#   - 分词以 jieba 精确模式为准(设计: jieba 速度快 74 倍,分词结果以 jieba 为准)
#   - 词性优先 HanLP(设计指定的词性权威);HanLP 未装/加载失败时用 jieba.posseg,
#     两者同为 ICTCLAS 风格标签(n/nr/ns/nt/nz/v/a/d...),下游白名单不变
#   - OOV 判定: 词不在 jieba 词频词典中 → oov=true(设计: 未登录词一律保留)

import sys, io, json

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")  # -sig: 容 BOM(0801确诊)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import jieba
import jieba.posseg as pseg

# HanLP CTB9 词性(设计: 分词以 jieba 为准,词性以 HanLP 为准;不一致以 HanLP 为准)
# CTB 标签 → ICTCLAS 语义映射(下游白名单 n/nr/t/v/d/r/m/q/p/c/u/x/e/o/a/f 不变)
_CTB2ICT = {
    "NR": "nr", "NN": "n", "NT": "t", "VV": "v", "VA": "a", "VC": "v", "VE": "v",
    "AD": "d", "PN": "r", "CD": "m", "OD": "m", "M": "q", "P": "p", "CC": "c", "CS": "c",
    "DEC": "u", "DEG": "u", "DER": "u", "DEV": "u", "AS": "u", "SP": "u", "ETC": "u", "MSP": "u",
    "PU": "x", "IJ": "e", "ON": "o", "JJ": "a", "LC": "f", "DT": "r", "BA": "p", "LB": "p", "SB": "p", "FW": "nx",
}
_HANLP_POS = None
_HANLP_ERR = None
def _load_hanlp():
    global _HANLP_POS, _HANLP_ERR
    if _HANLP_POS is not None or _HANLP_ERR is not None:
        return _HANLP_POS
    try:
        import hanlp
        _HANLP_POS = hanlp.load(hanlp.pretrained.pos.CTB9_POS_ELECTRA_SMALL)
    except Exception as e:  # HanLP 失败是合法降级态(退 jieba.posseg),不吞:provider 上报
        _HANLP_ERR = str(e)[:200]
    return _HANLP_POS

jieba.initialize()

# 自定义词典(设计§分词: 领域词典 load_userdict): main=acg+THUOCL(秒级);
# DomainWordsDict 916万词全量仅 env P1_USERDICT_FULL=on 加载(冷启分钟级,工程取舍 provider 上报)
import os as _os, time as _time
_UD_INFO = []
_RES_ROOT = _os.environ.get("P1_RESOURCE_DIR") or _os.path.join(_os.path.dirname(__file__), "..", "resources")
_DERIVED = _os.environ.get("P1V2_DERIVED") or _os.path.join(_RES_ROOT, "p1v2_derived")
for _name, _cond in (("userdict_main.txt", True), ("userdict_domain_full.txt", _os.environ.get("P1_USERDICT_FULL") == "on")):
    _f = _os.path.join(_DERIVED, _name)
    if _cond and _os.path.exists(_f):
        _t0 = _time.time()
        jieba.load_userdict(_f)
        _UD_INFO.append(f"{_name}({_time.time()-_t0:.1f}s)")

FREQ = jieba.dt.FREQ  # jieba 词典,用于 OOV 判定

# CoreNatureDictionary 双重校验(设计§分词: jieba+CoreNatureDictionary取交集,不一致以HanLP为准)
_CND = {}
_CND_PATH = _os.path.join(_RES_ROOT, 'CoreNatureDictionary.txt')
if _os.path.exists(_CND_PATH):
    for _line in open(_CND_PATH, encoding='utf-8', errors='replace'):
        _parts = _line.strip().split('\t')
        if len(_parts) >= 2:
            _CND[_parts[0]] = _parts[1]

# Stanza 英文(设计§分词: 英文Stanza tokenize,pos;惰性加载,失败退化 provider 上报)
_STANZA = None
_STANZA_ERR = None
def _load_stanza():
    global _STANZA, _STANZA_ERR
    if _STANZA is not None or _STANZA_ERR is not None:
        return _STANZA
    try:
        import stanza
        _STANZA = stanza.Pipeline("en", processors="tokenize,pos", verbose=False,
                                  tokenize_pretokenized=True)  # 词已由 jieba/英文正则切好,Stanza 只做 POS 不重切——保证与 JS 侧 token 一一对位回填
    except Exception as e:
        _STANZA_ERR = str(e)[:200]
    return _STANZA

import re as _re
_MIX_RE = _re.compile(r"[A-Za-z0-9.+#_\-]+|[\u4e00-\u9fff]+")
_HAS_LAT = _re.compile(r"[A-Za-z]")
_HAS_HAN = _re.compile(r"[\u4e00-\u9fff]")


_EN_SEG = _re.compile(r"[A-Za-z][A-Za-z0-9.+#_\-]*")

def _cut_zh(seg, toks):
    for w, pos in pseg.cut(seg):
        w = w.strip()
        if not w:
            continue
        toks.append({"w": w, "pos": pos, "oov": w not in FREQ or FREQ.get(w, 0) == 0})


def cut_with_pos(text):
    # 设计原文"中文英文混合需要单独检测,单独提取英文": 英文段先整体提出,不进 jieba
    # (0801实证: userdict 含 pa 词条时 jieba 把 parser 串切成 pa+rser;英文段与中文段各走对应管线)
    toks = []
    cursor = 0
    for m in _EN_SEG.finditer(text):
        _cut_zh(text[cursor:m.start()], toks)
        w = m.group()
        toks.append({"w": w, "pos": "eng", "oov": w.lower() not in FREQ, "enSeg": True})
        cursor = m.end()
    _cut_zh(text[cursor:], toks)
    return toks


def apply_stanza_upos(all_toks):
    """英文 token 按 unit 原序组序列喂 Stanza,回填 upos(设计: 保留 NOUN/PROPN/X,其余白名单外滤)"""
    seqs, refs = [], []
    for toks in all_toks:
        en = [t for t in toks if _HAS_LAT.search(t["w"]) and not _HAS_HAN.search(t["w"])]
        if en:
            seqs.append([t["w"] for t in en])
            refs.append(en)
    if not seqs:
        return "none_needed"
    nlp = _load_stanza()
    if nlp is None:
        return f"unavailable: {_STANZA_ERR}"
    try:
        doc = nlp(seqs)
    except Exception as e:
        return f"failed: {str(e)[:150]}"
    for sent, en in zip(doc.sentences, refs):
        for word, t in zip(sent.words, en):
            t["upos"] = word.upos
    return "stanza_en"


def apply_hanlp_pos(all_toks):
    """批量: jieba 分词结果喂 HanLP CTB9 词性,映射后覆盖 pos(以 HanLP 为准);失败整批保持 jieba"""
    model = _load_hanlp()
    if model is None:
        return "jieba_posseg"
    sents = [[t["w"] for t in toks] for toks in all_toks if toks]
    if not sents:
        return "hanlp_ctb9"
    try:
        tags = model(sents)
    except Exception as e:
        global _HANLP_ERR
        _HANLP_ERR = str(e)[:200]
        return "jieba_posseg"
    k = 0
    for toks in all_toks:
        if not toks:
            continue
        for t, ctb in zip(toks, tags[k]):
            mapped = _CTB2ICT.get(ctb)
            if mapped:
                t["pos"] = mapped
                t["pos_ctb"] = ctb
        k += 1
    # CoreNatureDictionary 双重校验(设计§分词): HanLP 没覆盖的词(pos_ctb 不在)检查 jieba vs CND 交集
    for toks in all_toks:
        for t in toks:
            if 'pos_ctb' not in t and t['w'] in _CND:
                cnd_pos = _CND[t['w']]
                if t['pos'] and t['pos'][0] != cnd_pos[0]:
                    t['pos'] = cnd_pos
                    t['pos_cnd'] = True
    return "hanlp_ctb9"


def main():
    payload = json.load(sys.stdin)
    texts = payload.get("texts", [])
    results = [cut_with_pos(t) for t in texts]
    pos_provider = apply_hanlp_pos(results)
    en_provider = apply_stanza_upos(results)
    out = {
        "provider": {
            "segmenter": "jieba_precise",
            "pos": pos_provider,
            "hanlp": "loaded" if _HANLP_POS is not None else f"unavailable: {_HANLP_ERR}",
            "stanza": en_provider,
            "userdict": _UD_INFO or ["none"],
        },
        "results": results,
    }
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
