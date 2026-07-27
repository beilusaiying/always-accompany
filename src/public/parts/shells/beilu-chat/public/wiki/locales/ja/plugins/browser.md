# ブラウザ自動化 (beilu-browser)

beilu-browser は、AI が実際の Chrome ブラウザを操作できるようにするプラグインです。AI は `<browser_op>` タグでブラウザ操作を発行し、プラグインがタグを解析・実行して、結果を次のラウンドの会話にインジェクションします。

> 沿革：初期バージョンには「フロントエンドからブラウザページのスナップショットをメッセージにインジェクションする」別チャネルがありましたが、2026-07-16 に削除されました。現在のブラウザ自動化は、本ページで説明する会話内 `<browser_op>` タグプロトコルに統一されています。プラグイン本体は継続的にメンテナンスされており、旧チャネルとともに削除されたわけではありません。

## 動作の仕組み

```
AI の返信に <browser_op> タグが含まれる
    ↓
ReplyHandler がタグを解析
    ↓
browser-driver が操作を実行（CDP WebSocket → Chrome）
    ↓
結果をインジェクション待ちキューに保存（会話ごとに隔離）
    ↓
次のラウンドの GetPrompt が結果を会話にインジェクション
    ↓
AI が結果を確認し、次の操作を決定
```

## 前提条件

Chrome をリモートデバッグモードで起動する必要があります。最も簡単な方法：「追加プラグイン → ブラウザ自動化」パネルで **Chrome を起動** ボタンをクリックします（Chrome のパスを自動検出し、正しい引数で起動します）。

手動起動の等価コマンド：

```
chrome --remote-debugging-port=9222 --user-data-dir=data/browser-profile
```

- `--remote-debugging-port`：ポート番号はプラグイン設定で変更できます
- `--user-data-dir`：独立したユーザーデータディレクトリ（デフォルトは beilu データディレクトリ配下、パネルで設定可能）。ログイン状態を共有します

## 操作タグ

### ナビゲーション

| タグ | 説明 |
|------|------|
| `<browser_op type="goto" url="https://..." />` | 指定した URL を開く |
| `<browser_op type="tabs" />` | すべてのタブを一覧表示 |
| `<browser_op type="newtab" url="https://..." />` | 新しいタブを開く |
| `<browser_op type="closetab" />` | 現在のタブを閉じる |
| `<browser_op type="sync" />` | あなたが閲覧中のタブに同期（人間と AI が同じブラウザを共有し、AI があなたのいるページから操作を引き継ぎます） |

### ページの確認

| タグ | 説明 |
|------|------|
| `<browser_op type="snapshot" />` | ページのアクセシビリティツリー（accessibility tree）を取得。各要素に @N 参照番号が付きます |
| `<browser_op type="screenshot" />` | ページのスクリーンショットを撮影し、PNG として保存 |

### インタラクション操作

snapshot が返す @N 参照番号で要素を特定します：

| タグ | 説明 |
|------|------|
| `<browser_op type="click" target="@3" />` | 要素をクリック |
| `<browser_op type="type" target="@3" value="入力するテキスト" />` | 入力欄にテキストを入力 |
| `<browser_op type="press" key="Enter" />` | キーボードのキーを押す |
| `<browser_op type="scroll" dy="300" />` | ページをスクロール（dy 正の値で下方向、負の値で上方向） |

### JavaScript 実行

```xml
<browser_op type="eval">document.title</browser_op>
```

### 待機

```xml
<browser_op type="wait" selector="css:.result" timeout="5000" />
```

### ブラウジング記録

```xml
<browser_op type="history" />
```

「ブラウジング記録」を有効にすると、ブラウザ操作ごとのページ URL・タイトル・結果サマリーがローカルファイル（デフォルト `data/browser-history.jsonl`）に記録されます。AI は `history` 操作で最近の記録を読み戻し、ラウンドをまたぐブラウジング記憶を実現します。記録スイッチと読み戻し件数はパネルで設定できます。

