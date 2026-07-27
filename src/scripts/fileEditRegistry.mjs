/**
 * fileEditRegistry.mjs — 多开同文件「主动停止 + 激活」单源注册表（81 细案）
 *
 * 跨插件单源：beilu-files（<file_op>）与 beilu-memory/ideClient（<ideToolCall>）均 import 此处，
 * 维护「文件绝对路径 → 正在编辑该文件的 chatid 集合」。写同一文件前停其他窗口在飞生成、写完后激活其重读续。
 *
 * 不新建中断/激活基建——停止复用 StreamManager.abortAll + cancelAutoContinue，激活复用 dispatchActivation wake，
 * 全部经动态 import（同 dispatchActivation 动态 import generation 的既有跨 part 范式），避免静态循环依赖。
 * 任何跨 part 调用失败都不抛给写路径（被动重读 _externalChanges 兜底正确性）。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const TTL_MS = 10 * 60 * 1000; // 编辑者活跃窗：10 分钟无触碰即视为离开该文件
const ACTIVATE_COOLDOWN_MS = 30 * 1000; // 同 (文件,目标窗口) 激活冷却，防 A↔B 互激活风暴

/** @type {Map<string, Map<string, number>>} 归一路径 → (chatid → lastTouchMs) */
const _editors = new Map();
/** @type {Map<string, number>} `${normPath}\u0000${chatid}` → 上次激活该窗口的时刻 */
const _activateCooldown = new Map();

/** 路径归一（与 beilu-files validateOpSecurity 同范式：斜杠+小写+去尾斜杠）。绝对 canonical 路径天然区分跨根同名文件。 */
function _norm(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/** 读/写文件即登记当前窗口为该文件编辑者（带时间戳）。 */
export function touch(canonicalPath, chatid) {
  if (!canonicalPath || !chatid) return;
  const key = _norm(canonicalPath);
  let m = _editors.get(key);
  if (!m) {
    m = new Map();
    _editors.set(key, m);
  }
  m.set(chatid, Date.now());
}

/** 会话关闭时清理其全部编辑者登记（防注册表泄漏 + 停/激活已关窗口）。 */
export function unregisterChat(chatid) {
  if (!chatid) return;
  for (const [key, m] of _editors) {
    m.delete(chatid);
    if (m.size === 0) _editors.delete(key);
  }
  // 与 _editors 对称清理 _activateCooldown（键尾 = `\u0000${chatid}`），防该 chatid 冷却键单调泄漏。
  const _suffix = "\u0000" + chatid;
  for (const ck of _activateCooldown.keys()) {
    if (ck.endsWith(_suffix)) _activateCooldown.delete(ck);
  }
}

/** 返回该文件上「非自己且未过 TTL」的其他编辑者 chatid（顺带剪枝过期项）。 */
export function othersEditing(canonicalPath, selfChatid) {
  const key = _norm(canonicalPath);
  const m = _editors.get(key);
  if (!m) return [];
  const now = Date.now();
  const out = [];
  for (const [cid, ts] of m) {
    if (now - ts > TTL_MS) {
      m.delete(cid);
      continue;
    }
    if (cid === selfChatid) continue;
    out.push(cid);
  }
  if (m.size === 0) _editors.delete(key);
  return out;
}

/** 解析 beilu-chat lib（broadcast/generation）模块（动态 import，跨 part）。 */
async function _loadChatLib(file) {
  const here = import.meta.dirname; // .../src/scripts
  const p = path.join(here, "../public/parts/shells/beilu-chat/src/lib/", file);
  return import(pathToFileURL(p).href);
}

/**
 * 写前：停其他窗口对同文件的【在飞生成】（StreamManager.abortAll 对没在生成的窗口是 no-op）+ 取消其自动继续。
 * **返回"实际被打断"的 chatid[]**——被打断 = 有在飞流被中止（aborted>0）**或** 有 pending 自动续轮
 * timer 被清（[0724 只许前端关] 补偿修：处于续轮延迟窗的窗口 aborted=0，原判据把它漏出唤醒名单
 * = 本函数把邻窗自动继续/Loop 无补偿静默杀死——自动化只允许前端开关关闭，系统打断必须配对唤回）。
 * 闲置且无 timer 的窗口不算被停，不空唤（满足 §五"无 stale 不空唤" + 收敛成环）。
 * 失败不抛（写路径不受影响）。
 */
export async function onWriteStart(canonicalPath, writerChatid) {
  const others = othersEditing(canonicalPath, writerChatid);
  if (others.length === 0) return [];
  const stopped = [];
  try {
    const [bcast, gen] = await Promise.all([
      _loadChatLib("broadcast.mjs"),
      _loadChatLib("generation.mjs"),
    ]);
    for (const cid of others) {
      let aborted = 0;
      let hadTimer = false; // cancel 前先探测，清掉后就取不到证据了
      try { hadTimer = !!gen.hasAutoContinueTimer?.(cid); } catch { /* 探测失败按无 timer */ }
      try { aborted = bcast.StreamManager?.abortAll?.(cid) || 0; } catch { /* 单窗口停失败不影响其他 */ }
      try { gen.cancelAutoContinue?.(cid); } catch { /* 同上 */ }
      if (aborted > 0 || hadTimer) stopped.push(cid); // 在飞流被中止 或 续轮 timer 被清=都算被打断，须唤回
    }
  } catch { /* 跨 part 加载失败 → 仅丢失「主动停止」，被动重读兜底正确性 */ }
  return stopped;
}

/**
 * 写后：只激活【本次写前真被打断的窗口】(stoppedChatids) 重读 + 续轮（dispatchActivation wake）。
 * 不传或空=不激活任何窗口（闲置/纯读过的窗口靠被动重读兜底，避免无谓 wake）。
 * 带 per-(文件,目标) 30s 冷却防 A↔B 互激活成环。失败不抛。返回实际被激活的 chatid[]。
 */
export async function onWriteComplete(canonicalPath, writerChatid, stoppedChatids) {
  const targets = Array.isArray(stoppedChatids) ? stoppedChatids : [];
  if (targets.length === 0) return [];
  const stillEditing = new Set(othersEditing(canonicalPath, writerChatid));
  const key = _norm(canonicalPath);
  const now = Date.now();
  // 顺带剪枝过期冷却项（与 _editors TTL 剪枝对称，防 _activateCooldown 单调泄漏）。
  for (const [ck, ts] of _activateCooldown) {
    if (now - ts > ACTIVATE_COOLDOWN_MS) _activateCooldown.delete(ck);
  }
  const woken = [];
  try {
    const here = import.meta.dirname;
    const dp = path.join(here, "../public/parts/plugins/beilu-memory/lib/tools/dispatchActivation.mjs");
    const { dispatchActivation } = await import(pathToFileURL(dp).href);
    for (const cid of targets) {
      if (cid === writerChatid || !stillEditing.has(cid)) continue; // 自己 / 已离开该文件的不唤
      const ck = `${key}\u0000${cid}`;
      if (now - (_activateCooldown.get(ck) || 0) < ACTIVATE_COOLDOWN_MS) continue; // 冷却内跳过，防成环
      _activateCooldown.set(ck, now);
      try {
        await dispatchActivation({ source: "event", action: { type: "wake", target: { chatid: cid } } });
        woken.push(cid);
      } catch { /* 单窗口激活失败不影响其他 */ }
    }
  } catch { /* 跨 part 加载失败 → 仅丢失「主动激活」，被动重读兜底（目标窗口下次操作自查 stale 重读）*/ }
  return woken;
}
