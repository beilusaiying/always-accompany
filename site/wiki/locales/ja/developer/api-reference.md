# API エンドポイントリファレンス

beilu-chat のすべての HTTP/WS ルートは `endpoints.mjs` で定義されています。このドキュメントでは主要なエンドポイントとその機能を一覧にしています。すべてのエンドポイントは `authenticate` ミドルウェアによって保護されています（ログインが必要です）。詳しくは[権限と認証](../security/auth.md)をご覧ください。

## ルートプレフィックス

すべての beilu-chat エンドポイントの基本パスは `/api/shells/chat/` です。以下のエンドポイントではこのプレフィックスを省略しています。

## 会話メッセージ操作

`:chatid` をパスパラメータとするエンドポイントは、`router.param("chatid")` による中央所属検証を経ます——リクエストユーザーがその会話を操作する権限があるかどうかを検証します。

| メソッド | パス | 説明 |
|------|------|------|
| WS | `/ws/.../ui/:chatid` | チャット UI WebSocket 接続 |
| GET | `:chatid/initial-data` | 会話を開いた際の初期化データ取得 |
| GET | `:chatid/log` | chatLog の取得（ページネーション対応） |
| GET | `:chatid/log/length` | chatLog の長さ（`?visible=1` で非表示でない条目のみ） |
| POST | `:chatid/message` | ユーザーがメッセージを送信（R1 エントリーポイント、AI 返信をトリガー） |
| PUT | `:chatid/message/:index` | 指定メッセージの編集 |
| DELETE | `:chatid/message/:index` | 指定メッセージの削除 |
| POST | `:chatid/trigger-reply` | AI 返信のみトリガー（ユーザーメッセージは保存しない） |
| POST | `:chatid/messages/delete-range` | メッセージ範囲の一括削除 |
| POST | `:chatid/messages/hide` | メッセージ範囲の表示/非表示切り替え |
| PUT | `:chatid/timeline` | タイムラインの切り替え（greeting swipe） |
| GET | `:chatid/render/entries` | regex アクティブ修正：render クエリ |

## 会話ライフサイクル

| メソッド | パス | 説明 |
|------|------|------|
| POST | `new` | 空の会話を新規作成 |
| DELETE | `delete` | 会話の一括削除 |
| POST | `:chatid/rename` | 会話のリネーム |
| POST | `:chatid/mode` | 会話モードバッジの設定 |
| POST | `:chatid/using` | モードウィンドウ使用中ポインタ（mode:char -> chatid） |
| POST | `branch` | 会話のブランチ分岐 |
| GET | `getchatlist` | チャットリストの取得 |
| POST | `search` | チャット内容の全文検索 |

## 会話メタデータ

| メソッド | パス | 説明 |
|------|------|------|
| GET | `:chatid/chars` | 会話内のキャラクターリスト |
| GET | `:chatid/plugins` | 会話内のプラグインリスト |
| GET | `:chatid/persona` | 現在のペルソナ名 |
| GET | `:chatid/world` | 現在のワールド設定名 |
| POST | `:chatid/char` | 会話にキャラクターを追加 |

## キャラクターカード管理

| メソッド | パス | 説明 |
|------|------|------|
| POST | `create-char` | 空白キャラクターカードの作成 |
| PUT | `update-char/:charName` | キャラクターカードフィールドの更新 |
| DELETE | `delete-char/:charName` | キャラクターカードの削除（8 ステップクリーンアップ） |
| POST | `import-char` | キャラクターカード JSON/PNG のインポート（正規表現 + ワールドブック移行を含む） |
| GET | `char/:charName/export` | キャラクターカードの PNG/JSON エクスポート |
| GET | `char-data/:charName` | chardata.json の取得 |
| GET | `char-aisource/:charName` | キャラクターにバインドされた AI ソース + 利用可能ソースリストの取得 |

## ペルソナ管理

