# 外掛開發與接入

always-accompany 的外掛系統允許你編寫自訂外掛來擴充功能。外掛透過標準化的介面參與[訊息管線](message-pipeline.md)，可以向 AI 注入提示詞、處理 AI 回覆、註冊自己的 HTTP 端點、提供設定面板。

本頁分兩部分：**怎麼做外掛**（結構、生命週期、介面）和**怎麼鏈接**（接入對話管線、接入前端、接入外部應用）。

## 一、怎麼做外掛

### 目錄結構

一個外掛的最小目錄結構：

```
plugins/my-plugin/
├── beilu-part.json    ← 部件清單（必需，發現機制只認它）
├── info.json          ← 本地化展示資訊（必需）
└── main.mjs           ← 外掛入口（必需）
```

### beilu-part.json（部件清單）

部件樹的發現機制**只掃描 `beilu-part.json`**。目錄裡有 `main.mjs` 但沒有此清單時，外掛不會進入部件列舉，且後端會輸出 `orphan_part_no_manifest` 警告。

```json
{
  "type": "plugins",
  "dirname": "my-plugin"
}
```

- `type`：部件類型路徑（外掛固定為 `plugins`）
- `dirname`：目錄名，必須與實際目錄一致

### info.json（展示資訊）

按語言鍵組織的本地化資訊，供外掛清單/詳情頁展示：

```json
{
  "zh-CN": {
    "name": "我的插件",
    "avatar": "https://api.iconify.design/mdi/puzzle.svg",
    "description": "一句话描述",
    "description_markdown": "**详细描述**，支持 Markdown。",
    "version": "0.1.0",
    "author": "你的名字",
    "tags": ["标签"]
  },
  "en-UK": { "name": "My Plugin", "description": "..." }
}
```

### main.mjs（入口）

匯出一個包含生命週期鉤子和 interfaces 的物件：

```javascript
export default {
  info,                // 通常 import info.json
  Init,                // 可選：安裝初始化（每用戶一次性）
  Load,                // 可選：每次執行時載入
  Unload,              // 可選：卸載（進程內移除）
  Uninstall,           // 可選：刪除外掛時清理
  interfaces: {
    chat: {
      GetPrompt,       // 注入提示詞
      TweakPrompt,     // 調整已組裝的 prompt_struct
      ReplyHandler,    // 處理 AI 回覆（可觸發重新生成）
    },
    config: {
      GetData,         // 讀取設定/狀態
      SetData,         // 寫入設定/觸發動作
    },
  },
};
```

### 生命週期與時序

由 `server/parts_loader.mjs` 驅動，順序是固定的：

```
Init({ router, username })   ← 每用戶 install-once（parts_init 記錄門）
  ↓
Load({ router, username })   ← 每次執行時首次載入
  ↓
interfaces.config.SetData(已儲存的設定)   ← 框架回灌 parts_config 持久化設定
```

要點：

- **SetData 在 Load 之後** — `Load` 內部拿不到框架注入的持久化設定，依賴設定的初始化要放在 SetData 裡或惰性執行。
- `Init` 只在安裝後第一次載入時執行一次（磁碟 `parts_init` 記錄）；worker isolate 裡則每個 isolate 各執行一次（記憶體門）。
- 啟動時框架先**淺載入**（只 `import` 暖模組快取，不跑鉤子），再背景**全量預載**（完整生命週期）；用戶請求路徑上懶載入兜底。
- 內建外掛放進 `plugins/` 目錄即自動註冊為預設外掛（`plugins/main.mjs` 容器在 Load 時掃描全部含 `main.mjs` 的子目錄）；載入失敗的外掛不會被註冊（防髒條目復活）。
- **熱重載 = 重啟進程**（Deno 不支援單檔案 ESM 卸載），改完代碼要重啟服務才生效。
- 拿到的外掛參照是惰性代理（FullProxy），重載後舊參照自動指向新實例。

## 二、怎麼鏈接：接入對話管線

對話每一輪，管線按固定順序觸碰外掛的 `interfaces.chat` 三個鉤子。參與方式：把外掛放進 `plugins/`（自動註冊後即參與），無需額外設定。

### GetPrompt — 回覆前注入

所有外掛的 GetPrompt **並發發起、統一 await**，回傳值進 `prompt_struct.plugin_prompts[外掛名]`。

**簽名**：`GetPrompt(args)`（args = chatReplyRequest，含 `chatid` / `username` / `chat_log` 等）

**回傳值**：

```javascript
{
  text: [
    { content: "提示詞文字", important: 0 }   // 按 important 排序後進「外掛」段
  ],
  additional_chat_log: [],   // 可選：追加進聊天記錄段的條目
  extension: {},             // 可選：外掛間傳遞的資料（不直接傳給 AI）
}
```

### TweakPrompt — 組裝後調整

所有 GetPrompt 完成後按 `detail_level` 輪數執行（預設 3 輪，dl = 2 → 1 → 0），每輪內各外掛並發。

**簽名**：`TweakPrompt(args, prompt_struct, my_prompt, detail_level)`

- `prompt_struct`：完整提示詞結構（可直接修改）
- `my_prompt`：本外掛在 GetPrompt 階段的回傳值
- 回傳值：無（直接改 `prompt_struct`）

