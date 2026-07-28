# 子模式与切换

[Code](beilu:mode/files) 和 [Work](beilu:mode/work) 模式内部的二级模式系统，将开发/工作流程拆分为多个阶段，每个阶段独立配置 AI 行为。

## 子模式的作用

切换子模式时，系统自动加载该子模式绑定的：

- **预设**：不同阶段使用不同的系统提示词
- **[API 源](beilu:settings/api)**：可为不同阶段选择不同的 AI 服务商
- **模型**：可为不同阶段选择不同的 AI 模型
- **采样参数**：温度、Top-P 等，按阶段差异化配置

## Code 模式的 11 个子模式

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. 任务确认师</div>
<div class="wiki-card-desc"><b>理解需求</b><br>封层捕捉重点，联网查类似方案，细化专业化</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. 前置设计师</div>
<div class="wiki-card-desc"><b>方案设计</b><br>读取任务具体代码进行设计，精确到代码行</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">3. 框架审查员</div>
<div class="wiki-card-desc"><b>框架审查</b><br>以代码框架和整体流程审查，确认合理性</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">4. 深度思考师</div>
<div class="wiki-card-desc"><b>算法与系统推演</b><br>算法设计、框架逻辑、线路逻辑，实验验证后交代码专家</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. 代码专家</div>
<div class="wiki-card-desc"><b>代码实现</b><br>专注于代码实现</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">6. 前置错误生产师</div>
<div class="wiki-card-desc"><b>语法与流程检查</b><br>检查语法错误、HTML 标签错误，审查流程，合理打回</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">7. 测试专家</div>
<div class="wiki-card-desc"><b>实际测试</b><br>通过脚本工具和浏览器后台实际操作测试</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">8. 纠错专家</div>
<div class="wiki-card-desc"><b>问题定位与修复</b><br>查看整体再专注单体，插入代码或 F12 快速排查</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. 任务交接员</div>
<div class="wiki-card-desc"><b>文档与交接</b><br>做成 md 文件，转给任务确认师并与人类确认</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. 大项目协调</div>
<div class="wiki-card-desc"><b>大项目协调中枢</b><br>scope 锁定、依赖链排序、增量合并、多分身编排、完整输出</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. 前端美化</div>
<div class="wiki-card-desc"><b>前端设计与美化</b><br>Brief 推断、三旋钮、设计系统、Pre-Flight Check</div>
</div>
</div>

## Work 模式的 11 个子模式

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. 任务确认师</div>
<div class="wiki-card-desc"><b>需求确认</b><br>理解需求，核对理解，记录原话，建立任务文件</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. 任务设计</div>
<div class="wiki-card-desc"><b>流程设计</b><br>读取任务 MD，通过最终效果反推设计执行流程</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">3. 流程优化</div>
<div class="wiki-card-desc"><b>流程优化</b><br>优化设计好的流程，减少 token 消耗，精简步骤</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">4. 框架审查</div>
<div class="wiki-card-desc"><b>流程审查</b><br>审查流程设计是否有错误，联想可能的问题，只优化不打回</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. 提示词设计</div>
<div class="wiki-card-desc"><b>提示词编写</b><br>为任务设计所需的提示词，参考提示词指南</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">6. 提示词+预设设计</div>
<div class="wiki-card-desc"><b>预设设计</b><br>设计 always-accompany 提示词与预设本身，内含教程、示例与方法论</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">7. Skill/脚本制作</div>
<div class="wiki-card-desc"><b>脚本制作</b><br>制作任务所需的脚本、skill、MCP 接入</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">8. 流程组装</div>
<div class="wiki-card-desc"><b>流程组装</b><br>将提示词、skill、脚本组装为可执行的流程组</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. 执行流程组</div>
<div class="wiki-card-desc"><b>执行流程</b><br>运行组装好的流程组，按顺序执行各步骤，记录执行日志</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. 验证</div>
<div class="wiki-card-desc"><b>结果验证</b><br>用户验证或自动验证执行结果</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. 收尾归档</div>
<div class="wiki-card-desc"><b>归档收尾</b><br>归档任务 MD，更新表格索引，记录经验，生成完成报告</div>
</div>
</div>

## 子模式切换

切换子模式一共有三条路：你手动点、流水线自动推进、AI 自己切。

### 手动切换

在 Code 或 Work 模式下，通过侧边栏或顶部的子模式选择器切换当前子模式。切换后，AI 的预设、模型和参数会自动更新。

### 流水线自动切换

流水线（Flow Group）可以将多个步骤编排为自动执行序列。每个步骤的 `steps[].mode` 字段指定目标子模式：

<div class="wiki-flow-h">
<div class="wiki-box wiki-box-amber"><b>步骤 1</b><small>任务确认师</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-amber"><b>步骤 2</b><small>前置设计师</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-green"><b>步骤 3</b><small>代码专家</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-blue"><b>步骤 4</b><small>测试专家</small></div>
</div>

流水线执行时，系统根据当前步骤的 `mode` 字段自动切换子模式，加载对应的预设和参数，然后推进到下一步。整个过程无需手动干预。

### AI 主动切换

第三条路：AI 在回复里自己说"我要换角色"。AI 输出 `<subModeSwitch>目标子模式</subModeSwitch>` 标签，系统就把当前对话切到目标子模式——预设、模型、采样参数一并跟着换。这个标签在显示前会被系统清理掉，所以你通常看不到它，只会发现子模式栏的高亮变了。

常见场景：代码专家写完代码，自己切到测试专家去验证；纠错专家修完 bug，切回测试专家重测。这正是流水线之外 AI 自主推进工作的方式。

AI 主动切换有两道护栏，遇到"AI 想切但没切动"多半是它们在起作用：

- **跨组拒绝**：AI 只能在当前模式组内切换（Code 组内互切、Work 组内互切），不能从 Code 组直接跳进 Work 组的子模式。尝试跨组会被拒绝、保持原样。真需要跨组转交任务，走"委派"（delegate）这条正规通道。
- **回路检测**：如果 AI 在两个子模式之间反复横跳（典型是纠错 ↔ 测试来回切、超过上限次数），系统会判定"这不是单个 bug，是方案本身有问题"，强制停止切换并提示 AI 重新审视整体方案——防止 AI 陷入死循环空烧 token。

另外，AI 的切换只作用于当前这个对话窗口（对话线级），不会把你其他窗口正在用的子模式也一起切走。多窗口的隔离规则详见 [多窗口与多开](beilu:wiki/modes/multi-window.md)。

## 子模式配置

每个子模式的独立配置项：

| 配置项 | 说明 |
|--------|------|
| 预设 | 该子模式使用的系统提示词预设 |
| API 源 | 该子模式使用的 AI 服务源 |
| 模型 | 该子模式使用的 AI 模型 |
| 采样参数 | 温度、Top-P、频率惩罚等参数 |

这些配置独立于主模式的全局配置。切换子模式时，子模式的配置优先于主模式的默认配置。

## 使用建议

- **按阶段切换**：开发过程中按实际阶段切换子模式，获得针对性的 AI 辅助
- **差异化配置**：为不同子模式配置不同的模型，例如审查用推理强的模型、编码用代码能力强的模型
- **善用流水线**：重复性的多步骤流程可编排为流水线，自动推进
