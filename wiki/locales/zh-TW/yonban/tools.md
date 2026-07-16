# 工具列表

YonBan 提供 30+ 工具，AI 在對話中透過 `<ideToolCall>` 標籤呼叫。寫操作需經審核系統批准後才執行。

## 檔案操作（7）

| 工具 | 功能 | 關鍵參數 | 讀/寫 |
|------|------|---------|-------|
| read_file | 讀取檔案內容（支援分頁與 xlsx/docx/pptx/pdf 文件解析） | path, offset, limit | 讀 |
| write_file | 寫入/建立檔案 | path, content | 寫 |
| list_files | 列出目錄內容 | path, recursive | 讀 |
| replace_lines | 按行號範圍替換內容 | path, start_line, end_line, new_content | 寫 |
| insert_at_line | 在指定行號插入內容 | path, line, content | 寫 |
| fuzzy_edit | 模糊比對替換（容許縮排/空行差異） | path, old_string, new_string | 寫 |
| edit_xlsx | 讀寫 Excel 檔案 | path, sheet, operations | 寫 |

## 搜尋（4）

| 工具 | 功能 | 關鍵參數 | 讀/寫 |
|------|------|---------|-------|
| search_files | 正規表示式/文字搜尋檔案內容 | pattern, path, regex | 讀 |
| search_by_name | 按檔案名稱模式搜尋 | pattern, path | 讀 |
| smart_search | 語意搜尋（結合檔案名稱 + 內容 + 路徑） | query, path | 讀 |
| ast_search | AST 結構搜尋（函式/類別/變數定義） | pattern, language | 讀 |

## 命令執行（2）

| 工具 | 功能 | 關鍵參數 | 讀/寫 |
|------|------|---------|-------|
| run_command | 在 IDE 終端機執行命令 | command, cwd | 寫 |
| run_script | 執行腳本檔案 | path, args | 寫 |

## 診斷（5）

| 工具 | 功能 | 關鍵參數 | 讀/寫 |
|------|------|---------|-------|
| get_diagnostics | 取得 IDE 診斷資訊（錯誤/警告） | path | 讀 |
| get_status | 取得 IDE 狀態（開啟檔案/活動編輯器） | — | 讀 |
| get_project_summary | 取得專案結構摘要 | path | 讀 |
| validate_html | 校驗 HTML 檔案 | path | 讀 |
| lint_code | 程式碼 lint 檢查 | path, rules | 讀 |

## 導覽（2）

| 工具 | 功能 | 關鍵參數 | 讀/寫 |
|------|------|---------|-------|
| goto_definition | 跳轉到符號定義 | path, line, character | 讀 |
| find_references | 尋找符號的所有引用 | path, line, character | 讀 |

## TODO（2）

| 工具 | 功能 | 關鍵參數 | 讀/寫 |
|------|------|---------|-------|
| todo_read | 讀取 TODO 列表 | filter | 讀 |
| todo_write | 寫入/更新 TODO 項 | items | 寫 |

## Git（9）

| 工具 | 功能 | 關鍵參數 | 讀/寫 |
|------|------|---------|-------|
| git_status | 查看工作區狀態 | cwd | 讀 |
| git_diff | 查看變更差異 | staged, path, cwd | 讀 |
| git_log | 查看提交歷史 | maxCount, cwd | 讀 |
| git_add | 暫存檔案 | paths, path, cwd | 寫 |
| git_commit | 提交 | message, all, cwd | 寫 |
| git_branch | 建立/列出分支 | create, cwd | 寫 |
| git_checkout | 切換分支 | branch, cwd | 寫 |
| git_stash | 暫存工作區 | action, message, ref, cwd | 寫 |
| git_merge | 合併分支 | branch, noFf, cwd | 寫 |

git 全家族接受可選 `cwd`（儲存庫目錄，工作區內路徑）：儲存庫在工作區子目錄時指定，缺省在工作區根執行。

## 內部工具

以 `_` 前綴命名的工具供系統內部使用，不由 AI 直接呼叫：

| 工具 | 功能 |
|------|------|
| _checkpoint_start | 開啟一次快照交易 |
| _checkpoint_commit | 提交快照交易 |
| _checkpoint_revert | 回退到指定快照 |
| _checkpoint_revert_to_message | 回退到某條訊息對應的狀態 |
| _checkpoint_revert_diff | 按差異回退 |
| _checkpoint_list | 列出所有快照 |
| _checkpoint_can_replay | 查詢某快照是否可重播 |
| _checkpoint_get_ops | 取得快照的操作記錄 |
| _checkpoint_get_diff | 取得快照差異 |
| _get_operation_log | 讀取操作日誌 |
| _reveal | 在 IDE 中開啟/醒目提示指定檔案 |

快照工具支撐程式碼模式的操作時間線功能——AI 每次修改檔案前自動建立快照，使用者可透過時間線面板回退到任意歷史節點。

## 導覽

- [YonBan 概覽](overview.md) — 安裝與連接
- [審核與權限](approval.md) — 哪些工具需要審核
- [執行鏈路](architecture.md) — 工具呼叫的完整執行流程
