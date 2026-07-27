/**
 * auth.mjs — 认证中间件 + 用户管理单一权威。不管路由注册/请求分发（那是 middleware.mjs / endpoints.mjs 的事）。
 *
 * 职责五域：
 *   1. JWT 签发/验证/刷新/撤销（ES256 密钥对 + jose）
 *   2. 认证中间件（authenticate / auth_request / requireOwner）
 *   3. API Key 管理 + SEC-T6 scope 体系
 *   4. 用户 CRUD（注册/登录/改名/删号/改密/安全问题密码找回）
 *   5. 暴力破解防御（账户锁定 + 假成功蜜罐 + 时间攻击保护）
 *
 * 链路：server.mjs init() → initAuth()（密钥加载/argon2 预热/数据清洗）
 *        → 各路由中间件 authenticate / requireOwner / auth_request
 *        → try_auth_request 内部四条认证路径按优先级尝试
 *
 * 认证路径优先级（try_auth_request，先命中即返回）：
 *   ① x-api-key header → verifyApiKey（查 SHA256 哈希表）
 *   ② cookies.apiAccessToken → JWT api 类型验证（SEC-T6 透传 scopes 防洗白）
 *   ③ cookies.accessToken → JWT 标准验证（本人会话 scope=['*']）
 *   ④ cookies.refreshToken → 刷新令牌续签（轮换 + 持久化防重启丢失）
 *
 * SEC-R1 owner 体系：首个注册用户 = 实例 owner（持久化 config.ownerUsername）。
 *   requireOwner 中间件拦截安全策略突变端点，非 owner → 403。
 *   本地单用户：唯一用户即 owner，自然通过。
 *
 * 影响：写 config.json（密钥/用户数据/token 撤销表）；emit AfterUserDeleted/AfterUserRenamed/BeforeUserDeleted 事件
 * 相交：← server.mjs(initAuth) / middleware.mjs(authenticate) / parts_router.mjs(auth_request,getUserByReq,isOwner)
 *         / endpoints.mjs(login/register/logout/API key) / api_v1_router.mjs(authenticate,requireApiKeyScope)
 *       → events.mjs(emit) / path_confine.mjs(getDeployMode) / server.mjs(config,save_config)
 *       → whitebox.mjs(wbTrace,wbDetect)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setInterval, setTimeout } from 'node:timers'

import fse from 'npm:fs-extra'
import * as jose from 'npm:jose'

import { console } from '../../../../scripts/i18n_core.mjs' // [0722 解环] console 叶子（i18n.mjs 上钻本文件，环成员禁引）
import { loadJsonFile } from '../../../../scripts/json_loader.mjs'
import { nicerWriteFileSync } from '../../../../scripts/nicerWriteFile.mjs' // [0716 断电安全] 原子写单源
import { ms } from '../../../../scripts/ms.mjs'

import { __dirname } from '../../../../server/base.mjs'
import { events } from '../../../../server/events.mjs'
import { getDeployMode } from './path_confine.mjs'
import { config, data_path, save_config } from '../../../../server/svr_state.mjs' // [0722 解环] 环境态叶子
import { wbTrace, wbDetect } from '../../../../server/whitebox.mjs'
import { createDiag } from '../../../../server/diagLogger.mjs'

// 诊断 auth 模块常驻埋点（0716 死标记接线）。铁律：任何埋点禁记 password/token 明文。
const diag = createDiag('auth')

// argon2 运行时选择：优先 @node-rs/argon2（Rust FFI，快）；不可用时回退 npm:argon2（纯 JS）。
// 实际 argon2 预热在 initAuth() 中完成（不再阻塞模块链接阶段）。
const { hash, verify, Algorithm } = await import('npm:@node-rs/argon2').catch(async error => {
	globalThis.console.warn(error)
	const fallback = await import('npm:argon2')
	return {
		hash: fallback.hash,
		verify: fallback.verify,
		Algorithm: {
			Argon2id: fallback.argon2id
		}
	}
})

// --- 常量定义 ---
const ACCESS_TOKEN_EXPIRY = '1d'
/** @constant {number} 访问令牌的持续时间（毫秒）。 */
export const ACCESS_TOKEN_EXPIRY_DURATION = ms(ACCESS_TOKEN_EXPIRY)
/** @constant {string} 刷新令牌的过期时间。 */
export const REFRESH_TOKEN_EXPIRY = '30d'
/** @constant {number} 刷新令牌的持续时间（毫秒）。 */
export const REFRESH_TOKEN_EXPIRY_DURATION = ms(REFRESH_TOKEN_EXPIRY)
const DEFAULT_MAX_REFRESH_TOKENS = 50
function getMaxRefreshTokens() { return config.maxRefreshTokensPerUser ?? DEFAULT_MAX_REFRESH_TOKENS }
const ACCOUNT_LOCK_TIME = '10m'
const MAX_LOGIN_ATTEMPTS = 5
const BRUTE_FORCE_THRESHOLD = 8
const BRUTE_FORCE_FAKE_SUCCESS_RATE = 1 / 3
const JWT_CACHE_SIZE = 32

// --- 模块级变量 ---

/** @type {jose.KeyLike} */
let privateKey
/** @type {jose.KeyLike} */
let publicKey
/**
 * 当前 JWT 私钥的 PEM 明文（PKCS8）。仅供 getFakePrivateKey 防撞比较——
 * 之前从 config.privateKey 读，私钥从 config 剥离到独立文件后改由此模块变量持有，
 * 私钥不再是 config 的属性（不落 config.json）。
 * @type {string}
 */
let privateKeyPem
/** @type {Object<string, number>} */
const loginFailures = {}
/** @type {Map<string, object>} */
const jwtCache = new Map()

// --- 辅助函数 ---

/**
 * 获取安全的 Cookie 选项，动态判断 'secure' 标志。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @returns {object} Cookie 选项对象。
 */
export function getSecureCookieOptions(req) {
	const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https'
	return {
		httpOnly: true,
		secure: isSecure,
		sameSite: 'Lax',
	}
}

/**
 * 清除所有认证相关的 Cookies。
 * @param {import('npm:express').Response} res - Express 响应对象。
 * @param {object} options - Cookie 选项。
 */
function clearAuthCookies(res, options) {
	res.clearCookie('accessToken', options)
	res.clearCookie('refreshToken', options)
	res.clearCookie('apiAccessToken', options)
	res.clearCookie('apiRefreshToken', options)
}

/**
 * 生成新的 EC 密钥对 (PEM 格式)。
 * @returns {{privateKey: string, publicKey: string}} 新的密钥对。
 */
function genNewKeyPair() {
	const { privateKey: newPrivateKey, publicKey: newPublicKey } = crypto.generateKeyPairSync('ec', {
		namedCurve: 'prime256v1',
	})
	return {
		privateKey: newPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
		publicKey: newPublicKey.export({ type: 'spki', format: 'pem' }),
	}
}

/**
 * JWT 签名密钥对的独立持久化文件路径（脱离业务 config.json）。
 *
 * 根因修复（T051）：私钥此前作 config 顶层 enumerable 属性，随 save_config 全量序列化明文落 config.json，
 *   config 快照泄漏 = JWT 签名私钥泄漏 = 可伪造任意用户 token 完全接管。私钥迁移到本独立文件后，
 *   config.json 快照不再含私钥。为何不复用 secret_box at-rest 加密：其密钥种子=config.uuid（同盘明文），
 *   加密私钥又存回 config.json 存在循环依赖（拿 config 即拿 uuid 即可解密），故用独立文件物理隔离。
 * 私钥与公钥一并存此文件（同源密钥对，importKeyPair 需成对导入；publicKey 可公开但同文件管理更内聚）。
 * @returns {string} data_path/.jwt_keypair.json 的绝对路径。
 */
function getKeyPairFilePath() {
	return path.join(data_path, '.jwt_keypair.json')
}

/**
 * 从独立文件读取 PEM 密钥对。文件不存在返回 null（触发迁移或首生成）。
 * @returns {{privateKey: string, publicKey: string} | null}
 */
function loadKeyPairFromFile() {
	const file = getKeyPairFilePath()
	if (!fs.existsSync(file)) return null
	return loadJsonFile(file)
}

/**
 * 将 PEM 密钥对写入独立文件（覆盖）。首生成与存量迁移共用。
 * @param {{privateKey: string, publicKey: string}} keyPair - PEM 格式密钥对。
 * @returns {void}
 */
function saveKeyPairToFile(keyPair) {
	// [0716 断电安全] 原子写收口：密钥对半写损坏=全部 JWT 会话失效
	nicerWriteFileSync(getKeyPairFilePath(), JSON.stringify(keyPair, null, '\t'))
}

/**
 * 将 PEM 格式的密钥对导入为 jose 可用的格式。
 * @param {{privateKey: string, publicKey: string}} keyPair - PEM 格式的密钥对。
 * @returns {Promise<{privateKey: jose.KeyLike, publicKey: jose.KeyLike}>} 导入的密钥对。
 */
async function importKeyPair(keyPair) {
	return {
		privateKey: await jose.importPKCS8(keyPair.privateKey, 'ES256'),
		publicKey: await jose.importSPKI(keyPair.publicKey, 'ES256'),
	}
}

/**
 * 为暴力破解防御生成一个临时的、假的私钥。
 * @returns {Promise<jose.KeyLike>} 一个假的私钥。
 */
async function getFakePrivateKey() {
	let fakeKeyPair
	do fakeKeyPair = genNewKeyPair()
	while (fakeKeyPair.privateKey == privateKeyPem)
	const importedFakeKeyPair = await importKeyPair(fakeKeyPair)
	return importedFakeKeyPair.privateKey
}

/**
 * 一个通用的 JWT 生成函数。
 * @param {object} payload - 令牌的有效载荷。
 * @param {string | number} expirationTime - 令牌的过期时间 (例如, '1d', '2h', 3600)。
 * @param {jose.KeyLike} [signingKey=privateKey] - 签名密钥。
 * @returns {Promise<string>} 生成的 JWT。
 */
async function generateToken(payload, expirationTime, signingKey = privateKey) {
	const jti = crypto.randomUUID()
	return await new jose.SignJWT({ ...payload, jti })
		.setProtectedHeader({ alg: 'ES256' })
		.setIssuedAt()
		.setExpirationTime(expirationTime)
		.sign(signingKey)
}

