# vector_service.py — NB300 向量 + WordNet HTTP 常驻服务
# 集群节点2: 向量相似度计算(NB300 cosine + WordNet path_similarity)
# 懒加载: 首次请求才加载向量/WordNet数据,不用不占内存
# 端口: 13152(env P1_VEC_PORT)

import os, sys, json, time
import numpy as np

# 懒加载容器
_nb_words = None
_nb_mat = None
_nb_index = None
_wn = None
_wn_err = None

DERIVED = os.environ.get("P1V2_DERIVED") or (
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "p1_res", "p1v2_derived")
    if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "p1_res", "p1v2_derived"))
    else r"D:\shajiuguan\自驱动召回\resources_derived")


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
        wordnet.synsets("dog")
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


@app.get("/health")
async def health():
    return {
        "ok": True, "service": "vector",
        "nb_loaded": _nb_index is not None,
        "nb_words": len(_nb_index) if _nb_index else 0,
        "wn_loaded": _wn is not None,
        "uptime": round(time.time() - _started, 1),
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
    """词对余弦(eval 用): pairs=[[w1,w2],...] → cosines=[cos,...]"""
    if not _ensure_nb():
        return {"cosines": [], "oov": [], "covered": 0}
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
    return {"cosines": cosines, "oov": list(set(oov)), "covered": sum(1 for c in cosines if c is not None)}


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
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
