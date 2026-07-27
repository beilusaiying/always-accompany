import { fromHtml } from '/esm-cache/hast-util-from-html'
import { toHtml } from '/esm-cache/hast-util-to-html'
import { h } from '/esm-cache/hastscript'
import languageMap from '/esm-cache/lang-map'
import md5 from '/esm-cache/md5'
import rehypeKatex from '/esm-cache/rehype-katex'
import rehypeMermaid from '/esm-cache/rehype-mermaid'
import rehypePrettyCode from '/esm-cache/rehype-pretty-code'
import rehypeRaw from '/esm-cache/rehype-raw'
import rehypeSanitize, { defaultSchema } from '/esm-cache/rehype-sanitize'
import rehypeStringify from '/esm-cache/rehype-stringify'
import remarkBreaks from '/esm-cache/remark-breaks'
import remarkGfm from '/esm-cache/remark-gfm'
import remarkMath from '/esm-cache/remark-math'
import remarkParse from '/esm-cache/remark-parse'
import remarkRehype from '/esm-cache/remark-rehype'
import { createHighlighter } from '/esm-cache/shiki'
import { unified } from '/esm-cache/unified'
import { visit } from '/esm-cache/unist-util-visit'

import { geti18n } from './i18n.mjs'
import { onThemeChange } from './theme.mjs'

// --- 辅助函数 ---

/**
 * 向 SVG 字符串添加一个类名。
 * @param {string} svg - SVG 字符串。
 * @param {string} className - 要添加的类名。
 * @returns {string} - 添加了类名的 SVG 字符串。
 */
const addClassToSvg = (svg, className) => svg.replace('<svg', `<svg class="${className}"`)

/**
 * 获取语言的扩展名。
 * @param {string} lang - 语言。
 * @returns {string} - 语言的扩展名。
 */
function getLanguageExtension(lang) {
	return languageMap.extensions(lang)?.[0]?.replace(/^\./, '') || lang
}

// --- Unified.js 插件 ---

/**
 * 禁用某些 micromark 扩展。
 * @param {object} [options={}] - 选项。
 * @returns {void}
 */
function remarkDisable(options = {}) {
	const data = this.data()
	const list = data.micromarkExtensions || (data.micromarkExtensions = [])
	list.push({ disable: { null: options.disable || [] } })
}

/**
 * Discord 剧透文本插件（rehype 阶段）。
 * 支持 ||文本|| 语法，将其转换为剧透文本。
 * @returns {Function} - Unified.js 插件。
 */
function rehypeDiscordSpoiler() {
	return tree => {
		visit(tree, 'text', (node, index, parent) => {
			if (!node.value || !(Object(node.value) instanceof String)) return

			// 跳过代码块中的文本（代码块应该保持原样）
			if (parent?.tagName?.toLowerCase() === 'code' || parent?.tagName?.toLowerCase() === 'pre') return

			// 匹配 ||文本|| 模式（至少包含一个非 | 字符）
			const spoilerRegex = /\|\|([^|]+)\|\|/g
			const matches = [...node.value.matchAll(spoilerRegex)]

			if (!matches.length) return

			// 如果整个文本就是一个剧透，直接替换
			if (matches.length === 1 && matches[0][0] === node.value) {
				const spoilerText = matches[0][1]
				parent.children[index] = {
					type: 'element',
					tagName: 'span',
					properties: {
						className: ['discord-spoiler'],
						style: 'background-color: var(--color-base-content); color: transparent; user-select: none; cursor: pointer; border-radius: 3px;',
						onclick: 'this.removeAttribute("style"); this.removeAttribute("onclick");'
					},
					children: [{ type: 'text', value: spoilerText }]
				}
				return
			}

			// 如果有多个匹配或部分匹配，需要拆分文本节点
			const newNodes = []
			let lastIndex = 0

			for (const match of matches) {
				// 添加匹配前的文本
				if (match.index > lastIndex) {
					const beforeText = node.value.slice(lastIndex, match.index)
					if (beforeText) newNodes.push({ type: 'text', value: beforeText })
				}

				// 添加剧透元素
				const spoilerText = match[1]
				newNodes.push({
					type: 'element',
					tagName: 'span',
					properties: {
						className: ['discord-spoiler'],
						style: 'background-color: var(--color-base-content); color: transparent; user-select: none; cursor: pointer; border-radius: 3px;',
						onclick: 'this.removeAttribute("style"); this.removeAttribute("onclick");'
					},
					children: [{ type: 'text', value: spoilerText }]
				})

				lastIndex = match.index + match[0].length
			}

			// 添加剩余的文本
			if (lastIndex < node.value.length) {
				const afterText = node.value.slice(lastIndex)
				if (afterText) newNodes.push({ type: 'text', value: afterText })
			}

			// 替换原节点
			parent.children.splice(index, 1, ...newNodes)
		})
	}
}

/**
 * 为元素添加 DaisyUI 类。
 * @returns {Function} - Unified.js 插件。
 */
function rehypeAddDaisyuiClass() {
	return tree => {
		visit(tree, 'element', node => {
			const existingClasses = node.properties.className || []
			let newClasses = []
			switch (node.tagName) {
				case 'hr':
					newClasses = ['divider', 'divider-primary']
					break
				case 'table':
					newClasses = ['table']
					break
				case 'th':
				case 'td':
					newClasses = ['bg-base-100']
					break
				case 'a':
					newClasses = ['link', 'link-primary']
					break
				default:
					return
			}
			node.properties.className = [...newClasses, ...existingClasses]
		})
	}
}

