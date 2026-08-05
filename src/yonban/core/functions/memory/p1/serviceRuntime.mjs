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

function _nonNegativeInteger(name, fallback) {
	const raw = _env(name)
	if (raw === undefined || raw === null || raw === '') return fallback
	const value = Number(raw)
	return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

function _filePath(url) {
	return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
const DEPS_MARKER = join(RUNTIME_ROOT, '.p1-deps-installed')
const PROXY_TIMEOUT_MS = _positiveNumber('P1_PROXY_TIMEOUT_MS', 30000)
const HEALTH_TIMEOUT_MS = _positiveNumber('P1_HEALTH_TIMEOUT_MS', 3000)
const WARMUP_TIMEOUT_MS = _positiveNumber('P1_WARMUP_TIMEOUT_MS', 180000)
const START_WAIT_MS = _positiveNumber('P1_START_WAIT_MS', 10000)
const START_POLL_MS = _positiveNumber('P1_START_POLL_MS', 250)
const SPAWN_COOLDOWN_MS = _positiveNumber('P1_SPAWN_COOLDOWN_MS', 60000)
const STOP_WAIT_MS = _positiveNumber('P1_STOP_WAIT_MS', 10000)
const HOST_ORPHAN_GRACE_SEC = _positiveNumber('P1_HOST_ORPHAN_GRACE_SEC', 120)
const START_RETRY_COUNT = _nonNegativeInteger('P1_START_RETRY_COUNT', 2)
const MAX_START_ATTEMPTS = START_RETRY_COUNT + 1
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

function _spawnAttemptError(reason, message, options = {}) {
	const error = new Error(message)
	error.code = reason === 'spawn-not-created' ? 'E_P1_SPAWN_NOT_CREATED' : 'E_P1_SPAWN_UNCERTAIN'
	error.reason = reason
	error.retryable = reason === 'spawn-not-created' && options.retryable === true
	if (options.cause !== undefined) error.cause = options.cause
	if (Number.isInteger(Number(options.pid)) && Number(options.pid) > 0) error.pid = Number(options.pid)
	if (options.owner) error.owner = options.owner
	if (options.bootstrapDiagnostic) error.bootstrapDiagnostic = options.bootstrapDiagnostic
	if (Number.isInteger(Number(options.bootstrapExitCode))) error.bootstrapExitCode = Number(options.bootstrapExitCode)
	return error
}

function _isProvablyNotCreatedCommandError(error) {
	return error?.name === 'NotFound' || error?.name === 'PermissionDenied'
}

function _decodeBootstrapOutput(output) {
	if (typeof output === 'string') return output.replace(/[\r\n]+/g, ' ').trim().slice(0, 4000)
	if (!(output instanceof Uint8Array) || output.length === 0) return ''
	try { return new TextDecoder().decode(output).replace(/[\r\n]+/g, ' ').trim().slice(0, 4000) }
	catch { return '' }
}

function _bootstrapDiagnostic(result) {
	const stderr = _decodeBootstrapOutput(result?.stderr)
	const stdout = _decodeBootstrapOutput(result?.stdout)
	return [stderr && `stderr=${stderr}`, stdout && `stdout=${stdout}`].filter(Boolean).join(' | ')
		|| `stderr/stdout 均无 bootstrap 诊断 (exit=${result?.code ?? 'unknown'})`
}

// P1 依赖自动安装：首次启动时执行 pip install -r requirements.txt，
// 标记文件 .p1-deps-installed 存在则跳过（requirements.txt 更新时删除标记即可重装）。
async function _ensurePythonDeps() {
	if (existsSync(DEPS_MARKER)) return
	const reqFile = join(SERVICE_DIR, 'requirements.txt')
	if (!existsSync(reqFile)) return
	if (!globalThis.Deno?.Command) return
	console.log('[shells:p1] 首次启动，自动安装 Python 依赖...')
	try {
		const result = await new globalThis.Deno.Command('python', {
			args: ['-m', 'pip', 'install', '-r', reqFile, '--quiet', '--disable-pip-version-check'],
			cwd: SERVICE_DIR,
			stdout: 'piped',
			stderr: 'piped',
			stdin: 'null',
		}).output()
		if (result.success) {
			try {
				const { mkdirSync, writeFileSync } = await import('node:fs')
				mkdirSync(RUNTIME_ROOT, { recursive: true })
				writeFileSync(DEPS_MARKER, JSON.stringify({ installedAt: new Date().toISOString(), reqFile }), 'utf-8')
			} catch { /* marker 写失败不阻塞启动，下次重装 */ }
			console.log('[shells:p1] Python 依赖安装完成')
		} else {
			const stderr = _decodeBootstrapOutput(result?.stderr)
			console.warn(`[shells:p1] pip install 失败 (exit=${result.code})${stderr ? ': ' + stderr.slice(0, 500) : ''}；P1 可能无法启动`)
		}
	} catch (e) {
		console.warn(`[shells:p1] pip install 无法执行: ${e?.message || e}；如 Python 未安装，P1 将不可用`)
	}
}

async function _spawnServiceProcess() {
	if (!globalThis.Deno?.Command) {
		throw _spawnAttemptError('spawn-not-created', '当前运行时不支持 Deno.Command', { retryable: true })
	}
	// 首次启动 storage/p1 和 data/p1 可能不存在（.gitignore 排除），P1 服务读写都依赖这两个目录
	for (const dir of [RUNTIME_ROOT, STORAGE_ROOT]) {
		try { const { mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true }) } catch { /* best effort */ }
	}
	// 依赖标记也落在 RUNTIME_ROOT；必须先建立目录，否则首次安装成功后标记写入
	// 会静默失败，导致每次重启都重新执行 pip install，首个 P1 请求再次被拖住。
	await _ensurePythonDeps()

	// Windows 下 Deno.ChildProcess.unref() 只解除事件循环等待；短命 Deno 调用进程
	// 退出时仍可能带走它直接创建的 Python，Python 来不及执行 cluster 回收，留下
	// 13151-13153 孤儿。让一个等待结束的隐藏 PowerShell 用 Start-Process 创建服务，
	// Python 便不再由 Deno 直接持有；真实本体长驻、命令行拉线和宿主退出语义一致。
	if (globalThis.Deno.build?.os === 'windows') {
		const spawnResultFile = `${RUNTIME_ROOT.replace(/[\\\/]$/, '')}/.spawn-${globalThis.Deno.pid}-${Date.now()}.pid`
		const bootstrap = [
			'$ErrorActionPreference = "Stop"',
			'[Console]::OutputEncoding = [Text.Encoding]::UTF8',
			'$OutputEncoding = [Text.Encoding]::UTF8',
			'function Write-P1BootstrapDiagnostic { param([string]$Phase, [object]$Record); $message = [string]$Record.Exception.Message; $message = $message -replace "[\\r\\n]+", " "; [Console]::Error.WriteLine(("P1_BOOTSTRAP phase={0} error={1}" -f $Phase, $message)) }',
			'$serviceDir = $env:P1_SERVICE_BOOTSTRAP_DIR',
			'$servicePort = $env:P1_SERVICE_PORT',
			'$runtimeDir = $env:P1_RUNTIME_DIR',
			'$resultFile = $env:P1_SERVICE_SPAWN_RESULT',
			"try { New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null } catch { Write-P1BootstrapDiagnostic 'prepare-runtime' $_; exit 40 }",
			'$stdoutLog = Join-Path $runtimeDir "service.stdout.log"',
			'$stderrLog = Join-Path $runtimeDir "service.stderr.log"',
			"try { $process = Start-Process -FilePath 'python' -ArgumentList @('p1_server.py', '--port', $servicePort) -WorkingDirectory $serviceDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog } catch { $startError = $_; Write-P1BootstrapDiagnostic 'start-process' $startError; try { [IO.File]::WriteAllText($stderrLog, ($startError | Out-String), [Text.Encoding]::UTF8) } catch { Write-P1BootstrapDiagnostic 'write-service-stderr' $_ }; exit 41 }",
			"try { [IO.File]::WriteAllText($resultFile, [string]$process.Id, [Text.Encoding]::ASCII) } catch { $pidError = $_; Write-P1BootstrapDiagnostic 'publish-pid' $pidError; try { [IO.File]::WriteAllText($stderrLog, ($pidError | Out-String), [Text.Encoding]::UTF8) } catch { Write-P1BootstrapDiagnostic 'write-service-stderr' $_ }; exit 42 }",
		].join('; ')
		let bootstrapProcess
		try {
			bootstrapProcess = new globalThis.Deno.Command('powershell', {
				args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', bootstrap],
				env: p1ProcessEnv({
					P1_SERVICE_BOOTSTRAP_DIR: SERVICE_DIR,
					P1_SERVICE_PORT: String(P1_SERVICE_PORT),
					P1_SERVICE_SPAWN_RESULT: spawnResultFile,
					P1_HOST_PID: String(globalThis.Deno.pid),
					P1_HOST_ORPHAN_GRACE_SEC: String(HOST_ORPHAN_GRACE_SEC),
				}),
				// 不再用 output() 等待管道 EOF：Start-Process 创建的长期 Python 可能继承
				// bootstrap 管道句柄，使 PID 已发布、服务已监听时 output() 仍永久 pending。
				stdout: 'null',
				stderr: 'inherit',
				stdin: 'null',
			}).spawn()
		} catch (error) {
			const retryable = _isProvablyNotCreatedCommandError(error)
			throw _spawnAttemptError(
				retryable ? 'spawn-not-created' : 'spawn-uncertain',
				`无法${retryable ? '创建' : '确认'} PowerShell 启动进程: ${error?.message || error}`,
				{ retryable, cause: error },
			)
		}
		const bootstrapStatus = bootstrapProcess.status
			.then((result) => ({ settled: true, result }))
			.catch((error) => ({ settled: true, error }))
		const bootstrapOutcome = await Promise.race([
			bootstrapStatus,
			_sleep(START_WAIT_MS).then(() => ({ settled: false })),
		])
		let pidText = ''
		try { pidText = (await globalThis.Deno.readTextFile(spawnResultFile)).trim() }
		catch { /* failure handled below */ }
		if (!bootstrapOutcome.settled) {
			try { bootstrapProcess.kill() }
			catch (error) {
				console.warn(`[shells:p1] PowerShell bootstrap 超时后终止失败: ${error?.message || error}`)
			}
		}
		try { await globalThis.Deno.remove(spawnResultFile) } catch { /* best effort */ }
		const pid = Number(pidText)
		if (Number.isInteger(pid) && pid > 0) {
			if (!bootstrapOutcome.settled) {
				console.warn(`[shells:p1] PowerShell bootstrap 在 ${START_WAIT_MS}ms 内未结算，但已发布 PID ${pid}；进入既有 health/PID ownership 确认`)
			}
			return { pid, owner: 'powershell-start-process' }
		}
		if (!bootstrapOutcome.settled) {
			throw _spawnAttemptError(
				'spawn-uncertain',
				`PowerShell bootstrap 在 ${START_WAIT_MS}ms 内未结算且未发布有效 PID；已终止 bootstrap，不会自动重试`,
				{
					retryable: false,
					owner: 'powershell-start-process',
					bootstrapDiagnostic: `bootstrap-timeout=${START_WAIT_MS}ms, pid=${pidText || '(empty)'}`,
				},
			)
		}
		if (bootstrapOutcome.error) {
			throw _spawnAttemptError(
				'spawn-uncertain',
				`PowerShell bootstrap 状态无法确认: ${bootstrapOutcome.error?.message || bootstrapOutcome.error}`,
				{ retryable: false, cause: bootstrapOutcome.error, owner: 'powershell-start-process' },
			)
		}
		const result = bootstrapOutcome.result
		const bootstrapDiagnostic = _bootstrapDiagnostic(result)
		// 只有尚未执行 Start-Process 的前置阶段（exit 40）能证明未创建进程。
		// Start-Process 自身抛错（exit 41）也可能发生在 CreateProcess 之后，必须按不确定处理。
		const provablyNotCreated = !result.success && result.code === 40
		throw _spawnAttemptError(
			provablyNotCreated ? 'spawn-not-created' : 'spawn-uncertain',
			provablyNotCreated
				? `PowerShell 在创建 P1 进程前失败 (exit=${result.code})；bootstrap 诊断: ${bootstrapDiagnostic}`
				: `PowerShell 可能已创建 P1 进程，但未确认有效 PID (exit=${result.code}, pid=${pidText || '(empty)'})；不会自动重试；bootstrap 诊断: ${bootstrapDiagnostic}`,
			{
				retryable: provablyNotCreated, pid, owner: 'powershell-start-process',
				bootstrapDiagnostic, bootstrapExitCode: result.code,
			},
		)
	}

	let child
	try {
		child = new globalThis.Deno.Command('python', {
			args: ['p1_server.py', '--port', String(P1_SERVICE_PORT)],
			cwd: SERVICE_DIR,
			env: p1ProcessEnv({
				P1_SERVICE_PORT: String(P1_SERVICE_PORT),
				P1_HOST_PID: String(globalThis.Deno.pid),
				P1_HOST_ORPHAN_GRACE_SEC: String(HOST_ORPHAN_GRACE_SEC),
			}),
			stdout: 'null',
			stderr: 'null',
			stdin: 'null',
		}).spawn()
	} catch (error) {
		const retryable = _isProvablyNotCreatedCommandError(error)
		throw _spawnAttemptError(
			retryable ? 'spawn-not-created' : 'spawn-uncertain',
			`Deno.Command.spawn ${retryable ? '未创建' : '无法确认是否创建'} P1 进程: ${error?.message || error}`,
			{ retryable, cause: error },
		)
	}
	const pid = Number(child?.pid)
	if (!Number.isInteger(pid) || pid <= 0) {
		throw _spawnAttemptError('spawn-uncertain', 'Deno.Command.spawn 已返回，但未提供可确认的 P1 PID', {
			pid, owner: 'deno-child-unref',
		})
	}
	try { child.unref?.() }
	catch (error) {
		throw _spawnAttemptError('spawn-uncertain', `P1 子进程已创建，但 unref 失败: ${error?.message || error}`, {
			cause: error, pid, owner: 'deno-child-unref',
		})
	}
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
	const attempt = Number.isInteger(Number(extra.attempt)) && Number(extra.attempt) >= 0 ? Number(extra.attempt) : 0
	const maxAttempts = Number.isInteger(Number(extra.maxAttempts)) && Number(extra.maxAttempts) > 0
		? Number(extra.maxAttempts)
		: MAX_START_ATTEMPTS
	const reason = typeof extra.reason === 'string' && extra.reason ? extra.reason : state
	const retryable = extra.retryable === true
	return {
		liveness: false, readyForRecall: false, state, code, error, service: P1_SERVICE_BASE,
		...extra, attempt, maxAttempts, reason, retryable,
	}
}

function _shuttingDownFailure(attempt = 0) {
	return _ensureFailure(
		'shutting-down',
		'E_P1_SHUTTING_DOWN',
		'宿主退出已开始，P1 服务不会再自动启动',
		{ attempt, reason: 'host-shutdown', retryable: false },
	)
}

async function _ensureP1Service() {
	if (_hostShutdownStarted) return _shuttingDownFailure()
	let updateRestartRequired = await _hasUpdateRestartMarker()
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
			attempt: 0,
			maxAttempts: MAX_START_ATTEMPTS,
			reason: 'already-running',
			retryable: false,
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

	// cooldown 从本轮最终终态开始；内部 retry 不再经过 cooldown 门。
	const completeStartRound = (result) => {
		_lastSpawnAt = Date.now()
		return result
	}
	for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
		if (attempt > 1) {
			if (_hostShutdownStarted) return completeStartRound(_shuttingDownFailure(attempt - 1))
			const retryUpdateRestartRequired = await _hasUpdateRestartMarker()
			if (_hostShutdownStarted) return completeStartRound(_shuttingDownFailure(attempt - 1))
			const retryProbe = await probeP1Service()
			if (_hostShutdownStarted) return completeStartRound(_shuttingDownFailure(attempt - 1))
			let blocked = null
			if (_serviceOwnership) {
				blocked = _ensureFailure(
					'spawn-ownership-unconfirmed',
					'E_P1_SPAWN_OWNERSHIP_UNCONFIRMED',
					'P1 retry 前仍存在本轮进程 ownership；不会创建第二个服务进程',
					{
						attempt: attempt - 1, reason: 'ownership-present-before-retry', retryable: false,
						pid: _serviceOwnership.pid, owner: _serviceOwnership.owner, probe: retryProbe,
					},
				)
			} else if (retryProbe.portListening) {
				blocked = retryUpdateRestartRequired
					? _ensureFailure(
						'update-restart-pending',
						'E_P1_UPDATE_RESTART_PENDING',
						'P1 retry 前发现更新标记且端口已监听；不会并行启动服务。',
						{ attempt: attempt - 1, reason: 'update-restart-pending', retryable: false, probe: retryProbe },
					)
					: _ensureFailure(
						'service-unhealthy',
						'E_P1_SERVICE_UNHEALTHY',
						'P1 retry 前端口已监听；无法证明该进程属于本轮，不会并行启动服务。',
						{ attempt: attempt - 1, reason: 'port-listening-before-retry', retryable: false, probe: retryProbe },
					)
			} else if (retryUpdateRestartRequired && !updateRestartRequired) {
				blocked = _ensureFailure(
					'update-restart-pending',
					'E_P1_UPDATE_RESTART_PENDING',
					'P1 retry 前出现新的更新重启标记；本轮不会继续启动。',
					{ attempt: attempt - 1, reason: 'update-restart-pending', retryable: false, probe: retryProbe },
				)
			}
			if (blocked) {
				console.warn(`[shells:p1] P1 自动启动 retry 已终止 (attempt=${blocked.attempt}/${blocked.maxAttempts}, reason=${blocked.reason}, retryable=${blocked.retryable}): ${blocked.error}`)
				return completeStartRound(blocked)
			}
			updateRestartRequired = retryUpdateRestartRequired
		}

		if (_hostShutdownStarted) return completeStartRound(_shuttingDownFailure(attempt - 1))
		let spawned
		try {
			spawned = await _spawnServiceProcess()
			_serviceOwnership = {
				pid: Number(spawned.pid),
				owner: spawned.owner,
				startedAt: Date.now(),
				confirmed: false,
			}
		} catch (error) {
			if (Number.isInteger(Number(error?.pid)) && Number(error.pid) > 0) {
				_serviceOwnership = {
					pid: Number(error.pid),
					owner: error.owner || 'spawn-uncertain',
					startedAt: Date.now(),
					confirmed: false,
				}
			}
			if (_hostShutdownStarted) return completeStartRound(_shuttingDownFailure(attempt))
			const reason = error?.reason === 'spawn-not-created' ? 'spawn-not-created' : 'spawn-uncertain'
			const retryBlockedBy = updateRestartRequired ? 'update-restart-marker' : null
			const retryable = reason === 'spawn-not-created' && error?.retryable === true
				&& !retryBlockedBy && attempt < MAX_START_ATTEMPTS
			const message = `自动启动 P1 服务失败（${error?.message || error}）`
			if (retryable) {
				console.warn(`[shells:p1] ${message}；准备内部 retry (attempt=${attempt}/${MAX_START_ATTEMPTS}, reason=${reason}, retryable=true)`)
				continue
			}
			const failed = _ensureFailure('spawn-failed', 'E_P1_SPAWN_FAILED', message, {
				attempt,
				reason,
				retryable: false,
				retryExhausted: reason === 'spawn-not-created' && error?.retryable === true
					&& !retryBlockedBy && attempt >= MAX_START_ATTEMPTS,
				...(retryBlockedBy ? { retryBlockedBy } : {}),
				...(error?.bootstrapDiagnostic ? {
					bootstrapDiagnostic: error.bootstrapDiagnostic,
					bootstrapExitCode: error.bootstrapExitCode,
				} : {}),
				...(error?.pid ? { pid: Number(error.pid), owner: error.owner } : {}),
			})
			console.warn(`[shells:p1] ${message} (attempt=${failed.attempt}/${failed.maxAttempts}, reason=${failed.reason}, retryable=${failed.retryable})——手动启动: cd ${SERVICE_DIR} && python p1_server.py`)
			return completeStartRound(failed)
		}

		const deadline = Date.now() + START_WAIT_MS
		while (Date.now() < deadline) {
			await _sleep(Math.min(START_POLL_MS, Math.max(1, deadline - Date.now())))
			const probe = await probeP1Service({ timeoutMs: Math.min(HEALTH_TIMEOUT_MS, START_POLL_MS) })
			if (!probe.liveness) continue
			const observedPid = _servicePidFromProbe(probe)
			if (observedPid !== _serviceOwnership?.pid) {
				const failed = _ensureFailure(
					'spawn-ownership-unconfirmed',
					'E_P1_SPAWN_OWNERSHIP_UNCONFIRMED',
					observedPid === null
						? 'P1 spawn 后 health 未返回 PID；不会认领或清除更新标记'
						: `P1 spawn PID ${_serviceOwnership?.pid} 与 health PID ${observedPid} 不一致；不会认领或清除更新标记`,
					{
						attempt, reason: 'ownership-unconfirmed', retryable: false,
						pid: _serviceOwnership?.pid, owner: _serviceOwnership?.owner, observedPid, probe,
					},
				)
				console.warn(`[shells:p1] P1 自动启动未确认 ownership (attempt=${attempt}/${MAX_START_ATTEMPTS}, reason=${failed.reason}, retryable=false): ${failed.error}`)
				return completeStartRound(failed)
			}
			_serviceOwnership.confirmed = true
			if (_hostShutdownStarted) return completeStartRound(_shuttingDownFailure(attempt))
			if (updateRestartRequired) await _clearUpdateRestartMarker()
			console.log(`[shells:p1] P1 服务已自动启动 (${P1_SERVICE_BASE}, pid=${spawned?.pid ?? '?'}, owner=${spawned?.owner ?? '?'}, attempt=${attempt}/${MAX_START_ATTEMPTS}, reason=spawned, retryable=false)`)
			return completeStartRound({
				liveness: true,
				readyForRecall: probe.readyForRecall,
				state: 'spawned', service: P1_SERVICE_BASE,
				pid: spawned?.pid, owner: spawned?.owner, probe,
				attempt, maxAttempts: MAX_START_ATTEMPTS, reason: 'spawned', retryable: false,
			})
		}

		if (_hostShutdownStarted) return completeStartRound(_shuttingDownFailure(attempt))
		const message = `P1 服务 spawn 后 ${START_WAIT_MS}ms 未就绪 (${P1_SERVICE_BASE})；日志: ${RUNTIME_ROOT}`
		const failed = _ensureFailure('spawned-not-ready', 'E_P1_START_TIMEOUT', message, {
			attempt, reason: 'start-timeout', retryable: false,
			pid: spawned?.pid, owner: spawned?.owner,
		})
		console.warn(`[shells:p1] ${message} (attempt=${attempt}/${MAX_START_ATTEMPTS}, reason=${failed.reason}, retryable=false)——查看 python 环境或手动启动: python ${SERVICE_DIR}p1_server.py`)
		return completeStartRound(failed)
	}
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
