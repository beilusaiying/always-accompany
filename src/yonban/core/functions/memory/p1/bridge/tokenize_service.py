# tokenize_service.py — 分词+词性 HTTP 常驻服务
#
# ONNX 版: 去掉 torch+HanLP 依赖(2GB→~200MB), 用 onnxruntime 推理 ELECTRA POS 模型
# GPU/CPU 自动切换: 有 CUDA → GPU(4.6ms/call), 无 → CPU(~20ms/call)
# 端口: 13151(env P1_TOK_PORT)

import io, sys, os, json, re, time

# ── 把 torch/lib 加进 PATH(onnxruntime CUDA 需要 cublasLt), 不 import torch 避免 500MB 开销 ──
import importlib.util as _ilu
_torch_spec = _ilu.find_spec("torch")
if _torch_spec and _torch_spec.submodule_search_locations:
    _torch_lib = os.path.join(list(_torch_spec.submodule_search_locations)[0], 'lib')
    if os.path.isdir(_torch_lib) and _torch_lib not in os.environ.get('PATH', ''):
        os.environ['PATH'] = _torch_lib + os.pathsep + os.environ.get('PATH', '')
del _ilu

# ── jieba 初始化 ──
import jieba
import jieba.posseg as pseg
jieba.initialize()

_DERIVED = os.environ.get("P1V2_DERIVED") or (
    os.path.join(os.path.dirname(__file__), "..", "..", "p1_res", "p1v2_derived")
    if os.path.exists(os.path.join(os.path.dirname(__file__), "..", "..", "p1_res", "p1v2_derived"))
    else r"D:\shajiuguan\自驱动召回\resources_derived")
_UD_INFO = []
for _name, _cond in (
    ("userdict_main.txt", True),
    ("userdict_moetype_acg.txt", True),
    ("userdict_domain_full.txt", os.environ.get("P1_USERDICT_FULL") == "on"),
):
    _f = os.path.join(_DERIVED, _name)
    if _cond and os.path.exists(_f):
        _t0 = time.time()
        jieba.load_userdict(_f)
        _UD_INFO.append(f"{_name}({time.time()-_t0:.1f}s)")

FREQ = jieba.dt.FREQ

# ── CoreNatureDictionary ──
_CND = {}
_CND_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'p1_res', 'CoreNatureDictionary.txt')
if not os.path.exists(_CND_PATH):
    _CND_PATH = r'D:\shajiuguan\p1shiyanshi\09_P1自驱动_专项\06_资源库_词库\P1资源库\CoreNatureDictionary.txt'
if os.path.exists(_CND_PATH):
    for _line in open(_CND_PATH, encoding='utf-8', errors='replace'):
        _parts = _line.strip().split('\t')
        if len(_parts) >= 2:
            _CND[_parts[0]] = _parts[1]

# ── ONNX POS 模型(替代 torch+HanLP, 内存 2GB→~200MB) ──
# 懒加载: 首次 /tokenize 请求才加载 ONNX+transformers, 不用不占内存
import numpy as np

_ONNX_DIR = os.path.join(_DERIVED, "hanlp_onnx")
_ONNX_MODEL = os.path.join(_ONNX_DIR, "pos_ctb9_electra_small.onnx")
_TAG_VOCAB_FILE = os.path.join(_ONNX_DIR, "tag_vocab.json")
_TOKENIZER_DIR = os.path.join(_ONNX_DIR, "tokenizer")

_ORT_SESSION = None
_ORT_DEVICE = "cpu"
_ORT_ERR = None
_TAG_VOCAB = {}
_ELECTRA_TOK = None
_gpu_name = "cpu"
_ONNX_LOADED = False

# CTB → ICTCLAS 映射(与旧版同源)
_CTB2ICT = {
    "NR": "nr", "NN": "n", "NT": "t", "VV": "v", "VA": "a", "VC": "v", "VE": "v",
    "AD": "d", "PN": "r", "CD": "m", "OD": "m", "M": "q", "P": "p", "CC": "c", "CS": "c",
    "DEC": "u", "DEG": "u", "DER": "u", "DEV": "u", "AS": "u", "SP": "u", "ETC": "u", "MSP": "u",
    "PU": "x", "IJ": "e", "ON": "o", "JJ": "a", "LC": "f", "DT": "r", "BA": "p", "LB": "p", "SB": "p", "FW": "nx",
}


