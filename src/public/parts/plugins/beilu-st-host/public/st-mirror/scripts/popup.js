/**
 * [beilu-st-host · st-mirror shim] scripts/popup.js —— 酒馆弹窗系统落点（P1，一期抛错 stub）。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.3）】
 *   Popup / callGenericPopup / POPUP_TYPE → Timelines / memory-enhancement（弹窗 UI）。
 *
 * 【一期策略】P1：弹窗多在「用户交互时」才触发（非加载即崩），故一期抛错 stub 即可（红线2 可见）。
 *   二期由 st-ui 提供真实弹窗桥。POPUP_TYPE 是枚举常量，给出值防 undefined（非「未实现 API」）。
 */

/** ST 弹窗类型枚举（常量表，非未实现 API，照给防 undefined）。 */
export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 }
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null }

/** 通用弹窗（P1 stub，二期接 st-ui 弹窗桥）。 */
export function callGenericPopup(...args) {
	throw new Error('[beilu宿主] callGenericPopup 尚未实现（一期 P1 stub）。弹窗系统属二期 st-ui 弹窗桥。')
}

/** ST Popup 类（P1 stub）。构造即抛，避免插件拿到坏实例后静默失败。 */
export class Popup {
	constructor() {
		throw new Error('[beilu宿主] Popup 类尚未实现（一期 P1 stub）。弹窗系统属二期 st-ui 弹窗桥。')
	}
}

/** 固定文案弹窗别名（P1 stub）。 */
export function callPopup(...args) {
	throw new Error('[beilu宿主] callPopup 尚未实现（一期 P1 stub）。弹窗系统属二期。')
}
