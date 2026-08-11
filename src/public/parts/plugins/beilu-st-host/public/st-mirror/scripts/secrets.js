/**
 * [beilu-st-host · st-mirror shim] scripts/secrets.js —— 酒馆密钥存储落点（P2，二期）。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.3）】
 *   secrets 等 → 少量插件（读写 API key 等敏感值）。
 *
 * 【一期策略】P2：密钥体系需对接 beilu 的凭证存储（/backends、secrets 端点），属二期路由映射表工作。
 *   一期一律抛错 stub（红线2 可见）；SECRET_KEYS 是常量枚举照给防 undefined。
 */

/** ST 密钥键枚举（常量表，照给防 undefined）。一期不接真实存储。 */
export const SECRET_KEYS = Object.freeze({})

/** 读密钥（P2 stub）。 */
export function readSecretState(...args) {
	throw new Error('[beilu宿主] readSecretState 尚未实现（一期 P2 stub）。密钥体系属二期（对接 beilu 凭证存储）。')
}

/** 写密钥（P2 stub）。 */
export function writeSecret(...args) {
	throw new Error('[beilu宿主] writeSecret 尚未实现（一期 P2 stub）。密钥体系属二期。')
}

/** 查密钥存在（P2 stub）。 */
export function findSecret(...args) {
	throw new Error('[beilu宿主] findSecret 尚未实现（一期 P2 stub）。密钥体系属二期。')
}
