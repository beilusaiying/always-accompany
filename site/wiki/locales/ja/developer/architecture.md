# システムアーキテクチャ

always-accompany は Deno バックエンド + ネイティブフロントエンドを採用し、parts 体系で機能モジュールを組織しています。

## 技術スタック

| レイヤー | 技術 |
|---|------|
| ランタイム | Deno（Node.js 互換） |
| バックエンドフレームワーク | Express |
| フロントエンド | ネイティブ HTML/CSS/JS（フレームワークなし） |
| リアルタイム通信 | WebSocket |
| データストレージ | JSON ファイルシステム（データベースなし） |

## ディレクトリ構成

```
beilu-always-accompany/
├── src/
│   ├── server/              ← サーバーコア（起動/ルーティング/ミドルウェア）
│   ├── scripts/             ← 共用スクリプトツール
│   ├── public/
│   │   └── parts/
│   │       ├── shells/      ← シェル（UI + エンドポイント）
│   │       │   └── beilu-chat/  ← メインシェル
│   │       ├── plugins/     ← プラグイン
│   │       └── serviceGenerators/ ← AI サービスジェネレータ
│   └── yonban/              ← コア機能ライブラリ（移行後の実装体）
│       └── core/
│           ├── functions/   ← 汎用ステートレス機能
│           │   ├── api/     ← AI API 呼び出し（6 社 provider）
│           │   ├── prompt/  ← プリセットエンジン + マクロ + 変数
│           │   ├── memory/  ← 記憶システム
│           │   ├── security/ ← セキュリティ体系
│           │   ├── screenshot/ ← スクリーンショット感知
│           │   ├── web/     ← ウェブ検索
│           │   ├── regex/   ← 正規表現エンジン
│           │   └── ...
│           ├── pipelines/   ← パイプラインランタイム
│           └── transport/   ← IDE ブリッジ
├── data/                    ← ユーザーデータ（ランタイム生成）
│   ├── config.json          ← グローバル設定
│   └── users/               ← ユーザーデータ（per-user 分離）
│       └── <username>/
│           ├── shells/chat/ ← 会話データ
│           ├── presets/     ← プリセットファイル
│           └── ...
└── desktop-eye/             ← デスクトップペット Electron + Python スクリーンショット
```

## Parts 体系

### 3 種類の Part

| 種類 | ディレクトリ | 説明 |
|------|------|------|
| Shell（シェル） | parts/shells/ | UI + HTTP エンドポイントを提供する、システムの「外殻」 |
| Plugin（プラグイン） | parts/plugins/ | 機能拡張、標準インターフェースを通じてメッセージパイプラインに参加 |
| Service Generator（サービスジェネレータ） | parts/serviceGenerators/ | AI API 呼び出しの実装 |

<div class="wiki-grid wiki-grid-3">
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: var(--beilu-amber-fg);">Shell（シェル）</div>
    <div class="wiki-card-desc">UI インターフェースと HTTP エンドポイントを提供します。システムの「外殻」であり、ユーザーが直接操作するエントリーポイントです。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/shells/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 300);">Plugin（プラグイン）</div>
    <div class="wiki-card-desc">機能拡張モジュールで、GetPrompt / TweakPrompt / ReplyHandler などの標準インターフェースを通じてメッセージパイプラインに参加します。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/plugins/</span></div>
  </div>
  <div class="wiki-card">
    <div class="wiki-card-title" style="color: oklch(0.65 0.15 150);">Service Generator（サービスジェネレータ）</div>
    <div class="wiki-card-desc">AI API 呼び出しの具体的な実装で、各 provider のリクエスト/レスポンスの差異をカプセル化します。</div>
    <div style="margin-top:6px;"><span class="wiki-badge">parts/serviceGenerators/</span></div>
  </div>
</div>

### ロードメカニズム

`parts_loader.mjs` がすべての Part の検出とロードを担当します：

- ディレクトリ規約に従い `beilu-part.json` / `info.json` をスキャン
- 各 Part の `main.mjs`（エントリーファイル）をロード
- interfaces オブジェクトを抽出し、各種インターフェース（GetPrompt / TweakPrompt / ReplyHandler など）を登録

### 薄シェル re-export パラダイム

yonban 移行後、多くのプラグインの `main.mjs` は薄シェルになりました——re-export のみを行い、実際のコードは `yonban/core/functions/` にあります。薄シェルは削除されません（P 型薄シェル）。parts_loader が規約の場所で検出・ロードするためです。

## yonban レイヤー

yonban は always-accompany のコア機能ライブラリレイヤーです。parts との違いは以下のとおりです：

- **parts**：always-accompany プラグインプロトコルに従い、info.json と interfaces を持つ
- **yonban**：純粋な機能モジュールで、parts とサーバーコアから参照される

### 移行の背景

元々はすべてのコードが parts ディレクトリにありました。yonban 移行により「汎用ステートレスバックエンド機能」を `core/functions/<グループ>/` に集約し、コード構成をより明確に、再利用性をより高くしました。

## データレイヤー

always-accompany はデータベースではなく JSON ファイルを使用します。データ操作はアトミック書き込み（tmp + rename）で整合性を保証します。

### per-user データ分離

`data/users/<username>/` 配下に、各ユーザーは独立したデータディレクトリを持ちます。主要なデータパスは `getUserDataDir(username)` 権威関数で取得します。

### データファイル

| ファイル | 説明 |
|------|------|
| config.json | グローバル設定（Owner/秘密鍵/ユーザーリスト） |
| users/\<user\>/shells/chat/\<chatid\>.json | 会話データ |
| users/\<user\>/presets/config.json | プリセット設定 |
| users/\<user\>/presets/registry.json | プリセットレジストリ |
| users/\<user\>/presets/\*.json | プリセットファイル |

## モジュール間依存原則

- **セキュリティモジュール**（path_confine / auth / security_policy）は依存の最下層に位置し、上位モジュールを参照しません
- **parts_loader** は server ドメインにあり、endpoints / requestBuilder から参照されます
- **プラグイン間**は extension フィールドを通じてデータを受け渡します（間接通信）、直接 import はしません
- **循環依存**は遅延動的 import で解消します

<div class="wiki-layers">
  <div class="wiki-layer wiki-layer-amber">
    <span class="wiki-layer-label">Shell レイヤー</span>
    UI + エンドポイント — ユーザーリクエストのエントリーポイント、下位レイヤーのサービスを呼び出す
  </div>
  <div class="wiki-layer wiki-layer-purple">
    <span class="wiki-layer-label">Plugin レイヤー</span>
    機能拡張 — extension による間接通信、相互 import はしない
  </div>
  <div class="wiki-layer wiki-layer-blue">
    <span class="wiki-layer-label">Server レイヤー</span>
    parts_loader / endpoints / requestBuilder — ロードとディスパッチ
  </div>
  <div class="wiki-layer wiki-layer-green">
    <span class="wiki-layer-label">yonban レイヤー</span>
    コア機能ライブラリ — 純粋な関数モジュール、上位レイヤーから参照される
  </div>
  <div class="wiki-layer">
    <span class="wiki-layer-label">セキュリティレイヤー</span>
    path_confine / auth / security_policy — 最下層、上位レイヤーを参照しない
  </div>
</div>

## ナビゲーション

- [メッセージパイプライン](message-pipeline.md) — メッセージフロー全体チェーン
- [プラグイン開発](plugin-dev.md) — カスタムプラグインの作成
- [API エンドポイントリファレンス](api-reference.md) — HTTP/WS インターフェース
- [セキュリティセンター](../security/overview.md)（[パネルを開く](beilu:settings/security)） — セキュリティアーキテクチャ
