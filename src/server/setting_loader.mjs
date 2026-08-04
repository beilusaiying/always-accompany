import fs from "node:fs";

import { on_shutdown } from "npm:on-shutdown";

import { loadJsonFile, saveJsonFile } from "../scripts/json_loader.mjs";

import { getUserDictionary } from "../yonban/core/functions/security/auth.mjs";
import { events } from "./events.mjs";
import { encryptSecret, decryptSecret, isEncrypted, BOT_SECRET_FIELDS } from "../yonban/core/functions/security/secret_box.mjs";

// N17: bot 密钥字段白名单单一权威在 secret_box.BOT_SECRET_FIELDS（at-rest 加密 + B-3 读通道脱敏共用）。
// 深克隆 + 对白名单字段名的 string 值应用 fn(加/解密)；其余原样。
function _transformBotSecrets(obj, fn) {
  if (Array.isArray(obj)) return obj.map((v) => _transformBotSecrets(v, fn));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && BOT_SECRET_FIELDS.has(k.toLowerCase())) out[k] = fn(v);
      else out[k] = _transformBotSecrets(v, fn);
    }
    return out;
  }
  return obj;
}
// 是否存在明文密钥(非空且非 enc 前缀)——用于首 load 主动迁移判定。
function _hasPlaintextBotSecret(obj) {
  if (Array.isArray(obj)) return obj.some((v) => _hasPlaintextBotSecret(v));
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && BOT_SECRET_FIELDS.has(k.toLowerCase())) {
        if (v !== "" && !isEncrypted(v)) return true;
      } else if (_hasPlaintextBotSecret(v)) return true;
    }
  }
  return false;
}

const userDataSet = {};

function _loadSettingsFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return loadJsonFile(filePath);
  } catch (cause) {
    const error = new Error(`无法读取设置文件: ${filePath}`, { cause });
    error.code = "E_SETTINGS_READ_FAILED";
    error.filePath = filePath;
    throw error;
  }
}

function _requireLoadedData(store, keys, filePath) {
  let current = store;
  for (const key of keys) current = current?.[key];
  if (current !== undefined) return current;
  const error = new Error(`拒绝保存尚未成功加载的设置文件: ${filePath}`);
  error.code = "E_SETTINGS_NOT_LOADED";
  error.filePath = filePath;
  throw error;
}
/**
 * 从 JSON 文件加载用户数据。
 * @param {string} username - 用户的用户名。
 * @param {string} dataname - 要加载的数据的名称。
 * @returns {object} 加载的数据。
 */
export function loadData(username, dataname) {
  userDataSet[username] ??= {};
  const cached = userDataSet[username][dataname];
  if (cached !== undefined) return cached;
  const filePath = getUserDictionary(username) + "/settings/" + dataname + ".json";
  const data = _loadSettingsFile(filePath);
  userDataSet[username][dataname] = data;
  return data;
}
/**
 * 将用户数据保存到 JSON 文件。
 * @param {string} username - 用户的用户名。
 * @param {string} dataname - 要保存的数据的名称。
 * @returns {void}
 */
export function saveData(username, dataname) {
  const settingsDir = getUserDictionary(username) + "/settings";
  const filePath = settingsDir + "/" + dataname + ".json";
  const data = _requireLoadedData(userDataSet, [username, dataname], filePath);
  fs.mkdirSync(settingsDir, { recursive: true });
  saveJsonFile(filePath, data);
}
on_shutdown(() => {
  for (const username in userDataSet)
    for (const dataname in userDataSet[username]) saveData(username, dataname);
});

/**
 * shelldata 用于存储特定于 shell 的数据。
 * @type {object}
 */
const userShellDataSet = {};
/**
 * 从 JSON 文件加载特定于 shell 的用户数据。
 * @param {string} username - 用户的用户名。
 * @param {string} shellname - shell 的名称。
 * @param {string} dataname - 要加载的数据的名称。
 * @returns {object} 加载的数据。
 */
export function loadShellData(username, shellname, dataname) {
  userShellDataSet[username] ??= {};
  userShellDataSet[username][shellname] ??= {};
  const cached = userShellDataSet[username][shellname][dataname];
  if (cached !== undefined && cached !== null) return cached;
  const filePath =
    getUserDictionary(username) + "/shells/" + shellname + "/" + dataname + ".json";
  let data = _loadSettingsFile(filePath);
  // N17: bot_configs 透明解密——磁盘密文→内存明文(供 client.login);明文值 passthrough(迁移容错)。
  if (dataname === "bot_configs" && data && typeof data === "object") {
    const hadPlaintext = _hasPlaintextBotSecret(data);
    data = _transformBotSecrets(data, decryptSecret);
    userShellDataSet[username][shellname][dataname] = data;
    // 首次发现明文密钥→立即重写为密文(主动迁移);内存已是明文,saveShellData 落盘时加密。
    if (hadPlaintext) {
      try { saveShellData(username, shellname, dataname); }
      catch (e) { console.error("[setting_loader] bot_configs 加密迁移失败:", e?.message); }
    }
    return data;
  }
  userShellDataSet[username][shellname][dataname] = data;
  return data;
}
/**
 * 将特定于 shell 的用户数据保存到 JSON 文件。
 * @param {string} username - 用户的用户名。
 * @param {string} shellname - shell 的名称。
 * @param {string} dataname - 要保存的数据的名称。
 * @returns {void}
 */
export function saveShellData(username, shellname, dataname) {
  const shellDir = getUserDictionary(username) + "/shells/" + shellname;
  const filePath = shellDir + "/" + dataname + ".json";
  let data = _requireLoadedData(userShellDataSet, [username, shellname, dataname], filePath);
  fs.mkdirSync(shellDir, {
    recursive: true,
  });
  // N17: bot_configs 落盘前加密(深克隆,不 mutate 内存明文缓存——bot.mjs 仍读明文 token)。
  if (dataname === "bot_configs" && data && typeof data === "object")
    data = _transformBotSecrets(data, encryptSecret);
  saveJsonFile(filePath, data);
}
on_shutdown(() => {
  for (const username in userShellDataSet)
    for (const shellname in userShellDataSet[username])
      for (const dataname in userShellDataSet[username][shellname])
        saveShellData(username, shellname, dataname);
});

/**
 * tempdata 用于临时数据存储。
 * @type {object}
 */
const userTempDataSet = {};
/**
 * 加载用户的临时数据。
 * @param {string} username - 用户的用户名。
 * @param {string} dataname - 要加载的数据的名称。
 * @returns {object} 加载的数据。
 */
export function loadTempData(username, dataname) {
  userTempDataSet[username] ??= {};
  return (userTempDataSet[username][dataname] ??= {});
}
// 无需保存 :)

// 事件处理程序
events.on("AfterUserDeleted", ({ username }) => {
  delete userDataSet[username];
  delete userShellDataSet[username];
  delete userTempDataSet[username];
});

events.on("AfterUserRenamed", ({ oldUsername, newUsername }) => {
  userDataSet[newUsername] = userDataSet[oldUsername] ?? {};
  delete userDataSet[oldUsername];
  userShellDataSet[newUsername] = userShellDataSet[oldUsername] ?? {};
  delete userShellDataSet[oldUsername];
  userTempDataSet[newUsername] = userTempDataSet[oldUsername] ?? {};
  delete userTempDataSet[oldUsername];
});
