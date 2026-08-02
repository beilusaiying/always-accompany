/**
 * MCP runtime source of truth.
 *
 * This registry stores only the primitive status fields needed by system/API/macro
 * consumers. Connection config, command args, environment variables, tokens, and
 * tool definitions must never be stored here.
 */

/** @typedef {{
 *   key: string,
 *   username: string|null,
 *   name: string,
 *   transport: 'stdio'|'websocket'|'http'|null,
 *   configured: boolean,
 *   approved: boolean,
 *   connected: boolean,
 *   error: string|null,
 *   toolCount: number,
 *   updatedAt: string
 * }} McpRuntimeEntry */

/** @type {Map<string, McpRuntimeEntry>} */
const runtimeEntries = new Map()
/** @type {Map<string, symbol>} */
const runtimeOwners = new Map()

/**
 * Runtime ownership is the authenticated owner plus the physical plugin identity.
 * The same plugin basename may exist for multiple users, while a hot reload of the
 * same owner/plugin pair must replace the prior lifecycle owner.
 *
 * @param {string|{username?: string|null, pluginIdentity: string}} lifecycleIdentity
 * @returns {string}
 */
function toLifecycleKey(lifecycleIdentity) {
	if (lifecycleIdentity && typeof lifecycleIdentity === 'object') {
		const pluginIdentity = String(lifecycleIdentity.pluginIdentity || '')
		if (!pluginIdentity) throw new TypeError('MCP runtime pluginIdentity is required')
		const username = lifecycleIdentity.username === undefined || lifecycleIdentity.username === null
			? ''
			: String(lifecycleIdentity.username)
		return JSON.stringify([username, pluginIdentity])
	}
	return String(lifecycleIdentity)
}

/**
 * Select only public contract fields so callers cannot accidentally retain secrets.
 * @param {Partial<McpRuntimeEntry>} value
 * @returns {McpRuntimeEntry}
 */
function toRuntimeEntry(value) {
	return {
		key: String(value.key || ''),
		username: value.username === undefined || value.username === null ? null : String(value.username),
		name: String(value.name || ''),
		transport: ['stdio', 'websocket', 'http'].includes(value.transport) ? value.transport : null,
		configured: value.configured === true,
		approved: value.approved === true,
		connected: value.connected === true,
		error: value.error === undefined || value.error === null ? null : String(value.error),
		toolCount: Number.isSafeInteger(value.toolCount) && value.toolCount >= 0 ? value.toolCount : 0,
		updatedAt: new Date().toISOString(),
	}
}

/**
 * Register one createMcpPart lifecycle.
 * @param {string|{username?: string|null, pluginIdentity: string}} lifecycleIdentity
 *   Internal owner/plugin identity; never exposed by snapshots
 * @param {Partial<McpRuntimeEntry>} initialState
 * @returns {{update: (patch: Partial<McpRuntimeEntry>) => void, remove: () => void}}
 */
export function registerMcpRuntime(lifecycleIdentity, initialState) {
	const internalKey = toLifecycleKey(lifecycleIdentity)
	const owner = Symbol('mcp-runtime')
	runtimeOwners.set(internalKey, owner)
	runtimeEntries.set(internalKey, toRuntimeEntry(initialState))
	return Object.freeze({
		update(patch) {
			const activeOwner = runtimeOwners.get(internalKey)
			if (activeOwner && activeOwner !== owner) return
			runtimeOwners.set(internalKey, owner)
			const current = runtimeEntries.get(internalKey)
			runtimeEntries.set(internalKey, toRuntimeEntry({ ...(current || initialState), ...patch }))
		},
		remove() {
			if (runtimeOwners.get(internalKey) !== owner) return
			runtimeOwners.delete(internalKey)
			runtimeEntries.delete(internalKey)
		},
	})
}

/**
 * Pure MCP health reducer shared by list, request, and transport lifecycle paths.
 * It deliberately keeps transport health separate from tool/application errors:
 * a JSON-RPC application error proves the transport answered, while timeout keeps
 * the prior connected bit and exposes degraded health.
 *
 * @param {{connected?: boolean, error?: string|null, toolCount?: number}} current
 * @param {{
 *   type: 'reset'|'catalog_succeeded'|'catalog_failed'|'request_succeeded'|'request_failed'|'transport_failed',
 *   error?: unknown,
 *   toolCount?: number,
 *   failureKind?: 'transport'|'timeout'|'application'
 * }} event
 * @returns {{connected: boolean, error: string|null, toolCount: number}}
 */
export function reduceMcpRuntimeHealth(current, event) {
	const state = {
		connected: current?.connected === true,
		error: current?.error === undefined || current?.error === null ? null : String(current.error),
		toolCount: Number.isSafeInteger(current?.toolCount) && current.toolCount >= 0 ? current.toolCount : 0,
	}
	const error = event?.error === undefined || event?.error === null
		? null
		: String(event.error?.message || event.error)

	switch (event?.type) {
		case 'reset':
			return { connected: false, error: null, toolCount: 0 }
		case 'catalog_succeeded':
			return {
				connected: true,
				error: null,
				toolCount: Number.isSafeInteger(event.toolCount) && event.toolCount >= 0 ? event.toolCount : 0,
			}
		case 'catalog_failed':
		case 'transport_failed':
			return { connected: false, error, toolCount: 0 }
		case 'request_succeeded':
			return { ...state, connected: true, error: null }
		case 'request_failed':
			if (event.failureKind === 'transport')
				return { connected: false, error, toolCount: 0 }
			if (event.failureKind === 'timeout')
				return { ...state, error }
			if (event.failureKind === 'application')
				return { ...state, connected: true, error: null }
			throw new TypeError(`Unknown MCP request failure kind: ${event.failureKind}`)
		default:
			throw new TypeError(`Unknown MCP runtime event: ${event?.type}`)
	}
}

/**
 * Return a safe copy of current MCP runtime state.
 * @param {string} [username] Optional exact username filter
 * @returns {McpRuntimeEntry[]}
 */
export function getMcpRuntimeSnapshot(username) {
	const filterUsername = username === undefined ? undefined : String(username)
	return [...runtimeEntries.values()]
		.filter((entry) => filterUsername === undefined || entry.username === filterUsername)
		.map((entry) => ({ ...entry }))
}
