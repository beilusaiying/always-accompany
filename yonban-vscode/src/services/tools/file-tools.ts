/**
 * file-tools.ts -- 文件读写+列目录工具（read_file / write_file / list_files）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * readFile:
 *   AI 需要查看文件内容
 *     → tool_call read_file { path, offset?, charOffset?, limit? }
 *     → resolveWorkspacePath 校验路径安全（越界抛异常）
 *     → 文档格式（xlsx/docx/pptx/pdf）走 readDocument 分支
 *     → 普通文件：大小限制(1MB) + 二进制检测(NUL) + BOM去除 + 行尾统一
 *     → 分页(offset/limit) + 行号格式化
 *     → 返回 { path, content, size, totalLines, shownRange, truncated }
 *     → AI 看到带行号的文件内容
 *
 * writeFile:
 *   AI 需要创建或覆盖文件
 *     → tool_call write_file { path, content }
 *     → resolveWorkspacePath + assertWritable 安全检查
 *     → FileCheckpoint.snapshotBeforeWrite 快照（Hop 6a）
 *     → fs.writeFileSync 写盘
 *     → 写后验证：回读比对内容（内容级，非 size 级）
 *     → autoSyntaxCheck 语法检查（JS/JSON）
 *     → revealAndHighlight 自动打开+高亮前5行
 *     → 返回 { path, totalLines, verified, message, syntaxCheck? }
 *     → 用户在编辑器中看到新文件
 *
 * listFiles:
 *   AI 探索项目结构
 *     → tool_call list_files { path?, recursive?, maxDepth? }
 *     → resolveWorkspacePath 解析目录路径
 *     → 递归遍历目录（跳过 node_modules/.git 等）
 *     → 返回 { directory, files, total } 结构化文件列表
 *     → AI 据此了解项目目录结构
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → tool-infra.ts resolveWorkspacePath/assertWritable/autoSyntaxCheck/SKIP_DIRS
 *   → FileCheckpoint.ts（写前快照）
 *   → EditorReveal.ts revealAndHighlight（写后跳转高亮）
 *   → constants.ts MAX_READ_FILE_SIZE/MAX_DOC_PARSE_SIZE/MAX_EDIT_FILE_SIZE
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  resolveWorkspacePath,
  assertWritable,
  autoSyntaxCheck,
  SKIP_DIRS,
  decodeXmlEntities,
  mapXlsxSheets,
} from "../tool-infra";
import {
  MAX_READ_FILE_SIZE,
  MAX_DOC_PARSE_SIZE,
  LIST_FILES_MAX,
} from "../../constants";
import type { FileCheckpoint } from "../FileCheckpoint";
import { revealAndHighlight } from "../EditorReveal";

// ═══════════════════════════════════════════════════════════════
// 文档解析扩展名集合
// ═══════════════════════════════════════════════════════════════

/** 走文档解析分支的扩展名 → 全部纯 JS 离线库，满足 beilu 离线约束。 */
export const DOC_EXTS = new Set([
  ".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", // 表格 → SheetJS
  ".docx",                                    // Word(新) → mammoth
  ".doc",                                     // Word(传统二进制) → word-extractor
  ".pptx",                                    // 演示 → jszip 自抽
  ".pdf",                                     // PDF → pdf-parse
]);

/**
 * 图片扩展名 → base64 分支（why: 原 read_file 遇图片走 NUL 二进制检测→返回"[二进制文件]"占位，
 *   AI 看不到内容。对比用户发图能看到=走多模态附件(image_url)；read_file 走文件IO=二进制占位。
 *   修法：读图片→base64→返回 {image:true, base64, mimeType, dataUrl}，上层注入层转 image_url 喂视觉模型）。
 *   ★ 两套系统对称：CLI 侧 代码cli/tools/file-tools.mjs 已加同款分支，YonBan 侧此处对齐（禁单端改）。
 *   ★ 只收视觉模型真支持的格式（jpeg/png/gif/webp，凛倾 0727 定"图片只支持对应的"）：
 *     .svg 是 XML 文本源码，走图片分支曾致 SVG 字节被下游标 png → Anthropic 400 → 空回复三连
 *     （0727 事故），已移出 → 落文本读取通道（AI 直接读源码，比看渲染图有用）。
 *     .bmp/.ico/.avif API 不收 → 移出，落二进制占位（诚实降级，不发必败请求）。
 */
