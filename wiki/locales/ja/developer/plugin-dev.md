# プラグイン開発と接続

always-accompany のプラグインシステムを使えば、カスタムプラグインを作成して機能を拡張できます。プラグインは標準化されたインターフェースを通じて[メッセージパイプライン](message-pipeline.md)に参加し、AI へのプロンプトインジェクション、AI 返信の処理、独自の HTTP エンドポイントの登録、設定パネルの提供が可能です。

このページは2つのパートで構成されています：**プラグインの作り方**（構造・ライフサイクル・インターフェース）と**接続の仕方**（会話パイプラインへの接続・フロントエンドへの接続・外部アプリへの接続）。

## 一、プラグインの作り方

### ディレクトリ構造

プラグインの最小ディレクトリ構造：

```
plugins/my-plugin/
├── beilu-part.json    ← パーツマニフェスト（必須 — 発見機構はこれだけを認識する）
├── info.json          ← ローカライズ表示情報（必須）
└── main.mjs           ← プラグインエントリー（必須）
```

### beilu-part.json（パーツマニフェスト）

パーツツリーの発見機構は**`beilu-part.json` のみをスキャン**します。ディレクトリに `main.mjs` があってもこのマニフェストがない場合、プラグインはパーツ列挙に入らず、バックエンドが `orphan_part_no_manifest` 警告を出力します。

```json
{
  "type": "plugins",
  "dirname": "my-plugin"
}
```

- `type`：パーツタイプパス（プラグインは常に `plugins`）
- `dirname`：ディレクトリ名。実際のディレクトリ名と一致している必要があります

### info.json（表示情報）

言語キーで整理されたローカライズ情報で、プラグインリスト/詳細ページに表示されます：

```json
{
  "zh-CN": {
    "name": "我的插件",
    "avatar": "https://api.iconify.design/mdi/puzzle.svg",
    "description": "一句话描述",
    "description_markdown": "**详细描述**，支持 Markdown。",
    "version": "0.1.0",
    "author": "你的名字",
    "tags": ["标签"]
  },
  "en-UK": { "name": "My Plugin", "description": "..." }
}
```

### main.mjs（エントリー）

ライフサイクルフックと interfaces を含むオブジェクトをエクスポートします：

```javascript
export default {
  info,                // 通常 info.json を import
  Init,                // 省略可：インストール初期化（ユーザーごとに一度だけ）
  Load,                // 省略可：ランタイムごとに読み込み
  Unload,              // 省略可：アンロード（プロセス内から削除）
  Uninstall,           // 省略可：プラグイン削除時のクリーンアップ
  interfaces: {
    chat: {
      GetPrompt,       // プロンプトをインジェクション
      TweakPrompt,     // 組み立て済みの prompt_struct を調整
      ReplyHandler,    // AI 返信を処理（再生成をトリガーできる）
    },
    config: {
      GetData,         // 設定/状態を読み取り
      SetData,         // 設定を書き込み/アクションをトリガー
    },
  },
};
```

### ライフサイクルと実行順序

`server/parts_loader.mjs` が駆動し、順序は固定です：

```
Init({ router, username })   ← ユーザーごとのインストール後一度だけ（parts_init レコードでゲート）
  ↓
Load({ router, username })   ← ランタイムごとの初回読み込み
  ↓
interfaces.config.SetData(保存済み設定)   ← フレームワークが parts_config 永続化設定を再注入
```

要点：

- **SetData は Load の後に実行されます** — `Load` 内ではフレームワーク注入の永続化設定を取得できません。設定に依存する初期化は SetData 内、または遅延実行にしてください。
- `Init` はインストール後の初回読み込み時にのみ一度実行されます（ディスク上の `parts_init` レコードでゲート）。worker isolate 内では isolate ごとに一度実行されます（メモリゲート）。
- 起動時、フレームワークはまず**シャロードロード**（モジュールキャッシュをウォームアップするだけで `import` のみ、フックは実行しない）を行い、その後バックグラウンドで**フルプリロード**（完全なライフサイクル）を実行します。ユーザーリクエストパスではレイジーロードがフォールバックとして機能します。
- `plugins/` ディレクトリに置かれた組み込みプラグインはデフォルトプラグインとして自動登録されます（`plugins/main.mjs` コンテナが Load 時に `main.mjs` を含む全サブディレクトリをスキャン）。読み込みに失敗したプラグインは登録されません（不正エントリの復活を防ぐ）。
- **ホットリロード = プロセスの再起動**（Deno はシングルファイル ESM のアンロードに対応していません）。コード変更を反映させるにはサービスの再起動が必要です。
- 受け取るプラグイン参照は遅延プロキシ（FullProxy）です。リロード後、古い参照は自動的に新しいインスタンスを指します。

