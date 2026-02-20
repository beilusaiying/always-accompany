import { getUserList, login, register } from '../scripts/endpoints.mjs'
import { getAnyDefaultPart } from '../scripts/parts.mjs'
import { applyTheme, setTheme } from '../scripts/theme.mjs'
import { showToast } from '../scripts/toast.mjs'

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
function hideAllViews() {
	viewLoading.style.display = 'none'
	viewUserSelect.style.display = 'none'
	viewCreateUser.style.display = 'none'
	viewPasswordLogin.style.display = 'none'
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
	const redirect = urlParams.get('redirect')

	let finalRedirectUrl
	if (redirect) {
		finalRedirectUrl = decodeURIComponent(redirect)
	} else {
		try {
			const defaultShell = await getAnyDefaultPart('shells') || 'home'
			finalRedirectUrl = `/parts/shells:${defaultShell}`
		} catch {
			finalRedirectUrl = `/parts/shells:home`
		}
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
					<span class="text-lg">${user.username.charAt(0).toUpperCase()}</span>
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

/**
 * 转义 HTML 特殊字符。
 * @param {string} str - 原始字符串。
 * @returns {string} 转义后的字符串。
 */
function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str
	return div.innerHTML
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
		// 有密码用户，进入密码输入视图
		loginUsernameDisplay.textContent = user.username
		loginErrorMessage.textContent = ''
		loginPassword.value = ''
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
 */
async function loadUsers() {
	try {
		const data = await getUserList()
		users = data.users || []
	} catch (error) {
		console.error('Failed to load user list:', error)
		users = []
	}
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

	// 加载用户列表
	await loadUsers()

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

// 执行初始化
try {
	await initializeApp()
} catch (error) {
	showToast('error', error.message)
	console.error('App initialization error:', error)
}
