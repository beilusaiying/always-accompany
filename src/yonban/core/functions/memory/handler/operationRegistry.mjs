/**
 * operationRegistry.mjs — ReplyHandler 可执行操作注册表 + 统一权限 admission（P0-B，2026-08-03）。
 *
 * 【功能链】
 *   AI 回复标签 → replyHandler 各解析段 → admitOperation(opId, ctx) 单一裁决
 *     → allowed → 该段既有执行体；denied → 可见拒绝（opLog blocked + wbD + _operation_denied
 *       pendingResult 回喂 AI），标签照剥不执行。
 *
 * 【why】
 *   旧状态（Fable 审查阻断4 + 分叉实例）：
 *   - Bot 档位门散落 9 个标签分支（modeSwitch/ideToolCall/question/delegate/parallelDelegate/
 *     clone/scheduleWakeup/wakeWindow/sendToWindow），tableEdit/memoryArchive/memoryNote/
 *     scheduleTask/captureControl/contextClean 等副作用入口完全未受控；
 *   - ModeDef features 只影响提示词（smart.json ide:false 但 replyHandler 照常执行 ideToolCall）
 *     ——声明面与执行面分叉；
 *   - Bot L3 数字直接等于宿主能力（host_control），身份不可证明。
 *   根因层=没有操作注册表：能力是散写 if，不是可枚举、可裁决、可审计的 operation。
 *
 * 【契约】
 *   - 注册表是唯一裁决数据源：replyHandler 不再新写裸档位 if；新增标签必须先登记再接执行体。
 *   - 未登记 opId → deny（fail-closed）。
 *   - requiredModeFeature：执行入口核 ModeDef 声明（modeFeature 同源镜像）——提示词教什么、
 *     执行放什么，同一张声明表（prompt feature 与 host gate 同源投影）。
 *     注册表预热未达（modeFeaturesReady()=false，启动最初数秒）→ 跳过该维度并 trace 留痕
 *     （诚实降级，不误拒正常回复；bot 档位/宿主门不依赖预热、恒生效）。
 *   - Bot 来源（ctx.botPerm 非空）：
 *     · hostControl 操作 → 必须 isOwner && hostControl（策略快照，源=config.HostControlEnabled
 *       owner-only 默认 false）&& level ≥ botMinimumLevel——L3 数字不再自动获得宿主能力；
 *       旧条目缺 _isOwner/_hostControl → 按 false 解析 = fail-closed。
 *     · 其余操作 → level ≥ botMinimumLevel。
 *   - 本地来源（botPerm=null）：仅 mode feature 维度裁决（本地用户权限体系走既有
 *     permission_level/审批门/规则集，不在本表重复建模）。
 *   - 被拒操作必须可见可审计：调用方（replyHandler._denyOperation）负责 opLog/wbD/pendingResult
 *     三件套；本模块只出裁决，不做副作用。
 *
 * 【字段】（任务 MD P0-B 最低契约）
 *   feature        操作所属功能域（对齐 ModeDef features 键；null=框架内建域）
 *   effect         none | read | write | host_control | destructive
 *   requiredModeFeature  执行入口要核的 ModeDef feature 键（null=不核）
 *   botMinimumLevel      Bot 来源最低档位（L0 只读/L1 读/L2 读写/L3 完整）
 *   hostControl    true=宿主能力（Bot 需 owner+HostControlEnabled，见上）
 *   ownerOnly      true=Bot 来源必须 isOwner（不足以 host_control 的敏感写）
 *   approvalPolicy 审批策略标注（"ide_write_gate"=复用既有 ideClient 写审批门；"none"）
 *   auditShape     审计摘要字段提示（供报告/对账，不参与裁决）
 *
 * 【关联链】
 *   ← replyHandler.mjs（唯一消费方）
 *   → storage.mjs modeFeature/modeFeaturesReady（ModeDef 声明镜像）
 *   → botContentShared.resolveRequestBotPermission（ctx.botPerm 形状生产者）
 */
import { modeFeature, modeFeaturesReady } from "../storage_mod/storage.mjs";

