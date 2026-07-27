// beilu tutorial / visual novel engine — 100% JSON-driven, tuesday-js pattern
// 独立插件化: 本引擎可脱离beilu独立运行。外部依赖全部是可选增强(动态import+catch降级):
//   sendAction → 教程CRUD/pet-settings/图包列表(无beilu时直接传JSON给startTutorial绕过CRUD)
//   iframeRenderer → BGM多轨(无beilu时降级自持audio)
//   beiluLive2d → 角色渲染(无beilu时走img立绘)
// 独立使用: import { startTutorial } from "./tutorialEngine.mjs"; startTutorial(教程JSON);
// All visual parameters flow from tutorial JSON → CSS custom properties (--tut-*) → rendered styles.
// Zero hardcoded CSS color/size/font values in JS strings.
//
// Data model (tuesday-js pattern):
//   tutorial JSON = { id, title, version, character, parameters:{...}, blockName:[scenes...] }
//   parameters.launch_story = starting block name
//   each block = array of scenes; each scene = { background_*, dialogs:[...] }
//   each dialog = { text, name, color, color_text, art, choice, go_to, timer, variables, html, event, controll,
//                   await_click:"selector"|{selector,go_to} — spotlight引导, 用户真点目标元素才推进 }
//   art[] (tuesday-js原版格式, 与编辑器/教程JSON单源, 勿再引入object格式):
//     { id?, url | pack+expr, position:[left,right,top,bottom], size:[width,height], fit, opacity, move, speed,
//       motion:"enter"|"leave"|"shake"|"bounce", show_if }
//     pack+expr = 图包表情语义引用(游戏侧机制拉线): 渲染时经pack.json解析文件,
//       同表情多张随机取一(小圆机制, per-art固定防重渲闪换), 图包更新教程自动跟随; url字段优先
//     position/size 数组元素为CSS长度串, "0"/0=不设(tuesday.js:471同判); id缺省=数组索引(运动action按data-art-id寻址)
//   show_if = 字符串条件 "varName == value"(_evalShowIf唯一权威格式, 编辑器读写同源)
//   parameters.text_panel.pause_full/pause_half = 标点呼吸停顿倍数(字符节点演出, Alice机制)
//   parameters.text_panel.type_sound / dialog.type_sound = 每字符节点blip("snd:文件"|预设名)
//
// Pull from existing beilu systems:
//   window.beiluLive2d.reloadModel(name) — pack switching
//   beilu:emotion-changed event — expression changes
//   beilu:switchTab event — tab navigation

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let _overlay = null;
let _tutorial = null;   // full tutorial JSON
let _running = false;
let _resolve = null;     // current dialog await resolver
let _cleanup = [];
let _onEnd = null;

// Navigation pointers
let _blockName = "";     // current block name
let _sceneIdx = 0;       // current scene index within block
let _dialogIdx = 0;      // current dialog index within scene

// Variable store (from parameters.variables, mutated by dialog.variables)
let _vars = {};

// 导航历史栈: [{b,s,d}] 每次展示对话前push, "上一句"pop回退(只回位置, 变量不回滚)
let _history = [];

// Art layer persistence: array of current art objects (diffed across dialogs)
let _currentArt = [];

// Typewriter state
let _typeTimer = null;
let _typeComplete = false;

// Timer state (dialog.timer)
let _timerHandle = null;

// 打字机默认速度(ms/字) — 出厂默认单点, JSON的dialog.dialog_speed/parameters.text_panel.dialog_speed逐级覆盖
const DEFAULT_TYPE_SPEED_MS = 25;

// ═══════════════════════════════════════════════════════════════
// Action registry (custom actions invokable via dialog.event)
// ═══════════════════════════════════════════════════════════════

const _actions = new Map();

export function registerTutorialAction(name, fn) { _actions.set(name, fn); }

// Built-in actions: pull from existing beilu systems
registerTutorialAction("switchTab", async (args) => {
	window.dispatchEvent(new CustomEvent("beilu:switchTab", { detail: { tab: args?.tab } }));
});
registerTutorialAction("changePack", async (args) => {
	if (args?.name && window.beiluLive2d?.reloadModel) {
		await window.beiluLive2d.reloadModel(args.name);
	}
});
registerTutorialAction("setEmotion", (args) => {
	if (args?.emotion) window.dispatchEvent(new CustomEvent("beilu:emotion-changed", { detail: { emotion: args.emotion } }));
});
registerTutorialAction("scrollTo", (args) => {
	if (args?.selector) document.querySelector(args.selector)?.scrollIntoView({ behavior: "smooth", block: "center" });
});
registerTutorialAction("click", (args) => {
	if (args?.selector) document.querySelector(args.selector)?.click();
});
registerTutorialAction("delay", (args) => new Promise(r => setTimeout(r, args?.ms || Number(_userDefaults?.action_delay) || 1000)));

// ── 角色立绘运动系统(通过action调用或dialog.art[].motion指定) ──

// 角色入场: { id, url, position, size, motion:"enter" }
registerTutorialAction("charEnter", (args) => _charMotion(args?.id || "0", "entering"));
// 角色退场
registerTutorialAction("charLeave", (args) => _charMotion(args?.id || "0", "leaving"));
// 角色说话高亮(其他角色变暗)
registerTutorialAction("charSpeak", (args) => {
	const layer = _overlay?.querySelector("#tut-art-layer");
	if (!layer) return;
	layer.querySelectorAll(".tut-art").forEach(el => {
		if (el.dataset.artId === String(args?.id || "0")) {
			el.classList.add("speaking"); el.classList.remove("dimmed");
		} else {
			el.classList.add("dimmed"); el.classList.remove("speaking");
		}
	});
});
// 全部角色恢复正常
registerTutorialAction("charResetAll", () => {
	_overlay?.querySelector("#tut-art-layer")?.querySelectorAll(".tut-art").forEach(el => {
		el.classList.remove("speaking", "dimmed", "shaking", "bouncing", "entering", "leaving");
	});
});
// 角色震动
registerTutorialAction("charShake", (args) => _charMotion(args?.id || "0", "shaking"));
// 角色弹跳
registerTutorialAction("charBounce", (args) => _charMotion(args?.id || "0", "bouncing"));
// 角色移动到指定位置
registerTutorialAction("charMove", (args) => {
	const el = _overlay?.querySelector(`.tut-art[data-art-id="${args?.id || "0"}"]`);
	if (!el) return;
	if (args?.left != null) el.style.left = args.left;
	if (args?.right != null) el.style.right = args.right;
	if (args?.top != null) el.style.top = args.top;
	if (args?.bottom != null) el.style.bottom = args.bottom;
	if (args?.width != null) el.style.width = args.width;
	if (args?.height != null) el.style.height = args.height;
	if (args?.opacity != null) el.style.opacity = args.opacity;
});
// 角色切换图片(同一art slot换图)
registerTutorialAction("charSetImage", (args) => {
	const el = _overlay?.querySelector(`.tut-art[data-art-id="${args?.id || "0"}"] img`);
	if (el && args?.url) el.src = args.url;
});

function _charMotion(id, cls) {
	const el = _overlay?.querySelector(`.tut-art[data-art-id="${id}"]`);
	if (!el) return;
	el.classList.remove("entering", "leaving", "shaking", "bouncing");
	void el.offsetWidth; // force reflow for re-trigger
	el.classList.add(cls);
	if (cls === "leaving") {
		el.addEventListener("animationend", () => el.remove(), { once: true });
	} else {
		el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
	}
}

// ═══════════════════════════════════════════════════════════════
// CSS — static rules with var(--tut-*) custom properties
// All values flow from JSON parameters at runtime, never hardcoded here.
// ═══════════════════════════════════════════════════════════════