典型分輪用法：dl=2 讀其他外掛的 extension → dl=1 重組訊息序列 → dl=0 最終調整。

### ReplyHandler — 回覆後處理

AI 回覆到達後，在重新生成循環裡**逐外掛串行**呼叫。

**簽名**：`ReplyHandler(result, { ...args, prompt_struct, AddLongTimeLog })`

- `result`：回覆物件，改 `result.content` 即修改回覆內容（`content_for_show` 是展示層文字）
- `AddLongTimeLog(entry)`：把工具呼叫軌跡寄生到本條訊息上落盤（跨輪可見）
- **回傳值：truthy = 觸發重新生成**（regen 循環無次數上限，由你的語義控制終止）；falsy = 放行
- 單一外掛拋異常會被隔離跳過，不中斷其他外掛的 ReplyHandler

典型用法：解析 AI 回覆中的自訂標籤 → 執行操作（檔案讀寫、變數設定）→ 結果透過下一輪 GetPrompt 注入。

### 外掛間通訊

外掛之間不直接 import，透過 `prompt_struct` 的 extension 欄位間接傳遞：

1. 外掛 A 在 GetPrompt 回傳值裡寫 `extension.my_data`
2. 外掛 B 在 TweakPrompt 階段讀 `prompt_struct.plugin_prompts['plugin-a'].extension.my_data`

### 模式管線（進階）

生成走 ModeDef 管線（chat/code/work 等模式各一條）。已遷入管線選單的外掛由 dispatch 按模式派發，選單外外掛走直調——**新外掛預設直調即可參與所有模式**，不需要註冊進管線選單。

## 三、怎麼鏈接：接入前端

### 自註冊 HTTP 端點

`Init` / `Load` 收到的 `router` 是外掛專屬的 Express 路由器，掛載在：

```
/(api|ws|virtual_files)/parts/plugins:<外掛名>/<你註冊的路徑>
```

例如外掛裡 `router.post('/config/setdata', handler)`，前端就請求 `POST /api/parts/plugins:my-plugin/config/setdata`。所有 parts API 請求先過登入認證，未認證回傳 401。

### config getdata/setdata 慣例

前端與外掛通訊的通用約定：

- `GET  /api/parts/plugins:<名>/config/getdata` → `interfaces.config.GetData()`
- `POST /api/parts/plugins:<名>/config/setdata` → `interfaces.config.SetData(data)`

`data._action` 欄位用於區分動作類型（讀檔案/寫設定/觸發操作……），一個 SetData 分發多種操作。

### 安全敏感設定必須註冊 owner 閘

多用戶部署下，`config/setdata` 任何登入用戶都能呼叫。如果你的設定項寫的是**進程級全域安全狀態**（開關沙箱、允許執行命令、改工作區根……），必須在 `security_policy.mjs` 的安全敏感寫清單裡註冊——框架會在路由接縫上強制僅 owner 可寫（大小寫變體也被涵蓋），否則任一註冊用戶可翻你的開關（RCE/沙箱逃逸面）。

### 用戶資料隔離

多用戶情境下外掛設定和資料按用戶隔離：用用戶資料目錄存盤，或用 AsyncLocalStorage 實作 per-user 上下文（beilu-files 的做法）。注意 GetPrompt/ReplyHandler 的 `args.username` 是隔離鍵來源。

## 四、怎麼鏈接：外部應用接入

外部程式（遊戲、腳本、第三方工具）不走外掛，走 **`/api/v1` 外部介面**：

1. 設定 → 外部應用整合 → 新建 API Key（選擇權限 scope，Key 只顯示一次）
2. REST 呼叫：`Authorization: Bearer <key>`，端點見 [API 端點參考](api-reference.md)（chat / characters / variables / memory / presets / worldbooks / tools / webhooks）
3. 即時橋接：`ws://host/api/v1/game/connect?chatId=<id>&token=<key>`——發 `{type:"send", content, sender}` 觸發 AI 回覆，自動收到串流 token 與訊息事件
4. 出站推送：註冊 Webhook 後，AI 回覆完成時 HMAC 簽名 POST 到你的 URL

外部輸入會被消毒（剝不可見字元、轉義協議標籤、`<external_user>` 身份包裹）；跳過消毒需要單獨的 `chat:raw` scope。危險操作（刪對話/改預設）需要 `X-Beilu-Confirm: true` 確認標頭。

## 用戶外掛 (beilu-plugin-host)

透過 beilu-plugin-host，用戶可以在執行階段載入自訂外掛腳本，無需重啟服務。用戶外掛與內建外掛享有相同的介面能力，但受安全策略約束。

## 除錯

- `BEILU_DIAG=<模組名>` 環境變數開啟診斷日誌
- whitebox 追蹤（wbTrace / wbDetect）記錄關鍵事件，錯誤面板可見
- fakeSend（token 預覽）模式測試 GetPrompt / TweakPrompt 輸出，不實際傳送

## 導覽

- [外掛概覽](../plugins/overview.md) — 現有外掛清單
- [訊息管線](message-pipeline.md) — 外掛在管線中的位置
- [系統架構](architecture.md) — 整體架構
- [API 端點參考](api-reference.md) — 端點介面
