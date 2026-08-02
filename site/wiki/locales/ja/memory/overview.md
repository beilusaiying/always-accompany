# 記憶システム

AI が会話中の重要な内容を自動的に記憶します——キャラクターの性格、ユーザーの好み、発生したイベントなど、会話をまたいでも失われません。

## あなたが行うこと

**通常は何もする必要がありません。** 記憶システムは完全自動で動作します：AI が自ら書き込み、自ら呼び出し、自らアーカイブします。

手動で管理したい場合は、[記憶管理](beilu:mode/memory)に入ると、すべての記憶エントリの閲覧、編集、削除が可能です。

## 自動動作フロー

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>ユーザーがメッセージを送信</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>ホットレイヤーから常駐記憶を取得</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>リコールエンジンが warm 層をスキャン</b><small>関連エントリをマッチング</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>コンテキストに組み込んで AI に送信</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>AI の返信に &lt;tableEdit&gt; が含まれる</b><small>記憶テーブルに書き戻し</small></div>
</div>

## 三層記憶アーキテクチャ

記憶は「温度」によって層分けされ、温度が高い層ほど AI に近くなります：

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot ホットレイヤー</span>
アクティブな記憶、毎ターンのコンテキストに自動インジェクション <span class="wiki-badge">自動</span>
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm ウォーム層</span>
近期の記憶、必要に応じてリコール（キーワードマッチ時に取り込み） <span class="wiki-badge wiki-badge-blue">リコールエンジンがトリガー</span>
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold コールド層</span>
アーカイブ記憶、長期保存、検索で到達可能 <span class="wiki-badge wiki-badge-green">手動検索</span>
</div>
</div>

## 記憶テーブル

記憶は**構造化テーブル**に格納されます。chat モードでは #0 から #9 まで 10 枚のテーブルがあり、それぞれ異なる種類の情報（時空、キャラクター特徴、ユーザーに関する情報など）に対応しています。AI は `<tableEdit>` タグでテーブルの CRUD 操作を行います。