def _ensure_onnx():
    """懒加载 ONNX + tokenizer。默认 tokenizers(Rust, 5MB); env P1_TOK_BACKEND=transformers 切完整版。"""
    global _ORT_SESSION, _ORT_DEVICE, _ORT_ERR, _TAG_VOCAB, _ELECTRA_TOK, _gpu_name, _ONNX_LOADED
    if _ONNX_LOADED:
        return _ORT_SESSION is not None
    _ONNX_LOADED = True
    try:
        import onnxruntime as ort
        _TAG_VOCAB.update(json.load(open(_TAG_VOCAB_FILE, encoding='utf-8')))
        _backend = os.environ.get("P1_TOK_BACKEND", "fast")
        if _backend == "transformers":
            from transformers import ElectraTokenizerFast
            _raw = ElectraTokenizerFast.from_pretrained(_TOKENIZER_DIR)
            _ELECTRA_TOK = _TransformersWrap(_raw)
        else:
            from tokenizers import BertWordPieceTokenizer
            _ELECTRA_TOK = _TokenizersWrap(BertWordPieceTokenizer(os.path.join(_TOKENIZER_DIR, "vocab.txt")))
        providers = []
        if 'CUDAExecutionProvider' in ort.get_available_providers():
            providers.append('CUDAExecutionProvider')
        providers.append('CPUExecutionProvider')
        _ORT_SESSION = ort.InferenceSession(_ONNX_MODEL, providers=providers)
        active = _ORT_SESSION.get_providers()
        _ORT_DEVICE = "cuda" if 'CUDAExecutionProvider' in active else "cpu"
        _gpu_name = f"onnx_{_ORT_DEVICE}:{_backend}"
        return True
    except Exception as e:
        _ORT_ERR = str(e)[:200]
        _gpu_name = f"onnx_unavailable: {_ORT_ERR}"
        return False


class _TokenizersWrap:
    """tokenizers 库统一接口"""
    def __init__(self, tok): self._tok = tok
    def encode(self, text):
        e = self._tok.encode(text)
        return _EncResult(e.ids, e.offsets)

class _TransformersWrap:
    """transformers 库统一接口"""
    def __init__(self, tok): self._tok = tok
    def encode(self, text):
        enc = self._tok(text, return_offsets_mapping=True, padding=False, truncation=True, max_length=512)
        return _EncResult(enc["input_ids"], enc["offset_mapping"])

class _EncResult:
    __slots__ = ('ids', 'offsets')
    def __init__(self, ids, offsets): self.ids = ids; self.offsets = offsets


def _onnx_pos_batch(all_toks):
    """ONNX POS: jieba 分好的词 → ELECTRA tokenize → ONNX 推理 → CTB 标签 → ICTCLAS 映射"""
    if not _ensure_onnx():
        return f"onnx_unavailable: {_ORT_ERR or 'not loaded'}"
    sents = [[t["w"] for t in toks] for toks in all_toks if toks]
    if not sents:
        return f"onnx_{_ORT_DEVICE}"

    try:
        for sent_words, toks in zip(sents, [t for t in all_toks if t]):
            text = "".join(sent_words)
            enc = _ELECTRA_TOK.encode(text)
            input_ids = np.array([enc.ids[:512]], dtype=np.int64)
            tokens_offsets = enc.offsets[:512]
            logits = _ORT_SESSION.run(None, {"input_ids": input_ids})[0]
            pred_ids = np.argmax(logits[0], axis=-1)
            char_tags = [None] * len(text)
            for i, (start, end) in enumerate(tokens_offsets):
                if start == end:
                    continue  # [CLS]/[SEP]
                tag_idx = str(pred_ids[i])
                ctb_tag = _TAG_VOCAB.get(tag_idx, "NN")
                for c in range(start, min(end, len(text))):
                    char_tags[c] = ctb_tag

            # 每个 jieba 词: 取首字符的 CTB 标签 → 映射 ICTCLAS
            pos = 0
            for t in toks:
                w = t["w"]
                if pos < len(char_tags) and char_tags[pos]:
                    ctb = char_tags[pos]
                    mapped = _CTB2ICT.get(ctb)
                    if mapped:
                        t["pos"] = mapped
                        t["pos_ctb"] = ctb
                pos += len(w)

        # CoreNatureDictionary 兜底
        for toks in all_toks:
            for t in toks:
                if 'pos_ctb' not in t and t['w'] in _CND:
                    cnd_pos = _CND[t['w']]
                    if t['pos'] and t['pos'][0] != cnd_pos[0]:
                        t['pos'] = cnd_pos
                        t['pos_cnd'] = True

        return f"onnx_ctb9_{_ORT_DEVICE}"
    except Exception as e:
        return f"onnx_fail: {str(e)[:100]}"


