# llmtok_service.py — Gigatoken LLM 分词器 HTTP 常驻服务
# 集群节点3: LLM token 切分(Qwen3-8B tokenizer)
# 懒加载: 首次请求才加载 tokenizer
# 端口: 13153(env P1_LLMTOK_PORT)

import os, sys, json, time

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
import uvicorn

app = FastAPI()
_started = time.time()


@app.get("/health")
async def health():
    return {"ok": True, "service": "llmtok", "model": MODEL,
            "loaded": _tokenizer is not None, "uptime": round(time.time() - _started, 1)}


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
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