// --- 图标资源 ---
// T018 离线约束：五个图标原为 api.iconify.design 顶层 await fetch——断网时任一 reject 会使整个模块
// import 失败，markdown.mjs:3 的 catch 兜底把每条消息都渲染成 "Markdown Load Error" 错误页（聊天主渲染
// 链 StreamRenderer/messageList/sidebar 全部降级）。装饰图标无权拖死核心渲染，故内联 SVG 原文
// （内容 = line-md/{clipboard,clipboard-check,download-outline,play,watch} 2026-07-05 快照，视觉不变）。

const iconClass = 'w-5 h-5'
const copyIconCode = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path stroke-dasharray="66" stroke-width="2" d="M12 3h7v18h-14v-18h7Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="66;0"/></path><path stroke-dasharray="14" stroke-dashoffset="14" d="M14.5 3.5v3h-5v-3"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.7s" dur="0.2s" to="0"/></path></g></svg>'
const successIconCode = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path stroke-dasharray="66" stroke-width="2" d="M12 3h7v18h-14v-18h7Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="66;0"/></path><path stroke-dasharray="14" stroke-dashoffset="14" d="M14.5 3.5v3h-5v-3"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.7s" dur="0.2s" to="0"/></path><path stroke-dasharray="12" stroke-dashoffset="12" stroke-width="2" d="M9 13l2 2l4 -4"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.9s" dur="0.2s" to="0"/></path></g></svg>'
const downloadIconCode = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path stroke-dasharray="20" d="M12 4h2v6h2.5l-4.5 4.5M12 4h-2v6h-2.5l4.5 4.5"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.5s" values="20;0"/></path><path stroke-dasharray="14" stroke-dashoffset="14" d="M6 19h12"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.5s" dur="0.2s" to="0"/></path></g></svg>'
const playIconCode = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-dasharray="38" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 6l10 6l-10 6Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.5s" values="38;0"/></path></svg>'
const previewIconCode = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 12c1.72 -3.83 5.53 -6.5 10 -6.5c4.47 0 8.28 2.67 10 6.5c-1.72 3.83 -5.53 6.5 -10 6.5c-4.47 0 -8.28 -2.67 -10 -6.5Z"><animate fill="freeze" attributeName="d" dur="0.5s" values="M4 12c1.38 -0.77 4.42 -1.3 8 -1.3c3.58 0 6.62 0.53 8 1.3c-1.38 0.77 -4.42 1.3 -8 1.3c-3.58 0 -6.62 -0.53 -8 -1.3Z;M2 12c1.72 -3.83 5.53 -6.5 10 -6.5c4.47 0 8.28 2.67 10 6.5c-1.72 3.83 -5.53 6.5 -10 6.5c-4.47 0 -8.28 -2.67 -10 -6.5Z"/></path><circle cx="12" cy="12" r="3" fill="currentColor"><animate fill="freeze" attributeName="r" dur="0.2s" values="0;3"/></circle></svg>'

const copyIconSized = addClassToSvg(copyIconCode, iconClass)
const successIconSized = addClassToSvg(successIconCode, iconClass)
const downloadIconSized = addClassToSvg(downloadIconCode, iconClass)
const playIconSized = addClassToSvg(playIconCode, iconClass)
const previewIconSized = addClassToSvg(previewIconCode, iconClass)

/**
 * 工厂函数，用于创建调用 Godbolt API 的执行器函数。
 * @param {string} compilerId - Godbolt 编译器 ID。
 * @param {string} lang - 语言标识符。
 * @returns {(code: string) => Promise<object>} - 一个自包含的异步执行器函数。
 */
const createGodboltExecutor = (compilerId, lang) => {
	const functionBody = `\
const response = await fetch('https://godbolt.org/api/compiler/${compilerId}/compile', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
	body: JSON.stringify({
		source: code,
		compiler: '${compilerId}',
		lang: '${lang}',
		options: { filters: { execute: true } },
	}),
})

if (!response.ok) {
	return { error: \`Godbolt API request failed: \${response.status} \${response.statusText}\` }
}

const data = await response.json()

if (data.code) {
	const errorText = data.stderr.map(e => e.text).join('\\n')
	return { error: \`Compilation failed:\\n\${errorText}\`, exitcode: data.code }
}

const { execResult } = data
const asm = data.asm?.map(a => a.text).join('\\n') || undefined

if (!execResult || !execResult.didExecute) {
	const buildError = execResult?.buildResult?.stderr?.map(e => e.text).join('\\n') || 'Execution did not run. Check for a missing main function or linking error.'
	return { error: \`Build failed:\\n\${buildError}\`, asm }
}

const result = {
	output: execResult.stdout?.map(o => o.text).join('') || undefined,
	error: execResult.stderr?.map(e => e.text).join('') || undefined,
	asm,
	execTime: execResult.execTime,
	exitcode: execResult.code,
}

Object.keys(result).forEach(key => !result[key] && delete result[key])
return result
`
	return new (Object.getPrototypeOf(async function () { }).constructor)('code', functionBody)
}

/**
 * 代码执行器集合
 * @type {Object.<string, (code: string) => Promise<{result?: string, output?: string, error?: string, exitcode?: number, outputHtml?: string, errorHtml?: string}>>}
 */
