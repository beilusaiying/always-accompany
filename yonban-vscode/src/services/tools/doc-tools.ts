/**
 * doc-tools.ts -- xlsx 公式编辑工具（edit_xlsx）
 *
 * ═══════════════════════════════════════════════════════════════
 *  使用链路（每个 tool_call 的完整传导路径）
 * ═══════════════════════════════════════════════════════════════
 *
 * editXlsx:
 *   AI 需要修改表格公式（如算法工作表）
 *     → tool_call edit_xlsx { path, edits: [{sheet?, cell, formula}] }
 *     → resolveWorkspacePath + assertWritable 安全检查
 *     → FileCheckpoint.snapshotBeforeWrite 快照原始文件
 *     → jszip 解包 xlsx（保留所有原始 XML/样式/条件格式/未知扩展）
 *     → _setCellFormula 在目标 sheet XML 中定点改写公式节点
 *     → jszip 重打包 → SheetJS 重解析校验（损坏则不写盘）
 *     → fs.writeFileSync 写回
 *     → 返回 { path, edited, count, message }
 *     → 用户在 Excel 中打开会自动重算
 *
 * 设计要点：
 *   只改目标 <c> 的 <f> 公式节点，其余 XML 字节原样（保样式/条件格式/未知扩展）。
 *   对标修复 算法001 翻车：openpyxl wb.save() 整体重存会删条件格式/未知扩展→文件打不开；
 *   本法用 jszip 解包、字符串级只动目标单元格、其它文件原样回灌，写前用 SheetJS 重解析校验。
 *
 * 相交：
 *   ← ToolExecutor.ts execute（_handlers 注册表路由到此）
 *   → tool-infra.ts resolveWorkspacePath/assertWritable
 *   → FileCheckpoint.ts（写前快照）
 *   → constants.ts（无直接依赖）
 */
import * as fs from "fs";
import * as path from "path";
import {
  resolveWorkspacePath,
  assertWritable,
  decodeXmlEntities,
  mapXlsxSheets,
} from "../tool-infra";
import type { FileCheckpoint } from "../FileCheckpoint";

