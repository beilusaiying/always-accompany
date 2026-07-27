/**
 * entryKind.mjs — 数据类条目判据单一真源（0722 审计 J1-B 收口；0722 二迁：从 injectionSystem 抽出为纯叶子）
 *
 * 【为什么是独立叶子】storage.mjs（播种域）也要消费本判据，但 injectionSystem 顶层
 *   import ideClient → commandGate，而 commandGate 顶层立即调用 storage.getFilesSettingsPath()。
 *   storage → injectionSystem 的 import 会让 commandGate 在 storage 尚未初始化 __projectRoot 时
 *   执行 → TDZ ReferenceError（0722 全插件 load_failed 事故）。判据本体是零依赖纯函数，
 *   抽到本叶子：storage 与 injectionSystem 各自单向 import，环消除；injectionSystem re-export
 *   保持四消费方（getPromptHandler/getDataHandler/setDataActions/storage）原 import 面不断。
 *   本文件必须保持零 import——加任何依赖前先重推环。
 *
 * 【判据背景】`-data` 后缀条目分两类，此前四个消费机制各写判据（getPromptHandler 主循环 skip 只认
 *   dataDriven 字段 / textEntries 排除只认后缀 / storage 播种认两者之一 / 白名单剥 _N 后缀），
 *   契约只存在于口头=误标任一字段即漂移出静默半态。判据收进单一真源——增改判据只动这里。
 * 两类语义：
 *   ① dataDriven:true —— 数据生产点经 _pushDataInj 按需注入（模板宏由生产点供值），
 *      主循环必须跳过（否则未展开的 {{数据宏}} 原样进提示词）；
 *   ② 仅 -data 后缀无 dataDriven —— 宏引擎供值（{{tableData}}/{{browser_status}} 等 env/替换链宏），
 *      必须过主循环才能被求值，不得跳过。
 * !!!禁止放入提示词!!! 本模块只做识别，禁止产生任何进 messages 的文本。
 */

/** 类①判据：数据生产点驱动的条目（主循环 skip / _pushDataInj 消费） */
export function isDataDrivenEntry(entry) {
  return entry?.dataDriven === true;
}

/** 数据类条目总判据（类①∪类②）：-data 后缀语义域——textEntries 排除、播种域、代理易变区识别共用 */
export function isDataEntry(entry) {
  return isDataDrivenEntry(entry) || /-data$/.test(String(entry?.id || ""));
}