// --- 核心认证逻辑 ---

/**
 * 初始化认证模块：密钥对加载/生成/存量迁移 + argon2 预热 + 用户数据清洗。
 *
 * 链路：server.mjs init() → initAuth()（启动序列第 5 步）
 * 影响：写 data/.jwt_keypair.json（JWT 签名密钥对——独立于 config.json 持久化，T051 私钥剥离）；
 *       写 config.json（uuid 注入 / 存量私钥字段删除 / 泄漏字段清理 / 过期 token 清理）
 * 约束：必须在任何 authenticate / auth_request 之前完成（否则 privateKey/publicKey 为 null）
 *
 * @returns {Promise<void>}
 */
export async function initAuth() {
	config.uuid ??= crypto.randomUUID()

	let needSave = false

	// JWT 签名密钥对加载（T051 根因修复：私钥从业务 config 剥离到独立文件持久化）。
	// 三路径，都保证"私钥同一把、config.json 不再含私钥"：
	//   ① 独立文件已存在（正常路径）→ 直接读。
	//   ② 独立文件不存在但 config 里有旧私钥（存量迁移）→ 用旧私钥（同一把，不换钥否则已签发 token 全失效）
	//      写入独立文件；随后统一从 config 删除。
	//   ③ 两处都无（首启动）→ 生成新密钥对写独立文件。
	let keyPairPem = loadKeyPairFromFile()
	if (!keyPairPem) {
		if (config.privateKey && config.publicKey)
			keyPairPem = { privateKey: config.privateKey, publicKey: config.publicKey } // 存量迁移：保留同一把私钥
		else
			keyPairPem = genNewKeyPair() // 首启动生成
		saveKeyPairToFile(keyPairPem)
	}
	// 无论哪条路径：若 config 仍持有私钥/公钥（存量残留或历史落盘），从 config 剥离并落盘，
	// 使 config.json 快照不再含签名私钥。delete 后 save_config 才真正把明文私钥从磁盘抹除。
	if (config.privateKey !== undefined || config.publicKey !== undefined) {
		delete config.privateKey
		delete config.publicKey
		needSave = true
	}

	const keyPair = await importKeyPair(keyPairPem)
	privateKey = keyPair.privateKey
	publicKey = keyPair.publicKey
	privateKeyPem = keyPairPem.privateKey // 供 getFakePrivateKey 防撞比较

	// argon2 warm-up: 从模块顶层 TLA 移到此处——不再阻塞模块链接阶段，仍在首次 login 前完成
	{
		const startTime = Date.now()
		await verify('$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlkYXRh$ZHVtbXlkYXRhZGF0YQ', 'dummydata').catch(() => { })
		avgVerifyTime = Date.now() - startTime
	}

	config.data.revokedTokens ??= {}
	config.data.apiKeys ??= {}
	config.data.users ??= {}
	for (const username in config.data.users) {
		const user = config.data.users[username]
		// 清理 JSON.parse 反序列化后残留的不该持久化的 enumerable 字段
		// _apiKeyJti/_apiKeyScopes 应为 non-enumerable（SEC-T6 attachScopes），locales 应为 per-request volatile
		for (const leaked of ['_apiKeyJti', '_apiKeyScopes', 'locales']) {
			if (Object.prototype.hasOwnProperty.call(user, leaked) && Object.getOwnPropertyDescriptor(user, leaked)?.enumerable) {
				delete user[leaked]
				needSave = true
			}
		}
		if (user.auth) {
			user.auth.refreshTokens ??= []
			user.auth.apiKeys ??= []
			user.auth.apiRefreshTokens ??= []
			user.auth.securityQuestions ??= []
			// 迁移：空密码用户标记为 passwordless
			if (user.auth.passwordless === undefined) {
				if (!user.auth.password || user.auth.password === '') {
					user.auth.passwordless = true
					user.auth.password = ''
					needSave = true
				} else {
					user.auth.passwordless = false
				}
			}
		}
	}
	if (needSave) save_config()

	cleanupRevokedTokens()
	cleanupRefreshTokens()
}

/**
 * 生成一个 JWT 访问令牌。
 * @param {object} payload - 令牌的有效载荷。
 * @param {jose.KeyLike} [signingKey=privateKey] - 签名密钥。
 * @returns {Promise<string>} 生成的访问令牌。
 */
export async function generateAccessToken(payload, signingKey = privateKey) {
	return generateToken(payload, ACCESS_TOKEN_EXPIRY, signingKey)
}

/**
 * 生成一个 API 访问令牌。
 * @param {object} payload - 令牌的有效载荷。
 * @param {jose.KeyLike} [signingKey=privateKey] - 签名密钥。
 * @returns {Promise<string>} 生成的 API 访问令牌。
 */
export async function generateApiAccessToken(payload, signingKey = privateKey) {
	return generateToken({ ...payload, type: 'api' }, ACCESS_TOKEN_EXPIRY, signingKey)
}

/**
 * 生成一个刷新令牌。
 * @param {object} payload - 令牌的有效载荷。
 * @param {string} deviceId - 设备的唯一标识符。
 * @param {jose.KeyLike} [signingKey=privateKey] - 签名密钥。
 * @returns {Promise<string>} 生成的刷新令牌。
 */
async function generateRefreshToken(payload, deviceId = 'unknown', signingKey = privateKey) {
	return generateToken({ ...payload, deviceId }, REFRESH_TOKEN_EXPIRY, signingKey)
}

/**
 * 生成一个 API 刷新令牌。
 * @param {object} payload - 令牌的有效载荷。
 * @param {string} apiKeyJti - 关联的 API 密钥的 JTI。
 * @param {jose.KeyLike} [signingKey=privateKey] - 签名密钥。
 * @returns {Promise<string>} 生成的 API 刷新令牌。
 */
async function generateApiRefreshToken(payload, apiKeyJti, signingKey = privateKey) {
	return generateToken({ ...payload, apiKeyJti, type: 'apiRefresh' }, REFRESH_TOKEN_EXPIRY, signingKey)
}

/**
 * 验证一个 JWT（访问令牌或刷新令牌），支持缓存。
 * @param {string} token - 要验证的 JWT。
 * @returns {Promise<object|null>} 解码后的有效载荷，如果验证失败则返回 null。
 */
async function verifyToken(token) {
	if (jwtCache.has(token)) {
		const cachedPayload = jwtCache.get(token)
		if (cachedPayload.exp * 1000 > Date.now()) {
			if (config.data.revokedTokens[cachedPayload.jti]) {
				jwtCache.delete(token)
				return null
			}
			jwtCache.delete(token)
			jwtCache.set(token, cachedPayload)
			return cachedPayload
		}
		jwtCache.delete(token)
	}
	try {
		const { payload } = await jose.jwtVerify(token, publicKey, { algorithms: ['ES256'] })
		if (config.data.revokedTokens[payload.jti]) {
			console.warnI18n('beiluConsole.auth.tokenRevoked', { jti: payload.jti })
			return null
		}

		if (jwtCache.size >= JWT_CACHE_SIZE)
			jwtCache.delete(jwtCache.keys().next().value)

		jwtCache.set(token, payload)

		return payload
	} catch (error) {
		console.errorI18n('beiluConsole.auth.tokenVerifyError', { error })
		return null
	}
}

/**
 * 通用的令牌刷新处理器（标准会话 refresh / API refresh 共用）。
 *
 * 链路：try_auth_request → refresh() / refreshApiToken() → handleTokenRefresh
 * 影响：写 config.json（令牌轮换持久化——否则重启后旧 jti 复活、新 jti 不在盘上 → 下次刷新 401）
 *
 * @param {string} refreshTokenValue - 客户端提供的刷新令牌。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @param {object} options - 刷新逻辑的配置（区分标准/API 两种路径的 payload/验证/生成/错误处理）。
 * @returns {Promise<object>} 包含状态码、新令牌或错误消息的对象。
 */
async function handleTokenRefresh(refreshTokenValue, req, options) {
	try {
		const decoded = await verifyToken(refreshTokenValue)
		if (!decoded || (options.expectedType && decoded.type !== options.expectedType))
			return { status: 401, success: false, message: `Invalid or revoked ${options.tokenName} refresh token` }


		const user = getUserByUsername(decoded.username)
		if (!user || !user.auth || !user.auth[options.userTokenArrayKey])
			return { status: 401, success: false, message: `User not found or ${options.tokenName} refresh tokens unavailable` }


		const tokenEntry = user.auth[options.userTokenArrayKey].find(t => t.jti === decoded.jti)

		if (!tokenEntry || !options.validateEntry(tokenEntry, decoded)) {
			if (tokenEntry) await revokeToken(refreshTokenValue, options.mismatchRevokeReason)
			return { status: 401, success: false, message: `${options.tokenName} refresh token not found or validation mismatch` }
		}

		// 更新条目信息
		tokenEntry.lastSeen = Date.now()
		if (req?.ip) tokenEntry.ipAddress = req.ip
		if (req?.headers?.['user-agent']) tokenEntry.userAgent = req.headers['user-agent']

		// 生成新令牌
		// SEC-T6: 透传 scopes(仅 api-cookie 刷新链有该字段)，否则刷新后新 api-cookie 丢 scopes → fail-closed 误拒受限 key 的合法刷新。
		// 标准会话刷新无 scopes 字段(decoded.scopes===undefined)，payload 不带，行为不变。
		const payload = { username: decoded.username, userId: decoded.userId }
		if (decoded.scopes !== undefined) payload.scopes = decoded.scopes
		const newAccessToken = await options.generateAccessToken(payload)
		const newRefreshToken = await options.generateRefreshToken(payload, tokenEntry)
		const decodedNewRefreshToken = jose.decodeJwt(newRefreshToken)

		// 更新用户的令牌列表
		user.auth[options.userTokenArrayKey] = user.auth[options.userTokenArrayKey].filter(t => t.jti !== decoded.jti)
		user.auth[options.userTokenArrayKey].push({
			...options.getNewTokenEntry(decodedNewRefreshToken, tokenEntry),
			ipAddress: req?.ip,
			userAgent: req?.headers?.['user-agent'],
			lastSeen: Date.now(),
		})

		// 持久化令牌轮换，否则重启后旧 jti 复活、客户端新令牌的 jti 不在盘上 → 下次刷新 401
		save_config()

		return {
			status: 200,
			success: true,
			[options.accessTokenKey]: newAccessToken,
			[options.refreshTokenKey]: newRefreshToken,
		}
	} catch (error) {
		console.errorI18n(options.errorI18nKey, { error: error.message })
		return { status: 401, success: false, message: `Error refreshing ${options.tokenName} token` }
	}
}

