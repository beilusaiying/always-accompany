# 記憶テーブル(#0-#9)

記憶テーブルは always-accompany 記憶システムのコアストレージ構造です。AI は `<tableEdit>` タグを使ってテーブルの CRUD（作成・読取・更新・削除）操作を行います。各テーブルは特定の種類の情報に対応しています。ワークモード（[チャットモード](beilu:mode/chat) / code / [ワークモード](beilu:mode/work)）によって異なるテーブルセットを使用します。

## chat モードのテーブル

chat モードでは #0 から #9 まで 10 枚のテーブルを使用します：

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card"><div class="wiki-card-title">#0 時空</div><div class="wiki-card-desc">現在の時間、場所、シーン — AI が「今どこにいるか、何時か」を認識</div></div>
<div class="wiki-card"><div class="wiki-card-title">#1 キャラクター特徴</div><div class="wiki-card-desc">キャラクターの性格、外見、習慣など — AI がキャラクターの一貫性を保持</div></div>
<div class="wiki-card"><div class="wiki-card-title">#2 ソーシャル</div><div class="wiki-card-desc">人間関係、好感度、インタラクション履歴 — AI がキャラクター間の関係を理解</div></div>
<div class="wiki-card"><div class="wiki-card-title">#3 タスク</div><div class="wiki-card-desc">進行中のタスク、目標 — AI がタスクの進捗を追跡</div></div>
<div class="wiki-card"><div class="wiki-card-title">#4 一時記憶</div><div class="wiki-card-desc">短期イベント、一時的な状態 — 今回の会話中の一時情報</div></div>
<div class="wiki-card"><div class="wiki-card-title">#5 アイテム</div><div class="wiki-card-desc">所持アイテム、道具 — アイテム管理</div></div>
<div class="wiki-card"><div class="wiki-card-title">#6 デイリーサマリー</div><div class="wiki-card-desc">毎日の要約情報 — 過去に何が起きたかを振り返り</div></div>
<div class="wiki-card"><div class="wiki-card-title">#7 ユーザーについて</div><div class="wiki-card-desc">ユーザーの好み、習慣、個人情報 — AI がユーザーを理解</div></div>
<div class="wiki-card"><div class="wiki-card-title">#8 永遠に覚えて</div><div class="wiki-card-desc">重要で忘れてはならない情報 — コア設定、重要な約束</div></div>
<div class="wiki-card"><div class="wiki-card-title">#9 時空記憶</div><div class="wiki-card-desc">時空に関連する長期記憶 — 場所に紐づいた思い出</div></div>
</div>

## code モードのテーブル

code モードでは C0 から C5 まで 6 枚のテーブルを使用し、プログラミング支援シーンに対応します：

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">C0</div><div class="wiki-card-desc">プロジェクトコンテキスト</div></div>
<div class="wiki-card"><div class="wiki-card-title">C1</div><div class="wiki-card-desc">コーディング規約・規範</div></div>
<div class="wiki-card"><div class="wiki-card-title">C2</div><div class="wiki-card-desc">現在のタスク</div></div>
<div class="wiki-card"><div class="wiki-card-title">C3</div><div class="wiki-card-desc">技術スタック・依存関係</div></div>
<div class="wiki-card"><div class="wiki-card-title">C4</div><div class="wiki-card-desc">問題と解決策</div></div>
<div class="wiki-card"><div class="wiki-card-title">C5</div><div class="wiki-card-desc">一時メモ</div></div>
</div>

## work モードのテーブル

work モードでは W0 から W4 まで 5 枚のテーブルを使用し、ワークフローシーンに対応します：

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">W0</div><div class="wiki-card-desc">ワークコンテキスト</div></div>
<div class="wiki-card"><div class="wiki-card-title">W1</div><div class="wiki-card-desc">タスクと進捗</div></div>
<div class="wiki-card"><div class="wiki-card-title">W2</div><div class="wiki-card-desc">連絡先・コラボレーション</div></div>
<div class="wiki-card"><div class="wiki-card-title">W3</div><div class="wiki-card-desc">意思決定記録</div></div>
<div class="wiki-card"><div class="wiki-card-title">W4</div><div class="wiki-card-desc">一時メモ</div></div>
</div>

