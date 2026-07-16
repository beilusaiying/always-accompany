# 対応 AI プロバイダー

always-accompany はチャンネル（Provider）を通じて異なる AI プロバイダーを識別します。[AI サービスソース](beilu:settings/api)パネルで正しいチャンネルを選択すると、メッセージフォーマットが正しく適合され、API 呼び出しの失敗を防げます。

### Anthropic Claude

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `claude` |
| デフォルトエンドポイント | `https://api.anthropic.com/v1/chat/completions` |
| 注意事項 | temperature と top_p は同時に設定できません（同時送信すると 400 が返ります）；max_tokens は必須 |
| 対応ジェネレーター | proxy（OpenAI 互換エンドポイント）/ claude-api（ネイティブ Messages API） |

Claude 公式 API を使用する場合、2つの接続方式があります：
- **proxy ジェネレーター + claude チャンネル**：OpenAI 互換エンドポイントを使用。設定がシンプルです
- **claude-api ジェネレーター**：Anthropic ネイティブ `/v1/messages` プロトコルを使用。より多くの Claude 機能に対応します

中継やリバースプロキシを使用する場合は、URL アドレスを直接置き換えるだけです。

### OpenRouter -> Claude

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `openrouter-claude` |
| デフォルトエンドポイント | `https://openrouter.ai/api/v1/chat/completions` |
| 注意事項 | Claude 系の制約と同様（temperature/top_p は排他） |

OpenRouter プラットフォーム経由で Claude モデルを呼び出す場合にこのチャンネルを使用します。

### OpenRouter

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `openrouter` |
| デフォルトエンドポイント | `https://openrouter.ai/api/v1/chat/completions` |
| 注意事項 | 特別な制約はありません |

OpenRouter 経由で Claude 以外のモデルを呼び出す場合に使用します。

### Google Gemini

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `gemini` |
| デフォルトエンドポイント | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| 注意事項 | reasoning_effort と thinking_config は同時に送信できません |
| 対応ジェネレーター | proxy（OpenAI 互換エンドポイント）/ gemini（ネイティブ API） |

### DeepSeek R1（推論系）

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `deepseek-r1` |
| デフォルトエンドポイント | `https://api.deepseek.com/chat/completions` |
| 注意事項 | deepseek-reasoner は system ロールメッセージに対応していません（自動的に最初の user メッセージにマージされます） |

### DeepSeek

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `deepseek` |
| デフォルトエンドポイント | `https://api.deepseek.com/chat/completions` |
| 注意事項 | 思考モードでは temperature/top_p/ペナルティパラメータがサイレントに無視されます |

### Qwen（通義 DashScope）

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `qwen` |
| デフォルトエンドポイント | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| 注意事項 | 思考機能（enable_thinking）の有効化にはストリーミングが必須；temperature を 0 に設定できません；地域によってエンドポイントが異なります |

### OpenAI 推論系（o1/o3/o4）

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `openai-reasoning` |
| デフォルトエンドポイント | `https://api.openai.com/v1/chat/completions` |
| 注意事項 | `system` ロールの代わりに `developer` ロールを使用します |

### OpenAI

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `openai` |
| デフォルトエンドポイント | `https://api.openai.com/v1/chat/completions` |
| 注意事項 | 特別な制約はありません |

### 通用 OpenAI 兼容（ローカル/セルフホスト）

| 項目 | 説明 |
|------|------|
| チャンネル識別子 | `generic` |
| デフォルトエンドポイント | `http://localhost:1234/v1/chat/completions` |
| 注意事項 | LM Studio / vLLM / llama.cpp server / koboldcpp などに適用 |

## チャンネルの役割

チャンネルを選択すると、always-accompany は自動的に対象に合わせたメッセージフォーマット適合を行います：

- **Claude 系**：ヘッダーの system メッセージをトップレベルの system フィールドに抽出（Anthropic プロトコルの要件）
- **Gemini**：ヘッダーの system を1つにマージ（互換レイヤーが systemInstruction に変換）
- **DeepSeek R1**：system メッセージを最初の user にマージ（R1 は system ロールを受け付けません）
- **OpenAI 推論系**：system ロールを developer ロールに置換
- **通用**：複数の system を1つにマージ（ローカル推論エンジンの互換性）

## 自動検出

チャンネルを選択しない場合（または「自動検出」を選択した場合）、always-accompany は API URL とモデル名からプロバイダーを推測します。ただし自動検出は誤判定の可能性があるため、手動選択を推奨します。

## Ollama（ローカルモデル）

Ollama は独立した ollama ジェネレーターを使用し、proxy は経由しません。ローカルで Ollama を実行している場合は、設定時に Ollama タイプのサービスソースを選択してください。Ollama が対応するサンプリングパラメータは OpenAI とは一部異なり（例：`repetition_penalty` の代わりに `repeat_penalty` を使用）、always-accompany はパラメータ名を自動的に変換します。

## ナビゲーション

- [サービスソース概要](overview.md) — 基本コンセプト
- [API 設定詳細](api-config.md) — 設定フィールドの詳細
- [モデルパラメータ](model-params.md) — サンプリングパラメータの説明
