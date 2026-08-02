/**
 * hintTexts.ts — IDE 工具结果/错误提示文本单源（2026-07-08 链路3·代码零提示词方向）。
 *
 * why：凛倾裁决「提示词一旦出现那么就是有问题的.因为提示词只有用户可以选择+做」——
 *   这批 hint 随 tool_result 的 _hint 字段回喂 AI（ToolExecutor.ts:212 挂载 →
 *   beilu replyHandler 拼进 [工具执行结果]），属 AI 可见指令文本，此前逐字写死在
 *   tool-infra.ts getResultHint/getErrorHint 的分支里，零配置槽。
 *
 * 用户可选择+可做的通道（VSCode settings.json）：
 *   - yonban.hints.enabled（boolean，默认 true）：false = 整体不附加任何 hint
 *   - yonban.hints.overrides（object）：按下表键逐条覆盖文本；占位符 {n}/{error}/{sites}/{layer} 保留
 * 条件分支（何时给哪条）是诊断逻辑归代码域；文本内容全部收敛于此，原样迁移未改一字。
 */

export const HINT_TEXTS: Record<string, string> = {
  // search_files
  "search_files.empty": "没有匹配结果。检查：关键词拼写是否正确？路径是绝对路径吗？正则特殊字符需要转义吗？",
  "search_files.found": "找到 {n} 处匹配。如需修改，先 read_file 读取目标文件再 fuzzy_edit。",
  // search_by_name
  "search_by_name.empty": "没有匹配的文件。检查：glob模式是否正确？路径是绝对路径吗？试试 search_files 搜文件内容作为替代。",
  "search_by_name.found": "找到 {n} 个文件。",
  // get_diagnostics
  "get_diagnostics.empty": "没有诊断信息 = 代码没有错误。这是正确结果，不是工具故障。",
  "get_diagnostics.found": "发现 {n} 条诊断信息，检查 errors/warnings 详情。",
  // lint_code
  "lint_code.layer_failed": " ⚠️ ESLint 规则层失效（{layer}）——no-undef/no-unreachable 等规则未生效，结果仅含语法+LSP 检查。",
  "lint_code.layer_unavailable": " 注：本机无 ESLint，第3层规则检查跳过（{layer}）。",
  "lint_code.errors": "发现 {n} 个错误、{w} 个警告，见 messages 详情。修复 errors 后再继续。",
  "lint_code.warnings": "发现 {n} 个警告（0 错误），见 messages 详情。",
  "lint_code.clean": "静态分析通过，没有发现问题。空结果 = 代码正确。",
  // goto_definition / find_references
  "goto_definition.not_found": "Language Server可能还没加载完。替代方案：用 search_files pattern=\"function 函数名\" 搜索定义位置。",
  "find_references.empty": "没有找到引用。可能是LS未加载完。替代方案：用 search_files pattern=\"函数名(\" 搜调用点。",
  "find_references.found": "找到 {n} 处引用。修改函数签名前确认这些调用点都要同步修改。",
  // get_status / get_project_summary / smart_search
  "get_status.empty": "工作区信息为空，IDE可能还在初始化。",
  "get_project_summary.empty": "项目信息为空。尝试 list_files recursive=true 查看目录结构。",
  "smart_search.empty": "没有搜索结果。建议直接用 search_files（更可靠）或检查路径是否正确。",
  // write_file
  "write_file.verify_failed": "⚠️ 写入验证失败，文件内容可能不正确，用 read_file 确认。",
  "write_file.syntax_error": "⚠️ 语法错误！请立即 read_file 查看并修复，不要继续下一步。错误: {error}",
  "write_file.ok": "写入成功，语法检查通过。",
  // fuzzy_edit
  "fuzzy_edit.no_match": "匹配失败。请重新 read_file 读取文件当前内容，从结果中精确复制 old_string 后重试。",
  "fuzzy_edit.syntax_error": "⚠️ 语法错误！立即修复: {error}",
  "fuzzy_edit.call_sites": "发现 {n} 处调用，检查是否需要同步修改: {sites}",
  "fuzzy_edit.ok": "修改成功，语法检查通过。",
  // replace_lines / insert_at_line
  "line_edit.syntax_error": "⚠️ 语法错误！立即修复: {error}",
  "line_edit.ok": "操作成功，语法检查通过。",
  // run_command / run_script
  "run.exit_nonzero": "命令退出码 {n}（非0=有错误）。检查 stderr 输出了解原因。",
  // ---- 错误提示（getErrorHint）----
  "err.file_not_found": "检查路径是否正确。必须用绝对路径（D:\\\\...），不要用相对路径。",
  "err.dir_not_found": "检查目录路径。用 list_files 确认目录结构。",
  "err.missing_param": "检查标签格式：<ideToolCall tool=\"工具名\" 参数=\"值\" />，确保所有必需参数都有。",
  "err.old_string_mismatch": "old_string 和文件实际内容不一致。请重新 read_file 读取文件，从结果中精确复制要修改的部分。",
  "err.fuzzy_edit": "先 read_file 确认文件当前内容，再重新构造 old_string。",
  "err.run_command": "Windows cmd.exe 会吃掉双引号（python -c \"...\"、含中文路径的 copy 等易翻车）。改用 run_script 工具(lang+code)把脚本落临时文件执行，彻底绕开内联引号问题。",
  "err.ls_not_loaded": "Language Server 可能未加载。替代方案：search_files pattern=\"关键词\"",
};

let _vscodeConf: (() => { enabled: boolean; overrides: Record<string, string> }) | null = null;

/** 惰性读 VSCode 配置（tool-infra 是纯函数层，测试/非 VSCode 环境拿不到 API 时回默认） */
function readConf(): { enabled: boolean; overrides: Record<string, string> } {
  if (!_vscodeConf) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscode = require("vscode");
      _vscodeConf = () => {
        const c = vscode.workspace.getConfiguration("yonban.hints");
        return {
          enabled: (c.get("enabled", true)) as boolean,
          overrides: ((c.get("overrides", {}) || {}) as Record<string, string>),
        };
      };
    } catch {
      _vscodeConf = () => ({ enabled: true, overrides: {} });
    }
  }
  return _vscodeConf();
}

/**
 * 取 hint 文本：用户 overrides 逐键覆盖 → 默认表；enabled=false 或键不存在 → null（调用方不附加）。
 * @param key HINT_TEXTS 键
 * @param vars 占位符表（{n}/{w}/{error}/{sites}/{layer}）
 */
export function hintText(key: string, vars?: Record<string, string | number>): string | null {
  const conf = readConf();
  if (!conf.enabled) return null;
  let t = typeof conf.overrides[key] === "string" && conf.overrides[key] !== "" ? conf.overrides[key] : HINT_TEXTS[key];
  if (t == null) return null;
  if (vars) for (const [k, v] of Object.entries(vars)) t = t.split(`{${k}}`).join(String(v));
  return t;
}