function _css() {
	return `
/* 所有数值走 --tut- 与 --bubble- 变量, 默认值单源=TUT_DEFAULTS(启动注入overlay), 此处零fallback字面量;
   oklch(var(--b*)...)=DaisyUI页面主题级联(非本系统默认值, 不进TUT_DEFAULTS)。
   注意: CSS注释内禁写 "星号斜杠" 形态的变量通配(如 --tut-星/), 会提前终结注释吞掉后续规则 */

#tut-overlay {
	position: fixed; inset: 0; z-index: var(--tut-z);
	font-family: var(--tut-font);
	pointer-events: none;
}
/* 交互白名单(精确列举, 不用 #tut-overlay * 全放行 — 那会以(0,1,1)特异性覆盖各层
   pointer-events:none, 全屏拦点击: "背景=操作界面"失效且spotlight洞放行不了)。
   凛倾图层语义: 只有角色(.tut-art)和对话框是实体, 其余全穿透; 角色用户可拖动挪开 */
#tut-text-panel, #tut-text-panel *,
#tut-html-layer.tut-visible, #tut-html-layer.tut-visible *,
#tut-choices, #tut-choices *,
.tut-art,
.tut-spot-mask { pointer-events: auto; }
/* 编辑态: 选项层不遮罩不拦点(看得到布局, 不挡立绘/对话框编辑), 按钮本身可点(编辑菜单) */
#tut-overlay.tut-editing #tut-choices { background: transparent; backdrop-filter: none; pointer-events: none; }
#tut-overlay.tut-editing .tut-choice-btn { pointer-events: auto; text-shadow: var(--tut-choice-shadow); }
.tut-art { cursor: grab; }
.tut-art.tut-dragging { cursor: grabbing; transition: none !important; }

/* 背景: 默认透明(当前界面=背景) */
#tut-bg { position: absolute; inset: 0; background: transparent; pointer-events: none; }

/* ── 角色立绘层 ── */
#tut-art-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }

.tut-art {
	position: absolute;
	transition-property: left, right, top, bottom, width, height, opacity, transform, filter;
	transition-timing-function: var(--tut-art-easing);
	transition-duration: var(--tut-art-speed);
	filter: brightness(1);
	transform-origin: bottom center; /* 小圆2.html:223 角色缩放/动作锚脚底 */
}
.tut-art img { width: 100%; height: 100%; object-fit: var(--tut-art-fit); pointer-events: none;
	filter: drop-shadow(0 0 15px var(--tut-art-glow)); /* 小圆2.html:221 立绘柔光 */ }

/* 角色运动状态 */
.tut-art.entering { animation: tut-art-enter var(--tut-art-enter-dur) var(--tut-art-easing) forwards; }
.tut-art.leaving  { animation: tut-art-leave var(--tut-art-leave-dur) var(--tut-art-easing) forwards; }
.tut-art.speaking { filter: brightness(1); transform: scale(var(--tut-art-speak-scale)); z-index: 10; }
.tut-art.dimmed   { filter: brightness(var(--tut-art-dim)); }
.tut-art.shaking  { animation: tut-art-shake var(--tut-art-shake-dur) ease; }
.tut-art.bouncing { animation: tut-art-bounce var(--tut-art-bounce-dur) ease; }

@keyframes tut-art-enter {
	from { opacity: 0; transform: translateY(var(--tut-art-enter-y)) scale(var(--tut-art-enter-scale)); }
	to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes tut-art-leave {
	from { opacity: 1; transform: translateY(0) scale(1); }
	to   { opacity: 0; transform: translateY(var(--tut-art-leave-y)) scale(var(--tut-art-leave-scale)); }
}
@keyframes tut-art-shake {
	0%,100% { transform: translateX(0); }
	20% { transform: translateX(var(--tut-art-shake-x)); }
	40% { transform: translateX(var(--tut-art-shake-x2)); }
	60% { transform: translateX(var(--tut-art-shake-x3)); }
	80% { transform: translateX(var(--tut-art-shake-x4)); }
}
@keyframes tut-art-bounce {
	0%,100% { transform: translateY(0); }
	40% { transform: translateY(var(--tut-art-bounce-y)); }
	60% { transform: translateY(var(--tut-art-bounce-y2)); }
}

/* ── 对话框: --bubble-*与桌宠气泡配置同源(pet-settings拉线注入, TUT_DEFAULTS离线兜底) ── */
#tut-text-panel {
	display: none; z-index: 2;
	position: fixed;
	left: var(--tut-panel-left);
	bottom: var(--tut-panel-bottom);
	transform: var(--tut-panel-transform);
	width: var(--tut-panel-width);
	min-height: var(--tut-panel-min-h);
	max-height: var(--tut-panel-max-h);
	overflow-y: auto;
	padding: var(--tut-panel-padding);
	border-radius: var(--bubble-radius);
	background: var(--bubble-bg);
	backdrop-filter: blur(var(--tut-panel-blur)); /* 小圆2.html:462 磨砂质感 */
	color: var(--bubble-fg);
	box-shadow: 0 10px 40px var(--tut-panel-shadow),
	            inset 0 0 0 1px var(--bubble-border);
	font-size: var(--bubble-fs);
	/* white-space只在#tut-text上——panel整体pre-wrap会把模板HTML的换行缩进渲染成空白行(0715凛倾截图大留白根因) */
	word-break: break-word;
	cursor: pointer;
	animation: tut-fade-in var(--tut-panel-anim-dur) ease;
}
#tut-text-panel.tut-visible { display: block; }
/* 引导点击避让(spotlight目标被面板遮挡时): id+class特异性压过基础规则, 无需!important */
#tut-text-panel.tut-avoid-top { bottom: auto; top: var(--tut-avoid-top); }
#tut-text-panel.tut-avoid-bottom { top: auto; bottom: var(--tut-panel-bottom); }

#tut-name {
	font-size: var(--tut-name-size); font-weight: 700;
	color: var(--bubble-name-color);
	margin-bottom: var(--tut-name-gap);
}
#tut-name:empty { display: none; }

#tut-text {
	font-size: var(--bubble-fs);
	color: var(--bubble-fg);
	line-height: var(--tut-text-lh);
	white-space: pre-wrap;
	/* 小圆2.html:500-505 文字区固定行高带滚动: 长文不撑爆对话框 */
	min-height: var(--tut-text-min-h);
	max-height: var(--tut-text-max-h);
	overflow-y: auto;
	padding-right: 0.8vw;
}
#tut-text::-webkit-scrollbar { width: 6px; }
#tut-text::-webkit-scrollbar-track { background: rgba(0,0,0,.05); border-radius: 3px; }
#tut-text::-webkit-scrollbar-thumb { background: var(--bubble-border); border-radius: 3px; }

/* ── 选项: 小圆2.html:888-951 "选择时刻"全屏层 — 模糊遮罩+竖排大按钮+逐项错开上滑 ── */
#tut-choices {
	position: fixed; inset: 0; z-index: 4;
	display: flex; flex-direction: column; justify-content: center; align-items: center;
	gap: var(--tut-choice-gap);
	background: var(--tut-choice-dim);
	backdrop-filter: blur(var(--tut-choice-blur));
	/* 小圆2.html:900 遮罩入场=纯淡入(无位移), 与对话框的tut-fade-in(带translateY)区分 */
	animation: tut-choices-in var(--tut-choice-overlay-dur) ease;
	overflow-y: auto; padding: 5vh 5vw;
}
@keyframes tut-choices-in { from { opacity: 0; } to { opacity: 1; } }
#tut-choices:empty { display: none; }
.tut-choice-btn {
	background: transparent; border: none;
	padding: var(--tut-choice-pad);
	border-radius: var(--tut-choice-radius);
	cursor: pointer; transition: all var(--tut-choice-anim);
	font-size: var(--tut-choice-fs);
	font-weight: 500; text-align: center;
	color: var(--tut-choice-fg);
	text-shadow: var(--tut-choice-shadow);
	animation: tut-choice-up var(--tut-choice-enter-dur) var(--tut-choice-enter-ease) backwards; /* 小圆slideUpOption同曲线 */
}
.tut-choice-btn:hover {
	transform: scale(1.05);
	background: var(--tut-choice-hover-bg); color: var(--tut-choice-hover-fg); /* 小圆2.html:940 悬停提亮到纯白 */
}
@keyframes tut-choice-up {
	from { opacity: 0; transform: translateY(var(--tut-choice-enter-y)); }
	to   { opacity: 1; transform: translateY(0); }
}

/* ── 控制按钮 ── */
#tut-next {
	position: absolute;
	right: var(--tut-next-right); bottom: var(--tut-next-bottom);
	width: var(--tut-next-size); height: var(--tut-next-size);
	border-radius: 50%;
	border: 1px solid var(--bubble-border);
	background: transparent; color: var(--bubble-name-color);
	font-size: var(--tut-next-fs); cursor: pointer;
	display: none; align-items: center; justify-content: center;
	transition: all var(--tut-btn-anim);
}
#tut-next:hover { background: color-mix(in oklch, var(--color-warning) 15%, transparent); }
#tut-next.tut-visible { display: flex; }

/* 上一句(driver.js默认三键范式: 点过头可回看; 变量不回滚, 只回位置) */
#tut-back {
	position: absolute;
	right: calc(var(--tut-next-right) + var(--tut-next-size) + 6px); bottom: var(--tut-next-bottom);
	width: var(--tut-next-size); height: var(--tut-next-size);
	border-radius: 50%;
	border: 1px solid var(--bubble-border);
	background: transparent; color: var(--bubble-name-color);
	font-size: var(--tut-next-fs); cursor: pointer;
	display: none; align-items: center; justify-content: center;
	opacity: .6;
	transition: all var(--tut-btn-anim);
}
#tut-back:hover { background: color-mix(in oklch, var(--color-warning) 15%, transparent); opacity: 1; }
#tut-back.tut-visible { display: flex; }

/* 线路内进度(产品引导范式: 进度指示提升完成率; text_panel.show_progress=false 可关) */
#tut-progress {
	position: absolute; left: var(--tut-next-right); bottom: var(--tut-next-bottom);
	height: var(--tut-next-size);
	display: none; align-items: center;
	font-size: var(--tut-progress-fs); opacity: .4; pointer-events: none;
}
#tut-progress.tut-visible { display: flex; }

#tut-skip {
	position: absolute;
	right: var(--tut-skip-right); top: var(--tut-skip-top);
	padding: var(--tut-skip-pad);
	border-radius: var(--tut-skip-radius);
	border: 1px solid var(--color-base-300);
	background: color-mix(in oklch, var(--color-base-200) 60%, transparent); color: color-mix(in oklch, var(--color-base-content) 40%, transparent);
	font-size: var(--tut-skip-fs); cursor: pointer;
	transition: all var(--tut-btn-anim);
}
#tut-skip:hover { background: var(--color-error); color: var(--color-error-content); border-color: var(--color-error); }

#tut-html-layer {
	position: absolute; inset: 0; z-index: 3;
	display: none; align-items: center; justify-content: center; pointer-events: none;
}
#tut-html-layer.tut-visible { display: flex; pointer-events: auto; }

/* ── spotlight 引导点击: 4遮罩围洞(洞区放行真实点击, driver.js镂空同理) + 呼吸描边 ── */
#tut-spot-layer { position: absolute; inset: 0; pointer-events: none; display: none; z-index: 1; }
#tut-spot-layer.tut-visible { display: block; }
.tut-spot-mask { position: absolute; background: var(--tut-spot-dim); pointer-events: auto; }
#tut-spot-ring {
	position: absolute; pointer-events: none;
	border: var(--tut-spot-ring-w) solid var(--color-warning);
	border-radius: var(--tut-spot-radius);
	animation: tut-spot-pulse var(--tut-spot-pulse-dur) ease-in-out infinite;
}
@keyframes tut-spot-pulse {
	0%,100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--color-warning) 50%, transparent); }
	50%     { box-shadow: 0 0 0 var(--tut-spot-pulse-spread) color-mix(in oklch, var(--color-warning) 0%, transparent); }
}

@keyframes tut-fade-in {
	from { opacity: 0; transform: translateY(var(--tut-fade-y)); }
	to   { opacity: 1; transform: translateY(0); }
}
.tut-fade-in { animation: tut-fade-in var(--tut-fade-dur) ease; }

#tut-bgm { display: none; }
	`;
}

// ═══════════════════════════════════════════════════════════════
// DOM construction
// ═══════════════════════════════════════════════════════════════

function _ensureOverlay() {
	if (_overlay) return;
	_overlay = document.createElement("div");
	_overlay.id = "tut-overlay";
	_overlay.innerHTML = `
		<div id="tut-bg"></div>
		<div id="tut-spot-layer"></div>
		<div id="tut-art-layer"></div>
		<div id="tut-text-panel">
			<button id="tut-skip">跳过</button>
			<div id="tut-name"></div>
			<div id="tut-text"></div>
			<span id="tut-progress"></span>
			<div id="tut-back" title="上一句">&#9664;</div>
			<div id="tut-next">&#9654;</div>
		</div>
		<div id="tut-choices"></div>
		<div id="tut-html-layer"></div>
		<audio id="tut-bgm" loop></audio>
	`;
	const style = document.createElement("style");
	style.textContent = _css();
	_overlay.prepend(style);
	document.body.appendChild(_overlay);

	// Static event listeners
	// skip=中断非完成: 显式空opts, 防event对象误入opts位; 存档保留供续玩(resume:"ask"入口续读)
	_overlay.querySelector("#tut-skip").addEventListener("click", () => stop({}));
	_overlay.querySelector("#tut-next").addEventListener("click", _onNextClick);
	_overlay.querySelector("#tut-back").addEventListener("click", _onBackClick);
	_overlay.querySelector("#tut-text").addEventListener("click", _onTextClick);
}

// ═══════════════════════════════════════════════════════════════
// CSS custom property injection from JSON parameters
// ═══════════════════════════════════════════════════════════════

