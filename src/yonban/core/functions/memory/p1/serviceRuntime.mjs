/**
 * P1 独立服务在宿主中的唯一生命周期所有者。
 *
 * 所有宿主入口（HTTP relay、IPC、生产 p1Bridge）都必须经本模块探测、启动和请求，
 * 避免某条入口只会直连、某条入口另起一套 cooldown/marker 状态。
 */

function _env(name) {
	try { return globalThis.Deno?.env?.get?.(name) }
	catch { return undefined }
}

function _positiveNumber(name, fallback) {
	const value = Number(_env(name))
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function _filePath(url) {
	return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
}

import {
	RESOURCE_ROOT,
	RUNTIME_ROOT,
	STORAGE_ROOT,
	UPDATE_RESTART_MARKER,
	p1ProcessEnv,
} from './paths.mjs'

export const P1_SERVICE_PORT = _positiveNumber('P1_SERVICE_PORT', 13150)
export const P1_SERVICE_BASE = `http://127.0.0.1:${P1_SERVICE_PORT}`

const SERVICE_DIR = _filePath(new URL('./service/', import.meta.url))
const PROXY_TIMEOUT_MS = _positiveNumber('P1_PROXY_TIMEOUT_MS', 30000)
const HEALTH_TIMEOUT_MS = _positiveNumber('P1_HEALTH_TIMEOUT_MS', 3000)
const WARMUP_TIMEOUT_MS = _positiveNumber('P1_WARMUP_TIMEOUT_MS', 180000)
const START_WAIT_MS = _positiveNumber('P1_START_WAIT_MS', 10000)
const START_POLL_MS = _positiveNumber('P1_START_POLL_MS', 250)
const SPAWN_COOLDOWN_MS = _positiveNumber('P1_SPAWN_COOLDOWN_MS', 60000)
const STOP_WAIT_MS = _positiveNumber('P1_STOP_WAIT_MS', 10000)
const AUTOSTART = (_env('P1_AUTOSTART') || 'on') !== 'off'

let _lastSpawnAt = 0
let _ensurePromise = null
let _warmPromise = null
let _stopPromise = null
let _hostShutdownStarted = false
let _serviceOwnership = null

function _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function _tcpReachable(timeoutMs) {
	if (!globalThis.Deno?.connect) return true
	let expired = false
	const connecting = globalThis.Deno.connect({ hostname: '127.0.0.1', port: P1_SERVICE_PORT })
		.then((connection) => {
			try { connection.close() } catch { /* already closed */ }
			return !expired
		})
		.catch(() => false)
	return await Promise.race([
		connecting,
		_sleep(timeoutMs).then(() => { expired = true; return false }),
	])
}

async function _spawnServiceProcess() {
	if (!globalThis.Deno?.Command) throw new Error('当前运行时不支持 Deno.Command')

	// Windows 下 Deno.ChildProcess.unref() 只解除事件循环等待；短命 Deno 调用进程
	// 退出时仍可能带走它直接创建的 Python，Python 来不及执行 cluster 回收，留下
	// 13151-13153 孤儿。让一个等待结束的隐藏 PowerShell 用 Start-Process 创建服务，
	// Python 便不再由 Deno 直接持有；真实本体长驻、命令行拉线和宿主退出语义一致。
	if (globalThis.Deno.build?.os === 'windows') {
		const spawnResultFile = `${RUNTIME_ROOT.replace(/[\\\/]$/, '')}/.spawn-${globalThis.Deno.pid}-${Date.now()}.pid`
		const bootstrap = [
			'$serviceDir = $env:P1_SERVICE_BOOTSTRAP_DIR',
			'$servicePort = $env:P1_SERVICE_PORT',
			'$runtimeDir = $env:P1_RUNTIME_DIR',
			'$resultFile = $env:P1_SERVICE_SPAWN_RESULT',
			'New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null',
			'$stdoutLog = Join-Path $runtimeDir "service.stdout.log"',
			'$stderrLog = Join-Path $runtimeDir "service.stderr.log"',
			"try { $process = Start-Process -FilePath 'python' -ArgumentList @('p1_server.py', '--port', $servicePort) -WorkingDirectory $serviceDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog; [IO.File]::WriteAllText($resultFile, [string]$process.Id, [Text.Encoding]::ASCII) } catch { [IO.File]::WriteAllText($stderrLog, ($_ | Out-String), [Text.Encoding]::UTF8); exit 1 }",
		].join('; ')
		const result = await new globalThis.Deno.Command('powershell', {
			args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', bootstrap],
			env: p1ProcessEnv({
				P1_SERVICE_BOOTSTRAP_DIR: SERVICE_DIR,
				P1_SERVICE_PORT: String(P1_SERVICE_PORT),
				P1_SERVICE_SPAWN_RESULT: spawnResultFile,
			}),
			stdout: 'null',
			stderr: 'null',
			stdin: 'null',
		}).output()
		let pidText = ''
		try { pidText = (await globalThis.Deno.readTextFile(spawnResultFile)).trim() }
		catch { /* failure handled below */ }
		try { await globalThis.Deno.remove(spawnResultFile) } catch { /* best effort */ }
		const pid = Number(pidText)
		if (!result.success || !Number.isInteger(pid) || pid <= 0) {
			throw new Error(`PowerShell Start-Process 未返回有效 PID: ${pidText || '(empty)'}；查看 ${RUNTIME_ROOT}/service.stderr.log`)
		}
		return { pid, owner: 'powershell-start-process' }
	}

	const child = new globalThis.Deno.Command('python', {
		args: ['p1_server.py', '--port', String(P1_SERVICE_PORT)],
		cwd: SERVICE_DIR,
		env: p1ProcessEnv({ P1_SERVICE_PORT: String(P1_SERVICE_PORT) }),
		stdout: 'null',
		stderr: 'null',
		stdin: 'null',
	}).spawn()
	child.unref?.()
	return { pid: child.pid, owner: 'deno-child-unref' }
}

function _timeoutSignal(ms) {
	return AbortSignal.timeout(ms)
}

function _parseJson(text) {
	if (!text) return null
	try { return JSON.parse(text) }
	catch { return null }
}

async function _fetchResponse(path, options = {}) {
	const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
		? Number(options.timeoutMs)
		: PROXY_TIMEOUT_MS
	try {
		const response = await fetch(`${P1_SERVICE_BASE}/${path}`, {
			method: options.method || 'GET',
			headers: options.headers,
			body: options.body,
			signal: _timeoutSignal(timeoutMs),
		})
		const text = await response.text()
		const data = _parseJson(text)
		return {
			transportOk: true,
			ok: response.ok,
			status: response.status,
			contentType: response.headers?.get?.('content-type') || 'application/json',
			data,
			text,
			...(text && data === null ? {
				code: 'E_P1_INVALID_JSON',
				error: `P1 服务返回了非 JSON 响应（HTTP ${response.status}）`,
			} : {}),
		}
	} catch (error) {
		return {
			transportOk: false,
			ok: false,
			status: 503,
			code: 'E_P1_TRANSPORT',
			error: `P1 服务不可达 (${P1_SERVICE_BASE}): ${error?.message || error}`,
			cause: error,
			data: null,
			text: '',
		}
	}
}

/** 只读探测，不启动服务。 */
export async function probeP1Service(options = {}) {
	const timeoutMs = options.timeoutMs || HEALTH_TIMEOUT_MS
	const portListening = await _tcpReachable(Math.min(timeoutMs, 500))
	if (!portListening) {
		return {
			transportOk: false, ok: false, status: 503, portListening: false, reachable: false,
			liveness: false, ready: false, readyForRecall: false,
			code: 'E_P1_TRANSPORT', error: `P1 服务端口未监听 (${P1_SERVICE_BASE})`,
			service: P1_SERVICE_BASE, data: null, text: '',
		}
	}
	const result = await _fetchResponse('health', { method: 'GET', timeoutMs })
	const liveness = result.transportOk && result.ok
		&& result.data?.ok === true && result.data?.liveness === true
	const readyForRecall = liveness && result.data?.readyForRecall === true
	return {
		...result,
		portListening: true,
		reachable: result.transportOk,
		liveness,
		readyForRecall,
		ready: readyForRecall,
		service: P1_SERVICE_BASE,
	}
}

function _servicePidFromProbe(probe) {
	const pid = Number(probe?.data?.pid)
	return probe?.liveness === true && Number.isInteger(pid) && pid > 0 ? pid : null
}

async function _hasUpdateRestartMarker() {
	try {
		await globalThis.Deno.stat(UPDATE_RESTART_MARKER)
		return true
	} catch (error) {
		if (error?.name !== 'NotFound') console.warn(`[shells:p1] 无法读取更新重启标记: ${error?.message || error}`)
		return false
	}
}

async function _clearUpdateRestartMarker() {
	try {
		await globalThis.Deno.remove(UPDATE_RESTART_MARKER)
	} catch (error) {
		if (error?.name !== 'NotFound') console.warn(`[shells:p1] 新服务已就绪，但无法清除更新重启标记: ${error?.message || error}`)
	}
}

async function _stopP1Service(options = {}) {
	const requireOwnership = options.requireOwnership === true
	const ownership = _serviceOwnership
	if (requireOwnership && !ownership) {
		return { success: true, state: 'not-owned', service: P1_SERVICE_BASE }
	}
	const initialProbe = await probeP1Service()
	if (!initialProbe.portListening) {
		_serviceOwnership = null
		return {
			success: true,
			state: 'already-stopped',
			service: P1_SERVICE_BASE,
			probe: initialProbe,
		}
	}
	const observedPid = _servicePidFromProbe(initialProbe)
	if (requireOwnership && (observedPid === null || observedPid !== ownership.pid)) {
		return {
			success: false,
			state: 'ownership-uncertain',
			code: 'E_P1_OWNERSHIP_UNCERTAIN',
			error: observedPid === null
				? 'P1 health 未返回可确认的服务 PID；不会停止端口上的未知实例'
				: `P1 health PID ${observedPid} 与本轮启动 PID ${ownership.pid} 不一致；不会停止其他实例`,
			service: P1_SERVICE_BASE,
			ownership: { ...ownership },
			observedPid,
			probe: initialProbe,
		}
	}
	if (requireOwnership) ownership.confirmed = true
	const expectedPid = requireOwnership ? ownership.pid : observedPid

	const stopped = await _fetchResponse('lifecycle/stop', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify(expectedPid === null ? {} : { expectedPid }),
		timeoutMs: HEALTH_TIMEOUT_MS,
	})
	const stopAccepted = stopped.transportOk && stopped.ok
		&& stopped.data?.success === true && stopped.data?.stopping === true
	if (!stopAccepted) {
		const invalidSuccessResponse = stopped.transportOk && stopped.ok
		return {
			success: false,
			state: 'stop-request-failed',
			code: stopped.code || stopped.data?.code
				|| (invalidSuccessResponse ? 'E_P1_STOP_RESPONSE_INVALID' : 'E_P1_STOP_REQUEST_FAILED'),
			error: stopped.error || stopped.data?.error || (invalidSuccessResponse
				? 'P1 停止响应未确认 success:true 且 stopping:true'
				: `P1 停止请求失败（HTTP ${stopped.status}）`),
			service: P1_SERVICE_BASE,
			request: stopped,
		}
	}
	for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += START_POLL_MS) {
		await _sleep(Math.min(START_POLL_MS, STOP_WAIT_MS - elapsed))
		const probe = await probeP1Service({ timeoutMs: Math.min(HEALTH_TIMEOUT_MS, START_POLL_MS) })
		// 必须等监听端口真正释放；HTTP 非 2xx 只代表旧进程不健康，不代表可安全并行拉新进程。
		if (!probe.portListening) {
			_serviceOwnership = null
			return {
				success: true,
				state: 'stopped',
				service: P1_SERVICE_BASE,
				request: stopped,
				probe,
			}
		}
	}
	return {
		success: false,
		state: 'stop-timeout',
		code: 'E_P1_STOP_TIMEOUT',
		error: `P1 服务在受控停止后 ${STOP_WAIT_MS}ms 内仍未释放端口`,
		service: P1_SERVICE_BASE,
		request: stopped,
	}
}

