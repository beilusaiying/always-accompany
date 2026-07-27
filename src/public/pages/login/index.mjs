import { getUserList, login, register } from '../scripts/endpoints.mjs'
import { resolveDefaultShell } from '../scripts/parts.mjs'
import { applyTheme, setTheme } from '../scripts/theme.mjs'
import { showToast } from '../scripts/toast.mjs'
import { escapeHtml } from '../scripts/escapeHtml.mjs' // T7：pages HTML 转义唯一共享点（5 字符含单引号；原本地 textContent 法不转引号）

// --- DOM 元素 ---
const viewLoading = document.getElementById('view-loading')
const viewUserSelect = document.getElementById('view-user-select')
const viewCreateUser = document.getElementById('view-create-user')
const viewPasswordLogin = document.getElementById('view-password-login')

const userListContainer = document.getElementById('user-list')
const btnCreateNew = document.getElementById('btn-create-new')

const createUsername = document.getElementById('create-username')
const createPassword = document.getElementById('create-password')
const createConfirmPassword = document.getElementById('create-confirm-password')
const createPasswordGroup = document.getElementById('create-password-group')
const createConfirmPasswordGroup = document.getElementById('create-confirm-password-group')
const createErrorMessage = document.getElementById('create-error-message')
const btnCreateSubmit = document.getElementById('btn-create-submit')
const btnBackToSelect = document.getElementById('btn-back-to-select')

const loginPassword = document.getElementById('login-password')
const loginErrorMessage = document.getElementById('login-error-message')
const loginUsernameDisplay = document.getElementById('password-login-username-display')
const btnLoginSubmit = document.getElementById('btn-login-submit')
const btnBackFromLogin = document.getElementById('btn-back-from-login')

// --- 状态 ---
let users = []
let selectedUsername = ''

// --- 视图切换 ---

/**
 * 隐藏所有视图。
 */
const viewSecurityQuestions = document.getElementById('view-security-questions')
const sqUsernameDisplay = document.getElementById('sq-username-display')
const sqErrorMessage = document.getElementById('sq-error-message')
const sqQuestionsContainer = document.getElementById('sq-questions-container')
const sqNewPassword = document.getElementById('sq-new-password')
const sqConfirmPassword = document.getElementById('sq-confirm-password')
const btnForgotPassword = document.getElementById('btn-forgot-password')
const btnBackFromSq = document.getElementById('btn-back-from-sq')
const btnSqSubmit = document.getElementById('btn-sq-submit')

function hideAllViews() {
	viewLoading.style.display = 'none'
	viewUserSelect.style.display = 'none'
	viewCreateUser.style.display = 'none'
	viewPasswordLogin.style.display = 'none'
	if (viewSecurityQuestions) viewSecurityQuestions.style.display = 'none'
}

/**
 * 显示指定视图。
 * @param {HTMLElement} view - 要显示的视图元素。
 */
function showView(view) {
	hideAllViews()
	view.style.display = 'block'
}

// --- 设备 ID ---

/**
 * 获取或生成设备 ID。
 * @returns {string} 设备 ID。
 */
function getDeviceId() {
	let deviceId = localStorage.getItem('deviceId')
	if (!deviceId) {
		deviceId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
		localStorage.setItem('deviceId', deviceId)
	}
	return deviceId
}

// --- 登录成功后的跳转 ---

/**
 * 登录成功后跳转到默认 Shell。
 */
async function redirectAfterLogin() {
	const urlParams = new URLSearchParams(window.location.search)
	// URLSearchParams.get 已解码一次；redirect 由 authenticate 302 出口用 encodeURIComponent(originalUrl)
	//   编码（auth.mjs:authenticate），这里不再 decodeURIComponent（双解码会把原 URL 里 %2F 等还原过度）。
	// 开放重定向围栏：只接受同源路径 = 以单个 / 开头。以 / 开头的串不可能被解析成 scheme URL
	//   （scheme 必须以字母开头），故无需查 ':'——路径里的冒号是合法的（/parts/shells:beilu-chat）。
	//   拒 '//'（协议相对 URL）和 '/\'（浏览器把 \ 归一成 / → 等效 '//'，已知绕过面），拒后落默认壳。
	const redirect = urlParams.get('redirect')
	const safeRedirect = redirect && /^\/(?![/\\])/.test(redirect) ? redirect : null

	let finalRedirectUrl
	if (safeRedirect) {
		finalRedirectUrl = safeRedirect
	} else {
		// resolveDefaultShell 内部已处理废壳映射 + 空值/异常兜底（统一落 beilu-chat），
		// 不再在此拼历史废串 shells:home（该目录不存在，落入即死亡）。
		const defaultShell = await resolveDefaultShell()
		finalRedirectUrl = `/parts/shells:${defaultShell}`
	}

	window.location.href = finalRedirectUrl
}

