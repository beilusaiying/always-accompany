# tokenize_service.py — 分词+词性 HTTP 常驻服务
#
# ONNX 版: 去掉 torch+HanLP 依赖(2GB→~200MB), 用 onnxruntime 推理 ELECTRA POS 模型
# GPU/CPU 自动切换: 有 CUDA → GPU(4.6ms/call), 无 → CPU(~20ms/call)
# 端口: 13151(env P1_TOK_PORT)

import asyncio
import io, sys, os, json, re, time
from runtime_contract import service_health

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

_RES_ROOT = os.path.abspath(os.environ.get("P1_RESOURCE_DIR") or os.path.join(os.path.dirname(__file__), "..", "resources"))
_DERIVED = os.environ.get("P1V2_DERIVED") or os.path.join(_RES_ROOT, "p1v2_derived")
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
_CND_PATH = os.path.join(_RES_ROOT, 'CoreNatureDictionary.txt')
if os.path.exists(_CND_PATH):
    for _line in open(_CND_PATH, encoding='utf-8', errors='replace'):
        _parts = _line.rstrip('\r\n').split('\t')
        if len(_parts) < 3:
            continue
        _best_pos = None
        _best_freq = -1
        for _i in range(1, len(_parts) - 1, 2):
            try:
                _freq = int(_parts[_i + 1])
            except (TypeError, ValueError):
                continue
            if _parts[_i] and _freq > _best_freq:
                _best_pos = _parts[_i].lower()
                _best_freq = _freq
        if _best_pos:
            _CND[_parts[0]] = _best_pos

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


