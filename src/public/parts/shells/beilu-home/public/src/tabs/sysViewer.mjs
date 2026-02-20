/**
 * beilu-home 系统查看器模块
 * "使用"选项卡 → 系统查看器
 *
 * 纯前端静态文档查看器，展示：
 * - 宏（Macro）列表和用法
 * - 记忆系统结构说明
 * - 预设引擎说明
 * - 文件系统说明
 */

// ============================================================
// 文档数据定义
// ============================================================

const DOCS = [
	{
		id: 'macros-basic',
		category: '宏',
		icon: '🔤',
		title: '基础宏',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">基础宏（预设引擎 + 记忆系统通用）</h4>
<table class="beilu-doc-table">
<thead><tr><th>宏</th><th>说明</th><th>示例</th></tr></thead>
<tbody>
<tr><td><code>{{user}}</code> / <code>&lt;user&gt;</code></td><td>用户显示名</td><td>凛倾</td></tr>
<tr><td><code>{{char}}</code> / <code>&lt;bot&gt;</code> / <code>&lt;char&gt;</code></td><td>角色显示名</td><td>贝露</td></tr>
<tr><td><code>{{time}}</code></td><td>当前时间（本地格式）</td><td>20:35</td></tr>
<tr><td><code>{{date}}</code></td><td>当前日期（本地格式）</td><td>2026年2月18日</td></tr>
<tr><td><code>{{weekday}}</code></td><td>星期几</td><td>星期二</td></tr>
<tr><td><code>{{isotime}}</code></td><td>ISO 时间</td><td>20:35</td></tr>
<tr><td><code>{{isodate}}</code></td><td>ISO 日期</td><td>2026-02-18</td></tr>
<tr><td><code>{{newline}}</code></td><td>换行符</td><td>\\n</td></tr>
<tr><td><code>{{trim}}</code></td><td>移除前后空行</td><td>—</td></tr>
<tr><td><code>{{noop}}</code></td><td>空操作（占位用）</td><td>—</td></tr>
<tr><td><code>{{idle_duration}}</code></td><td>距上次消息的时间</td><td>5 minutes ago</td></tr>
<tr><td><code>{{lasttime}}</code></td><td>最后一条消息的时间</td><td>20:30</td></tr>
<tr><td><code>{{lastdate}}</code></td><td>最后一条消息的日期</td><td>2026年2月18日</td></tr>
</tbody>
</table>`,
	},
	{
		id: 'macros-advanced',
		category: '宏',
		icon: '⚡',
		title: '高级宏',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">高级宏</h4>
<table class="beilu-doc-table">
<thead><tr><th>宏</th><th>说明</th></tr></thead>
<tbody>
<tr><td><code>{{random::a,b,c}}</code></td><td>从列表中随机选一个（每次不同）</td></tr>
<tr><td><code>{{pick::a,b,c}}</code></td><td>从列表中确定性选一个（同位置固定）</td></tr>
<tr><td><code>{{roll:1d6}}</code></td><td>掷骰子</td></tr>
<tr><td><code>{{reverse::text}}</code></td><td>反转文本</td></tr>
<tr><td><code>{{timediff::time1::time2}}</code></td><td>计算两个时间的差值</td></tr>
<tr><td><code>{{banned "word"}}</code></td><td>违禁词标记（会被清除）</td></tr>
<tr><td><code>{{datetimeformat FORMAT}}</code></td><td>自定义日期格式（moment.js 格式）</td></tr>
<tr><td><code>{{time_utc+N}}</code></td><td>指定时区的时间</td></tr>
<tr><td><code>{{//comment}}</code></td><td>注释（不会出现在输出中）</td></tr>
</tbody>
</table>`,
	},
	{
		id: 'macros-variables',
		category: '宏',
		icon: '📦',
		title: '变量宏',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">变量宏（ST 兼容）</h4>
<table class="beilu-doc-table">
<thead><tr><th>宏</th><th>说明</th></tr></thead>
<tbody>
<tr><td><code>{{getvar::name}}</code></td><td>获取局部变量</td></tr>
<tr><td><code>{{setvar::name::value}}</code></td><td>设置局部变量（返回空）</td></tr>
<tr><td><code>{{addvar::name::value}}</code></td><td>累加局部变量</td></tr>
<tr><td><code>{{incvar::name}}</code></td><td>局部变量 +1</td></tr>
<tr><td><code>{{decvar::name}}</code></td><td>局部变量 -1</td></tr>
<tr><td><code>{{getglobalvar::name}}</code></td><td>获取全局变量</td></tr>
<tr><td><code>{{setglobalvar::name::value}}</code></td><td>设置全局变量</td></tr>
<tr><td><code>{{incglobalvar::name}}</code></td><td>全局变量 +1</td></tr>
<tr><td><code>{{decglobalvar::name}}</code></td><td>全局变量 -1</td></tr>
</tbody>
</table>
<p class="text-xs text-base-content/50 mt-2">变量宏在每轮宏替换时执行。局部变量与当前聊天关联，全局变量跨聊天共享。</p>`,
	},
	{
		id: 'macros-memory',
		category: '宏',
		icon: '🧠',
		title: '记忆系统宏',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">记忆系统专用宏（beilu-memory）</h4>
<p class="text-xs text-base-content/50 mb-3">以下宏由 beilu-memory 插件在注入提示词（INJ-1/INJ-2）和记忆预设（P1-P6）中替换。与预设引擎宏独立运行。</p>
<table class="beilu-doc-table">
<thead><tr><th>宏</th><th>说明</th><th>使用位置</th></tr></thead>
<tbody>
<tr><td><code>{{tableData}}</code></td><td>所有记忆表格（#0-#9）的纯数据文本，含列头、行数据、操作规则</td><td>INJ-1, P1-P6</td></tr>
<tr><td><code>{{hotMemory}}</code></td><td>热记忆层全部内容：remember_about_user、forever、appointments、user_profile、温层月索引</td><td>INJ-1, P1-P6</td></tr>
<tr><td><code>{{chat_history}}</code></td><td>最近 N 条聊天记录文本（N 由 _config.json 的 retrieval.chat_history_count 控制）</td><td>P1-P6</td></tr>
<tr><td><code>{{current_date}}</code></td><td>当前日期时间（格式：YYYY年M月D日 周X HH:mm）</td><td>P3, P1-P6</td></tr>
<tr><td><code>{{lastUserMessage}}</code></td><td>用户最后一条消息的完整内容</td><td>P1-P6</td></tr>
<tr><td><code>{{char}}</code></td><td>角色显示名（同基础宏）</td><td>全部</td></tr>
<tr><td><code>{{user}}</code></td><td>用户显示名（同基础宏）</td><td>全部</td></tr>
</tbody>
</table>
<div class="mt-3 p-2 rounded text-xs" style="background: oklch(var(--bc) / 0.04);">
<strong>热层宏 {{hotMemory}} 展开后包含：</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li>想要记住的关于{{user}}的事情 — hot/remember_about_user/*.json</li>
<li>永远记住的事情（Top-100） — hot/forever.json</li>
<li>约定/任务/计划 — hot/appointments.json</li>
<li>关于{{user}} — hot/user_profile.json</li>
<li>历史记忆索引 — hot/warm_monthly_index.json</li>
</ul>
</div>
<div class="mt-2 p-2 rounded text-xs border border-warning/30" style="background: oklch(var(--wa) / 0.05);">
<strong>⚠️ 注意：</strong>记忆系统宏和预设引擎宏是<strong>独立替换</strong>的。记忆系统宏仅在 beilu-memory 的注入提示词和记忆AI预设中生效，不会在聊天预设条目中替换。反之，预设引擎的 env 自定义变量宏也不会在记忆预设中生效。
</div>`,
	},
	{
		id: 'macros-env',
		category: '宏',
		icon: '🔧',
		title: 'env 自定义变量宏',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">env 自定义变量宏（预设引擎专用）</h4>
<p class="text-xs text-base-content/50 mb-3">插件可通过 env 对象向预设引擎注入自定义变量，在聊天预设条目中以 <code>{{变量名}}</code> 形式替换。</p>
<table class="beilu-doc-table">
<thead><tr><th>来源插件</th><th>变量名</th><th>说明</th></tr></thead>
<tbody>
<tr><td>beilu-files</td><td><code>{{workspace_root}}</code></td><td>当前工作区根目录路径</td></tr>
<tr><td>beilu-files</td><td><code>{{workspace_tree}}</code></td><td>工作区目录树（文件列表）</td></tr>
<tr><td>beilu-sysinfo</td><td><code>{{system_info}}</code></td><td>运行环境信息（OS、内存、CPU等）</td></tr>
</tbody>
</table>
<div class="mt-3 p-2 rounded text-xs" style="background: oklch(var(--bc) / 0.04);">
<strong>工作原理：</strong>预设引擎的 <code>evaluateMacros(content, env)</code> 函数会遍历 env 对象的所有键，将 <code>{{key}}</code> 替换为 <code>env[key]</code> 的值。插件在 <code>GetPrompt</code> 阶段向 env 注入键值对即可扩展宏。
</div>
<div class="mt-2 p-2 rounded text-xs border border-info/30" style="background: oklch(var(--in) / 0.05);">
<strong>💡 提示：</strong>env 变量宏仅在<strong>预设引擎</strong>处理聊天预设时替换。记忆系统的注入提示词和记忆AI预设使用独立的宏替换逻辑，不会处理 env 变量。
</div>`,
	},
	{
		id: 'memory-tables',
		category: '记忆系统',
		icon: '📊',
		title: '记忆表格（#0-#9）',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">记忆表格结构</h4>
<p class="text-xs text-base-content/50 mb-3">记忆表格由 beilu-memory 管理，AI 通过 &lt;tableEdit&gt; 标签进行 CRUD 操作。</p>
<table class="beilu-doc-table">
<thead><tr><th>#</th><th>表格名</th><th>列</th><th>说明</th></tr></thead>
<tbody>
<tr><td>#0</td><td>时空表格</td><td>日期, 时间, 地点, 此地角色</td><td>当前场景状态</td></tr>
<tr><td>#1</td><td>角色特征表格</td><td>角色名, 身体特征, 性格, 职业, 爱好, 喜欢的事物, 住所, 其他</td><td>NPC 档案</td></tr>
<tr><td>#2</td><td>角色社交表格</td><td>角色名, 对{{user}}关系, 态度, 好感度</td><td>社交网络</td></tr>
<tr><td>#3</td><td>任务/命令/约定</td><td>角色, 任务, 地点, 持续时间</td><td>待办事项</td></tr>
<tr><td>#4</td><td>当日临时记忆</td><td>角色, 事件简述, 日期, 地点, 情绪</td><td>超50条自动归档</td></tr>
<tr><td>#5</td><td>重要物品（背包）</td><td>拥有人, 物品描述, 物品名, 重要原因</td><td>随身物品</td></tr>
<tr><td>#6</td><td>当天事件大总结</td><td>时间, 地点, 事件概述</td><td>日终清空</td></tr>
<tr><td>#7</td><td>想要记住的关于{{user}}的事</td><td>日期, 想要记住的事情, 原因</td><td>超3天归档到热层</td></tr>
<tr><td>#8</td><td>永远记住的事情</td><td>事件, 日期</td><td>超200条溢出到 forever.json</td></tr>
<tr><td>#9</td><td>时空记忆表格</td><td>日期, 当日总结</td><td>保留最近2天</td></tr>
</tbody>
</table>
<div class="mt-3 p-2 rounded text-xs" style="background: oklch(var(--bc) / 0.04);">
<strong>&lt;tableEdit&gt; 操作格式：</strong>
<pre class="mt-1 font-mono text-xs">
&lt;tableEdit&gt;
&lt;!--
insertRow(表格编号, {列编号: "值", ...})
updateRow(表格编号, 行编号, {列编号: "新值", ...})
deleteRow(表格编号, 行编号)
--&gt;
&lt;/tableEdit&gt;</pre>
</div>`,
	},
	{
		id: 'memory-layers',
		category: '记忆系统',
		icon: '🔥',
		title: '记忆层级架构',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">三层记忆架构</h4>
<div class="space-y-3">
<div class="p-2 rounded border border-red-500/20" style="background: oklch(var(--bc) / 0.03);">
<div class="flex items-center gap-2 mb-1"><span>🔥</span><strong class="text-sm text-red-400">热记忆层 (Hot)</strong><span class="badge badge-xs badge-error">每轮注入</span></div>
<div class="text-xs text-base-content/60 space-y-0.5">
<div>📂 <code>hot/remember_about_user/</code> — #7 超3天条目归档</div>
<div>📄 <code>hot/forever.json</code> — #8 超200条溢出（Top-K 注入 Top-100）</div>
<div>📄 <code>hot/appointments.json</code> — #3 已完成任务归档</div>
<div>📄 <code>hot/user_profile.json</code> — 用户画像（永不移出热层）</div>
<div>📄 <code>hot/items_archive.json</code> — #5 放入仓库的物品</div>
<div>📄 <code>hot/warm_monthly_index.json</code> — 温层月份索引（供 P1 检索）</div>
</div>
</div>
<div class="p-2 rounded border border-amber-500/20" style="background: oklch(var(--bc) / 0.03);">
<div class="flex items-center gap-2 mb-1"><span>🌤️</span><strong class="text-sm text-amber-400">温记忆层 (Warm)</strong><span class="badge badge-xs badge-warning">按需检索</span></div>
<div class="text-xs text-base-content/60 space-y-0.5">
<div>📂 <code>warm/{year}/{month}/{day}_summary.json</code> — 日总结</div>
<div>📂 <code>warm/{year}/{month}/{day}_details/</code> — #4 临时记忆归档（10条/文件）</div>
<div>📄 <code>warm/cold_yearly_index.json</code> — 冷层年份索引</div>
</div>
</div>
<div class="p-2 rounded border border-blue-500/20" style="background: oklch(var(--bc) / 0.03);">
<div class="flex items-center gap-2 mb-1"><span>❄️</span><strong class="text-sm text-blue-400">冷记忆层 (Cold)</strong><span class="badge badge-xs badge-info">深度检索</span></div>
<div class="text-xs text-base-content/60 space-y-0.5">
<div>📂 <code>cold/{year}/{month}/</code> — 超30天的温层数据迁入</div>
<div>📄 <code>cold/{year}/{month}/monthly_summary.json</code> — 月度总结（P5生成）</div>
</div>
</div>
</div>`,
	},
	{
		id: 'memory-presets',
		category: '记忆系统',
		icon: '🤖',
		title: '记忆AI预设（P1-P6）',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">6个内置记忆AI预设</h4>
<table class="beilu-doc-table">
<thead><tr><th>ID</th><th>名称</th><th>触发方式</th><th>职责</th></tr></thead>
<tbody>
<tr><td><span class="badge badge-xs badge-warning">P1</span></td><td>检索AI</td><td>auto_on_message</td><td>分析对话上下文，从温/冷层检索相关记忆</td></tr>
<tr><td><span class="badge badge-xs badge-warning">P2</span></td><td>表格总结/归档AI</td><td>auto_on_threshold</td><td>#4 超阈值时压缩为 #6 总结并归档</td></tr>
<tr><td><span class="badge badge-xs badge-warning">P3</span></td><td>每日总结AI</td><td>manual_button</td><td>日终时以{{char}}视角生成日总结</td></tr>
<tr><td><span class="badge badge-xs badge-warning">P4</span></td><td>热→温转移AI</td><td>manual_button</td><td>审查热层，将过时记忆移入温层</td></tr>
<tr><td><span class="badge badge-xs badge-warning">P5</span></td><td>月度总结/归档AI</td><td>manual_or_auto</td><td>温层超30天 → 月总结 → 冷层</td></tr>
<tr><td><span class="badge badge-xs badge-warning">P6</span></td><td>格式检查/修复AI</td><td>manual_button</td><td>扫描全部表格和文件，修复格式问题</td></tr>
</tbody>
</table>
<div class="mt-3 p-2 rounded text-xs" style="background: oklch(var(--bc) / 0.04);">
<strong>记忆AI文件操作标签：</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li><code>&lt;memorySearch&gt;</code> — 检索（readFile / listDir）</li>
<li><code>&lt;memoryArchive&gt;</code> — 归档（createFile / appendToFile / updateIndex / moveEntries）</li>
<li><code>&lt;memoryNote type="todo|issue"&gt;</code> — 备忘</li>
<li><code>&lt;tableEdit&gt;</code> — 表格操作</li>
</ul>
</div>
<div class="mt-2 p-2 rounded text-xs border border-info/30" style="background: oklch(var(--in) / 0.05);">
<strong>P2 归档阈值：</strong>P2 的触发条件是 <code>auto_on_threshold</code>，当 #4 临时记忆行数超过 <code>_config.json → archive.temp_memory_threshold</code>（默认 50）时自动触发。可在「记忆管理」页面的归档配置中自定义阈值。
</div>`,
	},
	{
		id: 'memory-injection',
		category: '记忆系统',
		icon: '💉',
		title: '注入提示词（INJ-1/INJ-2）',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">聊天AI注入提示词</h4>
<p class="text-xs text-base-content/50 mb-3">注入提示词在每轮聊天时由 beilu-memory 的 GetPrompt 自动注入到 AI 对话中。</p>
<table class="beilu-doc-table">
<thead><tr><th>ID</th><th>名称</th><th>autoMode</th><th>说明</th></tr></thead>
<tbody>
<tr><td><span class="badge badge-xs badge-info">INJ-1</span></td><td>dataTable说明</td><td>always</td><td>注入 {{tableData}} 和 &lt;tableEdit&gt; 操作规则，让聊天AI维护记忆表格</td></tr>
<tr><td><span class="badge badge-xs badge-info">INJ-2</span></td><td>文件层AI提示词</td><td>manual</td><td>注入文件操作能力（read/write/create/delete），让AI像 Cursor 一样操作文件</td></tr>
</tbody>
</table>
<div class="mt-3 p-2 rounded text-xs" style="background: oklch(var(--bc) / 0.04);">
<strong>autoMode 模式说明：</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li><code>always</code> — 始终跟随 enabled 字段（启用则每轮注入）</li>
<li><code>manual</code> — 只看 enabled 字段（需手动开关）</li>
<li><code>file</code> — 仅在文件模式下注入（beilu-files 的 activeMode === 'file' 时）</li>
</ul>
</div>`,
	},
	{
		id: 'preset-engine',
		category: '预设引擎',
		icon: '📝',
		title: 'ST 预设引擎',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">beilu-preset 预设引擎</h4>
<p class="text-xs text-base-content/50 mb-3">兼容 SillyTavern 预设格式，处理 prompts[] + prompt_order[] 排列和注入。</p>
<div class="space-y-2 text-xs">
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>条目分类</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li><strong>系统级</strong> (system_prompt: true) — 放在系统提示词区域，role 强制 system</li>
<li><strong>注入式</strong> (injection_position: 1) — 按 depth 插入聊天记录中，可选 role</li>
<li><strong>Marker</strong> (marker: true) — 内置占位符，展开为模块内容（charDescription 等）</li>
</ul>
</div>
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>12 个内置 Marker</strong>
<div class="flex flex-wrap gap-1 mt-1">
<code class="badge badge-xs badge-outline">main</code>
<code class="badge badge-xs badge-outline">nsfw</code>
<code class="badge badge-xs badge-outline">jailbreak</code>
<code class="badge badge-xs badge-outline">chatHistory</code>
<code class="badge badge-xs badge-outline">worldInfoBefore</code>
<code class="badge badge-xs badge-outline">worldInfoAfter</code>
<code class="badge badge-xs badge-outline">enhanceDefinitions</code>
<code class="badge badge-xs badge-outline">charDescription</code>
<code class="badge badge-xs badge-outline">charPersonality</code>
<code class="badge badge-xs badge-outline">scenario</code>
<code class="badge badge-xs badge-outline">personaDescription</code>
<code class="badge badge-xs badge-outline">dialogueExamples</code>
</div>
</div>
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>注入深度 (injection_depth)</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li><code>depth=0</code> → 插入到聊天记录最末尾（最新消息之后）</li>
<li><code>depth=N</code> → 从末尾往前数 N 条处插入</li>
</ul>
</div>
</div>`,
	},
	{
		id: 'worldbook',
		category: '预设引擎',
		icon: '🌍',
		title: '世界书',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">世界书（World Info）</h4>
<p class="text-xs text-base-content/50 mb-3">兼容 SillyTavern 世界书格式。条目通过关键词触发注入到对话中。</p>
<div class="space-y-2 text-xs">
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>触发方式</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li><strong>常驻</strong> (constant: true) — 每轮必定注入</li>
<li><strong>关键词触发</strong> — 当对话中出现主要关键字或辅助关键字时注入</li>
<li><strong>匹配逻辑</strong> — ANY（匹配任一关键词）或 ALL（匹配全部）</li>
</ul>
</div>
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>插入位置</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li><code>position=0</code> — 角色描述之前</li>
<li><code>position=1</code> — 角色描述之后</li>
<li><code>position=4</code> — @深度（按 depth 值插入聊天记录中）</li>
</ul>
</div>
</div>`,
	},
	{
		id: 'files-plugin',
		category: '插件系统',
		icon: '📁',
		title: 'beilu-files 文件系统',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">beilu-files 文件操作插件</h4>
<p class="text-xs text-base-content/50 mb-3">让 AI 具备类似 Cursor IDE 的文件读写能力。</p>
<div class="space-y-2 text-xs">
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>文件操作标签</strong>
<pre class="mt-1 font-mono">
&lt;file_op type="read" path="路径"&gt;&lt;/file_op&gt;
&lt;file_op type="write" path="路径"&gt;内容&lt;/file_op&gt;
&lt;file_op type="create" path="路径"&gt;内容&lt;/file_op&gt;
&lt;file_op type="delete" path="路径"&gt;&lt;/file_op&gt;
&lt;file_op type="list" path="目录"&gt;&lt;/file_op&gt;
&lt;file_op type="move" path="原路径" dest="新路径"&gt;&lt;/file_op&gt;</pre>
</div>
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>安全控制</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li>路径白名单/黑名单控制</li>
<li>读取操作可自动批准</li>
<li>写入/删除操作需用户确认</li>
<li>命令执行 (exec) 独立开关</li>
</ul>
</div>
</div>`,
	},
	{
		id: 'archive-flow',
		category: '记忆系统',
		icon: '📦',
		title: '归档流程',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">记忆归档流程</h4>
<div class="space-y-2 text-xs">
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>🌙 日终归档（"结束今天"按钮）— 9步流程</strong>
<ol class="list-decimal pl-4 mt-1 space-y-0.5">
<li>总结AI(P2) 处理 #6 → 生成日总结（TODO: AI调用）</li>
<li>日总结写入 warm/{year}/{month}/{day}_summary.json</li>
<li>#6 汇总到 #9 时空记忆表格</li>
<li>#6 清空</li>
<li>#7 超3天条目 → hot/remember_about_user/{date}.json</li>
<li>#3 已完成任务 → hot/appointments.json（需手动标记）</li>
<li>#4 剩余临时记忆 → warm/{year}/{month}/{day}_details/</li>
<li>更新 hot/warm_monthly_index.json</li>
<li>#0 时空表格清空</li>
</ol>
</div>
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>🔄 自动归档（每轮 AI 回复后）</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li>#4 超过阈值 → 触发 P2 归档AI 压缩后，10条/文件归档到温层
	<ul class="list-disc pl-4 mt-0.5">
		<li>阈值在「记忆管理 → 归档配置」中设置，默认 50 条</li>
		<li>配置保存在 <code>_config.json</code> 的 <code>archive.temp_memory_threshold</code></li>
	</ul>
</li>
<li>#7 超过3天 → 归档到 hot/remember_about_user/</li>
<li>#8 超过200条 → 溢出到 hot/forever.json</li>
<li>#9 超过2天 → 清理</li>
</ul>
</div>
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>❄️ 冷归档</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li>温层超过30天的月份 → 整月迁移到冷层</li>
<li>P5 月度总结AI 生成 monthly_summary.json</li>
<li>更新 cold_yearly_index.json</li>
</ul>
</div>
</div>`,
	},
	{
		id: 'memory-export-format',
		category: '记忆系统',
		icon: '📤',
		title: '导入/导出格式',
		content: `<h4 class="text-sm font-bold text-amber-700 mb-2">记忆数据导入/导出</h4>
<p class="text-xs text-base-content/50 mb-3">导出为 <strong>.zip</strong> 文件，包含完整的角色记忆目录结构。你可以解压修改后重新导入，或手动制作一个 zip 导入。</p>

<div class="space-y-3 text-xs">
<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>📦 导出 zip 内部结构</strong>
<pre class="mt-1 font-mono text-xs leading-relaxed">
beilu-memory_{角色ID}_{日期}.zip
├── tables.json              ← 记忆表格 #0-#9（JSON）
├── _config.json             ← 检索/归档配置
├── _memory_presets.json     ← 预设配置（P1-P6 + INJ）
├── hot/                     ← 热记忆层
│   ├── forever.json         ← 永远记住的事
│   ├── appointments.json    ← 约定/任务
│   ├── user_profile.json    ← 用户画像
│   ├── items_archive.json   ← 物品归档
│   ├── warm_monthly_index.json ← 温层月索引
│   └── remember_about_user/ ← 想记住的事（按日期）
│       ├── 2026-02-14.json
│       └── 2026-02-15.json
├── warm/                    ← 温记忆层
│   └── 2026/
│       └── 02/
│           ├── 14_summary.json   ← 日总结
│           └── 14_details/       ← 日详情
│               ├── batch_001.json
│               └── batch_002.json
└── cold/                    ← 冷记忆层
	   └── 2025/
	       └── 12/
	           └── monthly_summary.json
</pre>
</div>

<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>📝 手动制作 zip 导入包</strong>
<ol class="list-decimal pl-4 mt-1 space-y-1">
<li>创建上述目录结构（不需要全部文件，只放你需要的）</li>
<li>所有数据文件为 <strong>UTF-8 编码的 JSON</strong></li>
<li>打包为 <code>.zip</code>（根目录直接放文件，不要多套一层文件夹）</li>
<li>在聊天界面的记忆面板点"📥 导入"按钮上传</li>
</ol>
</div>

<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>📋 tables.json 格式</strong>
<pre class="mt-1 font-mono text-xs leading-relaxed">
{
	 "tables": [
	   {
	     "name": "时空表格",
	     "columns": ["日期","时间","地点","此地角色"],
	     "rows": [
	       ["2026-02-18","20:00","贝露的房间","贝露, 凛倾"]
	     ]
	   },
	   ...  // #1-#9 同结构
	 ]
}</pre>
</div>

<div class="p-2 rounded" style="background: oklch(var(--bc) / 0.04);">
<strong>📋 热层 JSON 通用格式</strong>
<pre class="mt-1 font-mono text-xs leading-relaxed">
// forever.json / appointments.json
[
	 { "event": "事件描述", "date": "2026-02-18" },
	 ...
]

// user_profile.json
{
	 "name": "用户名",
	 "traits": ["特征1", "特征2"],
	 ...  // 自由格式
}

// remember_about_user/{date}.json
[
	 { "date": "2026-02-14", "content": "想记住的事", "reason": "原因" },
	 ...
]</pre>
</div>

<div class="p-2 rounded border border-warning/30" style="background: oklch(var(--wa) / 0.05);">
<strong>⚠️ 导入注意事项</strong>
<ul class="list-disc pl-4 mt-1 space-y-0.5">
<li>导入会<strong>覆盖</strong>同名文件（原文件备份为 <code>.import_bak</code>）</li>
<li><code>.bak</code> 和 <code>.import_bak</code> 文件在导出时自动跳过</li>
<li>导入前建议先导出一份当前数据作为备份</li>
<li>zip 内不要包含非 UTF-8 文件或二进制文件</li>
</ul>
</div>
</div>`,
	},
]

// 分类列表（自动从 DOCS 中提取）
const CATEGORIES = [...new Set(DOCS.map(d => d.category))]

// ============================================================
// DOM 操作
// ============================================================

let currentDocId = null

/**
 * 初始化系统查看器
 */
export async function init() {
	const container = document.getElementById('section-sysViewer')
	if (!container) return

	// 构建 HTML
	container.innerHTML = `
		<div class="beilu-preset-layout">
			<!-- 左栏：文档列表 -->
			<div class="beilu-preset-list-col">
				<div class="flex gap-1 mb-2">
					<input type="text" id="sv-search" placeholder="搜索文档..."
						class="input input-sm input-bordered flex-grow" />
				</div>
				<div id="sv-doc-list" class="beilu-preset-entry-list"></div>
			</div>
			<!-- 右栏：文档内容 -->
			<div id="sv-doc-content" class="beilu-preset-detail-col" style="">
				<div class="text-center py-12">
					<p class="text-base-content/40 text-sm">👈 从左侧选择一个文档</p>
					<p class="text-base-content/30 text-xs mt-1">包含宏列表、记忆系统、预设引擎等系统文档</p>
				</div>
			</div>
		</div>
	`

	renderDocList()
	bindEvents()

	// 默认选中第一个
	if (DOCS.length > 0) {
		selectDoc(DOCS[0].id)
	}
}

/**
 * 渲染文档列表
 * @param {string} [filter] - 搜索过滤词
 */
function renderDocList(filter = '') {
	const listEl = document.getElementById('sv-doc-list')
	if (!listEl) return

	const lowerFilter = filter.toLowerCase()
	let html = ''
	let lastCategory = ''

	for (const doc of DOCS) {
		// 搜索过滤
		if (lowerFilter) {
			const searchText = `${doc.title} ${doc.category} ${doc.content}`.toLowerCase()
			if (!searchText.includes(lowerFilter)) continue
		}

		// 分类标题
		if (doc.category !== lastCategory) {
			lastCategory = doc.category
			html += `<div class="text-xs text-base-content/40 font-medium px-2 pt-2 pb-1">${doc.category}</div>`
		}

		const isSelected = doc.id === currentDocId
		html += `
			<div class="beilu-preset-entry-item ${isSelected ? 'selected' : ''}" data-doc-id="${doc.id}">
				<div class="flex items-center gap-1">
					<span class="text-sm">${doc.icon}</span>
					<span class="text-sm font-medium truncate flex-grow">${doc.title}</span>
				</div>
			</div>
		`
	}

	if (!html) {
		html = '<p class="text-xs text-base-content/40 text-center py-4">无匹配结果</p>'
	}

	listEl.innerHTML = html

	// 绑定点击事件
	listEl.querySelectorAll('.beilu-preset-entry-item').forEach(item => {
		item.addEventListener('click', () => {
			const docId = item.dataset.docId
			if (docId) selectDoc(docId)
		})
	})
}

/**
 * 选中并显示文档
 * @param {string} docId
 */
function selectDoc(docId) {
	const doc = DOCS.find(d => d.id === docId)
	if (!doc) return

	currentDocId = docId

	// 更新列表高亮
	const listEl = document.getElementById('sv-doc-list')
	if (listEl) {
		listEl.querySelectorAll('.beilu-preset-entry-item').forEach(item => {
			item.classList.toggle('selected', item.dataset.docId === docId)
		})
	}

	// 显示文档内容
	const contentEl = document.getElementById('sv-doc-content')
	if (contentEl) {
		contentEl.innerHTML = `
			<div class="sv-doc-content-inner">
				${doc.content}
			</div>
		`
	}
}

/**
 * 绑定搜索事件
 */
function bindEvents() {
	const searchInput = document.getElementById('sv-search')
	if (searchInput) {
		searchInput.addEventListener('input', () => {
			renderDocList(searchInput.value.trim())
		})
	}
}