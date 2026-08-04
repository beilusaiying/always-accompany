# vector_service.py — NB300 向量 + WordNet HTTP 常驻服务
# 集群节点2: 向量相似度计算(NB300 cosine + WordNet path_similarity)
# 懒加载: 首次请求才加载向量/WordNet数据,不用不占内存
# 端口: 13152(env P1_VEC_PORT)

import asyncio
import os, sys, json, time
import numpy as np
from runtime_contract import service_health

# 懒加载容器
_nb_words = None
_nb_mat = None
_nb_index = None
_wn = None
_wn_err = None

DERIVED = os.environ.get("P1V2_DERIVED") or os.path.abspath(os.path.join(
    os.environ.get("P1_RESOURCE_DIR") or os.path.join(os.path.dirname(__file__), "..", "resources"),
    "p1v2_derived"))


def _ensure_nb():
    global _nb_words, _nb_mat, _nb_index
    if _nb_index is not None:
        return True
    w_path = os.path.join(DERIVED, "nb_words.txt")
    v_path = os.path.join(DERIVED, "nb_vec_int8.npy")
    if not (os.path.exists(w_path) and os.path.exists(v_path)):
        return False
    with open(w_path, encoding="utf-8") as f:
        _nb_words = f.read().split("\n")
    _nb_index = {w: i for i, w in enumerate(_nb_words)}
    _nb_mat = np.load(v_path, mmap_mode="r")  # mmap: 不全载进内存
    return True


def _get_vec(word):
    w = word.strip().lower().replace(" ", "_")
    for key in (f"zh/{w}", f"en/{w}"):
        i = _nb_index.get(key)
        if i is not None:
            v = _nb_mat[i].astype("float32") / 127.0
            n = np.linalg.norm(v)
            return v / n if n > 0 else None
    return None


def _ensure_wn():
    global _wn, _wn_err
    if _wn is not None:
        return True
    if _wn_err:
        return False
    try:
        from nltk.corpus import wordnet
        wordnet.ensure_loaded()
        _wn = wordnet
        return True
    except Exception as e:
        _wn_err = str(e)[:200]
        return False


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
    return {
        **service_health("vector"),
        "nb_loaded": _nb_index is not None,
        "nb_words": len(_nb_index) if _nb_index else 0,
        "wn_loaded": _wn is not None,
        "uptime": round(time.time() - _started, 1),
    }


@app.post("/warmup")
async def warmup():
    """仅加载 Numberbatch 与 WordNet；不构造词或候选，也不执行相似度/POS 查询。"""
    started = time.perf_counter()

    nb_started = time.perf_counter()
    nb_exception = None
    try:
        nb_ready = _ensure_nb()
    except Exception as exc:
        nb_ready = False
        nb_exception = str(exc)[:300]
    nb_ms = round((time.perf_counter() - nb_started) * 1000, 3)

    wn_started = time.perf_counter()
    wn_exception = None
    try:
        wn_ready = _ensure_wn()
    except Exception as exc:
        wn_ready = False
        wn_exception = str(exc)[:300]
    wn_ms = round((time.perf_counter() - wn_started) * 1000, 3)

    words_path = os.path.join(DERIVED, "nb_words.txt")
    vectors_path = os.path.join(DERIVED, "nb_vec_int8.npy")
    resources = {
        "numberbatch": {
            "ready": nb_ready,
            "provider": "numberbatch_int8_mmap",
            "wordsPath": words_path,
            "wordsExists": os.path.isfile(words_path),
            "vectorsPath": vectors_path,
            "vectorsExist": os.path.isfile(vectors_path),
            "wordCount": len(_nb_index) if _nb_index is not None else 0,
            "shape": list(_nb_mat.shape) if _nb_mat is not None else None,
            "dtype": str(_nb_mat.dtype) if _nb_mat is not None else None,
            "ms": nb_ms,
            "error": nb_exception or (None if nb_ready else "Numberbatch data missing"),
        },
        "wordnet": {
            "ready": wn_ready,
            "provider": "nltk.corpus.wordnet",
            "loaded": _wn is not None,
            "ms": wn_ms,
            "error": wn_exception or _wn_err,
        },
    }
    ready = nb_ready and wn_ready
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    if not ready:
        failed = [name for name, status in resources.items() if not status["ready"]]
        error = "; ".join(
            f"{name}: {resources[name]['error'] or 'resource did not load'}" for name in failed
        )
        return JSONResponse(status_code=503, content={
            "success": False,
            "action": "warmup",
            "readyForRecall": False,
            "ready": False,
            "ms": elapsed_ms,
            "code": "P1_VECTOR_WARMUP_FAILED",
            "error": error,
            "details": {"phase": "load", "failedResources": failed, "resources": resources},
            "resources": resources,
        })
    return {
        "success": True,
        "action": "warmup",
        "readyForRecall": True,
        "ready": True,
        "ms": elapsed_ms,
        "provider": {
            "numberbatch": "numberbatch_int8_mmap",
            "wordnet": "nltk.corpus.wordnet",
        },
        "resources": resources,
    }


