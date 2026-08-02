# beilu-cli server（CLI 本地执行器本体）

beilu IDE 工具的 CLI 执行后端（替代 YonBan VSCode 扩展的常驻工具进程）。
由上级插件 `beilu-cli/main.mjs` 在本体启动时自动 spawn，无需手动运行。

## 依赖安装

公共仓库发布物不含 `node_modules`。首次克隆后在本目录执行一次：

```bash
npm install
```

依赖清单见 `package.json`（ws / diff / jszip / xlsx / mammoth / pdf-parse / word-extractor / html-validate，全部纯 JS 离线库，满足 beilu 离线约束）。

## 手动运行（调试用）

```bash
node server.mjs --port 13931 --settings <beilu-files-settings.json 路径>
```

工作区根由 `--settings` 指向的 beilu-files-settings.json 单源决定（文件面板「打开文件夹」即改），fs.watch 热跟随。
运行态（token / 端口注册表 / checkpoints）写在 `~/.beilu/` 与工作区 `.beilu/`，不写本目录。

## 测试脚本

`test_*.mjs` 为开发自测。其中 `test_ai_loop.mjs` / `test_all_tools.mjs` 需要真实 AI 源，
经环境变量 `BEILU_TEST_API_URL` / `BEILU_TEST_API_KEY` 注入，不硬编码进仓库。
