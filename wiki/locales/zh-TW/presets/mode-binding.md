# 預設集與模式聯動

always-accompany 的模式系統（[聊天模式](beilu:mode/chat) / Code / [工作模式](beilu:mode/work) / [Bot管理](beilu:mode/bot)）與預設集引擎深度聯動。每個模式可以綁定獨立的預設集，切換模式時系統自動切換預設集，保證不同工作情境下 AI 收到合適的指令。

## 綁定資料結構

### mode_preset_bindings

模式綁定關係儲存在記憶系統的全域設定中（`_config.json` 的 `mode_preset_bindings` 欄位）：

```
mode_preset_bindings: {
  chat: "預設集名A",
  code: "預設集名B",
  work: "預設集名C",
  bot:  "預設集名D"
}
```

每個模式只綁定一個預設集名。當你在某個模式下選擇預設集時，該綁定會自動更新。

### active_preset_map

除了模式級綁定，每個對話視窗可以獨立綁定預設集。`active_preset_map` 以對話 ID（或模式+角色複合鍵）為索引，記錄每個對話使用的預設集：

```
active_preset_map: {
  "abc1234": "預設集名X",         // 某個對話使用的預設集
  "chat:角色名": "預設集名Y",      // chat 模式下某角色的預設集
  "code:角色名": "預設集名Z"       // code 模式下某角色的預設集
}
```

## 預設集選擇優先級

當系統需要確定某次對話使用哪個預設集時，按以下優先級解析：

```
對話級 active_preset_map[chatId]
    ↓ 無 → 模式+角色複合鍵 active_preset_map[mode:charName]
    ↓ 無 → 模式綁定 mode_preset_bindings[mode]
    ↓ 無 → 全域預設 active_preset
```

## 模式切換時的聯動

使用者切換模式後，預設集引擎的行為：

1. 前端通知後端切換模式（switchMode）
2. 後端讀取目標模式的活躍對話（using 指標）
3. 從 active_preset_map 解析該對話的預設集
4. 如果對話沒有獨立預設集，回退到 mode_preset_bindings
5. 載入對應預設集到引擎，後續對話使用新預設集

## 子模式綁定

Code 和 Work 模式各擁有 11 個子模式。每個子模式可以獨立綁定：

- 預設集
- AI 服務源
- 模型名稱
- 採樣參數（temperature 等）

子模式參數在 TweakPrompt Round 2 階段覆蓋引擎參數。覆蓋鏈：

```
子模式參數 > runtime model_overrides_by_char > 全域 runtime_params > 預設集 eng.modelParams
```

子模式資訊透過 beilu-memory 的 extension 傳遞給預設集引擎（`sub_mode_*` 欄位），預設集引擎據此合併參數。

## P1 預設集切換訊號

記憶系統的 P1 管線可以在執行階段觸發預設集切換。當 extension 中出現 `preset_switch_to` 欄位時，預設集引擎會：

1. TweakPrompt Round 1 檢測到訊號
2. 切換到指定預設集
3. 持久化寫盤（saveConfigToDisk）
4. 同步正規表示式預設集（`_resyncPresetRegex`）
5. 後續輪次使用新預設集

這使得 AI 可以根據對話內容自動切換預設集（例如從聊天預設集切到程式碼預設集）。

## Bot 模式的預設集解析

Bot 模式的預設集解析有特殊邏輯：

- Bot 對話透過 `resolveBotModeFromRequest` 單源函式解析模式
- Bot 的預設集映射鍵使用 `bot:角色名` 格式
- Bot 模式複用 chat 後端模式，但預設集綁定獨立

## 資料持久化

| 資料 | 儲存位置 | 說明 |
|------|---------|------|
| mode_preset_bindings | 記憶系統 _config.json | 模式級綁定 |
| active_preset_map | 預設集 config.json | 對話/角色級綁定 |
| active_preset | 預設集 config.json | 全域預設預設集 |

預設集 config.json 按使用者隔離（`data/users/<user>/presets/config.json`），每個使用者擁有獨立的預設集設定。

## 清理機制

刪除對話時，系統會自動清理 active_preset_map 中該對話 ID 對應的殘鍵，防止設定檔案累積孤兒條目。

## 導航

- [預設集系統概覽](overview.md) — 預設集基礎概念
- [模式系統概覽](../modes/overview.md) — 模式架構
- [子模式與切換](../modes/submodes.md) — 子模式詳解