/** 列字母→列号（AE→31）。 */
function _colToNum(col: string): number {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

/** 在 sheet XML 里把某单元格设成公式：保留 s=样式属性，去掉 t=类型与缓存 <v>（Excel 重算）。不存在则按列/行序插入。 */
function _setCellFormula(xml: string, cell: string, formula: string): string {
  const fEsc = formula.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const keepStyle = (attrs: string) => attrs.match(/\ss="\d+"/)?.[0] ?? "";
  const reFull = new RegExp(`<c r="${cell}"([^>]*?)>[\\s\\S]*?</c>`);
  const reSelf = new RegExp(`<c r="${cell}"([^>]*?)/>`);
  if (reFull.test(xml)) return xml.replace(reFull, (_m, a) => `<c r="${cell}"${keepStyle(a)}><f>${fEsc}</f></c>`);
  if (reSelf.test(xml)) return xml.replace(reSelf, (_m, a) => `<c r="${cell}"${keepStyle(a)}><f>${fEsc}</f></c>`);
  // 单元格不存在 → 插入
  const mm = cell.match(/^([A-Z]+)(\d+)$/);
  if (!mm) throw new Error(`非法单元格引用: ${cell}`);
  const col = mm[1], rowNum = parseInt(mm[2], 10), colN = _colToNum(col);
  const newCell = `<c r="${cell}"><f>${fEsc}</f></c>`;
  // 行存在（含自闭合）
  const reRow = new RegExp(`<row r="${rowNum}"([^>]*)>([\\s\\S]*?)</row>`);
  const reRowSelf = new RegExp(`<row r="${rowNum}"([^>]*)/>`);
  if (reRow.test(xml)) {
    return xml.replace(reRow, (_m, attrs, inner) => {
      const cellRe = /<c r="([A-Z]+)\d+"/g; let pos = -1, c;
      while ((c = cellRe.exec(inner)) !== null) { if (_colToNum(c[1]) > colN) { pos = c.index; break; } }
      const ni = pos >= 0 ? inner.slice(0, pos) + newCell + inner.slice(pos) : inner + newCell;
      return `<row r="${rowNum}"${attrs}>${ni}</row>`;
    });
  }
  if (reRowSelf.test(xml)) return xml.replace(reRowSelf, (_m, attrs) => `<row r="${rowNum}"${attrs}>${newCell}</row>`);
  // 行不存在 → 插入新 row 到 sheetData（按行号序）
  const sdRe = /(<sheetData[^>]*>)([\s\S]*?)(<\/sheetData>)/;
  const sm = xml.match(sdRe);
  if (!sm) throw new Error("非法 sheet：缺 sheetData");
  const inner = sm[2];
  const rowRe = /<row r="(\d+)"/g; let pos = -1, r;
  while ((r = rowRe.exec(inner)) !== null) { if (parseInt(r[1], 10) > rowNum) { pos = r.index; break; } }
  const newRow = `<row r="${rowNum}">${newCell}</row>`;
  const ni = pos >= 0 ? inner.slice(0, pos) + newRow + inner.slice(pos) : inner + newRow;
  return xml.replace(sdRe, `$1${ni}$3`);
}

// ═══════════════════════════════════════════════════════════════
// 导出工具函数
// ═══════════════════════════════════════════════════════════════

/** 安全改 xlsx 公式：params={ path, edits:[{sheet?,cell,formula}] }。 */
export async function editXlsx(params: Record<string, unknown>, checkpoint: FileCheckpoint): Promise<unknown> {
  const filePath = params.path as string;
  if (!filePath) throw new Error("缺少 path 参数");
  const edits = params.edits as Array<{ sheet?: string; cell: string; formula: string }>;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("缺少 edits 参数（数组：[{sheet?,cell,formula}]）");

  const absPath = resolveWorkspacePath(filePath);
  assertWritable(absPath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${filePath}`);
  if (path.extname(absPath).toLowerCase() !== ".xlsx") throw new Error("edit_xlsx 仅支持 .xlsx（OOXML），其它格式请用对应工具");

  checkpoint.snapshotBeforeWrite(filePath);
  checkpoint.recordOperation("edit_xlsx", { path: filePath });

  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(absPath));

  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!wbXml) throw new Error("非法 xlsx：缺 xl/workbook.xml");
  const relsXml = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) || "";
  const sheetMap = mapXlsxSheets(wbXml, relsXml); // tool-infra 单源（重复收口 2026-07-13）
  const defaultPath = Object.values(sheetMap)[0];
  if (!defaultPath) throw new Error("非法 xlsx：解析不到任何 worksheet");

  const bySheet = new Map<string, Array<{ cell: string; formula: string }>>();
  for (const e of edits) {
    const sp = e.sheet ? sheetMap[e.sheet] : defaultPath;
    if (!sp) throw new Error(`找不到 sheet "${e.sheet}"（可用：${Object.keys(sheetMap).join(", ")}）`);
    if (!bySheet.has(sp)) bySheet.set(sp, []);
    bySheet.get(sp)!.push({ cell: String(e.cell).toUpperCase(), formula: String(e.formula || "").replace(/^=/, "") });
  }

  const applied: string[] = [];
  for (const [sp, cellEdits] of bySheet) {
    let xml = await zip.file(sp)?.async("string");
    if (!xml) throw new Error(`缺 worksheet ${sp}`);
    for (const { cell, formula } of cellEdits) {
      xml = _setCellFormula(xml, cell, formula);
      applied.push(cell);
    }
    zip.file(sp, xml);
  }

  const outBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  // ★ 容错闸（V1）：写盘前用 SheetJS 重解析校验，损坏则不写盘、原文件不动、报失败
  try {
    const XLSX = (await import("xlsx")).default;
    XLSX.read(outBuf, { type: "buffer" });
  } catch (e) {
    throw new Error(`定点改写后文件校验失败（未写盘，原文件未动）：${e instanceof Error ? e.message : String(e)}`);
  }

  fs.writeFileSync(absPath, outBuf);
  return {
    path: filePath,
    edited: applied,
    count: applied.length,
    message: `已定点写入 ${applied.length} 个单元格公式（样式/条件格式/扩展原样保留，已通过重解析校验）。Excel 打开会自动重算。`,
  };
}