export const OPERATION_REGISTRY = {
  // —— 记忆/任务域（memory）——
  tableEdit:        { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "ops[]" },
  taskPlan:         { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "count" },
  taskCheck:        { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "selector" },
  memoryArchive:    { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "ops[]" },
  memorySearch:     { feature: "memory",    effect: "read",         requiredModeFeature: null,        botMinimumLevel: 1, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "queries" },
  memoryNote:       { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "notes" },
  codeMemoryWrite:  { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "file" },
  workMemoryWrite:  { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "file" },
  vocabEdit:        { feature: "memory",    effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "blocks" },

  // —— 模式/会话域 ——
  modeSwitch:       { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 3, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "from→to" },
  subModeSwitch:    { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 3, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "from→to" },
  chatRename:       { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "name" },
  contextClean:     { feature: null,        effect: "destructive",  requiredModeFeature: null,        botMinimumLevel: 3, hostControl: false, ownerOnly: true,  approvalPolicy: "none", auditShape: "actions[]" },

  // —— IDE/宿主域（host_control）——
  ideToolCall:      { feature: "ide",       effect: "host_control", requiredModeFeature: "ide",       botMinimumLevel: 3, hostControl: true,  ownerOnly: true,  approvalPolicy: "ide_write_gate", auditShape: "tools[]" },
  question:         { feature: "ide",       effect: "host_control", requiredModeFeature: "ide",       botMinimumLevel: 3, hostControl: true,  ownerOnly: true,  approvalPolicy: "none", auditShape: "count" },
  captureControl:   { feature: null,        effect: "host_control", requiredModeFeature: null,        botMinimumLevel: 3, hostControl: true,  ownerOnly: true,  approvalPolicy: "none", auditShape: "fields" },

  // —— 联网域（websearch）——
  needWebSearch:    { feature: "websearch", effect: "read",         requiredModeFeature: "websearch", botMinimumLevel: 1, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "queries" },
  webDownload:      { feature: "websearch", effect: "write",        requiredModeFeature: "websearch", botMinimumLevel: 3, hostControl: false, ownerOnly: true,  approvalPolicy: "none", auditShape: "url" },

  // —— 委派/分身域 ——
  delegate:         { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "target" },
  parallelDelegate: { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "tasks[]" },
  report:           { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 1, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "status" },
  clone:            { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 3, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "tasks[]" },

  // —— 调度/跨窗域（scheduler）——
  scheduleTask:     { feature: "scheduler", effect: "write",        requiredModeFeature: "scheduler", botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "job" },
  scheduleWakeup:   { feature: "scheduler", effect: "write",        requiredModeFeature: "scheduler", botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "delay" },
  wakeWindow:       { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "target" },
  sendToWindow:     { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "target" },

  // —— 流程/审批/交付域 ——
  createFlowGroup:  { feature: "flowGroup", effect: "write",        requiredModeFeature: "flowGroup", botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "name" },
  approval:         { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "title" },
  mcpConnect:       { feature: null,        effect: "write",        requiredModeFeature: null,        botMinimumLevel: 2, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "requestId" },
  fileDelivery:     { feature: null,        effect: "none",         requiredModeFeature: null,        botMinimumLevel: 1, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "path" },

  // —— 无副作用信号域（登记以求全枚举；恒放行）——
  progress:         { feature: null,        effect: "none",         requiredModeFeature: null,        botMinimumLevel: 0, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "step" },
  needHelp:         { feature: null,        effect: "none",         requiredModeFeature: null,        botMinimumLevel: 0, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "msg" },
  stopContinue:     { feature: null,        effect: "none",         requiredModeFeature: null,        botMinimumLevel: 0, hostControl: false, ownerOnly: false, approvalPolicy: "none", auditShape: "-" },
};

/**
 * 统一 admission 裁决。
 * @param {string} opId - OPERATION_REGISTRY 键。
 * @param {{ mode?: string, botPerm?: {isBot:boolean, level:number, isOwner?:boolean, hostControl?:boolean, senderId?:string}|null }} ctx
 * @returns {{allowed:boolean, code:string, reason:string, spec?:object}}
 */
export function admitOperation(opId, ctx = {}) {
  const spec = OPERATION_REGISTRY[opId];
  if (!spec) {
    return { allowed: false, code: "E_OP_UNREGISTERED", reason: `操作 "${opId}" 未在注册表登记（fail-closed）` };
  }
  // 1. ModeDef 声明面 = 执行面（同源投影）。预热未达 → 跳过该维度（诚实降级，调用方 wbT 留痕）。
  if (spec.requiredModeFeature && ctx.mode) {
    if (modeFeaturesReady()) {
      if (!modeFeature(ctx.mode, spec.requiredModeFeature).enabled) {
        return {
          allowed: false, code: "E_MODE_FEATURE_DISABLED", spec,
          reason: `当前模式「${ctx.mode}」的功能声明 features.${spec.requiredModeFeature} 未启用，执行入口按声明拒绝`,
        };
      }
    }
    // else: 声明表未注册（启动预热窗）——不按全 false 误拒；bot/宿主维度继续裁决
  }
  // 2. Bot 来源维度（本地来源 botPerm=null 不进此段）。
  const bp = ctx.botPerm;
  if (bp && bp.isBot) {
    if (spec.hostControl) {
      // 宿主能力：owner + HostControlEnabled 策略快照 + 档位，三者齐备才放行；L3 数字不再单独成立。
      if (bp.isOwner !== true) {
        return { allowed: false, code: "E_BOT_HOST_CONTROL_NOT_OWNER", spec, reason: `宿主能力操作仅限 owner（当前 sender 非 owner 或身份未持久化，fail-closed）` };
      }
      if (bp.hostControl !== true) {
        return { allowed: false, code: "E_BOT_HOST_CONTROL_DISABLED", spec, reason: `宿主能力开关（HostControlEnabled）未开启——默认关闭，需在 Bot 配置显式开启` };
      }
      if (bp.level < spec.botMinimumLevel) {
        return { allowed: false, code: "E_BOT_LEVEL_DENIED", spec, reason: `档位不足：L${bp.level} < 所需 L${spec.botMinimumLevel}` };
      }
      return { allowed: true, code: "OK", spec, reason: "" };
    }
    if (spec.ownerOnly && bp.isOwner !== true) {
      return { allowed: false, code: "E_BOT_OWNER_ONLY", spec, reason: `该操作仅限 owner（当前 sender 非 owner 或身份未持久化，fail-closed）` };
    }
    if (bp.level < spec.botMinimumLevel) {
      return { allowed: false, code: "E_BOT_LEVEL_DENIED", spec, reason: `档位不足：L${bp.level} < 所需 L${spec.botMinimumLevel}` };
    }
  }
  return { allowed: true, code: "OK", spec, reason: "" };
}