## 二、接続の仕方：会話パイプラインへの接続

会話の各ターンで、パイプラインは固定の順序でプラグインの `interfaces.chat` の3つのフックに触れます。参加するには、プラグインを `plugins/` に置くだけです（自動登録後すぐに参加）。追加設定は不要です。

### GetPrompt — 返信前インジェクション

すべてのプラグインの GetPrompt は**並行して発行され、まとめて await** されます。戻り値は `prompt_struct.plugin_prompts[プラグイン名]` に入ります。

**シグネチャ**：`GetPrompt(args)`（args = chatReplyRequest、`chatid` / `username` / `chat_log` 等を含む）

**戻り値**：

```javascript
{
  text: [
    { content: "プロンプトテキスト", important: 0 }   // important 順にソートして「プラグイン」セグメントへ
  ],
  additional_chat_log: [],   // 省略可：チャット履歴セグメントに追加するエントリ
  extension: {},             // 省略可：プラグイン間で受け渡すデータ（AI には直接送信されない）
}
```

### TweakPrompt — 組み立て後調整

すべての GetPrompt 完了後に `detail_level` ラウンド実行されます（デフォルト3ラウンド：dl = 2 → 1 → 0）。各ラウンド内では各プラグインが並行して実行されます。

**シグネチャ**：`TweakPrompt(args, prompt_struct, my_prompt, detail_level)`

- `prompt_struct`：完全なプロンプト構造（直接変更可能）
- `my_prompt`：GetPrompt フェーズでのこのプラグインの戻り値
- 戻り値：なし（`prompt_struct` を直接変更）

典型的なラウンド別の使い方：dl=2 で他のプラグインの extension を読み取り → dl=1 でメッセージシーケンスを再構成 → dl=0 で最終調整。

### ReplyHandler — 返信後処理

AI 返信が届いた後、再生成ループ内で**プラグインごとに直列**に呼び出されます。

**シグネチャ**：`ReplyHandler(result, { ...args, prompt_struct, AddLongTimeLog })`

- `result`：返信オブジェクト。`result.content` を変更すると返信内容が変わります（`content_for_show` は表示レイヤーのテキスト）
- `AddLongTimeLog(entry)`：ツール呼び出しトレースをこのメッセージに添付して永続化します（ターンをまたいで参照可能）
- **戻り値：truthy = 再生成をトリガー**（regen ループの回数上限はなく、あなたのロジックで終了を制御）。falsy = 通過
- 単一プラグインの例外は隔離されてスキップされ、他のプラグインの ReplyHandler は中断されません

典型的な使い方：AI 返信中のカスタムタグを解析 → 操作を実行（ファイル読み書き、変数設定）→ 結果を次のラウンドの GetPrompt でインジェクション。

### プラグイン間通信

プラグイン同士は直接 import せず、`prompt_struct` の extension フィールドを通じて間接通信します：

1. プラグイン A が GetPrompt の戻り値に `extension.my_data` を書き込む
2. プラグイン B が TweakPrompt フェーズで `prompt_struct.plugin_prompts['plugin-a'].extension.my_data` を読み取る

### モードパイプライン（上級）

生成は ModeDef パイプライン（chat/code/work 等のモードごとに1本）を通ります。パイプラインメニューに移行済みのプラグインは dispatch がモード別に振り分けます。メニュー外のプラグインはダイレクトコール — **新しいプラグインはデフォルトでダイレクトコールされ、すべてのモードに参加できます**。パイプラインメニューへの登録は不要です。

## 三、接続の仕方：フロントエンドへの接続

### 自己登録 HTTP エンドポイント

`Init` / `Load` で受け取る `router` はプラグイン専用の Express ルーターで、次のパスにマウントされます：

