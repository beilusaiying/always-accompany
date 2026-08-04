import { existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function env(name) {
	try { return globalThis.Deno?.env?.get?.(name) ?? globalThis.process?.env?.[name] }
	catch { return globalThis.process?.env?.[name] }
}

function absoluteEnv(name, fallback) {
	const value = String(env(name) || '').trim()
	return resolve(value || fallback)
}

function discoverRepoRoot(start) {
	let current = resolve(start)
	for (;;) {
		if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'src'))) return current
		const parent = dirname(current)
		if (parent === current) throw new Error(`P1 repository root not found from ${start}`)
		current = parent
	}
}

export const P1_ROOT = fileURLToPath(new URL('./', import.meta.url))
export const REPO_ROOT = absoluteEnv('P1_REPO_ROOT', discoverRepoRoot(P1_ROOT))
export const RESOURCE_ROOT = absoluteEnv('P1_RESOURCE_DIR', join(P1_ROOT, 'resources'))
export const STORAGE_ROOT = absoluteEnv('P1_STORAGE_DIR', join(REPO_ROOT, 'storage', 'p1'))
export const RUNTIME_ROOT = absoluteEnv('P1_RUNTIME_DIR', join(REPO_ROOT, 'data', 'p1'))
export const HOST_DATA_ROOT = absoluteEnv('BEILU_DATA_DIR', join(REPO_ROOT, 'data'))
export const UPDATE_RESTART_MARKER = join(RUNTIME_ROOT, '.service-restart-required.json')

export function p1ProcessEnv(extra = {}) {
	return {
		PYTHONUTF8: '1',
		PYTHONIOENCODING: 'utf-8',
		P1_REPO_ROOT: REPO_ROOT,
		P1_RESOURCE_DIR: RESOURCE_ROOT,
		P1_STORAGE_DIR: STORAGE_ROOT,
		P1_RUNTIME_DIR: RUNTIME_ROOT,
		BEILU_DATA_DIR: HOST_DATA_ROOT,
		...extra,
	}
}
