# P1 召回服务（独立 / 可插拔 / 可独立运行）

自驱动记忆召回管线，独立 Python 进程。**不依赖本体**：本体不在跑、甚至本机没有本体，都能完整工作。

## 启动

**默认零操作**：本体启动时薄壳自动探测并拉起本服务（已在跑则直接复用；服务中途挂掉请求会触发自愈重拉，60s 冷却）。`P1_AUTOSTART=off` 可关闭自动启动。

手动/独立启动（拉线测试入口，或自动启动失败时）：

```
cd src/public/parts/shells/p1/service
python p1_server.py            # 默认 127.0.0.1:13150
python p1_server.py --port N   # 覆盖端口
```

- 健康检查：`GET /health`（含 pipelineLoaded / pipelineError 诚实状态）
- 召回：`POST /runP1` `{inputText, chatHistory, mode, username, charName, dataRecallOverride?}`
- 词库管理：`POST /listVocabs /atSearch /atBrowse /getUserVocab /saveUserVocab /toggleUserVocab /deleteUserVocab`
- 配置：`POST /getConfig /setConfig /updateConfig`（自持 `service/data/config.json`，路径类配置见其中 resourceDir/dataRoot/vocabDir）
- 聚合/统计：`POST /getData`（config 平铺键+meta 控件元数据+stats，供前端设置面板单次拉取）/ `POST /getStats`
- 缓存：`POST /clearCaches /unloadCaches`（tier: light|deep）
- P9 提示词：`POST /getP9Prompts /saveP9Prompts /resetP9Prompts`（默认件 `service/p9_prompts_default.json`，用户副本 `service/data/p9_prompts.json`）

## 与本体的关系（插拔语义）

- 本体 `shells/p1/main.mjs` 是薄传导层：把 `/api/parts/shells:p1/service/<action>` 代理到本服务。
- 服务不在 → 薄壳返回 503 明确错误 → 本体召回链降级（AI P1），**任何链路不炸**。
- 拔掉：停进程/删目录即可。插上：启动进程即可，本体零改动。

## 依赖

Python ≥3.12，jieba / fastapi / uvicorn / numpy（见 requirements.txt）。

## 测试

`tests/` 下拉线测试与 JS↔Python 等价对照（复用 p1shiyanshi 语料库），独立运行不需要本体。
