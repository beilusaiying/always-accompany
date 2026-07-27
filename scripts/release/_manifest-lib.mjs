// _manifest-lib.mjs — 发布清单的唯一解释器
//
// why: build-release（生产端）与 check-release（监测端）必须用同一套匹配语义，
//      否则"打包时排掉了"和"监测时算不算命中"会分叉——两套判断=散点自觉，不是机制。
// 功能链: release-manifest.json → [本模块] loadManifest/isExcluded/compileScanRules
//          → build-release.mjs（决定复制哪些）
//          → check-release.mjs（决定命中哪些）
// 关联: 规则改动只改 release-manifest.json，本模块不含任何具体路径。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadManifest(path) {
  const p = path || join(HERE, "release-manifest.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

// 路径规则 → 正则。语义（三种写法，与 .gitignore 直觉一致）：
//   "a/b/"      目录前缀 → a/b 自身及其下全部
//   "a/*.json"  单层通配 → * 不跨 /
//   "**/x"      任意深度
function ruleToRegExp(rule) {
  const dirRule = rule.endsWith("/");
  const body = dirRule ? rule.slice(0, -1) : rule;
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "*") {
      if (body[i + 1] === "*") {
        // ** → 任意深度；后随 / 时把该 / 一并吸收，使 "**/x" 也能匹配顶层 "x"
        i++;
        if (body[i + 1] === "/") { i++; re += "(?:.*/)?"; }
        else re += ".*";
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  // 目录规则：匹配目录本身或其下任意内容
  return new RegExp("^" + re + (dirRule ? "(?:/.*)?$" : "$"));
}

function compileList(list) {
  return (list || []).filter((r) => typeof r === "string" && !r.startsWith("_")).map((r) => ({ rule: r, re: ruleToRegExp(r) }));
}

// 汇总 manifest 的各组 exclude/keep。allowGroups 让 exe profile 放行运行时依赖。
export function compileExcludes(manifest, { skipGroups = [] } = {}) {
  const ex = [];
  const keep = [];
  for (const [group, cfg] of Object.entries(manifest)) {
    if (group.startsWith("_") || typeof cfg !== "object" || cfg === null) continue;
    if (!cfg.exclude && !cfg.keep) continue;
    if (skipGroups.includes(group)) continue;
    for (const e of compileList(cfg.exclude)) ex.push({ ...e, group });
    for (const k of compileList(cfg.keep)) keep.push({ ...k, group });
  }
  return { ex, keep };
}

// 返回命中的规则对象（含 group/rule），未命中返回 null。keep 优先于 exclude。
export function matchExclude({ ex, keep }, relPath) {
  const p = relPath.replace(/\\/g, "/");
  for (const k of keep) if (k.re.test(p)) return null;
  for (const e of ex) if (e.re.test(p)) return e;
  return null;
}

// 该目录下是否埋着 keep 例外。
// why: 调用方为性能对命中 exclude 的目录整棵剪枝，但那样 keep 永远没机会生效
//      （nlp/ 被排除时 nlp/tokenizer.mjs 会跟着被删 → 打断 4 个产品正路消费者）。
//      剪枝前先问这里：埋着例外就必须下钻逐文件判断。
export function hasKeepUnder({ keep }, relDir) {
  const d = relDir.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  return keep.some((k) => k.rule.replace(/\\/g, "/").startsWith(d));
}

export function compileScanRules(manifest) {
  const out = [];
  // 规则源文件自身必然含它要拦的模式字符串 → 自指豁免，并入每条规则的 allow
  const globalAllow = compileList(manifest.scanRules?._globalAllowFileGlobs);
  for (const [cat, list] of Object.entries(manifest.scanRules || {})) {
    if (cat.startsWith("_") || !Array.isArray(list)) continue;
    for (const r of list) {
      if (!r?.pattern) continue;
      out.push({
        category: cat,
        id: r.id,
        why: r.why,
        // 默认 block：新规则忘了标级别时按最严处理，宁可拦错不可放过
        severity: r.severity === "warn" ? "warn" : "block",
        re: new RegExp(r.pattern, "g"),
        allow: [...globalAllow, ...compileList(r.allowFileGlobs)],
        allowWhy: r.allowWhy,
      });
    }
  }
  return out;
}

export function isAllowedFor(rule, relPath) {
  const p = relPath.replace(/\\/g, "/");
  return rule.allow.some((a) => a.re.test(p));
}