/**
 * 刷新访问令牌。
 * @param {string} refreshTokenValue - 客户端提供的刷新令牌。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @returns {Promise<object>} 包含刷新结果的对象。
 */
async function refresh(refreshTokenValue, req) {
	return handleTokenRefresh(refreshTokenValue, req, {
		tokenName: 'standard',
		expectedType: undefined,
		userTokenArrayKey: 'refreshTokens',
		/**
		 * 验证令牌条目。
		 * @param {object} entry - 用户的令牌条目。
		 * @param {object} decoded - 解码后的刷新令牌。
		 * @returns {boolean} 如果条目有效，则返回 true。
		 */
		validateEntry: (entry, decoded) => entry.deviceId === decoded.deviceId,
		mismatchRevokeReason: 'refresh-device-mismatch',
		/**
		 * 生成新的访问令牌。
		 * @param {object} payload - 访问令牌的有效载荷。
		 * @returns {Promise<string>} 新的访问令牌。
		 */
		generateAccessToken: (payload) => generateAccessToken(payload),
		/**
		 * 生成新的刷新令牌。
		 * @param {object} payload - 刷新令牌的有效载荷。
		 * @param {object} entry - 旧的令牌条目。
		 * @returns {Promise<string>} 新的刷新令牌。
		 */
		generateRefreshToken: (payload, entry) => generateRefreshToken(payload, entry.deviceId),
		/**
		 * 获取新的令牌条目。
		 * @param {object} decoded - 解码后的新刷新令牌。
		 * @param {object} oldEntry - 旧的令牌条目。
		 * @returns {object} 新的令牌条目。
		 */
		getNewTokenEntry: (decoded, oldEntry) => ({
			jti: decoded.jti,
			deviceId: oldEntry.deviceId,
			expiry: decoded.exp * 1000,
		}),
		accessTokenKey: 'accessToken',
		refreshTokenKey: 'refreshToken',
		errorI18nKey: 'beiluConsole.auth.refreshTokenError',
	})
}

/**
 * 刷新 API 访问令牌。
 * @param {string} apiRefreshTokenValue - 客户端提供的 API 刷新令牌。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @returns {Promise<object>} 包含刷新结果的对象。
 */
async function refreshApiToken(apiRefreshTokenValue, req) {
	return handleTokenRefresh(apiRefreshTokenValue, req, {
		tokenName: 'API',
		expectedType: 'apiRefresh',
		userTokenArrayKey: 'apiRefreshTokens',
		/**
		 * 验证 API 令牌条目。
		 * @param {object} entry - 用户的 API 令牌条目。
		 * @param {object} decoded - 解码后的 API 刷新令牌。
		 * @returns {boolean} 如果条目有效，则返回 true。
		 */
		validateEntry: (entry, decoded) => entry.apiKeyJti === decoded.apiKeyJti,
		mismatchRevokeReason: 'api-refresh-key-mismatch',
		/**
		 * 生成新的 API 访问令牌。
		 * @param {object} payload - API 访问令牌的有效载荷。
		 * @returns {Promise<string>} 新的 API 访问令牌。
		 */
		generateAccessToken: (payload) => generateApiAccessToken(payload),
		/**
		 * 生成新的 API 刷新令牌。
		 * @param {object} payload - API 刷新令牌的有效载荷。
		 * @param {object} entry - 旧的令牌条目。
		 * @returns {Promise<string>} 新的 API 刷新令牌。
		 */
		generateRefreshToken: (payload, entry) => generateApiRefreshToken(payload, entry.apiKeyJti),
		/**
		 * 获取新的 API 令牌条目。
		 * @param {object} decoded - 解码后的新 API 刷新令牌。
		 * @param {object} oldEntry - 旧的令牌条目。
		 * @returns {object} 新的 API 令牌条目。
		 */
		getNewTokenEntry: (decoded, oldEntry) => ({
			jti: decoded.jti,
			apiKeyJti: oldEntry.apiKeyJti,
			expiry: decoded.exp * 1000,
		}),
		accessTokenKey: 'apiAccessToken',
		refreshTokenKey: 'apiRefreshToken',
		errorI18nKey: 'beiluConsole.auth.apiRefreshTokenError',
	})
}


/**
 * 用户登出。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @param {import('npm:express').Response} res - Express 响应对象。
 * @returns {Promise<void>}
 */
export async function logout(req, res) {
	const { cookies: { accessToken, refreshToken } } = req
	const user = await getUserByReq(req)

	if (accessToken) await revokeToken(accessToken, 'access-logout')

	if (refreshToken && user) {
		const userConfig = getUserByUsername(user.username)
		if (userConfig?.auth?.refreshTokens) try {
			const decoded = jose.decodeJwt(refreshToken)
			if (decoded?.jti) {
				const tokenIndex = userConfig.auth.refreshTokens.findIndex(t => t.jti === decoded.jti)
				if (tokenIndex !== -1) userConfig.auth.refreshTokens.splice(tokenIndex, 1)
				await revokeToken(refreshToken, 'refresh-logout')
			}
		} catch (error) {
			console.errorI18n('beiluConsole.auth.logoutRefreshTokenProcessError', { error: error.message })
		}
	}

	clearAuthCookies(res, getSecureCookieOptions(req))
	save_config()
	res.status(200).json({ success: true, message: 'Logout successful' })
}

/**
 * SEC-T6: 把 scopes / apiKeyJti 以**不可枚举**属性挂到（live 引用的）user 对象上。
 * 用 defineProperty(enumerable:false) 而非直接赋值——getUserByUsername 返回的是 config.data.users 的活引用，
 * save_config() 会 JSON.stringify(config)，直接赋值会把 _apiKeyScopes/_apiKeyJti 持久化进 config.json。
 * 非枚举属性被 JSON.stringify 跳过，既能被 apiKeyHasScope 读取，又永不落盘。
 * @param {object} user - 用户对象（config.data.users 的活引用）。
 * @param {string[]} scopes - 作用域数组。
 * @param {string} [jti] - 关联的 API Key JTI。
 * @returns {object} 同一个 user 对象（便于链式返回）。
 */
function attachScopes(user, scopes, jti) {
	Object.defineProperty(user, '_apiKeyScopes', { value: scopes, enumerable: false, writable: true, configurable: true })
	if (jti !== undefined)
		Object.defineProperty(user, '_apiKeyJti', { value: jti, enumerable: false, writable: true, configurable: true })
	return user
}

/**
 * 验证 API 密钥。
 * @param {string} apiKey - 要验证的 API 密钥。
 * @returns {Promise<object|null>} 如果成功，则返回用户对象，否则返回 null。
 */
export async function verifyApiKey(apiKey) {
	try {
		const hash = crypto.createHash('sha256').update(apiKey).digest('hex')
		const keyInfo = config.data.apiKeys[hash]
		if (!keyInfo) return null

		const user = getUserByUsername(keyInfo.username)
		if (!user) {
			delete config.data.apiKeys[hash]
			save_config()
			return null
		}

		const userKeyInfo = user.auth.apiKeys.find(k => k.jti === keyInfo.jti)
		if (userKeyInfo) userKeyInfo.lastUsed = Date.now()

		// SEC-B/T6/T6b/R5: scope 经单一权威 resolveApiKeyScopes 解析（与 get-api-cookie 洗白链同口径，
		//   存量无 scope key 在 server 模式 fail-closed）。非枚举挂到 user，不落盘。
		attachScopes(user, resolveApiKeyScopes(userKeyInfo?.scopes ?? keyInfo.scopes), keyInfo.jti)

		return user
	} catch (error) {
		console.error('API key verification error:', error)
		return null
	}
}

/**
 * SEC-B: 检查 API Key 是否拥有指定 scope。
 * @param {object} user - verifyApiKey 返回的 user 对象(或 req.user)
 * @param {string} requiredScope - 需要的作用域,如 'chat:send'
 * @returns {boolean}
 */
export function apiKeyHasScope(user, requiredScope) {
	// SEC-T6 fail-closed: 无 _apiKeyScopes 一律拒绝。
	// 三条认证路径(try_auth_request)现已统一挂 _apiKeyScopes：
	//   Cookie/JWT 本人会话 = ['*'](full,不破坏 web UI)；API Key/受限 api-cookie = 其声明 scopes。
	// 故缺失 _apiKeyScopes 只可能是未认证或异常路径，应拒绝而非放行(原 return true=fail-open 绕过漏洞)。
	if (!user?._apiKeyScopes) return wbDetect(null, 'auth', 'apiKeyHasScope:no_scopes_fail_closed', false, '无_apiKeyScopes,fail-closed拒绝', { requiredScope })
	const scopes = user._apiKeyScopes
	if (scopes.includes('*')) return true
	if (scopes.includes(requiredScope)) return true
	// 支持前缀匹配: 'chat:*' 覆盖 'chat:send' / 'chat:read'
	const [group] = requiredScope.split(':')
	if (scopes.includes(`${group}:*`)) return true
	wbDetect(null, 'auth', 'apiKeyHasScope:scope_missing', false, 'scope不足拒绝', { requiredScope, scopes })
	return false
}

/**
 * SEC-B: Express 中间件 — 要求 API Key 拥有指定 scope。
 * @param {string} requiredScope
 */
export function requireApiKeyScope(requiredScope) {
	return (req, res, next) => {
		if (!apiKeyHasScope(req.user, requiredScope)) {
			wbDetect(null, 'auth', 'requireApiKeyScope:403', false, 'API Key scope不足,中间件403', { requiredScope, user: req.user?.username })
			return res.status(403).json({ error: `API Key missing scope: ${requiredScope}` })
		}
		next()
	}
}

/**
 * 尝试对请求进行身份验证，成功则填充 req.user。
 * 通过 JWT Cookie 或 API 密钥验证用户身份。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @param {import('npm:express').Response} res - Express 响应对象。
 * @returns {Promise<void>}
 */
