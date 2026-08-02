# 檔案操作 (beilu-files)

beilu-files 讓 AI 能夠在你的電腦上讀寫檔案和執行命令。它是 [IDE模式](beilu:mode/files) 和 [工作模式](beilu:mode/work) 的核心工具外掛——AI 透過它瀏覽目錄、讀取程式碼、寫入檔案、執行終端命令。

所有檔案操作都在沙箱內執行，受多層安全機制保護。

## 支援的操作

| 操作類型 | 說明 | AI 標籤 |
|---------|------|--------|
| read | 讀取檔案內容 | `<file_op>` / `<tool_call>` |
| write | 寫入/覆蓋檔案 | `<file_op>` / `<tool_call>` |
| create | 建立新檔案 | `<file_op>` / `<tool_call>` |
| delete | 刪除檔案 | `<file_op>` / `<tool_call>` |
| list | 列出目錄內容 | `<file_op>` / `<tool_call>` |
| move | 移動/重新命名檔案 | `<file_op>` / `<tool_call>` |
| exec | 執行終端命令 | `<file_op>` / `<tool_call>` |

## 安全架構

beilu-files 採用四層縱深防禦，每個檔案操作（無論來源）都必須通過：

### 第一層：路徑規範化（resolveCanonicalOpPath）

將相對路徑錨定到工作區根目錄，消化 `..`（父目錄參照），防止透過路徑拼接逃出沙箱。

### 第二層：系統路徑阻斷（checkSystemDriveBlock）

阻斷對系統敏感路徑、敏感副檔名和關鍵詞的存取。

### 第三層：工作區沙箱

所有操作必須在工作區根目錄（workspaceRoot）內執行。超出工作區邊界的路徑一律拒絕。

### 第四層：白名單/黑名單

精細化的路徑允許/禁止清單。使用前綴 + 邊界分隔符比較（防止 `/a/b` 誤攔 `/a/bc`）。

### 三條路徑共用

無論操作來自哪個入口，都必須通過同一個安全閘：

- **AI 路徑**：AI 回覆中的 `<file_op>` / `<tool_call>` 標籤
- **前端路徑**：使用者透過 UI 直接操作檔案
- **審批路徑**：使用者審批通過待處理的操作

## 操作流程

### AI 發起的操作

```
AI 回覆包含檔案操作標籤
    ↓
ReplyHandler 解析操作
    ↓
Bot 權限閘（N42，檢查 Bot 來源的存取檔位）
    ↓
always 規則檢查（N46）
    ↓
權限開關檢查
    ↓
validateOpSecurity（四層縱深安全校驗）
    ↓
自動審批 / 進入待審批佇列
    ↓
executeFileOperation（磁碟操作）
    ↓
結果進入 pendingOpResults 佇列
    ↓
下一輪 GetPrompt 注入結果，AI 看到執行結果繼續工作
```

### 審批機制

某些操作（如寫入、刪除、執行命令）預設需要使用者審批：

- **自動審批**：讀取操作通常自動通過
- **待審批佇列**：寫入/刪除/執行進入佇列，等待使用者在前端確認
- **批次審批**：可以一鍵核准所有待處理操作

## 命令執行（exec）

exec 類型操作允許 AI 執行終端命令。由於安全風險較高，它受到額外的門控保護：

- **deployGatedAllow 門控**：本機部署（local 模式）預設放行；伺服器部署（server 模式）預設關閉，需要實例 owner 在安全中心顯式開啟
- 可透過設定面板控制 `allowExec` 開關
- 可透過環境變數 `BEILU_FILE_EXEC=on` 強制開啟

## 檔案歷史

beilu-files 會記錄檔案操作歷史，支援回溯到之前的版本。寫入操作前自動儲存舊版本，出問題可以恢復。

## GitHub 整合

beilu-files 包含 GitHub 整合模組，支援透過 GitHub API 進行儲存庫操作。

## 工作區設定

### workspaceRoot

工作區根目錄是 beilu-files 的沙箱邊界。所有檔案操作必須在此目錄內。可以在外掛設定中設定。

### workspaceRoots

多工作區支援。可以設定多個工作區根目錄，AI 可以在這些目錄間切換。

## 多使用者隔離

在多使用者情境下，beilu-files 使用 AsyncLocalStorage 實現 per-user 隔離。工作區設定等欄位按使用者獨立儲存，不同使用者互不影響。

## 導覽

- [外掛概覽](overview.md) — 外掛系統簡介
- [安全中心](../security/overview.md)（[開啟面板](beilu:settings/security)） — 安全策略總覽
- [權限與鑑權](../security/auth.md) — 權限分級
