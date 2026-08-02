# プラグイン

[プラグイン管理](beilu:settings/plugins)パネルで、すべてのプラグインを確認・設定できます。always-accompany には 18 個のプラグインが組み込まれており、機能別に以下のようにグループ分けされています。

## プラグイン一覧

<div class="wiki-group">
<div class="wiki-group-title">コアプラグイン <span class="wiki-badge-red">コア</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-memory</div>
<div class="wiki-card-desc">記憶システム（テーブル/ホットレイヤー/アーカイブ/リコール）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-preset</div>
<div class="wiki-card-desc">プリセットエンジン（プロンプト組み立て）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">beilu-worldbook</div>
<div class="wiki-card-desc">ワールドブック（キーワードトリガーによる背景インジェクション）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">ツールプラグイン <span class="wiki-badge-green">ツール</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-files</div>
<div class="wiki-card-desc">サンドボックス化されたファイルの読み書き・削除・実行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-web</div>
<div class="wiki-card-desc">ウェブ検索とウェブブラウジング</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">beilu-ppt</div>
<div class="wiki-card-desc">PPT 生成</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">感知プラグイン <span class="wiki-badge-blue">感知</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">beilu-eye</div>
<div class="wiki-card-desc">デスクトップスクリーンショット感知 + Electron デスクトップペット</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">拡張プラグイン <span class="wiki-badge">拡張</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-regex</div>
<div class="wiki-card-desc">正規表現スクリプトエンジン（AI 返信の後処理）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-mvu</div>
<div class="wiki-card-desc">変数システム（ローカル/グローバル変数の読み書き）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-ejs</div>
<div class="wiki-card-desc">EJS テンプレートレンダリング</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-toggle</div>
<div class="wiki-card-desc">エントリ動的スイッチ（プリセット/ワールドブックエントリ）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">beilu-vectordb</div>
<div class="wiki-card-desc">ベクトルデータベース（セマンティック検索）</div>
</div>
</div>
</div>

<div class="wiki-group">
<div class="wiki-group-title">基盤・開発 <span class="wiki-badge-blue">基盤/開発</span></div>
<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-sysinfo</div>
<div class="wiki-card-desc">システムモニタリング（CPU/メモリ/ネットワーク）</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-logger</div>
<div class="wiki-card-desc">ログ記録</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-plugin-host</div>
<div class="wiki-card-desc">ユーザープラグインホスト</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">beilu-tutorial</div>
<div class="wiki-card-desc">アプリ内チュートリアル / wiki（このヘルプページはこのプラグインがレンダリング）</div>
</div>
</div>
</div>

## プラグイン設定

各プラグインには独立した設定パネルがあります（[プラグイン管理](beilu:settings/plugins)で対応するプラグインをクリックすると開けます）。セキュリティ上重要な設定の書き込み（beilu-files の allowExec、beilu-ejs の sandboxOptOut など）にはインスタンス owner 権限が必要です。詳しくは[セキュリティセンター](../security/overview.md)（[セキュリティセンターを開く](beilu:settings/security)）をご覧ください。

## ユーザープラグイン

beilu-plugin-host を使用して、カスタムプラグインを作成・ロードできます。ユーザープラグインは組み込みプラグインと同等のインターフェース機能を持ちます。詳しくは[プラグイン開発](../developer/plugin-dev.md)をご覧ください。

## 詳細情報：プラグインインターフェース

各プラグインは標準インターフェースを通じてコアシステムと連携します：

### データインターフェース

| インターフェース | 方向 | 説明 |
|------|------|------|
| GetData | コア -> プラグイン | プラグイン設定と状態の読み取り |
| SetData | コア -> プラグイン | プラグイン設定の書き込みまたはアクションのトリガー |

### メッセージパイプラインインターフェース

| インターフェース | 呼び出しタイミング | 説明 |
|------|---------|------|
| GetPrompt | メッセージ送信前 | プラグインがプロンプトにインジェクションする内容を返す |
| TweakPrompt | GetPrompt の後 | 組み立て済みのプロンプト構造を修正・調整（3 ラウンド実行） |
| ReplyHandler | AI 返信後 | AI 返信中のタグ/指示を解析して実行 |
| GetReply | 生成呼び出し時 | AI 呼び出しリクエストをインターセプトまたは修正 |

### プラグインの呼び出し順序

1 回の完全なメッセージ送受信サイクルにおいて、プラグインは以下の順序で参加します：

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>ユーザーがメッセージを送信</b><small>メッセージパイプラインをトリガー</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. GetPrompt</b><small>各プラグインのプロンプトフラグメントを並列収集</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. TweakPrompt x 3 ラウンド</b><small>Round 1 (dl=2): 収集・クリア | Round 2 (dl=1): メッセージシーケンス再構築 | Round 3 (dl=0): スナップショット</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>3. StructCall</b><small>AI API を呼び出し（provider/ジェネレーターが実行）</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>4. ReplyHandler</b><small>AI 返信中の操作タグを解析</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>保存 + ブロードキャスト</b><small>メッセージを永続化しフロントエンドに通知</small></div>
</div>

### プラグインのロード

**デフォルトプラグイン**：always-accompany 起動時に `defaultParts.plugins` にリストされたプラグインを自動ロードします。コアプラグイン（memory / preset / worldbook など）は常に毎回の会話に参加します。

**会話レベルプラグイン**：会話作成時に、システムがデフォルトプラグインを会話の timeSlice にマージします。後からデフォルトリストに追加されたプラグインも自動的に加わります。

## クイックナビゲーション

- [ファイル操作 (beilu-files)](files.md) — AI ファイル読み書き
- [スクリーン感知 (beilu-eye)](eye.md) — デスクトップスクリーンショットとデスクトップペット
- [ウェブ検索 (beilu-web)](web.md) — 検索とウェブブラウジング
- [正規表現拡張 (beilu-regex)](regex.md) — AI 返信の後処理
- [変数システム (beilu-mvu)](mvu.md) — 変数の読み書き
- [スクリプトエンジン](scripts.md) — EJS テンプレートとスクリプト
- [プラグイン開発](../developer/plugin-dev.md) — カスタムプラグインの作成