export async function try_auth_request(req, res) {
	if (req.user) return
	// [0719 认证放大收口·诊断_YonBan通讯逐跳 跳5] 失败路径记忆化：成功路径上面 req.user 已短路，
	//   但认证失败的请求仍被 4 个 diff_if_auth 基础中间件+端点 authenticate 各重跑一次全链
	//   （同请求同 cookie 结果必同）——accessToken 过期场景每跑一次都重进 refresh 分支
	//   （重复 rotate 尝试+save_config 写大 config=实锤放大器）。同请求只试一次，
	//   Set-Cookie rotate 副作用也只发生一次=本该的语义。
	if (req._beiluAuthAttempted) return
	req._beiluAuthAttempted = true

	const { cookies } = req
	if (!cookies) return

	// 1. 尝试 API 密钥认证（通过 header）
	const apiKeyHeader = req.headers['x-api-key']
	if (apiKeyHeader) {
		const user = await verifyApiKey(apiKeyHeader)
		if (user) { wbTrace(null, 'auth', 'try_auth:apikey_header_ok', { username: user.username }); req.user = user; return }
		wbDetect(null, 'auth', 'try_auth:apikey_header_reject', false, 'x-api-key 验证失败', {})
	}

	// 2. 尝试 API Cookie 认证
	// SEC-T6 洗白修复：api-cookie 由 setApiCookieResponse 用原 API Key 兑换签发，
	// JWT payload 带上原 key 的 scopes(payload.scopes)。这里恢复用户时把 scopes 赋回 _apiKeyScopes，
	// 受限 key 换来的 cookie 仍受限——堵住"用受限 key 换 api-cookie 后越权"的洗白通道。
	// 旧 cookie(签发时无 scopes)按 fail-closed 取 []，即无任何 scope。
	if (cookies.apiAccessToken) {
		const payload = await verifyToken(cookies.apiAccessToken)
		if (payload?.type === 'api' && payload.username) {
			const user = getUserByUsername(payload.username)
			if (user) { wbTrace(null, 'auth', 'try_auth:api_cookie_ok', { username: user.username, scopes: payload.scopes || [] }); attachScopes(user, payload.scopes || [], payload.apiKeyJti); req.user = user; return }
		}
		// apiAccessToken 无效，尝试用 apiRefreshToken 刷新
		// WS 升级路径门(2026-07-20,判别子=req.ws——Express5 会给 mock res 重挂 app.response 原型,
		// capability 判定形同虚设,白盒实测戳穿):此前该路径照跑续签,
		// 服务端轮换(旧 refresh 被撤销)但新 token 发不到浏览器 → 浏览器持已撤销 token,下个
		// HTTP 续签必败=会话被吊死。无投递能力就不轮换,续签留给下一个真 HTTP 请求(WS 随后自动重连)。
		if (cookies.apiRefreshToken && !req.ws) {
			const result = await refreshApiToken(cookies.apiRefreshToken, req)
			if (result.success) {
				const cookieOptions = getSecureCookieOptions(req)
				res.cookie('apiAccessToken', result.apiAccessToken, { ...cookieOptions, maxAge: ACCESS_TOKEN_EXPIRY_DURATION })
				res.cookie('apiRefreshToken', result.apiRefreshToken, { ...cookieOptions, maxAge: REFRESH_TOKEN_EXPIRY_DURATION })
				const decoded = jose.decodeJwt(result.apiAccessToken)
				const user = getUserByUsername(decoded.username)
				if (user) { wbTrace(null, 'auth', 'try_auth:api_cookie_refreshed_ok', { username: user.username }); attachScopes(user, decoded.scopes || [], decoded.apiKeyJti); req.user = user; return }
			}
		}
	}

	// 3. 尝试标准 Cookie 认证
	// SEC-T6: 标准会话 = 用户本人登录(login 路径)，赋 full scope ['*']，不破坏 web UI。
	if (cookies.accessToken) {
		const payload = await verifyToken(cookies.accessToken)
		if (payload && !payload.type && payload.username) {
			const user = getUserByUsername(payload.username)
			if (user) { wbTrace(null, 'auth', 'try_auth:std_cookie_ok', { username: user.username }); attachScopes(user, ['*']); req.user = user; return }
		}
	}

	// 4. accessToken 无效，尝试用 refreshToken 刷新（req.ws 门:同上,WS 升级路径不轮换防吊死会话——426 为裸 socket 写,setHeader 全进虚空）
	if (cookies.refreshToken && !req.ws) {
		const result = await refresh(cookies.refreshToken, req)
		if (result.success) {
			const cookieOptions = getSecureCookieOptions(req)
			res.cookie('accessToken', result.accessToken, { ...cookieOptions, maxAge: ACCESS_TOKEN_EXPIRY_DURATION })
			res.cookie('refreshToken', result.refreshToken, { ...cookieOptions, maxAge: REFRESH_TOKEN_EXPIRY_DURATION })
			const decoded = jose.decodeJwt(result.accessToken)
			const user = getUserByUsername(decoded.username)
			if (user) { wbTrace(null, 'auth', 'try_auth:std_cookie_refreshed_ok', { username: user.username }); attachScopes(user, ['*']); req.user = user; return }
		}
	}

	// 所有认证路径未命中：请求保持未认证（req.user 仍空），上面板供生产环境排障。
	wbTrace(null, 'auth', 'try_auth:no_path_matched', { hasApiKeyHeader: !!apiKeyHeader, hasApiCookie: !!cookies.apiAccessToken, hasAccessCookie: !!cookies.accessToken, hasRefreshCookie: !!cookies.refreshToken }) // 未带cookie的公共/登录前请求=正常态,非异常(实测带cookie=200)

	// 陈旧会话回收（2026-07-20）：带着 cookie 走到这里=access 与 refresh 全链验证失败
	// （重装后旧签名密钥的 cookie / 已撤销 / 全过期）——正常续签在上面第 4 步已成功返回，
	// 到达此处的 cookie 是确定的尸体。不清除则浏览器每个请求都扛着它们产生 401 噪音、
	// 且用户看不出"该重新登录了"。清除后下次整页导航即走干净的未登录链(302→/login)。
	// req.ws 门：WS 升级路径 426 是裸 socket 写,Set-Cookie 到不了浏览器(清除=无效剧场);
	// 留给下一个真 HTTP 请求清。capability 判定不可靠(Express5 重挂原型),用 req.ws 判别。
	if ((cookies.accessToken || cookies.refreshToken || cookies.apiAccessToken || cookies.apiRefreshToken) && !req.ws && typeof res?.clearCookie === 'function') {
		clearAuthCookies(res, getSecureCookieOptions(req))
		wbDetect(null, 'auth', 'try_auth:stale_cookies_cleared', false, '陈旧会话cookie已清除(全链验证失败)', { path: req.path })
	}
}

/**
 * try_auth_request 的 Promise 包装器。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @param {import('npm:express').Response} res - Express 响应对象。
 * @returns {Promise<boolean>} 成功时为 true，失败时为 false。
 */
export function auth_request(req, res) {
	return try_auth_request(req, res).then(() => !!req.user, () => false)
}

/**
 * 认证中间件。未认证时返回 401。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @param {import('npm:express').Response} res - Express 响应对象。
 * @param {import('npm:express').NextFunction} next - Express 的 next 中间件函数。
 * @returns {Promise<void>}
 */
export async function authenticate(req, res, next) {
	await try_auth_request(req, res)
	if (!req.user) {
		// 会话失效泛化兜底层的文档导航出口（20260706）：整页导航（刷新/书签/会话失效后重开
		//   /parts/shells:* 等受保护页面）没有 JS 在场，裸 JSON 401 对人是死路——fetch 类请求
		//   有前端 apiFetch 的 401→/login 统一出口(api-client.mjs)，文档导航必须由服务端送去登录页。
		//   分流依据是【请求性质】而非路由：GET/HEAD + Accept 明确偏好 html（浏览器导航发
		//   text/html,...；fetch 默认 */* 会命中列表首位 json）+ 非 /api//ws/ 路径（API 契约保持
		//   机器可读 JSON 不动）。带 redirect 参数登录后跳回原页（login/index.mjs:redirectAfterLogin 消费）。
		const isDocNav = (req.method === 'GET' || req.method === 'HEAD') &&
			!req.path.startsWith('/api/') && !req.path.startsWith('/ws/') &&
			req.accepts(['json', 'html']) === 'html'
		if (isDocNav) {
			wbDetect(null, 'auth', 'authenticate:302_login', false, '认证中间件拒绝:未认证文档导航→登录页', { path: req.path })
			return res.redirect(302, `/login/?redirect=${encodeURIComponent(req.originalUrl)}`)
		}
		wbDetect(null, 'auth', 'authenticate:401', false, '认证中间件拒绝:未认证', { path: req.path, method: req.method })
		return res.status(401).json({ success: false, message: 'Authentication required' })
	}
	next?.()
}

/**
 * 通过将其 JTI 添加到撤销列表来撤销令牌。
 * @param {string} token - 要撤销的令牌。
 * @param {string} [typeSuffix='unknown'] - 撤销原因的后缀 (例如, 'logout', 'manual')。
 * @returns {Promise<void>}
 */
async function revokeToken(token, typeSuffix = 'unknown') {
	try {
		const decoded = jose.decodeJwt(token)
		if (!decoded || !decoded.jti)
			return console.errorI18n('beiluConsole.auth.revokeTokenNoJTI')

		let tokenType = decoded.type || 'unknown'
		if (tokenType === 'unknown' && decoded.exp && decoded.iat) {
			const duration = (decoded.exp - decoded.iat) * 1000
			if (Math.abs(duration - ACCESS_TOKEN_EXPIRY_DURATION) < ms('5m')) tokenType = 'access'
			else if (Math.abs(duration - REFRESH_TOKEN_EXPIRY_DURATION) < ms('1h')) tokenType = 'refresh'
		}

		config.data.revokedTokens[decoded.jti] = {
			expiry: decoded.exp ? decoded.exp * 1000 : Date.now() + REFRESH_TOKEN_EXPIRY_DURATION,
			type: `${tokenType}-${typeSuffix}`,
			revokedAt: Date.now(),
		}
		save_config()
	} catch (e) {
		console.error(`Error decoding token for revocation: ${e.message}`)
	}
}

// --- 用户管理 ---

/**
 * 通过用户名获取完整的用户信息对象。
 * @param {string} username - 用户名。
 * @returns {object|undefined} 用户对象，如果未找到则为 undefined。
 */
