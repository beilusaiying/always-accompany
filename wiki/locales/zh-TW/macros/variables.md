# 變數巨集

在預設集和角色卡中**儲存和讀取資料**，用於狀態追蹤（好感度、HP、物品數量等）。分為**區域變數**（目前角色/聊天專屬）和**全域變數**（所有角色共享），操作完全對稱。

## 核心概念

### 變數儲存位置

變數資料儲存在 `macroMemory` 中，並持久化到預設集的 `macro_variables` 欄位。這意味著：

- 變數在對話之間**持久保留**，不會因重新整理頁面而遺失
- 區域變數與目前角色/聊天繫結
- 全域變數在所有角色之間共享

### 變數類型

變數值可以是**字串**或**數字**。做數學運算（add/inc/dec）時，系統會嘗試將值當作數字處理。

## 區域變數操作

區域變數只在目前角色/聊天的範圍內有效。

| 巨集 | 說明 | 範例 |
|----|------|------|
| `{{setvar::名稱::值}}` | 設定變數 | `{{setvar::hp::100}}` |
| `{{getvar::名稱}}` | 讀取變數 | `{{getvar::hp}}` -> `100` |
| `{{addvar::名稱::值}}` | 加上一個數值 | `{{addvar::hp::-20}}` (hp 變為 80) |
| `{{incvar::名稱}}` | 自增 1 | `{{incvar::turn}}` |
| `{{decvar::名稱}}` | 自減 1 | `{{decvar::hp}}` |

### 使用範例

**設定初始狀態**（角色卡首條訊息中）：
```
{{setvar::hp::100}}{{setvar::mp::50}}{{setvar::gold::0}}
冒險開始了！{{user}}的初始狀態：HP {{getvar::hp}} / MP {{getvar::mp}}
```

**戰鬥中扣血**：
```
{{addvar::hp::-15}}
{{char}}的攻擊命中了！{{user}}受到 15 點傷害，剩餘 HP：{{getvar::hp}}
```

**回合計數**：
```
{{incvar::turn}}
=== 第 {{getvar::turn}} 回合 ===
```

## 全域變數操作

全域變數在所有角色和聊天之間共享。操作函式與區域變數完全對稱，名稱加上 `global` 前綴。

| 巨集 | 說明 | 範例 |
|----|------|------|
| `{{setglobalvar::名稱::值}}` | 設定全域變數 | `{{setglobalvar::reputation::neutral}}` |
| `{{getglobalvar::名稱}}` | 讀取全域變數 | `{{getglobalvar::reputation}}` |
| `{{addglobalvar::名稱::值}}` | 加上一個數值 | `{{addglobalvar::total_kills::1}}` |
| `{{incglobalvar::名稱}}` | 自增 1 | `{{incglobalvar::day_count}}` |
| `{{decglobalvar::名稱}}` | 自減 1 | `{{decglobalvar::energy}}` |

### 使用範例

**跨角色共享的世界狀態**：
```
{{setglobalvar::world_time::morning}}
{{setglobalvar::weather::sunny}}
```

不同角色的預設集中都可以讀取：
```
現在是{{getglobalvar::world_time}}，天氣{{getglobalvar::weather}}。
```

**跨對話的累積統計**：
```
{{incglobalvar::total_chats}}
這是你的第 {{getglobalvar::total_chats}} 次對話。
```

## 區域 vs 全域：如何選擇

| 情境 | 推薦 | 原因 |
|------|------|------|
| 角色好感度 | 區域變數 | 每個角色獨立 |
| HP/MP/狀態 | 區域變數 | 屬於目前角色的冒險 |
| 全域時間/天氣 | 全域變數 | 所有角色共享世界 |
| 玩家成就/統計 | 全域變數 | 跨角色累積 |
| 通用設定偏好 | 全域變數 | 不依賴特定角色 |

## 完整操作對照表

| 操作 | 區域變數 | 全域變數 |
|------|----------|----------|
| 設定 | `{{setvar::key::val}}` | `{{setglobalvar::key::val}}` |
| 讀取 | `{{getvar::key}}` | `{{getglobalvar::key}}` |
| 加值 | `{{addvar::key::N}}` | `{{addglobalvar::key::N}}` |
| 自增 | `{{incvar::key}}` | `{{incglobalvar::key}}` |
| 自減 | `{{decvar::key}}` | `{{decglobalvar::key}}` |

## 注意事項

- 讀取不存在的變數會回傳空字串，不會報錯
- `addvar` 可以傳負數來實現減法：`{{addvar::hp::-10}}`
- `setvar` 會覆蓋已有的值
- 變數名建議使用英文和底線，避免特殊字元
- 變數的設定和讀取都發生在後端巨集替換階段（傳送給 AI 之前）