```
/(api|ws|virtual_files)/parts/plugins:<プラグイン名>/<登録したパス>
```

例えばプラグイン内で `router.post('/config/setdata', handler)` と書けば、フロントエンドは `POST /api/parts/plugins:my-plugin/config/setdata` をリクエストします。すべての parts API リクエストはログイン認証を先に通過します。未認証の場合は 401 を返します。

### config getdata/setdata 規約

フロントエンドとプラグイン間の通信の一般的な規約：

- `GET  /api/parts/plugins:<名>/config/getdata` → `interfaces.config.GetData()`
- `POST /api/parts/plugins:<名>/config/setdata` → `interfaces.config.SetData(data)`

`data._action` フィールドでアクションの種類を区別します（ファイル読み取り/設定書き込み/操作トリガーなど）。1つの SetData で複数の操作を振り分けます。

### セキュリティ上重要な設定は必ず owner ゲートを登録する

マルチユーザー環境では、ログインしているユーザーなら誰でも `config/setdata` を呼べます。設定項目が**プロセスレベルのグローバルセキュリティ状態**を書き込む場合（サンドボックスの切り替え、コマンド実行の許可、ワークスペースルートの変更など）は、`security_policy.mjs` のセキュリティ上重要な書き込みリストに登録する必要があります。フレームワークはルーティングの接合点で owner のみ書き込みを強制します（大文字小文字のバリアントも対象）。登録しなければ、任意の登録ユーザーがあなたのスイッチを操作できます（RCE / サンドボックスエスケープ面）。

### ユーザーデータの分離

マルチユーザー環境では、プラグインの設定とデータはユーザーごとに分離します。ユーザーデータディレクトリを使って保存するか、AsyncLocalStorage で per-user コンテキストを実装してください（beilu-files のやり方）。GetPrompt/ReplyHandler の `args.username` が分離キーのソースです。

## 四、接続の仕方：外部アプリへの接続

外部プログラム（ゲーム、スクリプト、サードパーティツール）はプラグインを使わず、**`/api/v1` 外部インターフェース**を使います：

1. 設定 → 外部アプリ連携 → API キーを新規作成（権限スコープを選択。キーは一度しか表示されません）
2. REST 呼び出し：`Authorization: Bearer <key>`、エンドポイントは [API エンドポイントリファレンス](api-reference.md)を参照（chat / characters / variables / memory / presets / worldbooks / tools / webhooks）
3. リアルタイムブリッジ：`ws://host/api/v1/game/connect?chatId=<id>&token=<key>` — `{type:"send", content, sender}` を送ると AI 返信がトリガーされ、ストリーミングトークンとメッセージイベントを自動受信
4. アウトバウンドプッシュ：Webhook を登録すると、AI 返信完了時に HMAC 署名付き POST があなたの URL に送られます

外部入力はサニタイズされます（不可視文字の除去、プロトコルタグのエスケープ、`<external_user>` 身元でラップ）。サニタイズを省略するには別途 `chat:raw` スコープが必要です。危険な操作（会話の削除/プリセットの変更）には `X-Beilu-Confirm: true` 確認ヘッダーが必要です。

## ユーザープラグイン (beilu-plugin-host)

beilu-plugin-host を通じて、ユーザーはランタイム中にカスタムプラグインスクリプトをロードでき、サービスの再起動は不要です。ユーザープラグインは組み込みプラグインと同じインターフェース機能を持ちますが、セキュリティポリシーの制約を受けます。

## デバッグ

- `BEILU_DIAG=<モジュール名>` 環境変数で診断ログを有効化
- whitebox トレーシング（wbTrace / wbDetect）でキーイベントを記録。エラーパネルから確認可能
- fakeSend（token プレビュー）モードで GetPrompt / TweakPrompt の出力をテスト（実際には送信しない）

## ナビゲーション

- [プラグイン概要](../plugins/overview.md) — 既存プラグイン一覧
- [メッセージパイプライン](message-pipeline.md) — パイプラインにおけるプラグインの位置
- [システムアーキテクチャ](architecture.md) — 全体アーキテクチャ
- [API エンドポイントリファレンス](api-reference.md) — エンドポイントインターフェース