export function getUserByUsername(username) {
	return config.data.users[username]
}

// ============================================================
// SEC-R1：owner（服务端运营者）单一权威 + requireOwner 授权
//   病根：beilu 原无 owner/admin 概念，安全策略类配置端点(/api/security/* 突变、
//   MCP 批准等)只校验"已登录" → 多用户下任一注册用户可翻全局安全配置(deployMode→local
//   一键开所有 server 闸 / sandboxOptOut / MCP 自批准 → RCE)。
//   框架级正解：server 全局安全策略属【运营者域】，运营者 = 实例的 owner。
//   owner = 首个注册用户（持久化 config.ownerUsername，一次性确定，之后注册不授予 owner）。
//   本地单用户：唯一用户即 owner，requireOwner 自动通过 → 零影响。
// ============================================================

/**
 * 获取实例 owner 用户名（单一权威）。未显式设置则惰性落定为"最早创建的用户"并持久化。
 * @returns {string|null} owner 用户名，无任何用户时 null。
 */
export function getOwnerUsername() {
	if (config.ownerUsername && config.data.users[config.ownerUsername]) return config.ownerUsername
	// 惰性落定：取 createdAt 最早的用户（缺 createdAt 视为最大，排后）
	const names = Object.keys(config.data.users || {})
	if (!names.length) return null
	let owner = names[0]
	let earliest = config.data.users[owner]?.createdAt ?? Infinity
	for (const n of names) {
		const c = config.data.users[n]?.createdAt ?? Infinity
		if (c < earliest) { earliest = c; owner = n }
	}
	config.ownerUsername = owner
	try { save_config() } catch { /* 持久化失败不阻断鉴权，下次再落定 */ }
	return owner
}

/**
 * 判断 username 是否实例 owner。
 * @param {string} username
 * @returns {boolean}
 */
export function isOwner(username) {
	return !!username && username === getOwnerUsername()
}

/**
 * 中间件：要求请求者为已登录的 owner（安全策略突变端点用）。
 * 非 owner → 403（区别于未登录的 401）。本地单用户场景 owner=唯一用户，自然通过。
 * @param {import('npm:express').Request} req
 * @param {import('npm:express').Response} res
 * @param {Function} next
 */
export async function requireOwner(req, res, next) {
	await try_auth_request(req, res)
	if (!req.user) {
		wbDetect(null, 'auth', 'requireOwner:401', false, 'owner闸:未认证', { path: req.path })
		return res.status(401).json({ success: false, message: 'Authentication required' })
	}
	if (!isOwner(req.user.username)) {
		wbDetect(null, 'auth', 'requireOwner:403', false, 'owner闸:非owner拒绝', { user: req.user.username, owner: getOwnerUsername(), deployMode: getDeployMode(), path: req.path })
		return res.status(403).json({ success: false, message: '仅实例 owner 可修改安全策略配置' })
	}
	wbTrace(null, 'auth', 'requireOwner:pass', { user: req.user.username, deployMode: getDeployMode() })
	next?.()
}

/**
 * SEC-R5：API Key scope 单一权威解析（verifyApiKey 与 get-api-cookie 洗白链共用，杜绝两处口径相反）。
 *   有显式非空 scopes → 原样；无/空(scope 功能上线前的存量 key) → 按部署模式 fallback：
 *   local（owner 自己机器的旧 key）→ ['*'] 不破坏；server（多用户）→ [] fail-closed。
 * @param {any} scopes - 候选 scopes（可能 undefined/空数组/旧 key 无此字段）。
 * @returns {string[]}
 */
export function resolveApiKeyScopes(scopes) {
	if (Array.isArray(scopes) && scopes.length > 0) return scopes
	const _mode = getDeployMode()
	if (_mode === 'server') {
		// server 多用户:无 scope 的存量 key fail-closed 收成 [](无任何权限)。安全收紧分支,上面板。
		wbDetect(null, 'auth', 'resolveApiKeyScopes:fail_closed', false, 'server模式无scope的key收成[](fail-closed)', { mode: _mode })
		return []
	}
	wbTrace(null, 'auth', 'resolveApiKeyScopes:local_fallback', { mode: _mode, scopes: ['*'] })
	return ['*']
}

/**
 * 获取所有用户名的列表。
 * @returns {string[]} 用户名数组。
 */
export function getAllUserNames() {
	return Object.keys(config.data.users)
}

/**
 * 获取所有用户对象的字典。
 * @returns {object} 用户对象的字典。
 */
export function getAllUsers() {
	return config.data.users
}

/**
 * 获取用户列表（用于登录页面展示）。
 * 只返回用户名和是否需要密码，不暴露敏感信息。
 * @returns {Array<{username: string, passwordless: boolean, createdAt: number}>} 用户列表。
 */
export function getUserListForLogin() {
	return Object.values(config.data.users)
		.filter(u => u.auth)
		.map(u => ({
			username: u.username,
			passwordless: !!u.auth.passwordless,
			hasSecurityQuestions: !!(u.auth.securityQuestions?.length >= 3),
			createdAt: u.createdAt,
		}))
}

/**
 * 创建一个新用户。
 * @param {string} username - 用户名。
 * @param {string} [password] - 密码。为空或不提供则创建无密码用户。
 * @returns {Promise<object>} 创建的用户对象。
 */
async function createUser(username, password) {
	const isPasswordless = !password || password === ''
	const hashedPassword = isPasswordless ? '' : await hashPassword(password)
	const userId = crypto.randomUUID()
	const now = Date.now()
	const _userTemplate = loadJsonFile(path.join(__dirname, 'default', 'templates', 'user.json'))
	delete _userTemplate.auth
	config.data.users[username] = {
		..._userTemplate,
		username,
		createdAt: now,
		auth: {
			userId,
			password: hashedPassword,
			passwordless: isPasswordless,
			loginAttempts: 0,
			lockedUntil: null,
			refreshTokens: [],
			apiKeys: [],
			apiRefreshTokens: [],
			securityQuestions: [],
		},
	}

	save_config()
	return config.data.users[username]
}

/**
 * 使用 Argon2id 哈希密码。
 * @param {string} password - 明文密码。
 * @returns {Promise<string>} 哈希后的密码。
 */
export async function hashPassword(password) {
	return await hash(password, { algorithm: Algorithm.Argon2id })
}

/**
 * 验证密码。
 * @param {string} password - 用户提供的明文密码。
 * @param {string} hashedPassword - 存储的哈希密码。
 * @returns {Promise<boolean>} 如果密码匹配则为 true，否则为 false。
 */
export async function verifyPassword(password, hashedPassword) {
	if (!password || !hashedPassword) return false
	return await verify(hashedPassword, password)
}

/**
 * 校验用户敏感操作（撤 key / 删号 / 改名 / 改密）的密码门。
 * 无密码账户（passwordless）豁免：这类用户根本没有密码可验，authenticate 中间件（会话）已是访问门，
 * 若仍强制 verifyPassword 会因空哈希恒 false 而永久无法撤 key/删号/改名/改密。对齐 SillyTavern「仅在已设密码时校验」。
 * @param {object} user - 用户对象（含 auth.password）。
 * @param {string} password - 请求方提供的明文密码。
 * @returns {Promise<boolean>} 通过为 true。
 */
export async function verifyUserActionPassword(user, password) {
	if (!user?.auth?.password) return true // passwordless：已登录即放行
	return await verifyPassword(password, user.auth.password)
}

/**
 * 更改用户密码。
 * @param {string} username - 用户名。
 * @param {string} currentPassword - 当前密码。
 * @param {string} newPassword - 新密码。
 * @returns {Promise<{success: boolean, message: string}>} 操作结果。
 */
export async function changeUserPassword(username, currentPassword, newPassword, { req = null } = {}) {
	const user = getUserByUsername(username)
	if (!user || !user.auth) return { success: false, message: 'User not found' }

	const isValidPassword = await verifyUserActionPassword(user, currentPassword)
	if (!isValidPassword) return { success: false, message: 'Invalid current password' }

	user.auth.password = await hashPassword(newPassword)
	user.auth.passwordless = false // 设了真密码即非无密码账户，否则 login 仍凭 passwordless 跳过校验使新密码失效

	// 会话撤销口径对齐（20260706）：密码家族三函数里 resetPasswordBySecurityQuestions/ownerResetUserPassword
	//   都撤全部 refreshTokens，唯本函数漏撤——改密码常见动机=怀疑泄露，其他设备旧 refresh(30d)不该继续续命。
	//   保留当前设备会话（req 的 refresh cookie jti），其余全部进撤销表——改完密码本人不被登出，其他设备下线。
	let keepJti = null
	try { keepJti = jose.decodeJwt(req?.cookies?.refreshToken)?.jti || null } catch { /* 无/坏 cookie → 全撤 */ }
	user.auth.refreshTokens = (user.auth.refreshTokens || []).filter(token => {
		if (token.jti && token.jti === keepJti) return true
		if (token.jti)
			config.data.revokedTokens[token.jti] = {
				expiry: token.expiry,
				type: 'refresh-revoked-password-change',
				revokedAt: Date.now(),
			}
		return false
	})

	save_config()
	return { success: true, message: 'Password changed successfully' }
}

// ============================================================
// 安全问题（密码找回）
// ============================================================

/**
 * 设置用户安全问题（需当前密码验证或 passwordless 豁免）。
 * @param {string} username
 * @param {string} password - 当前密码（passwordless 可为空）
 * @param {Array<{questionId: string, question: string, answer: string}>} questions - 恰好 3 个
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function setSecurityQuestions(username, password, questions) {
	const user = getUserByUsername(username)
	if (!user?.auth) return { success: false, message: 'User not found.' }
	if (!await verifyUserActionPassword(user, password))
		return { success: false, message: 'Invalid password.' }
	if (!Array.isArray(questions) || questions.length !== 3)
		return { success: false, message: 'Exactly 3 security questions required.' }
	for (const q of questions) {
		if (!q.question?.trim() || !q.answer?.trim())
			return { success: false, message: 'Each question and answer must be non-empty.' }
	}
	user.auth.securityQuestions = await Promise.all(questions.map(async q => ({
		questionId: q.questionId || crypto.randomUUID(),
		question: q.question.trim(),
		answerHash: await hashPassword(q.answer.trim().toLowerCase()),
	})))
	save_config()
	return { success: true, message: 'Security questions set successfully.' }
}

/**
 * 获取用户安全问题（只返回问题文本，不返回答案哈希）。
 * @param {string} username
 * @returns {{success: boolean, questions?: Array<{questionId: string, question: string}>}}
 */