// --- 渲染用户列表 ---

/**
 * 渲染用户卡片列表。
 */
function renderUserList() {
	userListContainer.innerHTML = ''

	for (const user of users) {
		const card = document.createElement('button')
		card.className = 'btn btn-outline btn-lg justify-start gap-3 w-full'
		card.innerHTML = `
			<div class="avatar placeholder">
				<div class="bg-neutral text-neutral-content rounded-full w-10">
					<span class="text-lg">${escapeHtml(user.username.charAt(0).toUpperCase())}</span>
				</div>
			</div>
			<div class="flex flex-col items-start">
				<span class="font-bold">${escapeHtml(user.username)}</span>
				<span class="text-xs opacity-60">${user.passwordless ? '无密码' : '需要密码'}</span>
			</div>
		`
		card.addEventListener('click', () => handleUserClick(user))
		userListContainer.appendChild(card)
	}
}

// --- 事件处理 ---

/**
 * 处理用户卡片点击。
 * @param {object} user - 用户信息对象。
 */
async function handleUserClick(user) {
	selectedUsername = user.username

	if (user.passwordless) {
		// 无密码用户，直接登录
		try {
			const deviceId = getDeviceId()
			const response = await login(user.username, '', deviceId)
			const data = await response.json()

			if (response.ok) {
				await redirectAfterLogin()
			} else {
				showToast('error', data.message || '登录失败')
			}
		} catch (error) {
			console.error('Login error:', error)
			showToast('error', '登录出错')
		}
	} else {
		loginUsernameDisplay.textContent = user.username
		loginErrorMessage.textContent = ''
		loginPassword.value = ''
		if (btnForgotPassword) btnForgotPassword.style.display = user.hasSecurityQuestions ? 'inline' : 'none'
		showView(viewPasswordLogin)
		loginPassword.focus()
	}
}

/**
 * 处理密码登录提交。
 */
async function handlePasswordLogin() {
	const password = loginPassword.value
	if (!password) {
		loginErrorMessage.textContent = '请输入密码'
		return
	}

	try {
		btnLoginSubmit.disabled = true
		const deviceId = getDeviceId()
		const response = await login(selectedUsername, password, deviceId)
		const data = await response.json()

		if (response.ok) {
			await redirectAfterLogin()
		} else {
			loginErrorMessage.textContent = data.message || '用户名或密码错误'
		}
	} catch (error) {
		console.error('Login error:', error)
		loginErrorMessage.textContent = '登录出错，请重试'
	} finally {
		btnLoginSubmit.disabled = false
	}
}

/**
 * 处理创建用户提交。
 */
