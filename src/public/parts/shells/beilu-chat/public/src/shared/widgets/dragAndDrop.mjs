/**
 * dragAndDrop.mjs — 输入区拖拽上传 + 粘贴上传支持
 *
 * 功能链：
 *   addDragAndDropSupport(element, selectedFiles, previewContainer)
 *   → 监听 element 上的 dragover / dragleave / drop / paste 事件
 *   → drop → handleFilesSelect（文件写入 selectedFiles + 预览区渲染）
 *   → paste → handlePaste（剪贴板图片/文件写入 selectedFiles + 预览区渲染）
 *
 * why：
 *   用户习惯直接拖拽文件或粘贴截图到输入框；
 *   统一封装到此模块，调用方（输入区初始化）只需一行 addDragAndDropSupport() 即可激活全部行为；
 *   dragover/dragleave 控制 .dragover 样式反馈，drop 时阻止默认行为（防止浏览器打开文件）。
 *
 * 关联链：
 *   ← index.mjs / input.mjs（addDragAndDropSupport 调用入口）
 *   → fileHandling.mjs（handleFilesSelect / handlePaste：实际文件处理逻辑）
 *   无后端请求，无 localStorage，无状态（纯事件绑定）。
 *
 * 影响范围：
 *   目标 element 的 dragover/dragleave/drop/paste 事件；
 *   写入调用方传入的 selectedFiles 数组；
 *   操作调用方传入的 attachmentPreviewContainer DOM。
 *
 * 使用效果：
 *   拖拽文件到聊天输入区 → 文件出现在附件预览区，等待发送；
 *   粘贴截图到输入区 → 同上处理。
 */
import { handleFilesSelect, handlePaste } from '../chat-core/fileHandling.mjs' // 6c尾·根级散件归位

/**
 * 添加拖拽上传支持函数
 * @param {HTMLElement} element - 监听拖拽事件的 DOM 元素。
 * @param {Array<File>} selectedFiles - 存储选定文件的数组。
 * @param {HTMLElement} attachmentPreviewContainer - 附件预览容器的 DOM 元素。
 */
// [0716 命中区扩大·凛倾「拖动导入文件,灵敏度不足…只有非常小的一块可以复制」] 载荷分域守卫：
//   绑定元素升级为大容器（#chat-container）后，本模块只认领【含 Files 的拖放】（OS 文件拖入）；
//   非文件拖（x-beilu-part 角色卡/文本选区拖动等）不 preventDefault/stopPropagation，
//   放行冒泡给 body 层既有消费者（chat.mjs x-beilu-part drop 链），两域互不抢。
//   types 在 dragover 阶段即可判（files 内容要到 drop 才可读，types 全程可读）。
function _hasFilePayload(event) {
	return Array.from(event.dataTransfer?.types || []).includes('Files')
}

export function addDragAndDropSupport(element, selectedFiles, attachmentPreviewContainer) {
	element.addEventListener('dragover', event => {
		if (!_hasFilePayload(event)) return
		event.preventDefault()
		event.stopPropagation()
		element.classList.add('dragover')
	})

	element.addEventListener('dragleave', () => {
		element.classList.remove('dragover')
	})

	element.addEventListener('drop', event => {
		if (!_hasFilePayload(event)) return
		event.preventDefault()
		event.stopPropagation()
		element.classList.remove('dragover')
		handleFilesSelect(event, selectedFiles, attachmentPreviewContainer)
	})

	element.addEventListener('paste', event => {
		handlePaste(event, selectedFiles, attachmentPreviewContainer)
	})
}
