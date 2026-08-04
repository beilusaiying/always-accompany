// ════════════════════════════════════════════════════════════════════
// [p1_resdir] — P1 分词层资源库统一定位（P0-2 框架级修，2026-07-02）。
// why：RES_DIR 曾在 node1/axis/node5 三处各写一份，其中两处硬编码
//      "…/前端计划/P1资源库"（D 盘 6 月底数据丢失后该目录不存在），一处含
//      "<PROJECT_ROOT>" 字面量死路径——三处 loader 全静默退化（不崩但功能弱化）。
//      单源定位后，资源位挪动只改 paths.mjs；运行时只认该次启动选定的一个资源根。
// 资源实体：memory/p1/resources/（THUOCL/CoreNatureDictionary/DomainWordsDict/
//      Chinese-Synonyms/near-synonym，约 182MB，从 E 盘全量备份恢复的最小子集）。
// 消费方：p1_node1_tokenize(THUOCL 前缀仲裁+HanLP POS)、p1_axis(Domain/THUOCL 轴索引)、
//      p1_node5_resource(findResource: 同义/反义)。
// ════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { RESOURCE_ROOT } from "./paths.mjs";

let _resDir;
// 资源根缺失是部署错误，必须在白盒链上响亮失败；不得跨旧目录拼凑资源。
export function getResDir() {
  if (_resDir !== undefined) return _resDir;
  if (!fs.existsSync(RESOURCE_ROOT)) {
    const error = new Error(`[p1_resdir] P1_RESOURCE_ROOT_MISSING: ${RESOURCE_ROOT}`);
    error.code = "P1_RESOURCE_ROOT_MISSING";
    throw error;
  }
  _resDir = RESOURCE_ROOT;
  return _resDir;
}

// 所有消费者只在同一个资源根内找文件，缺少单项时由该 loader 明确决定是否可选。
export function findResource(rel) {
  const resourcePath = path.join(getResDir(), rel);
  return fs.existsSync(resourcePath) ? resourcePath : null;
}