// 默认值单源: 所有视觉参数的出厂默认集中在此, CSS里零fallback
// 教程JSON parameters可逐键覆盖; pet-settings用户配色经_applyBubbleTheme回填
// export: 编辑器预览画布注入同一份默认值(预览=运行时同源, 防两套色值)
export const TUT_DEFAULTS = {
	"--tut-z": "99999",
	"--tut-font": "system-ui, -apple-system, sans-serif",
	"--tut-art-speed": "0.4s",
	"--tut-art-easing": "ease",
	"--tut-art-fit": "contain",
	"--tut-art-enter-dur": "0.5s",
	"--tut-art-leave-dur": "0.4s",
	"--tut-art-enter-y": "30px",
	"--tut-art-enter-scale": "0.95",
	"--tut-art-leave-y": "-20px",
	"--tut-art-leave-scale": "0.95",
	"--tut-art-speak-scale": "1.03",
	"--tut-art-dim": "0.55",
	"--tut-art-shake-dur": "0.4s",
	"--tut-art-shake-x": "-8px",
	"--tut-art-shake-x2": "6px",
	"--tut-art-shake-x3": "-4px",
	"--tut-art-shake-x4": "2px",
	"--tut-art-bounce-dur": "0.5s",
	"--tut-art-bounce-y": "-15px",
	"--tut-art-bounce-y2": "-5px",
	// 出厂视觉值=弹性相对单位(clamp/vw/vh, 小圆cqw范式): 任意窗口等比自适应, 不是死px;
	// 每键仍可被 _defaults.json / 教程JSON text_panel / 编辑器拖拽与滑条覆盖
	"--tut-panel-left": "50%",
	"--tut-panel-bottom": "2.5vh",
	"--tut-panel-transform": "translateX(-50%)",
	// 对话框结构比例=小圆2.html:457-505(62.5cqw宽/24px圆角/24×32padding/文字3行滚动/blur磨砂)
	"--tut-panel-width": "min(62.5vw, 800px)",
	"--tut-panel-min-h": "auto",
	"--tut-panel-max-h": "38vh",
	"--tut-panel-blur": "4px",
	"--tut-panel-padding": "clamp(14px, 1.9vw, 24px) clamp(18px, 2.5vw, 32px)",
	"--tut-panel-shadow": "rgba(0,0,0,0.05)",
	"--tut-text-min-h": "3.4em",
	"--tut-text-max-h": "4.5em",
	"--tut-art-glow": "rgba(255,255,255,0.2)",
	"--tut-panel-anim-dur": "0.22s",
	"--tut-name-size": "clamp(11px, 1.2vw, 14px)",
	"--tut-name-gap": "clamp(2px, 0.5vh, 6px)",
	"--tut-text-lh": "1.55",
	// 选项"选择时刻"层=小圆2.html:888-951(遮罩0.2黑+blur8/大字1.4em/15×25pad/15圆角/0.05s错开)
	"--tut-choice-gap": "clamp(10px, 1.8vh, 18px)",
	"--tut-choice-dim": "rgba(0,0,0,0.2)",
	"--tut-choice-blur": "8px",
	"--tut-choice-pad": "clamp(10px, 1.8vh, 16px) clamp(18px, 2.4vw, 28px)",
	"--tut-choice-radius": "15px",
	"--tut-choice-anim": "0.2s",
	"--tut-choice-fs": "clamp(16px, 1.9vw, 23px)",
	"--tut-choice-fg": "#f0f0f0",
	"--tut-choice-stagger": "0.05s",
	"--tut-choice-shadow": "0 1px 5px rgba(0,0,0,0.7)",
	"--tut-choice-hover-bg": "rgba(255,255,255,0.1)",
	"--tut-choice-hover-fg": "#fff",
	"--tut-choice-overlay-dur": "0.3s",
	"--tut-choice-enter-y": "20px",
	"--tut-choice-enter-dur": "0.4s",
	"--tut-choice-enter-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
	"--tut-progress-fs": "10px",
	"--tut-next-right": "12px",
	"--tut-next-bottom": "10px",
	"--tut-next-size": "28px",
	"--tut-next-fs": "14px",
	"--tut-btn-anim": "0.15s",
	"--tut-skip-right": "12px",
	"--tut-skip-top": "8px",
	"--tut-skip-pad": "2px 10px",
	"--tut-skip-radius": "4px",
	"--tut-skip-fs": "11px",
	"--tut-fade-y": "8px",
	"--tut-fade-dur": "0.4s",
	// spotlight 引导点击(await_click)
	"--tut-avoid-top": "5vh",
	"--tut-spot-pad": "6px",
	"--tut-spot-radius": "8px",
	"--tut-spot-dim": "rgba(0,0,0,0.45)",
	"--tut-spot-ring-w": "2px",
	"--tut-spot-pulse-dur": "1.6s",
	"--tut-spot-pulse-spread": "6px",
	// 帮助模式图标(help_points)与桌宠教程按钮 — 挂在overlay子树之外(各板块内/body),
	// 变量经_applyHelpVars注入:root才解析得到(overlay inline style的继承链够不到它们)
	"--tut-desk-offset": "14px",
	"--tut-desk-pad": "8px 14px",
	"--tut-desk-fs": "13px",
	"--tut-desk-radius": "999px",
	"--tut-desk-shadow": "0 4px 14px rgba(0,0,0,0.3)",
	"--tut-help-size": "28px",
	"--tut-help-bg": "var(--color-warning, #f0a020)",
	"--tut-help-fg": "#fff",
	"--tut-help-fs": "16px",
	"--tut-help-border": "rgba(255,255,255,0.6)",
	"--tut-help-pulse-dur": "1.5s",
	"--tut-help-hover-scale": "1.3",
	"--tut-help-offset": "-6px",
	// pet-bubble风格默认(拉线: 如果beilu已有--bubble-*变量则自动级联, 此处是离线兜底)
	"--bubble-radius": "14px",
	"--bubble-bg": "rgba(255, 252, 245, 0.95)",
	"--bubble-fg": "#3a2c12",
	"--bubble-border": "rgba(245, 197, 66, 0.55)",
	"--bubble-name-color": "#b8860b",
	"--bubble-fs": "clamp(13px, 1.4vw, 16px)",
};

// ── 出厂默认的数据覆盖层(硬编码根治四判据: 单点默认+数据文件可覆盖) ──
// data/tutorials/_defaults.json 经 plugins:beilu-tutorial#getTutorialDefaults 拉取;
// "--"开头键覆盖CSS变量, 其余键(如 art_default_pos)供编辑器行为默认消费
let _userDefaults = null;    // 解析结果缓存
let _userDefaultsP = null;   // in-flight Promise缓存 — 并发首调(编辑器+startTutorial同时)只发一个GET

export async function loadTutorialDefaults() {
	if (_userDefaults !== null) return _userDefaults;
	_userDefaultsP ??= _sa("getTutorialDefaults")
		.then(d => (_userDefaults = d || {}))
		.catch(() => (_userDefaults = {})); // 离线: 出厂值兜底, 诚实降级
	return _userDefaultsP;
}

/**
 * JSON parameters → CSS变量 的唯一映射(export: 编辑器预览传自己的style复用同一份映射, 防两处各写一套)
 * 注入优先级: TUT_DEFAULTS出厂 < _defaults.json覆盖层 < pet-settings(_applyBubbleTheme异步) < 教程JSON params
 * @param {object} params - tutorial.parameters
 * @param {CSSStyleDeclaration} [styleTarget] - 缺省=运行时overlay
 */
export function applyTutCSSVars(params, styleTarget) {
	const s = styleTarget || _overlay?.style;
	if (!s) return;

	// 1. 注入全部默认值(出厂 + 数据覆盖层)
	for (const [k, v] of Object.entries(TUT_DEFAULTS)) s.setProperty(k, v);
	if (_userDefaults) {
		for (const [k, v] of Object.entries(_userDefaults)) {
			if (k.startsWith("--")) s.setProperty(k, String(v));
		}
	}

	if (!params) return;

	// 2. 教程JSON parameters覆盖(有就覆盖, 没有就用默认)
	const tp = params.text_panel;
	if (tp) {
		if (tp.color) s.setProperty("--bubble-bg", tp.color);
		if (tp.color_text) s.setProperty("--bubble-fg", tp.color_text);
		// opacity无color时: 基于当前--bubble-bg换alpha, 不另立色值(单源=TUT_DEFAULTS/已注入值)
		if (tp.opacity != null && !tp.color) {
			const base = s.getPropertyValue("--bubble-bg") || TUT_DEFAULTS["--bubble-bg"];
			const m = base.match(/^rgba?\(([^,]+),([^,]+),([^,)]+)/);
			if (m) s.setProperty("--bubble-bg", `rgba(${m[1]},${m[2]},${m[3]},${tp.opacity})`);
		}
		if (tp.size_text) s.setProperty("--bubble-fs", tp.size_text);
		if (tp.font_family) s.setProperty("--tut-font", tp.font_family);
		if (tp.radius != null) s.setProperty("--bubble-radius", tp.radius + "px");
		if (tp.border_color) s.setProperty("--bubble-border", tp.border_color);
		if (tp.name_color) s.setProperty("--bubble-name-color", tp.name_color);
		if (tp.dialog_speed != null) s.setProperty("--tut-panel-anim-dur", Math.max(0.05, tp.dialog_speed / 1000) + "s");
		if (tp.width) s.setProperty("--tut-panel-width", tp.width);
		if (tp.padding) s.setProperty("--tut-panel-padding", tp.padding);
		if (tp.bottom) s.setProperty("--tut-panel-bottom", tp.bottom);
		if (tp.left) s.setProperty("--tut-panel-left", tp.left);
	}

	// 2b. 选项"选择时刻"层可调键(凛倾: 自适应+可调整)
	if (tp) {
		if (tp.choice_size != null) s.setProperty("--tut-choice-fs", tp.choice_size + "px");
		if (tp.choice_dim != null) s.setProperty("--tut-choice-dim", `rgba(0,0,0,${tp.choice_dim})`);
		if (tp.choice_blur != null) s.setProperty("--tut-choice-blur", tp.choice_blur + "px");
	}

	// 3. 角色运动参数覆盖
	const art = params.art;
	if (art) {
		if (art.speed) s.setProperty("--tut-art-speed", art.speed);
		if (art.enter_dur) s.setProperty("--tut-art-enter-dur", art.enter_dur);
		if (art.leave_dur) s.setProperty("--tut-art-leave-dur", art.leave_dur);
		if (art.speak_scale) s.setProperty("--tut-art-speak-scale", String(art.speak_scale));
		if (art.dim) s.setProperty("--tut-art-dim", String(art.dim));
	}

	// 4. 自定义CSS变量(教程JSON可任意追加--tut-*变量)
	if (params.css_vars && typeof params.css_vars === "object") {
		for (const [k, v] of Object.entries(params.css_vars)) {
			if (k.startsWith("--")) s.setProperty(k, String(v));
		}
	}
}

// ═══════════════════════════════════════════════════════════════
// pet-bubble 真拉线: --bubble-* 与桌宠气泡用户配置同源
// 读链: GET /api/eye/pet-settings(server:eye#getPetSettings, companion.mjs:526 同门面)
// 优先级: 教程JSON parameters.text_panel > pet-settings用户配置 > TUT_DEFAULTS离线兜底
// 非阻塞: 拉取失败/超时不拦启动(CSS var 迟到 setProperty 即时生效)
// ═══════════════════════════════════════════════════════════════

function _hexToRgba(hex, alpha) {
	const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** TUT_DEFAULTS 里 --bubble-bg 的 alpha(出厂透明度), 不另立数字 */
function _defaultBubbleAlpha() {
	const m = TUT_DEFAULTS["--bubble-bg"].match(/,\s*([\d.]+)\s*\)$/);
	return m ? Number(m[1]) : 1;
}

function _applyBubbleTheme(params) {
	const tp = params?.text_panel || {};
	_saEye("getPetSettings").then(ps => {
		if (!_overlay || !ps) return;
		const s = _overlay.style;
		// 空串/-1/0 = 用户未配(跟随默认), 教程JSON的color覆盖时不回填;
		// 教程只设opacity时=用户底色(pet-settings/出厂)+教程alpha合成(不顶回出厂色)
		if (!tp.color) {
			const alpha = tp.opacity != null ? Number(tp.opacity)
				: (ps.bubbleOpacity != null && Number.isFinite(Number(ps.bubbleOpacity)))
					? Number(ps.bubbleOpacity) : _defaultBubbleAlpha();
			if (ps.bubbleColor) {
				const rgba = _hexToRgba(ps.bubbleColor, alpha);
				if (rgba) s.setProperty("--bubble-bg", rgba);
			} else if (tp.opacity != null || ps.bubbleOpacity != null) {
				const m = TUT_DEFAULTS["--bubble-bg"].match(/^rgba?\(([^,]+),([^,]+),([^,)]+)/);
				if (m) s.setProperty("--bubble-bg", `rgba(${m[1]},${m[2]},${m[3]},${alpha})`);
			}
		}
		if (!tp.color_text && ps.bubbleTextColor) s.setProperty("--bubble-fg", ps.bubbleTextColor);
		if (tp.radius == null && typeof ps.bubbleRadius === "number" && ps.bubbleRadius >= 0) s.setProperty("--bubble-radius", ps.bubbleRadius + "px");
		if (!tp.border_color && ps.bubbleBorderColor) s.setProperty("--bubble-border", ps.bubbleBorderColor);
		if (!tp.name_color && ps.bubbleNameColor) s.setProperty("--bubble-name-color", ps.bubbleNameColor);
		if (!tp.size_text && Number(ps.bubbleFontSize) > 0) s.setProperty("--bubble-fs", Number(ps.bubbleFontSize) + "px");
	}).catch(e => console.debug("[tutorial] pet-settings fallback:", e?.message));
}

// ═══════════════════════════════════════════════════════════════
// Variable system
// ═══════════════════════════════════════════════════════════════

function _initVars(params) {
	_vars = {};
	if (params?.variables && typeof params.variables === "object") {
		_vars = { ...params.variables };
	}
}

/** Apply variable mutations from a dialog's variables array: [[name, "add"|"set", value], ...] */
function _mutateVars(mutations) {
	if (!Array.isArray(mutations)) return;
	for (const entry of mutations) {
		if (!Array.isArray(entry) || entry.length < 3) continue;
		const [name, op, value] = entry;
		if (op === "set") {
			_vars[name] = value;
		} else if (op === "add") {
			_vars[name] = (Number(_vars[name]) || 0) + (Number(value) || 0);
		}
	}
}

