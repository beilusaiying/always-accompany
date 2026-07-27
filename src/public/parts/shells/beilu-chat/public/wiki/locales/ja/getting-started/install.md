# AI サービスソースの設定

AI サービスソースは、どの AI プロバイダを使うか、どのモデルを使うかを決定します。

## サービスソースを追加する

[設定 → AIサービスソース](beilu:settings/api) → 「追加」をクリック：

1. 名称を入力（任意の名前で、区別用）
2. サービスアドレスを入力（API endpoint）
3. API Key を入力
4. チャンネルを選択（リクエスト形式を決定）
5. モデルを選択

## 対応チャンネル

| チャンネル | 用途 |
|------|---------|
| openai | OpenAI 公式 / OpenAI 互換のリバースプロキシ |
| claude | Anthropic Claude API |
| gemini | Google Gemini |
| deepseek | DeepSeek |
| ollama | ローカル Ollama 推論 |
| openrouter | OpenRouter マルチモデルアグリゲーション |
| generic | その他の OpenAI 互換サービス |

詳しくは [対応 AI プロバイダ](beilu:wiki/ai-service/providers.md) をご覧ください。

## マルチサービスソース

複数のサービスソースを追加できます：
- キャラクターごとに異なる AI を割り当て（キャラクターカード編集 → AI ソース選択）
- モードごとに異なるモデルを使用（サブモードに個別の API ソースをバインド可能）
- メインソースがダウンした際にバックアップに切り替え

## 動作確認

追加後にメッセージを 1 通送ってみてください。返答があれば設定完了です。返答がない場合は [バックグラウンドモニタ](beilu:settings/monitor) のエラーログを確認してください。
