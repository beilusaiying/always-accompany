import fs from 'node:fs'

import cors from 'npm:cors'

import { console, fountLocaleList, getLocaleDataForUser } from '../../scripts/i18n.mjs'
import { ms } from '../../scripts/ms.mjs'
import { get_hosturl_in_local_ip, is_local_ip_from_req, rateLimit } from '../../scripts/ratelimit.mjs'
import { ACCESS_TOKEN_EXPIRY_DURATION, REFRESH_TOKEN_EXPIRY_DURATION, auth_request, authenticate, generateApiKey, getSecureCookieOptions, getUserByReq, getUserByUsername, getUserDictionary, login, logout, register, revokeApiKey, setApiCookieResponse, verifyApiKey } from '../auth.mjs'
import { currentGitCommit } from '../autoupdate.mjs'
import { __dirname } from '../base.mjs'
import { processIPCCommand } from '../ipc_server/index.mjs'
import {
  getAllCachedPartDetails,
  getAllDefaultParts as getAllDefaultPartsFromLoader,
  getAnyDefaultPart,
  getAnyPreferredDefaultPart,
  getDefaultParts,
  getLoadedPartList,
  getPartBranches,
  getPartDetails,
  getPartList,
  loadPart,
  setDefaultPart,
  unsetDefaultPart
} from '../parts_loader.mjs'
import { config, save_config, skip_report } from '../server.mjs'
// beilu: verifycode.mjs 已删除，提供空实现
function generateVerificationCode() { return '000000' }
function verifyVerificationCode() { return true }

import { renderDirectoryListingHtml } from './directory_listing.mjs'
import { register as registerNotifier } from './event_dispatcher.mjs'
import { betterSendFile } from './resources.mjs'
import { watchFrontendChanges } from './watcher.mjs'

// 贝露的眼睛 — 桌面截图注入共享状态
import { consumePendingInjection, getPendingStatus, setPendingInjection } from '../../public/parts/plugins/beilu-eye/injection_state.mjs'

/**
 * 为应用程序注册所有 API 端点。
 * @param {import('npm:express').Router} router - 要在其上注册端点的 Express 路由器。
 * @returns {void}
 */
