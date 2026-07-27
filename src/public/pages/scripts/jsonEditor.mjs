import { createJSONEditor as base } from '/vendor/vanilla-jsoneditor-standalone.js'

import { onThemeChange } from './theme.mjs'
import { showToast } from './toast.mjs'

/**
 * 创建一个 JSON 编辑器。
 * @param {HTMLElement} jsonEditorContainer - JSON 编辑器的容器元素。
 * @param {object} options - 选项。
 * @returns {import('vanilla-jsoneditor').JSONEditor} JSON 编辑器实例。
 */
export function createJsonEditor(jsonEditorContainer, options) {
	const result = base({
		target: jsonEditorContainer,
		props: {
			mode: 'code',
			indentation: '\t',
			...options
		}
	})
	// ctrl+s 保存。preventDefault 先行：原实现 JSON.parse 非法内容抛错时
	// preventDefault 未执行 → 浏览器弹"保存网页"对话框；parse 失败只报错不静默吞保存意图。
	document.addEventListener('keydown', e => {
		if (e.ctrlKey && e.key === 's') {
			e.preventDefault()
			try {
				options.onSave?.(result.get().json || JSON.parse(result.get().text))
			} catch (error) {
				console.error('[jsonEditor] 保存失败（内容不是合法 JSON）:', error)
				// T021 弹出：用户按 ctrl+s 保存失败必须可见，否则以为已保存
				showToast('error', '保存失败（内容不是合法 JSON）: ' + (error?.message || error))
			}
		}
	})
	onThemeChange(
		(theme, isDark) => {
			if (isDark) jsonEditorContainer.classList.add('jse-theme-dark')
			else jsonEditorContainer.classList.remove('jse-theme-dark')
		}
	)
	return result
}

{
	const jse_style = document.createElement('link')
	jse_style.rel = 'stylesheet'
	jse_style.href = '/vendor/jse-theme-dark.min.css'
	jse_style.crossorigin = 'anonymous'
	document.head.prepend(jse_style)
}
