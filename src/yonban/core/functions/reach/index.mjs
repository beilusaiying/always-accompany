/**
 * index.mjs — beilu-reach dispatch 注册
 *
 * 【功能链】
 *   本文件 import 时注册 "functions:reach" 节点 →
 *   dispatcher 可派发 search/read/doctor verb →
 *   executeWebSearch 平台路由钩子通过 dispatch 调用本节点。
 *
 * 【关联链】
 *   ← main.mjs（插件 ReplyHandler 也可直接 import executeReach）
 *   → registry.mjs（PLATFORM_REGISTRY）
 *   → adapters/*（惰性 import）
 */

import { register } from "../../dispatch/registry.mjs";
import { executeReach } from "./execute.mjs";
import { runDoctor } from "./doctor.mjs";

export { executeReach };

register("functions:reach", {
  transport: "local",
  contributes: {
    tags: ["reach"],
  },
  handlers: {
    async search(payload) {
      const { platform, query, limit, ...rest } = payload || {};
      if (!platform) return { ok: false, error: "missing platform" };
      try {
        const data = await executeReach(platform, "search", query, { limit, ...rest });
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async read(payload) {
      const { platform, action, query, ...rest } = payload || {};
      if (!platform) return { ok: false, error: "missing platform" };
      try {
        const data = await executeReach(platform, action || "read", query, rest);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async doctor() {
      return { ok: true, data: await runDoctor(true) };
    },
  },
});
