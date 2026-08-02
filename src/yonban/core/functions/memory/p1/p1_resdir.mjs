// ════════════════════════════════════════════════════════════════════
// [p1_resdir] — P1 分词层资源库统一定位（P0-2 框架级修，2026-07-02）。
// why：RES_DIR 曾在 node1/axis/node5 三处各写一份，其中两处硬编码
//      "…/前端计划/P1资源库"（D 盘 6 月底数据丢失后该目录不存在），一处含
//      "<PROJECT_ROOT>" 字面量死路径——三处 loader 全静默退化（不崩但功能弱化）。
//      单源定位后，资源位挪动只改这里；候选序 env > 随代码 > 旧运行位。
// 资源实体：memory/p1_res/（THUOCL/CoreNatureDictionary/DomainWordsDict/
//      Chinese-Synonyms/near-synonym，约 182MB，从 E 盘全量备份恢复的最小子集）。
// 消费方：p1_node1_tokenize(THUOCL 前缀仲裁+HanLP POS)、p1_axis(Domain/THUOCL 轴索引)、
//      p1_node5_resource(findResource: 同义/反义)。
// ════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const _DEFAULT = path.join(__dirname, "..", "p1_res");   // 随代码（与 NB300/SWOW/AT/TI 同层）

const CANDIDATES = [
  process.env.P1_RESOURCE_DIR,                            // 显式覆盖最高优先
  _DEFAULT,
  String.raw`D:\shajiuguan\beilu-与你之诗\beilu的工作日志和项目日志\前端计划\P1资源库`, // 旧运行位（历史兼容）
].filter(Boolean);

let _resDir;
// 返回第一个存在的候选；全缺时返回 _DEFAULT（非 null，保证下游 path.join 不抛，
// 走各 loader 自己的 existsSync/try-catch 静默退化路径，与改造前行为一致）。
export function getResDir() {
  if (_resDir !== undefined) return _resDir;
  _resDir = _DEFAULT;
  for (const c of CANDIDATES) {
    try { if (fs.existsSync(c)) { _resDir = c; break; } } catch { /* 无效候选跳过 */ }
  }
  if (!fs.existsSync(_resDir)) {
    console.warn("[p1_resdir] P1 资源库未找到(env P1_RESOURCE_DIR / memory/p1_res / 旧运行位均无) → node1 仲裁/POS 词典、axis domain 索引、node5 同义反义将退化为空");
  }
  return _resDir;
}

// 逐候选找相对路径（保留原 node5 语义：资源可分散在不同候选目录）。
export function findResource(rel) {
  for (const base of CANDIDATES) {
    try {
      const p = path.join(base, rel);
      if (fs.existsSync(p)) return p;
    } catch { /* 跳过 */ }
  }
  return null;
}