export const IMG_EXTS = new Map<string, string>([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"],
]);

type ReadTruncatedReason = "line_limit" | "character_limit" | null;

interface ReadRuntime {
  defaultLineLimit: number;
  maxLineLimit: number;
  maxOutputChars: number;
}

interface ReadToolContext {
  runtimePolicy?: Record<string, unknown>;
}

interface ReadSource {
  path: string;
  size: number;
  mtimeMs: number;
  readAt: string;
  contentHash: string | null;
}

interface ReadPage {
  content: string;
  totalLines: number;
  shownRange: {
    start: number;
    end: number;
    startCharOffset: number;
    endCharOffset: number;
  };
  truncated: boolean;
  nextOffset: number | null;
  nextCharOffset: number | null;
  limitApplied: {
    offset: number;
    charOffset: number;
    lineLimit: number;
    maxLineLimit: number;
    maxOutputChars: number;
  };
  truncatedReason: ReadTruncatedReason;
}

const READ_RUNTIME_DEFAULTS = Object.freeze({
  read_default_line_limit: 500,
  read_max_line_limit: 5000,
  read_max_output_chars: 20000,
});

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

function readRuntime(
  params: Record<string, unknown>,
  context: ReadToolContext = {},
): ReadRuntime {
  const raw = context.runtimePolicy ?? params._beiluRuntime;
  const runtime = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const maxLineLimit = boundedInt(
    runtime.read_max_line_limit,
    READ_RUNTIME_DEFAULTS.read_max_line_limit,
    100,
    20000,
  );
  return {
    defaultLineLimit: Math.min(
      boundedInt(
        runtime.read_default_line_limit,
        READ_RUNTIME_DEFAULTS.read_default_line_limit,
        50,
        5000,
      ),
      maxLineLimit,
    ),
    maxLineLimit,
    maxOutputChars: boundedInt(
      runtime.read_max_output_chars,
      READ_RUNTIME_DEFAULTS.read_max_output_chars,
      2000,
      500000,
    ),
  };
}