function _stopP1ServiceSingleFlight(options = {}) {
	if (_stopPromise) return _stopPromise
	_stopPromise = _stopP1Service(options).finally(() => { _stopPromise = null })
	return _stopPromise
}

/**
 * 幂等停止 P1 服务。finalExit 会先封闭宿主自动启动入口，并等待已在途的 ensure/spawn 落定后再探测停止。
 */
export async function stopP1Service(options = {}) {
	if (options.finalExit === true) {
		_hostShutdownStarted = true
		const inFlightEnsure = _ensurePromise
		if (inFlightEnsure) try {
			await inFlightEnsure
		} catch (error) {
			console.warn(`[shells:p1] 宿主退出等待在途 P1 启动失败: ${error?.message || error}`)
		}
		return await _stopP1ServiceSingleFlight({ requireOwnership: true })
	}
	return await _stopP1ServiceSingleFlight({ requireOwnership: false })
}

async function _stopExistingServiceForUpdate() {
	const stopped = await stopP1Service()
	if (stopped.success) return true
	if (stopped.state === 'stop-timeout') {
		console.warn('[shells:p1] 旧 P1 服务在受控停止后仍占用端口；保留重启标记，不会并行拉起混版本服务')
		return false
	}
	const request = stopped.request
	const failureDetail = stopped.code === 'E_P1_STOP_RESPONSE_INVALID'
		? stopped.error
		: (request?.transportOk ? `HTTP ${request.status}` : stopped.error)
	console.warn(`[shells:p1] 旧 P1 服务未完成受控更新停止（${failureDetail}）；保留重启标记`)
	return false
}

