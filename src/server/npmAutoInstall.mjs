/**
 * npmAutoInstall — 缺失 npm 包的运行时自动补装（单一收口模块）。
 *
 * why：便携包以 --node-modules-dir=manual(byonm) 启动（启动器注入，避免 auto 模式在目标机
 *   静默重建 .deno store 的分钟级黑窗），但 manual 同时砍掉了 deno 原生的"缺包联网自取"——
 *   用户自装插件 import 随包清单(68项)之外的 npm 包时会硬报错。本模块把该能力在框架层还原：
 *   识别缺包错误 → npm install 补装到项目根 node_modules(平铺,byonm 直读) → 调用方重试。
 *   在 auto 模式(开发机/git clone)下 deno 自己会联网取包，缺包错误形状不出现，本模块自然休眠。
 *
 * 链路：baseMjsPartLoader(parts_loader.mjs) import 失败 → extractMissingNpmPackage 识别
 *       → ensureNpmPackage 补装 → 调用方重试一次 import。
 * 约束：离线/npm 失败 = 快速失败 + 按包冷却(防对账/重载风暴)，调用方回到原有报错降级路径。
 * 环境：npm 可执行来自 PATH（便携包由启动器铺入 runtime\node；Linux/mac 用系统 npm）。
 */
import { fileURLToPath } from "node:url";

import { wbTrace, wbDetect } from "./whitebox.mjs";

// 本文件在 src/server/ 下,项目根在两层之上。Deno.Command 的 cwd 要字符串路径,不能传 URL。
const _projectRoot = fileURLToPath(new URL("../../", import.meta.url));

// deno 缺包错误的两种形状（deno 2.9 实测）：
//   byonm 包内依赖: Could not find package 'X' from referrer '...'
//   byonm 顶层请求: Could not find a matching package for 'npm:X@ver' in the node_modules directory
const RE_FROM_REFERRER = /Could not find package '([^']+)' from referrer/;
const RE_UNMATCHED_REQ = /Could not find a matching package for 'npm:([^']+)' in the node_modules/;

/**
 * 从 import 错误中识别缺失的 npm 包。识别不出（非缺包错误）返回 null。
 * @param {unknown} err
 * @returns {string|null} 包名或 name@range（顶层请求形状带原始区间）
 */
export function extractMissingNpmPackage(err) {
  const msg = err?.message || String(err);
  const m1 = RE_FROM_REFERRER.exec(msg);
  if (m1) return m1[1];
  const m2 = RE_UNMATCHED_REQ.exec(msg);
  if (m2) return m2[1];
  return null;
}

// 并发去重 + 失败冷却（按包）。冷却期内直接返回 false，不再反复起 npm 进程刷日志。
const _installing = new Map(); // spec -> Promise<boolean>
const _failedAt = new Map();   // spec -> timestamp
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 确保某 npm 包在项目根 node_modules 可用（缺则联网 npm install）。
 * @param {string} spec - 包名或 name@range
 * @returns {Promise<boolean>} 装上（或已在）= true
 */
export function ensureNpmPackage(spec) {
  if (_installing.has(spec)) return _installing.get(spec);
  const failedAt = _failedAt.get(spec) || 0;
  if (Date.now() - failedAt < FAIL_COOLDOWN_MS) return Promise.resolve(false);
  const p = (async () => {
    console.log(`[npm-auto] 检测到缺失 npm 包，自动补装: ${spec}`);
    wbTrace(null, "parts", "npmAutoInstall:begin", { spec });
    try {
      const cmd = new Deno.Command("npm", {
        // --no-save:运行时补装只落 node_modules(byonm 只读这里),不写 package.json——
        // 项目清单(68项)是发布物单源,用户插件的包混进去会随下次同步扩散。
        args: ["install", spec, "--no-save", "--no-audit", "--no-fund"],
        cwd: _projectRoot,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr);
        wbDetect(null, "parts", "npmAutoInstall:failed", false, "npm install 失败", { spec, code: output.code, err: stderr.slice(0, 200) });
        console.warn(`[npm-auto] 补装失败 (code ${output.code}，离线或源不可达): ${spec} — ${stderr.slice(0, 200)}`);
        _failedAt.set(spec, Date.now());
        return false;
      }
      _failedAt.delete(spec);
      console.log(`[npm-auto] 补装完成: ${spec}`);
      wbTrace(null, "parts", "npmAutoInstall:done", { spec });
      return true;
    } catch (e) {
      wbDetect(null, "parts", "npmAutoInstall:error", false, "npm 进程异常", { spec, err: e?.message || String(e) });
      console.warn(`[npm-auto] 补装异常(npm 不可用?): ${spec} — ${e?.message?.slice(0, 200)}`);
      _failedAt.set(spec, Date.now());
      return false;
    } finally {
      _installing.delete(spec);
    }
  })();
  _installing.set(spec, p);
  return p;
}