function canonicalPath(absPath: string): string {
  let resolved = path.resolve(absPath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // 文件存在性由调用方检查；若随后被删除，保留已解析的绝对路径作为来源记录。
  }
  return resolved.replace(/\\/g, "/");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readSource(
  absPath: string,
  stat: fs.Stats,
  readAt: string,
  hash: string | null,
): ReadSource {
  return {
    path: canonicalPath(absPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    readAt,
    contentHash: hash,
  };
}

/**
 * 在执行端同时应用行预算与字符预算。offset 保持 0-based 行游标兼容；
 * 字符预算在行内耗尽时通过 nextCharOffset 继续同一行，未展示内容不会被跳过。
 */
function pageText(
  content: string,
  params: Record<string, unknown>,
  context: ReadToolContext = {},
): ReadPage {
  const runtime = readRuntime(params, context);
  const allLines = content === "" ? [] : content.split("\n");
  let startLine = Math.min(
    Math.max(0, Math.floor(Number(params.offset) || 0)),
    allLines.length,
  );
  let startCharOffset = Math.max(0, Math.floor(Number(params.charOffset) || 0));
  if (startLine < allLines.length) {
    startCharOffset = Math.min(startCharOffset, allLines[startLine].length);
    if (startCharOffset > 0 && startCharOffset === allLines[startLine].length) {
      startLine++;
      startCharOffset = 0;
    }
  } else {
    startCharOffset = 0;
  }
  const requestedLimit = Number(params.limit);
  const lineLimit = Math.min(
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : runtime.defaultLineLimit,
    runtime.maxLineLimit,
  );
  const rendered: string[] = [];
  let renderedChars = 0;
  let cursorLine = startLine;
  let cursorCharOffset = startCharOffset;
  let touchedLines = 0;
  let characterLimited = false;
  let firstShownLine: number | null = null;
  let firstShownCharOffset: number | null = null;
  let lastShownLine: number | null = null;
  let lastShownCharOffset: number | null = null;

  while (cursorLine < allLines.length && touchedLines < lineLimit) {
    const line = allLines[cursorLine];
    const prefix = `${cursorLine + 1} | `;
    const separatorChars = rendered.length > 0 ? 1 : 0;
    const available = runtime.maxOutputChars - renderedChars - separatorChars;
    const remainingLine = line.slice(cursorCharOffset);

    if (available < prefix.length
      || (available === prefix.length && remainingLine.length > 0)) {
      characterLimited = true;
      break;
    }

    const contentCapacity = Math.max(0, available - prefix.length);
    const contentLength = Math.min(remainingLine.length, contentCapacity);
    const segmentStart = cursorCharOffset;
    const segmentEnd = segmentStart + contentLength;
    rendered.push(prefix + remainingLine.slice(0, contentLength));
    renderedChars += separatorChars + prefix.length + contentLength;
    touchedLines++;
    if (firstShownLine === null) {
      firstShownLine = cursorLine + 1;
      firstShownCharOffset = segmentStart;
    }
    lastShownLine = cursorLine + 1;
    lastShownCharOffset = segmentEnd;

    if (segmentEnd < line.length) {
      cursorCharOffset = segmentEnd;
      characterLimited = true;
      break;
    }

    cursorLine++;
    cursorCharOffset = 0;
  }

  const truncated = cursorLine < allLines.length;
  const truncatedReason: ReadTruncatedReason = characterLimited
    ? "character_limit"
    : truncated
      ? "line_limit"
      : null;

  return {
    content: rendered.join("\n"),
    totalLines: allLines.length,
    shownRange: {
      start: firstShownLine ?? (startLine + 1),
      end: lastShownLine ?? startLine,
      startCharOffset: firstShownCharOffset ?? startCharOffset,
      endCharOffset: lastShownCharOffset ?? startCharOffset,
    },
    truncated,
    nextOffset: truncated ? cursorLine : null,
    nextCharOffset: truncated ? cursorCharOffset : null,
    limitApplied: {
      offset: startLine,
      charOffset: startCharOffset,
      lineLimit,
      maxLineLimit: runtime.maxLineLimit,
      maxOutputChars: runtime.maxOutputChars,
    },
    truncatedReason,
  };
}

// ═══════════════════════════════════════════════════════════════
// 文档解析辅助
// ═══════════════════════════════════════════════════════════════

/** 从 .xlsx 各 sheet XML 直接抠公式 → Map<sheet名, ["REF: =FORMULA"...]>。SheetJS 对无缓存值的公式格不可靠，故走 XML。 */
async function _xlsxFormulasBySheet(absPath: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(absPath));
    const wbXml = await zip.file("xl/workbook.xml")?.async("string");
    if (!wbXml) return result;
    const relsXml = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) || "";
    const sheetMap = mapXlsxSheets(wbXml, relsXml); // name → path（tool-infra 单源，重复收口 2026-07-13）
    for (const [name, sp] of Object.entries(sheetMap)) {
      const xml = await zip.file(sp)?.async("string");
      if (!xml) continue;
      const list: string[] = [];
      for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>\s*<f[^>]*>([\s\S]*?)<\/f>/g)) {
        list.push(`${m[1]}: =${decodeXmlEntities(m[2])}`);
      }
      if (list.length) result.set(name, list);
    }
  } catch { /* 抠公式尽力而为，失败不影响 CSV 值视图 */ }
  return result;
}

