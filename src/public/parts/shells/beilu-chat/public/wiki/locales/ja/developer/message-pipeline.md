# メッセージパイプライン

メッセージパイプラインは、always-accompany においてユーザーがメッセージを送信してから AI の返信が表示されるまでの完全なデータフローです。このチェーンを理解することが、always-accompany の動作原理を理解する鍵となります。

## フルチェーン概要

<div class="wiki-flow">
  <div class="wiki-box wiki-box-amber wiki-box-full"><b>ユーザーがフロントエンドでメッセージを送信</b></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>POST /:chatid/message</b><small>endpoints.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addUserReply</b><small>chatOps.mjs — ユーザーメッセージを chatLog に保存</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>triggerCharReply</b><small>generation.mjs — AI 返信をトリガー</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>getChatRequest</b><small>requestBuilder.mjs — リクエストオブジェクトを構築</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>buildPromptStruct</b><small>プロンプト構造を組み立て</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-group" style="width:100%;max-width:480px;">
    <div class="wiki-group-title">プラグイン参加フェーズ</div>
    <div class="wiki-flow" style="margin:0;">
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>各プラグイン GetPrompt</b><small>プロンプト断片を並列収集</small></div>
      <div class="wiki-arrow">↓</div>
      <div class="wiki-box wiki-box-purple wiki-box-full"><b>各プラグイン TweakPrompt × 3 ラウンド</b><small>プロンプト構造を調整</small></div>
    </div>
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>executeGeneration</b><small>generation.mjs</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>GetReply → StructCall</b><small>provider — AI API を呼び出し</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green wiki-box-full"><b>AI ストリーミングレスポンス</b><small>StreamManager がチャンクごとにプッシュ</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple wiki-box-full"><b>各プラグイン ReplyHandler</b><small>返信中の操作タグを解析</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>finalizeEntry</b><small>メッセージ条目を構築</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue wiki-box-full"><b>addChatLogEntry</b><small>chatOps.mjs — AI 返信を chatLog に保存</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>broadcastChatEvent</b><small>WS でフロントエンドにプッシュ</small></div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red wiki-box-full"><b>自動継続ラウンド判定</b><small>生成を続行するかどうか</small></div>
</div>

## 各フェーズの詳細

### 1. ユーザーがメッセージを送信

フロントエンドが `POST /:chatid/message` エンドポイントを通じてユーザーメッセージを送信します。エンドポイントは `router.param("chatid")` による所属検証を経て、chatOps に処理を委譲します。

### 2. ユーザーメッセージの保存

`addUserReply` がユーザーメッセージを `chatLogEntry_t` として構築し、chatLog 配列に push して、ディスクに保存し、WS で `message_added` イベントをブロードキャストしてフロントエンドに通知します。

### 3. リクエストオブジェクトの構築

`getChatRequest` が完全な `chatReplyRequest_t` オブジェクトの組み立てを担当します：

- 会話メタデータ（chatMetadata）のロード
- ユーザーとキャラクター情報の解析
- デフォルトプラグインのマージ（getAllDefaultParts のプラグインは古いチャットの timeSlice になくても参加します）
- 可視チャットログの取得（getVisibleChatLog）

### 4. プロンプト構造の組み立て

`buildPromptStruct` がパイプラインランタイム（yonban pipelines）を呼び出し、すべての Part の GetPrompt と TweakPrompt をトリガーします：

#### GetPrompt フェーズ

各プラグインがプロンプトにインジェクションしたいテキスト断片を返します。戻り値は `prompt_struct` の対応する領域に入ります：

- `char_prompt` — キャラクター関連プロンプト
- `user_prompt` — ユーザー関連プロンプト
- `world_prompt` — ワールド/環境関連プロンプト
- `plugin_prompts` — プラグインプロンプト（プラグイン名で区分）

beilu-preset の GetPrompt は空殻を返します（プリセットの実際の処理は TweakPrompt フェーズで行われます）。

#### TweakPrompt 3 ラウンド

すべてのプラグインの TweakPrompt が detail_level の降順で 3 ラウンド実行されます：