export function getSecurityQuestionsForUser(username) {
	const user = getUserByUsername(username)
	if (!user?.auth?.securityQuestions?.length)
		return { success: false, questions: [] }
	return {
		success: true,
		questions: user.auth.securityQuestions.map(q => ({
			questionId: q.questionId,
			question: q.question,
		})),
	}
}

/**
 * @param {string} username
 * @returns {boolean}
 */
export function hasSecurityQuestions(username) {
	const user = getUserByUsername(username)
	return !!(user?.auth?.securityQuestions?.length >= 3)
}

/**
 * 验证安全问题答案。暴力破解防御：共享 loginAttempts 计数器（3 次错锁 15 分钟）。
 * @param {string} username
 * @param {string[]} answers - 3 个答案（顺序对应 securityQuestions）
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function verifySecurityAnswers(username, answers) {
	const user = getUserByUsername(username)
	if (!user?.auth) return { success: false, message: 'User not found.' }
	const sq = user.auth.securityQuestions
	if (!sq?.length || sq.length !== 3)
		return { success: false, message: 'Security questions not set.' }
	if (!Array.isArray(answers) || answers.length !== 3)
		return { success: false, message: 'Exactly 3 answers required.' }

	if (user.auth.lockedUntil && Date.now() < user.auth.lockedUntil)
		return { success: false, message: 'Account temporarily locked. Try again later.' }

	for (let i = 0; i < 3; i++) {
		const ok = await verifyPassword(answers[i]?.trim()?.toLowerCase() || '', sq[i].answerHash)
		if (!ok) {
			user.auth.loginAttempts = (user.auth.loginAttempts || 0) + 1
			if (user.auth.loginAttempts >= 3) {
				user.auth.lockedUntil = Date.now() + 15 * 60 * 1000
				user.auth.loginAttempts = 0
				save_config()
				return { success: false, message: 'Too many failed attempts. Account locked for 15 minutes.' }
			}
			save_config()
			return { success: false, message: 'Incorrect answer.' }
		}
	}
	user.auth.loginAttempts = 0
	save_config()
	return { success: true, message: 'Security answers verified.' }
}

/**
 * 通过安全问题重置密码：验证答案 → 设新密码 → 撤销所有 token 强制重登。
 * @param {string} username
 * @param {string[]} answers
 * @param {string} newPassword
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function resetPasswordBySecurityQuestions(username, answers, newPassword) {
	const verify = await verifySecurityAnswers(username, answers)
	if (!verify.success) return verify

	const user = getUserByUsername(username)
	user.auth.password = await hashPassword(newPassword)
	user.auth.passwordless = false

	user.auth.refreshTokens?.forEach(token => {
		if (token.jti)
			config.data.revokedTokens[token.jti] = {
				expiry: token.expiry,
				type: 'refresh-revoked-password-reset',
				revokedAt: Date.now(),
			}
	})
	user.auth.refreshTokens = []

	save_config()
	return { success: true, message: 'Password reset successfully. Please log in with your new password.' }
}

/**
 * Owner 直接重置其他用户的密码（无需目标用户旧密码）。
 * @param {string} ownerUsername
 * @param {string} targetUsername
 * @param {string} newPassword
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function ownerResetUserPassword(ownerUsername, targetUsername, newPassword) {
	if (!isOwner(ownerUsername))
		return { success: false, message: 'Only owner can reset other users\' passwords.' }
	const target = getUserByUsername(targetUsername)
	if (!target?.auth) return { success: false, message: 'Target user not found.' }

	target.auth.password = await hashPassword(newPassword)
	target.auth.passwordless = false

	target.auth.refreshTokens?.forEach(token => {
		if (token.jti)
			config.data.revokedTokens[token.jti] = {
				expiry: token.expiry,
				type: 'refresh-revoked-admin-reset',
				revokedAt: Date.now(),
			}
	})
	target.auth.refreshTokens = []

	save_config()
	return { success: true, message: `Password for ${targetUsername} reset successfully.` }
}

/**
 * 生成 API 密钥。
 * @param {string} username - 与密钥关联的用户名。
 * @param {string} [description='New API Key'] - API 密钥的描述。
 * @returns {Promise<{apiKey: string, jti: string}>} 生成的 API 密钥及其 JTI。
 */
export async function generateApiKey(username, description = 'New API Key', scopes = ['*']) {
	const user = getUserByUsername(username)
	if (!user) throw new Error('User not found')

	const apiKey = `${crypto.randomBytes(32).toString('base64url')}`
	const hash = crypto.createHash('sha256').update(apiKey).digest('hex')
	const jti = crypto.randomUUID()

	const scopeList = Array.isArray(scopes) && scopes.length > 0 ? scopes : ['*']

	config.data.apiKeys[hash] = { username, jti, scopes: scopeList }
	user.auth.apiKeys.push({
		jti,
		description,
		scopes: scopeList,
		createdAt: Date.now(),
		lastUsed: null,
		prefix: apiKey.substring(0, 7),
	})
	save_config()
	return { apiKey, jti, scopes: scopeList }
}

/**
 * 撤销 API 密钥。
 * @param {string} username - 用户名。
 * @param {string} jti - 要撤销的 API 密钥的 JTI。
 * @param {string} password - 用于验证的用户密码。
 * @returns {Promise<{success: boolean, message: string}>} 操作结果。
 */
export async function revokeApiKey(username, jti, password) {
	const user = getUserByUsername(username)
	if (!user?.auth?.apiKeys) return { success: false, message: 'User or API keys not found' }

	if (!await verifyUserActionPassword(user, password))
		return { success: false, message: 'Invalid password for revoking API key' }

	const keyIndex = user.auth.apiKeys.findIndex(key => key.jti === jti)
	if (keyIndex === -1) return { success: false, message: 'API key not found for this user' }

	const hashToRemove = Object.keys(config.data.apiKeys).find(hash => config.data.apiKeys[hash].jti === jti)
	if (hashToRemove) delete config.data.apiKeys[hashToRemove]
	user.auth.apiKeys.splice(keyIndex, 1)

	// 撤销关联的 API 刷新令牌
	const tokensToRevoke = user.auth.apiRefreshTokens.filter(token => token.apiKeyJti === jti)
	for (const token of tokensToRevoke)
		config.data.revokedTokens[token.jti] = {
			expiry: token.expiry,
			type: 'api-refresh-revoked-by-apikey',
			revokedAt: Date.now(),
		}

	user.auth.apiRefreshTokens = user.auth.apiRefreshTokens.filter(token => token.apiKeyJti !== jti)

	save_config()
	return { success: true, message: 'API key revoked successfully' }
}

/**
 * 通过 JTI 撤销用户的设备（刷新令牌）。
 * @param {string} username - 用户名。
 * @param {string} tokenJti - 要撤销的刷新令牌的 JTI。
 * @param {string} password - 用于验证的用户密码。
 * @returns {Promise<{success: boolean, message: string}>} 操作结果。
 */
export async function revokeUserDeviceByJti(username, tokenJti, password) {
	const user = getUserByUsername(username)
	if (!user?.auth?.refreshTokens) return { success: false, message: 'User or device list not found' }

	if (!await verifyUserActionPassword(user, password))
		return { success: false, message: 'Invalid password for user action' }

	const tokenIndex = user.auth.refreshTokens.findIndex(token => token.jti === tokenJti)
	if (tokenIndex === -1) return { success: false, message: 'Device (JTI) not found for this user' }

	const revokedToken = user.auth.refreshTokens.splice(tokenIndex, 1)[0]
	if (revokedToken?.jti)
		config.data.revokedTokens[revokedToken.jti] = {
			expiry: revokedToken.expiry,
			type: 'refresh-revoked-by-user-jti',
			revokedAt: Date.now(),
		}

	save_config()
	return { success: true, message: 'Device access (JTI) revoked successfully' }
}

/**
 * 将目录移入系统回收站（Windows）或 _deleted_users 备份目录（跨平台兜底）。
 * @param {string} dirPath - 要移入回收站的目录绝对路径。
 * @returns {Promise<{ok: boolean, dest?: string, error?: string}>}
 */