/** 表格(xlsx/xls/xlsm/xlsb/ods) → 每表 CSV(值) + 公式视图。值走 SheetJS sheet_to_csv；公式对 .xlsx 直接从 sheet XML 抠（SheetJS 对无缓存值的公式格不出 .f，不可靠），改公式(edit_xlsx)前据此对齐真实公式。 */
async function extractSpreadsheet(absPath: string): Promise<string> {
  const XLSX = (await import("xlsx")).default;
  const wb = XLSX.read(fs.readFileSync(absPath), { type: "buffer", cellDates: true, cellFormula: true });
  // ★ .xlsx：从 XML 抠公式（权威，不依赖缓存值）
  const xmlFormulas = path.extname(absPath).toLowerCase() === ".xlsx"
    ? await _xlsxFormulasBySheet(absPath)
    : null;
  let out = "";
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim();
    out += `--- Sheet: ${name} ---\n${csv}\n`;
    let formulas: string[] = [];
    if (xmlFormulas) {
      formulas = xmlFormulas.get(name) || [];
    } else {
      for (const addr of Object.keys(ws)) {
        if (addr[0] === "!") continue;
        const cell = ws[addr] as { f?: string };
        if (cell && cell.f) formulas.push(`${addr}: =${cell.f}`);
      }
    }
    if (formulas.length > 2000) formulas = formulas.slice(0, 2000).concat("[公式过多已截断]");
    if (formulas.length) out += `[公式 ${formulas.length}格]\n${formulas.join("\n")}\n`;
    out += "\n";
  }
  return out.trim();
}

/** pptx → 按 slide 顺序抽 <a:t> 文本，解 XML 实体。纯 jszip 解压，离线无依赖联网。 */
async function extractPptx(absPath: string): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(absPath));
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  let out = "";
  for (const n of slides) {
    const xml = await zip.files[n].async("string");
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
      decodeXmlEntities(m[1]),
    );
    out += `--- Slide ${n.match(/(\d+)/)![1]} ---\n${texts.join("\n")}\n\n`;
  }
  return out.trim();
}

/**
 * 解析文档(表格/Word/演示/PDF)为纯文本，复用 read_file 的分页/行号/截断协议。
 * 库懒加载(dynamic import)——只在真读文档时才载入，不拖慢扩展启动。全部离线纯 JS 库。
 */
