/**
 * 获取文件。
 * @param {string} path - 文件路径。
 * @returns {Promise<ArrayBuffer>} - 文件内容。
 */
export async function getfile(path) {
	try {
		// R1-SKIP: 任意路径(含静态资源)的二进制读取(.arrayBuffer)，且 !ok 优雅退回 ArrayBuffer(0)；apiFetch 的 json 解析+401跳转不适用。
		const res = await fetch(path);
		if (!res.ok) {
			console.error(`[files] getfile failed: ${path} → ${res.status}`);
			window._reportError?.(`[files] getfile ${res.status}: ${path}`);
			return new ArrayBuffer(0);
		}
		return await res.arrayBuffer();
	} catch (err) {
		console.error('[files] getfile network error:', path, err);
		window._reportError?.(`[files] getfile error: ${path}: ${err.message}`, err.stack);
		return new ArrayBuffer(0);
	}
}
