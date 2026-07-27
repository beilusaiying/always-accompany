/**
 * 安装 shell 的客户端逻辑。
 */
import { initTranslations, geti18n } from '../../scripts/i18n.mjs'
import { renderTemplate, usingTemplates } from '../../scripts/template.mjs'
import { applyTheme } from '../../scripts/theme.mjs'
import { showToast, showToastI18n } from '../../scripts/toast.mjs'

import { importFiles, importText } from './src/endpoints.mjs'

usingTemplates('/parts/shells:install/src/templates')
applyTheme()

const fileImportTab = document.getElementById('file-import-tab')
const textImportTab = document.getElementById('text-import-tab')
const fileImportContent = document.getElementById('file-import-content')
const textImportContent = document.getElementById('text-import-content')
const dropArea = document.getElementById('drop-area')
const fileList = document.getElementById('file-list')
const textInput = document.getElementById('text-input')
const importButton = document.getElementById('import-button')

let selectedFiles = []

// 切换标签页
fileImportTab.addEventListener('click', () => {
	fileImportTab.classList.add('tab-active')
	textImportTab.classList.remove('tab-active')
	fileImportContent.classList.remove('hidden')
	textImportContent.classList.add('hidden')
})

textImportTab.addEventListener('click', () => {
	textImportTab.classList.add('tab-active')
	fileImportTab.classList.remove('tab-active')
	textImportContent.classList.remove('hidden')
	fileImportContent.classList.add('hidden')
})

// 文件拖放处理
dropArea.addEventListener('dragover', event => {
	event.preventDefault()
	dropArea.classList.add('dragover')
})

dropArea.addEventListener('dragleave', () => {
	dropArea.classList.remove('dragover')
})

dropArea.addEventListener('drop', async event => {
	event.preventDefault()
	dropArea.classList.remove('dragover')
	await handleDroppedItems(event.dataTransfer.items)
})

// 点击选择文件
dropArea.addEventListener('click', () => {
	const input = document.createElement('input')
	input.type = 'file'
	input.multiple = true
	input.addEventListener('change', async event => {
		await handleFiles(event.target.files)
	})
	input.click()
})

/**
 * 处理拖放的项目。
 * @param {DataTransferItemList} items - 拖放的项目。
 * @returns {Promise<void>}
 */
async function handleDroppedItems(items) {
	const filesToProcess = []
	for (const item of items)
		filesToProcess.push(...await traverseFileSystemHandle(
			await item.getAsFileSystemHandle()
		))
	await handleFiles(filesToProcess)
}

/**
 * 遍历文件系统句柄。
 * @param {FileSystemHandle} handle - 文件系统句柄。
 * @returns {Promise<File[]>} - 文件数组。
 */
async function traverseFileSystemHandle(handle) {
	const files = []
	switch (handle?.kind) {
		case 'file':
			files.push(await handle.getFile())
			break
		case 'directory':
			for await (const entry of handle.values())
				files.push(...await traverseFileSystemHandle(entry))
			break
	}
	return files
}

/**
 * 处理文件。
 * @param {FileList} files - 文件列表。
 * @returns {Promise<void>}
 */
async function handleFiles(files) {
	for (const file of files)
		selectedFiles.push(file)
	await renderFileList()
}

/**
 * 渲染文件列表。
 * @returns {Promise<void>}
 */
async function renderFileList() {
	fileList.innerHTML = ''
	for (const file of selectedFiles) {
		const fileItem = await renderTemplate('import_file_item', { fileName: file.name })
		fileList.appendChild(fileItem)

		fileItem.querySelector('.remove-file-button').addEventListener('click', async () => {
			selectedFiles = selectedFiles.filter(f => f.name !== file.name)
			await renderFileList()
		})
	}
}

// 导入按钮点击事件
importButton.addEventListener('click', async () => {
	const isFileImport = !fileImportContent.classList.contains('hidden')
	try {
		const result = isFileImport
			? await handleFileImport()
			: await handleTextImport()

		showToastI18n('success', 'import.alerts.importSuccess')

		// consent 提醒：后端 ImportHandler（如 SillyTavern 角色卡）对含作者可控高优先级字段的外部导入
		// 打安全提醒标志，consentMessage 是后端已本地化的完整提示文本，导入成功后以 warning toast 展示，
		// 让用户知道导入内容会注入 AI 上下文、需来源可信（凛倾定"卡=外部导入给个提醒"）。
		if (result?.needsConsent && result.consentMessage)
			showToast('warning', result.consentMessage, 8000)
	}
	catch (error) {
		let errorMessage = error.message || geti18n('import.alerts.unknownError')
		if (error.errors)
			errorMessage += `\n${formatErrors(error.errors)}`

		showToastI18n('error', 'import.alerts.importFailed', { error: errorMessage })
	}
})


/**
 * 处理文件导入。
 * @returns {Promise<void>}
 */
async function handleFileImport() {
	if (!selectedFiles.length)
		throw new Error(geti18n('import.errors.noFileSelected'))

	const formData = new FormData()
	for (const file of selectedFiles)
		formData.append('files', file)

	const response = await importFiles(formData)

	const result = await response.json()
	if (!response.ok) {
		const error = new Error(geti18n('import.errors.fileImportFailed', { message: result.message || geti18n('import.errors.unknownError') }))
		error.errors = result.errors
		throw error
	}
	// 返回响应体，供主流程读取 needsConsent/consentMessage 展示安全提醒
	return result
}
/**
 * 处理文本导入。
 * @returns {Promise<void>}
 */
async function handleTextImport() {
	const text = textInput.value
	if (!text)
		throw new Error(geti18n('import.errors.noTextContent'))

	const response = await importText(text)

	const result = await response.json()
	if (!response.ok) {
		const error = new Error(geti18n('import.errors.textImportFailed', { message: result.message || geti18n('import.errors.unknownError') }))
		error.errors = result.errors
		throw error
	}
	// 返回响应体，供主流程读取 needsConsent/consentMessage 展示安全提醒
	return result
}

/**
 * 格式化错误。
 * @param {any[]} errors - 错误。
 * @returns {string} - 格式化的错误。
 */
function formatErrors(errors) {
	return errors.map(err => `${geti18n('import.errors.handler')}: ${err.handler}, ${geti18n('import.errors.error')}: ${err.error}`).join(';\n')
}

await initTranslations('import')
