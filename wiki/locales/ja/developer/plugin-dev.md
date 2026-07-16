# プラグイン開発

always-accompany のプラグインシステムを使えば、カスタムプラグインを作成して機能を拡張できます。プラグインは標準化されたインターフェースを通じて[メッセージパイプライン](message-pipeline.md)に参加し、AI へのプロンプトインジェクション、AI 返信の処理、設定パネルの提供などが可能です。

## プラグイン構成

always-accompany プラグインの最小ディレクトリ構成は以下のとおりです：

```
plugins/my-plugin/
├── info.json          ← プラグインメタデータ（必須）
├── main.mjs           ← プラグインエントリー（必須）
└── (オプション) display.mjs ← フロントエンド設定パネル
```

### info.json

プラグインのメタデータファイルで、parts_loader によって検出・読み取りされます：

```json
{
  "id": "my-plugin",
  "name": "マイプラグイン",
  "description": "プラグインの機能説明",
  "version": "1.0.0"
}
```

または `beilu-part.json` 形式でも構いません（どちらも parts_loader に認識されます）。

### main.mjs

プラグインのエントリーファイルです。interfaces を含むオブジェクトをエクスポートします：

```javascript
export default {
  info: { /* プラグイン情報 */ },
  interfaces: {
    chat: {
      GetPrompt,     // プロンプトをインジェクション
      TweakPrompt,   // プロンプトを調整
      ReplyHandler,  // AI 返信を処理
    },
    config: {
      GetData,       // 設定を読み取り
      SetData,       // 設定を書き込み
    },
  },
};
```

## インターフェース詳解

### GetPrompt

メッセージ送信前に呼び出され、プラグインがプロンプトにインジェクションしたい内容を返します。

**パラメータ**：`(chatReplyRequest)`

**戻り値**：`single_part_prompt_t` オブジェクト。内容は以下のとおりです：

```javascript
{
  text: [
    { content: "プロンプトテキスト", important: 0 }
  ],
  extension: {
    // プラグイン間で受け渡すデータ（AI には直接送信されない）
  }
}
```

- `text[]`：プロンプトにインジェクションするテキスト断片、important 順にソート
- `extension`：拡張データ、他のプラグインが TweakPrompt フェーズで読み取れます

### TweakPrompt

すべての GetPrompt の後に呼び出され、組み立て済みの prompt_struct を修正できます。3 ラウンド実行されます：

**パラメータ**：`(prompt_struct, chatReplyRequest, detail_level)`

- `prompt_struct`：現在のプロンプト構造（直接変更可能）
- `detail_level`：現在のラウンド（2 -> 1 -> 0）

**戻り値**：なし（prompt_struct を直接変更）

典型的な使い方：
- Round 1 (dl=2)：他のプラグインの extension データを読み取り
- Round 2 (dl=1)：メッセージシーケンスを再構成
- Round 3 (dl=0)：最終調整

### ReplyHandler

AI の返信到着後に呼び出され、返信中の特定タグを解析・処理します。

**パラメータ**：`(replyText, chatReplyRequest)`

**戻り値**：処理後のテキスト（返信内容を変更可能）

典型的な使い方：
- AI 返信中のカスタムタグを解析
- タグに対応する操作を実行（ファイル読み書き、変数設定など）
- 操作結果を GetPrompt を通じて次のラウンドにインジェクション

### GetData

フロントエンドや他のモジュールがプラグインの設定/状態を読み取る際に呼び出されます。

**パラメータ**：`(request)`

**戻り値**：設定データオブジェクト

### SetData

フロントエンドや他のモジュールがプラグインの設定を書き込む、またはアクションをトリガーする際に呼び出されます。

**パラメータ**：`(data, request)`

`data` 中の `_action` フィールドで異なる操作タイプを区別できます。

## プラグイン間通信

プラグイン間は直接 import せず、`prompt_struct` の `extension` フィールドを通じて間接通信します：

1. プラグイン A が GetPrompt フェーズでデータを `extension.my_data` に書き込み
2. プラグイン B が TweakPrompt フェーズで `prompt_struct.plugin_prompts['plugin-a'].extension.my_data` から読み取り

この疎結合設計により、プラグインを独立して開発・デプロイできます。

## プラグインのロード

### 自動ロード

`defaultParts.plugins` にリストされたプラグインは、すべての会話で自動的にロードされます。

### ロード順序

parts_loader がサーバー起動時にディレクトリ順でプラグインをロードします。プラグインのモジュールレベルコードはロード時に実行されるため、ブロッキングと循環依存に注意してください。

他のモジュールを参照する必要がある場合は、遅延動的 import（初回使用時にロード）の使用を推奨します。ロード順序の問題を回避できます。

## セキュリティ上の注意事項

### セキュリティ上重要な設定

プラグインにセキュリティ上重要な設定項目がある場合（サンドボックスの切り替え、コマンド実行の許可など）、`security_policy.mjs` の `OWNER_ONLY_PART_CONFIG_WRITE` テーブルに登録して、これらの設定が owner のみ変更可能になるようにする必要があります。

### ユーザーデータ分離

マルチユーザー環境では、プラグインの設定とデータはユーザーごとに分離する必要があります。`getUserDataDir(username)` でユーザーデータパスを取得するか、AsyncLocalStorage で per-user コンテキストを実装することを推奨します。

### フロントエンド設定パネル

`GetConfigDisplayContent` インターフェースを通じてフロントエンド設定パネルの JavaScript コードを返します。パネルはブラウザで実行されるため、機密情報を公開しないよう注意してください。

## ユーザープラグイン (beilu-plugin-host)

beilu-plugin-host を通じて、ユーザーはランタイム中にカスタムプラグインスクリプトをロードでき、サービスの再起動は不要です。ユーザープラグインは組み込みプラグインと同じインターフェース機能を持ちますが、セキュリティポリシーの制約を受けます。

## テスト

プラグイン開発時の推奨事項：

- `BEILU_DIAG=<モジュール名>` 環境変数で診断ログを有効化
- whitebox トレーシングシステム（wbTrace / wbDetect）でキーイベントを記録
- fakeSend（token プレビュー）モードで GetPrompt / TweakPrompt の出力をテスト

## ナビゲーション

- [プラグイン概要](../plugins/overview.md) — 既存プラグイン一覧
- [メッセージパイプライン](message-pipeline.md) — パイプラインにおけるプラグインの位置
- [システムアーキテクチャ](architecture.md) — 全体アーキテクチャ
- [API エンドポイントリファレンス](api-reference.md) — エンドポイントインターフェース
