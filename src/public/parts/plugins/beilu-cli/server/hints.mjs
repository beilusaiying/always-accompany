/**
 * hints.mjs — 工具结果提示文本（从 YonBan hintTexts.ts 移植）
 * [0723 禁硬编码] 提示文本单源=本体 data/beilu-cli-config.json 的 hintTexts 字段（前端可编辑）。
 *   本体 beilu-cli/main.mjs startCli 时经 env(BEILU_CLI_HINT_TEXTS) 注入本进程。
 *   优先级: 用户覆盖(env) > 内置默认(_defaults 回退)。config 改动需重启 CLI 生效(env 启动时快照)。
 *   why: 002 原话「禁止硬编码,用户可设置一切」——原直接返回硬编码 _defaults,用户无法自定义。
 */

// 内置默认（fallback：env 未注入/该键无覆盖时用）
const _defaults = {
  read_file_success: "",
  write_file_success: "",
  search_files_no_match: "没有找到匹配项。尝试调整搜索模式或扩大搜索范围。",
  search_by_name_no_match: "没有找到匹配的文件名。尝试使用更宽泛的模式。",
  run_command_timeout: "命令执行超时。考虑缩小操作范围或增加超时。",
  fuzzy_edit_fallback: "",
  error_path_outside: "路径不在工作区内，已拒绝。所有文件操作必须在工作区目录下。",
  error_file_too_large: "文件过大，已跳过。",
  error_command_blocked: "该命令被安全策略阻止。",
  error_special_chars: "命令或路径含特殊字符（&|<>^等），cmd.exe 可能解析失败。请尝试用引号包裹路径，或转义特殊符号。",
};

// 用户覆盖（本体经 env 注入；解析失败静默回退默认——配置容错,非吞错）
let _overrides = {};
try {
  if (process.env.BEILU_CLI_HINT_TEXTS) {
    _overrides = JSON.parse(process.env.BEILU_CLI_HINT_TEXTS);
  }
} catch { /* 解析失败用内置默认 */ }

export function hintText(key) {
  // 用户覆盖优先（仅接受 string），否则回退内置默认
  return (typeof _overrides[key] === "string" ? _overrides[key] : _defaults[key]) || "";
}

export function getResultHint(tool, result, params) {
  if (!result) return "";
  if (tool === "search_files" && result && typeof result === "object" && result.matchCount === 0)
    return hintText("search_files_no_match");
  if (tool === "search_by_name" && result && typeof result === "object" && Array.isArray(result.files) && result.files.length === 0)
    return hintText("search_by_name_no_match");
  return "";
}

export function getErrorHint(tool, errorMessage, params) {
  if (!errorMessage) return "";
  if (errorMessage.includes("工作区") || errorMessage.includes("outside"))
    return hintText("error_path_outside");
  if (errorMessage.includes("过大") || errorMessage.includes("too large"))
    return hintText("error_file_too_large");
  if (errorMessage.includes("黑名单") || errorMessage.includes("blocked"))
    return hintText("error_command_blocked");
  return "";
}