const languageExecutors = {
	/**
	 * 执行 JavaScript 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	js: async (code) => {
		try {
			const { async_eval } = await import('/esm-cache/@steve02081504/async-eval')
			return await async_eval(code)
		} catch (error) { return { error } }
	},
	/**
	 * 执行 Python 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	py: async (code) => {
		try {
			const { loadPyodide } = await import('https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.mjs')
			const pyodide = await loadPyodide()

			pyodide.runPython(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
`)

			const importRegex = /pyodide\.loadPackage\(\s*\[([^\]]*)]\s*\)/g
			let match
			while ((match = importRegex.exec(code)) !== null) {
				const packages = match[1].split(',').map(p => p.trim().replace(/["']/g, ''))
				await pyodide.loadPackage(packages)
			}

			const result = await pyodide.runPythonAsync(code)
			const output = pyodide.runPython('sys.stdout.getvalue()')
			const error = pyodide.runPython('sys.stderr.getvalue()')

			if (error)
				return { error: error.trim() }

			return {
				result: result !== undefined ? String(result) : undefined,
				output: output.trim(),
			}
		} catch (error) { return { error } }
	},
	/**
	 * 执行 Ruby 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	rb: async (code) => {
		try {
			const { DefaultRubyVM } = await import('https://cdn.jsdelivr.net/npm/@ruby/wasm-wasi/dist/browser/+esm')
			const response = await fetch('https://cdn.jsdelivr.net/npm/@ruby/head-wasm-wasi/dist/ruby+stdlib.wasm')
			const module = await WebAssembly.compileStreaming(response)
			const { vm } = await DefaultRubyVM(module)

			const initCode = `
require 'stringio'
$stdout = StringIO.new
$stderr = StringIO.new
`
			await vm.evalAsync(initCode)

			const result = await vm.evalAsync(code)
			const output = (await vm.evalAsync('$stdout.string')).toString()
			const error = (await vm.evalAsync('$stderr.string')).toString()

			if (error) return { error: error.trim() }

			return {
				result: result.toString(),
				output: output.trim(),
			}
		} catch (error) { return { error } }
	},
	/**
	 * 执行 Lisp 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	lisp: async (code) => {
		try {
			const { exec } = await import('/esm-cache/lips')
			const { VirtualConsole } = await import('/esm-cache/@steve02081504/virtual-console')
			const vc = new VirtualConsole()

			const result = await vc.hookAsyncContext(() => new Promise((resolve, reject) => {
				exec(code).then(resolve).catch(reject)
			}))

			return {
				result: result !== undefined && result !== null ? JSON.stringify(result, (key, value) => {
					value = value?.__value__ ?? value
					if (Object(value) instanceof BigInt)
						if (Number(value) == value)
							value = Number(value)
						else value = value.toString()
					return value
				}) : undefined,
				output: vc.outputs
			}
		} catch (error) { return { error } }
	},
	/**
	 * 执行 PHP 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	php: async (code) => {
		try {
			const { PhpWeb } = await import('https://cdn.jsdelivr.net/npm/php-wasm/PhpWeb.mjs')
			const php = new PhpWeb()
			let output = ''
			let error = ''

			php.addEventListener('output', (event) => {
				output += event.detail
			})
			php.addEventListener('error', (event) => {
				error += event.detail
			})

			await new Promise(resolve => php.addEventListener('ready', resolve))

			const exitcode = await php.run(`<?php ${code} ?>`)

			if (error || exitcode)
				return { error: (error || `Exited with code ${exitcode}`).trim(), exitcode }

			return {
				output: output.trim(),
				exitcode,
			}
		} catch (error) { return { error } }
	},
	/**
	 * 执行 Lua 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	lua: async (code) => {
		try {
			const { LuaFactory } = await import('/esm-cache/wasmoon')
			const factory = new LuaFactory()
			const lua = await factory.createEngine()

			let output = ''
			lua.global.set('print', lua.createFunction((...args) => {
				output += args.map(arg => lua.toString(arg)).join('\t') + '\n'
			}))

			await lua.doString(code)

			return {
				output: output.trim(),
			}
		} catch (error) { return { error } }
	},
	/**
	 * 执行 SQL 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	sql: async (code) => {
		try {
			const { default: initSqlJs } = await import('/esm-cache/sql.js')
			const SQL = await initSqlJs({
				/**
				 * 定位 SQL.js 文件。
				 * T018 离线约束：wasm 原走 cdn.jsdelivr.net（永不缓存，断网必败）。改走 /esm-cache 同源代理——
				 * 与上面 import 的 sql.js 同一上游（esm.sh）保证版本一致，首次使用后落盘缓存，断网可用。
				 * @param {string} file - 文件名。
				 * @returns {string} - 文件路径。
				 */
				locateFile: file => `/esm-cache/sql.js/dist/${file}`
			})
			const db = new SQL.Database()
			const results = db.exec(code)

			let output = ''
			if (results.length)
				output = results.map(res => {
					const header = `| ${res.columns.join(' | ')} |`
					const separator = `|${'-'.repeat(header.length - 2)}|`
					const rows = res.values.map(row => `| ${row.join(' | ')} |`).join('\n')
					return `${header}\n${separator}\n${rows}`
				}).join('\n\n')

			return {
				result: JSON.stringify(results),
				output: output.trim(),
			}
		} catch (error) { return { error } }
	},
	cpp: createGodboltExecutor('gsnapshot', 'c++'),
	c: createGodboltExecutor('cgsnapshot', 'c'),
	csharp: createGodboltExecutor('dotnettrunkcsharpcoreclr', 'csharp'),
	go: createGodboltExecutor('gltip', 'go'),
	rs: createGodboltExecutor('nightly', 'rust'),
	/**
	 * 执行 brainfuck 代码。
	 * @param {string} code - 要执行的代码。
	 * @returns {Promise<{result?: string, output?: string, error?: string, exitcode?: number}>} - 执行结果。
	 */
	b: async (code) => {
		try {
			const { default: Brainfuck } = await import('/esm-cache/brainfuck-node')
			const brainfuck = new Brainfuck()
			const result = brainfuck.execute(code)
			return { output: result.output }
		} catch (error) { return { error } }
	},
}

/**
 * 创建代码块插件。
 * @param {object} [options={}] - 选项。
 * @param {boolean} [options.isStandalone=false] - 是否为独立模式。
 * @returns {object} - 代码块插件。
 */
