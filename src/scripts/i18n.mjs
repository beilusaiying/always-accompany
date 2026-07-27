/**
 * i18n.mjs — per-user 本地化层（0722 启动大环解环：console/本机 locale 核已拆到 i18n_core.mjs）。
 *
 * 【分层约定】本文件=需要用户态的部分（用户 locale 偏好=auth、parts 语言包缓存=setting_loader、
 *   热更广播=event_dispatcher），允许上钻这些模块；i18n_core.mjs=零项目依赖叶子（console/查值/缓存），
 *   禁止上钻。启动环成员（server/auth/jobs/event_dispatcher/parts_loader/monitor 等）只准 import
 *   i18n_core，不准 import 本文件——否则大环复活（tests/check_import_cycles.mjs 守卫）。
 * 【兼容面】本文件 `export *` 转发 i18n_core 全部导出：环外既有消费方 import 面零变化。
 */
import fs from "node:fs";

import { getUserByUsername } from "../yonban/core/functions/security/auth.mjs";
import { __dirname } from "../server/base.mjs";
import { events } from "../server/events.mjs";
import { loadData, loadTempData, saveData } from "../server/setting_loader.mjs";
import { sendEventToAll } from "../server/web_server/event_dispatcher.mjs";

import {
  console,
  getbestlocale,
  getLocaleData,
  clearLocaleCache,
  refreshLocalhostLocaleData,
  baseGeti18n,
} from "./i18n_core.mjs";

// 核心层（console/geti18n/本机 locale/alert 系）全量转发——外部 import 面不变。
export * from "./i18n_core.mjs";

/**
 * @typedef {import('../decl/locale_data.ts').LocaleData} LocaleData
 * @typedef {import('../decl/locale_data.ts').LocaleKey} LocaleKey
 */

/**
 * 获取用户的区域设置数据。
 * @param {string} username - 用户的用户名。
 * @param {string[]} preferredlocaleList - 首选区域设置的列表。
 * @returns {Promise<LocaleData>} 一个解析为区域设置数据的承诺。
 */
export async function getLocaleDataForUser(username, preferredlocaleList) {
  const result = {
    ...getLocaleData([
      ...(preferredlocaleList ?? []),
      ...(getUserByUsername(username)?.locales ?? []),
    ]),
  };
  const partsLocaleLists = loadData(username, "parts_locale_lists_cache");
  const partsLocaleCache = loadData(username, "parts_locales_cache");
  const partsLocaleLoaders = loadTempData(username, "parts_locale_loaders");
  for (const partpath in partsLocaleLists) {
    const resultLocale = getbestlocale(
      preferredlocaleList,
      partsLocaleLists[partpath],
    );
    partsLocaleCache[partpath] ??= {};
    const partdata = (partsLocaleCache[partpath][resultLocale] ??=
      await partsLocaleLoaders[partpath]?.(resultLocale));
    Object.assign(result, partdata);
  }
  saveData(username, "parts_locales_cache");
  return result;
}
events.on("part-loaded", ({ username, partpath }) => {
  delete loadData(username, "parts_locales_cache")?.[partpath];
});
events.on("part-uninstalled", ({ username, partpath }) => {
  delete loadData(username, "parts_locales_cache")?.[partpath];
  saveData(username, "parts_locales_cache");
  delete loadData(username, "parts_locale_lists_cache")?.[partpath];
  saveData(username, "parts_locale_lists_cache");
  delete loadTempData(username, "parts_locale_loaders")?.[partpath];
});

fs.watch(`${__dirname}/src/public/locales`, (event, filename) => {
  if (!filename?.endsWith(".json")) return;
  const locale = filename.slice(0, -5);
  console.log(`Detected change in ${filename}.`);

  // 清除已更改文件的缓存（如果存在）——缓存本体在 i18n_core，经回调保单源
  if (!clearLocaleCache(locale)) return;
  refreshLocalhostLocaleData();
  sendEventToAll("locale-updated", null);
});

/**
 * 为部件添加区域设置数据。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径（例如 'chars/GentianAphrodite'）。
 * @param {string[]} localeList - 部件的可用区域设置列表。
 * @param {Function} loader - 加载部件区域设置数据的函数。
 * @returns {void}
 */
export function addPartLocaleData(username, partpath, localeList, loader) {
  const normalizedPartpath = partpath.replace(/^\/+|\/+$/g, "");
  const partsLocaleLists = loadData(username, "parts_locale_lists_cache");
  const partsLocaleLoaders = loadTempData(username, "parts_locale_loaders");
  partsLocaleLists[normalizedPartpath] = localeList;
  partsLocaleLoaders[normalizedPartpath] = loader;
  saveData(username, "parts_locale_lists_cache");
}

/**
 * 根据用户名和翻译键获取翻译后的文本。
 * @param {string} username - 用户名。
 * @param {LocaleKey} key - 翻译键。
 * @param {object} [params] - 可选的参数，用于插值。
 * @returns {string} - 翻译后的文本。
 */
export async function geti18nForUser(username, key, params = {}) {
  return baseGeti18n(await getLocaleDataForUser(username), key, params);
}
