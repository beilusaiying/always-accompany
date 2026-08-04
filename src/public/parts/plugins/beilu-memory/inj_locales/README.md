# inj_locales — INJ 条目正文的 locale 等义差量覆盖（D3 2026-08-04）

## 机制（覆盖式 i18n 范式，2026-07-15 定案：外语是差量覆盖，不是替换删减）

- INJ 条目的 `content`（default_memory_presets.json / 用户副本）**中文原文即默认语言**。
- 外语文本放本目录 `{locale}.json`（如 `en.json`、`ja.json`），**不进模板条目、不进用户副本**（零膨胀零迁移）。
- 运行时解析器：`storage_mod/injectionSystem.mjs resolveInjectionContentForLocales(entry, locales)`。
  传导链：账号级 `user.locales` → requestBuilder `result.locales` → getPromptHandler `arg.locales` → 解析器 → 条目正文 → 宏替换。
- 中文用户零 IO 快路径；目录/文件缺失=零覆盖优雅退化（永远有完整中文可用）。

## 文件格式

```json
{
  "entries": {
    "INJ-2": {
      "version": 1,
      "zh_sha256": "<对应中文原文的 sha256，64 位小写 hex>",
      "content": "……与中文语义等义的完整翻译，{{宏}} 占位符原样保留……"
    }
  }
}
```

## 安全契约（为什么必须带 zh_sha256）

覆盖只在 `zh_sha256 === sha256(条目当前 content)` 时发生：

- 用户改写过条目 → hash 不匹配 → 自动退回用户文本（「未改写才 locale 覆盖」契约）。
- 模板中文修订而翻译未跟进 → 退回新中文（**过期翻译永不注入**——"翻译=删减"的回归通道被 hash 闸死；
  这正是新用户重大 bug 的根因形态：英文化删减导致 示例/引导/code/work 能力死）。

## 翻译落地工作流

1. 翻译某条目：从 default_memory_presets.json 取该 id 的中文 `content` 全文，产出**语义等义**翻译
   （小节结构、数量、顺序、`{{宏}}` 集合必须与中文逐一相同；只译文字，不删不并小节）。
2. 写入本目录 `{locale}.json`（zh_sha256 = 当前中文全文的 sha256）。
3. 跑 `node ../inj_locale_check.mjs --write` 把该 locale 登记进 inj_locale_manifest.json。
4. 跑 `node ../inj_locale_check.mjs` 过门禁（hash 对齐 / 小节结构指纹 / 字数阈值 / 宏集合一致），
   exit 0 才可提交。中文正文修订后必须同批更新翻译与 manifest，否则该条翻译自动失效（安全但浪费）。
