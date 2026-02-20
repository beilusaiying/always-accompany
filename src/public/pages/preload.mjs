document.documentElement.dataset.theme = localStorage.getItem('theme') || (
	window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
)

// 字体大小防闪烁：在渲染前应用 font-size class 到 <html>
const _fs = localStorage.getItem('beilu-font-size')
if (_fs && _fs !== 'medium') {
	document.documentElement.classList.add(`font-size-${_fs}`)
}
