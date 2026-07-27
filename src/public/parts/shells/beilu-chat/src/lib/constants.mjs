/**
 * T012 操作标签名清单（本体/后端侧单源）。
 *
 * 三个集合语义不同，禁强行合一（合错=吞掉正常文字）：
 *   1. 显示剥离面（本清单 12 种）：AI 输出里操作性标记，所有显示面剥离。
 *      消费方：setDataActions cleanXmlTags（子集 6 种+「[已执行:x]」替换语义，手动清理历史工具）。
 *   2. 执行面全集（35+）：replyHandler._stripAllTags——生成链末步产干净 content_for_show 的权威单源，
 *      含指令类标签，与显示剥离面不是同一集合，不引用本清单。
 *   3. YonBan webview 副本：YonBan\webview-ui\chat-messages.js OPERATION_TAGS——浏览器/webview
 *      无法跨库 import 本文件，两库各自单源+注释互指；改标签清单时两处同步改。
 *
 * 分组=正则结构差异：paired 严格 <tag>；pairedLoose 开标签可带属性；selfClosing <tag .../>；
 * selfClosingQuoted 属性区容引号内字面 >；orphanClose 孤立闭合标签清理。
 */
export const OPERATION_TAG_NAMES = {
  paired: ["UpdateVariable", "tableEdit", "JSONPatch", "memoryArchive", "memorySearch", "memoryNote", "question", "search", "browse"],
  pairedLoose: ["file_op", "ideToolCall"],
  selfClosing: ["file_op", "toggle"],
  selfClosingQuoted: ["ideToolCall"],
  orphanClose: ["UpdateVariable", "tableEdit", "JSONPatch", "memoryArchive", "memorySearch", "memoryNote"],
};
