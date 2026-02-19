// beilu: 自动更新已完全禁用，移除git.mjs依赖

/**
 * 当前的 Git 提交哈希。
 * @type {string|null}
 */
export let currentGitCommit = null

/**
 * 启用空闲时自动检查上游并重启 — beilu: 已禁用，空操作。
 * @returns {void}
 */
export function enableAutoUpdate() {
	// beilu: 自动更新已禁用
}

/**
 * 禁用空闲时自动检查上游并重启 — beilu: 已禁用，空操作。
 * @returns {void}
 */
export function disableAutoUpdate() {
	// beilu: 自动更新已禁用
}