function createCodeBlockPlugin({ isStandalone = false } = {}) {
	return {
		name: 'code-block-enhancements',
		/**
		 * 处理 hast 树。
		 * @param {object} hast - hast 树。
		 * @returns {object} - 处理后的 hast 树。
		 */
		root(hast) {
			const rawCode = this.tokens.map(line => line.map(token => token.content).join('')).join('\n')
			const lineCount = this.tokens.length
			const collapseThreshold = 13
			const lang = this.options.lang || 'txt'
			const ext = getLanguageExtension(lang)
			let uniqueId
			do uniqueId = `markdown-code-block-${md5(rawCode)}-${Math.random().toString(36).slice(2, 9)}`
			while (document.getElementById(uniqueId))
			const executor = languageExecutors[ext] || languageExecutors[lang]

			/**
			 * 创建工具提示。
			 * @param {string} textKey - 文本键。
			 * @param {any} children - 子元素。
			 * @param {string} [position='left'] - 位置。
			 * @returns {object} - 工具提示元素。
			 */
			const createTooltip = (textKey, children, position = 'left') => {
				const props = isStandalone
					? { 'data-tip': geti18n(textKey + '.dataset.tip') }
					: { 'data-i18n': textKey }
				return h('div', { class: `tooltip tooltip-${position}`, ...props }, children)
			}

			// 复制按钮
			const copyButtonCore = h('button', {
				class: 'btn btn-ghost btn-square btn-sm text-icon',
				...isStandalone ? { 'aria-label': geti18n('code_block.copy.aria-label') } : { 'data-i18n': 'code_block.copy' },
				onclick: `\
event.stopPropagation()
const button = this
;(async () => {
	const tooltip = button.parentElement
	try {
		await navigator.clipboard.writeText(document.querySelector('#${uniqueId} pre').innerText)
		${isStandalone
						? `tooltip.dataset.tip = '${geti18n('code_block.copied.dataset.tip')}'`
						: 'tooltip.dataset.i18n = \'code_block.copied\''
}
		button.innerHTML = ${JSON.stringify(successIconSized)}
	} catch (e) {
		${isStandalone
						? 'alert(\'Failed to copy: \' + e.message)'
						: 'const { showToastI18n } = await import(\'/scripts/toast.mjs\'); showToastI18n(\'error\', \'code_block.copy_failed\', { error: e.message })'
}
	}
	setTimeout(() => {
		${isStandalone
						? `tooltip.dataset.tip = '${geti18n('code_block.copy.dataset.tip')}'`
						: 'tooltip.dataset.i18n = \'code_block.copy\''
}
		button.innerHTML = ${JSON.stringify(copyIconSized)}
	}, 2000)
})()
`,
			}, [fromHtml(copyIconSized, { fragment: true })])

			// 下载按钮
			const downloadButtonCore = h('button', {
				class: 'btn btn-ghost btn-square btn-sm text-icon',
				...isStandalone ? { 'aria-label': geti18n('code_block.download.aria-label') } : { 'data-i18n': 'code_block.download' },
				onclick: `\
event.stopPropagation()
const code = document.querySelector('#${uniqueId} pre').innerText
const a = document.createElement('a')
a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(code)
a.download = \`code.${ext}\`
document.body.appendChild(a)
a.click()
document.body.removeChild(a)
`,
			}, [fromHtml(downloadIconSized, { fragment: true })])

			// 预览按钮 — 应用内 artifact 面板（任务F，凛倾 2026-07-09「AI 给出前端代码…类似 claude 网页一样渲染…用户还可以进行编辑」）
			// why 改造：旧行为 window.open + document.write = 同源新窗口裸执行 AI 代码（无 sandbox 隔离）且体验割裂。
			// 现：代码块下方展开 artifact——sandbox iframe（只给 allow-scripts，origin=null 触不到本站登录态，
			// 与聊天美化消息 iframeRenderer 同权限档）运行代码 + 用户可编辑重渲染 + 新窗口(旧行为保留为次级、
			// 用户主动动作) + 保存到工作区（beilu:artifact-save 事件解耦，shell 侧 fileExplorer 订阅落盘；
			// standalone 导出场景无 shell 不渲染保存钮）。创作平台定位：本插件只做机制不做内容样式。
			let previewButtonCore = null
			if (ext === 'html')
				previewButtonCore = h('button', {
					class: 'btn btn-ghost btn-square btn-sm text-icon',
					...isStandalone ? { 'aria-label': geti18n('code_block.preview.aria-label') } : { 'data-i18n': 'code_block.preview' },
					onclick: `\
event.stopPropagation()
const codeBlockContainer = document.getElementById('${uniqueId}')
const oldPanels = document.querySelectorAll('.${uniqueId}-artifact')
if (oldPanels.length) { oldPanels.forEach((n) => n.remove()); return } // 再点=收起
const code = codeBlockContainer.querySelector('pre').innerText
const panel = document.createElement('div')
panel.className = '${uniqueId}-artifact border border-base-300 rounded-lg mt-1 overflow-hidden'
const bar = document.createElement('div')
bar.className = 'flex items-center gap-1 px-2 py-1 bg-base-200/60'
const mkBtn = (label, title) => { const b = document.createElement('button'); b.className = 'btn btn-ghost btn-xs'; b.textContent = label; b.title = title; return b }
const editBtn = mkBtn('\\u270F\\uFE0F \\u7F16\\u8F91', '\\u7F16\\u8F91\\u4EE3\\u7801\\u5E76\\u91CD\\u65B0\\u6E32\\u67D3')
const applyBtn = mkBtn('\\u25B6 \\u5E94\\u7528', '\\u7528\\u4E0B\\u65B9\\u4FEE\\u6539\\u540E\\u7684\\u4EE3\\u7801\\u91CD\\u65B0\\u6E32\\u67D3')
const openBtn = mkBtn('\\u2197', '\\u65B0\\u7A97\\u53E3\\u6253\\u5F00')
const saveBtn = ${isStandalone ? 'null' : "mkBtn('\\u4FDD\\u5B58', '\\u4FDD\\u5B58\\u5230\\u5DE5\\u4F5C\\u533A')"}
const closeBtn = mkBtn('\\u2715', '\\u5173\\u95ED')
closeBtn.style.marginLeft = 'auto'
applyBtn.classList.add('hidden')
const iframe = document.createElement('iframe')
iframe.sandbox = 'allow-scripts'
iframe.className = 'w-full border-0 bg-white'
iframe.style.height = '360px'
iframe.srcdoc = code
const ta = document.createElement('textarea')
ta.className = 'w-full font-mono text-xs p-2 bg-base-100 hidden'
ta.style.height = '200px'
ta.spellcheck = false
ta.value = code
editBtn.onclick = () => { ta.classList.toggle('hidden'); applyBtn.classList.toggle('hidden') }
applyBtn.onclick = () => { iframe.srcdoc = ta.value }
openBtn.onclick = () => { const w = window.open('', '_blank'); w.document.write(ta.value); w.document.close() }
if (saveBtn) saveBtn.onclick = () => {
	window.dispatchEvent(new CustomEvent('beilu:artifact-save', { detail: { code: ta.value, ext: 'html' } }))
	saveBtn.textContent = '\\u2713'
	setTimeout(() => { saveBtn.textContent = '\\u4FDD\\u5B58' }, 2000)
}
closeBtn.onclick = () => panel.remove()
bar.append(editBtn, applyBtn, openBtn)
if (saveBtn) bar.append(saveBtn)
bar.append(closeBtn)
panel.append(bar, iframe, ta)
codeBlockContainer.insertAdjacentElement('afterend', panel)
`,
				}, [fromHtml(previewIconSized, { fragment: true })])

			// 执行按钮（SEC-T13：用户可经 localStorage beilu-code-exec='off' 彻底关闭代码执行）
			let executeButtonCore = null
			if (executor && getCodeExecEnabled())
				executeButtonCore = h('button', {
					class: 'btn btn-ghost btn-square btn-sm text-icon',
					...isStandalone ? { 'aria-label': geti18n('code_block.execute.aria-label') } : { 'data-i18n': 'code_block.execute' },
					onclick: `\
event.stopPropagation()
const codeBlockContainer = document.getElementById('${uniqueId}')
const preExistingOutput = document.querySelectorAll('.${uniqueId}-execution-output')
for (const output of preExistingOutput) output.remove()

const outputContainer = document.createElement('div')
outputContainer.innerHTML = /* html */ \`\\
<div class="join-item alert">
	${playIconSized}
	<div class="loading loading-spinner"></div>
</div>
\`
codeBlockContainer.insertAdjacentElement('afterend', outputContainer)

const copySvg = decodeURIComponent(${JSON.stringify(encodeURIComponent(copyIconSized))})
const successSvg = decodeURIComponent(${JSON.stringify(encodeURIComponent(successIconSized))})

const createCopyBtn = (text) => {
	const encoded = encodeURIComponent(text).replace(/'/g, '%27')
	const copyAction = \`\\
event.stopPropagation()
const btn = this
navigator.clipboard.writeText(decodeURIComponent('\${encoded}')).then(() => {
	btn.innerHTML = \${JSON.stringify(successSvg)}
	setTimeout(() => btn.innerHTML = \${JSON.stringify(copySvg)}, 2000)
	${isStandalone
							? `btn.parentElement.dataset.tip = decodeURIComponent(${JSON.stringify(encodeURIComponent(geti18n('code_block.copied.dataset.tip')))})`
							: 'btn.parentElement.dataset.i18n = \'code_block.copied\''
}
}).catch(error => {
	${isStandalone
							? 'alert(\'Failed to copy: \' + error.message)'
							: 'import(\'/scripts/toast.mjs\').then(({ showToastI18n }) => showToastI18n(\'error\', \'code_block.copy_failed\', { error: error.message }))'
}
})
\`

	return /* html */ \`\\
<button class="btn btn-ghost btn-square btn-xs absolute top-2 right-2 opacity-70 hover:opacity-100 z-10"
		${isStandalone ? 'aria-label="Copy"' : 'data-i18n="code_block.copy"'}
		onclick="\${copyAction.replace(/"/g, '&quot;')}" >
	\${copySvg}
</button>\`
}

;(${executor.toString()})(document.querySelector('#${uniqueId} pre').innerText).then(async result => {
	result = result || {}
	// T018：executor catch 返回的 error 可能是 Error 对象（离线时 CDN import/fetch 的 TypeError）——此处是所有 executor 的唯一渲染出口，归一化为字符串+离线提示
	if (result.error && !(Object(result.error) instanceof String)) {
		result.error = String(result.error?.message || result.error)
		if (!navigator.onLine) result.error = 'Runtime unavailable (offline).\n' + result.error
	}
	const { AnsiUp } = await import('/esm-cache/ansi-up')
	const ansi_up = new AnsiUp()
	const escapeHtml = (str) => ansi_up.ansi_to_html(str)

	let alerts = []

	if (result.error)
		alerts.push(/* html */ \`\\
<div class="join-item alert alert-error bg-error/50 border-error/50 relative pr-10">
	\${createCopyBtn(result.error)}
	<div>
		<div class="font-bold">Error</div>
		<pre class="font-mono text-sm overflow-x-auto whitespace-pre-wrap">\${result.errorHtml || '<code>'+escapeHtml(result.error)+'</code>'}</pre>
	</div>
</div>
\`)
	if (result.output)
		alerts.push(/* html */ \`\\
<div class="join-item alert alert-info bg-info/40 border-info/40 relative pr-10">
	\${createCopyBtn(result.output)}
	<div>
		<div class="font-bold">Output</div>
		<pre class="font-mono text-sm overflow-x-auto whitespace-pre-wrap">\${result.outputHtml || '<code>'+escapeHtml(result.output)+'</code>'}</pre>
	</div>
</div>
\`)
	if (result.asm)
		alerts.push(/* html */ \`\\
<details class="join-item collapse alert alert-warning bg-warning/40 border-warning/40">
	<summary class="collapse-title font-bold text-sm">Assembly</summary>
	<div class="collapse-content relative pr-10">
		\${createCopyBtn(result.asm)}
		<pre class="font-mono text-xs overflow-x-auto">\${result.asmHtml || '<code>'+escapeHtml(result.asm)+'</code>'}</pre>
	</div>
</details>
\`)
	if (result.result)
		alerts.push(/* html */ \`\\
<div class="join-item alert alert-success bg-success/40 border-success/40 relative pr-10">
	\${createCopyBtn(result.result)}
	<div>
		<div class="font-bold">Result</div>
		<pre class="font-mono text-sm font-bold overflow-x-auto whitespace-pre-wrap">\${result.resultHtml || '<code>'+escapeHtml(result.result)+'</code>'}</pre>
	</div>
</div>
\`)

	const footerItems = []
	if (result.execTime)
		footerItems.push(\`<div><div class="text-xs">Execution Time: \${result.execTime} ms</div></div>\`)
	if (result.exitcode)
		footerItems.push(\`<div><div class="text-xs">Exit Code: \${result.exitcode}</div></div>\`)

	if (footerItems.length)
		alerts.push(/* html */ \`\\
<div class="join-item alert alert-secondary bg-secondary/40 border-secondary/40 flex justify-between w-full">
	\${footerItems.join('')}
</div>
\`)

	if (!alerts.length)
		alerts.push(/* html */ \`\\
<div class="join-item alert alert-success bg-success/40 border-success/40">
	<div><div class="text-xs">Execution finished with no output.</div></div>
</div>
\`)

	outputContainer.innerHTML = alerts.join('')
	window.dispatchEvent(new CustomEvent('markdown-codeblock-execution-result', { detail: {
		lang: '${lang}',
		code: document.querySelector('#${uniqueId} pre').innerText,
		...result
	}}))
}).catch(e => {
	outputContainer.innerHTML = /* html */ \`\\
<div class="join-item alert alert-error bg-error/70 border-error/70">
	\${createCopyBtn(e.stack)}
	<div>
		<div class="font-bold">Execution Error</div>
		<pre class="text-xs overflow-x-auto whitespace-pre-wrap"><code>\${e.stack}</code></pre>
	</div>
</div>
\`
	window.dispatchEvent(new CustomEvent('markdown-codeblock-execution-error', { detail: {
		lang: '${lang}',
		code: document.querySelector('#${uniqueId} pre').innerText,
		error: e
	}}))
}).then(() => {
	for (const child of [...outputContainer.children].reverse()) {
		child.classList.add('${uniqueId}-execution-output')
		codeBlockContainer.after(child)
	}
	outputContainer.remove()
})
`,
				}, [fromHtml(playIconSized, { fragment: true })])

			/**
			 * 获取按钮组。
			 * @param {string} tooltipPosition - 工具提示位置。
			 * @returns {object} - 按钮组元素。
			 */
			const getButtonGroup = (tooltipPosition) => {
				const buttons = []
				if (previewButtonCore)
					buttons.push(createTooltip('code_block.preview', [previewButtonCore], tooltipPosition))
				if (executeButtonCore)
					buttons.push(createTooltip('code_block.execute', [executeButtonCore], tooltipPosition))

				buttons.push(
					createTooltip('code_block.download', [downloadButtonCore], tooltipPosition),
					createTooltip('code_block.copy', [copyButtonCore], tooltipPosition)
				)
				return h('div', { class: 'flex items-center' }, buttons)
			}

			if (lineCount > collapseThreshold) {
				const buttonNode = getButtonGroup()
				const summaryNode = h('summary', { class: 'bg-base-200 collapse-title' }, [h('div', {
					class: 'font-mono text-xs font-bold flex items-center justify-between'
				}, [
					h('span', `${lang.toUpperCase()} - ${lineCount} lines`),
					buttonNode
				])])
				return h('details', { id: uniqueId, class: 'markdown-code-block collapse collapse-arrow join-item', open: true }, [
					summaryNode,
					h('div', { class: 'collapse-content' }, [hast])
				])
			}

			const buttonNode = h('div', { class: 'absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200' }, [getButtonGroup('left')])
			return h('div', { id: uniqueId, class: 'markdown-code-block group join-item', style: 'position: relative' }, [hast, buttonNode])
		}
	}
}

