# 快速開始

## 第一步：新增 AI 服務源

[設定 → AI服務源](beilu:settings/api) → 新增：

| 項目 | 填什麼 |
|------|--------|
| 名稱 | 隨便取，用來區分不同源 |
| 服務位址 | API 位址（如 `https://api.openai.com/v1/chat/completions`） |
| API Key | 服務商提供的金鑰 |
| 頻道 | 選對應的服務商（OpenAI / Claude / Gemini 等） |
| 模型 | 選一個可用模型 |

儲存後，在左欄的模型選擇器裡確認已選中這個源。詳見 [設定 AI 服務源](install.md)。

## 第二步：選角色開始對話

左側欄點一個角色卡，底部輸入框發訊息，AI 就會回覆。

沒有角色？點角色列表上方的「+」建立一個，填個名字就行。

## 第三步：按需求切模式

頂部四個按鈕切換模式：

| 模式 | 快捷鍵 | 用途 |
|------|--------|---------|
| 全智能 | Ctrl+1 | 任務看板 + 審批 |
| AIRP | Ctrl+2 | 角色對話（預設） |
| IDE | Ctrl+3 | AI 寫程式碼 + 檔案操作 |
| 工作 | Ctrl+4 | 工作流程 + 定時任務 |

詳見 [模式系統](beilu:wiki/modes/overview.md)。

## 接下來

- 調 AI 回覆風格 → 換預設集，詳見 [預設集與參數](first-chat.md)
- 讓 AI 記東西 → [記憶系統](beilu:wiki/memory/overview.md)自動運作，也可手動管理
- 加世界觀設定 → [編輯介面 Tab2](beilu:editor/worldbook) 寫世界書
- 調參數 → 左欄模型參數面板（temperature / top_p 等）
- 用巨集 → [巨集系統](beilu:wiki/macros/overview.md)在預設集裡插入動態內容