export function registerEndpoints(router) {
	router.ws('/ws/test/echo', (ws, req) => {
		console.log('WebSocket test connection established.')
		ws.on('message', message => {
			console.log('Received from /ws/test/echo:', message.toString())
			ws.send(message.toString())
		})
		ws.on('close', () => {
			console.log('WebSocket test connection closed.')
		})
	})
	router.ws('/ws/test/auth_echo', authenticate, (ws, req) => {
		console.log('WebSocket auth_test connection established.')
		ws.on('message', message => {
			console.log('Received from /ws/test/auth_echo:', message.toString())
			ws.send(message.toString())
		})
		ws.on('close', () => {
			console.log('WebSocket auth_test connection closed.')
		})
	})

	router.ws('/ws/notify', authenticate, async (ws, req) => {
		const { username } = await getUserByReq(req)
		registerNotifier(username, ws)
	})

	router.get('/api/test/error', (req, res) => {
		throw skip_report(new Error('test error'))
	})
	router.get('/api/test/async_error', async (req, res) => {
		throw skip_report(new Error('test error'))
	})
	router.get('/api/test/unhandledRejection', async (req, res) => {
		Promise.reject(skip_report(new Error('test error')))
		return res.status(200).json({ message: 'hell yeah!' })
	})
	router.get('/api/ping', cors(), async (req, res) => {
		const is_local_ip = is_local_ip_from_req(req)
		let hosturl_in_local_ip
		let ver
		if (is_local_ip || await auth_request(req, res)) {
			try { hosturl_in_local_ip = get_hosturl_in_local_ip() } catch { }
			ver = currentGitCommit
		}
		return res.status(200).json({
			message: 'pong',
			client_name: 'fount',
			ver,
			uuid: config.uuid,
			is_local_ip,
			hosturl_in_local_ip,
		})
	})

	// beilu: PoW 端点已禁用（pow.mjs已删除）
	router.post('/api/pow/challenge', async (req, res) => {
		res.json({ success: true, message: 'PoW disabled' })
	})

	router.post('/api/pow/redeem', async (req, res) => {
		res.json({ success: true, message: 'PoW disabled' })
	})

	router.get('/api/getlocaledata', async (req, res) => {
		const browserLanguages = req.headers['accept-language']?.split?.(',')?.map?.(lang => lang.trim().split(';')[0]) || []
		const userPreferredLanguages = req.query.preferred?.split?.(',')?.map?.(lang => lang.trim()) || []

		// 合并语言列表，用户设置的优先，然后去重
		const preferredLanguages = [...new Set([...userPreferredLanguages, ...browserLanguages])].filter(Boolean)

		let username
		// beilu: 自动登录模式不依赖 cookie，始终执行认证
		try {
			await authenticate(req, res)
			const user = await getUserByReq(req)
			user.locales = preferredLanguages
			username = user.username
		} catch (error) {
			console.error('Error setting language preference for user:', error)
		}

		return res.status(200).json(await getLocaleDataForUser(username, preferredLanguages))
	})

	router.get('/api/getavailablelocales', async (req, res) => {
		res.status(200).json(fountLocaleList)
	})

	router.post('/api/login', rateLimit({ maxRequests: 5, windowMs: ms('1m') }), async (req, res) => {
		// beilu: PoW验证已禁用
		const { username, password, deviceid } = req.body
		const result = await login(username, password, deviceid, req)
		// 在登录成功时设置 Cookie
		if (result.status === 200) {
			const cookieOptions = getSecureCookieOptions(req)
			res.cookie('accessToken', result.accessToken, { ...cookieOptions, maxAge: ACCESS_TOKEN_EXPIRY_DURATION }) // 短效
			res.cookie('refreshToken', result.refreshToken, { ...cookieOptions, maxAge: REFRESH_TOKEN_EXPIRY_DURATION }) // 长效
		}
		res.status(result.status).json(result)
	})

	router.post('/api/register/generateverificationcode', async (req, res) => {
		// get ip
		const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
		generateVerificationCode(ip)
		res.status(200).json({ message: 'verification code generated' })
	})
	router.post('/api/register', rateLimit({ maxRequests: 5, windowMs: ms('1m') }), async (req, res) => {
		const { username, password } = req.body
		// beilu: PoW和验证码验证已禁用
		const result = await register(username, password)
		res.status(result.status).json(result)
	})

	router.post('/api/logout', logout)

	router.post('/api/apikey/create', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const { description } = req.body
		const { apiKey, jti } = await generateApiKey(user.username, description)
		res.status(201).json({ success: true, apiKey, jti, message: 'API Key created successfully. Store it securely, it will not be shown again.' })
	})

	router.get('/api/apikey/list', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const userConfig = getUserByUsername(user.username)
		const apiKeys = (userConfig.auth.apiKeys || []).map(key => ({
			jti: key.jti,
			prefix: key.prefix,
			description: key.description,
			createdAt: key.createdAt,
			lastUsed: key.lastUsed,
		}))
		res.status(200).json({ success: true, apiKeys })
	})

	router.post('/api/apikey/revoke', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const { jti, password } = req.body
		if (!jti) return res.status(400).json({ success: false, error: 'JTI of the key to revoke is required.' })
		if (!password) return res.status(400).json({ success: false, error: 'Password is required to revoke API key.' })

		const result = await revokeApiKey(user.username, jti, password)
		res.status(result.success ? 200 : 400).json(result)
	})

	router.post('/api/apikey/verify', async (req, res) => {
		const { apiKey } = req.body
		if (!apiKey) return res.status(400).json({ success: false, error: 'API key is required.' })

		const user = await verifyApiKey(apiKey)
		res.status(200).json({ success: true, valid: !!user })
	})

	router.post('/api/get-api-cookie', async (req, res) => {
		const { apiKey } = req.body
		const result = await setApiCookieResponse(apiKey, req, res)
		res.status(result.status).json(result)
	})

	router.get('/api/whoami', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		res.status(200).json({ username })
	})

	router.post('/api/authenticate', authenticate, (req, res) => {
		res.status(200).json({ message: 'Authenticated' })
	})

	router.post('/api/runpart', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { partpath, args } = req.body
		await processIPCCommand('runpart', { username, partpath, args })
		res.status(200).json({ message: 'Shell command sent successfully.' })
	})

	router.post('/api/loadpart', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { partpath } = req.body
		const normalized = partpath?.replace?.(/:/g, '/')
		if (!normalized) return res.status(400).json({ success: false, error: 'Part path is required.' })
		await loadPart(username, normalized)
		res.status(200).json({ success: true, message: `Part ${normalized} loaded successfully.` })
	})

	// Generic path handlers
	// Capture remaining path as request param 0.
	router.get(/^\/api\/getlist\/(.*)/, authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const path = req.params[0].replace(/:/g, '/')
		res.status(200).json(getPartList(username, path))
	})
	router.get(/^\/api\/getloadedlist\/(.*)/, authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const path = req.params[0].replace(/:/g, '/')
		res.status(200).json(getLoadedPartList(username, path))
	})
	router.get(/^\/api\/getallcacheddetails\/(.*)/, authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const path = req.params[0].replace(/:/g, '/')
		const details = await getAllCachedPartDetails(username, path)
		res.status(200).json(details)
	})
	router.get(/^\/api\/getdetails\/(.*)/, authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const path = req.params[0].replace(/:/g, '/')
		// name param from query is optional override? Or should invalid?
		// Usually details are for a specific part path.
		// But previously it was /api/getdetails/SHELLS?name=CHAT
		// Now it is likely /api/getdetails/shells/chat.
		const { nocache } = req.query
		const details = await getPartDetails(username, path, nocache)
		res.status(200).json(details)
	})

	router.get('/api/getpartbranches', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const nocache = req.query.nocache === 'true' || req.query.nocache === '1'
		res.status(200).json(getPartBranches(username, { nocache }))
	})

	// Static files handler: /parts/partpath/filepath (partpath may contain colons)
	router.get(/^\/parts\/([^/]+)(.*)$/, authenticate, async (req, res, next) => {
		const { username } = await getUserByReq(req)
		const partpath = req.params[0]
		const filepath = req.params[1].split('?')[0]
		// Convert partpath colons to slashes for filesystem access
		const realPath = partpath.replace(/:/g, '/') + '/public'
		let finalPath
		for (const directory of [
			getUserDictionary(username) + '/' + realPath,
			__dirname + '/src/public/parts/' + realPath,
		]) {
			const path = directory + '/' + filepath
			if (fs.existsSync(path)) {
				finalPath = path
				if (fs.statSync(path).isDirectory())
					if (req.path.endsWith('/')) {
						const indexPath = path + '/index.html'
						if (fs.existsSync(indexPath)) finalPath = indexPath
						else return res.set('Content-Type', 'text/html; charset=utf-8').send(await renderDirectoryListingHtml(req.path, path))
					}
					else
						return res.redirect(301, req.url.replace(req.path, req.path + '/'))

				watchFrontendChanges(`/parts/${partpath}/`, directory)
				break
			}
		}
		if (finalPath) return betterSendFile(res, finalPath)
		return next()
	})

	router.get('/api/defaultpart/getall', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		res.status(200).json(getDefaultParts(user))
	})

	router.post('/api/defaultpart/add', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const { parent, child } = req.body
		setDefaultPart(user, parent, child)
		res.status(200).json({ message: 'success' })
	})

	router.post('/api/defaultpart/unset', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const { parent, child } = req.body
		unsetDefaultPart(user, parent, child)
		res.status(200).json({ message: 'success' })
	})

	router.get(/^\/api\/defaultpart\/getany\/(.*)/, authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const parent = req.params[0]
		res.status(200).json(getAnyDefaultPart(user, parent) || '')
	})

	router.get(/^\/api\/defaultpart\/getallbytype\/(.*)/, authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const parent = req.params[0]
		res.status(200).json(getAllDefaultPartsFromLoader(user, parent))
	})

	router.get(/^\/api\/defaultpart\/getanypreferred\/(.*)/, authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const parent = req.params[0]
		res.status(200).json(getAnyPreferredDefaultPart(user, parent) || '')
	})

	router.get('/api/getusersetting', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const { key } = req.query
		res.status(200).json({ key, value: user[key] })
	})

	router.post('/api/setusersetting', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		const { key, value } = req.body
		user[key] = value
		save_config()
		res.status(200).json({ message: 'success' })
	})

	// ---- 贝露的眼睛：桌面截图注入 API（无需认证，仅 localhost） ----
	router.post('/api/eye/inject', async (req, res) => {
		try {
			// 仅允许 localhost 访问
			if (!is_local_ip_from_req(req)) {
				return res.status(403).json({ error: 'Only localhost access allowed' })
			}
			const { image, message, mode } = req.body || {}
			if (!image) {
				return res.status(400).json({ error: 'Missing image field' })
			}
			setPendingInjection({ image, message: message || '', mode: mode || 'passive' })
			res.status(200).json({ success: true, message: '截图已接收，将在下次 AI 回复时注入' })
		} catch (err) {
			console.error('[eye/inject] Error:', err)
			res.status(500).json({ error: err.message })
		}
	})

	router.get('/api/eye/status', async (req, res) => {
		res.status(200).json(getPendingStatus())
	})

	// 消费截图数据（获取完整 base64 并清除 pending 状态）
	router.post('/api/eye/consume', async (req, res) => {
		try {
			const data = consumePendingInjection()
			if (!data) {
				return res.status(200).json({ success: false, message: 'No pending injection' })
			}
			console.log('[eye/consume] 截图数据已消费，大小:', Math.round((data.image?.length || 0) / 1024), 'KB')
			res.status(200).json({ success: true, ...data })
		} catch (err) {
			console.error('[eye/consume] Error:', err)
			res.status(500).json({ error: err.message })
		}
	})
}
