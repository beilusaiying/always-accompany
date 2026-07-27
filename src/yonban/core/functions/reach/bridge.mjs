/**
 * bridge.mjs — CLI 桥接通用层
 *
 * 所有 CLI 类平台适配器通过本模块 spawn 外部命令。
 * 统一：超时控制 / 输出解析 / 错误归类 / 安全参数传递。
 *
 * 【安全】args 严格数组传入 Deno.Command，禁 shell: true，防命令注入。
 *
 * cliTimeout/proxyUrl 收口：本模块是所有 CLI 适配器必经点，用户配置的默认超时与
 * 代理在此统一生效（适配器显式传 timeout/env 时优先——平台知识覆盖全局默认）。
 */

import { getReachConfig } from "./config.mjs";
import { wbT, wbD } from "../../../../server/wbStub.mjs"; // 白盒：CLI 执行是 reach 链最外部环节，成败/退出码可观测

const _isWindows = typeof Deno !== "undefined"
  ? Deno.build.os === "windows"
  : process.platform === "win32";

/**
 * 执行外部 CLI 命令并返回输出。
 * @param {string} cmd - 命令名（PATH 上）
 * @param {string[]} args - 参数数组（严格参数化，不经 shell）
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000] - 超时 ms
 * @param {"text"|"json"|"lines"} [opts.parseAs="text"] - 输出解析模式
 * @param {Record<string,string>} [opts.env] - 额外环境变量
 * @param {string} [opts.stdin] - 写入 stdin 的数据
 * @returns {Promise<{ok:boolean, data:any, stderr:string, code:number}>}
 */
export async function execCLI(cmd, args, opts = {}) {
  const _cfg = getReachConfig();
  const { timeout = _cfg.cliTimeout || 30000, parseAs = "text", stdin, quiet = false } = opts;
  // proxyUrl → 标准代理 env（Twitter/Reddit 等 CLI 认 HTTP(S)_PROXY）；适配器自带 env 优先
  let env = opts.env;
  if (_cfg.proxyUrl) {
    env = { HTTP_PROXY: _cfg.proxyUrl, HTTPS_PROXY: _cfg.proxyUrl, ...(env || {}) };
  }

  // quiet=观测降噪（probeCommand 探测预期性失败不刷 fail），不改变任何执行语义
  if (!quiet) wbT(null, "reach:cli", "exec", { cmd, args: args.slice(0, 4).join(" ").slice(0, 120), timeout });
  try {
    const r = (typeof Deno !== "undefined" && Deno.Command)
      ? await _execDeno(cmd, args, { timeout, parseAs, env, stdin })
      : await _execNode(cmd, args, { timeout, parseAs, env, stdin });
    if (!r.ok && !quiet) wbD(null, "reach:cli", "exec.fail", false, (r.stderr || "").slice(0, 160), { cmd, code: r.code });
    return r;
  } catch (err) {
    if (!quiet) wbD(null, "reach:cli", "exec.throw", false, err.message, { cmd, code: err.code });
    return {
      ok: false,
      data: null,
      stderr: err.message,
      code: err.code === "ENOENT" ? -1 : (err.code === "EPERM" ? -2 : -99),
    };
  }
}

async function _execDeno(cmd, args, { timeout, parseAs, env, stdin }) {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: stdin ? "piped" : "null",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });

  const child = command.spawn();

  if (stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }

  const timer = timeout > 0
    ? setTimeout(() => { try { child.kill(); } catch {} }, timeout)
    : null;

  const result = await child.output();
  if (timer) clearTimeout(timer);

  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  const code = result.code;

  if (code !== 0) return { ok: false, data: stdout, stderr, code };
  return { ok: true, data: _parse(stdout, parseAs), stderr, code };
}

async function _execNode(cmd, args, { timeout, parseAs, env, stdin }) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = execFile(cmd, args, {
      timeout,
      encoding: "utf-8",
      env: env ? { ...process.env, ...env } : undefined,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          data: (stdout || "").trim(),
          stderr: err.message,
          code: err.code === "ENOENT" ? -1 : (err.code === "EPERM" ? -2 : (err.code || -99)),
        });
        return;
      }
      resolve({ ok: true, data: _parse((stdout || "").trim(), parseAs), stderr: (stderr || "").trim(), code: 0 });
    });
    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

function _parse(raw, parseAs) {
  if (!raw) return parseAs === "json" ? null : (parseAs === "lines" ? [] : "");
  if (parseAs === "json") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (parseAs === "lines") return raw.split("\n").filter(Boolean);
  return raw;
}

/**
 * 探测命令是否可用。
 * @param {string} cmd
 * @param {string[]} [testArgs=["--version"]]
 * @returns {Promise<{status:"ok"|"missing"|"blocked"|"error", version?:string, message?:string}>}
 */
export async function probeCommand(cmd, testArgs = ["--version"]) {
  const r = await execCLI(cmd, testArgs, { timeout: 5000, quiet: true });
  if (r.ok) return { status: "ok", version: (r.data || "").split("\n")[0] };
  if (r.code === -1) return { status: "missing", message: `${cmd} not found in PATH` };
  if (r.code === -2) return { status: "blocked", message: `${cmd} blocked by security software` };
  return { status: "error", message: r.stderr || r.data || "unknown error" };
}