/** Interpolate <varName> placeholders in text */
function _interpolate(text) {
	if (typeof text !== "string") return text ?? "";
	return text.replace(/<([^>]+)>/g, (match, key) => {
		if (key in _vars) return String(_vars[key]);
		// Check if it is a character reference from parameters.characters
		const chars = _tutorial?.parameters?.characters;
		if (chars?.[key]?.name) return chars[key].name;
		return match; // leave unchanged if not a known variable
	});
}

export const SHOW_IF_RE = /^\s*(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;

function _evalShowIf(condition) {
	if (!condition || typeof condition !== "string") return true;
	const m = condition.match(SHOW_IF_RE);
	if (!m) {
		// Simple truthy check: "varName" means _vars[varName] is truthy
		if (condition.startsWith("!")) return !_vars[condition.slice(1)];
		return !!_vars[condition];
	}
	const [, varName, op, rawVal] = m;
	const left = _vars[varName];
	// Try numeric comparison first
	const numL = Number(left);
	const numR = Number(rawVal);
	const isNumeric = !isNaN(numL) && !isNaN(numR);
	switch (op) {
		case "==": return isNumeric ? numL === numR : String(left) === rawVal;
		case "!=": return isNumeric ? numL !== numR : String(left) !== rawVal;
		case ">":  return numL > numR;
		case "<":  return numL < numR;
		case ">=": return numL >= numR;
		case "<=": return numL <= numR;
	}
	return true;
}

// ═══════════════════════════════════════════════════════════════
// Art layer system — images persist across dialogs (diff/reuse)
// ═══════════════════════════════════════════════════════════════

/**
 * 立绘布局单源（tuesday-js原版数组格式, tuesday.js:455-475同构）。
 * 引擎运行时与编辑器预览画布共用此函数 — 定位逻辑只此一份, 防预览≠运行时。
 * @param {HTMLElement} el - .tut-art / .te-canvas-art 容器
 * @param {object} art - { position:[l,r,t,b], size:[w,h], fit, opacity, move, speed }
 */
export function applyArtLayout(el, art) {
	// position: [left,right,top,bottom], "0"/0=不设该边(tuesday-js同判); 后设边清对边防残留
	const pos = art.position;
	if (Array.isArray(pos)) {
		if (pos[0] && pos[0] !== "0") { el.style.right = ""; el.style.left = pos[0]; }
		if (pos[1] && pos[1] !== "0") { el.style.left = ""; el.style.right = pos[1]; }
		if (pos[2] && pos[2] !== "0") { el.style.bottom = ""; el.style.top = pos[2]; }
		if (pos[3] && pos[3] !== "0") { el.style.top = ""; el.style.bottom = pos[3]; }
	}
	// size: [width,height]
	const sz = art.size;
	if (Array.isArray(sz)) {
		if (sz[0]) el.style.width = sz[0];
		if (sz[1]) el.style.height = sz[1];
	}
	if (art.speed != null) el.style.setProperty("--tut-art-speed", art.speed + "s");
	const img = el.querySelector("img");
	if (art.fit && img) img.style.objectFit = art.fit;
	el.style.opacity = art.opacity != null ? String(art.opacity) : "1";
	// move: CSS transform串, transition推着走
	if (art.move) el.style.transform = art.move;
}

// ── 图包表情引用解析(游戏侧机制拉线) ──
// resolveArtUrl=纯函数(数据由调用方给, 无隐藏状态时序); 引擎运行时用_packCache, 编辑器传自己的_packs
let _packCache = null;      // [{name, expressions, default}] 运行时缓存
const _artUrlMemo = new WeakMap(); // art对象→已解析url: 同表情多张随机取一后固定, 防dialog重渲随机闪换

/** @param {object} art @param {Array} packs listImagepacks形状 @returns {string} url("":解析失败) */
export function resolveArtUrl(art, packs) {
	if (art.url) return art.url;
	if (!art.pack || !art.expr) return "";
	if (_artUrlMemo.has(art)) return _artUrlMemo.get(art);
	const p = (packs || []).find(x => x.name === art.pack);
	const files = p?.expressions?.[art.expr];
	let url = "";
	if (Array.isArray(files) && files.length) {
		const f = files[Math.floor(Math.random() * files.length)]; // 小圆机制: 同表情多张随机
		url = `/api/eye/user-images/${encodeURIComponent(art.pack)}/${encodeURIComponent(f)}`;
	}
	_artUrlMemo.set(art, url);
	return url;
}

/** 教程含pack引用时预拉图包数据(startTutorial时机, 之后_applyArt同步查) */
async function _ensurePacks(script) {
	if (_packCache) return;
	try { if (JSON.stringify(script).includes('"pack"')) _packCache = await listImagepacks(); }
	catch { _packCache = []; }
}

/** 读元素当前生效的过渡时长(ms), 供移除动画收尾 — 与--tut-art-speed同源, 不另立数字 */
function _artSpeedMs(el) {
	const v = parseFloat(getComputedStyle(el).getPropertyValue("--tut-art-speed"));
	return Number.isFinite(v) && v > 0 ? v * 1000 : parseFloat(TUT_DEFAULTS["--tut-art-speed"]) * 1000;
}

function _applyArt(artArray) {
	const layer = _overlay?.querySelector("#tut-art-layer");
	if (!layer) return;

	// If dialog has no art field, keep current art (persistence)
	if (!artArray) return;

	// Filter by show_if; url=裸url或pack+expr解析(游戏侧图包机制, 解析失败=诚实不渲染)
	const desired = artArray.filter(a => _evalShowIf(a.show_if) && resolveArtUrl(a, _packCache));

	// Remove art elements that are no longer in the desired set
	const desiredUrls = new Set(desired.map(a => resolveArtUrl(a, _packCache)));
	const existing = new Map(); // url -> element
	for (const el of [...layer.children]) {
		const url = el.dataset.url;
		if (!desiredUrls.has(url)) {
			el.style.opacity = "0";
			setTimeout(() => el.remove(), _artSpeedMs(el));
		} else {
			existing.set(url, el);
		}
	}

	// Add or update art elements
	desired.forEach((art, idx) => {
		const url = resolveArtUrl(art, _packCache);
		let el = existing.get(url);
		const isNew = !el;
		if (isNew) {
			el = document.createElement("div");
			el.className = "tut-art tut-fade-in";
			el.dataset.url = url;
			el.innerHTML = `<img src="${_escAttr(url)}" />`;
			layer.appendChild(el);
		}
		// 运动action寻址锚点: charEnter/charSpeak/charMove等按data-art-id查, 必与此同源
		el.dataset.artId = art.id != null ? String(art.id) : String(idx);

		// 角色=实体可拖(凛倾: 用户触发后可移动角色挪开视线); 会话级位置, 不写回JSON
		if (isNew) _bindRuntimeArtDrag(el);

		applyArtLayout(el, art);

		// motion: 声明式运动(enter/leave/shake/bounce) — 与action系_charMotion同一class体系
		if (art.motion) {
			const cls = { enter: "entering", leave: "leaving", shake: "shaking", bounce: "bouncing" }[art.motion];
			// enter只在元素新建时播, 其余每次声明都触发
			if (cls && (art.motion !== "enter" || isNew)) _charMotion(el.dataset.artId, cls);
		}
	});

	_currentArt = desired;
}

/** 运行时角色拖动: mousedown拖=改left/top(清right/bottom锚), 拖过5px内不算(区分点击) */
function _bindRuntimeArtDrag(el) {
	el.addEventListener("mousedown", (e) => {
		if (e.button !== 0 || _editMode) return; // 编辑态由编辑器拖动(写回JSON), 运行时拖=会话级挪开
		const sx = e.clientX, sy = e.clientY;
		const r = el.getBoundingClientRect();
		const offX = sx - r.left, offY = sy - r.top;
		let moved = false;
		const mv = (ev) => {
			if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
			moved = true;
			el.classList.add("tut-dragging");
			el.style.right = ""; el.style.bottom = "";
			el.style.left = (ev.clientX - offX) + "px";
			el.style.top = (ev.clientY - offY) + "px";
		};
		const up = () => {
			document.removeEventListener("mousemove", mv);
			document.removeEventListener("mouseup", up);
			el.classList.remove("tut-dragging");
		};
		document.addEventListener("mousemove", mv);
		document.addEventListener("mouseup", up);
	});
}

function _clearArt() {
	const layer = _overlay?.querySelector("#tut-art-layer");
	if (layer) layer.innerHTML = "";
	_currentArt = [];
}

// ═══════════════════════════════════════════════════════════════
// Spotlight 引导点击 (dialog.await_click: "selector" | {selector, go_to})
// 4遮罩围洞: 洞区=目标元素真实可点(遮罩pointer-events:auto拦周围, 洞无遮罩放行), driver.js镂空同理
// ═══════════════════════════════════════════════════════════════

let _awaitingClick = false;  // 等待引导点击期间, 文本点击/next不推进
let _spotRedraw = null;      // scroll/resize 重绘句柄(cleanup用)

function _spotPadPx(layer) {
	const v = parseFloat(getComputedStyle(layer).getPropertyValue("--tut-spot-pad"));
	return Number.isFinite(v) ? v : parseFloat(TUT_DEFAULTS["--tut-spot-pad"]);
}

function _showSpotlight(target) {
	const layer = _overlay?.querySelector("#tut-spot-layer");
	if (!layer || !target) return false;
	layer.innerHTML = `
		<div class="tut-spot-mask" data-m="t"></div><div class="tut-spot-mask" data-m="b"></div>
		<div class="tut-spot-mask" data-m="l"></div><div class="tut-spot-mask" data-m="r"></div>
		<div id="tut-spot-ring"></div>`;
	const q = (m) => layer.querySelector(`[data-m="${m}"]`);
	const ring = layer.querySelector("#tut-spot-ring");
	const draw = () => {
		const r = target.getBoundingClientRect();
		const p = _spotPadPx(layer);
		const x = r.left - p, y = r.top - p, w = r.width + p * 2, h = r.height + p * 2;
		Object.assign(q("t").style, { left: "0", top: "0", right: "0", height: Math.max(0, y) + "px" });
		Object.assign(q("b").style, { left: "0", top: (y + h) + "px", right: "0", bottom: "0" });
		Object.assign(q("l").style, { left: "0", top: y + "px", width: Math.max(0, x) + "px", height: h + "px" });
		Object.assign(q("r").style, { left: (x + w) + "px", top: y + "px", right: "0", height: h + "px" });
		Object.assign(ring.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
		// 对话框避让: 引导目标与对话框相交=面板挡住用户要点的东西(底部目标如输入框必撞),
		// 目标在下半屏→面板去顶部, 在上半屏→面板去底部; 不相交=保持原位
		const panel = _overlay?.querySelector("#tut-text-panel");
		if (panel) {
			const pr = panel.getBoundingClientRect();
			const overlap = !(x + w < pr.left || pr.right < x || y + h < pr.top || pr.bottom < y);
			panel.classList.remove("tut-avoid-top", "tut-avoid-bottom");
			if (overlap) panel.classList.add(y + h / 2 > innerHeight / 2 ? "tut-avoid-top" : "tut-avoid-bottom");
		}
	};
	draw();
	_spotRedraw = draw;
	window.addEventListener("scroll", draw, true);
	window.addEventListener("resize", draw, true);
	layer.classList.add("tut-visible");
	return true;
}

function _hideSpotlight() {
	const layer = _overlay?.querySelector("#tut-spot-layer");
	if (layer) { layer.classList.remove("tut-visible"); layer.innerHTML = ""; }
	_overlay?.querySelector("#tut-text-panel")?.classList.remove("tut-avoid-top", "tut-avoid-bottom");
	if (_spotRedraw) {
		window.removeEventListener("scroll", _spotRedraw, true);
		window.removeEventListener("resize", _spotRedraw, true);
		_spotRedraw = null;
	}
	_awaitingClick = false;
}

// ═══════════════════════════════════════════════════════════════
// Background (scene-level)
// ═══════════════════════════════════════════════════════════════

function _applyBackground(scene) {
	const bg = _overlay?.querySelector("#tut-bg");
	if (!bg) return;
	if (scene.background_image) {
		bg.style.backgroundImage = `url(${_escAttr(scene.background_image)})`;
	} else {
		bg.style.backgroundImage = "none";
	}
	if (scene.background_color) {
		bg.style.backgroundColor = scene.background_color;
	}
}

// BGM 拉线 beiluAudio bgm 轨(iframeRenderer 单实例播放器: 同URL不重启/与聊天美化BGM不叠音)。
// import 失败(独立插件场景无 beilu 渲染器)=降级到自持 #tut-bgm audio。
let _bgmVia = null; // "beilu" | "self" — 记住启动用了哪条路, stop走同路
async function _applyBGM(scene) {
	const url = scene.background_music;
	try {
		const { beiluAudioPlay, beiluAudioStop } = await import("../render/iframeRenderer.mjs");
		_bgmVia = "beilu";
		if (url) beiluAudioPlay(url, { track: "bgm", loop: true });
		else beiluAudioStop({ track: "bgm" });
		return;
	} catch { /* 渲染器不可用: 走自持audio */ }
	_bgmVia = "self";
	const audio = _overlay?.querySelector("#tut-bgm");
	if (!audio) return;
	if (url) {
		if (audio.src !== url) { audio.src = url; audio.play().catch(() => {}); }
	} else if (audio.src) { audio.pause(); audio.src = ""; }
}

async function _stopBGM() {
	if (_bgmVia === "beilu") {
		try { const { beiluAudioStop } = await import("../render/iframeRenderer.mjs"); beiluAudioStop({ track: "bgm" }); } catch { /* 已降级 */ }
	}
	const audio = _overlay?.querySelector("#tut-bgm");
	if (audio) { audio.pause(); audio.src = ""; }
}

// ═══════════════════════════════════════════════════════════════
// 打字音效(Undertale式每字blip) + 系统声音库播放
// 预设=WebAudio程序化合成(零依赖离线可用, 女声=高频三角波快衰减);
// "snd:文件名"=data/tutorials/sounds/系统库文件(全局存储, 非per-user)。
// 消费键: dialog.type_sound > parameters.text_panel.type_sound > 无声
// 预设参数可被 _defaults.json 的 type_sound_presets 逐键覆盖(硬编码四判据: 出厂单点+数据覆盖层)
// ═══════════════════════════════════════════════════════════════

let _audioCtx = null;
const _ac = () => {
	_audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
	// autoplay解锁(websocket._playDoneBeep同范式): 用户手势后suspended态可resume
	if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
	return _audioCtx;
};

// 出厂blip预设: freq=基频Hz, jitter=随机音高抖动(±Hz, 打字生动感), dur=秒, vol=音量
// label=键名原样(凛倾0715: 别给音效打标签, 不编描述)
const BLIP_PRESETS = {
	blip_1: { type: "triangle", freq: 1245, dur: 0.04,  vol: 0.16, jitter: 90, label: "blip_1" },
	blip_2: { type: "triangle", freq: 1046, dur: 0.045, vol: 0.18, jitter: 60, label: "blip_2" },
	blip_3: { type: "sine",     freq: 880,  dur: 0.055, vol: 0.2,  jitter: 40, label: "blip_3" },
	blip_4: { type: "square",   freq: 440,  dur: 0.05,  vol: 0.1,  jitter: 30, label: "blip_4" },
};

function _blipPreset(name) {
	return _userDefaults?.type_sound_presets?.[name] || BLIP_PRESETS[name];
}

function _playBlip(name) {
	const p = _blipPreset(name);
	if (!p) return;
	try {
		const ctx = _ac(), t = ctx.currentTime;
		const o = ctx.createOscillator(), g = ctx.createGain();
		o.type = p.type;
		o.frequency.value = p.freq + (Math.random() * 2 - 1) * (p.jitter || 0);
		g.gain.setValueAtTime(p.vol, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + p.dur);
		o.connect(g); g.connect(ctx.destination);
		o.start(t); o.stop(t + p.dur);
	} catch (e) { console.debug("[tutorial] blip:", e?.message); }
}

// 系统库文件音效: fetch+decode缓存, 每次bufferSource播(可重叠)。
// 缓存存Promise而非buffer——打字机每字调用, 存buffer会在首个await完成前并发N个fetch(时序竞态)
const _sndCache = new Map();
export const soundUrl = (file) => `/api/parts/plugins:beilu-tutorial/sounds/${encodeURIComponent(file)}`;
async function _playSndFile(file) {
	try {
		const ctx = _ac();
		let p = _sndCache.get(file);
		if (!p) {
			p = fetch(soundUrl(file)).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab));
			_sndCache.set(file, p);
			p.catch(() => _sndCache.delete(file)); // 失败清缓存, 下次可重试
		}
		const buf = await p;
		const src = ctx.createBufferSource();
		src.buffer = buf; src.connect(ctx.destination); src.start();
	} catch (e) { console.debug("[tutorial] snd:", e?.message); }
}

