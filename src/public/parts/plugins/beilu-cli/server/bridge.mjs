/**
 * bridge.mjs — 接入 ideClient.mjs 的桥接模块
 *
 * 接入方式：在 ideClient.mjs 的 callTool() 中，当 !this.isConnected 时，
 * 路由到本模块的 executeLocally() 代替返回 "IDE 未连接" 错误。
 *
 * 使用方法：
 *   import { createLocalExecutor } from "<path>/bridge.mjs";
 *   const localExec = createLocalExecutor(workspaceRoot);
 *   // 在 callTool 中：
 *   if (!this.isConnected && localExec) {
 *     return await localExec.execute(tool, params);
 *   }
 *
 * 结果格式与 YonBan WS tool_result 完全对齐：
 *   { success, result?, error?, resolvedPath? }
 */
import { ToolExecutor } from "./executor.mjs";

let _instance = null;

export function createLocalExecutor(workspaceRoot) {
  if (_instance && _instance._wsRoot === workspaceRoot) return _instance;
  const executor = new ToolExecutor(workspaceRoot);
  _instance = {
    _wsRoot: workspaceRoot,
    _executor: executor,

    async execute(tool, params = {}) {
      const id = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await executor.execute({ id, tool, params });
      return {
        success: result.success,
        result: result.result,
        error: result.error,
        resolvedPath: result.resolvedPath,
        failedFiles: result.failedFiles,
        _hint: result._hint,
        _debug: result._debug,
      };
    },

    getToolList() {
      return executor.getToolList();
    },

    getCheckpoint() {
      return executor.checkpoint;
    },
  };
  return _instance;
}

export function getLocalExecutor() {
  return _instance;
}

/**
 * 接入指南 — 修改 ideClient.mjs 的 callTool 方法：
 *
 * 在 line 1068 的 `if (!this.isConnected)` 块中，把：
 *   return { success: false, error: "IDE 未连接" };
 *
 * 改为：
 *   // CLI 本地执行器回退
 *   const { getLocalExecutor } = await import("<path>/bridge.mjs");
 *   const local = getLocalExecutor();
 *   if (local) {
 *     return await local.execute(tool, params);
 *   }
 *   return { success: false, error: "IDE 未连接且 CLI 执行器未初始化" };
 *
 * 初始化（server.mjs 或启动段）：
 *   import { createLocalExecutor } from "<path>/bridge.mjs";
 *   createLocalExecutor(workspaceRoot);
 */
