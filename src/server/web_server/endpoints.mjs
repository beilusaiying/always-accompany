/**
 * 框架 API 端点注册 — registerEndpoints() 将所有非部件 HTTP 路由挂到 mainRouter。
 * 不管部件路由分发（那是 PartsRouter/parts_router.mjs 的事），不管中间件链（那是 middleware.mjs 的事）。
 *
 * 链路：web_server/index.mjs → registerEndpoints(mainRouter) → 各 router.get/post 注册
 * 影响：注册约 80+ 端点（认证/部件管理/Eye 注入/安全策略/Live2D 模型扫描/用户插件/IPC 命令），
 *       延迟 3s 首次引导 beilu-plugin-host
 * 相交：← web_server/index.mjs(registerEndpoints)
 *       → auth.mjs(authenticate/requireOwner/login/register/...) / parts_loader.mjs(loadPart/reloadPart/...) /
 *         yonban/core/functions/screenshot/injection_state.mjs(Eye 截图注入,T8 壳删除后新位) / monitor.mjs(asyncHandler)
 *
 * 端点域划分：
 *   - /api/ping, /api/test/*: 健康检查与测试
 *   - /api/users/*, /api/register/*, /api/logout, /api/authenticate, /api/whoami: 认证与用户管理
 *   - /api/apikey/*: API Key CRUD
 *   - /api/runpart, /api/loadpart, /api/getlist/*, /api/getdetails/*: 部件管理
 *   - /api/defaultpart/*: 默认部件注册
 *   - /api/eye/*: Eye 截图注入 / 陪伴 / 宠物设定
 *   - /api/security/*: 安全策略（MCP审批/CSP/CORS/部署模式/命令闸/审计日志/...）
 *   - /api/user-plugins/*: 用户级插件注册与推送
 *   - /api/live2d/*: Live2D 模型扫描与文件服务
 */
import fs from "node:fs";

import cors from "npm:cors";

import {
  beiluLocaleList,
  console,
  getLocaleDataForUser,
} from "../../scripts/i18n.mjs";
import { ms } from "../../scripts/ms.mjs";
import {
  get_hosturl_in_local_ip,
  is_local_ip_from_req,
  rateLimit,
} from "../../scripts/ratelimit.mjs";
import {
  ACCESS_TOKEN_EXPIRY_DURATION,
  REFRESH_TOKEN_EXPIRY_DURATION,
  auth_request,
  authenticate,
  changeUserPassword,
  deleteUserAccount,
  generateApiKey,
  getAllUsers,
  getSecureCookieOptions,
  getSecurityQuestionsForUser,
  getUserByReq,
  getUserByUsername,
  getUserDictionary,
  getUserListForLogin,
  hasSecurityQuestions,
  isOwner,
  login,
  logout,
  ownerResetUserPassword,
  register,
  reissueSessionTokens,
  renameUser,
  requireOwner,
  resetPasswordBySecurityQuestions,
  revokeApiKey,
  setApiCookieResponse,
  setSecurityQuestions,
  verifyApiKey,
  verifyUserActionPassword,
} from "../../yonban/core/functions/security/auth.mjs";
import { currentGitCommit } from "../autoupdate.mjs";
import { __dirname } from "../base.mjs";
import { confineSegment, getDeployMode, confinePath } from "../../yonban/core/functions/security/path_confine.mjs";
// R5 路径单源：beilu-files-settings.json 的 node 侧路径由 storage.getFilesSettingsPath() 统一供给，
//   删除本文件旧的 __dirname 上溯本地推导（原 _FILES_SETTINGS_PATH），消除三头巧合对齐。
//   方向 server → yonban/memory 无环（本文件已依赖 yonban 侧 path_confine / screenshot injection_state）。
import { getFilesSettingsPath } from "../../yonban/core/functions/memory/storage_mod/storage.mjs";
import path from "node:path";
import { processIPCCommand } from "../ipc_server/index.mjs";
import {
  getAllCachedPartDetails,
  getAllDefaultParts as getAllDefaultPartsFromLoader,
  getAnyDefaultPart,
  getAnyPreferredDefaultPart,
  getDefaultParts,
  getLoadedPartList,
  getPartBranches,
  getPartDetails,
  getPartList,
  loadPart,
  reloadPart,
  setDefaultPart,
  unsetDefaultPart,
} from "../parts_loader.mjs";
import { saveJsonFile } from "../../scripts/json_loader.mjs";
import { config, save_config, skip_report } from "../server.mjs";
import { asyncHandler } from "../monitor.mjs";

const RATE_LIMIT_AUTH = { maxRequests: 5, windowMs: 60000 };
const RATE_LIMIT_SENSITIVE = { maxRequests: 3, windowMs: 60000 };

// T12：verifycode.mjs 已删除后遗留的空实现占位（generateVerificationCode 恒返回 "000000"、
// verifyVerificationCode 恒返回 true）已随本函数纯删——全库 grep 确认零调用方（register 流程不校验验证码，
// /api/register/generateverificationcode 路由返回静态 message 不依赖此函数）。

import { renderDirectoryListingHtml } from "./directory_listing.mjs";
import { register as registerNotifier } from "./event_dispatcher.mjs";
import { betterSendFile } from "./resources.mjs";
import { watchFrontendChanges } from "./watcher.mjs";

// 桌面截图 — 桌面截图注入共享状态
import {
  archiveScreenshot,
  checkScreenshotBlacklist,
  checkScreenshotWhitelist,
  consumePendingInjection,
  consumePendingOrbMessage,
  resolvePetToken,
  DEFAULT_EYE_CONFIG,
  getEyeProcessState,
  getPendingStatus,
  getPetClientSeenAgoMs,
  hasPendingInjection,
  hasPendingOrbMessage,
  listScreenshotHistory,
  loadEyeConfig,
  getPetExpressionWords,
  loadPetCapabilities,
  loadPetSettingsStore,
  loadPetSettingsStoreRaw,
  loadUserModelDict,
  readScreenshotFile,
  saveEyeConfig,
  savePetSettingsStore,
  saveUserModelEntry,
  setEyeProcessState,
  setPendingInjection,
  setPendingOrbMessage,
} from "../../yonban/core/functions/screenshot/injection_state.mjs"; // T8·回切：改指 yonban 新位实现体

// beilu-plugin-host — 用户级插件注册表（共享状态单例）
import {
  getAllPlugins as getAllUserPlugins,
  getPlugin as getUserPlugin,
  setPendingInjection as setUserPluginPending,
  validateToken as validatePluginToken,
} from "../../public/parts/plugins/beilu-plugin-host/plugin_registry.mjs";

// ---- SEC-T11：命令执行闸（commandGate）配置文件读写 ----
//   权威源：<项目根>/data/beilu-files-settings.json 的 commandGate 段
//   （与 ideClient.mjs _loadCommandGateConfig 读的同一文件同一字段；本处只读写该 JSON，不碰 ideClient/beilu-files 代码）。
//   安全默认：allowChannelBExec=false（前端/分身通道命令类工具不即时执行）。
//   R5：路径改由 storage.getFilesSettingsPath() 单源供给（函数内取值，不在模块顶层求值，避免加载顺序耦合）。
// 0714 扩展：端点原只暴露 allowChannelBExec，failClosedUnknown 一直可读但零 UI 承载。现两字段读写。
//   ⚠ capabilities 不在此处：能力授权单源 = per-user command_config.json（get/setCommandConfig 动作，
//   UI=workPanel/权限面板同链），本端点只管 commandGate 段的两个真全局行为开关，不做第二能力存储。
async function _readCommandGate() {
  const _FILES_SETTINGS_PATH = getFilesSettingsPath();
  try {
    const raw = await fs.promises.readFile(_FILES_SETTINGS_PATH, "utf-8");
    const j = JSON.parse(raw);
    const g = (j && typeof j.commandGate === "object" && j.commandGate) ? j.commandGate : {};
    return {
      allowChannelBExec: g.allowChannelBExec === true,
      failClosedUnknown: g.failClosedUnknown !== false,
    };
  } catch {
    return { allowChannelBExec: false, failClosedUnknown: true };
  }
}
// 写 commandGate 段（部分字段更新）：合并到既有 settings（保留 workspaceRoot 等其它字段），原子覆盖整文件。
async function _writeCommandGate(patch) {
  const _FILES_SETTINGS_PATH = getFilesSettingsPath();
  let j = {};
  try {
    const raw = await fs.promises.readFile(_FILES_SETTINGS_PATH, "utf-8");
    j = JSON.parse(raw) || {};
  } catch { /* 文件不存在/损坏 → 从空对象重建 */ }
  if (!j || typeof j !== "object") j = {};
  if (!j.commandGate || typeof j.commandGate !== "object") j.commandGate = {};
  if (typeof patch.allowChannelBExec === "boolean") j.commandGate.allowChannelBExec = patch.allowChannelBExec;
  if (typeof patch.failClosedUnknown === "boolean") j.commandGate.failClosedUnknown = patch.failClosedUnknown;
  await fs.promises.mkdir(path.dirname(_FILES_SETTINGS_PATH), { recursive: true });
  await fs.promises.writeFile(_FILES_SETTINGS_PATH, JSON.stringify(j, null, 2), "utf-8");
  return {
    allowChannelBExec: j.commandGate.allowChannelBExec === true,
    failClosedUnknown: j.commandGate.failClosedUnknown !== false,
  };
}
// 0715 硬编码改选项：写 commandGate 段的黑/灰名单+git push 远程白名单（读侧 = commandGate.mjs _loadCommandRules 同文件同段）。
// patch 各键三态：undefined=不动 / null=删除覆盖(恢复代码默认) / 数组=整体覆盖。校验在路由层已做。
async function _writeCommandRules(patch) {
  const _FILES_SETTINGS_PATH = getFilesSettingsPath();
  let j = {};
  try {
    const raw = await fs.promises.readFile(_FILES_SETTINGS_PATH, "utf-8");
    j = JSON.parse(raw) || {};
  } catch { /* 文件不存在/损坏 → 从空对象重建 */ }
  if (!j || typeof j !== "object") j = {};
  if (!j.commandGate || typeof j.commandGate !== "object") j.commandGate = {};
  for (const key of ["blacklist", "graylist", "gitPushAllowedRemotes"]) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) delete j.commandGate[key];
    else j.commandGate[key] = patch[key];
  }
  // 0715 总开关（rulesEnabled）：黑/灰名单整体启停。true=删键回默认（缺省即启用），false=落盘停用。
  if (typeof patch.rulesEnabled === "boolean") {
    if (patch.rulesEnabled) delete j.commandGate.rulesEnabled;
    else j.commandGate.rulesEnabled = false;
  }
  await fs.promises.mkdir(path.dirname(_FILES_SETTINGS_PATH), { recursive: true });
  await fs.promises.writeFile(_FILES_SETTINGS_PATH, JSON.stringify(j, null, 2), "utf-8");
}

// ---- SEC-R4：正则 ReDoS 护栏配置读取（只读，供安全中心展示） ----
//   权威源：plugins/beilu-regex/config_data.json 的 regexGuard 段
//   安全默认与 regexGuard.mjs DEFAULT_GUARD_CONFIG 一致。
const _REGEX_CONFIG_PATH = path.join(__dirname, "src", "public", "parts", "plugins", "beilu-regex", "config_data.json");
async function _readRegexGuardConfig() {
  const defaults = { enabled: true, maxInputLength: 1000000, maxQuantifiers: 60, maxNestedQuantifierDepth: 0 };
  try {
    const raw = await fs.promises.readFile(_REGEX_CONFIG_PATH, "utf-8");
    const j = JSON.parse(raw);
    const g = (j && typeof j.regexGuard === "object" && j.regexGuard) ? j.regexGuard : {};
    return { ...defaults, ...g };
  } catch {
    return defaults;
  }
}

