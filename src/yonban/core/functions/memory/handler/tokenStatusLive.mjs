/**
 * token 用量内存单源（per `${username}::${chatid}` 的最后一次完整估算）。
 *
 * 【why】token 用量的真口径只有一处——getPromptHandler 组装提示词时算出的
 * code_token_status（注入+chatLog，countTokensSync×安全余量；分母=resolveEffectiveMaxContextLive）。
 * 此前 replyHandler <contextClean> 闸门与 {{token_status}} 宏各自用 chatLog 字数/3.5
 * 原地重估（第二/第三估算器），注入占大头的 IDE 流程低估 50%+：前端进度条显示 90%
 * 而闸门按 37% 拒绝清理、宏引导全不触发（2026-08-11 实症，压缩流程整体卡死）。
 *
 * 【功能链】写方唯一 = getPromptHandler 算完 _codeTokenStatus 即存（同一次生成的提示词口径）；
 * 读方 = replyHandler contextClean 闸门（"产生本条回复的那份提示词有多大"，语义精确）
 *      + getPromptHandler {{token_status}} 宏（取上一轮值，误差=一轮增量，仍远优于漏掉全部注入）。
 *
 * 【约束】进程内存态，不落盘；服务重启后为空。读方必须容缺：缺值=放行/回退本地粗估，
 * 禁止拿缺值当 0 去拦截（低估导致的误拦正是本模块要根治的病）。
 */
const _lastTokenStatus = new Map(); // key: `${username}::${chatid}` → { used, limit, percentage, at }

export function setLastTokenStatus(username, chatid, status) {
  if (!username || !chatid || !status || !Number.isFinite(Number(status.used))) return;
  _lastTokenStatus.set(`${username}::${chatid}`, { ...status, at: Date.now() });
}

export function getLastTokenStatus(username, chatid) {
  if (!username || !chatid) return null;
  return _lastTokenStatus.get(`${username}::${chatid}`) || null;
}
