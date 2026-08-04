// build_domainwords_shards.mjs — DomainWordsDict 有界查询索引的部署期确保入口。
//
// 只允许由服务启动准备/运维显式执行；召回请求和 loader 永不调用本文件。
// [0804] 改调 ensureDomainWordsShardIndex：缺失→构建 / 有效→快速返回 / stale（含旧 mtime 版指纹）
//   →原子重建（旧 manifest 旁移备份、旧 dataDir 保留）。p1_server 启动期恒调本脚本（幂等毫秒级）。

import { ensureDomainWordsShardIndex } from '../resources2.mjs';

try {
  const result = ensureDomainWordsShardIndex();
  process.stdout.write(`${JSON.stringify({ success: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    success: false,
    code: error?.code ?? 'E_P1_DOMAIN_WORDS_INDEX_BUILD_FAILED',
    error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
    details: error?.details ?? null,
  })}\n`);
  process.exitCode = 1;
}
