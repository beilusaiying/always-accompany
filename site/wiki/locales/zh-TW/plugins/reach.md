# 平台觸達 (beilu-reach)

beilu-reach 讓 AI 取得 13 個網際網路平台的結構化資料——比通用網頁擷取更深層（API/CLI 級資料而非 HTML 正文）。AI 透過 `<reach>` 標籤呼叫，結果注入下一輪對話。

## 三條觸發路徑

```
① AI 主動呼叫：回覆中寫 <reach platform="..." action="...">query</reach>
② 搜尋自動路由：搜尋詞含 site:已知平台網域 → 自動補充該平台結構化結果
③ URL 智慧擷取：<browse> 一個已知平台 URL → 優先用平台介接器取結構化資料，失敗降級通用擷取
```

## 標籤格式

```xml
<reach platform="v2ex" action="hot">latest</reach>
<reach platform="github" action="search-repos" limit="5">AI agent</reach>
<reach platform="bilibili" action="video">BV1xx411c7mD</reach>
```

## 平台一覽

| 平台 | 操作 | 後端 | 設定 |
|------|------|------|------|
| V2EX | hot / node / topic / user | 公開 API | 零設定 |
| RSS/Atom | read | 原生解析 | 零設定 |
| Jina Reader | read | r.jina.ai | 零設定 |
| GitHub | search-repos / search-code / repo / issues / prs | gh CLI | Token 可選（提升限額） |
| YouTube | info / subtitle / search | yt-dlp | Cookie 來源瀏覽器可選 |
| Bilibili | search / video / hot / rank | bili-cli / opencli / 公開 API | SESSDATA 可選 |
| Twitter/X | search / read / user / feed | twitter-cli / opencli | Cookie |
| Reddit | search / read / subreddit / hot | opencli / rdt-cli | — |
| 小紅書 | search / note / comments / feed | opencli / mcporter | Cookie |
| 雪球 | quote / search-stock / hot-posts / hot-stocks | 公開 API | Cookie（xq_a_token） |
| Facebook | search / profile / feed | opencli | — |
| Instagram | search / profile / user / explore | opencli | — |
| LinkedIn | profile / search-people / search-jobs / company | mcporter / Jina | — |

面板的「平台狀態」卡即時偵測各平台工具可用性（每個平台的實際操作與後端以狀態卡為準——單一來源是後端註冊表）。

## 設定

「額外外掛 → 平台觸達」面板：

- **基礎開關**：總開關 / 搜尋平台路由 / URL 智慧擷取
- **平台憑證**：各平台 Cookie / Token（只在伺服器端請求平台時使用，不會出現在 AI 上下文裡）
- **網路與安全**：CLI 代理位址、指令逾時、平台白名單（限制 AI 可用的平台範圍）

設定改動即時同步後端並落盤，重啟不遺失。

## 安全

- **SSRF 防護**：AI 傳入的 URL 型參數（訂閱來源位址、影片連結等）經統一出站安全校驗，私有網路/回環/雲端中繼資料位址一律拒絕。
- **內容邊界**：平台回傳內容注入 AI 前經不可信內容邊界處理（尖括號中性化 + nonce 邊界標註），阻斷平台內容對 AI 的間接指令注入。
- **憑證隔離**：Cookie/Token 只在介接器內部用於請求，不進入 AI 可見上下文。
- **指令注入防護**：外部 CLI 一律參數陣列呼叫，不經 shell。

## 能力引導

AI 的 `<reach>` 用法說明走注入文字設定鏈（`reach.capabilities` 鍵），可在設定的注入文字編輯器中修改；可用平台清單由後端即時偵測動態產生，不隨文案固化。