| ラウンド | dl 値 | コア動作 |
|------|-------|---------|
| Round 1 | 2 | 収集クリア — 各モジュールのプロンプトをマクロ環境 env に読み込み、元のモジュールをクリア |
| Round 2 | 1 | メッセージ再構築 — エンジン buildAllEntries() が 4 段メッセージを生成、model_params をマージ |
| Round 3 | 0 | スナップショット — デバッグスナップショット（commanderSnapshot）を記録、chat_log はもう変更しない |

### 5. AI API 呼び出し

`executeGeneration` がストリーミング生成のコアです。GetReply インターフェースを通じて provider の StructCall を呼び出します：

- **StructCall** が prompt_struct を受け取り、`assembleCommanderMessages`（コマンダーモード）を呼び出すか、直接メッセージを組み立てます
- **applyModelParams** が canonical パラメータを provider 固有の形状にマッピングします
- HTTP/SSE ストリーミングリクエストを発行し、チャンクごとに返します

### 6. ストリーミングレスポンス処理

StreamManager がストリーミングレスポンスを管理します：

- チャンクごとに SSE データを解析
- WS で `stream_start` / `stream_update` イベントをフロントエンドにブロードキャスト
- フロントエンドが AI の返信を逐次表示

### 7. ReplyHandler 解析

AI の返信が完了した後、各プラグインの ReplyHandler が順次処理します：

- **beilu-files**：`<file_op>` / `<tool_call>` タグを解析し、ファイル操作を実行
- **beilu-regex**：正規表現置換ルールを実行
- **beilu-mvu**：変数操作コマンドを解析
- **beilu-memory**：`<tableEdit>` タグを解析し、記憶テーブルを更新
- **beilu-web**：`<search>` / `<browse>` タグを解析し、ウェブリクエストをトリガー

### 8. 保存とブロードキャスト

`finalizeEntry` が最終的な AI メッセージ条目（chatLogEntry_t）を構築し、`addChatLogEntry` を通じて chatLog に保存してブロードキャストします。

### 9. 自動継続ラウンド

AI の返信が継続ラウンド条件をトリガーした場合（プログラミングタスクの実行中やツールコール後に続行が必要な場合など）、システムは自動的に新しいラウンドの `triggerCharReply` をトリガーします。

継続ラウンドにはセーフティ制限があります：
- 継続ラウンド数に上限なし、パネルスイッチで制御可能
- 空返信リトライ制限（EMPTY_REPLY_MAX_RETRIES = 3）
- fuzzy_edit 連続失敗ヒューズ（FUZZY_FAIL_LIMIT = 3）
- Loop 自動継続：AI がツール呼び出しなしで終了した場合、カスタムテキストを注入して継続

## モジュール責務境界

| モジュール | 担当すること | 担当しないこと |
|------|--------|---------|
| endpoints.mjs | HTTP パラメータ検証 + 委譲 | 生成ロジックは担当しない |
| requestBuilder.mjs | リクエストオブジェクト組み立て | 生成スケジューリングは担当しない |
| generation.mjs | トリガー -> ストリーミング生成 -> ディスク書き込み -> 継続ラウンド | プロンプト組み立ては担当しない |
| chatOps.mjs | メッセージ CRUD + 書き込み操作 | AI 生成は担当しない |
| chatStorage.mjs | ストレージパス解決 + 永続化 | メッセージ操作は担当しない |
| prompt_struct.mjs | プロンプト構造定義 + シリアライゼーション | プラグイン呼び出しは担当しない |

## RT-4 グローバル契約

chatLog を変更した後にフロントエンドへ通知が必要なすべての操作は、まず `await saveChat`（ディスク書き込み）を行い、その後 `broadcastChatEvent`（WS プッシュ）を行う必要があります。順序が逆になると、フロントエンドが WS イベントを受信した後に refetch エンドポイントで古いデータを読む可能性があります。

## ナビゲーション

- [システムアーキテクチャ](architecture.md) — 全体アーキテクチャ
- [プリセットシステム概要](../presets/overview.md) — プリセットエンジン
- [コマンダーモード](../presets/commander.md) — 5 段組み立て
- [プラグイン概要](../plugins/overview.md) — プラグインインターフェース
