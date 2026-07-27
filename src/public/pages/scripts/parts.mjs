/**
 * 部件相关的 API 函数。
 */

/**
 * 运行部件。
 * @param {string} partpath - 部件路径。
 * @param {object} args - 参数。
 * @returns {Promise<object>} - 服务器响应。
 */
export async function runPart(partpath, args) {
	const response = await fetch('/api/runpart', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ partpath, args }),
	})
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 加载部件。
 * @param {string} partpath - 部件路径。
 * @returns {Promise<object>} - 服务器响应。
 */
export async function loadPart(partpath) {
	const response = await fetch('/api/loadpart', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ partpath }),
	})
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取部件类型列表。
 * @returns {Promise<string[]>} - 部件类型列表。
 */
export async function getPartTypeList() {
	const response = await fetch('/api/getparttypelist')
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取部件列表。
 * @param {string} path - 路径。
 * @returns {Promise<object>} - 部件列表。
 */
export async function getPartList(path) {
	const response = await fetch(`/api/getlist/${path}`)
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取已加载部件的列表。
 * @param {string} path - 路径。
 * @returns {Promise<object>} - 已加载的部件列表。
 */
export async function getLoadedPartList(path) {
	const response = await fetch(`/api/getloadedlist/${path}`)
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取所有缓存的部件详细信息。
 * @param {string} path - 路径。
 * @returns {Promise<object>} - 缓存的部件详细信息。
 */
export async function getAllCachedPartDetails(path) {
	const response = await fetch(`/api/getallcacheddetails/${path}`)
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取部件详细信息。
 * @param {string} path - 路径。
 * @param {boolean} [nocache=false] - 是否不使用缓存。
 * @returns {Promise<object>} - 部件详细信息。
 */
export async function getPartDetails(path, nocache = false) {
	const url = new URL(window.location.origin + `/api/getdetails/${path}`)
	if (nocache) url.searchParams.set('nocache', 'true')
	const response = await fetch(url)
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取所有默认部件。
 * @returns {Promise<object>} - 默认部件。
 */
export async function getAllDefaultParts() {
	const response = await fetch('/api/defaultpart/getall')
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 设置默认部件。
 * @param {string} parent - 父部件。
 * @param {string} child - 子部件。
 * @returns {Promise<object>} - 服务器响应。
 */
export async function setDefaultPart(parent, child) {
	const response = await fetch('/api/defaultpart/add', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ parent, child }),
	})
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 取消设置默认部件。
 * @param {string} parent - 父部件。
 * @param {string} child - 子部件。
 * @returns {Promise<object>} - 服务器响应。
 */
export async function unsetDefaultPart(parent, child) {
	const response = await fetch('/api/defaultpart/unset', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ parent, child }),
	})
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取任何默认部件。
 * @param {string} parent - 父部件。
 * @returns {Promise<string>} - 默认子部件。
 */
export async function getAnyDefaultPart(parent) {
	const response = await fetch(`/api/defaultpart/getany/${parent}`)
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 废弃 shell 名单 —— 唯一权威定义（why：这些壳已停止维护，落入即全链路死亡）。
 * 键 = 废弃/失效的 shell 名，值 = 迁移目标可用 shell。
 * - 'beilu-home'：老壳，2026-07 判定废弃（凛倾实测老用户落此壳直接死亡）。
 * - 'home'：历史回退串（getAnyDefaultPart 空值时旧代码拼 `shells:home`），该目录从不存在。
 * 存量 config 里带废壳的老用户由后端启动段 migrateStaleShells()（server/parts_loader.mjs，server.mjs 启动段调用）
 * 一次性幂等迁移；本映射是运行期读侧兜底。（注释校准0706：原写 migrate_stale_shells.mjs 独立脚本——该文件不存在，实现为启动内置函数。）
 */
export const DEPRECATED_SHELLS = {
	'beilu-home': 'beilu-chat',
	'home': 'beilu-chat',
}

/** 解析不到默认 shell / 兜底目标时使用的可用 shell。 */
export const FALLBACK_SHELL = 'beilu-chat'

/**
 * 解析登录/入口跳转的默认 shell —— shells 语义单点收口。
 * 三态：废壳→FALLBACK_SHELL(chat) / 正常壳原样返回 / 缺失(空/异常)→FALLBACK_SHELL(chat)。
 * login 跳转与 index 入口两处消费统一走此函数，废壳名单不散落各处 if。
 *
 * 401 例外（20260706 删号传导链根因层）：未认证 ≠ 没配置默认壳，是两种语义。
 *   旧版 catch 把 401 也吞成 FALLBACK_SHELL → index.html 的 .catch(→/login/) 分流死代码化 →
 *   会话失效（删号/过期/被踢）后访问 `/` 被照常导航进 /parts/shells:* 撞 401 死路。
 *   401 必须向上传导，让调用者的 catch 分流去登录页；其余失败（网络抖动/无配置）仍落 FALLBACK。
 * @returns {Promise<string>} - 可跳转的有效 shell 名。
 */
export async function resolveDefaultShell() {
	let shell
	try {
		shell = await getAnyDefaultPart('shells')
	} catch (err) {
		if (err?.response?.status === 401) throw err
		return FALLBACK_SHELL
	}
	if (!shell) return FALLBACK_SHELL
	return DEPRECATED_SHELLS[shell] || shell
}

/**
 * 按类型获取所有默认部件。
 * @param {string} parent - 父部件。
 * @returns {Promise<object>} - 默认子部件列表。
 */
export async function getAllDefaultPartsByType(parent) {
	const response = await fetch(`/api/defaultpart/getallbytype/${parent}`)
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取任何首选的默认部件。
 * @param {string} parent - 父部件。
 * @returns {Promise<string>} - 首选的默认子部件。
 */
export async function getAnyPreferredDefaultPart(parent) {
	const response = await fetch(`/api/defaultpart/getanypreferred/${parent}`)
	if (!response.ok) return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	return response.json()
}

/**
 * 获取部件分支树。
 * @param {boolean} [nocache=false] - 是否绕过缓存。
 * @returns {Promise<object>} - 部件分支对象。
 */
export async function getPartBranches(nocache = false) {
	const url = new URL('/api/getpartbranches', window.location.origin)
	if (nocache) url.searchParams.set('nocache', 'true')
	return fetch(url).then(async response => {
		if (response.ok) return response.json()
		else return Promise.reject(Object.assign(new Error(`API request failed with status ${response.status}`), await response.json().catch(() => ({})), { response }))
	})
}


