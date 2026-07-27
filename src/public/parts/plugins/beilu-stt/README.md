# beilu-stt — 本地语音转录插件

基于 [MOSS-Transcribe-Diarize 0.9B](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize) 的本地语音转文字插件：50+ 语言、说话人分离、时间戳。

## 结构

```
beilu-stt/
├── main.mjs          # Node 入口：服务生命周期 / 录音与转录代理 / 环境检测 / 模型下载器
├── stt_service.py    # Python FastAPI 微服务：模型推理 + 系统麦直采录音（sounddevice）
├── vendor/           # MOSS-Transcribe-Diarize 推理代码（vendored，Apache-2.0，见 vendor/LICENSE）
└── (模型权重)         # 仓库根 moxin/MOSS-Transcribe-Diarize/ ——约1.8GB,不进 git
```

## 模型下载

模型权重过大无法随仓库分发。在应用内「额外插件 → 语音转录」的使用引导卡中一键下载：
- HuggingFace 直链（`OpenMOSS-Team/MOSS-Transcribe-Diarize`）
- hf-mirror 镜像（适配各地区网络）

下载目标为仓库根 `moxin/` 目录（已在 .gitignore 中）。也可手动 `hf download OpenMOSS-Team/MOSS-Transcribe-Diarize` 后在设置中指定路径。

## 依赖

Python 3.10+；首次启动服务自动安装：torch、transformers≥5、fastapi、uvicorn、av、librosa、soundfile、sounddevice。

## 致谢

- [MOSS-Transcribe-Diarize](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize) — OpenMOSS Team，Apache License 2.0。vendor/ 目录内含其推理代码的最小子集（moss_transcribe_diarize 包，不含 app/tests）。
