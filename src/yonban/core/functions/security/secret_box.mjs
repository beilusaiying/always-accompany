/**
 * secret_box.mjs — at-rest 对称加密单一权威（N17：bot 密钥落盘加密）
 *
 * 背景：beilu 是可部署/多人/开源项目，bot token 等密钥此前明文落 bot_configs.json，
 *   磁盘/备份/data 泄漏即暴露。本模块提供透明字段级加解密原语，由 setting_loader 在
 *   bot_configs 的磁盘 I/O 边界调用（内存保持明文供 client.login，磁盘存密文）。
 *
 * 密钥（离线自启硬约束：不得依赖 operator 交互/必填 env）：
 *   env BEILU_BOT_SECRET（operator 可选，最强：密钥可离机/集中管理）
 *   else config.uuid（首启动 auth.mjs 自动 randomUUID 持久化，零 env 零交互）
 *   → scryptSync 派生 32B AES 密钥。seed 本身高熵(UUID/operator 秘密)，静态 salt 可接受。
 *
 * 算法：AES-256-GCM（认证加密，防篡改）。格式：`enc:v1:` + base64(iv(12) | tag(16) | ciphertext)。
 *
 * 容错（迁移/换钥不崩）：decryptSecret 对非 enc 前缀值原样返回（明文 passthrough=平滑迁移）；
 *   解密失败（换钥/损坏）记 console.error 并返回原值，绝不抛出中断 bot 加载。
 *
 * 链路：setting_loader 磁盘 I/O 边界 → encryptSecret(写盘) / decryptSecret(读盘)
 *        → 内存保持明文供 client.login，磁盘存密文
 * 影响：无磁盘副作用（加解密纯计算，由调用方负责 I/O）
 * 相交：← setting_loader(at-rest 加密) / 9 个 bot shell endpoints(maskBotConfig 脱敏，0716 删 kookbot)
 *         / gitHubIntegration
 *       → path_confine.mjs(readConfigFlag — 读 config.uuid 做密钥种子)
 */
import crypto from "node:crypto";

import { readConfigFlag } from "./path_confine.mjs";

const MARKER = "enc:v1:";
const _SALT = "beilu-bot-secret-v1";

let _key = null;
/**
 * 派生/缓存对称密钥。env BEILU_BOT_SECRET 优先，否则用首启动持久化的 config.uuid。
 * @returns {Buffer|null} 32B 密钥；无任何 seed（理论不应发生，uuid 恒被注入）时返回 null。
 */
function _getKey() {
  if (_key) return _key;
  const envSecret = globalThis?.process?.env?.BEILU_BOT_SECRET;
  const seed = (envSecret && String(envSecret)) || readConfigFlag("uuid") || "";
  if (!seed) return null;
  _key = crypto.scryptSync(String(seed), _SALT, 32);
  return _key;
}

/**
 * 加密明文密钥字段。空串/非字符串/已加密值 → 原样返回（幂等）。
 * @param {string} plain
 * @returns {string} `enc:v1:...` 或原值
 */
export function encryptSecret(plain) {
  if (typeof plain !== "string" || plain === "" || plain.startsWith(MARKER)) return plain;
  const key = _getKey();
  if (!key) return plain; // 无密钥种子：保持明文（不静默丢数据），由调用方/日志察觉
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * 解密密钥字段。非 `enc:v1:` 前缀 → 原样返回（明文 passthrough，迁移容错）。
 *   解密失败（换钥/损坏）→ console.error + 返回原值，不抛（不中断 bot 加载）。
 * @param {string} val
 * @returns {string} 明文或原值
 */
export function decryptSecret(val) {
  if (typeof val !== "string" || !val.startsWith(MARKER)) return val;
  const key = _getKey();
  if (!key) return val;
  try {
    const raw = Buffer.from(val.slice(MARKER.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (e) {
    try { console.error("[secret_box] 解密失败（密钥变更或数据损坏？），返回原值:", e?.message); } catch { /* ignore */ }
    return val;
  }
}

/** 判断一个值是否为本模块加密的密文。 */
export function isEncrypted(val) {
  return typeof val === "string" && val.startsWith(MARKER);
}

// ── bot 密钥字段(小写)单一权威白名单（setting_loader at-rest 加密 + 下方 B-3 读通道脱敏共用）──
//   标识符(appId/clientId/corpId/agentId/char/config…)不入此集——它们可能被别处当比较键/用作 key，不脱敏不加密。
export const BOT_SECRET_FIELDS = new Set([
  "token", "apptoken", "appsecret", "secret", "clientsecret", "encodingaeskey",
  "channelaccesstoken", "channelsecret", "accesstoken", "accesssecret", "appkey", "apitoken",
]);

const _MASK = "••••••••";
/** 是否为脱敏占位（前端回传时据此判定"未改"）。 */
export function isMask(v) { return v === _MASK; }

/**
 * N17 B-3：getbotconfig 回前端前脱敏——深克隆 config，密钥字段(非空串)值替换为掩码占位。
 *   保留磁盘/内存真值不变，只改回前端的副本。空串/非密钥字段原样。
 * @param {any} config
 * @returns {any}
 */
export function maskBotConfig(config) {
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && v !== "" && BOT_SECRET_FIELDS.has(k.toLowerCase())) out[k] = _MASK;
        else out[k] = walk(v);
      }
      return out;
    }
    return o;
  };
  return walk(config);
}

/**
 * N17 B-3：setbotconfig 合并前端回传——密钥字段若 === 掩码(用户没改) → 保留 existing 原值，
 *   否则用 incoming 新值。杜绝"前端回传掩码占位覆盖真 token"。
 * @param {any} incoming 前端回传的 config
 * @param {any} existing 当前存储的 config（真值）
 * @returns {any}
 */
export function unmaskBotConfig(incoming, existing) {
  const walk = (inc, ex) => {
    if (Array.isArray(inc)) return inc.map((v, i) => walk(v, Array.isArray(ex) ? ex[i] : undefined));
    if (inc && typeof inc === "object") {
      const out = {};
      for (const [k, v] of Object.entries(inc)) {
        const exV = (ex && typeof ex === "object") ? ex[k] : undefined;
        if (typeof v === "string" && v === _MASK && BOT_SECRET_FIELDS.has(k.toLowerCase())) out[k] = exV ?? "";
        else out[k] = walk(v, exV);
      }
      return out;
    }
    return inc;
  };
  return walk(incoming, existing);
}
