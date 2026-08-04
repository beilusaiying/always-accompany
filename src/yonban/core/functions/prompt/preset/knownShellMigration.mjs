/**
 * [D2 · 已知空壳迁移判定] — 只保存「E 测试用户 21 个空壳的原始 SHA-256」与迁移判定，
 *   不含任何 prompt 正文（D2 §精确文件范围：knownShellMigration.mjs 仅保存上表 hash 集与迁移判定）。
 *
 * 【why 存在】新用户/存量用户的 21 个默认预设曾被 memory 侧 `_ensureSubModePresetsFor` 造的
 *   11-entry 空壳抢占（source=beilu-memory），随后官方 builtin 播种因「文件已存在」跳过（seedBuiltinsForUser:579）
 *   → 官方运行池被空壳顶掉（交接实证 243,297 正文字符损失 / 319 identifier 缺失）。
 * 【判定契约（三条件 AND，任一不满足即不迁移）】——见 D2「精确已知空壳迁移」：
 *   ① 用户预设文件原始字节的 sha256 精确命中下表；
 *   ② 该项 registry/_meta 的 source === "beilu-memory"（空壳生产者的固定 source）；
 *   ③ 名称在下表（= 当前 builtin manifest 项）。
 *   → 这样不会误把「相似的用户自改预设」「官方 builtin 正常文件（source=builtin，hash 不在表）」
 *     「后续被编辑过的文件（hash 已变）」当空壳覆盖。
 * 【执行编排不在此】迁移的备份/复制/registry 写/marker 由 preset/main.mjs 的
 *   migrateKnownShellPresets(username) 在 owner 事务（withFileLock registry）内完成；本模块纯判定。
 * 【数据来源】21 条 SHA-256 逐字复制自
 *   `新用户重大bug多层追踪_20260804/实施设计_20260804/D2_默认预设唯一Owner与恢复契约.md`
 *   §精确已知空壳迁移表（凛倾定案；hash 取自 E 现场实际文件，禁改）。大写存储、比较时两侧归一。
 */

// name → 空壳原始 SHA-256（大写，逐字来自 D2 表）。SHA-256 = 64 hex。
export const KNOWN_SHELL_SHA256 = Object.freeze({
  "大项目协调": "271E79EC652839EBBA0D13C99BD2AD10455A5E50D4D0D4E4A35F86C11195CE3B",
  "代码专家": "DBA7D5F4BB4EB9B13BAB15014CC20DFEF72934225B6865DFB45D6D8712E7A62E",
  "脚本制作": "05723617A36CEE6D26D744914FDD61283EC7E4B5744FB5E7C3318E61EDAED997",
  "纠错专家": "FBBD675BFF7CA433446BBAACDFA826AF603ECDF978FC8718D90992819EA16053",
  "框架审查": "6D3E526D209D17CF52110D0B2EB89678EA889A78B4946D285537DA2160D5A016",
  "框架审查员": "DC5DAD39B1DB303942E7BA0E1875678AF4A0A73A2956BE9BDC909E53778E0091",
  "链路审计专家": "21BE110EE088992707E21FD57ED0059510A6DF4946A6D5BDB6A3A754F4EC1F09",
  "流程优化": "FB84FBD173D034203EF738A02D1D5E46D22B84F49C682B2236AF6F59B1EEC840",
  "流程组装": "FDF47B0E49CD8384C0B73D209080DA57DE30576B6E080F9E6F4EEFF2A98DEAE1",
  "前端美化专家": "0F19654628ADAC76998A9593D2D73DCBD91E8142B879643D079B8FA4EB762D09",
  "前置任务专家": "72709EDA5696A17F0966C40DA82DBCF47D71B58D5D3634207153BCF3DABDC8A8",
  "任务交接员": "1AF3F544947A214236ABA63905761B531688C2B03EC5D1A4760FB48185E3B96C",
  "任务确认": "1445F7648FCB0B1A1D11077EF09F49BEA99B787DA94A9201B60E311EB3CDC69B",
  "任务设计": "EE9C16A6A96883C6A5F85491DCD120E20AC351252F6CD8EFBAFD6B6898765D8E",
  "收尾归档": "E2B31658755F0FF3044F99C9B7E64D84F064DC225856DDCE5654FCE81D4ED7DA",
  "算法与推演专家": "A9D7FF9834A3068B35C901A71A5A3C4154952D61053004650599CCE5A136DC7A",
  "提示词设计": "E7C3D138358AB4D1CF960A448C8DDDD76DF4820557405A03D2BF9700FFBAF83D",
  "验证": "6F21F210842FBAD4E0FF3F4638A87DBBF821778BB3FF54121A51E7AD5F603AB8",
  "预设设计": "6FDF2A45DEADF6E5141F7C020C4F413FF488D6EDEFF90C54C0AF67584ECD57D8",
  "执行流程组": "E4EACD4ECD018AEA468F306B139BC8CB2F8D552F903510CA42F8DC82A578B8A2",
  "PPT制作": "ED390DF4B9E7A6D923F0EA2699B548C1756F4907C7079D44DFB30037DDCAE65D",
});

// 空壳生产者（memory 侧 createPreset）固定写入的 registry source（判定条件②）。
export const SHELL_SOURCE = "beilu-memory";

// 一次性迁移标记文件名（marker 守卫：存在即不再迁移；同 storage.mjs INJ v4 marker 范式）。
//   放 presets/.owner/ 下（D2 §owner 协调根）。
export const SHELL_MIGRATION_MARKER = "known-shell-migration-v1.done";

// _conflicts 备份子目录（原空壳在覆盖前迁此，不可静默丢弃；D2 recovery namespace）。
export const SHELL_CONFLICT_SUBDIR = "20260804-known-shell";

/**
 * 迁移判定（三条件 AND）。命中=该文件确为已知空壳，可安全用官方发布文件覆盖。
 * @param {string} name           预设名（用户 registry 键）
 * @param {string} sha256Hex      用户文件原始字节的 sha256（hex，大小写不敏感）
 * @param {string|undefined} registrySource  该项 registry.source
 * @returns {boolean}
 */
export function isKnownShell(name, sha256Hex, registrySource) {
  const expected = KNOWN_SHELL_SHA256[name];
  if (!expected) return false;                                   // ③ 名不在表
  if (registrySource !== SHELL_SOURCE) return false;             // ② source 非空壳生产者
  if (typeof sha256Hex !== "string") return false;
  return sha256Hex.toUpperCase() === expected.toUpperCase();     // ① hash 精确命中
}

/** 全部已知空壳名（供迁移编排遍历） */
export function knownShellNames() {
  return Object.keys(KNOWN_SHELL_SHA256);
}