// --- 缓存插件 ---

/**
 * 读取缓存插件
 * @returns {object} - 读取缓存插件
 */
function rehypeCacheRead() {
	return (tree, file) => {
		const { cache } = file.data
		if (!cache) return

		visit(tree, 'element', (node, index, parent) => {
			// 1. 识别 Mermaid (pre > code.language-mermaid)
			// 2. 识别 普通代码块 (pre > code) - 添加这个以优化 Shiki 高亮性能
			if (node.tagName === 'pre' && node.children?.[0]?.tagName === 'code') {
				const codeNode = node.children[0]
				const className = codeNode.properties.className ??= []
				const content = codeNode.children?.[0]?.value || ''

				// 如果没有语言类，默认添加 language-text，这样 rehype-pretty-code 才会调用 transformer 添加复制按钮
				if (!className.some(c => c.startsWith('language-'))) className.push('language-text')

				// 区分 Mermaid 和普通代码
				const isMermaid = className.includes('language-mermaid')
				const lang = className.find(c => c.startsWith('language-')) || 'text'

				// 生成 Cache Key (包含内容和语言)
				const hash = md5(content + lang)

				// Mermaid 渲染结果在 standalone 和普通模式下相同，使用 common 缓存
				// 普通代码块包含交互按钮，在两种模式下不同，使用 specific 缓存
				const cacheStore = isMermaid ? cache.common : cache.specific
				const cacheKey = isMermaid ? `mermaid-${hash}` : `code-${hash}`

				if (cacheStore && cacheStore[cacheKey]) {
					// HIT: 使用缓存替换当前节点
					const cachedHast = fromHtml(cacheStore[cacheKey], { fragment: true }).children
					parent.children.splice(index, 1, ...cachedHast)
					// 跳过刚插入的节点，避免重复访问
					return index + cachedHast.length
				} else {
					// MISS: 包装节点以便后续插件处理后被 Write 插件捕获
					const wrapper = {
						type: 'element',
						tagName: 'div',
						// 使用通用属性，后续 Write 插件只需检查这个属性
						properties: {
							'data-cache-key': cacheKey,
							'data-cache-store': isMermaid ? 'common' : 'specific',
							style: 'display: contents;'
						},
						children: [node]
					}
					parent.children[index] = wrapper
				}
			}

			// 3. 识别 Math (span.math-inline / div.math-display)
			// Math 渲染结果在 standalone 和普通模式下相同，使用 common 缓存
			if (node.properties?.className?.some(c => c === 'math-inline' || c === 'math-display')) {
				const content = node.children?.[0]?.value || ''
				const hash = md5(content)
				const cacheKey = `math-${hash}`
				const cacheStore = cache.common

				if (cacheStore && cacheStore[cacheKey]) {
					const cachedHast = fromHtml(cacheStore[cacheKey], { fragment: true }).children
					parent.children.splice(index, 1, ...cachedHast)
					return index + cachedHast.length
				} else {
					const wrapper = {
						type: 'element',
						tagName: 'div',
						properties: {
							'data-cache-key': cacheKey,
							'data-cache-store': 'common',
							style: 'display: contents;'
						},
						children: [node]
					}
					parent.children[index] = wrapper
				}
			}
		})
	}
}

