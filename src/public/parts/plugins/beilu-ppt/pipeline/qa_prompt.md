# 视觉 QA prompt（来源: anthropics/skills pptx SKILL.md, v0.5 资产化）

用法: 真实产出时把渲染 PNG 交给**子代理**（新鲜眼睛——自己盯久了只会看到预期不是实况）按此 prompt 挑错。
原则: **假设有问题, 任务是找到它们**; 第一轮找不到问题 = 看得不够狠; 至少一轮 fix-and-verify（修一处常引发另一处, 修后重验相邻）。

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.
Report ALL issues found, including minor ones.
```

## 官方设计禁忌（生成 spec 时对照）
- 勿居中正文（正文/列表左对齐, 只有标题可居中）
- **勿在标题下加装饰线——AI 生成味的标志**, 用留白或背景色代替
- 勿纯文字页（每页要有视觉元素: 图/表/stat/形状）
- 勿页页同版式（列/卡片/callout 轮换）
- 勿低对比（浅字浅底/深字深底）
- 字号对比要够: 标题 36pt+ vs 正文 14-16pt
- 块距统一用 0.3" 或 0.5", 勿混
