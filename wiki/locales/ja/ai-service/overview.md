# AI サービスソースの追加

[設定 → AI サービスソース](beilu:settings/api)で API を追加し、always-accompany を AI に接続します。

## クイックスタート

1. [AI サービスソース](beilu:settings/api)設定パネルに移動します
2. API アドレス（URL）を入力します
3. API キー（Key）を入力します
4. モデル名を選択します
5. チャンネル（Provider）を選択し、always-accompany にどのサービスの API かを伝えます
6. 設定を保存します

### チャンネルの選び方

チャンネルは always-accompany が API のメッセージフォーマットをどう適合させるかを決定します：

- Claude を使う場合は `Anthropic Claude` を選択
- OpenRouter 経由で Claude を使う場合は `OpenRouter -> Claude` を選択
- ローカルモデルを使う場合は `通用 OpenAI 兼容` を選択
- 不明な場合は `自動検出` を選択（非推奨、誤判定の可能性があります）

詳しくは [API 設定詳細](api-config.md) をご覧ください。

## 複数サービスソースの設定

always-accompany は複数のサービスソースの設定に対応しています：

- 異なるモードに異なるサービスソースを紐付け（チャットには Claude、コーディングには GPT）
- 異なるキャラクターに異なるサービスソースを紐付け
- 異なるサブモードに異なるサービスソースを紐付け

## 対応サービスプロバイダー

| プロバイダー | 説明 |
|--------|------|
| OpenAI | GPT シリーズモデル |
| Anthropic Claude | Claude シリーズモデル（公式 API および OpenAI 互換エンドポイントに対応） |
| Google Gemini | Gemini シリーズモデル |
| xAI Grok | Grok シリーズモデル（リバース API） |
| Ollama | ローカルデプロイのオープンソースモデル |
| DeepSeek | DeepSeek シリーズモデル |
| Qwen（通義） | 通義千問シリーズモデル |
| OpenRouter | マルチモデルアグリゲーションプラットフォーム |
| 通用 OpenAI 兼容 | LM Studio / vLLM / llama.cpp などのローカルエンジン |

詳しくは [対応 AI プロバイダー](providers.md) をご覧ください。

## ジェネレータータイプ

always-accompany 内部には複数の**ジェネレーター（Service Generator）**があり、それぞれ1種類の API プロトコルに対応します：

| ジェネレーター | プロトコル | 適用シーン |
|--------|------|---------|
| proxy | OpenAI Chat Completions | 最も汎用的。ほとんどのプロバイダーがこの経路を使用 |
| claude-api | Anthropic Messages API | Claude 公式ネイティブ API |
| gemini | Gemini API | Gemini 公式 API |
| grok | Grok リバース API | xAI Grok |
| claude | Claude リバース API | Claude リバース |
| ollama | Ollama API | ローカル Ollama |

その中で **proxy** が最も一般的なジェネレーターで、すべての OpenAI 互換フォーマットの API（OpenRouter、DeepSeek、Qwen など）に対応します。

## サービスソースとは

always-accompany 自体には AI モデルが含まれておらず、API を通じて外部の AI サービスを呼び出します。サービスソースとは、この API 接続の設定——API アドレス、キー、使用するモデルなどの情報を含むものです。

例えるなら、always-accompany が電話機だとすると、サービスソースは SIM カードです。SIM カードがなければ、どんなに良い電話機でも発信できません。

## クイックナビゲーション

- [対応 AI プロバイダー](providers.md) — 各プロバイダーの詳細と設定のポイント
- [API 設定詳細](api-config.md) — 設定フィールドの説明
- [モデルパラメータ](model-params.md) — temperature、top_p などのパラメータ説明