## AI のテーブル操作方法

AI は返信の中で `<tableEdit>` タグを使用してテーブル操作を行います。システムがそのタグを解析し、対応する CRUD アクションを実行します：

- **Create**：新しい行を追加
- **Read**：テーブル内容を照会（通常はリコールエンジンにより自動実行）
- **Update**：既存の行を変更
- **Delete**：古くなった行を削除

タグ内部は関数呼び出し形式の構文を使用します（これはシステムが AI にインジェクションする操作フォーマットでもあります）：

```
<tableEdit>
<!--
insertRow(表格编号, {列编号: "值", ...})
updateRow(表格编号, 行编号, {列编号: "新值", ...})
deleteRow(表格编号, 行编号)
-->
</tableEdit>
```

操作は記憶システムの INJ 指示によって導かれます——INJ-1 が、現在のモードで使用可能なテーブル、各テーブルの格納内容、書き込みフォーマットを AI に伝えます。

## 動作チェーン

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>AI が返信を生成</b><small>返信に &lt;tableEdit&gt; タグが含まれる</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>バックエンドの記憶システムが &lt;tableEdit&gt; タグを解析</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>テーブル番号に基づいて対応するテーブルファイルを特定</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>CRUD 操作を実行しホットレイヤーに書き込み</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>次のターンの会話時</b><small>ホットレイヤーのテーブル内容が自動的にコンテキストにインジェクション</small></div>
</div>

## テーブルと三層アーキテクチャの関係

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot ホットレイヤー</span>
現在アクティブなテーブル内容、毎ターンインジェクション
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm ウォーム層</span>
近期だがアクティブでなくなったテーブルエントリ、オンデマンドでリコール
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold コールド層</span>
アーカイブ済みの過去のエントリ、検索で到達可能
</div>
</div>

テーブルエントリは時間とともに hot から warm、さらに cold へ自動的に移行します。移行は記憶システムのアーカイブパイプラインにより自動実行されます。

## データテーブルエディタ

[記憶管理](beilu:mode/memory)のツールバーで **table** ボタンをクリックするか、記憶コンテンツエリアで「テーブル」サブ Tab に切り替えると、データテーブルエディタを開けます。

### テーブル切替

上部に #0 から #9（または C0-C5 / W0-W4、現在の viewMode に応じて）の Tab ページが表示され、クリックで異なるテーブルに切り替えられます。各テーブルの名称はクリックで直接編集可能です。

### セル編集

任意のセルをクリックするとインプレース編集状態になり、変更後は自動保存されます。列ヘッダーもクリックで編集でき、列名の調整に使用します。

### ルールエリア

テーブル下部のルールエリアでは、そのテーブルの書き込みルールとフォーマット制約を定義します。各テーブルで独立に設定でき、AI が書き込む際にこれらのルールを参照します。

### 行操作

- **行の追加**：テーブルの末尾に新しい行を追加
- **行の削除**：複数選択での一括削除をサポート
- **有効/無効 toggle**：テーブルエントリがインジェクションに参加するかどうかを制御

### 検索

テーブルには検索機能が内蔵されており、キーワードで現在のテーブル内のマッチする行をフィルタリングできます。

### 楽観的並行制御

テーブル編集はバージョン番号メカニズムを採用しています：保存のたびにバージョン番号をチェックし、他のソース（AI の `<tableEdit>` など）がテーブルを変更してバージョンが一致しない場合、システムが競合を通知し、上書きによるデータ損失を防ぎます。

### スナップショット

テーブルエディタ内で現在のテーブルのスナップショットを作成でき、調整前のバックアップに便利です。詳しくは[記憶アーカイブと検索](archival.md)のスナップショット管理セクションをご覧ください。

## 注意事項

- 各モードのテーブルは互いに独立しており、モード切替時に対応するテーブルセットがロードされます
- テーブル番号は固定であり、各番号に対応する役割は INJ-1 指示で定義されています
- AI がテーブルに書き込むフォーマットはシステムの解析要件に準拠する必要があります。準拠しない場合、書き込みは無視されます
