# beilu 美化/脚本开发 — 类型声明与 API 指南

beilu 在消息渲染 iframe 中注入一套「酒馆兼容」(SillyTavern-compat) API。
美化代码 / 角色卡脚本可直接调用这些全局函数，无需 import。

本目录提供 `.d.ts` 类型声明，让你在自己的项目里获得自动补全。

## 快速开始

在你的美化项目（`.js` / `.ts`）顶部加引用即可：

```js
/// <reference path="https://你的beilu地址/parts/shells:chat/@types/beilu-helper.d.ts" />
/// <reference path="https://你的beilu地址/parts/shells:chat/@types/events.d.ts" />
```

之后 `eventOn`、`getVariables`、`TavernHelper.generate` 等都会有类型提示。

## 文件说明

| 文件 | 内容 |
|------|------|
| `beilu-helper.d.ts` | 全部「已实现」注入 API 的类型声明（与 stCompat 运行时一一对应） |
| `events.d.ts` | 事件名常量 + 事件数据形状；区分「真广播」与「设计占位」 |
| `README.md` | 本文件 |

## API 概览（已实现）

- **事件**：`eventOn` / `eventOnce` / `eventMakeLast` / `eventMakeFirst` / `eventEmit` /
  `eventEmitAndWait` / `eventRemoveListener` / `eventClearEvent` / `eventClearListener` / `eventClearAll`
- **全局对象**：`initializeGlobal` / `waitGlobalInitialized`
- **变量**：`getVariables` / `replaceVariables` / `updateVariablesWith` /
  `insertOrAssignVariables` / `insertVariables` / `deleteVariable` / `getAllVariables`
- **工具**：`errorCatched` / `getLastMessageId` / `getCurrentMessageId` /
  `substitudeMacros` / `getIframeName` / `getScriptId` / `reloadIframe`
- **楼层**：`getChatMessages` / `setChatMessages` / `createChatMessages` /
  `deleteChatMessages` / `sendChoice` / `getUserName` / `getCurrentCharacterName`
- **世界书**：`getCurrentCharPrimaryLorebook` / `getLorebookEntries` / `getCharWorldbookNames`
- **聚合对象**：`TavernHelper.*`、`BeiluHelper.*`（beilu 规范命名空间，设计 §4.4）、`SillyTavern.*`、`triggerSlash`、`beiluAudio.*`
- **情感契约**：`getCurrentEmotion()`（无来源返回 `null`）+ `EMOTION_CHANGED` 事件（producer 待后端）

## ⚠ 未实现 / 易踩坑（设计提过但运行时没有）

调用这些会得到 `undefined is not a function` 或静默无效，请改用替代写法：

| 你可能想用 | 现状 | 替代写法 |
|------------|------|----------|
| `eventOff(type, fn)` | ❌ 不存在 | 用 `eventRemoveListener(type, fn)`，或保留 `eventOn` 返回的句柄调 `.stop()` |
| `getGlobal(name)` | ❌ 不存在 | 直接读 `window[name]`，或 `await waitGlobalInitialized(name)` |
| `getCurrentEmotion()` | ⚠ 契约就位，**无来源时返回 `null`** | 情感检测链路 0% 落地；后端落地后即插即用，**当前一律 `null`，绝不造假** |
| `EMOTION_CHANGED` 事件 | ⚠ 常量已就位（`tavern_events.EMOTION_CHANGED`），但无 producer | 监听管道已通（`eventOn`），父页面 producer 待后端情感检测落地，落地后即触发 |
| `MODE_CHANGED` / `CHARACTER_CHANGED` | ⚠ 常量已就位，无 producer | 模式/角色切换广播未落地，监听暂不触发 |

### `window.BeiluHelper`（设计 §4.4）

beilu 的【规范命名空间】，归集 beilu 专属/增补 API。与 `TavernHelper` 并存——
`TavernHelper.*` 及其平铺到 `window` 的别名**全部保留**（向后兼容，现有脚本不破）。
`BeiluHelper` 是新增的正式入口，内部引用同一批 `window` 函数，两种写法等价：

```js
// 规范风格
BeiluHelper.eventOn(tavern_events.MESSAGE_RECEIVED, (idx) => { ... });
const emo = BeiluHelper.getCurrentEmotion();  // null（情感检测未落地）

// 平铺风格（等价，继续可用）
eventOn(tavern_events.MESSAGE_RECEIVED, (idx) => { ... });
```

#### 情感系统（契约就位，后端落地后即插即用）

```js
// 监听情感变化（producer 落地后触发）
eventOn(tavern_events.EMOTION_CHANGED, ({ emotion, message_id }) => {
  // emotion: "开心" / "难过" / ...  用户自己决定怎么用（立绘/Live2D/音效）
});

// 读取当前情感：无来源时返回 null（绝不造假），有来源时 { emotion, message_id, timestamp }
const cur = BeiluHelper.getCurrentEmotion();
if (cur) { /* 渲染 */ }
```

### 事件：能收到的只有 6 个

父页面（websocket.mjs）当前只广播这 6 个事件：
`message_sent` / `message_received` / `generation_started` / `generation_ended`
（外加 `js_generation_started` / `js_generation_ended` 两个 js_ 前缀变体）。

`tavern_events` 常量表里虽然有 `CHAT_CHANGED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、
`VARIABLE_UPDATED` 等（能拿到字符串常量），但**父页面没有 emit 它们**，监听不会触发。
详见 `events.d.ts` 的分类注释。

## 调试：beiluDebug

在 iframe 的 DevTools Console 里可直接调用 `window.beiluDebug`：

```js
beiluDebug.listListeners();   // 当前 iframe 注册的所有事件监听
beiluDebug.dumpVariables();   // 合并后的全部变量（= getAllVariables()）
beiluDebug.fakeEvent(name, data);  // 手动派发事件，调试监听器
beiluDebug.getParentState();  // 父页面状态：{ chatId, charName, userName, messageId }
```

> 注：`getParentState()` 设计里还规划了 `mode` / `emotion` 字段，但模式/情感检测尚未落地，
> 当前返回值不含这两项（或为 null）。
