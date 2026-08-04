# llmtok_service.py — Gigatoken LLM 分词器 HTTP 常驻服务
# 集群节点3: LLM token 切分(Qwen3-8B tokenizer)
# 懒加载: 首次请求才加载 tokenizer
# 端口: 13153(env P1_LLMTOK_PORT)

import asyncio
import os, sys, json, time
from runtime_contract import service_health

_tokenizer = None
_tok_err = None
MODEL = "Qwen/Qwen3-8B"


def _ensure_tok():
    global _tokenizer, _tok_err
    if _tokenizer is not None:
        return True
    if _tok_err:
        return False
    try:
        import gigatoken as gt
        _tokenizer = gt.Tokenizer(MODEL)
        return True
    except Exception as e:
        _tok_err = str(e)[:200]
        return False


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
    return {**service_health("llmtok"), "model": MODEL,
            "loaded": _tokenizer is not None, "uptime": round(time.time() - _started, 1)}


@app.post("/warmup")
async def warmup():
    """仅加载 Gigatoken tokenizer；不构造文本，也不执行 encode/decode。"""
    started = time.perf_counter()
    ready = _ensure_tok()
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    resources = {
        "tokenizer": {
            "ready": ready,
            "loaded": _tokenizer is not None,
            "provider": f"gigatoken:{MODEL}",
            "model": MODEL,
            "ms": elapsed_ms,
            "error": _tok_err,
        },
    }
    if not ready:
        error = _tok_err or "Gigatoken tokenizer did not load"
        return JSONResponse(status_code=503, content={
            "success": False,
            "action": "warmup",
            "readyForRecall": False,
            "ready": False,
            "ms": elapsed_ms,
            "code": "P1_LLMTOK_WARMUP_FAILED",
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
        "provider": f"gigatoken:{MODEL}",
        "resources": resources,
    }


@app.post("/tokenize")
async def tokenize(req: Request):
    if not _ensure_tok():
        return {"provider": f"unavailable: {_tok_err}", "results": []}
    body = await req.json()
    results = []
    for t in body.get("texts", []):
        ids = _tokenizer.encode(t)
        toks = []
        buf = b""
        for i in ids:
            piece = _tokenizer.decode([i])
            buf += piece.encode("utf-8") if isinstance(piece, str) else bytes(piece)
            try:
                s = buf.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if s.strip():
                toks.append(s)
            buf = b""
        results.append(toks)
    return {"provider": f"gigatoken:{MODEL}", "results": results}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("P1_LLMTOK_PORT", "13153")))
    args = parser.parse_args()
    print(f"[llmtok-service] port={args.port} model={MODEL} (懒加载)", flush=True)
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning")
    _uvicorn_server = uvicorn.Server(config)
    _uvicorn_server.run()