# ── Stanza 英文(懒加载: 首次遇到英文文本才 import, 避免 torch 500MB 启动开销) ──
_STANZA = None
_STANZA_ERR = None
_STANZA_LOADED = False


def _ensure_stanza():
    global _STANZA, _STANZA_ERR, _STANZA_LOADED
    if _STANZA_LOADED:
        return _STANZA is not None
    _STANZA_LOADED = True
    try:
        import stanza
        _STANZA = stanza.Pipeline("en", processors="tokenize,pos", verbose=False, tokenize_pretokenized=True)
        return True
    except Exception as e:
        _STANZA_ERR = str(e)[:200]
        return False

# ── 分词逻辑(与旧版同源) ──
_EN_SEG = re.compile(r"[A-Za-z][A-Za-z0-9.+#_\-]*")
_HAS_LAT = re.compile(r"[A-Za-z]")
_HAS_HAN = re.compile(r"[\u4e00-\u9fff]")


def _cut_zh(seg, toks):
    for w, pos in pseg.cut(seg):
        w = w.strip()
        if w:
            toks.append({"w": w, "pos": pos, "oov": w not in FREQ or FREQ.get(w, 0) == 0})


def cut_with_pos(text):
    toks = []
    cursor = 0
    for m in _EN_SEG.finditer(text):
        _cut_zh(text[cursor:m.start()], toks)
        w = m.group()
        toks.append({"w": w, "pos": "eng", "oov": w.lower() not in FREQ, "enSeg": True})
        cursor = m.end()
    _cut_zh(text[cursor:], toks)
    return toks


def apply_stanza(all_toks):
    seqs, refs = [], []
    for toks in all_toks:
        en = [t for t in toks if _HAS_LAT.search(t["w"]) and not _HAS_HAN.search(t["w"])]
        if en:
            seqs.append([t["w"] for t in en])
            refs.append(en)
    if not seqs:
        return "none_needed"
    if not _ensure_stanza():
        return f"unavailable: {_STANZA_ERR}"
    try:
        doc = _STANZA(seqs)
        for sent, en in zip(doc.sentences, refs):
            for word, t in zip(sent.words, en):
                t["upos"] = word.upos
        return "stanza_en"
    except Exception as e:
        return f"failed: {str(e)[:150]}"


# ── HTTP 服务 ──
from fastapi import FastAPI, Request
import uvicorn

app = FastAPI()
_started = time.time()


@app.get("/health")
async def health():
    return {"ok": True, "service": "tokenize", "gpu": _gpu_name, "device": _ORT_DEVICE,
            "onnx": _ORT_SESSION is not None, "uptime": round(time.time() - _started, 1)}


@app.post("/tokenize")
async def tokenize(req: Request):
    body = await req.json()
    texts = body.get("texts", [])
    results = [cut_with_pos(t) for t in texts]
    pos_prov = _onnx_pos_batch(results)
    en_prov = apply_stanza(results)
    return {
        "provider": {
            "segmenter": "jieba_precise",
            "pos": pos_prov,
            "hanlp": f"onnx_{_ORT_DEVICE}" if _ORT_SESSION else f"unavailable: {_ORT_ERR}",
            "stanza": en_prov,
            "userdict": _UD_INFO or ["none"],
            "gpu": _gpu_name,
            "device": _ORT_DEVICE,
        },
        "results": results,
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("P1_TOK_PORT", "13151")))
    args = parser.parse_args()
    print(f"[tokenize-service] ONNX port={args.port} device={_ORT_DEVICE} gpu={_gpu_name}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
