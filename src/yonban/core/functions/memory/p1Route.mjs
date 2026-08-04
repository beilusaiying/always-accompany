/**
 * P1 运行路由的单一互斥契约。
 *
 * 只允许三种有效状态：
 *   10 = 自驱动召回
 *   01 = AI P1
 *   00 = 本轮不自动运行 P1
 *
 * 历史配置可能含 11 或只写了一个字段。读取时按明确规则收敛：
 *   11 -> 10；00 原样保留；单字段 true 会取得路由所有权并关闭另一条。
 * 写入时只拒绝显式 11，允许用户把两条路都关闭。
 */

function _hasBoolean(config, key) {
  return typeof config?.[key] === "boolean";
}

export function normalizeP1RouteConfig(config = {}) {
  const selfDriven = config.selfDriven === true;
  const aiP1 = !selfDriven && config.aiP1 === true; // legacy 11 -> 10
  return {
    ...config,
    selfDriven,
    aiP1,
  };
}

export function resolveEffectiveP1RouteConfig(declaredConfig = {}, overrideConfig = null) {
  const declaredRoute = normalizeP1RouteConfig(declaredConfig);
  const hasOverrideSelfDriven = _hasBoolean(overrideConfig, "selfDriven");
  const hasOverrideAiP1 = _hasBoolean(overrideConfig, "aiP1");
  let effectiveRoute = declaredRoute;

  if (hasOverrideSelfDriven && hasOverrideAiP1) {
    effectiveRoute = normalizeP1RouteConfig(overrideConfig);
  } else if (hasOverrideSelfDriven) {
    effectiveRoute = overrideConfig.selfDriven
      ? { selfDriven: true, aiP1: false }
      : { selfDriven: false, aiP1: declaredRoute.aiP1 };
  } else if (hasOverrideAiP1) {
    effectiveRoute = overrideConfig.aiP1
      ? { selfDriven: false, aiP1: true }
      : { selfDriven: declaredRoute.selfDriven, aiP1: false };
  }

  return {
    ...declaredConfig,
    ...(overrideConfig && typeof overrideConfig === "object" ? overrideConfig : {}),
    selfDriven: effectiveRoute.selfDriven,
    aiP1: effectiveRoute.aiP1,
  };
}

export function resolveP1RouteUpdate(update = {}, currentConfig = {}) {
  const hasSelfDriven = Object.prototype.hasOwnProperty.call(update, "selfDriven");
  const hasAiP1 = Object.prototype.hasOwnProperty.call(update, "aiP1");

  if (!hasSelfDriven && !hasAiP1) {
    return { ok: false, code: "E_P1_ROUTE_MISSING", error: "必须选择自驱动召回或 AI P1" };
  }
  if ((hasSelfDriven && typeof update.selfDriven !== "boolean")
    || (hasAiP1 && typeof update.aiP1 !== "boolean")) {
    return { ok: false, code: "E_P1_ROUTE_TYPE", error: "P1 路由值必须是 boolean" };
  }
  if (hasSelfDriven && hasAiP1 && update.selfDriven === true && update.aiP1 === true) {
    return { ok: false, code: "E_P1_ROUTE_NOT_EXCLUSIVE", error: "自驱动召回与 AI P1 不能同时开启" };
  }

  const current = normalizeP1RouteConfig(currentConfig);
  let selfDriven = hasSelfDriven ? update.selfDriven : current.selfDriven;
  let aiP1 = hasAiP1 ? update.aiP1 : current.aiP1;
  if (hasSelfDriven && update.selfDriven === true) aiP1 = false;
  if (hasAiP1 && update.aiP1 === true) selfDriven = false;
  return {
    ok: true,
    config: {
      selfDriven,
      aiP1,
    },
  };
}