function _ensureFailure(state, code, error, extra = {}) {
	return { liveness: false, readyForRecall: false, state, code, error, service: P1_SERVICE_BASE, ...extra }
}

function _shuttingDownFailure() {
	return _ensureFailure('shutting-down', 'E_P1_SHUTTING_DOWN', '宿主退出已开始，P1 服务不会再自动启动')
}

async function _ensureP1Service() {
	if (_hostShutdownStarted) return _shuttingDownFailure()
	const updateRestartRequired = await _hasUpdateRestartMarker()
	if (_hostShutdownStarted) return _shuttingDownFailure()
	const initialProbe = await probeP1Service()
	if (_hostShutdownStarted) return _shuttingDownFailure()
	if (!initialProbe.portListening) _serviceOwnership = null
	if (initialProbe.liveness && !updateRestartRequired) {
		if (_serviceOwnership && _servicePidFromProbe(initialProbe) === _serviceOwnership.pid) {
			_serviceOwnership.confirmed = true
		}
		return {
			liveness: true,
			readyForRecall: initialProbe.readyForRecall,
			state: 'already-running',
			service: P1_SERVICE_BASE,
			probe: initialProbe,
		}
	}
	if (initialProbe.portListening && updateRestartRequired) {
		if (!await _stopExistingServiceForUpdate()) {
			return _ensureFailure(
				'update-restart-pending',
				'E_P1_UPDATE_RESTART_PENDING',
				'P1 源码已更新，但旧服务尚未完成受控重启；为避免混用旧代码，本次请求未转发。',
			)
		}
		if (_hostShutdownStarted) return _shuttingDownFailure()
	}
	if (initialProbe.portListening && !updateRestartRequired) {
		return _ensureFailure(
			'service-unhealthy',
			'E_P1_SERVICE_UNHEALTHY',
			'P1 端口已监听，但 /health 未返回当前 liveness 契约；不会在占用端口上并行拉起新服务。',
			{ probe: initialProbe },
		)
	}

	if (_hostShutdownStarted) return _shuttingDownFailure()
	if (!AUTOSTART) {
		return _ensureFailure('autostart-off', 'E_P1_AUTOSTART_OFF', 'P1 服务未运行，且 P1_AUTOSTART=off')
	}
	const sinceLastSpawn = Date.now() - _lastSpawnAt
	if (sinceLastSpawn < SPAWN_COOLDOWN_MS) {
		return _ensureFailure(
			'spawn-cooldown',
			'E_P1_SPAWN_COOLDOWN',
			`P1 服务仍未就绪；启动冷却剩余 ${SPAWN_COOLDOWN_MS - sinceLastSpawn}ms`,
		)
	}

	_lastSpawnAt = Date.now()
	let spawned
	try {
		if (_hostShutdownStarted) return _shuttingDownFailure()
		spawned = await _spawnServiceProcess()
		_serviceOwnership = {
			pid: Number(spawned.pid),
			owner: spawned.owner,
			startedAt: Date.now(),
			confirmed: false,
		}
	} catch (error) {
		const message = `自动启动 P1 服务失败（${error?.message || error}）`
		console.warn(`[shells:p1] ${message}——手动启动: cd ${SERVICE_DIR} && python p1_server.py`)
		return _ensureFailure('spawn-failed', 'E_P1_SPAWN_FAILED', message)
	}

	const deadline = Date.now() + START_WAIT_MS
	while (Date.now() < deadline) {
		await _sleep(Math.min(START_POLL_MS, Math.max(1, deadline - Date.now())))
		const probe = await probeP1Service({ timeoutMs: Math.min(HEALTH_TIMEOUT_MS, START_POLL_MS) })
		if (!probe.liveness) continue
		const observedPid = _servicePidFromProbe(probe)
		if (observedPid !== _serviceOwnership?.pid) {
			return _ensureFailure(
				'spawn-ownership-unconfirmed',
				'E_P1_SPAWN_OWNERSHIP_UNCONFIRMED',
				observedPid === null
					? 'P1 spawn 后 health 未返回 PID；不会认领或清除更新标记'
					: `P1 spawn PID ${_serviceOwnership?.pid} 与 health PID ${observedPid} 不一致；不会认领或清除更新标记`,
				{ pid: _serviceOwnership?.pid, owner: _serviceOwnership?.owner, observedPid, probe },
			)
		}
		_serviceOwnership.confirmed = true
		if (_hostShutdownStarted) return _shuttingDownFailure()
		if (updateRestartRequired) await _clearUpdateRestartMarker()
		console.log(`[shells:p1] P1 服务已自动启动 (${P1_SERVICE_BASE}, pid=${spawned?.pid ?? '?'}, owner=${spawned?.owner ?? '?'})`)
		return {
			liveness: true,
			readyForRecall: probe.readyForRecall,
			state: 'spawned', service: P1_SERVICE_BASE,
			pid: spawned?.pid, owner: spawned?.owner, probe,
		}
	}

	if (_hostShutdownStarted) return _shuttingDownFailure()
	const message = `P1 服务 spawn 后 ${START_WAIT_MS}ms 未就绪 (${P1_SERVICE_BASE})；日志: ${RUNTIME_ROOT}`
	console.warn(`[shells:p1] ${message}——查看 python 环境或手动启动: python ${SERVICE_DIR}p1_server.py`)
	return _ensureFailure('spawned-not-ready', 'E_P1_START_TIMEOUT', message, { pid: spawned?.pid, owner: spawned?.owner })
}