/**
 * 写入缓存插件
 * @returns {object} - 写入缓存插件
 */
function rehypeCacheWrite() {
	return (tree, file) => {
		const { cache } = file.data
		if (!cache) return

		visit(tree, 'element', (node, index, parent) => {
			const key = node.properties?.['data-cache-key']
			const storeType = node.properties?.['data-cache-store'] || 'specific'

			if (key) {
				// 根据 storeType 选择缓存存储位置
				const targetStore = cache[storeType] ??= {}

				// 将处理后的子节点序列化为 HTML 字符串存入缓存
				const html = toHtml(node.children)
				targetStore[key] = html

				// 解包：移除 wrapper div，将内容提升到父级
				parent.children.splice(index, 1, ...node.children)

				// 返回当前索引，以便继续正确遍历后续节点
				return index
			}
		})
	}
}

/**
 * SEC-T13：读取 markdown 代码块「执行」按钮开关（localStorage: beilu-code-exec）。
 *   代码块执行(js→async_eval / py→pyodide 等)仅在用户【显式点击执行按钮】时触发(非自动)，
 *   但点击不可信内容(AI/角色卡/世界书)里的代码块会在本人浏览器会话内跑任意代码。
 *   故提供用户可控开关：默认 'on'（保留功能、显式点击才跑），设 'off' 则不渲染执行按钮(彻底关闭)。
 * @returns {boolean} 是否允许渲染代码执行按钮。
 */
