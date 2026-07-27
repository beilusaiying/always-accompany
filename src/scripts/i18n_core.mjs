/**
 * i18n_core.mjs — 本地化核心叶子（0722 启动大环解环拆出）。
 *
 * 【为什么拆】原 i18n.mjs 同时是「全仓 console 单源」（fan-in 25+，含启动环内 server/auth/jobs/
 *   event_dispatcher/parts_loader）和「per-user 本地化」（上钻 import auth/setting_loader/
 *   event_dispatcher）——ambient 服务住在高层模块里，把 11 成员启动环焊死。本文件只收
 *   【零项目依赖可成立】的部分：console + 本机 locale + 翻译查值。per-user 层留在 i18n.mjs
 *   （re-export 本文件，外部消费面不变）。
 * 【铁律】本文件禁止 import 任何 server/yonban 模块（只允许 base/json_loader 叶子与 npm/node 内建），
 *   新增依赖前先跑 tests/check_import_cycles.mjs。
 * 【功能链】所有后端模块 import { console } → 本文件；i18n.mjs（per-user 层）→ 本文件（查值/缓存）；
 *   locales 热更 watcher 在 i18n.mjs，经 clearLocaleCache/refreshLocalhostLocaleData 回调本文件缓存。
 */
import fs from "node:fs";
import process from "node:process";

import { exec } from "npm:@steve02081504/exec";
import { console as baseConsole } from "npm:@steve02081504/virtual-console";

import { __dirname } from "../server/base.mjs";

import { loadJsonFile } from "./json_loader.mjs";

/**
 * @typedef {import('../decl/locale_data.ts').LocaleData} LocaleData
 * @typedef {import('../decl/locale_data.ts').LocaleKey} LocaleKey
 */

const console = baseConsole;

/**
 * 所有可用区域设置的列表。
 * @type {{id: string, name: string}[]}
 */
export const beiluLocaleList = fs
  .readFileSync(__dirname + "/src/public/locales/list.csv", "utf8")
  .trim()
  .split("\n")
  .slice(1) // Skip header
  .map((line) => {
    const [id, ...nameParts] = line.split(",");
    return { id: id.trim(), name: nameParts.join(",").trim() };
  })
  .filter((locale) => locale.id);

/**
 * 从首选区域设置列表中获取最佳匹配的区域设置。
 * @param {string[]} preferredlocaleList - 首选区域设置的列表。
 * @param {{id: string}[]} localeList - 可用区域设置的列表。
 * @returns {string} 最佳匹配的区域设置。
 */
export function getbestlocale(preferredlocaleList, localeList) {
  const available = new Set(localeList.map((l) => l?.id ?? l).filter(Boolean));

  for (const preferred of preferredlocaleList ?? []) {
    // 1. 完全匹配
    if (available.has(preferred)) return preferred;

    // 2. 部分匹配 (例如, 'en' 来自 'en-US')
    const prefix = preferred.split("-")[0];
    for (const locale of available)
      if (locale.startsWith(prefix)) return locale;
  }

  return "en-UK"; // 默认
}

const beiluLocaleCache = {};

/**
 * 清除指定 locale 的缓存（locales 热更 watcher 用，watcher 在 i18n.mjs）。
 * @param {string} locale
 * @returns {boolean} 该 locale 此前是否有缓存。
 */
export function clearLocaleCache(locale) {
  if (!beiluLocaleCache[locale]) return false;
  delete beiluLocaleCache[locale];
  return true;
}

/**
 * 获取区域设置数据。
 * @param {string[]} localeList - 区域设置列表。
 * @returns {LocaleData} 区域设置数据。
 */
export function getLocaleData(localeList) {
  const resultLocale = getbestlocale(localeList, beiluLocaleList);
  return (
    beiluLocaleCache[resultLocale] ??
    loadJsonFile(__dirname + `/src/public/locales/${resultLocale}.json`)
  );
}

/**
 * 本地主机上所有可用区域设置的列表。
 * @type {string[]}
 */