async function moveToTrash(dirPath) {
	if (!fs.existsSync(dirPath)) return { ok: true, dest: '(not exists)' }
	if (process.platform === 'win32') {
		try {
			const { execFile } = await import('node:child_process')
			const escaped = dirPath.replace(/'/g, "''")
			await new Promise((resolve, reject) => {
				execFile('powershell', [
					'-NoProfile', '-Command',
					`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
				], { timeout: 30000, windowsHide: true }, (err) => err ? reject(err) : resolve())
			})
			return { ok: true, dest: 'RecycleBin' }
		} catch (e) {
			console.warn('[moveToTrash] PowerShell RecycleBin failed, falling back to _deleted_users:', e.message)
		}
	}
	try {
		const ts = new Date().toISOString().replace(/[:.]/g, '-')
		const trashDir = path.join(data_path, '_deleted_users')
		fse.ensureDirSync(trashDir)
		const dest = path.join(trashDir, `${path.basename(dirPath)}_${ts}`)
		fse.moveSync(dirPath, dest, { overwrite: true })
		return { ok: true, dest }
	} catch (e) {
		console.error('[moveToTrash] Fallback move also failed:', e.message)
		return { ok: false, error: e.message }
	}
}

/**
 * 删除用户帐户及其数据，需要密码验证。
 *
 * 链路：endpoints.mjs DELETE /api/auth/user → deleteUserAccount
 * 影响：emit BeforeUserDeleted/AfterUserDeleted 事件 → parts_router 清路由 + parts_loader 卸载部件 + 清缓存；
 *   用户数据目录移入回收站（非永久删除）；写 config.json（删用户/撤 token/清 apiKeys）。
 *
 * @param {string} username - 要删除的帐户的用户名。
 * @param {string} password - 用户密码。
 * @param {object} [options]
 * @param {boolean} [options.purgeConfig=false] - true=完全清除配置痕迹(apiKeys/revokedTokens)不留任何可恢复数据；false=文件进回收站、配置正常清理。
 * @returns {Promise<{success: boolean, message: string, trashDest?: string}>} 操作结果。
 */
export async function deleteUserAccount(username, password, options = {}) {
	const { purgeConfig = false, skipPasswordCheck = false } = options
	const user = getUserByUsername(username)
	if (!user?.auth) return { success: false, message: 'User not found.' }
	if (!skipPasswordCheck && !await verifyUserActionPassword(user, password))
		return { success: false, message: 'Invalid password for deleting account.' }

	await events.emit('BeforeUserDeleted', { username })

	const userDirectoryPath = getUserDictionary(username)

	// 撤销所有用户刷新令牌
	user.auth.refreshTokens?.forEach(token => {
		if (token.jti)
			config.data.revokedTokens[token.jti] = {
				expiry: token.expiry,
				type: 'refresh-revoked-account-delete',
				revokedAt: Date.now(),
			}
	})

	// 清理全局 apiKeys 表中属于该用户的条目
	for (const h of Object.keys(config.data.apiKeys))
		if (config.data.apiKeys[h]?.username === username) delete config.data.apiKeys[h]

	if (purgeConfig) {
		// 完全清除：清掉该用户所有 revokedTokens 痕迹（包括本次撤销的和之前撤销的 apiKey/refresh）
		const userJtis = new Set()
		user.auth.refreshTokens?.forEach(t => { if (t.jti) userJtis.add(t.jti) })
		user.auth.apiKeys?.forEach(k => { if (k.jti) userJtis.add(k.jti) })
		for (const jti of Object.keys(config.data.revokedTokens))
			if (userJtis.has(jti) || config.data.revokedTokens[jti]?.type === 'refresh-revoked-account-delete')
				delete config.data.revokedTokens[jti]
	}

	delete config.data.users[username]
	// owner 删自己时清掉 ownerUsername（20260706）：留 stale 值会废掉 register 的
	// 「首个注册用户 && !config.ownerUsername → 授 owner」闸——全员删光后新首用户拿不到显式 owner，
	// 只能靠 getOwnerUsername 惰性重选自愈；清掉让首用户闸恢复原语义。
	if (config.ownerUsername === username) delete config.ownerUsername
	save_config()

	// 用户数据目录移入回收站（非永久删除）
	const trashResult = await moveToTrash(userDirectoryPath)

	await events.emit('AfterUserDeleted', { username })
	return { success: true, message: 'User account deleted successfully.', trashDest: trashResult.dest }
}

/**
 * 重命名用户帐户，需要密码验证。
 * @param {string} currentUsername - 当前用户名。
 * @param {string} newUsername - 新用户名。
 * @param {string} password - 用户密码。
 * @returns {Promise<{success: boolean, message: string}>} 操作结果。
 */
export async function renameUser(currentUsername, newUsername, password, options = {}) {
	const { skipPasswordCheck = false } = options
	const user = getUserByUsername(currentUsername)
	if (!user?.auth) return { success: false, message: 'Current user not found.' }
	if (!skipPasswordCheck && !await verifyUserActionPassword(user, password))
		return { success: false, message: 'Invalid password for renaming user.' }

	if (currentUsername === newUsername)
		return { success: false, message: 'New username must be different from the current one.' }

	// 同 register 安全卫兵（20260707 路径穿越）——改名目标同样进 path.join，同需净化
	// eslint-disable-next-line no-control-regex
	if (/[/\\]|\.\.|\x00|[\x01-\x1f]/.test(newUsername))
		return { success: false, message: 'New username contains illegal characters' }
	if (newUsername.length > 64)
		return { success: false, message: 'New username too long (max 64)' }

	if (getUserByUsername(newUsername))
		return { success: false, message: 'New username already exists.' }

	await events.emit('BeforeUserRenamed', { oldUsername: currentUsername, newUsername })

	const oldUserPath = getUserDictionary(currentUsername)
	const newUserConfigEntry = JSON.parse(JSON.stringify(user))
	newUserConfigEntry.username = newUsername
	config.data.users[newUsername] = newUserConfigEntry
	delete config.data.users[currentUsername]

	const newUserPath = getUserDictionary(newUsername)

	try {
		if (fse.existsSync(oldUserPath) && oldUserPath.toLowerCase() !== newUserPath.toLowerCase()) {
			fse.ensureDirSync(path.dirname(newUserPath))
			fse.moveSync(oldUserPath, newUserPath, { overwrite: true })
		}
	}
	catch (error) {
		// 失败时恢复配置更改
		config.data.users[currentUsername] = user
		delete config.data.users[newUsername]
		console.error('Error moving user data directory:', error)
		return { success: false, message: `Error moving user data: ${error.message}. Username change reverted.` }
	}

	// 同步全局 apiKeys 表的 username，否则改名后旧 key 因查不到用户被静默失效
	for (const h of Object.keys(config.data.apiKeys))
		if (config.data.apiKeys[h]?.username === currentUsername) config.data.apiKeys[h].username = newUsername

	// owner 身份随改名迁移（20260706）：不迁则 getOwnerUsername 走 createdAt 惰性重选兜底——
	// 老账户缺 createdAt(?? Infinity 排最后)时 owner 权限会漂移给别的用户（安全策略闸易主）。
	if (config.ownerUsername === currentUsername) config.ownerUsername = newUsername

	save_config()
	await events.emit('AfterUserRenamed', { oldUsername: currentUsername, newUsername })
	return { success: true, message: 'Username renamed successfully.' }
}

/**
 * 从请求中获取用户信息。依赖于 authenticate 中间件已填充 req.user。
 *
 * 约束：调用前必须确保 authenticate 中间件已执行过——否则 req.user 为空会抛错。
 *   parts_router.mjs / endpoints.mjs 是主要调用方。
 *
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @returns {Promise<object>} 用户对象（config.data.users 的活引用）。
 * @throws {Error} 如果请求未经过身份验证（req.user 为空）。
 */
export async function getUserByReq(req) {
	if (!req.user) {
		wbDetect(null, 'auth', 'getUserByReq:unauthenticated', false, 'getUserByReq:req.user为空(未过authenticate中间件)', { path: req?.path })
		throw new Error('Request is not authenticated. Use authenticate middleware first.')
	}
	wbTrace(null, 'auth', 'getUserByReq', { username: req.user.username })
	return req.user
}

/**
 * 获取用户数据目录的路径。
 * @param {string} username - 用户名。
 * @returns {string} 用户数据目录的绝对路径。
 */
export function getUserDictionary(username) {
	if (!username) return path.resolve(path.join(data_path, 'users', '_default'))
	const user = config.data.users[username]
	return path.resolve(user?.UserDictionary || path.join(data_path, 'users', username))
}

let avgVerifyTime = 0

/**
 * 用户登录。支持有密码和无密码用户。
 *
 * 暴力破解防御三层：
 *   1. 账户锁定（MAX_LOGIN_ATTEMPTS=5 次错 → 锁 10 分钟）
 *   2. 假成功蜜罐（连续错超 BRUTE_FORCE_THRESHOLD=8 次 → 1/3 概率返回用假密钥签的假 token，
 *      攻击者拿到的 token 验签必失败，但无法区分真假响应）
 *   3. 时间攻击保护（失败延迟 ≈ argon2 平均耗时 ± 10%，防时间侧信道区分"用户不存在"和"密码错"）
 *
 * 影响：写 config.json（loginAttempts/lockedUntil/refreshTokens/用户目录创建）
 *
 * @param {string} username - 用户名。
 * @param {string} [password] - 密码（无密码用户可不提供）。
 * @param {string} [deviceId='unknown'] - 设备标识符。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @returns {Promise<object>} 包含状态码、消息和令牌的对象。
 */
export async function login(username, password, deviceId = 'unknown', req) {
	const { ip } = req
	const user = getUserByUsername(username)
	diag.debug('login 尝试:', username, 'ip:', ip, 'device:', deviceId, 'userExists:', !!user)

	/**
	 * 处理失败的登录尝试。
	 * @param {object} [response={}] - 要包含在响应中的附加数据。
	 * @returns {Promise<object>} 包含状态码和消息的响应对象。
	 */
	async function handleFailedLogin(response = {}) {
		loginFailures[ip] = (loginFailures[ip] || 0) + 1
		diag.warn('login 失败:', username, 'ip:', ip, '该IP累计失败:', loginFailures[ip])

		if (loginFailures[ip] >= BRUTE_FORCE_THRESHOLD && Math.random() < BRUTE_FORCE_FAKE_SUCCESS_RATE) {
			const fakePrivateKey = await getFakePrivateKey()
			const fakeUserId = crypto.randomUUID()
			const accessToken = await generateAccessToken({ username, userId: fakeUserId }, fakePrivateKey)
			const refreshToken = await generateRefreshToken({ username, userId: fakeUserId }, deviceId, fakePrivateKey)
			return { status: 200, success: true, message: 'Login successful', accessToken, refreshToken }
		}
		// 时间攻击保护
		const delay = Math.max(0, avgVerifyTime * 0.9 + Math.random() * avgVerifyTime * 0.2)
		await new Promise(resolve => setTimeout(resolve, delay).unref())
		return { status: 401, success: false, message: 'Invalid username or password', ...response }
	}

	if (!user) return await handleFailedLogin()

	const authData = user.auth
	if (authData.lockedUntil && authData.lockedUntil > Date.now()) {
		const timeLeft = ms(authData.lockedUntil - Date.now(), { long: true })
		return { status: 403, success: false, message: `Account locked. Try again in ${timeLeft}.` }
	}

	// 无密码用户：跳过密码验证
	if (authData.passwordless) {
		// 无密码用户不需要验证，直接通过
	} else {
		// 有密码用户：验证密码
		const startTime = Date.now()
		const isValidPassword = await verifyPassword(password, authData.password)
		avgVerifyTime = (avgVerifyTime * 3 + (Date.now() - startTime)) / 4

		if (!isValidPassword) {
			authData.loginAttempts = (authData.loginAttempts || 0) + 1
			if (authData.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
				authData.lockedUntil = Date.now() + ms(ACCOUNT_LOCK_TIME)
				authData.loginAttempts = 0
				save_config()
				diag.warn('账户锁定:', username, 'ip:', ip, '锁至:', new Date(authData.lockedUntil).toISOString())
				console.logI18n('beiluConsole.auth.accountLockedLog', { username })
				return { status: 403, success: false, message: 'Account locked due to too many failed attempts.' }
			}
			return await handleFailedLogin()
		}
	}

	// 登录成功
	diag.log('login 成功:', username, 'ip:', ip, 'device:', deviceId)
	delete loginFailures[ip]
	authData.loginAttempts = 0
	authData.lockedUntil = null

	// 创建用户目录：首登录时把 default/templates/user 磁盘模板拷进用户目录（serviceSources 种子等）。
	// overwrite:false → 老用户已有目录时零覆盖（回归门：不破坏 data/users/<老用户>/*）。
	// 禁吞错(T044)：copySync 失败会让新用户进入残缺环境（无 serviceSources/AI 派生等），
	//   不许再静默 console.error——改结构化上报 wbDetect(ok=false) 进白盒监控，用户/运维可见。
	const userdir = getUserDictionary(username)
	if (!fs.existsSync(userdir)) try {
		fse.copySync(path.join(__dirname, '/default/templates/user'), userdir, { overwrite: false })
	} catch (e) {
		wbDetect(null, 'auth', 'login:template_copy_failed', false, '新用户初始化模板拷贝失败,用户环境可能残缺', { username, userdir, err: e?.message || String(e) })
		console.error(`Failed to copy default user template for ${username}`, e)
	}

	for (const subdir of ['settings']) try {
		fs.mkdirSync(path.join(userdir, subdir), { recursive: true })
	} catch (e) {
		wbDetect(null, 'auth', 'login:subdir_create_failed', false, '新用户settings目录创建失败', { username, subdir, err: e?.message || String(e) })
		console.error(`Failed to create user subdirectory: ${subdir}`, e)
	}

	const { accessToken, refreshToken } = await issueSessionTokens(user, deviceId, req)
	return { status: 200, success: true, message: 'Login successful', accessToken, refreshToken }
}

/**
 * 会话 token 签发核心（单一权威）：签 access+refresh 并把 refresh jti 登记进 user.auth.refreshTokens 账本。
 * login 与改名会话迁移（reissueSessionTokens）共用，杜绝两处账本口径漂移。
 * @param {object} user - config.data.users 里的用户对象（活引用）。
 * @param {string} [deviceId='unknown'] - 设备标识（refresh 账本按 deviceId 去重）。
 * @param {import('npm:express').Request} [req=null] - 用于登记 ip/userAgent，可空。
 * @returns {Promise<{accessToken: string, refreshToken: string}>}
 */
async function issueSessionTokens(user, deviceId = 'unknown', req = null) {
	const authData = user.auth
	const payload = { username: user.username, userId: authData.userId }
	const accessToken = await generateAccessToken(payload)
	const refreshToken = await generateRefreshToken(payload, deviceId)
	const decodedRefreshToken = jose.decodeJwt(refreshToken)

	authData.refreshTokens = (authData.refreshTokens || []).filter(t => t.deviceId !== deviceId)
	authData.refreshTokens.push({
		jti: decodedRefreshToken.jti,
		deviceId,
		expiry: decodedRefreshToken.exp * 1000,
		ipAddress: req?.ip,
		userAgent: req?.headers?.['user-agent'],
		lastSeen: Date.now(),
	})
	if (authData.refreshTokens.length > getMaxRefreshTokens()) {
		authData.refreshTokens.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
		authData.refreshTokens.length = getMaxRefreshTokens()
	}
	save_config()
	return { accessToken, refreshToken }
}

/**
 * 改名会话迁移（20260706 改名传导链）：JWT payload 载用户名，改名后旧 cookie 全部失效
 *   ——不重签 = 自改名当场把自己静默登出（与删号同死路家族）。系统事件在发生处处置：
 *   改名端点成功后调本函数按新用户名重签 token，发起浏览器（同浏览器所有标签共享 cookie）无缝续会话；
 *   其他设备无法远程改写 cookie，走 401→登录页兜底链。
 *   deviceId 从当前 refresh cookie 的 JWT 声明恢复（generateRefreshToken 埋入），保持账本按设备去重的语义。
 * @param {import('npm:express').Request} req - 当前请求（取旧 refresh cookie 的 deviceId）。
 * @param {string} username - 新用户名。
 * @returns {Promise<{accessToken: string, refreshToken: string}|null>} 用户不存在时 null。
 */
export async function reissueSessionTokens(req, username) {
	const user = getUserByUsername(username)
	if (!user?.auth) return null
	let deviceId = 'unknown'
	try { deviceId = jose.decodeJwt(req.cookies?.refreshToken)?.deviceId || 'unknown' } catch { /* 无/坏 refresh cookie → unknown */ }
	return issueSessionTokens(user, deviceId, req)
}


/**
 * 注册一个新用户。支持无密码注册。
 * @param {string} username - 用户名。
 * @param {string} [password] - 密码。为空或不提供则创建无密码用户。
 * @returns {Promise<object>} 包含状态码和用户信息的对象。
 */
export async function register(username, password) {
	if (!username || username.trim() === '') return { status: 400, success: false, message: 'Username is required' }
	// 用户名安全净化（20260707 路径穿越确诊：'../admin' 经 path.join 逃出 data/users/ 写到 data/admin）：
	//   - 禁 / \ .. null 及控制字符（目录穿越/目录逃逸/文件系统截断面）
	//   - 长度上限 64（超长名在 Windows NTFS 260 路径限制下爆路径 + config.json 体积膨胀面）
	//   - 不做大小写归一（现有用户区分大小写是 config key 语义；Windows 目录不敏感属已知设计取舍）
	// eslint-disable-next-line no-control-regex
	if (/[/\\]|\.\.|\x00|[\x01-\x1f]/.test(username))
		return { status: 400, success: false, message: 'Username contains illegal characters' }
	if (username.length > 64)
		return { status: 400, success: false, message: 'Username too long (max 64)' }
	if (getUserByUsername(username)?.auth) return { status: 409, success: false, message: 'Username already exists' }
	const _isFirstUser = Object.keys(config.data.users || {}).length === 0
	const newUser = await createUser(username, password || '')
	// SEC-R1：首个注册用户落定为实例 owner（运营者），持久化；之后注册不授予 owner。
	if (_isFirstUser && !config.ownerUsername) {
		config.ownerUsername = username
		try { save_config() } catch { /* 下次 getOwnerUsername 惰性落定兜底 */ }
	}
	return { status: 201, success: true, user: { username: newUser.username, userId: newUser.auth.userId, passwordless: newUser.auth.passwordless, createdAt: newUser.createdAt } }
}

/**
 * 使用 API 密钥设置认证 Cookies。
 * @param {string} apiKey - API 密钥。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @param {import('npm:express').Response} res - Express 响应对象。
 * @returns {Promise<object>} 操作结果。
 */
export async function setApiCookieResponse(apiKey, req, res) {
	if (!apiKey) return { status: 400, success: false, error: 'API key is required.' }

	const user = await verifyApiKey(apiKey)
	if (!user) return { status: 401, success: false, error: 'Invalid API key.' }

	const hash = crypto.createHash('sha256').update(apiKey).digest('hex')
	const apiKeyInfo = config.data.apiKeys[hash]
	if (!apiKeyInfo) return { status: 500, success: false, error: 'API key data inconsistency.' }

	// SEC-T6/R5 洗白修复：经单一权威 resolveApiKeyScopes 解析（与 verifyApiKey 同口径，
	//   存量无 scope key 在 server 模式 fail-closed []，杜绝换 cookie 洗成 ['*'] 全权的提权）。
	const keyScopes = resolveApiKeyScopes(apiKeyInfo.scopes)
	const payload = { username: user.username, userId: user.auth.userId, scopes: keyScopes, apiKeyJti: apiKeyInfo.jti }
	const apiAccessToken = await generateApiAccessToken(payload)
	const apiRefreshToken = await generateApiRefreshToken(payload, apiKeyInfo.jti)
	const decodedApiRefreshToken = jose.decodeJwt(apiRefreshToken)

	user.auth.apiRefreshTokens = user.auth.apiRefreshTokens.filter(t => t.apiKeyJti !== apiKeyInfo.jti)
	user.auth.apiRefreshTokens.push({
		jti: decodedApiRefreshToken.jti,
		apiKeyJti: apiKeyInfo.jti,
		expiry: decodedApiRefreshToken.exp * 1000,
		ipAddress: req?.ip,
		userAgent: req?.headers?.['user-agent'],
		lastSeen: Date.now(),
	})

	const cookieOptions = getSecureCookieOptions(req)
	res.cookie('apiAccessToken', apiAccessToken, { ...cookieOptions, maxAge: ACCESS_TOKEN_EXPIRY_DURATION })
	res.cookie('apiRefreshToken', apiRefreshToken, { ...cookieOptions, maxAge: REFRESH_TOKEN_EXPIRY_DURATION })

	return { status: 200, success: true, message: 'API cookie set successfully.' }
}


// --- 定时清理任务 ---

/**
 * 清理过期的已撤销令牌。
 * @returns {void}
 */
function cleanupRevokedTokens() {
	const now = Date.now()
	let changed = false
	for (const jti in config.data.revokedTokens)
		if (config.data.revokedTokens[jti].expiry <= now) {
			delete config.data.revokedTokens[jti]
			changed = true
		}

	if (changed) save_config()
}

/**
 * 清理用户配置中过期的刷新令牌。
 * @returns {void}
 */
function cleanupRefreshTokens() {
	const now = Date.now()
	let changed = false
	for (const username in config.data.users) {
		const user = config.data.users[username]
		if (user?.auth?.refreshTokens) {
			const originalCount = user.auth.refreshTokens.length
			user.auth.refreshTokens = user.auth.refreshTokens.filter(
				token => token.expiry > now && !config.data.revokedTokens[token.jti]
			)
			if (user.auth.refreshTokens.length > getMaxRefreshTokens()) {
				user.auth.refreshTokens.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
				user.auth.refreshTokens.length = getMaxRefreshTokens()
			}
			if (user.auth.refreshTokens.length !== originalCount) changed = true
		}
	}
	if (changed) save_config()
}

/**
 * 清理旧的登录失败记录。
 * @returns {void}
 */
function cleanupLoginFailures() {
	for (const ip in loginFailures) delete loginFailures[ip]
}

// 设置定时任务
setInterval(() => {
	cleanupRevokedTokens()
	cleanupRefreshTokens()
	cleanupLoginFailures()
}, ms('1h')).unref()
