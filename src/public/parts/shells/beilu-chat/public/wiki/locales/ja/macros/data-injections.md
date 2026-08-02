# データ注入エントリとデータマクロ（*-data）

動的コンテンツ（毎ターンまたは頻繁に変化するデータ）は、**末尾データ注入エントリ**を通じて会話に入ります——これらは `injection_prompts` 内で id が `-data` で終わるエントリであり、`depth: 0`（チャット履歴の下に注入）です。テンプレートテキストは INJ パネルで編集でき、コードはデータマクロの値を提供するだけです。

## 動的コンテンツが末尾でなければならない理由

プロンプトキャッシュはプレフィックスマッチングで動作します：頭部（system 領域）の1文字でも変化すると、キャッシュプレフィックス全体が無効化され、毎ターン数万 token が再課金・再処理されます。そのため：

- **固定コンテンツ**（身元、ルール、能力説明）→ 頭部（`depth >= 1`）、安定した不変コンテンツ、キャッシュ可能
- **動的コンテンツ**（状態、検索結果、タスクデータ、毎ターン変化するマクロ）→ 末尾（`depth: 0` の `*-data` エントリ）、キャッシュブレークポイントより後、変化してもキャッシュを壊さない
- キャッシュブレークポイントはプロキシ層が `*-data` エントリの前に自動配置します（`-data` サフィックスは揮発性ゾーン検出の識別マーカーの1つ）

## 鉄則と傍受機構

**プロンプトテキストは INJ エントリとプリセットにのみ存在でき、コードへのプロンプトハードコードは禁止です。** 唯一の例外：AI がコマンドを発行した後のシステム応答（ツール実行結果など）で、これらは自然に会話の末尾に現れます。

機構による強制（自律に頼らない）：

- `getPromptHandler` は返す前に**ホワイトリスト検証**を実行します：注入エントリの id は `injection_prompts` に登録されている必要があり、未登録の注入は傍受・削除され、診断システムに可視警告（`dataInj:hardcodeBlocked`）が残ります
- 新しい注入はまず設定でエントリを登録する必要があり（テンプレートはフロントエンドで編集可能）、コードは統一エントリポイント `_pushDataInj` を通じてデータマクロの値のみを提供します
- エントリが存在しない（レプリカが未シードまたは削除済み）場合、可視警告 `dataInj:entryMissing` が生成されます。フロントエンドの「デフォルトに戻す」で回復できます

## データ注入エントリ一覧

以下のエントリはデータ生産ポイントが必要に応じて注入します（データがない場合はエントリ全体を注入しない）；テンプレート内のマクロは**エントリローカルデータマクロ**であり、対応するエントリテンプレート内でのみ有効です：

| エントリ id | 内容 | データマクロ | トリガー条件 |
|------------|------|-------------|------------|
| `INJ-p1-act-data` | P1 自律駆動リコール記憶データ | `{{p1_act}}` | P1 パイプラインにリコール結果がある |
| `INJ-p1-recall-usage` | P1 リコール記憶使用ガイド | _(静的テキスト)_ | INJ-p1-act-data と連動 |
| `INJ-p1-retrieval-data` | メモリAI検索結果 | `{{p1_retrieval}}` `{{p1_retrieval_ts}}` | P1 検索に結果がある |
| `INJ-p8-web-search-data` | ウェブ検索結果 | `{{p8_results}}` | P8 検索に結果がある |
| `INJ-chat-search-data` | 前ターンのチャットAI検索結果 | `{{chat_search_results}}` `{{chat_search_ts}}` | 注入待ち検索結果がある |
| `INJ-table-edit-feedback-data` | 前ターンの tableEdit 失敗詳細 | `{{table_edit_failures}}` `{{table_edit_ts}}` | 失敗フィードバックがある |
| `INJ-scheduler-due-data` | 期限切れスケジュールタスクのリマインダー | `{{scheduler_due}}` | 期限切れタスクがある |
| `INJ-delegate-task-data` | アクティブな委任タスク | `{{delegate_seq}}` `{{delegate_from}}` `{{delegate_priority}}` `{{delegate_source_channel}}` `{{delegate_user_message}}` `{{delegate_task}}` `{{delegate_chat_context}}` `{{delegate_report_instruction}}` | アクティブな委任がある |
| `INJ-delegate-report-data` | 委任完了レポート | `{{delegate_report_to}}` `{{delegate_report_status}}` `{{delegate_report_task}}` `{{delegate_report_body}}` | 未注入レポートがある |
| `INJ-parallel-delegate-data` | 並列委任結果 | `{{parallel_count}}` `{{parallel_results}}` | 並列結果がある |
| `INJ-approval-results-data` | 承認結果フィードバック | `{{approval_results}}` | 承認決定がある |
| `INJ-async-ai-data` | バックグラウンド AI 結果 | `{{async_ai_results}}` | 非同期結果がある |
| `INJ-flow-group-data` | フロークループ実行ステータス | `{{flow_group_name}}` `{{flow_group_progress}}` `{{flow_group_steps}}` `{{flow_group_current}}` `{{flow_group_auto_advance}}` | フローグループが実行中 |

テンプレート内のオプションフィールドの「ラベル: 」行は、データが空の場合に自動的に行ごと除去されます（機構の動作；テンプレートには全フィールドを安心して記述できます）。

## 動的マクロの末尾エントリへの移動（頭部から分離）

以下のエントリは、もともと頭部説明ブロックに混在していた動的マクロを担います（グローバルマクロ——各マクロドキュメントページを参照）：

| エントリ id | 内容 | マクロ | 元の場所 |
|------------|------|--------|---------|
| `INJ-browser-status-data` | ブラウザ接続ステータス行 | `{{browser_status}}` `{{browser_port}}` | INJ-browser（頭部）の最終行 |
| `INJ-work-submodes-data` | work グループのサブモードリアルタイム一覧 | `{{work_sub_modes_list}}` | INJ-1-work（頭部） |
| `INJ-code-submodes-data` | code グループのサブモードリアルタイム一覧 | `{{code_sub_modes_list}}` | INJ-2-code（頭部） |

対応する頭部エントリは説明を指すように変更され（「リアルタイム一覧は末尾注入ブロックを参照」）、頭部が毎ターン安定するようになっています。

## 編集と復元

- すべての `*-data` エントリは **INJ 注入パネル**で編集できます（コンテンツテンプレート / depth / order / 有効/無効の切替）
- 壊してしまった場合は「デフォルトに戻す」で出荷時テンプレートに戻せます
- エントリの無効化（`enabled=false`）= 対応データはもう注入されません（データ生産ロジックは引き続き実行されますが、会話には入りません）