export const localhostLocales = [
  ...new Set(
    [
      ...[
        process.env.LANG,
        process.env.LANGUAGE,
        process.env.LC_ALL,
        await exec("locale -uU")
          .then((r) => r.stdout.trim())
          .catch(() => undefined),
      ]
        .filter(Boolean)
        .map((locale) => locale.split(".")[0].replace("_", "-")),
      ...(navigator.languages || [navigator.language]),
      "en-UK",
    ].filter(Boolean),
  ),
];
/**
 * 本地主机的区域设置数据。
 * @type {LocaleData}
 */
export let localhostLocaleData = getLocaleData(localhostLocales);

/** locales 热更后刷新本机数据（watcher 在 i18n.mjs，经此回调保 live binding 单源）。 */
export function refreshLocalhostLocaleData() {
  localhostLocaleData = getLocaleData(localhostLocales);
}

/**
 * 从对象中获取嵌套值。
 * @param {object} obj - 要从中获取值的对象。
 * @param {string} key - 要获取的值的键。
 * @returns {any} 键的值，如果键不存在则为 undefined。
 */
function getNestedValue(obj, key) {
  const keys = key.split(".");
  let value = obj;
  for (const k of keys)
    if (value && value instanceof Object && k in value) value = value[k];
    else return undefined;

  return value;
}

/**
 * 获取区域设置数据中的翻译文本（i18n.mjs per-user 层复用）。
 * @param {LocaleData} localeData - 区域设置数据。
 * @param {LocaleKey} key - 翻译键。
 * @param {object} [params] - 可选的参数，用于插值（例如 {name: "John"}）。
 * @returns {string} - 翻译后的文本。
 */
export function baseGeti18n(localeData, key, params = {}) {
  let translation = getNestedValue(localeData, key);
  if (translation === undefined)
    console.warn(`Translation key "${key}" not found.`);
  for (const param in params)
    translation = translation?.replaceAll?.(`\${${param}}`, params[param]);
  return translation;
}

/**
 * 根据首选区域设置列表和翻译键获取翻译后的文本。
 * @param {string[]} localeList - 区域设置列表。
 * @param {LocaleKey} key - 翻译键。
 * @param {object} [params] - 可选的参数，用于插值。
 * @returns {string} - 翻译后的文本。
 */
export function geti18nForLocales(localeList, key, params = {}) {
  return baseGeti18n(getLocaleData(localeList), key, params);
}

/**
 * 根据提供的键（key）获取翻译后的文本（本机 locale）。
 * @param {LocaleKey} key - 翻译键。
 * @param {object} [params] - 可选的参数，用于插值。
 * @returns {string} - 翻译后的文本，如果未找到则返回键本身。
 */
export function geti18n(key, params = {}) {
  return baseGeti18n(localhostLocaleData, key, params);
}

/** 使用 i18n 打印参考消息。 */
console.infoI18n = (key, params = {}) => console.info(geti18n(key, params));
/** 使用 i18n 打印日志消息。 */
console.logI18n = (key, params = {}) => console.log(geti18n(key, params));
/** 使用 i18n 打印警告消息。 */
console.warnI18n = (key, params = {}) => console.warn(geti18n(key, params));
/** 使用 i18n 打印错误消息。 */
console.errorI18n = (key, params = {}) => console.error(geti18n(key, params));
/** 使用 i18n 在新行上打印消息。 */
console.freshLineI18n = (id, key, params = {}) =>
  console.freshLine(id, geti18n(key, params));

/** 使用 i18n 显示警报。 */
export function alertI18n(key, params = {}) {
  return alert(geti18n(key, params));
}
/** 使用 i18n 显示提示。 */
export function promptI18n(key, params = {}) {
  return prompt(geti18n(key, params));
}
/** 使用 i18n 显示确认。 */
export function confirmI18n(key, params = {}) {
  return confirm(geti18n(key, params));
}
/**
 * 导出的控制台对象。
 * @type {Console}
 */
export { console };
