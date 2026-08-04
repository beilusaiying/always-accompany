/**
 * Legacy P1 part-name adapter.
 *
 * The implementation, resources, lifecycle and storage all live under
 * yonban/core/functions/memory/p1. This file keeps only the installed plugin
 * identity and forwards old generic parts calls to that one runtime.
 */
import info from './info.json' with { type: 'json' }
import { getUserDictionary } from '../../../../yonban/core/functions/security/auth.mjs'
import { requestP1Service } from '../../../../yonban/core/functions/memory/p1/serviceRuntime.mjs'

async function forward(action, body = {}) {
	const username = String(body?._username || body?.username || '')
	const result = await requestP1Service(action, {
		body,
		username,
		memoryRoot: getUserDictionary(username),
	})
	return result.data || {
		success: false,
		status: result.status,
		code: result.code || 'E_P1_LEGACY_ADAPTER',
		error: result.error || 'P1 service returned no JSON',
	}
}

export default {
	info,
	Load: async () => {
		console.info('[beilu-p1-selfdriven] legacy part name forwards to shells:p1; no second P1 implementation loaded')
	},
	Unload: async () => {},
	interfaces: {
		web: {},
		config: {
			GetData: async (data = {}) => forward('getData', data),
			SetData: async (data = {}) => {
				const action = String(data?._action || 'updateConfig')
				const { _action, ...payload } = data || {}
				return forward(action, payload)
			},
		},
	},
}
