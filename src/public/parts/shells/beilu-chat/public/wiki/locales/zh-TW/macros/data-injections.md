# 資料注入條目與資料巨集（*-data）

動態內容（每輪或頻繁變化的資料）統一透過**尾部資料注入條目**進入對話——它們是 `injection_prompts` 裡 id 以 `-data` 結尾的條目，`depth: 0`（注入在聊天記錄下方）。範本文字在 INJ 面板可編輯，程式碼只負責提供資料巨集的值。

## 為什麼動態內容必須在尾部

提示詞快取按前綴比對：頭部（system 區）任何一個字元變化，整個快取前綴作廢，每輪重新計費／重新處理數萬 token。因此：

- **固定內容**（身份、規則、能力說明）→ 頭部（`depth >= 1`），穩定不變，可被快取
- **動態內容**（狀態、檢索結果、任務資料、每輪變化的巨集）→ 尾部（`depth: 0` 的 `*-data` 條目），在快取斷點之後，變化不破壞快取
- 快取斷點由代理層自動放在 `*-data` 條目之前（`-data` 後綴是易變區偵測的識別標記之一）

## 鐵律與攔截機制

**提示詞文字只允許存在於 INJ 條目和預設集中，程式碼裡禁止硬編碼提示詞。** 唯一豁免：AI 發出指令後的系統回執（工具執行結果等），它們天然出現在對話尾部。

機制強制（不靠自覺）：

- `getPromptHandler` 返回前做**白名單校驗**：注入條目的 id 必須在 `injection_prompts` 中登錄，未登錄的注入直接攔截刪除，並在診斷系統留下可見警告（`dataInj:hardcodeBlocked`）
- 新增注入必須先在設定登錄條目（範本前端可改），程式碼經統一入口 `_pushDataInj` 只提供資料巨集值
- 條目缺失（副本未播種／被刪）會產生可見警告 `dataInj:entryMissing`，前端「恢復預設」可找回

## 資料注入條目清單

以下條目由資料生產點按需注入（無資料時整條不注入）；範本中的巨集為**條目局部資料巨集**，僅在對應條目範本內有效：

| 條目 id | 內容 | 資料巨集 | 觸發條件 |
|---------|------|---------|---------|
| `INJ-p1-act-data` | P1 自驅動召回記憶資料 | `{{p1_act}}` | P1 管線有召回結果 |
| `INJ-p1-recall-usage` | P1 召回記憶用法說明 | _(靜態文字)_ | 與 INJ-p1-act-data 聯動 |
| `INJ-p1-retrieval-data` | 記憶 AI 檢索結果 | `{{p1_retrieval}}` `{{p1_retrieval_ts}}` | P1 檢索有結果 |
| `INJ-p8-web-search-data` | 聯網搜尋結果 | `{{p8_results}}` | P8 搜尋有結果 |
| `INJ-chat-search-data` | 上輪聊天 AI 搜尋結果 | `{{chat_search_results}}` `{{chat_search_ts}}` | 有待注入搜尋結果 |
| `INJ-table-edit-feedback-data` | 上輪 tableEdit 失敗明細 | `{{table_edit_failures}}` `{{table_edit_ts}}` | 有失敗回饋 |
| `INJ-scheduler-due-data` | 到期定時任務提醒 | `{{scheduler_due}}` | 有到期任務 |
| `INJ-delegate-task-data` | 活躍委派任務 | `{{delegate_seq}}` `{{delegate_from}}` `{{delegate_priority}}` `{{delegate_source_channel}}` `{{delegate_user_message}}` `{{delegate_task}}` `{{delegate_chat_context}}` `{{delegate_report_instruction}}` | 有活躍委派 |
| `INJ-delegate-report-data` | 委派完成報告 | `{{delegate_report_to}}` `{{delegate_report_status}}` `{{delegate_report_task}}` `{{delegate_report_body}}` | 有未注入報告 |
| `INJ-parallel-delegate-data` | 並行委派結果 | `{{parallel_count}}` `{{parallel_results}}` | 有並行結果 |
| `INJ-approval-results-data` | 審批結果回饋 | `{{approval_results}}` | 有審批決定 |
| `INJ-async-ai-data` | 後台 AI 結果 | `{{async_ai_results}}` | 有非同步結果 |
| `INJ-flow-group-data` | 流程組執行狀態 | `{{flow_group_name}}` `{{flow_group_progress}}` `{{flow_group_steps}}` `{{flow_group_current}}` `{{flow_group_auto_advance}}` | 流程組運行中 |

範本裡可選欄位的「標籤: 」行在資料為空時會整行自動剔除（機制行為，範本可放心寫全欄位）。

## 動態巨集歸尾條目（從頭部拆出）

以下條目承載原本混在頭部說明塊裡的動態巨集（全域巨集，見各巨集文件頁）：

| 條目 id | 內容 | 巨集 | 原位置 |
|---------|------|-----|--------|
| `INJ-browser-status-data` | 瀏覽器連線狀態行 | `{{browser_status}}` `{{browser_port}}` | 原 INJ-browser（頭部）尾行 |
| `INJ-work-submodes-data` | work 組子模式即時清單 | `{{work_sub_modes_list}}` | 原 INJ-1-work（頭部） |
| `INJ-code-submodes-data` | code 組子模式即時清單 | `{{code_sub_modes_list}}` | 原 INJ-2-code（頭部） |

對應的頭部條目改為指向說明（「即時清單見尾部注入塊」），保持頭部逐輪穩定。

## 編輯與恢復

- 所有 `*-data` 條目在 **INJ 注入面板**可編輯（content 範本 / depth / order / 開關）
- 改壞了用「恢復預設」找回出廠範本
- 關閉條目（`enabled=false`）= 對應資料不再注入（資料生產邏輯照常運行，只是不進對話）