## 典型的なワークフロー

1. `goto` で対象ページに移動
2. `snapshot` でページ構造を確認し、要素の @N 参照番号を取得
3. `click` / `type` でページと対話
4. `snapshot` で再度確認し、操作の成功をチェック
5. タスク完了まで繰り返し

## マクロ

beilu-browser は macro_env を通じて以下のマクロを提供します。INJ エントリやプリセットで使用できます：

| マクロ | 説明 |
|----|------|
| `{{browser_status}}` | ブラウザ接続状態（connected / disconnected） |
| `{{browser_port}}` | CDP デバッグポート番号 |

## INJ エントリ

プラグインの初回ロード時に、AI のブラウザ操作能力の説明を含む `INJ-browser` エントリが自動作成されます。INJ エディタで内容・深度・モードゲーティングなどの設定を自由に変更できます。

- **デフォルト深度**: 1（system 領域）
- **デフォルトモード**: always（全モードで有効）
- **マクロサポート**: 内容に `{{browser_status}}`、`{{browser_port}}` などのマクロを使用できます

## 設定項目

すべての設定は「追加プラグイン → ブラウザ自動化」パネルで行えます：

| 設定 | デフォルト値 | 説明 |
|------|--------|------|
| enabled | true | プラグインのマスタースイッチ |
| port | 9222 | Chrome リモートデバッグポート |
| snapshotMaxLines | 200 | スナップショットの最大行数（超長ページによるコンテキスト溢れを防止） |
| chromePath | 空（自動検出） | Chrome 実行ファイルのパス |
| userDataDir | data/browser-profile | Chrome ユーザーデータディレクトリ（beilu データディレクトリからの相対パス） |
| driverPath | 空（内蔵ドライバ） | 空のままなら beilu に同梱の内蔵ドライバを使用。外部ドライバの file:// URL も指定可能 |
| defaultTimeout | 5000 | wait 操作のデフォルトタイムアウト（ms） |
| defaultScrollDy | 300 | scroll のデフォルトスクロール量（px） |
| gotoWaitUntil | load | ナビゲーション待機戦略（load / domcontentloaded / commit） |
| resultLabel / resultSeparator | — | 結果インジェクションのセクションタイトルと区切り文字 |
| autoReconnect | true | 操作失敗後の自動再接続 |
| recordBrowsing | true | ブラウジング記録スイッチ |
| historyFile | data/browser-history.jsonl | ブラウジング記録の保存先ファイル |
| historyMaxRead | 30 | history 操作のデフォルト読み戻し件数 |

## セキュリティ

- **イントラネット防護**：`goto` / `newtab` の URL は統一アウトバウンドセキュリティチェック（safe_fetch）を通過します。プライベートネットワーク・ループバック・クラウドメタデータアドレスは一律拒否——AI がブラウザを使ってイントラネットを探索することはできません。
- **コンテンツ境界**：ページタイトル・スナップショット・eval 結果などの外部コンテンツは、AI にインジェクションされる前に信頼できないコンテンツ境界処理（山括弧の中性化 + ランダム nonce 境界マーカー）を通過し、ウェブコンテンツによる AI への間接プロンプトインジェクションをブロックします。

## 技術アーキテクチャ

基盤ドライバはプラグインディレクトリに内蔵されており（`beilu-browser/driver/`、beilu 本体と一緒に配布、外部依存ゼロ）、Chrome DevTools Protocol (CDP) のネイティブ WebSocket でブラウザを直接制御します：

- Playwright/Puppeteer に依存せず、npm 依存ゼロ
- Playwright スタイルの Locator API（CSS / role / text / xpath）をサポート
- Input Probe フォールバック機構：CDP ネイティブイベントが失敗した場合、synthetic event で自動再送
- Session 自己修復：タブのクローズ/ナビゲーション後に自動で再アタッチし、preferredTarget が切り替えに追従