| メソッド | パス | 説明 |
|------|------|------|
| POST | `persona/create` | ペルソナの作成 |
| DELETE | `persona/:name` | ペルソナの削除 |
| PUT | `persona/:name/update` | ペルソナの説明 + アバターの更新 |

## IDE ブリッジ

| メソッド | パス | 説明 |
|------|------|------|
| GET | `ide/wstoken` | ブラウザが IDE WS token を代理読み取り |
| POST | `ide/connect` | バックエンド ideClient の即時接続を強制 |
| POST | `ide/manual-tool-call` | 手動パネルツールコール（バックエンド統一実行ゲートを経由） |

## マルチグループ並列管理

| メソッド | パス | 説明 |
|------|------|------|
| GET | `groups` | 本ユーザーの全グループを一覧表示 |
| POST | `groups` | グループの新規作成 |
| PUT | `groups/:groupId` | グループフィールドの更新 |
| DELETE | `groups/:groupId` | グループの削除（worker の終了を含む） |
| POST | `groups/:groupId/role` | グループ内ロールを chatid にバインド |
| DELETE | `groups/:groupId/role/:role` | グループ内ロールのバインド解除 |
| GET | `groups/engine` | 並列エンジンのスイッチ状態 |
| POST | `groups/engine` | 並列エンジンスイッチの切り替え |
| POST | `groups/:groupId/execute` | グループ内全ロールの会話を起動 |

## プラグイン設定エンドポイント

プラグイン設定は parts_router の統一エンドポイント経由でアクセスします（beilu-chat 固有ではありません）：

| 操作 | エンドポイント | 説明 |
|------|------|------|
| 設定読み取り | `GET /api/parts/:partpath/config` | プラグイン設定の取得 |
| 設定書き込み | `POST /api/parts/:partpath/config` | プラグイン設定の更新 |
| データ読み取り | `GET /api/parts/:partpath/data` | GetData の呼び出し |
| データ書き込み | `POST /api/parts/:partpath/data` | SetData の呼び出し |

セキュリティ上重要な config/setdata の書き込みは `partConfigWriteNeedsOwner` による検出を受け、該当時は owner 権限が要求されます。

## WebSocket イベント

always-accompany は WebSocket を通じてリアルタイム通信を実現しています。主要なイベントは以下のとおりです：

### サーバー -> クライアント

| イベント | 説明 |
|------|------|
| `message_added` | 新しいメッセージの追加（ユーザーメッセージ / AI 返信プレースホルダー） |
| `message_replaced` | メッセージの置換（AI 返信確定 / 非表示範囲の更新） |
| `message_edited` | メッセージの編集 |
| `message_deleted` | メッセージの削除 |
| `stream_start` | AI ストリーミング返信の開始 |
| `stream_update` | AI ストリーミング返信の新しいチャンク |
| `token_usage` | Token 使用統計 |
| `typing_status` | 入力ステータス（マルチグループ並列時の対向アクティビティ表示） |
| `auto_continue_fuse` | 自動継続ラウンドのヒューズ通知 |

### クライアント -> サーバー

| イベント | 説明 |
|------|------|
| `stop_generation` | 現在の生成を停止 |

## 認証要件

| エンドポイントタイプ | 認証レベル |
|---------|---------|
| すべての API エンドポイント | authenticate（ログインが必要） |
| セキュリティ上重要な設定 | requireOwner（インスタンス owner が必要） |
| API v1 外部呼び出し | API Key + scope 検証 |

## エラーレスポンス

| ステータスコード | 説明 |
|--------|------|
| 401 | 未認証（未ログインまたは token 期限切れ） |
| 403 | 権限なし（owner でない / 会話が現在のユーザーに属さない） |
| 404 | 会話 / キャラクター / リソースが存在しない |
| 500 | サーバー内部エラー |

## ナビゲーション

- [システムアーキテクチャ](architecture.md) — 全体アーキテクチャ
- [メッセージパイプライン](message-pipeline.md) — メッセージフロー
- [権限と認証](../security/auth.md) — 認証システム
- [プラグイン開発](plugin-dev.md) — カスタムプラグイン
