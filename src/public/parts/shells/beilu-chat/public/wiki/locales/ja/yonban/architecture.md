# 実行リンク

AI の出力から IDE での実際の実行までの完全なデータフローです。このリンクを理解することで、ツール呼び出しが失敗した場合の原因調査に役立ちます。

## メインリンク：10 ステップの実行フロー

<div class="wiki-flow">
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">1. AI 出力</div>
    AI が応答内で &lt;ideToolCall&gt; タグを生成し、ツール名とパラメータを含めます
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">2. ReplyHandler による解析</div>
    メッセージパイプラインの ReplyHandler が応答をインターセプトし、ideToolCall タグを解析します
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">3. 読み書き分岐</div>
    ツールタイプを判定します：読み取り操作はそのまま通過、書き込み操作はセキュリティチェックに進みます
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-red">
    <div class="wiki-label">4. セキュリティチェック</div>
    5 段階のセキュリティゲートが順次検証します：コマンドゲート → ルールセット → 承認ゲート → 統一実行ゲート → フィンガープリント紐付け
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-amber">
    <div class="wiki-label">5. 承認キュー</div>
    承認が必要な操作はキューに入り、フロントエンドに承認カードがポップアップしてユーザーの承認または拒否を待ちます
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">6. callTool ディスパッチ</div>
    承認通過後、callTool がリクエストを WS メッセージにカプセル化して YonBan 拡張に送信します
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">7. WebSocket 転送</div>
    リクエストは WS 長期接続を通じてローカル IDE で動作している YonBan 拡張に届きます
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-green">
    <div class="wiki-label">8. ToolExecutor による実行</div>
    YonBan 拡張の ToolExecutor がローカル IDE 環境で実際の操作を実行します
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-blue">
    <div class="wiki-label">9. 結果の返送</div>
    実行結果が WS を通じて always-accompany バックエンドに返送され、キューに入って処理を待ちます
  </div>
  <div class="wiki-arrow">↓</div>
  <div class="wiki-box wiki-box-purple">
    <div class="wiki-label">10. 次の会話ラウンドに注入</div>
    ツールの実行結果が次の AI 会話ラウンドのコンテキストに注入され、AI はそれに基づいて後続の操作を決定します
  </div>
</div>

## 4 つの呼び出しパス

ツール呼び出しは AI が自発的に発起する1つのパスだけではなく、合計 4 つの入口があります：

| パス | トリガー方式 | 説明 |
|------|---------|------|
| AI 自発呼び出し | AI の応答に `<ideToolCall>` が含まれる | メインリンク。ReplyHandler が解析した後、完全なセキュリティゲートを通過します |
| フロントエンド手動呼び出し | ユーザーが接続パネル下部から手動で送信 | ツール選択 + パラメータ入力 + 送信で、AI 環節をスキップして直接 callTool に進みます |
| 分身呼び出し | サブモード/分身 AI が発起 | メインリンクと同じですが、異なる権限レベルが紐付けられる場合があります |
| dispatch ディスパッチ | システム内部で自動トリガー | 自動スナップショット（_checkpoint_start）、診断プッシュなど。内部ツールは承認を経ません |

## WebSocket メッセージタイプ

always-accompany バックエンドと YonBan 拡張間の WS 通信は以下のメッセージタイプを使用します：

| メッセージタイプ | 方向 | 説明 |
|---------|------|------|
| tool_call | バックエンド → 拡張 | ツール呼び出しリクエスト。ツール名とパラメータを含みます |
| tool_result | 拡張 → バックエンド | ツール実行結果。戻り値またはエラー情報を含みます |
| hello | 拡張 → バックエンド | 接続ハンドシェイク。エディタのタイプ/バージョンを報告します |
| status | 拡張 → バックエンド | 拡張ステータス報告（開いているファイル/アクティブエディタ/診断情報） |
| console | 拡張 → バックエンド | IDE ターミナル/コンソール出力の転送 |
| ping / pong | 双方向 | ハートビートキープアライブ。接続の存続を検出します |

## 障害の特定

ツール呼び出しが失敗した場合、リンクに沿って段階的に調査します：

| 症状 | 考えられる断点 |
|------|-----------|
| AI がツールを呼び出さない | ステップ 1 — プリセット/プロンプトで IDE ツールが有効になっていない |
| 呼び出しが拒否された | ステップ 4-5 — 権限レベルが不足、またはユーザーに拒否された |
| 呼び出しがタイムアウトして無応答 | ステップ 7 — WS 接続が切断。接続パネルのステータスランプを確認してください |
| 実行時にエラーが報告される | ステップ 8 — ローカル環境の問題（ファイルが存在しない/権限不足） |
| AI が結果を受け取っていない | ステップ 9-10 — 結果の返送または注入に異常がある |

## ナビゲーション

- [YonBan 概要](overview.md) — インストールと接続
- [ツール一覧](tools.md) — 30 以上のツールの速査
- [承認と権限](approval.md) — 5 段階セキュリティゲートの詳解
- [メッセージパイプライン](beilu:wiki/developer/message-pipeline.md) — ReplyHandler のパイプライン内での位置