async function readDocument(
  absPath: string,
  filePath: string,
  ext: string,
  stat: fs.Stats,
  params: Record<string, unknown>,
  context: ReadToolContext,
): Promise<unknown> {
  const readAt = new Date().toISOString();
  // 文档原始体积上限 20MB(对标 Cline)；解析后文本再走行级分页。
  if (stat.size > MAX_DOC_PARSE_SIZE) {
    throw new Error(
      `文档过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大 20MB`,
    );
  }

  let text: string;
  try {
    switch (ext) {
      case ".xlsx": case ".xls": case ".xlsm": case ".xlsb": case ".ods":
        text = await extractSpreadsheet(absPath);
        break;
      case ".docx": {
        const mammoth = (await import("mammoth")).default;
        text = (await mammoth.extractRawText({ path: absPath })).value;
        break;
      }
      case ".doc": {
        const WordExtractor = (await import("word-extractor")).default;
        const doc = await new WordExtractor().extract(absPath);
        text = doc.getBody();
        break;
      }
      case ".pptx":
        text = await extractPptx(absPath);
        break;
      default: {
        // .pdf —— pdf-parse v1(底层 pdfjs v2.x,无 DOMMatrix 依赖,可被 esbuild 打包且离线)。
        //   走 /lib/pdf-parse 子路径绕开 index.js 启动时读测试文件的 bug(对标 Cline)。
        const pdf = (await import("pdf-parse/lib/pdf-parse.js")).default;
        text = (await pdf(fs.readFileSync(absPath))).text;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`文档解析失败 (${ext}): ${msg}`);
  }

  // ★ 与 read_file 同一套：去 BOM + 统一行尾 + 执行端行/字符双预算分页。
  const content = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const page = pageText(content, params, context);

  return {
    path: filePath,
    ...page,
    size: stat.size,
    format: ext.slice(1),
    source: readSource(absPath, stat, readAt, contentHash(content)),
  };
}

// ═══════════════════════════════════════════════════════════════
// 导出工具函数
// ═══════════════════════════════════════════════════════════════

/** 读取文件内容（增强版：分页 + 行号 + 二进制检测） */
export async function readFile(
  params: Record<string, unknown>,
  context: ReadToolContext = {},
): Promise<unknown> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("缺少 path 参数");

  const absPath = resolveWorkspacePath(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const stat = fs.statSync(absPath);
  const readAt = new Date().toISOString();
  if (stat.isDirectory()) {
    throw new Error(`路径是目录，不是文件: ${filePath}`);
  }

  // ★ 文档解析分支（表格/Word/演示/PDF）——必须在 1MB 上限 + 二进制 NUL 检测之前：
  //   这些格式本质是 ZIP/二进制且常 >1MB，走默认路必被二进制检测弹掉。
  //   纯 JS 离线库（SheetJS/mammoth/word-extractor/jszip/pdf-parse），满足 beilu 离线约束。对标 Cline extract-text.ts。
  const _docExt = path.extname(absPath).toLowerCase();
  if (DOC_EXTS.has(_docExt)) {
    return await readDocument(absPath, filePath, _docExt, stat, params, context);
  }

  // ★ 图片分支（必须在 NUL 二进制检测之前：图片本质二进制会被 NUL 检测弹成占位）——
  //   读图片→base64→返回 image 结构，上层注入层据 image:true 转 image_url 喂 AI 视觉。
  //   why: 修「read_file 读 png 读不到」——原走 NUL 检测返回二进制占位，AI 看不到图。
  //   ★ 两套系统对称：与 CLI 侧 file-tools.mjs 同款分支（禁单端改）。
  const _imgExt = path.extname(absPath).toLowerCase();
  if (IMG_EXTS.has(_imgExt)) {
    // 图片大小上限 10MB（base64 后约 13MB，避免超大图撑爆 AI 上下文；超限给可读提示不硬崩）
    const IMG_MAX = 10 * 1024 * 1024;
    if (stat.size > IMG_MAX) {
      return {
        path: filePath, image: true, oversized: true, size: stat.size,
        content: `[图片过大 ${(stat.size / 1024 / 1024).toFixed(1)}MB，超 10MB 上限，未加载。路径: ${filePath}]`,
        message: "图片过大，未转 base64",
        source: readSource(absPath, stat, readAt, null),
      };
    }
    const _imgBuf = fs.readFileSync(absPath);
    const _mime = IMG_EXTS.get(_imgExt)!;
    const _b64 = _imgBuf.toString("base64");
    return {
      path: filePath,
      image: true,
      mimeType: _mime,
      base64: _b64,
      dataUrl: `data:${_mime};base64,${_b64}`,
      size: stat.size,
      content: `[图片已读取: ${path.basename(absPath)}, ${_mime}, ${(stat.size / 1024).toFixed(1)}KB]`,
      source: readSource(absPath, stat, readAt, null),
    };
  }

  // 限制文件大小（1MB）
  if (stat.size > MAX_READ_FILE_SIZE) {
    throw new Error(
      `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大 1MB`,
    );
  }

  // 二进制检测：前 512 字节检查 NUL 字符
  const headBuf = Buffer.alloc(Math.min(512, stat.size));
  const fd = fs.openSync(absPath, "r");
  fs.readSync(fd, headBuf, 0, headBuf.length, 0);
  fs.closeSync(fd);
  if (headBuf.includes(0)) {
    return {
      path: filePath,
      binary: true,
      size: stat.size,
      content: `[二进制文件, 大小: ${stat.size} 字节, 路径: ${filePath}]`,
      message: "二进制文件，无法显示",
      source: readSource(absPath, stat, readAt, null),
    };
  }

  const rawContent = fs.readFileSync(absPath, "utf-8");
  // ★ 去除 BOM + 统一行尾为 \n
  const content = rawContent
    .replace(/^\uFEFF/, "")          // UTF-8 BOM
    .replace(/\r\n/g, "\n")          // CRLF → LF
    .replace(/\r/g, "\n");           // 老Mac CR → LF
  const page = pageText(content, params, context);

  return {
    path: filePath,
    ...page,
    size: stat.size,
    source: readSource(absPath, stat, readAt, contentHash(content)),
  };
}

/**
 * 写入文件内容（整文件覆盖）。
 *
 * 步骤：
 *   1. resolveWorkspacePath 安全边界检查 + assertWritable U9 护栏
 *   2. FileCheckpoint.snapshotBeforeWrite 快照原始文件（Hop 6a）
 *   3. fs.writeFileSync 写盘
 *   4. 写后验证：回读比对内容（Hop 6c，内容级而非 size 级）
 *   5. autoSyntaxCheck 语法检查（JS/JSON 走 node --check）
 *   6. revealAndHighlight 自动打开+高亮前 5 行
 * 不变量：步骤 2 必须在步骤 3 之前（否则快照的是改后内容，回档无效）
 */
export async function writeFile(params: Record<string, unknown>, checkpoint: FileCheckpoint): Promise<unknown> {
  const filePath = params.path as string;
  const content = params.content as string;
  if (!filePath) throw new Error("缺少 path 参数");
  if (content === undefined || content === null) {
    throw new Error("缺少 content 参数");
  }

  const absPath = resolveWorkspacePath(filePath);
  assertWritable(absPath);
  const isNew = !fs.existsSync(absPath);
  let oldSize = 0;
  let oldLines = 0;
  if (!isNew) {
    try {
      const stat = fs.statSync(absPath);
      oldSize = stat.size;
      oldLines = fs.readFileSync(absPath, "utf-8").split("\n").length;
    } catch { /* ignore */ }
  }

  // ★ 检查点：写入前自动快照
  checkpoint.snapshotBeforeWrite(filePath);
  checkpoint.recordOperation("write_file", { path: filePath });

  // 确保目录存在
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absPath, content, "utf-8");
  const newSize = Buffer.byteLength(content, "utf-8");
  const newLines = content.split("\n").length;

  // ★ 写后验证：内容级比对（不只是size）
  const readBack = fs.readFileSync(absPath, "utf-8");
  const verified = readBack === content;
  let verifyDetail = "";
  if (!verified) {
    // 找到第一个不同的位置
    let diffPos = 0;
    const minLen = Math.min(readBack.length, content.length);
    while (diffPos < minLen && readBack[diffPos] === content[diffPos]) diffPos++;
    const line = readBack.slice(0, diffPos).split("\n").length;
    verifyDetail = `内容不匹配，第${line}行第${diffPos}字符处不同(写入${content.length}字符/读回${readBack.length}字符)`;
  }

  // ★ 写后自动语法检查
  const syntaxCheck = autoSyntaxCheck(absPath);
  // ★ 功能A：自动打开+高亮前5行
  revealAndHighlight(absPath, 1, Math.min(newLines, 5));

  return {
    path: filePath,
    totalLines: newLines,
    verified,
    message: verified
      ? (isNew ? `✓ 新建 ${newLines}行` : `✓ 写入 ${newLines}行`)
      : `✗ 验证失败: ${verifyDetail}`,
    ...(syntaxCheck ? { syntaxCheck } : {}),
  };
}

/** 列出目录文件 */
export async function listFiles(params: Record<string, unknown>): Promise<unknown> {
  const dirPath = (params.path as string) || ".";
  const recursive = params.recursive === true;
  const maxDepth = (params.maxDepth as number) || 3;

  const absPath = resolveWorkspacePath(dirPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`目录不存在: ${dirPath}`);
  }

  if (!fs.statSync(absPath).isDirectory()) {
    throw new Error(`路径不是目录: ${dirPath}`);
  }

  const files: Array<{
    name: string;
    path: string;
    type: "file" | "directory";
    size?: number;
  }> = [];

  const walk = (dir: string, relBase: string, depth: number) => {
    if (depth > maxDepth) return;
    if (files.length >= LIST_FILES_MAX) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        files.push({ name: entry.name, path: relPath, type: "directory" });
        if (recursive) {
          walk(path.join(dir, entry.name), relPath, depth + 1);
        }
      } else if (entry.isFile()) {
        let size: number | undefined;
        try {
          size = fs.statSync(path.join(dir, entry.name)).size;
        } catch {
          // ignore
        }
        files.push({ name: entry.name, path: relPath, type: "file", size });
      }
    }
  };

  walk(absPath, "", 0);
  return { directory: dirPath, files, total: files.length };
}