詳しくは[記憶テーブル(#0-#9)](tables.md)をご覧ください。[記憶管理](beilu:mode/memory)で閲覧・管理することもできます。

## 記憶のライフサイクル

<div class="wiki-flow">
<div class="wiki-box wiki-box-green"><b>新しい情報が発生</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>AI がホットレイヤーのテーブルに書き込み</b><small>&lt;tableEdit&gt; タグ</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>ホットレイヤーの記憶は毎ターン自動的にコンテキストにインジェクション</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">時間の経過とともに</div>
<div class="wiki-box wiki-box-blue"><b>warm 層に自動移行</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-label">さらに時間が経過</div>
<div class="wiki-box wiki-box-purple"><b>cold 層にアーカイブ</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>リコールエンジンが warm/cold 層から検索して呼び戻す</b><small>必要時</small></div>
</div>

## 記憶管理画面

[記憶管理](beilu:mode/memory)では、上部ツールバーに 7 つのショートカットボタンがあります：

| ボタン | 名称 | 機能 |
|------|------|------|
| table | テーブル | [データテーブルエディタ](tables.md)を開き、#0-#9 テーブルの内容を直接編集します |
| diag | P1 診断 | P1 リコールエンジンの動作状態とキャッシュを確認します |
| snapshot | スナップショット | [記憶スナップショットと Git スナップショット](archival.md)を管理し、作成・復元できます |
| retrieval | 検索設定 | P1 自動トリガー、引用件数、検索ラウンド数、タイムアウトなどのパラメータを調整します |
| format | フォーマットチェック | 記憶ファイルをスキャンし、フォーマットの適合/警告/エラーを集計、ワンクリックアップグレードに対応します |
| pseries | P シリーズエンジン | [P1-P8 各プリセット](presets.md)のプロンプト、AI ソース、モデルなどのパラメータを編集します |
| skills | マニュアルライブラリ | 各モードのマニュアル（トリガー条件、本文など）を管理します |

### インラインセッティングバー（T040a）

管理パネルには常駐のセッティング chip バーがあり、よく使うパラメータを素早く調整できます：

- P1 自動トリガー toggle — P1 の毎ターン自動リコールのオン/オフ
- 引用件数 number — リコール時にインジェクションするエントリ数の制御
- 検索ラウンド数 number — P1 マルチラウンド検索の最大回数
- 「詳細設定」ボタン — 完全な検索設定パネルを展開

### 三層メインエリア

- **記憶コンテンツ**（content）— サブ Tab：ファイルツリー / テーブル。記憶ファイルとテーブルデータの閲覧と編集
- **検索/診断**（diagretr）— サブ Tab：診断 / 検索。P1 の動作状態確認と検索パラメータの調整
- **記憶メンテナンス**（ops）— サブ Tab：スナップショット / フォーマット / インポート・エクスポート。バックアップ・復元とフォーマットメンテナンス

### 記憶ファイルブラウザ

ファイルツリーは hot / warm / cold / code / work の 5 層ディレクトリ構造を表示します：

- `_` で始まるファイルや `.bak` ファイルはデフォルトで非表示、各層に専用アイコンマッピングがあります
- 各ファイルにサイズと相対時間が表示されます
- ファイルをクリックすると右カラムで JSON エディタが開き、直接編集・保存できます

**アーカイブツールバー**では一括操作が可能です：一時記憶のアーカイブ / 当日終了 / Hot → Warm / Warm → Cold / 完了タスクのアーカイブ。

**code 層専用ツール**：正規表現検索、新規フォルダ作成、zip のインポート/エクスポート。

## 詳細情報

### 記憶 AI プリセット

記憶システムの裏側では 8 つの専用 AI プリセットが連携して動作しています：

- **P1**：検索 AI——NLP 分かち書き、連想拡張、4 次元スコアリングにより warm/cold 層から記憶をリコール
- **P2**：テーブル要約/アーカイブ——一時記憶が閾値を超えた時に要約を生成し warm 層にアーカイブ
- **P3**：デイリーサマリー——1 日の終わりにその日のイベントを集約
- **P4**：ホット→ウォーム移行——期限切れ/低ウェイトの記憶を warm 層に移動
- **P5**：月次サマリー/アーカイブ——warm 層の月別データの月次サマリーを編纂
- **P6**：フォーマットチェック/修正——テーブルと記憶ファイルのフォーマットをメンテナンス
- **P7**：コンテキスト圧縮 AI——コンテキストが長すぎる場合に要約を生成
- **P8**：ウェブ検索——外部情報が必要な場合に呼び出し

詳しくは[記憶 AI プリセット(P1-P8)](presets.md)をご覧ください。

### ワールドブックとの関係

記憶システムが管理するのは**動的に発生する情報**（会話中に起きたこと、AI が学んだこと）です。ワールドブックが管理するのは**プリセットされた背景知識**（世界観設定、キャラクター資料、ルール）です。どちらもインジェクションシステム（INJ）を通じてコンテキストに送られますが、情報源と管理方法が異なります。

## ナビゲーション

- [記憶テーブル(#0-#9)](tables.md) — テーブル構造と各テーブルの役割
- [ホットレイヤー記憶](hot-layer.md) — ホットレイヤーのファイルと自動インジェクション機構
- [記憶 AI プリセット(P1-P8)](presets.md) — 各プリセットの分担と動作チェーン
- [コンテキスト圧縮](compression.md) — P7 圧縮メカニズム
- [記憶アーカイブと検索](archival.md) — warm/cold 層の移行とリコールエンジン
- [ワールドブック概要](worldbook-overview.md) — プリセット背景知識システム（[ワールドブック編集](beilu:editor/worldbook)）
- [インジェクションシステム概要](inj-overview.md) — 情報がどのようにコンテキストに入るか