/**
 * 探测/更新/启动的单飞入口。同一冷启动窗口内所有调用共享完整 Promise，等待服务真正健康。
 */
export function ensureP1Service() {
	if (_hostShutdownStarted) return Promise.resolve(_shuttingDownFailure())
	if (_ensurePromise) return _ensurePromise
	_ensurePromise = _ensureP1Service().finally(() => { _ensurePromise = null })
	return _ensurePromise
}

function _requestHeaders(options = {}) {
	const headers = { ...(options.headers || {}) }
	headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=utf-8'
	if (options.username !== undefined) {
		headers['X-P1-Username'] = encodeURIComponent(String(options.username || ''))
	}
	if (options.memoryRoot !== undefined) {
		headers['X-P1-Memory-Root'] = encodeURIComponent(String(options.memoryRoot || ''))
	}
	return headers
}

async function _warmP1Service(options = {}) {
	const ensured = await ensureP1Service()
	if (!ensured.liveness) {
		return {
			transportOk: false, ok: false, status: 503,
			code: ensured.code, error: ensured.error, ensure: ensured,
			liveness: false, readyForRecall: false, data: null, text: '',
		}
	}
	const result = await _fetchResponse('warmup', {
		method: 'POST',
		headers: _requestHeaders(options),
		body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {}),
		timeoutMs: options.timeoutMs || WARMUP_TIMEOUT_MS,
	})
	const readyForRecall = result.transportOk && result.ok
		&& result.data?.success === true && result.data?.readyForRecall === true
	if (!readyForRecall) {
		return {
			...result,
			code: result.code || result.data?.code || 'E_P1_WARMUP_FAILED',
			error: result.error || result.data?.error || 'P1 warmup 未进入 readyForRecall 状态',
			ensure: ensured,
			liveness: ensured.liveness,
			readyForRecall: false,
		}
	}
	return { ...result, ensure: ensured, liveness: true, readyForRecall: true }
}