class _BackendFailure(RuntimeError):
    """A selected POS backend failed and the batch must not be consumed."""

    def __init__(self, code, message, *, status_code=503, details=None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.details = details or {}


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
    # CoreNature 是 provenance 与模型成功后个别无标签 token 的辅助，不能把整个
    # ONNX 批次失败伪装成可消费的 POS 结果。
    for toks in all_toks:
        for t in toks:
            segmenter_pos = t.get("pos")
            core_pos = _CND.get(t["w"])
            t["segmenterPos"] = segmenter_pos
            t["modelPos"] = None
            t["modelTag"] = None
            t["corePos"] = core_pos
            t["posSource"] = "segmenter"

    if not _ensure_onnx():
        raise _BackendFailure(
            "P1_ONNX_LOAD_FAILED",
            f"ONNX POS backend unavailable: {_ORT_ERR or 'not loaded'}",
            details={
                "backend": "onnx_ctb9",
                "phase": "load",
                "device": _ORT_DEVICE,
                "error": _ORT_ERR or "not loaded",
                "model": _ONNX_MODEL,
                "tokenizer": _TOKENIZER_DIR,
            },
        )
    sents = [[t["w"] for t in toks] for toks in all_toks if toks]
    if not sents:
        return {
            "backend": "onnx_ctb9", "available": True,
            "label": f"onnx_ctb9_{_ORT_DEVICE}", "sentences": 0,
            "modelTagged": 0, "modelTaggedHan": 0, "gaps": 0,
        }

    try:
        model_tagged = 0
        han_tokens = 0
        model_tagged_han = 0
        gaps = 0
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
                ctb_tag = _TAG_VOCAB.get(tag_idx)
                for c in range(start, min(end, len(text))):
                    char_tags[c] = ctb_tag

            # 每个 jieba 词: 取首字符的 CTB 标签 → 映射 ICTCLAS
            pos = 0
            for t in toks:
                w = t["w"]
                is_han = bool(re.search(r"[\u4e00-\u9fff]", w))
                if is_han:
                    han_tokens += 1
                ctb = None
                mapped = None
                if pos < len(char_tags) and char_tags[pos]:
                    ctb = char_tags[pos]
                    mapped = _CTB2ICT.get(ctb) if ctb else None
                if mapped:
                    t["pos"] = mapped
                    t["modelPos"] = mapped
                    t["modelTag"] = ctb
                    t["posSource"] = "onnx_ctb9"
                    model_tagged += 1
                    if is_han:
                        model_tagged_han += 1
                else:
                    gaps += 1
                    if t["corePos"]:
                        t["pos"] = t["corePos"]
                        t["posSource"] = "coreNature_model_gap"
                pos += len(w)

        if han_tokens and not model_tagged_han:
            raise _BackendFailure(
                "P1_ONNX_INFERENCE_CONTRACT_FAILED",
                "ONNX POS inference returned no usable labels for Chinese tokens",
                status_code=500,
                details={
                    "backend": "onnx_ctb9",
                    "phase": "inference_contract",
                    "device": _ORT_DEVICE,
                    "sentences": len(sents),
                    "hanTokens": han_tokens,
                    "modelTaggedHan": model_tagged_han,
                    "gaps": gaps,
                },
            )

        return {
            "backend": "onnx_ctb9",
            "available": True,
            "label": f"onnx_ctb9_{_ORT_DEVICE}",
            "sentences": len(sents),
            "modelTagged": model_tagged,
            "modelTaggedHan": model_tagged_han,
            "gaps": gaps,
        }
    except _BackendFailure:
        raise
    except Exception as e:
        message = str(e)[:300]
        raise _BackendFailure(
            "P1_ONNX_INFERENCE_FAILED",
            f"ONNX POS inference failed: {message}",
            status_code=500,
            details={
                "backend": "onnx_ctb9",
                "phase": "inference",
                "device": _ORT_DEVICE,
                "error": message,
                "sentences": len(sents),
            },
        ) from e


# ── Stanza 英文（显式可选重后端）──
# 默认英文 POS 由 vector_service 的 WordNet 词法后端统一承担。Stanza 会连带加载
# PyTorch，在 2GB 运行预算下不能因为单个英文标识符自动启用；只有调用方明确传
# englishPosBackend=stanza 时才加载。
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
            toks.append({"w": w, "pos": pos, "segmenterPos": pos,
                         "oov": w not in FREQ or FREQ.get(w, 0) == 0})


def cut_with_pos(text):
    toks = []
    cursor = 0
    for m in _EN_SEG.finditer(text):
        _cut_zh(text[cursor:m.start()], toks)
        w = m.group()
        toks.append({"w": w, "pos": "eng", "segmenterPos": "eng",
                     "oov": w.lower() not in FREQ, "enSeg": True})
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
        raise _BackendFailure(
            "P1_STANZA_LOAD_FAILED",
            f"Stanza POS backend unavailable: {_STANZA_ERR or 'not loaded'}",
            details={
                "backend": "stanza",
                "phase": "load",
                "error": _STANZA_ERR or "not loaded",
                "sentences": len(seqs),
            },
        )
    try:
        doc = _STANZA(seqs)
        if len(doc.sentences) != len(refs):
            raise RuntimeError(f"sentence count mismatch: expected {len(refs)}, got {len(doc.sentences)}")
        for sent, en in zip(doc.sentences, refs):
            if len(sent.words) != len(en):
                raise RuntimeError(f"token count mismatch: expected {len(en)}, got {len(sent.words)}")
            for word, t in zip(sent.words, en):
                if not word.upos:
                    raise RuntimeError(f"missing UPOS label for token: {t['w']}")
                t["upos"] = word.upos
        return "stanza_en"
    except Exception as e:
        message = str(e)[:300]
        raise _BackendFailure(
            "P1_STANZA_INFERENCE_FAILED",
            f"Stanza POS inference failed: {message}",
            status_code=500,
            details={
                "backend": "stanza",
                "phase": "inference",
                "error": message,
                "sentences": len(seqs),
            },
        ) from e


# ── HTTP 服务 ──
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI()
_started = time.time()
_uvicorn_server = None


async def _stop_after_response():
    await asyncio.sleep(0.1)
    if _uvicorn_server is not None:
        _uvicorn_server.should_exit = True


@app.post("/lifecycle/stop")
async def lifecycle_stop():
    asyncio.create_task(_stop_after_response())
    return {"success": True, "stopping": True}


@app.get("/health")
async def health():
    return {**service_health("tokenize"), "gpu": _gpu_name, "device": _ORT_DEVICE,
            "onnx": _ORT_SESSION is not None, "uptime": round(time.time() - _started, 1)}


@app.post("/warmup")
async def warmup():
    """仅加载分词服务的召回资源；不构造文本，也不执行分词或 POS 推理。"""
    started = time.perf_counter()
    ready = _ensure_onnx()
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    active_providers = _ORT_SESSION.get_providers() if _ORT_SESSION is not None else []
    resources = {
        "segmenter": {
            "ready": True,
            "provider": "jieba_precise",
            "dictionaryEntries": len(FREQ),
            "userdict": _UD_INFO or ["none"],
        },
        "posModel": {
            "ready": ready,
            "provider": "onnx_ctb9",
            "ms": elapsed_ms,
            "device": _ORT_DEVICE,
            "runtime": _gpu_name,
            "activeProviders": active_providers,
            "model": _ONNX_MODEL,
            "modelExists": os.path.isfile(_ONNX_MODEL),
            "tokenizer": _TOKENIZER_DIR,
            "tokenizerExists": os.path.isdir(_TOKENIZER_DIR),
            "tagVocab": _TAG_VOCAB_FILE,
            "tagVocabExists": os.path.isfile(_TAG_VOCAB_FILE),
            "tagCount": len(_TAG_VOCAB),
            "error": _ORT_ERR,
        },
        "coreNature": {
            "ready": bool(_CND),
            "entries": len(_CND),
            "path": _CND_PATH,
            "role": "provenance_and_model_gap_assist_only",
        },
    }
    if not ready:
        error = _ORT_ERR or "ONNX POS resources did not load"
        return JSONResponse(status_code=503, content={
            "success": False,
            "action": "warmup",
            "readyForRecall": False,
            "ready": False,
            "ms": elapsed_ms,
            "code": "P1_TOKENIZE_WARMUP_FAILED",
            "error": error,
            "details": {"phase": "load", "resources": resources},
            "resources": resources,
        })
    return {
        "success": True,
        "action": "warmup",
        "readyForRecall": True,
        "ready": True,
        "ms": elapsed_ms,
        "provider": {
            "segmenter": "jieba_precise",
            "pos": f"onnx_ctb9_{_ORT_DEVICE}",
            "device": _ORT_DEVICE,
            "activeProviders": active_providers,
        },
        "resources": resources,
    }


@app.post("/tokenize")
async def tokenize(req: Request):
    try:
        body = await req.json()
    except Exception as e:
        return JSONResponse(status_code=400, content={
            "success": False,
            "code": "P1_TOKENIZE_BAD_REQUEST",
            "error": f"invalid JSON body: {str(e)[:200]}",
            "details": {"phase": "request"},
        })

    texts = body.get("texts", []) if isinstance(body, dict) else None
    en_backend = str(body.get("englishPosBackend") or "none").lower() if isinstance(body, dict) else "none"
    if not isinstance(texts, list) or any(not isinstance(text, str) for text in texts):
        return JSONResponse(status_code=422, content={
            "success": False,
            "code": "P1_TOKENIZE_BAD_REQUEST",
            "error": "texts must be an array of strings",
            "details": {"phase": "request", "receivedType": type(texts).__name__},
        })
    if en_backend not in ("none", "stanza"):
        return JSONResponse(status_code=422, content={
            "success": False,
            "code": "P1_TOKENIZE_BAD_REQUEST",
            "error": f"unsupported englishPosBackend: {en_backend}",
            "details": {"phase": "request", "allowed": ["none", "stanza"]},
        })

    pos_status = None
    en_prov = "disabled"
    try:
        results = [cut_with_pos(text) for text in texts]
        pos_status = _onnx_pos_batch(results)
        en_prov = apply_stanza(results) if en_backend == "stanza" else "disabled"
    except _BackendFailure as e:
        provider = {
            "segmenter": "jieba_precise",
            "pos": pos_status["label"] if pos_status else "unavailable",
            "posStatus": pos_status,
            "hanlp": f"onnx_{_ORT_DEVICE}" if _ORT_SESSION else f"unavailable: {_ORT_ERR}",
            "stanza": en_prov,
            "englishPosBackend": "stanza" if en_backend == "stanza" else "external",
            "coreNature": {
                "available": bool(_CND),
                "entries": len(_CND),
                "path": _CND_PATH,
                "role": "provenance_and_model_gap_assist_only",
            },
            "userdict": _UD_INFO or ["none"],
            "gpu": _gpu_name,
            "device": _ORT_DEVICE,
        }
        return JSONResponse(status_code=e.status_code, content={
            "success": False,
            "code": e.code,
            "error": str(e),
            "details": e.details,
            "provider": provider,
        })
    except Exception as e:
        message = str(e)[:300]
        return JSONResponse(status_code=500, content={
            "success": False,
            "code": "P1_TOKENIZE_INTERNAL_ERROR",
            "error": f"tokenize service failed: {message}",
            "details": {"phase": "tokenize", "error": message},
        })

    return {
        "success": True,
        "provider": {
            "segmenter": "jieba_precise",
            "pos": pos_status["label"],
            "posStatus": pos_status,
            "hanlp": f"onnx_{_ORT_DEVICE}",
            "stanza": en_prov,
            "englishPosBackend": "stanza" if en_backend == "stanza" else "external",
            "coreNature": {
                "available": bool(_CND),
                "entries": len(_CND),
                "path": _CND_PATH,
                "role": "provenance_and_model_gap_assist_only",
            },
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
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning")
    _uvicorn_server = uvicorn.Server(config)
    _uvicorn_server.run()
