# env 自訂變數巨集

外掛透過 `extension.macro_env` 注入自訂鍵值對，這些鍵自動成為可用巨集。

## 機制原理

```
外掛設定 extension.macro_env.my_key = "my_value"
  -> 巨集環境中出現 my_key
  -> 預設集中寫 {{my_key}} 會被替換為 "my_value"
```

這是一個**完全動態**的機制——外掛可以隨時更新 `macro_env` 中的值，下次巨集替換時就會使用新值。

## 已有的 env 巨集

以下是目前由 always-accompany 官方外掛注入的 env 巨集：

| 巨集 | 注入外掛 | 說明 |
|----|----------|------|
| `{{workspace_root}}` | beilu-files | 目前工作區的根目錄路徑 |
| `{{workspace_tree}}` | beilu-files | 目前工作區的目錄樹結構 |

### {{workspace_root}}

由 beilu-files 外掛注入。值為目前檔案工作區的根目錄路徑。程式碼模式下，AI 可以透過這個巨集知道專案在哪裡。

### {{workspace_tree}}

由 beilu-files 外掛注入。值為目前工作區的目錄樹文字表示。讓 AI 瞭解專案的檔案結構，不需要逐個列舉檔案。

## 外掛如何注入自訂巨集

對於外掛開發者，注入自訂巨集的方式是在外掛中設定 `extension.macro_env`：

```
extension.macro_env = {
    my_custom_key: "值會在巨集替換時填入",
    another_key: dynamicValue
};
```

設定後，預設集和角色卡中就可以使用 `{{my_custom_key}}` 和 `{{another_key}}`。

### 要點

- **鍵名即巨集名**：`macro_env` 中的鍵直接對應 `{{鍵名}}` 巨集
- **值可以動態更新**：外掛可以在執行階段更新 `macro_env` 的值，下次巨集替換自動生效
- **多外掛合併**：多個外掛的 `macro_env` 會合併到同一個巨集環境中
- **後端替換**：env 巨集在後端巨集引擎（evaluateMacros）階段被替換

## 執行鏈路

```
各外掛在初始化或執行階段設定 extension.macro_env
  -> 使用者傳送訊息
  -> 後端組裝提示詞
  -> TweakPrompt Round1: buildMacroEnvFromPromptStruct
     合併所有外掛的 macro_env 到巨集環境
  -> Round2: PresetEngine.buildAllEntries -> evaluateMacros
     遇到 {{key}} 時從巨集環境中查詢並替換
  -> 替換後的提示詞傳給 AI
```

## 與其他巨集的關係

| 對比維度 | env 巨集 | 內建巨集（如 {{user}}） | 變數巨集（如 {{getvar::x}}） |
|----------|--------|----------------------|--------------------------|
| 定義方式 | 外掛透過 macro_env 注入 | 寫死在巨集引擎中 | 使用者透過 setvar 設定 |
| 值來源 | 外掛執行階段計算 | 系統狀態（使用者名稱等） | macroMemory 儲存 |
| 可擴充性 | 任意擴充 | 固定集合 | 任意鍵名 |
| 持久性 | 外掛生命週期內有效 | 始終有效 | 持久化到預設集 |
| 適用情境 | 外掛向 AI 暴露資料 | 基本資訊佔位 | 對話狀態追蹤 |

## 注意事項

- env 巨集只在後端替換階段生效，前端不會處理
- 如果多個外掛注入了同名的巨集，後注入的會覆蓋先注入的
- env 巨集的值可以是字串或會被轉為字串的值
- 外掛解除安裝或停用後，其注入的 env 巨集不再可用，對應的 `{{巨集名}}` 會保持原樣不被替換
