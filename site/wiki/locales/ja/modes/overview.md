# モードシステム

Ctrl+1~4（または Alt+1~4）でモードを切り替えます。各モードは独立した作業環境であり、異なるレイアウト、パネル、AI の動作を持っています。

## 4つの主要モード

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Smart スマートモード <span class="wiki-badge">Ctrl+1 / Alt+1</span></div>
<div class="wiki-card-desc">3カラム（左右は折りたたみ可能）<br>ペルソナ管理、ワールドブック、タスクボード</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Chat/AIRP チャットモード <span class="wiki-badge">Ctrl+2 / Alt+2</span></div>
<div class="wiki-card-desc">3カラム<br>ロールプレイ対話、プリセット管理</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Code/IDE コードモード <span class="wiki-badge">Ctrl+3 / Alt+3</span></div>
<div class="wiki-card-desc">IDE スタイル（アクティビティバー+サイドバー+メインエリア）<br>コード作成、ファイルブラウジング、プログラミング支援</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">Work ワークモード <span class="wiki-badge">Ctrl+4 / Alt+4</span></div>
<div class="wiki-card-desc">IDE スタイル<br>タスク管理、承認、委任、定時タスク</div>
</div>
</div>

モードを切り替えると、そのモードにバインドされたプリセット、API ソース、モデルパラメータが自動的に読み込まれ、AI の動作が変わります。

## 4つの補助ビュー

補助メニューから開きます。管理と設定のインターフェースを提供します：

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Bot 管理 <span class="wiki-badge-blue">補助メニュー</span></div>
<div class="wiki-card-desc">マルチプラットフォーム Bot の設定と権限管理</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Companion ゲームコンパニオン <span class="wiki-badge-blue">補助メニュー</span></div>
<div class="wiki-card-desc">デスクトップペット、Live2D、AI 自律行動</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Memory 記憶管理 <span class="wiki-badge-blue">補助メニュー</span></div>
<div class="wiki-card-desc">記憶テーブルの閲覧・編集、AI プリセット実行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">Helper ST 互換 <span class="wiki-badge-blue">補助メニュー</span></div>
<div class="wiki-card-desc">正規表現スクリプト、変数管理、ST 互換ツール</div>
</div>
</div>

## サブモード

[Code](beilu:mode/files) と [Work](beilu:mode/work) モードにはそれぞれ 11 個のサブモードがあり、作業段階をより細かく分割できます。各サブモードはプリセット、API ソース、モデル、サンプリングパラメータを個別にバインドできます。詳しくは[サブモードと切り替え](beilu:wiki/modes/submodes.md)をご覧ください。

## 詳細：2層モードアーキテクチャ

always-accompany のモードは2層に分かれています：

| 層 | 説明 | 選択肢 |
|------|------|--------|
| バックエンドモード（B チャンネル） | 権威モード値。AI の動作とプリセットの読み込みを決定します | `chat` / `smart` / `code` / `work` / `bot` |
| フロントエンド Tab（UI ビュー） | インターフェース表示層。レイアウトとパネルを決定します | `smart` / `chat` / `files` / `work` / `memory` / `bot` / `companion` / `helper` / `settings` / `editor` |

バックエンドモードが権威ソースであり、フロントエンド Tab はビュー層です。1つのバックエンドモードが複数のフロントエンド Tab に対応する場合があります（例：`chat` モードは Chat、Bot、Helper などのビューを兼ねます）。ただし、各 Tab は最大1つのバックエンドモードにマッピングされます。

### モードと Tab のマッピング関係

**正方向マッピング**（バックエンドモード → フロントエンド Tab）：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>バックエンドモード（B チャンネル）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart</small></div>
<div class="wiki-box wiki-box-amber"><b>code</b><small>→ files</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work</small></div>
</div>
</div>
</div>

**逆方向マッピング**（フロントエンド Tab → バックエンドモード）：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<b>主モード Tab（バックエンドモードを切り替えます）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-amber"><b>chat</b><small>→ chat チャットモード</small></div>
<div class="wiki-box wiki-box-amber"><b>airp</b><small>→ chat AIRP ロールプレイ</small></div>
<div class="wiki-box wiki-box-amber"><b>smart</b><small>→ smart スマートモード</small></div>
<div class="wiki-box wiki-box-amber"><b>bot</b><small>→ chat Bot 管理</small></div>
<div class="wiki-box wiki-box-amber"><b>helper</b><small>→ chat ST 互換</small></div>
<div class="wiki-box wiki-box-amber"><b>files</b><small>→ code IDE コードモード</small></div>
<div class="wiki-box wiki-box-amber"><b>work</b><small>→ work ワークモード</small></div>
</div>
</div>
<div class="wiki-layer wiki-layer-blue">
<b>ビュー専用 Tab（バックエンドモードを切り替えません）</b>
<div class="wiki-row">
<div class="wiki-box wiki-box-blue"><b>memory</b><small>ビュー専用</small></div>
<div class="wiki-box wiki-box-blue"><b>companion</b><small>ビュー専用</small></div>
<div class="wiki-box wiki-box-blue"><b>settings</b><small>ビュー専用</small></div>
<div class="wiki-box wiki-box-blue"><b>editor</b><small>ビュー専用</small></div>
</div>
</div>
</div>

### モード切り替えフロー

ユーザーがモード切り替えをトリガーすると、システムは以下のフローを実行します：

<div class="wiki-flow">
<div class="wiki-box wiki-box-green wiki-box-full"><b>1. ユーザー操作</b><small>トップセレクターをクリック / ショートカットキーを押す / 補助メニューをクリック</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. switchTab(tabName)</b><small>フロントエンドが UI ビューを切り替えます</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber wiki-box-full"><b>3. switchModeTo(targetMode)</b><small>Tab がバックエンドモードにマッピングされている場合、バックエンドモード切り替えをトリガーします</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. バックエンド switchMode</b><small>モード値を永続化し、すべての接続にブロードキャストします</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>5. フロントエンド更新</b><small>ブロードキャストを受信後、UI を更新し、対応する chatId を復元します</small></div>
</div>

## クイックナビゲーション

- [チャットモード (Chat/AIRP)](beilu:wiki/modes/chat.md) - ロールプレイと日常会話
- [コードモード (Code/IDE)](beilu:wiki/modes/ide.md) - AI 支援プログラミング
- [ワークモード (Work)](beilu:wiki/modes/work.md) - タスク管理とワークフロー
- [Bot モード](beilu:wiki/modes/bot.md) - マルチプラットフォーム Bot 管理
- [ゲームコンパニオンモード](beilu:wiki/modes/game.md) - デスクトップペットと Live2D
- [サブモードと切り替え](beilu:wiki/modes/submodes.md) - サブモード詳細