/** 每字音效入口: 预设名 或 "snd:文件名"; 跳过空白与标点(Undertale同感) */
function _typeSound(sound, ch) {
	if (!sound || /[\s。，、！？.,!?;:…"'"'()（）]/.test(ch || "")) return;
	if (sound.startsWith("snd:")) _playSndFile(sound.slice(4));
	else _playBlip(sound);
}

/** 试听(编辑器用) */
export function previewTypeSound(sound) { _typeSound(sound, "a"); }
export function listBlipPresets() { return Object.entries(BLIP_PRESETS).map(([k, v]) => [k, v.label]); }

// ── 搞怪效果 action: 屏幕震动 / 闪光(参数JSON可配) ──

registerTutorialAction("screenShake", (args) => {
	const target = document.body;
	const sd = _userDefaults?.screen_shake || {};
	const amp = Number(args?.intensity) || Number(sd.intensity) || 8;
	const dur = Number(args?.duration) || Number(sd.duration) || 400;
	const frameCount = Number(args?.frames) || Number(sd.frames) || 10;
	const frames = [];
	for (let i = 0; i < frameCount; i++) frames.push({ transform: `translate(${(Math.random() * 2 - 1) * amp}px, ${(Math.random() * 2 - 1) * amp}px)` });
	frames.push({ transform: "translate(0,0)" });
	target.animate(frames, { duration: dur, easing: "linear" });
});
registerTutorialAction("screenFlash", (args) => {
	const f = document.createElement("div");
	const fd = _userDefaults?.screen_flash || {};
	f.style.cssText = `position:fixed;inset:0;z-index:calc(var(--tut-z, 99999) + 1);pointer-events:none;background:${args?.color || fd.color || "#fff"};opacity:${Number(args?.opacity) || Number(fd.opacity) || 0.85};`;
	document.body.appendChild(f);
	f.animate([{ opacity: f.style.opacity }, { opacity: 0 }], { duration: Number(args?.duration) || Number(fd.duration) || 350, easing: "ease-out" })
		.addEventListener("finish", () => f.remove());
});

// ═══════════════════════════════════════════════════════════════
// Typewriter
// ═══════════════════════════════════════════════════════════════

// 标点呼吸停顿倍数(AliceInCradle/Undertale机制: 一个字符=一个演出节点, 句读处有节奏)
// 出厂单点, 教程JSON text_panel.pause_full/pause_half 可覆盖
const PAUSE_FULL_X = 8;   // 。！？!?… 后
const PAUSE_HALF_X = 4;   // ，、,;；: 后
const _RE_PAUSE_FULL = /[。！？!?…]/;
const _RE_PAUSE_HALF = /[，、,;；:]/;

function _typewriter(el, text, speed, onDone, sound) {
	_cancelTypewriter();
	_typeComplete = false;
	el.textContent = "";
	if (!text) { _typeComplete = true; onDone?.(); return; }

	// 字符节点驱动(凛倾0715: "alice的音效和文字演出配合的很好,相当于一个字符一个节点"):
	// 每个字符=一个演出节点——字与blip同帧原子触发, 下一节点延时由本字符类型决定(标点=呼吸停顿),
	// 而非固定interval节拍(那样音效只是搭在旁边, 无演出节奏)
	const tp = _tutorial?.parameters?.text_panel;
	const fullX = Number(tp?.pause_full) > 0 ? Number(tp.pause_full) : Number(_userDefaults?.pause_full) > 0 ? Number(_userDefaults.pause_full) : PAUSE_FULL_X;
	const halfX = Number(tp?.pause_half) > 0 ? Number(tp.pause_half) : Number(_userDefaults?.pause_half) > 0 ? Number(_userDefaults.pause_half) : PAUSE_HALF_X;
	let i = 0;
	const step = () => {
		const ch = text[i++];
		el.textContent += ch;
		if (sound) _typeSound(sound, ch);
		if (i >= text.length) {
			_typeTimer = null;
			_typeComplete = true;
			onDone?.();
			return;
		}
		const delay = _RE_PAUSE_FULL.test(ch) ? speed * fullX
			: _RE_PAUSE_HALF.test(ch) ? speed * halfX
			: speed;
		_typeTimer = setTimeout(step, delay);
	};
	_typeTimer = setTimeout(step, speed);
}

function _skipTypewriter(el, text) {
	if (_typeTimer && !_typeComplete) {
		_cancelTypewriter();
		el.textContent = text;
		_typeComplete = true;
		return true; // was skipped
	}
	return false;
}

function _cancelTypewriter() {
	if (_typeTimer) { clearTimeout(_typeTimer); _typeTimer = null; } // 节点驱动=setTimeout链
}

// ═══════════════════════════════════════════════════════════════
// Click handlers
// ═══════════════════════════════════════════════════════════════

function _onTextClick() {
	const textEl = _overlay?.querySelector("#tut-text");
	if (!textEl || !_running) return;
	const dialog = _getCurrentDialog();
	if (!dialog) return;
	const fullText = _interpolate(dialog.text || "");
	// If typewriter is still running, skip to full text
	if (_skipTypewriter(textEl, fullText)) {
		// Show next button or choices after skip
		_onTypewriterDone(dialog);
		return;
	}
	// If already complete and no choices, advance (引导点击期间只认目标元素, 点文本不推进)
	if (_typeComplete && !_awaitingClick && (!dialog.choice || dialog.choice.length === 0)) {
		_resolve?.("next");
	}
}

function _onNextClick() {
	if (_running && !_awaitingClick) _resolve?.("next");
}

// 上一句: 不受_awaitingClick闸(引导等待中也可回看, cleanup会摘spotlight与目标监听)
function _onBackClick() {
	if (_running && _history.length > 1) _resolve?.({ type: "back" });
}

// ═══════════════════════════════════════════════════════════════
// Navigation helpers
// ═══════════════════════════════════════════════════════════════

function _getBlock(name) {
	if (!_tutorial || !name) return null;
	return _tutorial[name] ?? null;
}

function _getCurrentScene() {
	const block = _getBlock(_blockName);
	if (!block || !Array.isArray(block)) return null;
	return block[_sceneIdx] ?? null;
}

function _getCurrentDialog() {
	const scene = _getCurrentScene();
	if (!scene || !Array.isArray(scene.dialogs)) return null;
	return scene.dialogs[_dialogIdx] ?? null;
}

/** Parse go_to string. Supports: "blockName" (jump to block), "tue_go" (next scene), "block,scene,dialog" triple. */
function _parseGoTo(goTo) {
	if (!goTo || typeof goTo !== "string") return null;
	if (goTo === "tue_go") return { type: "next_scene" };
	if (goTo.includes(",")) {
		const parts = goTo.split(",").map(s => s.trim());
		return {
			type: "triple",
			block: parts[0] || _blockName,
			scene: parts[1] != null ? parseInt(parts[1], 10) : 0,
			dialog: parts[2] != null ? parseInt(parts[2], 10) : 0,
		};
	}
	// Single string: block name
	return { type: "block", block: goTo };
}

// ═══════════════════════════════════════════════════════════════
// Dialog execution
// ═══════════════════════════════════════════════════════════════

function _showDialog(dialog) {
	return new Promise(resolve => {
		_resolve = resolve;
		const panel = _overlay.querySelector("#tut-text-panel");
		const nameEl = _overlay.querySelector("#tut-name");
		const textEl = _overlay.querySelector("#tut-text");
		const choicesEl = _overlay.querySelector("#tut-choices");
		const nextBtn = _overlay.querySelector("#tut-next");
		const htmlLayer = _overlay.querySelector("#tut-html-layer");

		// Show text panel
		panel.classList.add("tut-visible");
		htmlLayer.classList.remove("tut-visible");
		htmlLayer.innerHTML = "";

		// Per-dialog color/text overrides via inline style (not CSS vars, since these are per-dialog)
		if (dialog.color) panel.style.backgroundColor = dialog.color;
		else panel.style.removeProperty("background-color");
		if (dialog.color_text) textEl.style.color = dialog.color_text;
		else textEl.style.removeProperty("color");

		// Name — resolve from parameters.characters if key-style
		let displayName = dialog.name || "";
		const chars = _tutorial?.parameters?.characters;
		if (chars && displayName && chars[displayName]) {
			const charDef = chars[displayName];
			if (charDef.color_text) nameEl.style.color = charDef.color_text;
			else nameEl.style.removeProperty("color");
			if (charDef.color) nameEl.style.backgroundColor = charDef.color;
			else nameEl.style.removeProperty("background-color");
			displayName = charDef.name || displayName;
		} else {
			nameEl.style.removeProperty("color");
			nameEl.style.removeProperty("background-color");
		}
		nameEl.textContent = _interpolate(displayName);

		// Clear choices and next
		choicesEl.innerHTML = "";
		nextBtn.classList.remove("tut-visible");

		// 上一句按钮(栈里有上一条才显) + 线路内进度(第N/共M句; text_panel.show_progress=false关)
		_overlay.querySelector("#tut-back")?.classList.toggle("tut-visible", _history.length > 1);
		const progEl = _overlay.querySelector("#tut-progress");
		if (progEl) {
			if (_tutorial?.parameters?.text_panel?.show_progress === false) {
				progEl.classList.remove("tut-visible");
			} else {
				const block = _getBlock(_blockName) || [];
				let before = 0;
				for (let i = 0; i < _sceneIdx; i++) before += block[i]?.dialogs?.length || 0;
				const total = block.reduce((n, s) => n + (s?.dialogs?.length || 0), 0);
				progEl.textContent = `${before + _dialogIdx + 1}/${total}`;
				progEl.classList.add("tut-visible");
			}
		}

		// Apply art (persists if dialog.art is absent)
		_applyArt(dialog.art);

		// Apply variable mutations
		_mutateVars(dialog.variables);

		// HTML overlay
		if (dialog.html) {
			htmlLayer.innerHTML = _interpolate(dialog.html);
			htmlLayer.classList.add("tut-visible");
		}

		// Event dispatch (pull from beilu systems)
		if (dialog.event) _handleEvent(dialog.event);

		// Controll (pack switching / emotion)
		if (dialog.controll) _handleControll(dialog.controll);

		// 引导点击: 高亮目标元素, 等用户真点了才推进(教程核心能力)
		// await_click: "selector" 或 {selector, go_to}; 目标不存在=诚实降级走普通next流程。
		// IFRAME目标同样降级: iframe内点击不冒泡到父文档, 等待=教程永久卡死(消息区iframe渲染)
		_awaitingClick = false;
		if (dialog.await_click) {
			const ac = typeof dialog.await_click === "string" ? { selector: dialog.await_click } : dialog.await_click;
			let targetEl = ac?.selector ? document.querySelector(ac.selector) : null;
			if (targetEl?.tagName === "IFRAME") { console.warn("[tutorial] await_click target is IFRAME, degrading to next"); targetEl = null; }
			if (targetEl && _showSpotlight(targetEl)) {
				_awaitingClick = true;
				const goTo = ac.go_to ?? dialog.go_to;
				const onClick = () => {
					_hideSpotlight();
					_resolve?.(goTo ? { type: "go_to", target: goTo } : "next");
				};
				targetEl.addEventListener("click", onClick, { once: true });
				_cleanup.push(() => { targetEl.removeEventListener("click", onClick); _hideSpotlight(); });
			}
		}

		// beiluLive2d口型: 打字期间驱动桌宠说话（复用已有系统，不自造口型）
		if (window.beiluLive2d?.talk && dialog.text) {
			const talkMs = Math.min(10000, (dialog.text.length || 1) * (dialog.dialog_speed ?? _tutorial?.parameters?.text_panel?.dialog_speed ?? 60));
			window.beiluLive2d.talk(talkMs);
		}

		// Typewriter(打字音效: 对话级 > 教程级text_panel > 无)
		const fullText = _interpolate(dialog.text || "");
		const speed = dialog.dialog_speed ?? _tutorial?.parameters?.text_panel?.dialog_speed ?? (Number(_userDefaults?.dialog_speed) || DEFAULT_TYPE_SPEED_MS);
		const typeSound = dialog.type_sound ?? _tutorial?.parameters?.text_panel?.type_sound;

		_typewriter(textEl, fullText, speed, () => {
			_onTypewriterDone(dialog);
		}, typeSound);

		// Timer: [ms, target] — auto-advance after ms to target
		if (dialog.timer && Array.isArray(dialog.timer) && dialog.timer.length >= 2) {
			_timerHandle = setTimeout(() => {
				_timerHandle = null;
				resolve({ type: "go_to", target: dialog.timer[1] });
			}, dialog.timer[0]);
			_cleanup.push(() => { if (_timerHandle) { clearTimeout(_timerHandle); _timerHandle = null; } });
		}
	});
}

function _onTypewriterDone(dialog) {
	const choicesEl = _overlay.querySelector("#tut-choices");
	const nextBtn = _overlay.querySelector("#tut-next");

	// Choices: filter by show_if, render buttons
	const choices = (dialog.choice || []).filter(c => _evalShowIf(c.show_if));
	if (choices.length > 0) {
		choicesEl.innerHTML = "";
		for (const [ci, ch] of choices.entries()) {
			const btn = document.createElement("button");
			btn.className = "tut-choice-btn";
			// 小圆机制: 逐项错开上滑入场(index×stagger)
			btn.style.animationDelay = `calc(${ci} * var(--tut-choice-stagger))`;
			btn.textContent = _interpolate(ch.text || "");

			// Per-choice style overrides
			if (ch.color) btn.style.backgroundColor = ch.color;
			if (ch.color_text) btn.style.color = ch.color_text;

			btn.addEventListener("click", () => {
				// Apply choice-level variable mutations
				_mutateVars(ch.variables);
				if (ch.go_to) {
					_resolve?.({ type: "go_to", target: ch.go_to });
				} else {
					_resolve?.("next");
				}
			});
			choicesEl.appendChild(btn);
		}
		// Choices block advancement until clicked — do NOT show next button
		nextBtn.classList.remove("tut-visible");
		// 选择时刻层(fixed全屏z4)盖住panel(z2): back/progress留着=看得见点不到的死按钮, 一并藏
		// (选错重选路径: 分支第一句按◀回到带选项的对话, 选项重新弹出)
		_overlay.querySelector("#tut-back")?.classList.remove("tut-visible");
		_overlay.querySelector("#tut-progress")?.classList.remove("tut-visible");
	} else if (_awaitingClick) {
		// 引导点击中: 不显示next不auto-go, 推进权只在目标元素的真实点击
	} else {
		// No choices: show next button (unless go_to is set, in which case auto-advance)
		if (dialog.go_to) {
			_resolve?.({ type: "go_to", target: dialog.go_to });
		} else {
			nextBtn.classList.add("tut-visible");
		}
	}
}

// ═══════════════════════════════════════════════════════════════
// Event / controll handlers (pull from beilu systems)
// ═══════════════════════════════════════════════════════════════

async function _handleEvent(event) {
	if (typeof event === "string") {
		// Registered action name
		const fn = _actions.get(event);
		if (fn) await fn({});
	} else if (typeof event === "object") {
		// { action: "name", args: {...} }
		const fn = _actions.get(event.action || event.name);
		if (fn) await fn(event.args || event);
	}
}

async function _handleControll(controll) {
	if (typeof controll !== "object") return;
	if (controll.pack) await _handleEvent({ action: "changePack", args: { name: controll.pack } });
	if (controll.emotion) await _handleEvent({ action: "setEmotion", args: { emotion: controll.emotion } });
	if (controll.tab) await _handleEvent({ action: "switchTab", args: { tab: controll.tab } });
}

// ═══════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════

function _cleanupStep() {
	_cleanup.forEach(fn => { try { fn(); } catch (e) { console.debug("[tutorial] cleanup:", e?.message); } });
	_cleanup = [];
	_cancelTypewriter();
	_typeComplete = false;
	if (_timerHandle) { clearTimeout(_timerHandle); _timerHandle = null; }
	if (_overlay) {
		const panel = _overlay.querySelector("#tut-text-panel");
		const choicesEl = _overlay.querySelector("#tut-choices");
		const nextBtn = _overlay.querySelector("#tut-next");
		const htmlLayer = _overlay.querySelector("#tut-html-layer");
		if (panel) panel.classList.remove("tut-visible");
		if (choicesEl) choicesEl.innerHTML = "";
		if (nextBtn) nextBtn.classList.remove("tut-visible");
		_overlay.querySelector("#tut-back")?.classList.remove("tut-visible");
		_overlay.querySelector("#tut-progress")?.classList.remove("tut-visible");
		if (htmlLayer) { htmlLayer.classList.remove("tut-visible"); htmlLayer.innerHTML = ""; }
	}
}

// ═══════════════════════════════════════════════════════════════
// Save / Load (localStorage)
// ═══════════════════════════════════════════════════════════════

const _SAVE_KEY = "beilu_tutorial_save";

function _saveState() {
	if (!_tutorial || !_running) return;
	try {
		const state = {
			tutorialId: _tutorial.id,
			blockName: _blockName,
			sceneIdx: _sceneIdx,
			dialogIdx: _dialogIdx,
			vars: { ..._vars },
			timestamp: Date.now(),
		};
		localStorage.setItem(_SAVE_KEY, JSON.stringify(state));
	} catch (e) { console.debug("[tutorial] save state:", e?.message); }
}

function _loadState() {
	try {
		const raw = localStorage.getItem(_SAVE_KEY);
		if (!raw) return null;
		return JSON.parse(raw);
	} catch { return null; }
}

function _clearSaveState() {
	try { localStorage.removeItem(_SAVE_KEY); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Main loop
// ═══════════════════════════════════════════════════════════════

async function _runLoop() {
	while (_running) {
		const scene = _getCurrentScene();
		if (!scene) {
			// No more scenes in this block — end
			break;
		}

		// Apply scene-level background/music (once per scene entry)
		_applyBackground(scene);
		_applyBGM(scene);

		const dialogs = scene.dialogs || [];
		if (_dialogIdx >= dialogs.length) {
			// All dialogs in this scene consumed — advance to next scene
			_sceneIdx++;
			_dialogIdx = 0;
			continue;
		}

		const dialog = dialogs[_dialogIdx];
		_cleanupStep();
		_history.push({ b: _blockName, s: _sceneIdx, d: _dialogIdx }); // back回退栈(back到达时pop两次再重push, 栈保持一致)

		// Save state at each dialog
		_saveState();

		// Execute dialog
		const result = await _showDialog(dialog);
		if (!_running) break;

		// Process result
		if (result === "next") {
			// Advance to next dialog
			_dialogIdx++;
		} else if (result && typeof result === "object" && result.type === "back") {
			// 上一句: 弹掉当前+上一条(上一条展示时会重新入栈)
			_history.pop();
			const prev = _history.pop();
			if (prev) { _blockName = prev.b; _sceneIdx = prev.s; _dialogIdx = prev.d; }
		} else if (result && typeof result === "object" && result.type === "go_to") {
			const nav = _parseGoTo(result.target);
			if (!nav) {
				_dialogIdx++;
			} else if (nav.type === "next_scene") {
				_sceneIdx++;
				_dialogIdx = 0;
			} else if (nav.type === "block") {
				const block = _getBlock(nav.block);
				if (block) {
					_blockName = nav.block;
					_sceneIdx = 0;
					_dialogIdx = 0;
				} else {
					console.warn(`[tutorial] go_to target block "${nav.block}" not found, advancing`);
					_dialogIdx++;
				}
			} else if (nav.type === "triple") {
				if (nav.block && _getBlock(nav.block)) _blockName = nav.block;
				_sceneIdx = nav.scene || 0;
				_dialogIdx = nav.dialog || 0;
			}
		} else if (result === "end" || result === null) {
			break;
		} else {
			_dialogIdx++;
		}
	}
}

// ═══════════════════════════════════════════════════════════════
// 编辑渲染模式(凛倾原话MSG#15"中间是界面和拖动"/MSG#17"在这些平面上覆盖一次"):
// 编辑器不再用模拟画布 — 直接驱动运行时overlay在真实界面上渲染指定对话,
// 编辑交互(拖立绘/改文字/点选项)由编辑器绑到本层元素上, 所见=运行时所得。
// 与runLoop互斥: 编辑渲染无打字机/无推进/无存档/无引导等待。
// ═══════════════════════════════════════════════════════════════

let _editMode = false;
export function isEditRender() { return _editMode; }

/**
 * 在真实界面上渲染指定对话(编辑态)。
 * @param {object} script - 教程JSON(编辑器的live对象, 改动即时可重渲)
 * @param {string} blockName @param {number} sceneIdx @param {number} dialogIdx
 */
export async function renderDialogForEdit(script, blockName, sceneIdx, dialogIdx) {
	if (_running) stop({}); // 预览中切编辑: 停运行时(保留存档语义无关紧要, 编辑态)
	_ensureOverlay();
	_editMode = true;
	_tutorial = script;
	_initVars(script.parameters);
	await loadTutorialDefaults();
	await _ensurePacks(script);
	applyTutCSSVars(script.parameters);
	_applyBubbleTheme(script.parameters);
	_overlay.style.display = "block";
	_overlay.classList.add("tut-editing"); // 编辑态: 选项层透明不拦点

	const scene = script[blockName]?.[sceneIdx];
	const dialog = scene?.dialogs?.[dialogIdx];
	_applyBackground(scene || {});
	// 编辑态art=全量重渲当前对话(运行时的"无art字段=沿用"持久语义不适用)
	_applyArt(dialog?.art || []);

	const panel = _overlay.querySelector("#tut-text-panel");
	const nameEl = _overlay.querySelector("#tut-name");
	const textEl = _overlay.querySelector("#tut-text");
	const choicesEl = _overlay.querySelector("#tut-choices");
	const nextBtn = _overlay.querySelector("#tut-next");
	panel.classList.add("tut-visible");
	nextBtn.classList.remove("tut-visible");
	_hideSpotlight();

	// 名字(characters解析同运行时)
	let displayName = dialog?.name || "";
	const chars = script.parameters?.characters;
	if (chars?.[displayName]?.name) displayName = chars[displayName].name;
	if (document.activeElement !== nameEl) nameEl.textContent = _interpolate(displayName);
	// 文字全文直显(无打字机)
	if (document.activeElement !== textEl) textEl.textContent = _interpolate(dialog?.text || "");
	// 选项静态渲染(点击行为由编辑器接管; 错开动画=运行时同观感)
	choicesEl.innerHTML = "";
	for (const [i, ch] of (dialog?.choice || []).entries()) {
		const btn = document.createElement("button");
		btn.className = "tut-choice-btn";
		btn.dataset.editChoice = String(i);
		btn.style.animationDelay = `calc(${i} * var(--tut-choice-stagger))`;
		btn.textContent = _interpolate(ch.text || "");
		choicesEl.appendChild(btn);
	}
}

/** 编辑态: 参数改动后同步舞台overlay的CSS变量(保持优先级链 DEFAULTS<覆盖层<pet-settings<params) */
export function syncEditVars(params) {
	if (!_editMode || !_overlay) return;
	applyTutCSSVars(params);
	_applyBubbleTheme(params);
}

export function stopEditRender() {
	_editMode = false;
	_cancelTypewriter();
	_clearArt();
	_hideSpotlight();
	if (_overlay) {
		_overlay.classList.remove("tut-editing");
		_overlay.querySelector("#tut-text-panel")?.classList.remove("tut-visible");
		_overlay.querySelector("#tut-choices").innerHTML = "";
		_overlay.style.display = "none";
	}
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Start a tutorial from a JSON script object.
 * @param {object} script - Full tutorial JSON (with parameters, blocks, etc.)
 * @param {object} [opts] - { onEnd, resume }
 *   resume: if true, attempt to load saved state for this tutorial
 */
export async function startTutorial(script, opts = {}) {
	if (_running) stop();
	_ensureOverlay();

	_tutorial = script;
	_running = true;
	_history = [];
	_onEnd = opts.onEnd || null;
	_overlay.style.display = "block";

	// Initialize variables from parameters
	_initVars(script.parameters);

	// 数据覆盖层+图包数据先就位(各一个本地GET, 之后缓存), 再注入CSS变量
	await loadTutorialDefaults();
	await _ensurePacks(script);
	applyTutCSSVars(script.parameters);

	// 真拉线: 桌宠气泡用户配色异步回填(JSON 未覆盖的键才回填, 失败=兜底降级)
	_applyBubbleTheme(script.parameters);

	// Determine starting block (opts.block优先=帮助模式点?触发特定block)
	const launchBlock = opts.block || script.parameters?.launch_story;

	// Check for saved state to resume
	// resume: true=静默续读 / "ask"=有本教程存档就问(继续/从头) / 其他=从头。
	// (存档由skip中断时保留——没有ask入口时它是写了永远读不到的死档)
	let saved = null;
	if (opts.resume === true) saved = _loadState();
	else if (opts.resume === "ask") {
		const s = _loadState();
		if (s && s.tutorialId === script.id) {
			let cont = false;
			try {
				const { beiluConfirm } = await import("../widgets/beiluDialog.mjs");
				cont = await beiluConfirm("这个教程上次看到一半，继续上次进度？", { confirmText: "继续", cancelText: "从头开始" });
			} catch { /* 独立运行无beilu对话框: 不问, 从头 */ }
			if (cont) saved = s; else _clearSaveState();
		}
	}
	if (saved && saved.tutorialId === script.id) {
		_blockName = saved.blockName;
		_sceneIdx = saved.sceneIdx;
		_dialogIdx = saved.dialogIdx;
		if (saved.vars) _vars = { ...saved.vars };
	} else if (launchBlock && _getBlock(launchBlock)) {
		_blockName = launchBlock;
		_sceneIdx = 0;
		_dialogIdx = 0;
	} else {
		// Fallback: find first block key that is an array (skip id/title/version/character/parameters)
		const reserved = new Set(["id", "title", "version", "character", "parameters"]);
		const firstBlock = Object.keys(script).find(k => !reserved.has(k) && Array.isArray(script[k]));
		if (firstBlock) {
			_blockName = firstBlock;
			_sceneIdx = 0;
			_dialogIdx = 0;
		} else {
			stop({ completed: true });
			return;
		}
	}

	await _runLoop();
	// 自然走完(_running仍true)才算completed→清存档; 中途skip/外部stop已按中断处理(保留存档), 不重复stop
	if (_running) stop({ completed: true });
}

/**
 * @param {object} [opts] - { completed } 存档语义: 走完=清档, 中断(skip/外部stop)=保留供 resume 续玩
 */
export function stop(opts = {}) {
	_running = false;
	// 了结在途dialog等待: 不了结则_runLoop的await永久悬挂→startTutorial永不返回→
	// await它的调用方(auto_trigger串行队列/帮助点onEnd链)全部卡死
	const r = _resolve; _resolve = null;
	r?.("end");
	_cleanupStep();
	_clearArt();
	_cancelTypewriter();
	if (_timerHandle) { clearTimeout(_timerHandle); _timerHandle = null; }
	// Stop BGM(beiluAudio轨或自持audio, 按启动路径)
	_stopBGM();
	// Reset overlay inline styles (CSS vars)
	if (_overlay) {
		_overlay.style.display = "none";
		_overlay.style.cssText = "display:none";
	}
	if (opts.completed) _clearSaveState();
	if (_onEnd) { const cb = _onEnd; _onEnd = null; cb(); }
}

export function isRunning() { return _running; }

// ═══════════════════════════════════════════════════════════════
// Data operations (pull from beilu-tutorial plugin via sendAction)
// ═══════════════════════════════════════════════════════════════

const _sa = async (verb, payload) => {
	const { sendAction } = await import("../transport/sendAction.mjs");
	return sendAction({ verb, target: "plugins:beilu-tutorial", source: "web", payload });
};

// 桌宠链读路(pet-settings 拉线用, sendAction.mjs server:eye 已注册路由)
const _saEye = async (verb) => {
	const { sendAction } = await import("../transport/sendAction.mjs");
	return sendAction({ verb, target: "server:eye", source: "web" });
};

export const loadTutorial = (id) => _sa("getTutorial", { id });
export const listTutorials = () => _sa("listTutorials");
export const saveTutorial = (t) => _sa("saveTutorial", t);
export const deleteTutorial = (id) => _sa("deleteTutorial", { id });
// 图包列表: 拉线既有 /api/eye/imagepacks(唯一权威,含无pack.json自动物化) + 逐包fetch pack.json
// 组装 {name, expressions:{表情:[文件]}, default}(hitEditor.mjs:40 同范式直读pack.json)
export const listImagepacks = async () => {
	const packs = await _saEye("listImagepacks");
	if (!Array.isArray(packs)) return [];
	return Promise.all(packs.filter(p => p?.format === "image").map(async (p) => {
		try {
			const pj = await (await fetch(p.url, { cache: "no-store" })).json();
			return { name: p.name, expressions: pj.expressions || {}, default: pj.default || "" };
		} catch { return { name: p.name, expressions: {}, default: "" }; }
	}));
};
export const listSounds = () => _sa("listSounds");
export const downloadSounds = () => _sa("downloadSounds");

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

// 0716 轮子收口：原本地 4 字符副本（&"<>）缺单引号转义——属性单引号上下文不安全；
//   改复用权威 utils.escapeHtml（全 5 字符含 '），导出名 escTutHtml 保留（tutorialPanel 消费）。
//   import 声明提升，位置随收口点。（文件头"non-module consumers"注释是历史残留：实际消费方
//   仅 tutorialPanel/layout 两个 ESM import，无非模块引用，加 import 安全。）
import { escapeHtml as _utilsEscapeHtml } from "../state/utils.mjs";
export const escTutHtml = _utilsEscapeHtml;
const _escAttr = escTutHtml;

// ═══════════════════════════════════════════════════════════════
// Global exposure (for non-module consumers)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// 帮助模式（凛倾0715MSG#9: 模式开关→板块出?→点?角色出现播教程）
// 数据: 教程JSON parameters.help_points = [{selector, label, story, position, trigger, style}]
// 触发: overlay_icon(默认叠?) / bind_click(绑已有元素) / bind_hover / auto(首次可见)
// ═══════════════════════════════════════════════════════════════

let _helpMode = false;
let _helpOverlay = null;
let _helpCleanups = [];
let _helpScripts = [];

export function isHelpMode() { return _helpMode; }

/** 帮助模式期间跟随tab切换重扫问号(目标板块DOM就位后): 用户"点击板块才出现问号"的动线核心 */
const _onTabForHelp = () => { if (_helpMode) setTimeout(() => _renderHelpPoints(), 150); };

/** @returns {Promise<boolean>} true=已进入; false=没有任何教程配置帮助点(入口方给可见反馈, 不静默) */
export async function enterHelpMode() {
	if (_helpMode) return true;
	_helpMode = true;
	const allTuts = await listTutorials().catch(() => []);
	_helpScripts = [];
	for (const t of allTuts) {
		const script = await loadTutorial(t.id).catch(() => null);
		if (script?.parameters?.help_points?.length) _helpScripts.push(script);
	}
	if (!_helpScripts.length) { _helpMode = false; return false; }
	_renderHelpPoints();
	window.addEventListener("beilu:tab-activated", _onTabForHelp);
	return true;
}

export function exitHelpMode() {
	_helpMode = false;
	window.removeEventListener("beilu:tab-activated", _onTabForHelp);
	_helpCleanups.forEach(fn => { try { fn(); } catch {} });
	_helpCleanups = [];
	if (_helpOverlay) { _helpOverlay.remove(); _helpOverlay = null; }
	_helpScripts = [];
}

/** @returns {Promise<"on"|"off"|"empty">} 入口方按状态给用户反馈 */
export async function toggleHelpMode() {
	if (_helpMode) { exitHelpMode(); return "off"; }
	return (await enterHelpMode()) ? "on" : "empty";
}

/** help/desk变量族注入:root — 问号icon挂各板块内、桌宠钮挂body, 都在overlay子树外,
 *  overlay inline style的变量继承不到它们(不注入=透明底/无脉冲的隐形残废)。单源仍=TUT_DEFAULTS+覆盖层 */
function _applyHelpVars() {
	const root = document.documentElement.style;
	const isHelpKey = (k) => k.startsWith("--tut-help-") || k.startsWith("--tut-desk-");
	for (const [k, v] of Object.entries(TUT_DEFAULTS)) if (isHelpKey(k)) root.setProperty(k, v);
	if (_userDefaults) for (const [k, v] of Object.entries(_userDefaults)) if (isHelpKey(k) && k.startsWith("--")) root.setProperty(k, String(v));
}

function _renderHelpPoints() {
	_applyHelpVars();
	// 先清旧绑定与图标: 问号icon是target.appendChild(挂在各板块内部), _helpOverlay.remove()清不到——
	// 不先跑cleanups, 教程播完onEnd重渲/tab切换重渲会问号叠加+bind_click监听翻倍
	_helpCleanups.forEach(fn => { try { fn(); } catch { /* 已移除 */ } });
	_helpCleanups = [];
	if (_helpOverlay) _helpOverlay.remove();
	_helpOverlay = document.createElement("div");
	_helpOverlay.id = "tut-help-overlay";
	_helpOverlay.style.cssText = "position:fixed;inset:0;z-index:99998;pointer-events:none;";
	document.body.appendChild(_helpOverlay);

	for (const script of _helpScripts) {
		for (const hp of (script.parameters?.help_points || [])) {
			if (!hp.selector || !hp.story) continue;
			const target = document.querySelector(hp.selector);
			if (!target) continue;
			const trigger = hp.trigger || "overlay_icon";

			if (trigger === "overlay_icon") {
				_createHelpIcon(target, hp, script);
			} else if (trigger === "bind_click") {
				const handler = () => _triggerHelpPoint(hp, script);
				target.addEventListener("click", handler);
				_helpCleanups.push(() => target.removeEventListener("click", handler));
			} else if (trigger === "bind_hover") {
				const handler = () => _triggerHelpPoint(hp, script);
				target.addEventListener("mouseenter", handler, { once: true });
				_helpCleanups.push(() => target.removeEventListener("mouseenter", handler));
			} else if (trigger === "auto") {
				const obs = new IntersectionObserver(([entry]) => {
					if (entry.isIntersecting) { obs.disconnect(); _triggerHelpPoint(hp, script); }
				}, { threshold: Number(hp?.threshold) || 0.3 });
				obs.observe(target);
				_helpCleanups.push(() => obs.disconnect());
			}
		}
	}
}

/** 问号定位: 挂_helpOverlay(fixed全屏)按目标矩形骑角摆放。
 *  不再target.appendChild — textarea/input/img等纯文本/void元素不渲染子元素(问号会静默消失),
 *  且免去强改target position:relative的副作用; 目标隐藏(矩形0)时问号跟着藏 */
function _positionHelpIcon(icon, target, pos) {
	const r = target.getBoundingClientRect();
	if (!r.width && !r.height) { icon.style.display = "none"; return; }
	icon.style.display = "flex";
	const size = parseFloat(getComputedStyle(icon).width) || parseFloat(TUT_DEFAULTS["--tut-help-size"]);
	const map = {
		"top-right": [r.right - size / 2, r.top - size / 2],
		"top-left": [r.left - size / 2, r.top - size / 2],
		"bottom-right": [r.right - size / 2, r.bottom - size / 2],
		"bottom-left": [r.left - size / 2, r.bottom - size / 2],
		"center": [r.left + r.width / 2 - size / 2, r.top + r.height / 2 - size / 2],
	};
	const [x, y] = map[pos] || map["top-right"];
	icon.style.left = x + "px";
	icon.style.top = y + "px";
}

function _createHelpIcon(target, hp, script) {
	const icon = document.createElement("button");
	icon.className = "tut-help-icon";
	icon.textContent = hp.icon || "?";
	icon.title = hp.label || "";
	const st = hp.style || {};
	icon.style.cssText = `position:fixed;z-index:99999;pointer-events:auto;
		width:${st.size || "var(--tut-help-size)"};height:${st.size || "var(--tut-help-size)"};border-radius:50%;
		background:${st.bg || "var(--tut-help-bg)"};color:${st.fg || "var(--tut-help-fg)"};
		font-weight:bold;font-size:${st.fontSize || "var(--tut-help-fs)"};border:2px solid ${st.border || "var(--tut-help-border)"};
		cursor:pointer;display:flex;align-items:center;justify-content:center;
		box-shadow:0 2px 8px rgba(0,0,0,0.3);animation:tut-help-pulse var(--tut-help-pulse-dur) ease-in-out infinite;`;
	_helpOverlay.appendChild(icon);
	const reposition = () => _positionHelpIcon(icon, target, hp.position || "top-right");
	reposition();
	window.addEventListener("scroll", reposition, true);
	window.addEventListener("resize", reposition, true);
	icon.addEventListener("click", (e) => { e.stopPropagation(); _triggerHelpPoint(hp, script); });
	_helpCleanups.push(() => {
		window.removeEventListener("scroll", reposition, true);
		window.removeEventListener("resize", reposition, true);
		icon.remove();
	});
}

async function _triggerHelpPoint(hp, script) {
	if (_running) return;
	await startTutorial(script, {
		block: hp.story,
		resume: "ask", // 上次skip留的存档: 问一句继续还是从头(存档位置优先于hp.story)
		onEnd: () => { if (_helpMode) _renderHelpPoints(); },
	});
}

// 帮助模式CSS（注入一次）
let _helpStyleInjected = false;
function _ensureHelpStyle() {
	if (_helpStyleInjected) return;
	_helpStyleInjected = true;
	const s = document.createElement("style");
	s.textContent = `
@keyframes tut-help-pulse {
	0%,100% { transform: scale(1); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
	50% { transform: scale(1.15); box-shadow: 0 2px 12px rgba(240,160,32,0.5); }
}
.tut-help-icon:hover { transform: scale(var(--tut-help-hover-scale)) !important; }
`;
	document.head.appendChild(s);
}
_ensureHelpStyle();

// ═══════════════════════════════════════════════════════════════
// auto_trigger（凛倾0715审阅第2条: 可以设置第一次使用时出现）
// 教程JSON parameters.auto_trigger = [{type, target?, story, once?}]
// type: "first_open"=首次打开beilu / "first_visit"=目标元素首次可见 / "on_event"=事件触发
// once: true=只触发一次(localStorage记住) / false=每次都触发
// ═══════════════════════════════════════════════════════════════

let _autoTriggerCleanups = [];
const _AUTO_KEY = "beilu_tut_auto_";

export async function initAutoTriggers() {
	_autoTriggerCleanups.forEach(fn => { try { fn(); } catch {} });
	_autoTriggerCleanups = [];
	const allTuts = await listTutorials().catch(() => []);
	const firstOpenQueue = []; // {fire, delay} 收集后统一串行(凛倾MSG#12"10个教程立刻播放会怎么样": 原实现同时到点只活第一个其余静默丢)
	for (const t of allTuts) {
		const script = await loadTutorial(t.id).catch(() => null);
		// 桌宠式常驻按钮(凛倾0715批注3"做成一个桌宠,点击一个按钮出现"): 与auto_trigger共享本次扫描, 清理走同一cleanups
		if (script?.parameters?.desk_button?.story || script?.parameters?.desk_button?.enabled) _renderDeskButton(script);
		if (!script?.parameters?.auto_trigger) continue;
		const triggers = Array.isArray(script.parameters.auto_trigger) ? script.parameters.auto_trigger : [script.parameters.auto_trigger];
		for (const at of triggers) {
			if (!at?.type || !at?.story) continue;
			const key = _AUTO_KEY + script.id + "_" + at.story;
			if (at.once && localStorage.getItem(key)) continue;
			const fire = async () => {
				if (_running) return; // 用户正在播(手动/前一条自动)则让位; once未标, 下次启动再来
				if (at.once) localStorage.setItem(key, "1");
				await startTutorial(script, { block: at.story });
			};
			if (at.type === "first_open") {
				firstOpenQueue.push({ fire, delay: Number(at.delay) || Number(_userDefaults?.auto_trigger_delay) || 3500 });
			} else if (at.type === "first_visit" && at.target) {
				const el = document.querySelector(at.target);
				if (el) {
					const obs = new IntersectionObserver(([entry]) => {
						if (entry.isIntersecting) { obs.disconnect(); fire(); }
					}, { threshold: Number(at?.threshold) || 0.3 });
					obs.observe(el);
					_autoTriggerCleanups.push(() => obs.disconnect());
				}
			} else if (at.type === "on_event" && at.target) {
				const handler = () => fire();
				window.addEventListener(at.target, handler, { once: true });
				_autoTriggerCleanups.push(() => window.removeEventListener(at.target, handler));
			}
		}
	}
	// first_open 串行队列: 多教程同时命中时一个播完再播下一个(fire内部await到教程自然结束),
	// 各教程仍尊重自己的delay(前面播完时还没到点的等到点再播), 用户中途手动开教程则后续让位(fire的_running闸, once不误标)
	if (firstOpenQueue.length) {
		firstOpenQueue.sort((a, b) => a.delay - b.delay);
		const t0 = Date.now();
		let cancelled = false;
		(async () => {
			for (const x of firstOpenQueue) {
				const wait = x.delay - (Date.now() - t0);
				if (wait > 0) await new Promise(r => setTimeout(r, wait));
				if (cancelled) return;
				await x.fire();
			}
		})();
		_autoTriggerCleanups.push(() => { cancelled = true; });
	}
}

// ═══════════════════════════════════════════════════════════════
// 桌宠式教程按钮(凛倾0715批注3): 教程JSON parameters.desk_button = {label?, story, position?}
// 渲染常驻悬浮小钮(四角可选, 默认右下), 点击=播指定线路(角色出现)。样式走--tut-help-*变量族。
// ═══════════════════════════════════════════════════════════════

function _renderDeskButton(script) {
	const db = script.parameters.desk_button;
	const story = db.story || script.parameters?.launch_story;
	if (!story) return;
	_applyHelpVars(); // 按钮挂body(overlay子树外), 变量族需在:root才解析得到
	const btn = document.createElement("button");
	btn.className = "tut-desk-btn";
	btn.textContent = db.label || "教程";
	btn.title = script.title || script.id;
	const off = "var(--tut-desk-offset)";
	const posMap = {
		"bottom-right": { bottom: off, right: off }, "bottom-left": { bottom: off, left: off },
		"top-right": { top: off, right: off }, "top-left": { top: off, left: off },
	};
	btn.style.cssText = `position:fixed;z-index:99997;pointer-events:auto;padding:var(--tut-desk-pad);border-radius:var(--tut-desk-radius);
		background:var(--tut-help-bg);color:var(--tut-help-fg);border:2px solid var(--tut-help-border);
		font-size:var(--tut-desk-fs);font-weight:600;cursor:pointer;box-shadow:var(--tut-desk-shadow);
		animation:tut-help-pulse var(--tut-help-pulse-dur) ease-in-out infinite;`;
	Object.assign(btn.style, posMap[db.position] || posMap["bottom-right"]);
	btn.addEventListener("click", () => { if (!_running) startTutorial(script, { block: story, resume: "ask" }); });
	document.body.appendChild(btn);
	_autoTriggerCleanups.push(() => btn.remove());
}

window.beiluTutorial = {
	startTutorial, stop, isRunning,
	loadTutorial, listTutorials, listImagepacks,
	saveTutorial, deleteTutorial,
	registerTutorialAction,
	enterHelpMode, exitHelpMode, toggleHelpMode, isHelpMode,
	initAutoTriggers,
};