/** 专用资源预热单飞；不构造伪输入，不读取用户记忆，也不写召回运行记录。 */
export function warmP1Service(options = {}) {
	if (_warmPromise) return _warmPromise
	_warmPromise = _warmP1Service(options).finally(() => { _warmPromise = null })
	return _warmPromise
}

/**
 * 向 P1 发请求。返回 transport/http/service 三层原始证据，不把 success:true 空结果、
 * success:false 和连接失败压成同一个 null。
 */
export async function requestP1Service(action, options = {}) {
	const normalizedAction = String(action || '').trim()
	if (!/^[A-Za-z0-9_-]+$/.test(normalizedAction)) {
		return {
			transportOk: false,
			ok: false,
			status: 400,
			code: 'E_P1_ACTION_INVALID',
			error: `非法 P1 action: ${normalizedAction || '(empty)'}`,
			data: null,
			text: '',
		}
	}
	if (normalizedAction === 'warmup') return warmP1Service(options)

	const ensured = await ensureP1Service()
	if (!ensured.liveness) {
		return {
			transportOk: false,
			ok: false,
			status: 503,
			code: ensured.code,
			error: ensured.error,
			ensure: ensured,
			data: null,
			text: '',
		}
	}

	const method = options.method || 'POST'
	const headers = _requestHeaders(options)
	let body
	if (method !== 'GET') {
		// 统一 HTTP 文本契约：JS 字符串由 fetch 按 UTF-8 发送，FastAPI 直接 req.json()。
		// 不对中文做 encodeURIComponent/base64 等二次编码，避免把生产输入改成测试壳格式。
		body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {})
	}
	const result = await _fetchResponse(normalizedAction, {
		method,
		headers,
		body,
		timeoutMs: options.timeoutMs,
	})
	return { ...result, ensure: ensured }
}

export const P1_PATHS = Object.freeze({
	service: SERVICE_DIR,
	resources: RESOURCE_ROOT,
	storage: STORAGE_ROOT,
	runtime: RUNTIME_ROOT,
	restartMarker: UPDATE_RESTART_MARKER,
})