function getCodeExecEnabled() {
	try {
		const v = typeof localStorage !== 'undefined' && localStorage.getItem('beilu-code-exec')
		return v !== 'off' // 默认 on；仅显式 'off' 关闭
	} catch { return true }
}

// --- HTML 净化（XSS 防护，F-D5）---

/**
 * 读取净化严格度配置（localStorage: beilu-sanitize-level）。
 * 安全默认：strict。owner 可在设置里改 loose（仅放宽 style 等，仍剥脚本/事件属性/危险协议）。
 * @returns {'strict'|'loose'} 严格度档位。
 */
function getSanitizeLevel() {
	try {
		const v = typeof localStorage !== 'undefined' && localStorage.getItem('beilu-sanitize-level')
		return v === 'loose' ? 'loose' : 'strict'
	} catch { return 'strict' }
}

/**
 * 构建 rehype-sanitize 的 schema（基于 hast-util-sanitize defaultSchema 扩展）。
 *
 * 设计要点（F-D5 sec_D5 §3.1）：
 * - rehype-sanitize 紧跟 rehypeRaw 运行（见 GetMarkdownConvertor），此时 hast 树里
 *   只有"原始文本解析出的 HTML"，框架增强插件(spoiler/prettyCode/katex/mermaid/daisyui class)
 *   都在 sanitize 之后运行 → 框架产物天然不被剥，仅原始 HTML 被净化。
 * - defaultSchema 已做的：strip script、on* 事件属性不在白名单(自动剥)、href/src 协议限 http(s)等
 *   (自动剥 javascript:/vbscript:/data:text/html)、不含 iframe/object/embed/base/meta/svg(自动剥)。
 * - 本扩展只放行原始 HTML 里安全且常用的 className(class 不能执行 JS)，使纯 CSS 美化存活；
 *   不放行 style 属性(可藏 expression()/url(javascript:))，loose 档才放行 style。
 *
 * @param {'strict'|'loose'} level - 严格度。
 * @returns {object} hast-util-sanitize schema。
 */