async function handleCreateUser() {
	const username = createUsername.value.trim()
	if (!username) {
		createErrorMessage.textContent = '请输入用户名'
		return
	}

	const authMode = document.querySelector('input[name="auth-mode"]:checked').value
	let password = ''

	if (authMode === 'password') {
		password = createPassword.value
		const confirmPassword = createConfirmPassword.value

		if (!password) {
			createErrorMessage.textContent = '请输入密码'
			return
		}
		if (password.length < 4) {
			createErrorMessage.textContent = '密码至少需要4个字符'
			return
		}
		if (password !== confirmPassword) {
			createErrorMessage.textContent = '两次输入的密码不一致'
			return
		}
	}

	try {
		btnCreateSubmit.disabled = true
		createErrorMessage.textContent = ''

		// 1. 注册
		const regResponse = await register(username, password)
		const regData = await regResponse.json()

		if (!regResponse.ok) {
			createErrorMessage.textContent = regData.message || '注册失败'
			return
		}

		// 新用户标志：beilu-chat 首次进入据此自动打开「设置→语言」一次（凛倾 0716：只对新用户，出现一次）
		try { localStorage.setItem('beiluNewUser', '1') } catch { /* 存储不可用则跳过引导 */ }

		// 2. 自动登录
		const deviceId = getDeviceId()
		const loginResponse = await login(username, password, deviceId)
		const loginData = await loginResponse.json()

		if (loginResponse.ok) {
			await redirectAfterLogin()
		} else {
			// 注册成功但登录失败，提示用户手动登录
			createErrorMessage.textContent = '注册成功，但自动登录失败，请手动登录'
			await loadUsers()
			showView(viewUserSelect)
		}
	} catch (error) {
		console.error('Create user error:', error)
		createErrorMessage.textContent = '创建用户出错，请重试'
	} finally {
		btnCreateSubmit.disabled = false
	}
}

/**
 * 处理认证方式切换（无密码/有密码）。
 */
function handleAuthModeChange() {
	const authMode = document.querySelector('input[name="auth-mode"]:checked').value
	const showPassword = authMode === 'password'
	createPasswordGroup.style.display = showPassword ? 'block' : 'none'
	createConfirmPasswordGroup.style.display = showPassword ? 'block' : 'none'

	if (!showPassword) {
		createPassword.value = ''
		createConfirmPassword.value = ''
	}
}

// --- 数据加载 ---

/**
 * 从服务器加载用户列表。
 * @returns {Promise<boolean>} 加载成功=true;网络/服务失败=false(与"真无用户"严格区分)。
 * why(2026-07-20 全链审计):此前 catch 里 users=[],网络失败被当"没有用户"直接把老用户
 * 引进"创建新用户"流程——误导重复注册。失败必须呈现为失败+可重试,不是空列表。
 */
async function loadUsers() {
	try {
		const data = await getUserList()
		users = data.users || []
		return true
	} catch (error) {
		console.error('Failed to load user list:', error)
		users = []
		return false
	}
}

/**
 * 用户列表加载失败视图:错误说明+重试按钮(渲染进 user-list 容器,复用用户选择视图外框)。
 */
function renderLoadFailure() {
	userListContainer.innerHTML = ''
	const box = document.createElement('div')
	box.className = 'flex flex-col items-center gap-3 py-6'
	const msg = document.createElement('p')
	msg.className = 'text-error text-sm'
	msg.textContent = '用户列表加载失败（服务未就绪或网络问题），并非没有账号。'
	const btn = document.createElement('button')
	btn.className = 'btn btn-primary btn-sm'
	btn.textContent = '重试'
	btn.addEventListener('click', async () => {
		btn.disabled = true
		const ok = await loadUsers()
		btn.disabled = false
		if (!ok) return showToast('error', '仍然失败，请确认黑色窗口里的服务在运行')
		btnCreateNew.style.display = ''
		if (users.length === 0) { btnBackToSelect.style.display = 'none'; showView(viewCreateUser); createUsername.focus() }
		else { renderUserList(); showView(viewUserSelect) }
	})
	box.append(msg, btn)
	userListContainer.appendChild(box)
	btnCreateNew.style.display = 'none'
	showView(viewUserSelect)
}

// --- 初始化 ---

/**
 * 初始化应用。
 */
async function initializeApp() {
	// 主题设置
	localStorage.setItem('theme', localStorage.getItem('theme') || 'dark')
	applyTheme()
	const urlParams = new URLSearchParams(window.location.search)
	if (urlParams.get('theme')) setTheme(urlParams.get('theme'))

	// 加载用户列表(失败≠无用户:失败走重试视图,不进创建流程)
	const loaded = await loadUsers()
	if (!loaded) return renderLoadFailure()

	if (users.length === 0) {
		// 无用户，直接进入创建流程
		btnBackToSelect.style.display = 'none'
		showView(viewCreateUser)
		createUsername.focus()
	} else {
		// 有用户，显示用户选择
		renderUserList()
		showView(viewUserSelect)
	}
}

