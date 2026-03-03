"""
beilu-graphrag Python Worker
通过 stdin/stdout JSON-line 协议与 Deno 后端通信
使用 LightRAG 进行知识图谱构建和查询
"""

import sys
import os
import json
import glob
import traceback

# ============================================================
# 环境变量配置
# ============================================================

WORKING_DIR = os.environ.get("GRAPHRAG_WORKING_DIR", "./graphrag_data")
LLM_API_URL = os.environ.get("GRAPHRAG_LLM_API_URL", "")
LLM_API_KEY = os.environ.get("GRAPHRAG_LLM_API_KEY", "")
LLM_MODEL = os.environ.get("GRAPHRAG_LLM_MODEL", "gpt-4o-mini")
EMBEDDING_API_URL = os.environ.get("GRAPHRAG_EMBEDDING_API_URL", "")
EMBEDDING_API_KEY = os.environ.get("GRAPHRAG_EMBEDDING_API_KEY", "")
EMBEDDING_MODEL = os.environ.get("GRAPHRAG_EMBEDDING_MODEL", "text-embedding-ada-002")

# ============================================================
# LightRAG 初始化
# ============================================================

rag = None


def init_rag():
    """初始化 LightRAG 实例"""
    global rag

    try:
        from lightrag import LightRAG, QueryParam
        from lightrag.llm import openai_complete_if_cache, openai_embedding

        os.makedirs(WORKING_DIR, exist_ok=True)

        # 配置 LLM 和 Embedding
        async def llm_func(prompt, **kwargs):
            return await openai_complete_if_cache(
                LLM_MODEL,
                prompt,
                api_key=LLM_API_KEY,
                base_url=LLM_API_URL,
                **kwargs,
            )

        async def embedding_func(texts):
            return await openai_embedding(
                texts,
                model=EMBEDDING_MODEL,
                api_key=EMBEDDING_API_KEY,
                base_url=EMBEDDING_API_URL or LLM_API_URL,
            )

        rag = LightRAG(
            working_dir=WORKING_DIR,
            llm_model_func=llm_func,
            embedding_func=embedding_func,
        )

        log("LightRAG 初始化成功，工作目录: " + WORKING_DIR)
        return True

    except ImportError:
        log("错误: lightrag 未安装，请执行 pip install lightrag-hku")
        return False
    except Exception as e:
        log(f"LightRAG 初始化失败: {e}")
        traceback.print_exc(file=sys.stderr)
        return False


def log(msg):
    """输出日志到 stderr（不干扰 stdout JSON 协议）"""
    print(f"[graphrag] {msg}", file=sys.stderr, flush=True)


# ============================================================
# 请求处理
# ============================================================

import asyncio


async def handle_insert(params):
    """插入文档（增量更新）"""
    if not rag:
        return {"error": "LightRAG 未初始化"}

    content = params.get("content", "")
    source = params.get("source", "unknown")

    if not content:
        return {"error": "content 为空"}

    try:
        await rag.ainsert(content)
        log(f"文档已插入: {source} ({len(content)} 字符)")
        return {"inserted": True, "source": source, "length": len(content)}
    except Exception as e:
        log(f"插入失败: {e}")
        return {"error": str(e)}


async def handle_query(params):
    """查询知识图谱"""
    if not rag:
        return {"error": "LightRAG 未初始化"}

    question = params.get("question", "")
    mode = params.get("mode", "hybrid")

    if not question:
        return {"error": "question 为空"}

    try:
        from lightrag import QueryParam

        result = await rag.aquery(
            question,
            param=QueryParam(mode=mode),
        )

        log(f"查询完成: '{question[:50]}...' (mode={mode})")
        return {"answer": result, "mode": mode, "question": question}
    except Exception as e:
        log(f"查询失败: {e}")
        return {"error": str(e)}


async def handle_stats(params):
    """获取图谱统计信息"""
    stats = {
        "working_dir": WORKING_DIR,
        "initialized": rag is not None,
    }

    try:
        # 统计工作目录中的文件
        if os.path.exists(WORKING_DIR):
            files = []
            total_size = 0
            for root, dirs, filenames in os.walk(WORKING_DIR):
                for f in filenames:
                    fp = os.path.join(root, f)
                    size = os.path.getsize(fp)
                    total_size += size
                    files.append(f)

            stats["file_count"] = len(files)
            stats["total_size_kb"] = round(total_size / 1024, 2)
            stats["files"] = files[:20]  # 只返回前20个文件名
    except Exception as e:
        stats["error"] = str(e)

    return stats


async def handle_index_memory(params):
    """批量索引记忆目录"""
    if not rag:
        return {"error": "LightRAG 未初始化"}

    mem_dir = params.get("memDir", "")
    if not mem_dir or not os.path.exists(mem_dir):
        return {"error": f"记忆目录不存在: {mem_dir}"}

    indexed = 0
    errors = 0
    total_chars = 0

    try:
        # 遍历记忆目录中的所有 JSON 文件
        for root, dirs, files in os.walk(mem_dir):
            # 跳过索引目录
            dirs[:] = [d for d in dirs if not d.startswith("_")]

            for filename in files:
                if not filename.endswith(".json"):
                    continue

                filepath = os.path.join(root, filename)
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        content = f.read()

                    if len(content) > 100 * 1024:  # 跳过大文件
                        continue

                    # 添加文件路径作为上下文
                    rel_path = os.path.relpath(filepath, mem_dir)
                    annotated = f"[来源: {rel_path}]\n{content}"

                    await rag.ainsert(annotated)
                    indexed += 1
                    total_chars += len(content)
                    log(f"索引: {rel_path} ({len(content)} 字符)")

                except Exception as e:
                    errors += 1
                    log(f"索引失败 {filename}: {e}")

        log(f"批量索引完成: {indexed} 文件, {errors} 错误, {total_chars} 字符")
        return {
            "indexed": indexed,
            "errors": errors,
            "total_chars": total_chars,
        }

    except Exception as e:
        return {"error": str(e)}


# 方法路由
HANDLERS = {
    "insert": handle_insert,
    "query": handle_query,
    "stats": handle_stats,
    "index_memory": handle_index_memory,
}


async def process_request(request):
    """处理单个请求"""
    req_id = request.get("id", 0)
    method = request.get("method", "")
    params = request.get("params", {})

    handler = HANDLERS.get(method)
    if not handler:
        return {"id": req_id, "error": f"未知方法: {method}"}

    try:
        result = await handler(params)
        if "error" in result:
            return {"id": req_id, "error": result["error"]}
        return {"id": req_id, "result": result}
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        return {"id": req_id, "error": str(e)}


# ============================================================
# 主循环：stdin → 处理 → stdout
# ============================================================


async def main():
    """主事件循环"""
    log("Worker 启动中...")

    # 初始化 LightRAG
    if not init_rag():
        log("LightRAG 初始化失败，Worker 将在无 RAG 的情况下运行")

    log("Worker 就绪，等待请求...")

    loop = asyncio.get_event_loop()

    # 从 stdin 读取 JSON-line 请求
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            log(f"无效 JSON: {line[:100]}")
            continue

        # 处理请求
        response = await process_request(request)

        # 输出 JSON-line 响应到 stdout
        response_str = json.dumps(response, ensure_ascii=False)
        print(response_str, flush=True)


if __name__ == "__main__":
    asyncio.run(main())