@app.post("/nb_cosine")
async def nb_cosine(req: Request):
    """NB300 余弦: anchors × candidates → 锚质心 vs 各候选的 cosine"""
    if not _ensure_nb():
        return JSONResponse({"available": False, "cos": {}, "oov": [], "why": "nb data missing"})
    body = await req.json()
    anchors, candidates = body.get("anchors", []), body.get("candidates", [])
    avecs = [v for v in (_get_vec(a) for a in anchors) if v is not None]
    out = {"available": True, "cos": {}, "oov": [], "anchorHit": len(avecs), "anchorTotal": len(anchors)}
    if not avecs:
        return out
    centroid = np.mean(avecs, axis=0)
    n = np.linalg.norm(centroid)
    centroid = centroid / n if n > 0 else centroid
    for c in candidates:
        v = _get_vec(c)
        if v is None:
            out["oov"].append(c)
        else:
            out["cos"][c] = round(float(np.dot(centroid, v)), 4)
    return out


@app.post("/nb_pairs")
async def nb_pairs(req: Request):
    """词对余弦（Node4 近义去重 + eval）: pairs=[[w1,w2],...] → cosines=[cos,...]。"""
    if not _ensure_nb():
        return {"available": False, "cosines": [], "oov": [], "covered": 0, "why": "nb data missing"}
    body = await req.json()
    pairs = body.get("pairs", [])
    lang = body.get("lang", "auto")
    cosines, oov = [], []
    for w1, w2 in pairs:
        v1, v2 = _get_vec(w1), _get_vec(w2)
        if v1 is None or v2 is None:
            cosines.append(None)
            if v1 is None: oov.append(w1)
            if v2 is None: oov.append(w2)
        else:
            cosines.append(round(float(np.dot(v1, v2)), 4))
    return {"available": True, "cosines": cosines, "oov": list(set(oov)), "covered": sum(1 for c in cosines if c is not None)}


@app.post("/wn_sim")
async def wn_sim(req: Request):
    """WordNet path_similarity: anchors × candidates → max sim"""
    if not _ensure_wn():
        return {"available": False, "sim": {}, "why": _wn_err or "not loaded"}
    body = await req.json()
    anchors = [a for a in body.get("anchors", []) if a.isascii()]
    candidates = [c for c in body.get("candidates", []) if c.isascii()]
    anchor_syns = []
    for a in anchors:
        ss = _wn.synsets(a.replace(" ", "_"))
        if ss:
            anchor_syns.append(ss[0])
    out = {"available": True, "sim": {}, "anchorHit": len(anchor_syns)}
    for c in candidates:
        ss = _wn.synsets(c.replace(" ", "_"))
        if not ss:
            continue
        best = 0.0
        for asyn in anchor_syns:
            v = ss[0].path_similarity(asyn)
            if v is not None and v > best:
                best = v
        if best > 0:
            out["sim"][c] = round(best, 3)
    return out


@app.post("/wn_pos")
async def wn_pos(req: Request):
    """轻量英文词法 POS：复用本服务唯一 WordNet 实例，不在分词进程重复加载 PyTorch/Stanza。

    WordNet 的首义项按语料频率排序，可稳定映射 NOUN/VERB/ADJ/ADV；未收录词按设计中的
    OOV 规则标 X 并保留。它是词法 POS，不冒充上下文句法标注，provider 会如实上报。
    """
    if not _ensure_wn():
        return {"available": False, "results": {}, "provider": "wordnet_first_synset",
                "why": _wn_err or "not loaded"}
    body = await req.json()
    words = body.get("words", [])
    pos_map = {"n": "NOUN", "v": "VERB", "a": "ADJ", "s": "ADJ", "r": "ADV"}
    results = {}
    for raw in words:
        word = str(raw or "").strip()
        if not word or not word.isascii():
            continue
        # 代码标识符/缩写不是 WordNet 自然语言词，按 OOV 专名通道保留。
        if not word.isalpha() or (any(ch.isupper() for ch in word[1:])):
            results[word] = "X"
            continue
        synsets = _wn.synsets(word.lower().replace(" ", "_"))
        results[word] = pos_map.get(synsets[0].pos(), "X") if synsets else "X"
    return {"available": True, "results": results, "provider": "wordnet_first_synset",
            "oovCount": sum(1 for pos in results.values() if pos == "X")}


@app.post("/wn_supersense")
async def wn_supersense(req: Request):
    """WordNet supersense(lexname): word → [lexname...] for domain disambiguation.
    code/work mode: if all synsets are noun.animal but none are noun.artifact/noun.communication → wrong domain.
    """
    if not _ensure_wn():
        return {"available": False, "results": {}, "why": _wn_err or "not loaded"}
    body = await req.json()
    words = body.get("words", [])
    results = {}
    for w in words:
        if not w or not w.isascii():
            continue
        synsets = _wn.synsets(w.replace(" ", "_"), pos=_wn.NOUN)
        if synsets:
            results[w] = list(set(s.lexname() for s in synsets))
    return {"available": True, "results": results}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("P1_VEC_PORT", "13152")))
    args = parser.parse_args()
    print(f"[vector-service] port={args.port} (懒加载: NB/WordNet 首次请求才加载)", flush=True)
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning")
    _uvicorn_server = uvicorn.Server(config)
    _uvicorn_server.run()
