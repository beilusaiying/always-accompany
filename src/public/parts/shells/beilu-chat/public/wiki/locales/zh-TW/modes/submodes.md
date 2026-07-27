# 子模式與切換

[Code](beilu:mode/files) 和 [Work](beilu:mode/work) 模式內部的二級模式系統，將開發/工作流程拆分為多個階段，每個階段獨立設定 AI 行為。

## 子模式的作用

切換子模式時，系統自動載入該子模式綁定的：

- **預設集**：不同階段使用不同的系統提示詞
- **[API 源](beilu:settings/api)**：可為不同階段選擇不同的 AI 服務商
- **模型**：可為不同階段選擇不同的 AI 模型
- **採樣參數**：溫度、Top-P 等，按階段差異化設定

## Code 模式的 11 個子模式

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. 任務確認師</div>
<div class="wiki-card-desc"><b>理解需求</b><br>封層捕捉重點，聯網查類似方案，細化專業化</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. 前置設計師</div>
<div class="wiki-card-desc"><b>方案設計</b><br>讀取任務具體程式碼進行設計，精確到程式碼行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">3. 框架審查員</div>
<div class="wiki-card-desc"><b>框架審查</b><br>以程式碼框架和整體流程審查，確認合理性</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">4. 深度思考師</div>
<div class="wiki-card-desc"><b>演算法與系統推演</b><br>演算法設計、框架邏輯、線路邏輯，實驗驗證後交程式碼專家</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. 程式碼專家</div>
<div class="wiki-card-desc"><b>程式碼實作</b><br>專注於程式碼實作</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">6. 前置錯誤產生師</div>
<div class="wiki-card-desc"><b>語法與流程檢查</b><br>檢查語法錯誤、HTML 標籤錯誤，審查流程，合理打回</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">7. 測試專家</div>
<div class="wiki-card-desc"><b>實際測試</b><br>透過腳本工具和瀏覽器後台實際操作測試</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">8. 糾錯專家</div>
<div class="wiki-card-desc"><b>問題定位與修復</b><br>查看整體再專注單體，插入程式碼或 F12 快速排查</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. 任務交接員</div>
<div class="wiki-card-desc"><b>文件與交接</b><br>做成 md 檔案，轉給任務確認師並與人類確認</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. 大專案協調</div>
<div class="wiki-card-desc"><b>大專案協調中樞</b><br>scope 鎖定、依賴鏈排序、增量合併、多分身編排、完整輸出</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. 前端美化</div>
<div class="wiki-card-desc"><b>前端設計與美化</b><br>Brief 推斷、三旋鈕、設計系統、Pre-Flight Check</div>
</div>
</div>

## Work 模式的 11 個子模式

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. 任務確認師</div>
<div class="wiki-card-desc"><b>需求確認</b><br>理解需求，核對理解，記錄原話，建立任務檔案</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. 任務設計</div>
<div class="wiki-card-desc"><b>流程設計</b><br>讀取任務 MD，透過最終效果反推設計執行流程</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">3. 流程最佳化</div>
<div class="wiki-card-desc"><b>流程最佳化</b><br>最佳化設計好的流程，減少 token 消耗，精簡步驟</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">4. 框架審查</div>
<div class="wiki-card-desc"><b>流程審查</b><br>審查流程設計是否有錯誤，聯想可能的問題，只最佳化不打回</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. 提示詞設計</div>
<div class="wiki-card-desc"><b>提示詞編寫</b><br>為任務設計所需的提示詞，參考提示詞指南</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">6. 提示詞+預設集設計</div>
<div class="wiki-card-desc"><b>預設集設計</b><br>設計 always-accompany 提示詞與預設集本身，內含教學、範例與方法論</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">7. Skill/腳本製作</div>
<div class="wiki-card-desc"><b>腳本製作</b><br>製作任務所需的腳本、skill、MCP 接入</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">8. 流程組裝</div>
<div class="wiki-card-desc"><b>流程組裝</b><br>將提示詞、skill、腳本組裝為可執行的流程組</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. 執行流程組</div>
<div class="wiki-card-desc"><b>執行流程</b><br>執行組裝好的流程組，按順序執行各步驟，記錄執行日誌</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. 驗證</div>
<div class="wiki-card-desc"><b>結果驗證</b><br>使用者驗證或自動驗證執行結果</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. 收尾歸檔</div>
<div class="wiki-card-desc"><b>歸檔收尾</b><br>歸檔任務 MD，更新表格索引，記錄經驗，產生完成報告</div>
</div>
</div>

## 子模式切換

### 手動切換

在 Code 或 Work 模式下，透過側邊欄或頂部的子模式選擇器切換目前子模式。切換後，AI 的預設集、模型和參數會自動更新。

### 流水線自動切換

流水線（Flow Group）可以將多個步驟編排為自動執行序列。每個步驟的 `steps[].mode` 欄位指定目標子模式：

<div class="wiki-flow-h">
<div class="wiki-box wiki-box-amber"><b>步驟 1</b><small>任務確認師</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-amber"><b>步驟 2</b><small>前置設計師</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-green"><b>步驟 3</b><small>程式碼專家</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-blue"><b>步驟 4</b><small>測試專家</small></div>
</div>

流水線執行時，系統根據目前步驟的 `mode` 欄位自動切換子模式，載入對應的預設集和參數，然後推進到下一步。整個過程無需手動介入。

## 子模式設定

每個子模式的獨立設定項：

| 設定項 | 說明 |
|--------|------|
| 預設集 | 該子模式使用的系統提示詞預設集 |
| API 源 | 該子模式使用的 AI 服務源 |
| 模型 | 該子模式使用的 AI 模型 |
| 採樣參數 | 溫度、Top-P、頻率懲罰等參數 |

這些設定獨立於主模式的全域設定。切換子模式時，子模式的設定優先於主模式的預設設定。

## 使用建議

- **按階段切換**：開發過程中按實際階段切換子模式，獲得針對性的 AI 輔助
- **差異化設定**：為不同子模式設定不同的模型，例如審查用推理強的模型、編碼用程式碼能力強的模型
- **善用流水線**：重複性的多步驟流程可編排為流水線，自動推進