// ---- T-C：Live2D 模型【导入深扫描】(web 端，ESM 镜像 desktop-eye/main.js scanModelInfo) ----
//   web 进程不能 require desktop-eye/main.js(它是 Electron 主进程入口,require('electron') 在 npm 包下返回路径字符串、
//   destructure 出的 app 为 string-undefined,top-level app.xxx bootstrap 在 Electron 外即崩)，故此处独立实现同一扫描逻辑。
//   逻辑克隆参考项目 Live2DPet/src/main/model-import.js:7-29 + :73-153；校验加严参 airi live2d-validator.ts。
//   PARAM_FUZZY_MAP = 导入期参数自动建议表(非运行时硬编码情绪)。
const PARAM_FUZZY_MAP = {
  angleX: ["ParamAngleX", "ParamX", "Angle_X", "PARAM_ANGLE_X", "AngleX"],
  angleY: ["ParamAngleY", "ParamY", "Angle_Y", "PARAM_ANGLE_Y", "AngleY"],
  angleZ: ["ParamAngleZ", "ParamZ", "Angle_Z", "PARAM_ANGLE_Z", "AngleZ"],
  bodyAngleX: ["ParamBodyAngleX", "BodyAngleX", "PARAM_BODY_ANGLE_X", "ParamBodyX"],
  eyeBallX: ["ParamEyeBallX", "EyeBallX", "PARAM_EYE_BALL_X", "ParamEyeX"],
  eyeBallY: ["ParamEyeBallY", "EyeBallY", "PARAM_EYE_BALL_Y", "ParamEyeY"],
};
function _suggestParamMapping(parameterIds) {
  const suggested = {};
  for (const [key, candidates] of Object.entries(PARAM_FUZZY_MAP)) {
    const match = candidates.find((c) => parameterIds.some((p) => p.toLowerCase() === c.toLowerCase()));
    suggested[key] = match
      ? parameterIds.find((p) => p.toLowerCase() === match.toLowerCase())
      : null;
  }
  return suggested;
}
function _auditMoc3Header(mocPath) {
  try {
    const fd = fs.openSync(mocPath, "r");
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    const header = buf.slice(0, 4).toString("latin1");
    return { ok: header === "MOC3", header, ver: buf[4] };
  } catch { return { ok: false, header: "", ver: 0 }; }
}
function _basenameCollisions(refPaths) {
  const seen = new Map();
  for (const p of refPaths) {
    if (!p) continue;
    const base = String(p).split(/[\\/]/).pop();
    if (!seen.has(base)) seen.set(base, []);
    seen.get(base).push(p);
  }
  const collisions = [];
  for (const [base, paths] of seen.entries()) if (paths.length > 1) collisions.push(base);
  return collisions;
}
// 深扫描单个模型文件夹(纯 fs):解析 model3.json + cdi3 扒参数/表情/动作 + 校验 + 参数自动建议。
function scanModelInfo(folderPath, model3File) {
  try {
    const modelJsonPath = path.join(folderPath, model3File);
    if (!fs.existsSync(modelJsonPath)) return { success: false, error: "model3.json 不存在: " + modelJsonPath };
    const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, "utf-8"));
    const refs = modelJson.FileReferences || {};

    // (a) 参数双源去重: Groups[].Ids + DisplayInfo(cdi3).Parameters[].Id
    // parameterNames(凛倾 2026-07-22"找可以调动的动作,而不是固定的"):cdi3 的 Name 是建模者起的
    //   人话显示名(如"脸颊泛红/摇动 前发"——Cubism 编辑器参数面板同源),此前只取 Id 丢 Name,
    //   前端只能展示裸 ParamXxx。现按 {Id: Name} 透出,UI/调试工具可显示可读名;缺 cdi3=空对象诚实降级。
    let parameterIds = [];
    const parameterNames = {};
    if (Array.isArray(modelJson.Groups)) modelJson.Groups.forEach((g) => { if (g && Array.isArray(g.Ids)) parameterIds.push(...g.Ids); });
    if (refs.DisplayInfo) {
      const cdiPath = path.join(folderPath, refs.DisplayInfo);
      try {
        if (fs.existsSync(cdiPath)) {
          const cdiJson = JSON.parse(fs.readFileSync(cdiPath, "utf-8"));
          if (Array.isArray(cdiJson.Parameters)) {
            for (const p of cdiJson.Parameters) {
              if (!p || !p.Id) continue;
              parameterIds.push(p.Id);
              if (p.Name) parameterNames[p.Id] = p.Name;
            }
          }
        }
      } catch { /* 缺 cdi3 静默 */ }
    }
    parameterIds = [...new Set(parameterIds)];

    // (b) 表情双路兜底
    let expressions = [];
    if (Array.isArray(refs.Expressions)) expressions = refs.Expressions.map((e) => ({ name: e.Name, file: e.File }));
    if (expressions.length === 0) {
      try { expressions = fs.readdirSync(folderPath).filter((f) => f.endsWith(".exp3.json")).map((f) => ({ name: f.replace(".exp3.json", ""), file: f })); } catch { /* 无表情 */ }
    }

    // (c) 动作双路兜底
    let motions = {};
    if (refs.Motions && typeof refs.Motions === "object") {
      for (const [group, entries] of Object.entries(refs.Motions)) motions[group] = (entries || []).map((e) => ({ file: e.File }));
    }
    if (Object.keys(motions).length === 0) {
      try {
        const motionFiles = fs.readdirSync(folderPath).filter((f) => f.endsWith(".motion3.json"));
        if (motionFiles.length) motions["Default"] = motionFiles.map((f) => ({ file: f }));
      } catch { /* 无动作 */ }
    }

    // (d) 校验: Moc/Textures 存在性 + MOC3 头/basename 碰撞(加严)
    let mocValid = false;
    let mocHeaderValid = false;
    if (refs.Moc) {
      const mocPath = path.join(folderPath, refs.Moc);
      mocValid = fs.existsSync(mocPath);
      if (mocValid) mocHeaderValid = _auditMoc3Header(mocPath).ok;
    }
    let texturesValid = false;
    if (Array.isArray(refs.Textures)) texturesValid = refs.Textures.every((t) => fs.existsSync(path.join(folderPath, t)));
    const refPaths = [];
    if (refs.Moc) refPaths.push(refs.Moc);
    if (Array.isArray(refs.Textures)) refPaths.push(...refs.Textures);
    if (refs.Physics) refPaths.push(refs.Physics);
    expressions.forEach((e) => { if (e.file) refPaths.push(e.file); });
    const basenameCollisions = _basenameCollisions(refPaths);

    return {
      success: true,
      modelName: model3File.replace(".model3.json", ""),
      parameterIds,
      parameterNames,
      expressions,
      motions,
      mocValid,
      texturesValid,
      mocHeaderValid,
      basenameCollisions,
      suggestedMapping: _suggestParamMapping(parameterIds),
      hitAreas: modelJson.HitAreas || [],
    };
  } catch (e) { return { success: false, error: e.message }; }
}
// 文件路径 → file:/// URL(与 desktop-eye/main.js _fileUrl 同语义,供端点回传 renderer 可加载的 url)。
function _modelFileUrl(p) {
  const norm = p.replace(/\\/g, "/");
  return "file:///" + encodeURI(norm).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/**
 * 为应用程序注册所有 API 端点。
 * @param {import('npm:express').Router} router - 要在其上注册端点的 Express 路由器。
 * @returns {void}
 */
export async function registerEndpoints(router) {
  router.ws("/ws/test/echo", (ws, req) => {
    console.log("WebSocket test connection established.");
    ws.on("message", (message) => {
      console.log("Received from /ws/test/echo:", message.toString());
      ws.send(message.toString());
    });
    ws.on("close", () => {
      console.log("WebSocket test connection closed.");
    });
  });
  router.ws("/ws/test/auth_echo", authenticate, (ws, req) => {
    console.log("WebSocket auth_test connection established.");
    ws.on("message", (message) => {
      console.log("Received from /ws/test/auth_echo:", message.toString());
      ws.send(message.toString());
    });
    ws.on("close", () => {
      console.log("WebSocket auth_test connection closed.");
    });
  });

  router.ws("/ws/notify", authenticate, async (ws, req) => {
    const { username } = await getUserByReq(req);
    registerNotifier(username, ws);
  });

  router.get("/api/test/error", (req, res) => {
    throw skip_report(new Error("test error"));
  });
  router.get("/api/test/async_error", async (req, res) => {
    throw skip_report(new Error("test error"));
  });
  router.get("/api/test/unhandledRejection", async (req, res) => {
    Promise.reject(skip_report(new Error("test error")));
    return res.status(200).json({ message: "hell yeah!" });
  });
  router.get("/api/ping", cors(), async (req, res) => {
    const is_local_ip = is_local_ip_from_req(req);
    let hosturl_in_local_ip;
    let ver;
    if (is_local_ip || (await auth_request(req, res))) {
      try {
        hosturl_in_local_ip = get_hosturl_in_local_ip();
      } catch {}
      ver = currentGitCommit;
    }
    return res.status(200).json({
      message: "pong",
      client_name: "beilu",
      ver,
      uuid: config.uuid,
      is_local_ip,
      hosturl_in_local_ip,
    });
  });

  // beilu: PoW 端点已禁用（pow.mjs已删除）
  router.post("/api/pow/challenge", async (req, res) => {
    res.json({ success: true, message: "PoW disabled" });
  });

  router.post("/api/pow/redeem", async (req, res) => {
    res.json({ success: true, message: "PoW disabled" });
  });

  router.get("/api/getlocaledata", async (req, res) => {
    const browserLanguages =
      req.headers["accept-language"]
        ?.split?.(",")
        ?.map?.((lang) => lang.trim().split(";")[0]) || [];
    const userPreferredLanguages =
      req.query.preferred?.split?.(",")?.map?.((lang) => lang.trim()) || [];

    // 合并语言列表，用户设置的优先，然后去重
    const preferredLanguages = [
      ...new Set([...userPreferredLanguages, ...browserLanguages]),
    ].filter(Boolean);

    // 传导链修复（20260706）：未登录时 username 曾保持 undefined → getLocaleDataForUser 内
    //   loadData/saveData 把 "undefined" 字符串化落盘 data/users/undefined/（bug 化石实存）。
    //   缺省 "_default" 对齐全框架匿名语义（setDataActions:780 同款；_default/settings 已在承接同类缓存）。
    let username = "_default";
    // beilu: 尝试认证但不强制（登录页面也需要获取语言数据）
    try {
      await auth_request(req, res);
      if (req.user) {
        Object.defineProperty(req.user, 'locales', { value: preferredLanguages, enumerable: false, writable: true, configurable: true });
        username = req.user.username;
      }
    } catch (error) {
      console.error("Error setting language preference for user:", error);
    }

    return res
      .status(200)
      .json(await getLocaleDataForUser(username, preferredLanguages));
  });

  router.get("/api/getavailablelocales", async (req, res) => {
    res.status(200).json(beiluLocaleList);
  });

  // 获取用户列表（无需认证，用于登录页面）
  router.get("/api/users/list", async (req, res) => {
    res.status(200).json({ success: true, users: getUserListForLogin() });
  });

  router.post(
    "/api/login",
    rateLimit({ ...RATE_LIMIT_AUTH }),
    async (req, res) => {
      const { username, password, deviceid } = req.body;
      const result = await login(username, password || "", deviceid, req);
      // 在登录成功时设置 Cookie
      if (result.status === 200) {
        const cookieOptions = getSecureCookieOptions(req);
        res.cookie("accessToken", result.accessToken, {
          ...cookieOptions,
          maxAge: ACCESS_TOKEN_EXPIRY_DURATION,
        });
        res.cookie("refreshToken", result.refreshToken, {
          ...cookieOptions,
          maxAge: REFRESH_TOKEN_EXPIRY_DURATION,
        });
      }
      res.status(result.status).json(result);
    },
  );

  // beilu SEC-T3：可配置注册门。
  // 优先级：env BEILU_REGISTRATION > config.registration > 默认 'open'。
  // open(默认)  ：任意访客可注册（保持单用户本地零摩擦，不破坏现状）。
  // closed      ：禁止注册（适合多用户/对外部署，账号由 owner 预建）。
  // invite      ：需在请求体携带 inviteCode，且命中邀请码白名单。
  //               邀请码来源：env BEILU_INVITE_CODES(逗号分隔) ∪ config.inviteCodes(数组)。
  const getRegistrationMode = () => {
    const m = (process.env.BEILU_REGISTRATION || config.registration || "open")
      .toString().trim().toLowerCase();
    return ["open", "closed", "invite"].includes(m) ? m : "open";
  };
  const getInviteCodes = () => {
    const fromEnv = (process.env.BEILU_INVITE_CODES || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const fromConfig = Array.isArray(config.inviteCodes) ? config.inviteCodes : [];
    return new Set([...fromEnv, ...fromConfig]);
  };
  // 注册门检查：通过返回 null，拒绝返回 { status, message }。
  const checkRegistrationGate = (req) => {
    const mode = getRegistrationMode();
    if (mode === "closed")
      return { status: 403, message: "Registration is disabled" };
    if (mode === "invite") {
      const code = (req.body?.inviteCode ?? req.body?.invitecode ?? "").toString().trim();
      if (!code || !getInviteCodes().has(code))
        return { status: 403, message: "A valid invite code is required" };
    }
    return null; // open，或 invite 校验通过
  };

  router.post("/api/register/generateverificationcode", async (req, res) => {
    res.status(200).json({ message: "verification code generated" });
  });
  router.post(
    "/api/register",
    rateLimit({ ...RATE_LIMIT_AUTH }),
    async (req, res) => {
      // beilu SEC-T3：注册门前置（默认 open，不改变现状）
      const gate = checkRegistrationGate(req);
      if (gate) {
        res.status(gate.status).json({ status: gate.status, message: gate.message });
        return;
      }
      const { username, password } = req.body;
      const result = await register(username, password);
      res.status(result.status).json(result);
    },
  );

  router.post("/api/logout", logout);

  router.post("/api/users/change-password",
    authenticate,
    rateLimit({ ...RATE_LIMIT_AUTH }),
    asyncHandler(async (req, res) => {
      const user = await getUserByReq(req);
      const { currentPassword, newPassword } = req.body || {};
      if (!newPassword || typeof newPassword !== "string" || newPassword.length < 1)
        return res.status(400).json({ success: false, message: "New password is required." });
      // { req }：保留当前设备会话，其余设备 refresh 全撤（auth.mjs changeUserPassword 20260706 口径对齐）
      const result = await changeUserPassword(user.username, currentPassword || "", newPassword, { req });
      res.status(result.success ? 200 : 400).json(result);
    }, "POST /api/users/change-password"),
  );

  router.post("/api/users/delete-account",
    authenticate,
    rateLimit({ ...RATE_LIMIT_SENSITIVE }),
    asyncHandler(async (req, res) => {
      const user = await getUserByReq(req);
      const { password, purgeConfig, targetUsername } = req.body || {};
      let usernameToDelete = user.username;
      let ownerDeletingOther = false;
      if (targetUsername && targetUsername !== user.username) {
        if (!isOwner(user.username))
          return res.status(403).json({ success: false, message: "Only owner can delete other accounts." });
        if (!await verifyUserActionPassword(user, password || ""))
          return res.status(400).json({ success: false, message: "Invalid owner password." });
        usernameToDelete = targetUsername;
        ownerDeletingOther = true;
      }
      const result = await deleteUserAccount(usernameToDelete, password || "", { purgeConfig: !!purgeConfig, skipPasswordCheck: ownerDeletingOther });
      if (result.success && usernameToDelete === user.username) {
        res.clearCookie("accessToken");
        res.clearCookie("refreshToken");
      }
      res.status(result.success ? 200 : 400).json(result);
    }, "POST /api/users/delete-account"),
  );

  // 安全问题：设置（需认证+密码验证）
  router.post("/api/users/security-questions/set",
    authenticate,
    rateLimit({ ...RATE_LIMIT_SENSITIVE }),
    asyncHandler(async (req, res) => {
      const user = await getUserByReq(req);
      const { password, questions } = req.body || {};
      const result = await setSecurityQuestions(user.username, password || "", questions || []);
      res.status(result.success ? 200 : 400).json(result);
    }, "POST /api/users/security-questions/set"),
  );

  // 安全问题：获取问题列表（无需认证，登录页使用）
  router.get("/api/users/security-questions/get/:username",
    rateLimit({ maxRequests: 10, windowMs: ms("1m") }),
    (req, res) => {
      const result = getSecurityQuestionsForUser(req.params.username);
      res.status(200).json(result);
    },
  );

  // 安全问题：检查是否已设置（无需认证）
  router.get("/api/users/security-questions/has/:username",
    rateLimit({ maxRequests: 20, windowMs: ms("1m") }),
    (req, res) => {
      res.status(200).json({ hasSecurityQuestions: hasSecurityQuestions(req.params.username) });
    },
  );

  // 通过安全问题重置密码（无需认证，限流严格）
  router.post("/api/users/reset-password",
    rateLimit({ maxRequests: 3, windowMs: ms("5m") }),
    asyncHandler(async (req, res) => {
      const { username, answers, newPassword } = req.body || {};
      if (!username || !newPassword)
        return res.status(400).json({ success: false, message: "Username and new password required." });
      const result = await resetPasswordBySecurityQuestions(username, answers || [], newPassword);
      res.status(result.success ? 200 : 400).json(result);
    }, "POST /api/users/reset-password"),
  );

  // Owner 重置其他用户密码
  router.post("/api/users/admin-reset-password",
    authenticate,
    requireOwner,
    rateLimit({ ...RATE_LIMIT_AUTH }),
    asyncHandler(async (req, res) => {
      const owner = await getUserByReq(req);
      const { targetUsername, newPassword } = req.body || {};
      if (!targetUsername || !newPassword)
        return res.status(400).json({ success: false, message: "Target username and new password required." });
      const result = await ownerResetUserPassword(owner.username, targetUsername, newPassword);
      res.status(result.success ? 200 : 400).json(result);
    }, "POST /api/users/admin-reset-password"),
  );

  // 重命名用户
  router.post("/api/users/rename",
    authenticate,
    rateLimit({ ...RATE_LIMIT_SENSITIVE }),
    asyncHandler(async (req, res) => {
      const user = await getUserByReq(req);
      const { newUsername, password, targetUsername } = req.body || {};
      if (!newUsername || typeof newUsername !== "string" || !newUsername.trim())
        return res.status(400).json({ success: false, message: "New username required." });
      let usernameToRename = user.username;
      if (targetUsername && targetUsername !== user.username) {
        if (!isOwner(user.username))
          return res.status(403).json({ success: false, message: "Only owner can rename other accounts." });
        if (!await verifyUserActionPassword(user, password || ""))
          return res.status(400).json({ success: false, message: "Invalid owner password." });
        usernameToRename = targetUsername;
      }
      const ownerRenamingOther = usernameToRename !== user.username;
      const result = await renameUser(usernameToRename, newUsername.trim(), password || "", { skipPasswordCheck: ownerRenamingOther });
      // 改名会话迁移（20260706）：自改名后旧 cookie JWT 载旧用户名=当场全会话失效（静默登出死路家族）。
      //   系统事件在发生处处置：按新名重签 token 落 cookie（auth.mjs:reissueSessionTokens 单一权威账本），
      //   发起浏览器（含其同源全部标签，cookie 浏览器级共享）无缝续会话；其他设备走 401→登录页兜底链。
      //   owner 改他人不重签（发起者自己的会话没变）。
      if (result.success && !ownerRenamingOther) {
        const tokens = await reissueSessionTokens(req, newUsername.trim());
        if (tokens) {
          const cookieOptions = getSecureCookieOptions(req);
          res.cookie("accessToken", tokens.accessToken, { ...cookieOptions, maxAge: ACCESS_TOKEN_EXPIRY_DURATION });
          res.cookie("refreshToken", tokens.refreshToken, { ...cookieOptions, maxAge: REFRESH_TOKEN_EXPIRY_DURATION });
        }
      }
      res.status(result.success ? 200 : 400).json(result);
    }, "POST /api/users/rename"),
  );

  router.post("/api/apikey/create", authenticate, asyncHandler(async (req, res) => {
    const user = await getUserByReq(req);
    const { description, scopes } = req.body || {};
    if (!description || typeof description !== "string" || !description.trim()) {
      return res.status(400).json({ error: "description is required" });
    }
    const resolvedScopes = (Array.isArray(scopes) && scopes.length > 0) ? scopes : ["*"];
    const { apiKey, jti, scopes: savedScopes } = await generateApiKey(
      user.username,
      description.trim(),
      resolvedScopes,
    );
    res.status(201).json({
      success: true,
      apiKey,
      jti,
      scopes: savedScopes,
      message:
        "API Key created successfully. Store it securely, it will not be shown again.",
    });
  }, "POST /api/apikey/create"));

  // 可用 scope 列表（单一数据源在 v1_adapter.AVAILABLE_SCOPES）
  router.get("/api/apikey/available-scopes", authenticate, async (_req, res) => {
    const { AVAILABLE_SCOPES } = await import("./v1_adapter.mjs");
    res.json({ success: true, scopes: AVAILABLE_SCOPES });
  });

  router.get("/api/apikey/list", authenticate, asyncHandler(async (req, res) => {
    const user = await getUserByReq(req);
    const userConfig = getUserByUsername(user.username);
    const apiKeys = (userConfig.auth.apiKeys || []).map((key) => ({
      jti: key.jti,
      prefix: key.prefix,
      description: key.description,
      scopes: key.scopes || ['*'],
      createdAt: key.createdAt,
      lastUsed: key.lastUsed,
    }));
    res.status(200).json({ success: true, apiKeys });
  }, "GET /api/apikey/list"));

  router.post("/api/apikey/revoke", authenticate, async (req, res) => {
    const user = await getUserByReq(req);
    const { jti, password } = req.body;
    if (!jti)
      return res.status(400).json({
        success: false,
        error: "JTI of the key to revoke is required.",
      });
    if (!password)
      return res.status(400).json({
        success: false,
        error: "Password is required to revoke API key.",
      });

    const result = await revokeApiKey(user.username, jti, password);
    res.status(result.success ? 200 : 400).json(result);
  });

  // SEC-T6 (A-1): 补 authenticate + rateLimit(对齐 /api/login 的 5/min)。
  // 原端点无认证、无限流 → 可被匿名滥用做 API Key 探测/枚举。
  router.post(
    "/api/apikey/verify",
    rateLimit({ ...RATE_LIMIT_AUTH }),
    authenticate,
    async (req, res) => {
      const { apiKey } = req.body;
      if (!apiKey)
        return res
          .status(400)
          .json({ success: false, error: "API key is required." });

      const user = await verifyApiKey(apiKey);
      res.status(200).json({ success: true, valid: !!user });
    },
  );

  // SEC-T6 (A-4): 补 authenticate + rateLimit。
  router.post(
    "/api/get-api-cookie",
    rateLimit({ ...RATE_LIMIT_AUTH }),
    authenticate,
    asyncHandler(async (req, res) => {
      const { apiKey } = req.body;
      const result = await setApiCookieResponse(apiKey, req, res);
      res.status(result.status).json(result);
    }, "POST /api/get-api-cookie"),
  );

  router.get("/api/whoami", authenticate, asyncHandler(async (req, res) => {
    const { username } = await getUserByReq(req);
    res.status(200).json({ username, isOwner: isOwner(username) });
  }, "GET /api/whoami"));

  router.post("/api/authenticate", authenticate, (req, res) => {
    res.status(200).json({ message: "Authenticated" });
  });

  router.post("/api/runpart", authenticate, asyncHandler(async (req, res) => {
    const { username } = await getUserByReq(req);
    const { partpath, args } = req.body;
    await processIPCCommand("runpart", { username, partpath, args });
    res.status(200).json({ message: "Shell command sent successfully." });
  }, "POST /api/runpart"));

  router.post("/api/loadpart", authenticate, async (req, res) => {
    const { username } = await getUserByReq(req);
    const { partpath } = req.body;
    const normalized = partpath?.replace?.(/:/g, "/");
    if (!normalized)
      return res
        .status(400)
        .json({ success: false, error: "Part path is required." });
    await loadPart(username, normalized);
    res.status(200).json({
      success: true,
      message: `Part ${normalized} loaded successfully.`,
    });
  });

  // Generic path handlers
  // Capture remaining path as request param 0.
  router.get(/^\/api\/getlist\/(.*)/, authenticate, asyncHandler(async (req, res) => {
    const { username } = await getUserByReq(req);
    const path = req.params[0].replace(/:/g, "/");
    res.status(200).json(getPartList(username, path));
  }, "GET /api/getlist"));
  router.get(/^\/api\/getloadedlist\/(.*)/, authenticate, asyncHandler(async (req, res) => {
    const { username } = await getUserByReq(req);
    const path = req.params[0].replace(/:/g, "/");
    res.status(200).json(getLoadedPartList(username, path));
  }, "GET /api/getloadedlist"));
  router.get(
    /^\/api\/getallcacheddetails\/(.*)/,
    authenticate,
    asyncHandler(async (req, res) => {
      const { username } = await getUserByReq(req);
      const path = req.params[0].replace(/:/g, "/");
      const details = await getAllCachedPartDetails(username, path);
      res.status(200).json(details);
    }, "GET /api/getallcacheddetails"),
  );
  router.get(/^\/api\/getdetails\/(.*)/, authenticate, asyncHandler(async (req, res) => {
    const { username } = await getUserByReq(req);
    const path = req.params[0].replace(/:/g, "/");
    const { nocache } = req.query;
    const details = await getPartDetails(username, path, nocache);
    res.status(200).json(details);
  }, "GET /api/getdetails"));

  router.get("/api/getpartbranches", authenticate, async (req, res) => {
    const { username } = await getUserByReq(req);
    const nocache = req.query.nocache === "true" || req.query.nocache === "1";
    res.status(200).json(getPartBranches(username, { nocache }));
  });

  // Static files handler: /parts/partpath/filepath (partpath may contain colons)
  router.get(/^\/parts\/([^/]+)(.*)$/, authenticate, async (req, res, next) => {
    const { username } = await getUserByReq(req);
    const partpath = req.params[0];
    // 去掉捕获组 (.*) 带入的前导 `/`：filepath 应相对 public 目录。否则 confinePath 视 `/x` 为绝对路径
    //   → resolve 到盘符根 → 误判越界（旧版 `dir + "/" + filepath` 靠双斜杠折叠侥幸可用）。
    const filepath = req.params[1].split("?")[0].replace(/^\/+/, "");
    // Convert partpath colons to slashes for filesystem access
    const realPath = partpath.replace(/:/g, "/") + "/public";
    let finalPath;
    // SEC 目录穿越：partpath 与 filepath 均取自 URL，旧版 `directory + "/" + filepath` 裸字符串拼接，
    //   filepath(`(.*)` 捕获)可 `../` 逃出 part 的 public 目录读 part 源码(如 ../main.mjs)，partpath(`..`)可逃出可信根。
    //   框架级收口：两级 confinePath 围栏——① realPath(含 partpath) 不得逃出可信根；
    //   ② filepath 不得逃出该 part 的 public 目录（仅围栏到 root 不够：public/../main.mjs 仍在 root 内会泄漏 part 源码）。
    //   confinePath 消化 .. /绝对路径/同形点/null 字节，server 模式加 symlink 实路径校验；越界抛错→跳过该根(视同未命中)。
    for (const root of [
      getUserDictionary(username),
      __dirname + "/src/public/parts",
    ]) {
      let baseDir, safePath;
      try {
        baseDir = confinePath(root, realPath);     // partpath 不得逃出可信根
        safePath = confinePath(baseDir, filepath); // filepath 不得逃出该 part 的 public 目录
      } catch {
        continue; // 穿越尝试：该根下视为未命中
      }
      if (fs.existsSync(safePath)) {
        finalPath = safePath;
        if (fs.statSync(safePath).isDirectory())
          if (req.path.endsWith("/")) {
            const indexPath = safePath + "/index.html";
            if (fs.existsSync(indexPath)) finalPath = indexPath;
            else
              return res
                .set("Content-Type", "text/html; charset=utf-8")
                .send(await renderDirectoryListingHtml(req.path, safePath));
          } else
            return res.redirect(301, req.url.replace(req.path, req.path + "/"));

        watchFrontendChanges(`/parts/${partpath}/`, baseDir);
        break;
      }
    }
    if (finalPath) return betterSendFile(res, finalPath);
    return next();
  });

  router.get("/api/defaultpart/getall", authenticate, asyncHandler(async (req, res) => {
    const user = await getUserByReq(req);
    res.status(200).json(getDefaultParts(user));
  }, "GET /api/defaultpart/getall"));

  router.post("/api/defaultpart/add", authenticate, asyncHandler(async (req, res) => {
    const user = await getUserByReq(req);
    const { parent, child } = req.body;
    setDefaultPart(user, parent, child);
    res.status(200).json({ message: "success" });
  }, "POST /api/defaultpart/add"));

  router.post("/api/defaultpart/unset", authenticate, asyncHandler(async (req, res) => {
    const user = await getUserByReq(req);
    const { parent, child } = req.body;
    unsetDefaultPart(user, parent, child);
    res.status(200).json({ message: "success" });
  }, "POST /api/defaultpart/unset"));

  router.get(
    /^\/api\/defaultpart\/getany\/(.*)/,
    authenticate,
    asyncHandler(async (req, res) => {
      const user = await getUserByReq(req);
      const parent = req.params[0];
      res.status(200).json(getAnyDefaultPart(user, parent) || "");
    }, "GET /api/defaultpart/getany"),
  );

  router.get(
    /^\/api\/defaultpart\/getallbytype\/(.*)/,
    authenticate,
    asyncHandler(async (req, res) => {
      const user = await getUserByReq(req);
      const parent = req.params[0];
      res.status(200).json(getAllDefaultPartsFromLoader(user, parent));
    }, "GET /api/defaultpart/getallbytype"),
  );

  router.get(
    /^\/api\/defaultpart\/getanypreferred\/(.*)/,
    authenticate,
    asyncHandler(async (req, res) => {
      const user = await getUserByReq(req);
      const parent = req.params[0];
      res.status(200).json(getAnyPreferredDefaultPart(user, parent) || "");
    }, "GET /api/defaultpart/getanypreferred"),
  );

  router.get("/api/getusersetting", authenticate, asyncHandler(async (req, res) => {
    const user = await getUserByReq(req);
    const { key } = req.query;
    const _allowedKeys = new Set(["displayName", "avatar", "theme", "language", "locale", "timezone", "settings", "preferences", "contentFilter"]);
    if (!key || !_allowedKeys.has(key)) return res.status(400).json({ error: `不允许读取字段: ${key}` });
    res.status(200).json({ key, value: user[key] });
  }, "GET /api/getusersetting"));

  router.post("/api/setusersetting", authenticate, async (req, res) => {
    const user = await getUserByReq(req);
    const { key, value } = req.body;
    const _allowedKeys = new Set(["displayName", "avatar", "theme", "language", "locale", "timezone", "settings", "preferences", "contentFilter"]);
    if (!key || !_allowedKeys.has(key)) return res.status(400).json({ error: `不允许设置字段: ${key}` });
    user[key] = value;
    save_config();
    res.status(200).json({ message: "success" });
  });

  // ---- 桌面截图：桌面截图注入 API（pet-token 鉴权 + 仅 localhost IP 校验，详见下方 A4） ----
  router.post("/api/eye/inject", async (req, res) => {
    try {
      // 仅允许 localhost 访问
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      // inject per-user 鉴权令牌闸（A4，2026-06-18，范式同 orb _resolveOrbUser:930）：
      //   is_local_ip 只挡远程，挡不住本机他进程伪造截图推给任意用户。新增 x-pet-token 令牌(挡同机他进程 + 隔离用户)。
      //   截图客户端经 beilu-eye/main.mjs registerPetToken 拿令牌、env BEILU_PET_TOKEN 注入、inject 请求带 header；
      //   端点反解出 username 只给令牌所属 user 推图。resolvePetToken 返回 username 字符串(可为 ""=owner)；无效/缺失=null→403。
      //   ★安全核心：用令牌反解的 username 覆盖 payload 的 username，丢弃 body.username → 只能给令牌所属 user 推图。
      //   注意 username 可能为 ""(owner)，故用 === null 判无效，不能用 falsy。
      const _resolvedUser = resolvePetToken(req.headers["x-pet-token"]);
      if (_resolvedUser === null) {
        return res.status(403).json({ error: "Invalid or missing pet token" });
      }
      const { image, message, mode, window_title } = req.body || {};
      const injectUser = _resolvedUser; // 丢弃 payload 的 username，用令牌反解的 user（安全核心）
      if (!image) {
        return res.status(400).json({ error: "Missing image field" });
      }

      // ★ 截图黑名单检查（W13 + W18）
      // H3 修复：黑名单按 window_title 匹配，原逻辑仅当 window_title 存在才查，
      // 不传 window_title 即可旁路银行/密码窗口过滤。改为 fail-closed：
      // 已配置黑名单时 window_title 变为必填，缺失则拒绝（无法核实窗口安全性）。
      // FT5 A-③: 顺带取用户 injectionTtlMs 传给 setPendingInjection，使"只发最新"的过期清理跟用户值（不再写死 60s）。
      let _injectTtlMs = 0;
      // 感知模式（陪伴MD 三态）：用户持久偏好优先于截图客户端单次 mode 标记。
      // quiet → 只归档不写 pending；active/passive → 覆盖注入 mode（前端 pollEyeStatus 据此决定是否自动发 AI）。
      let _perceptionMode = null;
      // 口径对齐 :710 的 === null：injectUser 已过令牌闸（非 null），"" 为合法 owner-fallback 用户，
      // 不能用 falsy 跳过——否则 "" owner 会旁路黑白名单过滤 + 漏归档（半修陷阱）。
      if (injectUser !== null) {
        const eyeConfig = loadEyeConfig(injectUser, __dirname);
        _injectTtlMs = Number(eyeConfig.injectionTtlMs) || 0;
        if (eyeConfig.perceptionMode === "active" || eyeConfig.perceptionMode === "passive" || eyeConfig.perceptionMode === "quiet") {
          _perceptionMode = eyeConfig.perceptionMode;
        }
        const blacklistPatterns = eyeConfig.blacklistPatterns;
        if (blacklistPatterns && blacklistPatterns.length > 0) {
          if (!window_title) {
            return res.status(400).json({
              success: false,
              blocked: true,
              reason: "已配置截图黑名单，必须提供 window_title 以供安全核实",
            });
          }
          const blCheck = checkScreenshotBlacklist(window_title, blacklistPatterns);
          if (blCheck.blocked) {
            console.log(`[eye/inject] 🛡️ 截图被黑名单阻止: 窗口="${window_title}" 匹配="${blCheck.matchedPattern}"`);
            return res.status(200).json({
              success: false,
              blocked: true,
              reason: `窗口标题匹配黑名单: ${blCheck.matchedPattern}`,
            });
          }
        }

        // ★ 截图白名单检查（allowlist：只允许截某些窗口，其余一律拒绝）
        // 黑名单【之后】叠加：先黑名单排除危险窗口，再白名单正向限定准入范围。
        // fail-closed：白名单非空（启用）时 window_title 变必填，缺失则 400 拒绝（无法核实窗口在不在名单内）。
        // 白名单为空（默认）→ checkScreenshotWhitelist 始终 allowed，旧行为不变。
        const whitelistPatterns = eyeConfig.whitelistPatterns;
        if (whitelistPatterns && whitelistPatterns.length > 0) {
          if (!window_title) {
            return res.status(400).json({
              success: false,
              blocked: true,
              reason: "已配置截图白名单，必须提供 window_title 以供安全核实",
            });
          }
          const wlCheck = checkScreenshotWhitelist(window_title, whitelistPatterns);
          if (!wlCheck.allowed) {
            console.log(`[eye/inject] 🛡️ 截图被白名单拦截（窗口不在名单内）: 窗口="${window_title}"`);
            return res.status(200).json({
              success: false,
              blocked: true,
              reason: "窗口不在白名单",
            });
          }
        }
      }

      // 注入 mode：感知模式存在时由它权威决定，否则回落到客户端 mode（兼容旧调用）。
      const _effectiveMode = _perceptionMode || mode || "passive";
      // BR1: 安静模式 = 只截图不发送给 AI。跳过 setPendingInjection（永不进 pending → 前端轮询永远拿不到 → AI 看不到），仅归档。
      if (_perceptionMode !== "quiet") {
        setPendingInjection({
          image,
          message: message || "",
          mode: _effectiveMode,
          windowTitle: window_title || "",
          ttlMs: _injectTtlMs, // FT5 A-③: 用户 injectionTtlMs（0 → injection_state 走兜底默认 60s）
        }, injectUser); // ★ J6：按 username 分区，截图客户端 body 带 username 时定向，缺失落兜底键
      }
      // CP-N3: 归档到磁盘供历史面板浏览（安静模式下仍归档，符合「只截图」语义）
      if (injectUser !== null) {  // 口径对齐 :710，"" owner-fallback 也归档
        archiveScreenshot(injectUser, __dirname, {
          image,
          message: message || "",
          mode: _effectiveMode,
          windowTitle: window_title || "",
        });
      }
      res.status(200).json({
        success: true,
        message: _perceptionMode === "quiet"
          ? "截图已归档（安静模式，不发送给 AI）"
          : "截图已接收，将在下次 AI 回复时注入",
      });
    } catch (err) {
      console.error("[eye/inject] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/eye/status", authenticate, async (req, res) => {
    // ★ J6：按 username 分区取本用户 pending 状态（前端 pollEyeStatus 据此决定是否自动发 AI）。
    let _eyeUser = "";
    try { _eyeUser = (await getUserByReq(req)).username || ""; } catch { /* 取不到落兜底键 */ }
    res.status(200).json(getPendingStatus(_eyeUser));
  });

  // ---- beilu-eye: 截图安全配置 API ----
  router.get("/api/eye/config", authenticate, async (req, res) => {
    try {
      const { username } = await getUserByReq(req);
      const config = loadEyeConfig(username, __dirname);
      res.status(200).json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/eye/config", authenticate, async (req, res) => {
    try {
      const { username } = await getUserByReq(req);
      const updates = req.body || {};
      // 只允许更新已知字段
      const currentConfig = loadEyeConfig(username, __dirname);
      const newConfig = { ...currentConfig };
      if (Array.isArray(updates.blacklistPatterns)) newConfig.blacklistPatterns = updates.blacklistPatterns;
      if (Array.isArray(updates.whitelistPatterns)) newConfig.whitelistPatterns = updates.whitelistPatterns;
      if (typeof updates.askBeforeCapture === "boolean") newConfig.askBeforeCapture = updates.askBeforeCapture;
      // D5 分叉修(2026-07-13):值域改读 caps 单源(captureResolutionLimits,data/pet_capabilities.json 可覆盖),原 480/2160 三处副本
      if (typeof updates.captureResolution === "number") {
        const _crl = loadPetCapabilities(__dirname).captureResolutionLimits || {};
        const _crMin = Number(_crl.min) > 0 ? Number(_crl.min) : 480;
        const _crMax = Number(_crl.max) > 0 ? Number(_crl.max) : 2160;
        newConfig.captureResolution = Math.max(_crMin, Math.min(_crMax, updates.captureResolution));
      }
      // 0713 去硬编码批新字段(白名单式写口,不收=前端保存被静默丢弃的半接线)。
      // 0715 收口(近期diff审计后端#1):clamp 值域改读 caps 单源 eyeConfigLimits(与上方 captureResolution D5 同范式),
      //   括号内数字=离线兜底(与 PET_CAPABILITIES 出厂值同值,分叉即病);前端 companion.mjs 同谱消费。
      {
        const _eyeLim = loadPetCapabilities(__dirname).eyeConfigLimits || {};
        const _clampEye = (key, v, defMin, defMax) => {
          const L = _eyeLim[key] || {};
          const lo = Number.isFinite(Number(L.min)) ? Number(L.min) : defMin;
          const hi = Number.isFinite(Number(L.max)) ? Number(L.max) : defMax;
          return Math.max(lo, Math.min(hi, Math.round(v)));
        };
        if (typeof updates.captureJpegQuality === "number") newConfig.captureJpegQuality = _clampEye("captureJpegQuality", updates.captureJpegQuality, 1, 100); // 消费=autoCapture._getJpegQuality
        if (typeof updates.capturePollSec === "number") newConfig.capturePollSec = _clampEye("capturePollSec", updates.capturePollSec, 2, 60); // 消费=autoCapture._getPollMs
        if (typeof updates.gcShotWaitSec === "number") newConfig.gcShotWaitSec = _clampEye("gcShotWaitSec", updates.gcShotWaitSec, 0, 120); // 消费=gameCompanion 等图窗
        if (typeof updates.gcShotKeepN === "number") newConfig.gcShotKeepN = _clampEye("gcShotKeepN", updates.gcShotKeepN, 0, 100); // 消费=gameCompanion T4 截图历史修剪(0=关)
        if (typeof updates.captureRequestTtlSec === "number") newConfig.captureRequestTtlSec = _clampEye("captureRequestTtlSec", updates.captureRequestTtlSec, 1, 120); // 消费=replyHandler captureNow unlink
      }
      // 智能过滤(设计稿"智能过滤"段;beilu_eye.py _get_filter_config 消费): L1去重阈值/L2区域差分/L3变化分级/时间戳元数据
      if (typeof updates.dedupHammingThreshold === "number") newConfig.dedupHammingThreshold = Math.max(0, Math.min(20, Math.round(updates.dedupHammingThreshold)));
      if (typeof updates.l2RegionDiff === "boolean") newConfig.l2RegionDiff = updates.l2RegionDiff;
      if (typeof updates.l3Grading === "boolean") newConfig.l3Grading = updates.l3Grading;
      if (typeof updates.metaTimestamp === "boolean") newConfig.metaTimestamp = updates.metaTimestamp;
      if (typeof updates.captureFrequency === "number") newConfig.captureFrequency = Math.max(0, updates.captureFrequency);
      if (updates.captureWindow !== undefined) newConfig.captureWindow = updates.captureWindow || null;
      // BR1: 感知模式三态枚举（passive/active/quiet），非法值忽略
      if (updates.perceptionMode === "passive" || updates.perceptionMode === "active" || updates.perceptionMode === "quiet") newConfig.perceptionMode = updates.perceptionMode;
      // SEC-F: TTL 范围 10~600 秒
      if (typeof updates.injectionTtlMs === "number") newConfig.injectionTtlMs = Math.max(10_000, Math.min(600_000, updates.injectionTtlMs));
      // AI 自主 gate/反馈(caps.aiAutonomy 谱驱动;凛倾 2026-07-09):开关按谱收;停留时长不 clamp——
      //   用户手动设置什么就是什么(凛倾同日"时间还有范围用户手动设置就行"),仅拒负数(时长负值无语义)
      {
        const _aiSpec = loadPetCapabilities(__dirname).aiAutonomy;
        for (const _t of (_aiSpec?.toggles || [])) {
          if (typeof updates[_t.k] === "boolean") newConfig[_t.k] = updates[_t.k];
        }
        const _dw = _aiSpec?.dwell;
        if (_dw && typeof updates[_dw.k] === "number" && updates[_dw.k] >= 0) {
          newConfig[_dw.k] = Math.round(updates[_dw.k]);
        }
      }
      saveEyeConfig(username, __dirname, newConfig);
      res.status(200).json({ success: true, config: newConfig });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- beilu-eye: getdata / setdata（替代 beilu parts API，解决 404 问题）----
  // S9-X7：桌宠 python 客户端 poll 本端点但无 session（仅 pet-token），原 authenticate 中间件→401→python except:pass
  //   静默吞→AI自主/游戏陪伴"请求截图"链端到端断。改双鉴权（去 authenticate 中间件，handler 内分流，安全不弱）：
  //   带 x-pet-token=桌宠本机客户端（is_local_ip + resolvePetToken，同 orb-consume:984 范式）；否则=前端走 session（无 session→401，等价原 authenticate）。
  router.get("/api/eye/getdata", async (req, res) => {
    const processState = getEyeProcessState();
    // ★ J6：按 username 分区查本用户是否有 pending。
    let _gdUser = "";
    const _gdPetToken = req.headers["x-pet-token"];
    if (_gdPetToken !== undefined) {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const _gdU = resolvePetToken(_gdPetToken);
      if (_gdU === null) return res.status(403).json({ error: "Invalid or missing pet token" });
      _gdUser = _gdU; // string（可为 ""=owner 兜底键）
    } else {
      try { _gdUser = (await getUserByReq(req)).username || ""; }
      catch { return res.status(401).json({ error: "Unauthorized" }); }
    }
    // FT5 接断点②: 暴露陪伴/AI 自主截图请求标记。gameCompanion.mjs 写
    //   data/users/<username>/_gc_capture_request.json（按 username 分区），此处读其是否存在
    //   → 返回 captureRequested。beilu_eye.py poll() 见真即调 auto_capture_and_send()（接断点③）。
    //   写入方（gameCompanion）负责 unlink，本路由只读不删（幂等：截图前请求标记可能被多次轮询读到）。
    let _gdCaptureRequested = false;
    if (_gdUser) {
      try {
        const { getGcCaptureRequestPath } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T7 尾段收口：权威路径单点（server 层动态引先例=api_v1_router webhooks；__dirname=项目根与 getUserDataDir 同锚）
        _gdCaptureRequested = fs.existsSync(getGcCaptureRequestPath(_gdUser));
      } catch { /* 读不到当作无请求 */ }
    }
    res.status(200).json({
      hasPending: hasPendingInjection(_gdUser),
      captureRequested: _gdCaptureRequested,
      eyeStatus: processState.status,
      eyeError: processState.error,
      desktopEyeDir: processState.desktopEyeDir,
      // 桌宠 Electron 客户端距上次露面 ms(resolvePetToken 单点记,orb 轮询~2s 新鲜);null=本次后端启动后没见过。
      // consumer=companion 面板"桌宠在线"灯(审计C:此前桌宠未起,面板保存仍显示成功=假象)。
      petClientSeenAgoMs: getPetClientSeenAgoMs(_gdUser),
      // T5#10(2026-07-13):回传 token/会话反解的 username——desktop-eye autoCapture 据此按用户寻址
      // eye_config(此前=data/users 扫第一个有配置的目录,多用户时可能读错人);""=owner 兜底键。
      username: _gdUser,
      description:
        "桌面截图(桌宠 Electron 进程),截图通过 files 路径直接发送给 AI",
    });
  });

  router.post("/api/eye/setdata", authenticate, async (req, res) => {
    try {
      const data = req.body || {};

      // ★ J6：本路由认证态，取 username 作 eye pending 分区键（缺失落兜底键 ""）。
      let _sdUser = "";
      try { _sdUser = (await getUserByReq(req)).username || ""; } catch { /* 取不到落兜底键 */ }

      if (data._action === "inject") {
        if (!data.image) {
          return res.status(400).json({ error: "Missing image field" });
        }
        // FT5 A-③: 取用户 injectionTtlMs 传给 setPendingInjection（与 /api/eye/inject 同, "只发最新"过期跟用户值）
        let _sdTtlMs = 0;
        try { if (_sdUser) _sdTtlMs = Number(loadEyeConfig(_sdUser, __dirname).injectionTtlMs) || 0; } catch { /* 缺失走兜底 */ }
        setPendingInjection({
          image: data.image,
          message: data.message || "",
          mode: data.mode || "passive",
          ttlMs: _sdTtlMs,
        }, _sdUser);
        return res.status(200).json({ success: true });
      }

      if (data._action === "clear") {
        consumePendingInjection(_sdUser);
        return res.status(200).json({ success: true });
      }

      // restart / stop：委派给 beilu-eye/main.mjs 的 Parts SetData 真正控制进程。
      // SEC-R1：进程控制属运营者域，仅 owner 可 restart/stop（inject/clear 保持 per-user）。
      if (data._action === "restart" || data._action === "stop") {
        if (!isOwner(_sdUser)) return res.status(403).json({ success: false, message: "仅实例 owner 可控制截图进程" });
        try {
          const eyeMain = await import("../../public/parts/plugins/beilu-eye/main.mjs");
          const eyePlugin = eyeMain.default || eyeMain;
          if (eyePlugin?.interfaces?.config?.SetData) {
            await eyePlugin.interfaces.config.SetData({ _action: data._action });
          }
        } catch (eyeErr) {
          console.warn("[eye/setdata] beilu-eye 进程控制失败:", eyeErr.message);
          setEyeProcessState({ status: "error", error: eyeErr.message });
        }
        return res
          .status(200)
          .json({ success: true, message: `Action ${data._action} executed` });
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("[eye/setdata] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // orb per-user 鉴权令牌闸（B 方案，2026-06-18）：
  //   orb 三端点保留 is_local_ip(挡远程) + 新增 x-pet-token 令牌(挡同机他进程 + 隔离用户)。
  //   桌宠经 beilu-eye/main.mjs registerPetToken 拿令牌、env 传入、请求带 header；端点反解出 username
  //   只访问该 user 的 orb 槽。resolvePetToken 返回 username 字符串(可为 ""=owner 落兜底键)；无效/缺失=null→403。
  //   注意 username 可能为 ""(owner 落 orb 兜底键 __default__)，故用 === null 判无效，不能用 falsy。
  const _resolveOrbUser = (req, res) => {
    const token = req.headers["x-pet-token"];
    const username = resolvePetToken(token);
    if (username === null) {
      res.status(403).json({ error: "Invalid or missing pet token" });
      return undefined;
    }
    return username; // string（可为 ""）
  };

  // 悬浮球消息(orbMessage): backend push (localhost only + pet token)
  router.post("/api/eye/orb-set", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      const _orbUser = _resolveOrbUser(req, res);
      if (_orbUser === undefined) return; // 已 403
      const { text } = req.body || {};
      if (!text) return res.status(400).json({ error: "Missing text" });
      setPendingOrbMessage(_orbUser, text);
      res.status(200).json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 悬浮球消息: Electron 端 polling 消费 (localhost only + pet token)
  router.get("/api/eye/orb-consume", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      const _orbUser = _resolveOrbUser(req, res);
      if (_orbUser === undefined) return; // 已 403
      const data = consumePendingOrbMessage(_orbUser);
      if (!data) return res.status(200).json({ hasPending: false });
      res.status(200).json({ hasPending: true, ...data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 悬浮球消息: 状态查询 (localhost only + pet token)
  router.get("/api/eye/orb-status", async (req, res) => {
    if (!is_local_ip_from_req(req)) {
      return res.status(403).json({ error: "Only localhost access allowed" });
    }
    const _orbUser = _resolveOrbUser(req, res);
    if (_orbUser === undefined) return; // 已 403
    res.status(200).json({ hasPending: hasPendingOrbMessage(_orbUser) });
  });

  // 桌宠语音自动连接(凛倾 2026-07-22"点击语言,包括本体,那些都需要自动连接"):桌宠 🎤 遇 ECONNREFUSED
  // → 本端点(pet-token,同 orb 范式)→ beilu-stt 插件 ensureServiceStarted(spawn+等 health,单飞去重)。
  // 直接 import 插件模块(同一模块实例,_sttProcess 状态单源)——STT 服务是机器级单例,无 per-user 语义。
  router.post("/api/eye/stt-ensure", async (req, res) => {
    if (!is_local_ip_from_req(req)) {
      return res.status(403).json({ error: "Only localhost access allowed" });
    }
    const _sttUser = resolvePetToken(req.headers["x-pet-token"]);
    if (_sttUser === null) return res.status(403).json({ error: "invalid pet token" });
    try {
      const { ensureServiceStarted } = await import("../../public/parts/plugins/beilu-stt/main.mjs");
      const r = await ensureServiceStarted(Number(req.body?.port) || 7861);
      return res.status(r.ok ? 200 : 503).json(r);
    } catch (e) {
      console.error("[eye/stt-ensure] 失败:", e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Live2D 桌宠用户自定义模型字典: 调试工具"保存到用户配置"(localhost only, 无 session, 同 orb-set 范式)
  // body=单条或多条 model_dict 条目(需含 name)→按 name 字段级合并写 data/live2d_user_models.json
  router.post("/api/eye/usermodel-save", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      const entry = req.body;
      const hasName = Array.isArray(entry)
        ? entry.some((e) => e && e.name)
        : !!(entry && entry.name);
      if (!hasName) return res.status(400).json({ error: "Missing model entry (need name)" });
      const dict = saveUserModelEntry(__dirname, entry);
      res.status(200).json({ success: true, count: dict.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live2D 桌宠用户自定义模型字典: renderer 经 __BEILU_USER_DICT_URL 加载(localhost only)
  router.get("/api/eye/usermodel-dict", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      res.status(200).json(loadUserModelDict(__dirname));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // T-C: Live2D 模型【导入深扫描】(localhost only,无 session,同 usermodel-dict:831 范式)
  //   扫 <项目根>/desktop-eye/user-models(__dirname=项目根,见 base.mjs:6)每个子目录的 *.model3.json,
  //   跑 scanModelInfo 深解析(参数/表情/动作/校验/参数自动建议),返回数组供调试工具(T-D)预填。
  router.get("/api/eye/usermodel-scan", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      const userModelsDir = path.join(__dirname, "desktop-eye", "user-models");
      const out = [];
      if (!fs.existsSync(userModelsDir)) {
        // 目录不存在(桌宠未启用/未导入任何模型)：返回空数组而非报错。
        return res.status(200).json([]);
      }
      for (const dir of fs.readdirSync(userModelsDir)) {
        const sub = path.join(userModelsDir, dir);
        let st;
        try { st = fs.statSync(sub); } catch { continue; }
        if (!st.isDirectory()) continue;
        let m3;
        try { m3 = fs.readdirSync(sub).find((f) => f.toLowerCase().endsWith(".model3.json")); } catch { continue; }
        if (!m3) continue;
        const info = scanModelInfo(sub, m3);
        const url = _modelFileUrl(path.join(sub, m3));
        if (!info.success) {
          out.push({ name: dir, url, error: info.error });
          continue;
        }
        out.push({
          name: dir,
          url,
          // web 可加载 URL(0722 读侧对齐):url 是 file:///(仅 Electron renderer 能加载),web 预览
          // 走 /api/eye/user-models 静态路由;相对引用(textures/motions)由该路由多段子路径承接。
          webUrl: `/api/eye/user-models/${encodeURIComponent(dir)}/${encodeURIComponent(m3)}`,
          parameterIds: info.parameterIds,
          parameterNames: info.parameterNames, // cdi3 显示名 {Id:Name}(0722:可调参数按人话名展示)
          expressions: info.expressions,
          motions: info.motions,
          mocValid: info.mocValid,
          texturesValid: info.texturesValid,
          mocHeaderValid: info.mocHeaderValid,
          basenameCollisions: info.basenameCollisions,
          suggestedMapping: info.suggestedMapping,
          hitAreas: info.hitAreas,
        });
      }
      res.status(200).json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 图片包(图片模式,任务②③ 2026-07-09):user-images/<包名>/pack.json 单源(localhost only,同 usermodel 范式) ──
  //   /api/eye/imagepacks → dict 同构条目(format:"image"),web renderer _mergeUserModels ③路默认拉取;
  //   /api/eye/user-images/:pack/:file → 图片/pack.json 静态读(web 端图片 URL 按 pack.json URL 相对解析到此);
  //   /api/eye/imagepack-save → 编辑器写回 pack.json(增表情/增删图=改 json,物理图片经 upload);
  //   /api/eye/imagepack-upload → base64 落图片文件(≤8MB,仅图片扩展名)。
  // 桌宠能力/选项单源下发(任务⑥):动态预设/creature/corner/resolution 选项集 + 上传限值 + 气泡默认/滑块谱/窗高限/托盘档。
  //   权威=loadPetCapabilities(出厂默认 PET_CAPABILITIES ← data/pet_capabilities.json 用户覆盖);web 面板与 Electron 托盘都读此。
  router.get("/api/eye/pet-capabilities", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      res.status(200).json(loadPetCapabilities(__dirname));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  // 表情宏当前值(凛倾 2026-07-09"宏需要在显眼的地方可以复制,可以查看当前内容"):
  //   与 preset_engine._petMacroEnv 同源取值(getPetExpressionWords+pet_settings 标签名),面板展示/复制用。
  router.get("/api/eye/pet-macros", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const s = loadPetSettingsStore(__dirname);
      res.status(200).json({
        petExpressions: getPetExpressionWords(__dirname),
        // 0715 收口(近期diff审计后端#4):删 `|| "emotion"/"motion"` 本地默认副本——loadPetSettingsStore
        // 已合并 PET_SETTINGS_DEFAULT(injection_state.mjs:584)单源;消费端 replyHandler:790 同样裸读,
        // 此处再加回退=第二默认源且与真实抽取行为不同源(store 异常值时面板显示≠实际生效)。
        petEmotionTag: s.emotionTag,
        petMotionTag: s.motionTag,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  // 触碰发送(凛倾 2026-07-09 触碰设计②):桌宠点击热区把【用户预设内容】作为用户消息发给 AI,
  //   回应经既有 companion_message/orb→气泡链可见。localhost+pet-token 反解 user(同 inject 范式);
  //   刻意不走 /api/eye/inject——那是截图注入域(image 必填+感知模式权威覆盖),语义不同,硬塞=补丁。
  router.post("/api/eye/pet-message", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const _pmUser = resolvePetToken(req.headers["x-pet-token"]);
      if (_pmUser === null) return res.status(403).json({ error: "Invalid or missing pet token" });
      const text = (req.body && typeof req.body.text === "string") ? req.body.text.trim() : "";
      if (!text) return res.status(400).json({ error: "Missing text" });
      const _gcUrl = new URL("../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs", import.meta.url).href;
      const _gcMod = await import(_gcUrl);
      const ok = _gcMod.gameCompanionTouchMessage(_pmUser, text);
      res.status(200).json(ok ? { success: true } : { success: false, reason: "陪伴未运行(触碰发送需要陪伴会话上下文)" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  const _userImagesRoot = () => path.join(__dirname, "desktop-eye", "user-images");
  const _safeSeg = (s) => typeof s === "string" && !!s && !/[\\/]|\.\./.test(s); // 单段名,拒穿越
  // 0715 收口(近期diff审计后端#5):图片包支持的图片扩展名此前同文件三处各写一份
  //   (物化扫描过滤 / 静态文件 MIME 表 / 上传校验),新增格式要改三处必漂移——收为单源常量。
  //   MIME 表=图片集+pack.json 专用 json(非图片,不进上传/物化校验)。regex 无 /g 无状态,共享安全。
  const IMAGEPACK_IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
  const IMAGEPACK_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".json": "application/json" };
  router.get("/api/eye/imagepacks", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const root = _userImagesRoot();
      const out = [];
      if (fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root)) {
          const sub = path.join(root, dir);
          let st; try { st = fs.statSync(sub); } catch { continue; }
          if (!st.isDirectory()) continue;
          // 外部导入(2026-07-09 断链修):用户把现成图片文件夹丢进 user-images——无 pack.json 时自动物化最小声明
          //   (键=文件名去扩展,禁字符[\s,|]换-;default=首键)。幂等(存在即跳过);之后编辑器照常增删改。
          //   单点实现:只此处物化,desktop-eye 扫描仍只认 pack.json(物化后自然可见),不复制派生逻辑。
          if (!fs.existsSync(path.join(sub, "pack.json"))) {
            try {
              const imgs = fs.readdirSync(sub).filter((f) => IMAGEPACK_IMG_RE.test(f));
              if (!imgs.length) continue; // 非图片目录:不物化不列出
              const expressions = {};
              for (const f of imgs) {
                const key = f.replace(/\.[^.]+$/, "").replace(/[\s,|]+/g, "-");
                if (!key) continue;
                (expressions[key] = expressions[key] || []).push(f);
              }
              const keys = Object.keys(expressions);
              if (!keys.length) continue;
              fs.writeFileSync(path.join(sub, "pack.json"), JSON.stringify({ default: keys[0], expressions }, null, 2));
            } catch { continue; }
          }
          out.push({ name: dir, format: "image", url: `/api/eye/user-images/${encodeURIComponent(dir)}/pack.json`, source: "图片包" });
        }
      }
      res.status(200).json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  // Live2D user-models 静态读(0722,与 user-images 同范式):web 预览加载用户模型的唯一 http 通道
  //   (usermodel-scan.webUrl 指此;model3.json 的相对引用 textures/motions/ 等多段子路径同路由承接)。
  //   Electron 桌宠 renderer 不走此(壳注入 file:/// URL,旧链不动)。逐段 _safeSeg 拒穿越。
  const LIVE2D_MIME = { ".json": "application/json", ".moc3": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
  //   ⚠ 路由语法=path-to-regexp@8(router@2.2.0,Express5 系):通配必须【命名】`*rest`——裸 `/*` 在 v8
  //   解析期即抛 PathError,且抛在 registerEndpoints 中段=其后全部路由(pet-settings 等)不注册,全面 404
  //   (2026-07-22 实炸复盘)。匹配值契约=按 / 切好的已解码数组(dist/index.js:231 亲核)。
  router.get("/api/eye/user-models/:model/*rest", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const model = req.params.model;
      const segs = (Array.isArray(req.params.rest) ? req.params.rest : []).filter(Boolean);
      if (!_safeSeg(model) || !segs.length || !segs.every(_safeSeg)) return res.status(400).json({ error: "Bad path" });
      const mime = LIVE2D_MIME[path.extname(segs[segs.length - 1]).toLowerCase()];
      if (!mime) return res.status(400).json({ error: "Unsupported file type" });
      const fp = path.join(__dirname, "desktop-eye", "user-models", model, ...segs);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
      res.set("Content-Type", mime);
      // json(model3/物理/动作等)禁缓存:导入覆盖后 web 预览必须拿最新;二进制(moc3/纹理)短缓存。
      res.set("Cache-Control", mime === "application/json" ? "no-store" : "private, max-age=60");
      res.send(fs.readFileSync(fp));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.get("/api/eye/user-images/:pack/:file", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const { pack, file } = req.params;
      if (!_safeSeg(pack) || !_safeSeg(file)) return res.status(400).json({ error: "Bad path" });
      const mime = IMAGEPACK_MIME[path.extname(file).toLowerCase()];
      if (!mime) return res.status(400).json({ error: "Unsupported file type" });
      const fp = path.join(_userImagesRoot(), pack, file);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
      res.set("Content-Type", mime);
      // 链路修(凛倾 2026-07-09"链路有问题"):pack.json 禁缓存——编辑器保存后 renderer/编辑器再读必须拿最新,
      //   60s 陈缓存=保存了但显示旧内容(读写不同步假象)。图片仍短缓存(内容不可变,改图=换文件名)。
      res.set("Cache-Control", mime === "application/json" ? "no-store" : "private, max-age=60");
      res.send(fs.readFileSync(fp));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.post("/api/eye/imagepack-save", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const { pack, json } = req.body || {};
      if (!_safeSeg(pack)) return res.status(400).json({ error: "Bad pack name" });
      if (!json || typeof json !== "object" || Array.isArray(json) || typeof json.expressions !== "object") {
        return res.status(400).json({ error: "json 必须含 expressions 对象(表情键→图片文件名数组)" });
      }
      const dir = path.join(_userImagesRoot(), pack);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify(json, null, 2));
      res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.post("/api/eye/imagepack-upload", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const { pack, filename, dataBase64 } = req.body || {};
      if (!_safeSeg(pack) || !_safeSeg(filename)) return res.status(400).json({ error: "Bad path" });
      if (!IMAGEPACK_IMG_RE.test(filename)) return res.status(400).json({ error: "仅支持图片文件(png/jpg/gif/webp)" });
      if (typeof dataBase64 !== "string" || !dataBase64) return res.status(400).json({ error: "Missing dataBase64" });
      const buf = Buffer.from(dataBase64, "base64");
      const _upMax = loadPetCapabilities(__dirname).imagepackUploadMaxBytes; // 限值单源(任务⑥),UI 经 pet-capabilities 读同一值(含用户覆盖)
      if (buf.length > _upMax) return res.status(400).json({ error: `图片超过 ${Math.round(_upMax / 1024 / 1024)}MB 上限` });
      const dir = path.join(_userImagesRoot(), pack);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), buf);
      res.status(200).json({ success: true, size: buf.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Live2D 模型文件选择式导入(凛倾 2026-07-22"导入功能做成选择的那种,也就是选择文件") ──
  //   此前唯一导入路=手动把模型文件夹丢进 desktop-eye/user-models/(扫描式,无上传通道;图片包早有
  //   imagepack-upload 唯 Live2D 缺——同范式补齐,不造平行机制):逐文件 base64 落
  //   user-models/<模型名>/<相对路径>,落完即被既有 scanUserModels/usermodel-scan/托盘扫描链自动发现,
  //   零新发现机制。limits 单源=caps.live2dUploadMaxBytes(用户可 data/pet_capabilities.json 覆盖)。
  //   模型引用可含子目录(motions/xx.motion3.json),relPath 允许多段但逐段过 _safeSeg(拒 ../绝对路径穿越)。
  //   .cmo3/.can3 是 Cubism Editor 工程格式,运行时引擎(moc3/model3.json 体系)不可加载——拒收并给导出指引
  //   (airi 同样零处理 cmo3,全网运行时栈皆然)。
  const LIVE2D_FILE_RE = /\.(moc3|json|png|jpe?g|webp|wav|mp3)$/i;
  const LIVE2D_EDITOR_RE = /\.(cmo3|can3|cmox|psd)$/i;
  router.post("/api/eye/usermodel-upload", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) return res.status(403).json({ error: "Only localhost access allowed" });
      const { model, relPath, dataBase64 } = req.body || {};
      if (!_safeSeg(model)) return res.status(400).json({ error: "Bad model name" });
      const segs = typeof relPath === "string" ? relPath.split(/[\\/]/).filter(Boolean) : [];
      if (!segs.length || !segs.every(_safeSeg)) return res.status(400).json({ error: "Bad relPath" });
      const fname = segs[segs.length - 1];
      if (LIVE2D_EDITOR_RE.test(fname)) {
        return res.status(400).json({ error: `${fname} 是 Cubism Editor 工程文件,运行时无法加载。请在 Cubism Editor 里「文件→导出运行时文件(.moc3)」导出后,选择导出目录(含 .model3.json)导入` });
      }
      if (!LIVE2D_FILE_RE.test(fname)) return res.status(400).json({ error: "不支持的文件类型(允许: moc3/json/png/jpg/webp/wav/mp3)" });
      if (typeof dataBase64 !== "string" || !dataBase64) return res.status(400).json({ error: "Missing dataBase64" });
      const buf = Buffer.from(dataBase64, "base64");
      const _l2Max = loadPetCapabilities(__dirname).live2dUploadMaxBytes; // 限值单源(同 imagepackUploadMaxBytes 范式)
      if (buf.length > _l2Max) return res.status(400).json({ error: `文件超过 ${Math.round(_l2Max / 1024 / 1024)}MB 上限: ${fname}` });
      const dir = path.join(__dirname, "desktop-eye", "user-models", model, ...segs.slice(0, -1));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fname), buf);
      res.status(200).json({ success: true, size: buf.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 桌宠设置桥(单一权威源 data/pet_settings.json,localhost only,无 session,同 orb 范式)
  //   GET → web 设置中心读当前 + Electron 桌宠主进程轮询读取应用显示设置(对话框/动态/模型)。
  //   POST(字段级 patch) → web 设置中心/托盘写改动。petEnabled 由插件读决定拉起桌宠。
  router.get("/api/eye/pet-settings", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      // ?raw=1 → 只回盘上显式键(Electron 对账用:分辨"用户设过/默认",替代旧"值≠默认"启发式——
      //   该启发式在用户把值改回默认时误判并触发 Electron 旧值回灌,2026-07-09 确诊)。缺省=默认合并全量(web 面板回填用)。
      if (req.query && req.query.raw) return res.status(200).json(loadPetSettingsStoreRaw(__dirname));
      res.status(200).json(loadPetSettingsStore(__dirname));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  router.post("/api/eye/pet-settings", async (req, res) => {
    try {
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }
      const patch = req.body;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return res.status(400).json({ error: "Body must be a settings object" });
      }
      const next = savePetSettingsStore(__dirname, patch);
      res.status(200).json({ success: true, settings: next });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // CP-N3: 截图历史列表 (用户认证)
  router.get("/api/eye/screenshots", authenticate, async (req, res) => {
    try {
      const { username } = await getUserByReq(req);
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
      const list = listScreenshotHistory(username, __dirname, limit);
      res.status(200).json({ screenshots: list, count: list.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // CP-N3: 读取单张截图文件 (用户认证,路径穿越保护)
  router.get("/api/eye/screenshot/:filename", authenticate, async (req, res) => {
    try {
      const { username } = await getUserByReq(req);
      const filename = req.params.filename;
      const buf = readScreenshotFile(username, __dirname, filename);
      if (!buf) return res.status(404).json({ error: "Screenshot not found" });
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "private, max-age=3600");
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 消费截图数据（获取完整 base64 并清除 pending 状态）
  router.post("/api/eye/consume", authenticate, async (req, res) => {
    try {
      // ★ J6：按 username 分区消费本用户 pending（前端 consume 与 status/getdata 同分区键）。
      let _cnUser = "";
      try { _cnUser = (await getUserByReq(req)).username || ""; } catch { /* 取不到落兜底键 */ }
      const data = consumePendingInjection(_cnUser);
      if (!data) {
        return res
          .status(200)
          .json({ success: false, message: "No pending injection" });
      }
      console.log(
        "[eye/consume] 截图数据已消费，大小:",
        Math.round((data.image?.length || 0) / 1024),
        "KB",
      );
      res.status(200).json({ success: true, ...data });
    } catch (err) {
      console.error("[eye/consume] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- SEC-H: 安全中心状态汇总接口 ----
  // 采集框架内各安全机制的运行时状态,供 🛡️ 安全中心面板展示
  // 只读/采集型,不强制任何配置 — 用户根据建议自主决定
  router.get("/api/security/status", authenticate, async (req, res) => {
    try {
      const items = [];
      // control（可选，第6参）：前端据此渲染控件 + 回写。
      //   { kind:'select', source:'localStorage'|'server'|'partconfig'|'readonly',
      //     key/endpoint/field, options:[{value,label,risk?}], value, risk?, restartHint? }
      const add = (id, label, status, level, hint, control) =>
        items.push({ id, label, status, level, hint, ...(control ? { control } : {}) });

      // 认证/网络
      add("auth", "服务器认证", "已启用 (Argon2id + JWT)", "ok", "");
      add("host_validation", "Host Header 验证 (F-T5)",
        process.env.BEILU_HOST_VALIDATION === "off" ? "已关闭 (env)" : "已启用",
        process.env.BEILU_HOST_VALIDATION === "off" ? "warn" : "ok",
        process.env.BEILU_HOST_VALIDATION === "off" ? "建议开启,防 DNS 重绑定攻击" : "");
      // FT7：读真实开关状态 — env BEILU_CSP=off 强制关 > config.csp_enabled(默认开)
      const cspEnvOff = process.env.BEILU_CSP === "off";
      const cspCfgEnabled = config?.csp_enabled !== false;
      const cspActive = !cspEnvOff && cspCfgEnabled;
      add("csp", "CSP 响应头 (SEC-C / FT7)",
        cspEnvOff ? "已关闭 (env)" : (cspActive ? "已启用 (响应头已实装)" : "已关闭 (设置)"),
        cspActive ? "ok" : "warn",
        cspActive ? "" : "建议开启,防 XSS");

      // 绑定地址 / 远程访问 (设计 §5.4 #2 / #5)
      // config.listen 决定服务器监听地址: localhost/127.0.0.1/::1 = 仅本机;
      // 其余值(0.0.0.0 / 局域网IP)或留空(默认绑全部网卡) = 对局域网/外部开放
      const listenRaw = config?.listen;
      const listenStr = String(listenRaw ?? "").trim().toLowerCase();
      const isLocalBind = listenStr === "localhost" || listenStr === "127.0.0.1" ||
        listenStr === "::1" || listenStr === "[::1]";
      add("bind_localhost", "绑定地址 (设计 §5.4 #2)",
        listenRaw ? (isLocalBind ? "localhost (仅本机)" : `${listenRaw} (对外开放)`) : "未设置 (默认绑全部网卡)",
        isLocalBind ? "ok" : "warn",
        isLocalBind ? "" : "服务器绑定到非 localhost 地址,局域网/外部可访问;若无需远程访问,建议在 config.json 设 listen 为 localhost");
      add("remote_access", "远程访问 (设计 §5.4 #5)",
        isLocalBind ? "已关闭 (仅本机可连)" : "已开放 (局域网/外部可连)",
        isLocalBind ? "ok" : "warn",
        isLocalBind ? "" : "当前允许远程访问;请确认认证 + Host 校验 + Origin 校验均已开启");

      // 截图
      let eyeCfg = null;
      try {
        const { username } = await getUserByReq(req);
        eyeCfg = loadEyeConfig(username, __dirname);
      } catch {}
      if (eyeCfg) {
        const blCount = (eyeCfg.blacklistPatterns || []).length;
        add("eye_blacklist", "截图黑名单",
          `${blCount} 条`,
          blCount >= 5 ? "ok" : "warn",
          blCount < 5 ? "建议至少 5 条关键词" : "");
        const ttlSec = Math.round((eyeCfg.injectionTtlMs || 60000) / 1000);
        add("eye_ttl", "截图注入 TTL (SEC-F)",
          `${ttlSec} 秒`,
          ttlSec >= 10 && ttlSec <= 600 ? "ok" : "warn",
          "");
      }
      add("eye_auth", "截图 API 认证 (SEC-A)", "已启用", "ok", "");
      // 截图注入仅本地 IP (设计 §5.4 #8)
      // /api/eye/inject 硬编码 is_local_ip_from_req 校验,
      // 非本机来源一律 403,该限制始终生效、用户无法关闭
      add("eye_local_only", "截图注入仅本地 IP (设计 §5.4 #8)",
        "已启用 (非本机来源 403)", "ok", "");

      // API Key
      try {
        const { getUserByUsername } = await import("../../yonban/core/functions/security/auth.mjs");
        const { username } = await getUserByReq(req);
        const u = getUserByUsername(username);
        const keys = u?.auth?.apiKeys || [];
        const scopedKeys = keys.filter(k => Array.isArray(k.scopes) && !k.scopes.includes('*')).length;
        add("api_key_scopes", "API Key 作用域 (SEC-B)",
          `${keys.length} 个 Key, ${scopedKeys} 个受限`,
          keys.length === 0 || scopedKeys > 0 ? "ok" : "warn",
          keys.length > 0 && scopedKeys === 0 ? "现有 Key 均为全权限,建议按需限制" : "");
      } catch {}

      // postMessage 来源校验 (设计 §5.4 #9)
      // 前端 iframeRenderer.mjs 监听 message 时硬编码校验 e.origin
      // (仅放行 'null' 沙箱来源与本站 origin),该校验随代码加载始终生效
      add("postmessage_origin", "iframe postMessage 来源校验 (设计 §5.4 #9)",
        "已启用 (仅放行本站 origin)", "ok", "由前端 iframeRenderer 强制,无需配置");

      // WS Origin
      add("ws_origin", "WebSocket Origin 校验", "已启用 (WsAbleRouter)", "ok", "");

      // ============================================================
      // SEC-T11：本次安全加固新增项 + 可调策略
      //   只读状态项读真实运行态；可配置项带 control 描述，前端据此渲染控件 + 回写。
      // ============================================================

      // T1 跨账号身份锁定（认证身份唯一权威源，代码硬编码，始终生效）
      add("t1_identity_lock", "跨账号身份锁定 (T1)",
        "已启用", "ok",
        "认证身份为唯一权威源，请求体不得覆盖 username");

      // T2 文件操作沙箱 / 部署模式（可配 local/server）。读真实 getDeployMode（env > config）。
      const _deployMode = getDeployMode();
      const _deployEnv = (process.env.BEILU_DEPLOY_MODE || "").trim().toLowerCase();
      const _deployEnvForced = _deployEnv === "local" || _deployEnv === "server";
      const _deployCfg = String(config?.deployMode ?? "").trim().toLowerCase() === "server" ? "server" : "local";
      add("t2_file_sandbox", "文件操作沙箱 / 部署模式 (T2 / RCE-3)",
        `${_deployMode === "server" ? "server（严格 per-user）" : "local（宽工作区根）"}${_deployEnvForced ? " (env 强制)" : ""}`,
        "ok",
        "前端/AI 文件操作限制在工作区根内（部署模式决定严格度）",
        {
          kind: "select", source: "server",
          endpoint: "/api/security/deploy-mode", field: "deployMode",
          value: _deployCfg, locked: _deployEnvForced,
          lockedHint: _deployEnvForced ? "已被环境变量 BEILU_DEPLOY_MODE 强制，此下拉只读" : "",
          options: [
            { value: "local", label: "本地 local（宽工作区根）", risk: "单机宽松：放宽 per-user 隔离 + 关 symlink 实路径校验" },
            { value: "server", label: "服务器 server（严格 per-user）" },
          ],
        });

      // T4 EJS 模板沙箱（超时 + opt-out）— 经 beilu-ejs part config 接口（前端读写，后端只展示状态）
      add("t4_ejs_sandbox", "EJS 模板沙箱 (T4 / SSTI)",
        "已启用 (Deno Worker 权限全关)", "ok",
        "模板渲染在权限全关 Deno Worker 内执行；超时自动终止",
        {
          kind: "ejs", source: "partconfig",
          endpointGet: "/api/parts/plugins:beilu-ejs/config/getdata",
          endpointSet: "/api/parts/plugins:beilu-ejs/config/setdata",
          timeoutField: "sandboxTimeoutMs", optOutField: "sandboxOptOut",
          optOutRisk: "opt-out=开：模板在主进程执行，恶意世界书/角色卡可 RCE",
        });

      // SEC-R4 正则 ReDoS 护栏（只读状态，配置入口在正则编辑器 🛡️ 面板）
      const _guardCfg = await _readRegexGuardConfig();
      add("regex_guard", "正则 ReDoS 护栏 (SEC-R4)",
        _guardCfg.enabled ? `已启用 (RE2 + 复杂度预检，量词上限 ${_guardCfg.maxQuantifiers}，嵌套深度 ${_guardCfg.maxNestedQuantifierDepth})` : "已关闭 (危险，仅供调试)",
        _guardCfg.enabled ? "ok" : "warn",
        "用户/角色卡可控正则走 RE2 线性引擎 + 静态预检；配置入口在「正则脚本」面板 🛡️ 按钮");

      // T5 工具/命令执行闸（allowChannelBExec 开关）— 读 data/beilu-files-settings.json commandGate
      const _cmdGate = await _readCommandGate();
      add("t5_command_gate", "工具/命令执行闸 (T5)",
        _cmdGate.allowChannelBExec ? "已放行通道B (allowChannelBExec=on)" : "已启用 (fail-closed)",
        "ok",
        "callTool 统一闸 fail-closed；危险命令到不了执行端。开关=是否放行前端/分身通道即时执行命令类工具",
        {
          kind: "switch", source: "server",
          endpoint: "/api/security/command-gate", field: "allowChannelBExec",
          value: _cmdGate.allowChannelBExec,
          risk: "放行通道B（前端直连命令）= 前端 git 面板可跑命令但削弱防护",
        });

      // T12 change-prompt ${} eval 闸（server 模式默认关，防服务端 RCE；owner 可开）
      //   仅 server 部署有意义：local 恒放行(owner 自己机器)。开关写 config.allowPromptEval。
      const _peEnvOn = String(process.env.BEILU_PROMPT_EVAL || "").toLowerCase() === "on";
      const _peCfgOn = config?.allowPromptEval === true;
      const _peDeploy = getDeployMode();
      const _peEffective = _peDeploy !== "server" || _peEnvOn || _peCfgOn;
      add("t12_prompt_eval", "change-prompt 模板 eval (T12)",
        _peDeploy !== "server"
          ? "本地模式恒放行 (owner 机器)"
          : (_peEnvOn ? "已放行 (env 强制)" : _peCfgOn ? "已放行 (owner 开启)" : "已关闭 (server 默认，防 RCE)"),
        _peEffective && _peDeploy === "server" ? "warn" : "ok",
        "change-prompt 自定义源模板里的 ${...} 会在服务端执行任意 JS。server 多用户部署默认关闭（防任一用户经此 RCE）；本地单用户恒放行。",
        {
          kind: "switch", source: "server",
          endpoint: "/api/security/prompt-eval", field: "allowPromptEval",
          value: _peCfgOn, locked: _peEnvOn,
          lockedHint: _peEnvOn ? "已被环境变量 BEILU_PROMPT_EVAL=on 强制放行，此开关只读" : "",
          risk: "开启=允许 change-prompt 源在服务端执行模板内 ${} JS（server 多用户下=任一用户可 RCE）",
        });

      // T13 用户插件子进程 spawn 闸（server 模式默认关，防服务端 RCE；owner 可开）
      //   plugin-host 的 user-plugins 带 runtime 会 spawn python/node/executable + pip install。
      const _upsEnvOn = String(process.env.BEILU_USER_PLUGIN_SPAWN || "").toLowerCase() === "on";
      const _upsCfgOn = config?.allowUserPluginSpawn === true;
      const _upsDeploy = getDeployMode();
      add("t13_user_plugin_spawn", "用户插件子进程 (T13)",
        _upsDeploy !== "server"
          ? "本地模式恒放行 (owner 机器)"
          : (_upsEnvOn ? "已放行 (env 强制)" : _upsCfgOn ? "已放行 (owner 开启)" : "已关闭 (server 默认，防 RCE)"),
        _upsDeploy === "server" && (_upsEnvOn || _upsCfgOn) ? "warn" : "ok",
        "user-plugins/ 带 runtime 的插件会 spawn 宿主进程(python/node/可执行文件)并 pip 装依赖。server 多用户部署默认不启动；本地单用户恒放行。",
        {
          kind: "switch", source: "server",
          endpoint: "/api/security/user-plugin-spawn", field: "allowUserPluginSpawn",
          value: _upsCfgOn, locked: _upsEnvOn,
          lockedHint: _upsEnvOn ? "已被环境变量 BEILU_USER_PLUGIN_SPAWN=on 强制放行，此开关只读" : "",
          risk: "开启=允许 user-plugins 在服务端 spawn 进程执行任意命令（server 多用户下=任一用户可 RCE）",
        });

      // T7 出站 SSRF 防护（代码硬编码拦截，始终生效）
      add("t7_ssrf", "出站 SSRF 防护 (T7)",
        "已启用", "ok",
        "webhook/网页抓取/角色卡下载：拦内网/云元数据/混淆IP（本地 LLM 端点放行）");

      // T6 API Key scope 强制（fail-closed，代码强制）
      add("t6_scope_enforce", "API Key scope 强制 (T6)",
        "已启用 (fail-closed)", "ok",
        "受限 Key 换 cookie 不再洗白提权");

      // raw_send scope 隔离（game/connect WS 的 raw_send 跳过输入消毒，需 chat:raw scope）
      add("raw_send_scope", "raw_send scope 隔离",
        "已启用 (需 chat:raw)", "ok",
        "game/connect WS 的 raw_send 跳过输入消毒，需独立 chat:raw scope（默认 API Key 不含）");

      // P8 Markdown 净化（localStorage：strict/loose；reader 仅识别这两档）
      add("p8_md_sanitize", "Markdown 净化 (P8 / XSS)",
        "可配 (strict/loose)", "ok",
        "不可信内容(AI/角色卡/世界书/网页) rehype-sanitize 剥脚本/事件/危险协议",
        {
          kind: "select", source: "localStorage", key: "beilu-sanitize-level",
          default: "strict",
          options: [
            { value: "strict", label: "strict（严格，默认）" },
            { value: "loose", label: "loose（放行 style）", risk: "放行 style 属性，可能藏 CSS expression()/url(javascript:)" },
          ],
        });

      // T13 Markdown 代码块执行按钮（localStorage：on/off；reader 默认 on，仅显式 off 关闭）
      add("t13_code_exec", "Markdown 代码执行 (T13)",
        "可配 (on/off)", "ok",
        "代码块「执行」按钮：点击才跑(非自动)，但会在本人浏览器执行不可信内容里的代码。设 off 彻底隐藏执行按钮。",
        {
          kind: "select", source: "localStorage", key: "beilu-code-exec",
          default: "on",
          options: [
            { value: "on", label: "on（显示执行按钮，默认）", risk: "可手动执行 AI/角色卡代码块里的 JS/Python（在本人会话内）" },
            { value: "off", label: "off（隐藏执行按钮，最安全）" },
          ],
        });

      // F-T4 iframe 沙箱（localStorage：strict/standard/sandbox；reader 默认 strict）
      add("iframe_sandbox", "iframe 沙箱 (F-T4)",
        "3 档可配 (strict/standard/sandbox)", "ok",
        "strict 去 same-origin（默认）；美化卡高度/音频走 postMessage",
        {
          kind: "select", source: "localStorage", key: "beilu-iframe-sandbox",
          default: "strict",
          options: [
            { value: "strict", label: "strict（默认，安全）" },
            { value: "standard", label: "standard（含 same-origin）", risk: "含 allow-same-origin：美化卡与父页同源，有 XSS 风险" },
            { value: "sandbox", label: "sandbox（仅脚本）" },
          ],
        });

      // 脚本激活（localStorage：beilu-script-activation，默认 off）
      add("script_activation", "脚本激活 (display script)",
        "默认禁用", "ok",
        "角色卡/正则 display script 是否在主页面激活（默认禁用，高风险才开）",
        {
          kind: "switch", source: "localStorage", key: "beilu-script-activation",
          truthy: "true", default: false,
          risk: "开启=角色卡脚本可在主页面执行（高风险）",
        });

      // 角色卡图片校验（导入时硬校验，始终生效）
      add("charcard_image", "角色卡图片校验 (P8)",
        "已启用", "ok",
        "导入 file-type 真实 MIME 断言 + 重编码杀 polyglot + 拒 SVG 内联脚本");

      // T3 注册门（可配 open/invite/closed）。读真实 config.registration（env 优先则标注）。
      //   server 模式默认 closed（防忘配导致任意注册），local 模式默认 open（个人零摩擦）。
      const _regDefaultByDeploy = getDeployMode() === "server" ? "closed" : "open";
      const _regEnv = (process.env.BEILU_REGISTRATION || "").trim().toLowerCase();
      const _regCfg = (config?.registration || _regDefaultByDeploy).toString().trim().toLowerCase();
      const _regEnvForced = ["open", "closed", "invite"].includes(_regEnv);
      const _regEffective = _regEnvForced ? _regEnv : (["open", "closed", "invite"].includes(_regCfg) ? _regCfg : _regDefaultByDeploy);
      add("t3_registration", "注册门 (T3)",
        `${_regEffective}${_regEnvForced ? " (env 强制)" : ""}`,
        "ok",
        "控制谁能注册新账号",
        {
          kind: "select", source: "server",
          endpoint: "/api/security/registration", field: "registration",
          value: _regCfg, locked: _regEnvForced,
          lockedHint: _regEnvForced ? "已被环境变量 BEILU_REGISTRATION 强制，此下拉只读" : "",
          options: [
            { value: "open", label: `open（开放${_regDefaultByDeploy === "open" ? "，默认" : ""}）`, risk: "任意访客可注册" },
            { value: "invite", label: "invite（邀请码）" },
            { value: "closed", label: `closed（关闭${_regDefaultByDeploy === "closed" ? "，默认" : ""}）` },
          ],
        });

      // T3 MCP 导入（consent，代码强制）
      add("mcp_import", "MCP 导入 (T3)",
        "已启用 (consent)", "ok",
        "env 最小化(仅 allowlist 透传)；可 spawn 的 server 导入需确认");

      // T10 git 恢复防护（开关：config.gitRestoreMultiUser；仅写配置 + 展示，enforcement 由主 AI 后续接）
      add("t10_git_restore", "git 恢复防护 (T10)",
        config?.gitRestoreMultiUser === true ? "多用户允许 gitRestore (on)" : "已启用 (单用户)",
        "ok",
        "命令 argv 不走 shell + hash 校验；多用户共享仓回滚开关",
        {
          kind: "switch", source: "server",
          endpoint: "/api/security/git-restore-multiuser", field: "gitRestoreMultiUser",
          value: config?.gitRestoreMultiUser === true,
          risk: "开启=多用户共享仓可被任一用户触发 git 回滚",
        });

      // SEC-MCP：命令型 MCP 的逐个批准开关已移出本概览，归口到「MCP Servers 面板」
      //   （用户实际管理 MCP 处就近批准），数据源 = GET /api/security/mcp-servers。
      //   此处保留上方 mcp_import(T3) 的总览状态项即可，避免两处重复同一组开关。

      // EXT-CORS：外部接口跨域白名单（config.cors_allowed_origins，默认 []）
      const corsOrigins = Array.isArray(config?.cors_allowed_origins) ? config.cors_allowed_origins : [];
      add("cors_origins", "CORS 域白名单 (EXT-CORS)",
        corsOrigins.length === 0 ? "默认拒绝所有外部 origin（安全）" : `已允许 ${corsOrigins.length} 个外部 origin`,
        corsOrigins.length === 0 ? "ok" : "warn",
        "控制哪些外部网页可跨域调用 /api/v1 接口；留空 = 拒绝全部（最安全）",
        {
          kind: "list", source: "server",
          endpoint: "/api/security/cors-origins",
          value: corsOrigins,
          placeholder: "https://example.com",
          risk: "每个域均可跨域调用 beilu 的外部 API",
        });

      // SEC-AL: 安全审计日志（可配开关，默认关闭）
      const _alEnvOn = String(process.env.BEILU_AUDIT_LOG || "").toLowerCase() === "on";
      const _alCfg = config.auditLog || {};
      const _alOn = _alCfg.enabled === true || _alEnvOn;
      add("audit_log", "安全审计日志",
        _alOn ? "已启用 (data/audit/)" : "已关闭（安全事件仅内存环形缓冲）",
        _alOn ? "ok" : "warn",
        "将 wbDetect 安全异常事件持久化写入 data/audit/security-YYYY-MM-DD.jsonl。server 部署建议开启",
        {
          kind: "switch", source: "server",
          endpoint: "/api/security/audit-log", field: "enabled",
          value: _alCfg.enabled === true,
          locked: _alEnvOn,
          lockedHint: _alEnvOn ? "已被环境变量 BEILU_AUDIT_LOG=on 强制开启，此开关只读" : "",
          risk: "",
        });

      // SEC-GC: AI 生成全局并发上限（可配开关，默认关闭）
      const _gcEnvMax = parseInt(process.env.BEILU_GEN_CONCURRENCY_MAX || "0");
      const _gcCfg = config.genConcurrency || {};
      const _gcOn = _gcCfg.enabled === true || _gcEnvMax > 0;
      const _gcMax = _gcEnvMax > 0 ? _gcEnvMax : (_gcCfg.max || 10);
      add("gen_concurrency", "AI 生成并发上限",
        _gcOn ? `已启用 (上限 ${_gcMax})` : "已关闭（不限制并发数）",
        _gcOn ? "ok" : "warn",
        "限制同时进行的 AI 生成任务数。server 部署建议开启，防多 key 同时耗尽计算资源",
        {
          kind: "switch", source: "server",
          endpoint: "/api/security/gen-concurrency", field: "enabled",
          value: _gcCfg.enabled === true,
          locked: _gcEnvMax > 0,
          lockedHint: _gcEnvMax > 0 ? `已被环境变量 BEILU_GEN_CONCURRENCY_MAX=${_gcEnvMax} 强制，此开关只读` : "",
          risk: "",
          // T11-A 接链：伴随数值输入 max（后端 POST handler :2291 已接收 max>0 落盘），前端 switch-num 控件渲染。
          //   env 强制时 locked=只读（前端 numDisabled）。
          numField: "max", numValue: _gcMax, numMin: 1, numLabel: "上限",
        });

      // SEC-RL: v1 API 速率限制（可配开关，默认关闭）
      const _rlEnvOn = String(process.env.BEILU_V1_RATE_LIMIT || "").toLowerCase() === "on";
      const _rlCfg = config.v1RateLimit || {};
      const _rlOn = _rlCfg.enabled === true || _rlEnvOn;
      add("v1_rate_limit", "v1 API 速率限制",
        _rlOn ? `已启用 (每 key ${_rlCfg.perKeyPerMin || 120} 次/分)` : "已关闭（个人使用无需限制）",
        _rlOn ? "ok" : "warn",
        "控制 /api/v1 端点的 per-key 每分钟请求上限。server 部署建议开启，防 API Key 滥刷 AI 计算",
        {
          kind: "switch", source: "server",
          endpoint: "/api/security/v1-rate-limit", field: "enabled",
          value: _rlCfg.enabled === true,
          locked: _rlEnvOn,
          lockedHint: _rlEnvOn ? "已被环境变量 BEILU_V1_RATE_LIMIT=on 强制开启，此开关只读" : "",
          risk: "",
        });

      // 计分
      const okCount = items.filter(i => i.level === "ok").length;
      const warnCount = items.filter(i => i.level === "warn").length;
      const errCount = items.filter(i => i.level === "error").length;
      res.json({
        success: true,
        summary: { total: items.length, ok: okCount, warn: warnCount, error: errCount },
        items,
        env: {
          BEILU_HOST_VALIDATION: process.env.BEILU_HOST_VALIDATION || "on",
          BEILU_CSP: process.env.BEILU_CSP || "on",
        },
        // FT7：CSP 用户开关真实状态(供设置面板开关读取)
        csp: {
          enabled: config?.csp_enabled !== false,
          envForcedOff: process.env.BEILU_CSP === "off",
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- SEC-MCP：批准/撤销命令型 MCP server（置 data._mcpApproved + reloadPart 使其 spawn/停）----
  //   补齐原本「有闸无开关」的缺口：Template/main.mjs 的 spawn 闸要求 _mcpApproved===true，
  //   但此前全库无任何代码 set 它。此端点是该 flag 的唯一写入点（owner 在安全中心 switch 触发）。
  router.post("/api/security/mcp-approve", requireOwner, async (req, res) => {
    try {
      const { username } = await getUserByReq(req);
      const body = req.body || {};
      // 兼容 SEC-T11 switch 的 { [pluginName]: bool }，也接受显式 { pluginName, approved }
      let pluginName = body.pluginName;
      let approved = body.approved;
      if (!pluginName) {
        const _k = Object.keys(body).find((k) => k.startsWith("mcp_"));
        if (_k) { pluginName = _k; approved = body[_k]; }
      }
      const _safe = confineSegment(String(pluginName || ""));
      if (!_safe || !_safe.startsWith("mcp_")) {
        return res.status(400).json({ success: false, error: "非法 pluginName（须为 mcp_ 前缀插件）" });
      }
      const _wantApproved = approved === true;
      const _dataPath = path.join(getUserDictionary(username), "plugins", _safe, "data.json");
      let _d;
      try { _d = JSON.parse(fs.readFileSync(_dataPath, "utf-8")); }
      catch { return res.status(404).json({ success: false, error: "MCP 插件不存在或 data.json 不可读" }); }
      _d._mcpApproved = _wantApproved;
      saveJsonFile(_dataPath, _d);
      // 重载插件 → 重跑 Load/initializeMCP：批准则按 command spawn，撤销则下次不 spawn
      try { await reloadPart(username, "plugins/" + _safe); }
      catch (e) { console.warn("[security/mcp-approve] reloadPart 失败:", e?.message); }
      console.warn(`[SEC-MCP] 用户 ${username} ${_wantApproved ? "批准" : "撤销"}命令型 MCP server ${_safe}（command: ${_d?.config?.command}）`);
      res.json({ success: true, [_safe]: _wantApproved });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- SEC-MCP：枚举命令型 MCP server 的批准态（供「MCP Servers 面板」就近批准）----
  //   仅命令型(config.command)需批准——会 spawn 宿主进程执行命令(RCE 面)，默认被
  //   Template/main.mjs 的 _mcpApproved 闸拦下不 spawn；url 型不 spawn 本机进程，不列入。
  //   与 POST /api/security/mcp-approve 同口径(pluginName=插件目录名 mcp_*)。
  router.get("/api/security/mcp-servers", authenticate, async (req, res) => {
    try {
      const { username } = await getUserByReq(req);
      const servers = [];
      if (username) {
        const _pluginsDir = path.join(getUserDictionary(username), "plugins");
        let _entries = [];
        try { _entries = fs.readdirSync(_pluginsDir, { withFileTypes: true }); } catch { _entries = []; }
        for (const _e of _entries) {
          if (!_e.isDirectory() || !_e.name.startsWith("mcp_")) continue;
          let _d = null;
          try { _d = JSON.parse(fs.readFileSync(path.join(_pluginsDir, _e.name, "data.json"), "utf-8")); } catch { continue; }
          if (!_d?.config?.command) continue; // 仅命令型需批准
          servers.push({
            pluginName: _e.name,
            name: _d.name || _e.name,
            command: _d.config.command,
            args: Array.isArray(_d.config.args) ? _d.config.args : [],
            approved: _d._mcpApproved === true,
          });
        }
      }
      res.json({ success: true, servers });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- SEC-T12：change-prompt 模板 ${} eval 开关 — 读/写 config.allowPromptEval 并持久化 ----
  //   仅 server 部署有意义（local 恒放行）；env BEILU_PROMPT_EVAL=on 为最高优先强制放行。
  //   gate 实现在 serviceGenerators/AI/change-prompt/main.mjs（_promptEvalAllowed）。
  router.get("/api/security/prompt-eval", authenticate, async (req, res) => {
    try {
      res.json({
        success: true,
        allowPromptEval: config?.allowPromptEval === true,
        deployMode: getDeployMode(),
        envForcedOn: String(process.env.BEILU_PROMPT_EVAL || "").toLowerCase() === "on",
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/prompt-eval", requireOwner, async (req, res) => {
    try {
      const { allowPromptEval } = req.body || {};
      if (typeof allowPromptEval !== "boolean") {
        return res.status(400).json({ success: false, error: "allowPromptEval 必须为布尔值" });
      }
      config.allowPromptEval = allowPromptEval;
      let _persisted = true;
      try { save_config(); }
      catch (e) { _persisted = false; console.warn("[security/prompt-eval] 持久化失败:", e?.message); }
      res.json({ success: true, persisted: _persisted, allowPromptEval: config.allowPromptEval });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- SEC-T13：用户插件子进程 spawn 开关 — 读/写 config.allowUserPluginSpawn 并持久化 ----
  //   仅 server 部署有意义（local 恒放行）；env BEILU_USER_PLUGIN_SPAWN=on 为最高优先强制放行。
  //   gate 实现在 plugins/beilu-plugin-host/process_manager.mjs（_userPluginSpawnAllowed）。
  router.get("/api/security/user-plugin-spawn", authenticate, async (req, res) => {
    try {
      res.json({
        success: true,
        allowUserPluginSpawn: config?.allowUserPluginSpawn === true,
        deployMode: getDeployMode(),
        envForcedOn: String(process.env.BEILU_USER_PLUGIN_SPAWN || "").toLowerCase() === "on",
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/user-plugin-spawn", requireOwner, async (req, res) => {
    try {
      const { allowUserPluginSpawn } = req.body || {};
      if (typeof allowUserPluginSpawn !== "boolean") {
        return res.status(400).json({ success: false, error: "allowUserPluginSpawn 必须为布尔值" });
      }
      config.allowUserPluginSpawn = allowUserPluginSpawn;
      let _persisted = true;
      try { save_config(); }
      catch (e) { _persisted = false; console.warn("[security/user-plugin-spawn] 持久化失败:", e?.message); }
      res.json({ success: true, persisted: _persisted, allowUserPluginSpawn: config.allowUserPluginSpawn });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- FT7：CSP 用户开关 — 读/写 config.csp_enabled 并持久化 ----
  router.get("/api/security/csp", authenticate, async (req, res) => {
    try {
      res.json({
        success: true,
        enabled: config?.csp_enabled !== false,
        envForcedOff: process.env.BEILU_CSP === "off",
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/csp", requireOwner, async (req, res) => {
    try {
      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ success: false, error: "enabled 必须为布尔值" });
      }
      config.csp_enabled = enabled;
      let _persisted = true;
      try {
        save_config();
      } catch (e) {
        _persisted = false;
        console.warn("[security/csp] 持久化失败:", e?.message);
      }
      res.json({
        success: true,
        persisted: _persisted,
        enabled: config.csp_enabled,
        envForcedOff: process.env.BEILU_CSP === "off",
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- 请求日志：重复聚合、来源字段和静默规则均由 owner 配置，middleware 实时读取 ----
  router.get("/api/diagnostics/request-log", authenticate, async (req, res) => {
    try {
      const repeatWindowMs = Number(config?.request_log_repeat_window_ms);
      if (!Number.isFinite(repeatWindowMs)) {
        throw new Error("request_log_repeat_window_ms 配置无效");
      }
      if (typeof config?.request_log_include_source !== "boolean") {
        throw new Error("request_log_include_source 配置无效");
      }
      res.json({
        success: true,
        repeatWindowMs,
        includeSource: config.request_log_include_source,
        silentPatterns: Array.isArray(config?.request_log_silent_patterns)
          ? config.request_log_silent_patterns
          : [],
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/diagnostics/request-log", requireOwner, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      let repeatWindowMs = Number(config?.request_log_repeat_window_ms);
      let includeSource = config?.request_log_include_source;
      if (!Number.isFinite(repeatWindowMs)) {
        return res.status(500).json({ success: false, error: "request_log_repeat_window_ms 配置无效" });
      }
      if (typeof includeSource !== "boolean") {
        return res.status(500).json({ success: false, error: "request_log_include_source 配置无效" });
      }
      let silentPatterns = Array.isArray(config?.request_log_silent_patterns)
        ? [...config.request_log_silent_patterns]
        : [];
      if (Object.hasOwn(body, "repeatWindowMs")) {
        const value = Number(body.repeatWindowMs);
        if (!Number.isFinite(value) || value < 0 || value > 60000) {
          return res.status(400).json({ success: false, error: "repeatWindowMs 必须是 0 到 60000 的数字" });
        }
        repeatWindowMs = Math.round(value);
      }
      if (Object.hasOwn(body, "includeSource")) {
        if (typeof body.includeSource !== "boolean") {
          return res.status(400).json({ success: false, error: "includeSource 必须为布尔值" });
        }
        includeSource = body.includeSource;
      }
      if (Object.hasOwn(body, "silentPatterns")) {
        if (!Array.isArray(body.silentPatterns) || body.silentPatterns.length > 200) {
          return res.status(400).json({ success: false, error: "silentPatterns 必须是不超过 200 项的字符串数组" });
        }
        const patterns = [];
        for (const raw of body.silentPatterns) {
          if (typeof raw !== "string" || raw.length > 500) {
            return res.status(400).json({ success: false, error: "每条静默规则必须是长度不超过 500 的字符串" });
          }
          const source = raw.trim();
          if (!source) continue;
          try { new RegExp(source); }
          catch (error) {
            return res.status(400).json({ success: false, error: `无效正则 ${JSON.stringify(source)}: ${error.message}` });
          }
          if (!patterns.includes(source)) patterns.push(source);
        }
        silentPatterns = patterns;
      }
      const previous = {
        repeatWindowMs: config.request_log_repeat_window_ms,
        includeSource: config.request_log_include_source,
        silentPatterns: config.request_log_silent_patterns,
      };
      try {
        config.request_log_repeat_window_ms = repeatWindowMs;
        config.request_log_include_source = includeSource;
        config.request_log_silent_patterns = silentPatterns;
        save_config();
      } catch (error) {
        config.request_log_repeat_window_ms = previous.repeatWindowMs;
        config.request_log_include_source = previous.includeSource;
        config.request_log_silent_patterns = previous.silentPatterns;
        throw error;
      }
      const { flushRequestLogAggregation } = await import("./middleware.mjs");
      flushRequestLogAggregation();
      res.json({
        success: true,
        repeatWindowMs,
        includeSource,
        silentPatterns,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- EXT-CORS：/api/v1 外部接口跨域白名单 — 读/写 config.cors_allowed_origins 并持久化 ----
  //   设计权威：外部接口_设计 §7.3 + 凛倾拍板 2026-06-12「白名单只要空白的，交给用户」。
  //   默认 [] = 拒绝所有外部 origin（安全默认）；用户在此显式添加可信外部网页 origin。
  //   生效点：middleware.mjs 全局 Origin 中间件（grep `EXT-CORS`），命中即回显 CORS 头 + 处理预检。
  //   全程离线：纯本地 config 读写，无任何外网依赖。
  router.get("/api/security/cors-origins", authenticate, async (req, res) => {
    try {
      const origins = Array.isArray(config?.cors_allowed_origins) ? config.cors_allowed_origins : [];
      res.json({ success: true, origins });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/cors-origins", requireOwner, async (req, res) => {
    try {
      const { origins } = req.body || {};
      if (!Array.isArray(origins)) {
        return res.status(400).json({ success: false, error: "origins 必须为字符串数组" });
      }
      // 规范化：去空白、去重、仅保留合法 origin（scheme://host[:port]，无路径），防误填整 URL。
      const cleaned = [];
      for (const raw of origins) {
        if (typeof raw !== "string") continue;
        const s = raw.trim();
        if (!s) continue;
        try {
          const u = new URL(s);
          const norm = u.origin; // 例如 https://my-game.com:443 → https://my-game.com:443（标准化）
          if (norm && norm !== "null" && !cleaned.includes(norm)) cleaned.push(norm);
        } catch {
          // 非法 origin 直接丢弃（不抛错，容错用户输入）
        }
      }
      config.cors_allowed_origins = cleaned;
      let _persisted = true;
      try {
        save_config();
      } catch (e) {
        _persisted = false;
        console.warn("[security/cors-origins] 持久化失败:", e?.message);
      }
      res.json({ success: true, persisted: _persisted, origins: config.cors_allowed_origins });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // SEC-T11：安全中心可配置项的服务端 GET/POST 端点（照 /api/security/csp 模板）
  //   全部 authenticate + 写 config.json / beilu-files-settings.json 持久化。
  //   写后即被对应 reader 读到（registration→checkRegistrationGate，deployMode→path_confine.getDeployMode，
  //   allowChannelBExec→ideClient._loadCommandGateConfig，gitRestoreMultiUser→主 AI 后续在 setDataActions 接 enforcement）。
  // ============================================================

  // ---- T3 注册门：读/写 config.registration ----
  router.get("/api/security/registration", authenticate, async (req, res) => {
    try {
      const envRaw = (process.env.BEILU_REGISTRATION || "").trim().toLowerCase();
      const envForced = ["open", "closed", "invite"].includes(envRaw);
      const cfg = (config?.registration || "open").toString().trim().toLowerCase();
      res.json({
        success: true,
        registration: ["open", "closed", "invite"].includes(cfg) ? cfg : "open",
        envForced,
        envValue: envForced ? envRaw : null,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/registration", requireOwner, async (req, res) => {
    try {
      const { registration } = req.body || {};
      const v = String(registration ?? "").trim().toLowerCase();
      if (!["open", "closed", "invite"].includes(v)) {
        return res.status(400).json({ success: false, error: "registration 必须为 open/invite/closed" });
      }
      config.registration = v;
      let _persisted = true;
      try { save_config(); } catch (e) { _persisted = false; console.warn("[security/registration] 持久化失败:", e?.message); }
      const envRaw = (process.env.BEILU_REGISTRATION || "").trim().toLowerCase();
      res.json({
        success: true,
        persisted: _persisted,
        registration: config.registration,
        envForced: ["open", "closed", "invite"].includes(envRaw),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- T2 部署模式：读/写 config.deployMode（path_confine.getDeployMode 已加 config 回退）----
  router.get("/api/security/deploy-mode", authenticate, async (req, res) => {
    try {
      const envRaw = (process.env.BEILU_DEPLOY_MODE || "").trim().toLowerCase();
      const envForced = envRaw === "local" || envRaw === "server";
      const cfg = String(config?.deployMode ?? "").trim().toLowerCase();
      res.json({
        success: true,
        deployMode: getDeployMode(),                       // 真实生效值（env > config > local）
        configValue: cfg === "server" ? "server" : "local", // config 持久化值
        envForced,
        envValue: envForced ? envRaw : null,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/deploy-mode", requireOwner, async (req, res) => {
    try {
      const { deployMode } = req.body || {};
      const v = String(deployMode ?? "").trim().toLowerCase();
      if (v !== "local" && v !== "server") {
        return res.status(400).json({ success: false, error: "deployMode 必须为 local/server" });
      }
      config.deployMode = v;
      let _persisted = true;
      try { save_config(); } catch (e) { _persisted = false; console.warn("[security/deploy-mode] 持久化失败:", e?.message); }
      res.json({
        success: true,
        persisted: _persisted,
        deployMode: getDeployMode(),
        configValue: config.deployMode,
        envForced: ["local", "server"].includes((process.env.BEILU_DEPLOY_MODE || "").trim().toLowerCase()),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- T10 git 恢复多用户开关：读/写 config.gitRestoreMultiUser（仅写配置+展示，enforcement 待主 AI 接）----
  router.get("/api/security/git-restore-multiuser", authenticate, async (req, res) => {
    try {
      res.json({ success: true, gitRestoreMultiUser: config?.gitRestoreMultiUser === true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/git-restore-multiuser", requireOwner, async (req, res) => {
    try {
      const { gitRestoreMultiUser } = req.body || {};
      if (typeof gitRestoreMultiUser !== "boolean") {
        return res.status(400).json({ success: false, error: "gitRestoreMultiUser 必须为布尔值" });
      }
      config.gitRestoreMultiUser = gitRestoreMultiUser;
      let _persisted = true;
      try { save_config(); } catch (e) { _persisted = false; console.warn("[security/git-restore-multiuser] 持久化失败:", e?.message); }
      res.json({ success: true, persisted: _persisted, gitRestoreMultiUser: config.gitRestoreMultiUser });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- SEC-AL：安全审计日志开关 ----
  router.get("/api/security/audit-log", authenticate, async (req, res) => {
    try {
      const cfg = config.auditLog || {};
      res.json({ success: true, enabled: cfg.enabled === true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  router.post("/api/security/audit-log", requireOwner, async (req, res) => {
    try {
      const { enabled } = req.body || {};
      if (!config.auditLog) config.auditLog = {};
      if (typeof enabled === "boolean") config.auditLog.enabled = enabled;
      let _persisted = true;
      try { save_config(); } catch (e) { _persisted = false; console.warn("[security] save_config failed:", e?.message); }
      // 运行时立即生效：更新 whitebox auditConfig
      const { setAuditConfig } = await import("../whitebox.mjs");
      setAuditConfig({ enabled: config.auditLog.enabled, dir: __dirname + "/data/audit" });
      res.json({ success: true, persisted: _persisted, enabled: config.auditLog.enabled });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- SEC-GC：AI 生成并发上限开关 ----
  router.get("/api/security/gen-concurrency", authenticate, async (req, res) => {
    try {
      const cfg = config.genConcurrency || {};
      res.json({ success: true, enabled: cfg.enabled === true, max: cfg.max || 10 });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  router.post("/api/security/gen-concurrency", requireOwner, async (req, res) => {
    try {
      const { enabled, max } = req.body || {};
      if (!config.genConcurrency) config.genConcurrency = {};
      if (typeof enabled === "boolean") config.genConcurrency.enabled = enabled;
      if (typeof max === "number" && max > 0) config.genConcurrency.max = max;
      let _persisted = true;
      try { save_config(); } catch (e) { _persisted = false; console.warn("[security] save_config failed:", e?.message); }
      res.json({ success: true, persisted: _persisted, enabled: config.genConcurrency.enabled, max: config.genConcurrency.max || 10 });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- SEC-RL：v1 API 速率限制开关 ----
  router.get("/api/security/v1-rate-limit", authenticate, async (req, res) => {
    try {
      const cfg = config.v1RateLimit || {};
      res.json({ success: true, enabled: cfg.enabled === true, perKeyPerMin: cfg.perKeyPerMin || 120 });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  router.post("/api/security/v1-rate-limit", requireOwner, async (req, res) => {
    try {
      const { enabled, perKeyPerMin } = req.body || {};
      if (!config.v1RateLimit) config.v1RateLimit = {};
      if (typeof enabled === "boolean") config.v1RateLimit.enabled = enabled;
      if (typeof perKeyPerMin === "number" && perKeyPerMin > 0) config.v1RateLimit.perKeyPerMin = perKeyPerMin;
      let _persisted = true;
      try { save_config(); } catch (e) { _persisted = false; console.warn("[security] save_config failed:", e?.message); }
      res.json({ success: true, persisted: _persisted, enabled: config.v1RateLimit.enabled, perKeyPerMin: config.v1RateLimit.perKeyPerMin || 120 });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- T5 命令执行闸 allowChannelBExec：读/写 data/beilu-files-settings.json commandGate 段 ----
  //   reader = ideClient._loadCommandGateConfig（读同一文件同一字段）。本处只读写 JSON，不碰其代码。
  router.get("/api/security/command-gate", authenticate, async (req, res) => {
    try {
      res.json({ success: true, ...(await _readCommandGate()) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  router.post("/api/security/command-gate", requireOwner, async (req, res) => {
    try {
      const { allowChannelBExec, failClosedUnknown } = req.body || {};
      if (allowChannelBExec === undefined && failClosedUnknown === undefined) {
        return res.status(400).json({ success: false, error: "至少提供 allowChannelBExec / failClosedUnknown 之一" });
      }
      if (allowChannelBExec !== undefined && typeof allowChannelBExec !== "boolean") {
        return res.status(400).json({ success: false, error: "allowChannelBExec 必须为布尔值" });
      }
      if (failClosedUnknown !== undefined && typeof failClosedUnknown !== "boolean") {
        return res.status(400).json({ success: false, error: "failClosedUnknown 必须为布尔值" });
      }
      const out = await _writeCommandGate({ allowChannelBExec, failClosedUnknown });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- 命令安全规则列表（黑/灰名单+分类默认值）：前端动态读取，不硬编码副本 ----
  router.get("/api/security/command-rules", authenticate, async (req, res) => {
    try {
      const { getCommandRulesReadable } = await import("../../yonban/core/functions/security/commandGate.mjs");
      res.json({ success: true, ...getCommandRulesReadable() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  // 0715 硬编码改选项：命令安全规则写端点（owner）。blacklist/graylist/gitPushAllowedRemotes 三键，
  // 每键：null=恢复代码默认 / 数组=整体覆盖（黑灰名单条目 {pattern(RegExp源串), flags?}，remotes 为字符串数组，"*"=不限制）。
  router.post("/api/security/command-rules", requireOwner, async (req, res) => {
    try {
      const { blacklist, graylist, gitPushAllowedRemotes, rulesEnabled } = req.body || {};
      if (blacklist === undefined && graylist === undefined && gitPushAllowedRemotes === undefined && rulesEnabled === undefined) {
        return res.status(400).json({ success: false, error: "至少提供 blacklist / graylist / gitPushAllowedRemotes / rulesEnabled 之一" });
      }
      if (rulesEnabled !== undefined && typeof rulesEnabled !== "boolean") {
        return res.status(400).json({ success: false, error: "rulesEnabled 必须为布尔值" });
      }
      const _validRegexList = (v, name) => {
        if (v === null) return null;
        if (!Array.isArray(v)) return `${name} 必须为数组或 null(恢复默认)`;
        for (const e of v) {
          if (!e || typeof e.pattern !== "string" || !e.pattern.trim()) return `${name} 条目缺少 pattern`;
          if (e.flags !== undefined && (typeof e.flags !== "string" || /[^gimsuy]/.test(e.flags))) return `${name} 条目 flags 非法`;
          if (e.enabled !== undefined && typeof e.enabled !== "boolean") return `${name} 条目 enabled 非法`;
          if (e.forced !== undefined && typeof e.forced !== "boolean") return `${name} 条目 forced 非法`;
          try { new RegExp(e.pattern, e.flags || "i"); } catch { return `${name} 条目不是合法正则: ${e.pattern}`; }
        }
        return null;
      };
      for (const [v, name] of [[blacklist, "blacklist"], [graylist, "graylist"]]) {
        if (v === undefined) continue;
        const err = _validRegexList(v, name);
        if (err) return res.status(400).json({ success: false, error: err });
      }
      if (gitPushAllowedRemotes !== undefined && gitPushAllowedRemotes !== null) {
        if (!Array.isArray(gitPushAllowedRemotes) || gitPushAllowedRemotes.some((r) => typeof r !== "string" || !r.trim())) {
          return res.status(400).json({ success: false, error: "gitPushAllowedRemotes 必须为非空字符串数组或 null(恢复默认)" });
        }
      }
      // 0715 开关化：条目透传 enabled（缺省 true 不落盘）/ forced（灰名单，缺省不落盘=读侧按 true 保守处理）
      const _norm = (v) => (v === undefined || v === null) ? v
        : v.map((e) => ({
            pattern: e.pattern.trim(), flags: (e.flags || "i"),
            ...(e.enabled === false ? { enabled: false } : {}),
            ...(typeof e.forced === "boolean" ? { forced: e.forced } : {}),
          }));
      await _writeCommandRules({
        blacklist: _norm(blacklist),
        graylist: _norm(graylist),
        gitPushAllowedRemotes: (gitPushAllowedRemotes === undefined || gitPushAllowedRemotes === null)
          ? gitPushAllowedRemotes : gitPushAllowedRemotes.map((r) => r.trim()),
        rulesEnabled,
      });
      // 回读 live 真值（读写同源验证：从 commandGate 读侧函数返回，不回显请求体）
      const { getCommandRulesReadable } = await import("../../yonban/core/functions/security/commandGate.mjs");
      res.json({ success: true, ...getCommandRulesReadable() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---- beilu-plugin-host：用户级插件数据推送 API（仅 localhost） ----
  // 外部插件进程通过此路由向主程序推送注入数据
  // 与 /api/eye/inject 同模式，但通用化
  router.post("/api/user-plugins/:id/push", async (req, res) => {
    try {
      // 安全检查：仅允许 localhost 访问
      if (!is_local_ip_from_req(req)) {
        return res.status(403).json({ error: "Only localhost access allowed" });
      }

      const pluginId = req.params.id;
      const token = req.headers["x-plugin-token"] || req.body?.token || "";

      // 验证插件身份
      if (!validatePluginToken(pluginId, token)) {
        console.warn(
          `[plugin-host] push 被拒绝: 无效 token (pluginId=${pluginId})`,
        );
        return res.status(401).json({ error: "Invalid plugin token" });
      }

      // 验证插件存在且正在运行
      const plugin = getUserPlugin(pluginId);
      if (!plugin) {
        return res
          .status(404)
          .json({ error: `Plugin ${pluginId} not registered` });
      }

      const { content, hook_target, position, ttl } = req.body || {};
      if (!content) {
        return res.status(400).json({ error: "Missing content field" });
      }

      setUserPluginPending(pluginId, {
        content,
        hook_target: hook_target || "GetPrompt",
        position: position || "system_bottom",
        ttl: ttl || undefined,
      });

      console.log(
        `[plugin-host] 收到插件 ${pluginId} 的数据推送 (${content.length} chars)`,
      );
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("[plugin-host/push] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // 用户插件状态查询（需认证）
  router.get("/api/user-plugins/status", authenticate, async (req, res) => {
    const plugins = getAllUserPlugins().map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      error: p.error,
      port: p.port,
      hasPending: !!p.pendingInjection,
    }));
    res.status(200).json({ plugins });
  });

  // ---- 新插件首次引导 ----
  // 首次引导（_bootstrapPlugins）：新插件不在任何用户的 defaultParts 中，shallowLoadAllDefaultParts
  // 不会加载它。在此异步引导一次：loadPart 触发 Load()，Load() 调用 setDefaultPart() 完成永久注册。
  // ★ 此块不承担「每次启动拉起」：旧版 _eagerPlugins 在此无条件 loadPart 想让 beilu-cli 的 Init
  //   每次启动重跑——前提错误：Init 由磁盘 parts_init 门控=install-once（parts_loader loadPartBase:883，
  //   落 true 后重启永久跳过），loadPart 再多次调用也只跑 Load。每次启动的完整生命周期本来就由
  //   server.mjs:384 fullLoadAllParts 覆盖（已安装插件全集），CLI spawn 已迁入 beilu-cli 的 Load。
  const _bootstrapPlugins = ["beilu-plugin-host", "beilu-cli"];
  setTimeout(async () => {
    try {
      for (const user of Object.values(getAllUsers())) {
        if (!user?.username) continue;
        const existing = user?.defaultParts?.plugins || [];
        for (const pluginName of _bootstrapPlugins) {
          if (existing.includes(pluginName)) continue;
          try {
            await loadPart(user.username, `plugins/${pluginName}`);
            console.log(`[bootstrap] 首次引导: 为用户 ${user.username} 加载 ${pluginName}`);
          } catch (e) {
            console.warn(`[bootstrap] 装载失败 (user=${user.username}, plugin=${pluginName}):`, e.message);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, 3000);

  // ---- beilu-reach 首次引导 ----
  setTimeout(async () => {
    try {
      for (const user of Object.values(getAllUsers())) {
        if (!user?.username) continue;
        const existing = user?.defaultParts?.plugins || [];
        if (existing.includes("beilu-reach")) continue;
        try {
          await loadPart(user.username, "plugins/beilu-reach");
          console.log(`[beilu-reach] 首次引导: 为用户 ${user.username} 加载 beilu-reach`);
        } catch (e) {
          console.warn(`[beilu-reach] 首次引导失败 (user=${user.username}):`, e.message);
        }
      }
    } catch { /* ignore */ }
  }, 4000);
}