// --- 事件绑定 ---
btnCreateNew.addEventListener('click', () => {
	createErrorMessage.textContent = ''
	createUsername.value = ''
	createPassword.value = ''
	createConfirmPassword.value = ''
	// 重置为无密码模式
	document.querySelector('input[name="auth-mode"][value="passwordless"]').checked = true
	handleAuthModeChange()
	btnBackToSelect.style.display = 'inline-flex'
	showView(viewCreateUser)
	createUsername.focus()
})

btnBackToSelect.addEventListener('click', () => {
	showView(viewUserSelect)
})

btnBackFromLogin.addEventListener('click', () => {
	showView(viewUserSelect)
})

btnCreateSubmit.addEventListener('click', handleCreateUser)
btnLoginSubmit.addEventListener('click', handlePasswordLogin)

// 认证方式切换监听
document.querySelectorAll('input[name="auth-mode"]').forEach(radio => {
	radio.addEventListener('change', handleAuthModeChange)
})

// 回车提交
loginPassword.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') handlePasswordLogin()
})
createUsername.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		const authMode = document.querySelector('input[name="auth-mode"]:checked').value
		if (authMode === 'passwordless') {
			handleCreateUser()
		} else {
			createPassword.focus()
		}
	}
})
createConfirmPassword.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') handleCreateUser()
})

// --- 安全问题找回密码 ---

async function showSecurityQuestionsView() {
	if (!selectedUsername) return
	sqUsernameDisplay.textContent = selectedUsername
	sqErrorMessage.textContent = ''
	sqQuestionsContainer.innerHTML = '<p class="text-xs text-base-content/50">加载安全问题...</p>'
	sqNewPassword.value = ''
	sqConfirmPassword.value = ''
	showView(viewSecurityQuestions)
	try {
		const res = await fetch(`/api/users/security-questions/get/${encodeURIComponent(selectedUsername)}`)
		const data = await res.json()
		if (!data.success || !data.questions?.length) {
			sqErrorMessage.textContent = '该用户未设置安全问题'
			return
		}
		sqQuestionsContainer.innerHTML = data.questions.map((q, i) => `
			<div class="form-control">
				<label class="label"><span class="label-text text-xs">${escapeHtml(q.question)}</span></label>
				<input type="text" class="input input-bordered input-sm sq-answer" data-index="${i}" placeholder="输入答案" autocomplete="off" />
			</div>
		`).join('')
	} catch {
		sqErrorMessage.textContent = '加载安全问题失败'
	}
}

async function handleSecurityQuestionsSubmit() {
	const answerInputs = sqQuestionsContainer.querySelectorAll('.sq-answer')
	const answers = Array.from(answerInputs).map(el => el.value)
	const newPwd = sqNewPassword.value
	const confirmPwd = sqConfirmPassword.value
	if (answers.some(a => !a.trim())) { sqErrorMessage.textContent = '请回答所有安全问题'; return }
	if (!newPwd) { sqErrorMessage.textContent = '请输入新密码'; return }
	if (newPwd !== confirmPwd) { sqErrorMessage.textContent = '两次输入的新密码不一致'; return }
	try {
		btnSqSubmit.disabled = true
		const res = await fetch('/api/users/reset-password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: selectedUsername, answers, newPassword: newPwd }),
		})
		const data = await res.json()
		if (res.ok && data.success) {
			showToast('success', '密码重置成功，请使用新密码登录')
			loginPassword.value = ''
			loginErrorMessage.textContent = ''
			showView(viewPasswordLogin)
			loginPassword.focus()
		} else {
			sqErrorMessage.textContent = data.message || '重置失败'
		}
	} catch { sqErrorMessage.textContent = '请求失败' }
	finally { btnSqSubmit.disabled = false }
}

if (btnForgotPassword) btnForgotPassword.addEventListener('click', showSecurityQuestionsView)
if (btnBackFromSq) btnBackFromSq.addEventListener('click', () => { showView(viewPasswordLogin); loginPassword.focus() })
if (btnSqSubmit) btnSqSubmit.addEventListener('click', handleSecurityQuestionsSubmit)

// 执行初始化
try {
	await initializeApp()
} catch (error) {
	showToast('error', error.message)
	console.error('App initialization error:', error)
}