function buildSanitizeSchema(level) {
	const base = defaultSchema
	const starAttrs = (base.attributes && base.attributes['*']) || []
	const extendedStar = [...starAttrs, 'className']
	// loose 档额外放行 style（CSS 注入风险低于 JS，但仍可藏 url(javascript:)，故非默认）
	if (level === 'loose') extendedStar.push('style')
	return {
		...base,
		// 显式确保 script 被剥（与 default 一致，防上游变更）
		strip: [...new Set([...(base.strip || []), 'script', 'iframe', 'object', 'embed', 'base', 'meta', 'noscript', 'template'])],
		attributes: {
			...base.attributes,
			'*': extendedStar,
		},
		// 协议白名单沿用 default（href/src 限 http(s)/mailto 等），额外显式声明 srcdoc 不放行
		protocols: {
			...base.protocols,
		},
	}
}

// --- Markdown 转换器 ---

/**
 * 获取 Markdown 转换器。
 * @param {object} [options={}] - 选项。
 * @param {boolean} [options.isStandalone=false] - 是否为独立模式。
 * @param {boolean} [options.trusted=false] - 是否为可信源。false(默认)走 HTML 净化；
 *   true 跳过净化(仅系统自渲染 UI 等可信内容用，AI 输出/角色卡/世界书/网页一律 false)。
 * @returns {Promise<import('npm:unified').Processor>} - Markdown 转换器。
 */
export async function GetMarkdownConvertor({ isStandalone = false, trusted = false } = {}) {
	const pipeline = unified()
		.use(remarkParse)
		.use(remarkDisable, { disable: ['codeIndented'] })
		.use(remarkBreaks)
		.use(remarkMath)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeRaw)
	// ★ F-D5 XSS 净化：紧跟 rehypeRaw、在所有框架增强插件之前插 rehype-sanitize。
	//   非可信源(默认)才净化；可信源跳过(系统自渲染不含外来注入)。
	if (!trusted)
		pipeline.use(rehypeSanitize, buildSanitizeSchema(getSanitizeLevel()))
	return pipeline
		.use(remarkGfm, { singleTilde: false })
		.use(rehypeCacheRead)
		.use(rehypeDiscordSpoiler)
		.use(rehypeMermaid, {
			dark: true,
			/**
			 * Mermaid 错误回退。
			 * @param {object} element - 元素。
			 * @param {string} diagram - 图表。
			 * @param {Error} error - 错误。
			 * @returns {object} - 回退元素。
			 */
			errorFallback: (element, diagram, error) => {
				// https://github.com/remcohaszing/rehype-mermaid/issues/31
				document.getElementById('dmermaid-0')?.remove()
				document.getElementById('dmermaid-dark-0')?.remove()

				return h('pre.mermaid-error-fallback', `\
❌ Mermaid Diagram Failed to Render
Error: ${error.message}
--- Diagram Source ---
${diagram}`
				)
			}
		})
		.use(rehypePrettyCode, {
			theme: {
				dark: 'github-dark-dimmed',
				light: 'github-light',
			},
			/**
			 * 扩展默认的高亮器配置
			 * @param {object} options - 选项。
			 * @returns {Promise<import('npm:shiki').Highlighter>} - 高亮器。
			 */
			getHighlighter: options => createHighlighter({
				...options,
				langs: [
					...options.langs,
					async () => {
						try {
							return {
								...await fetch('https://cdn.jsdelivr.net/gh/Chris2011/netbeans-textmate-files@master/supported%20languages/brainfuck/brainfuck.tmLanguage.json').then(res => res.json()),
								name: 'brainfuck',
								displayName: 'Brainfuck',
								aliases: ['bf'],
							}
						} catch {
							// T018 离线退化：语法定义是纯装饰外链，加载失败时给最小合法 grammar——
							// 仅 brainfuck 失去高亮，而非拖死 createHighlighter 连带所有代码块渲染。
							return { name: 'brainfuck', displayName: 'Brainfuck', aliases: ['bf'], scopeName: 'source.brainfuck', patterns: [], repository: {} }
						}
					}
				]
			}),
			transformers: [
				await createCodeBlockPlugin({ isStandalone })
			],
			/**
			 * 访问标题。
			 * @param {object} caption - 标题。
			 * @returns {void}
			 */
			onVisitCaption(caption) {
				caption.properties.className = 'alert alert-secondary shadow-lg join-item'
			},
			/**
			 * 访问标题。
			 * @param {object} title - 标题。
			 * @returns {void}
			 */
			onVisitTitle(title) {
				title.properties.className = 'alert alert-info shadow-lg join-item'
			}
		})
		.use(() => {
			return tree => {
				visit(tree, 'element', node => {
					if (!node.properties.className && node.tagName === 'figure' && node.children.some(child => child.properties.className?.includes?.('markdown-code-block')))
						node.properties.className = 'join join-vertical [&:not(:last-child)]:pb-6'
				}, true)
			}
		})
		.use(rehypeKatex)
		.use(rehypeCacheWrite)
		.use(rehypeAddDaisyuiClass)
		.use(rehypeStringify, {
			allowDangerousCharacters: true,
			allowDangerousHtml: true,
			tightBreaks: true,
		})
}

// --- 全局样式注入 ---

document.head.prepend(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/katex.min.css' }))

const markdown_style = document.createElement('link')
markdown_style.rel = 'stylesheet'
markdown_style.crossOrigin = 'anonymous'
onThemeChange((theme, is_dark) => {
	markdown_style.href = `/vendor/github-markdown-${is_dark ? 'dark' : 'light'}.min.css`
})
document.head.prepend(markdown_style)
