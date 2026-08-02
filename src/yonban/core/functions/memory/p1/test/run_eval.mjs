#!/usr/bin/env node
// run_eval.mjs — P1 词向量标注测评入口
//
// 用法:
//   node test/run_eval.mjs              # 跑全部评测集(WordSim-353, SimLex-999, MEN-3000, PKU-500)
//   node test/run_eval.mjs WordSim-353  # 跑指定评测集
//   node test/run_eval.mjs --list       # 列出可用评测集
//
// 前置条件:
//   - Python 3 + numpy 已安装
//   - NB 子集已构建(nb_words.txt + nb_vec_int8.npy 在 resources_derived/)
//   - 首次运行会从 dropbox 下载评测数据(约 1-5MB), 缓存在 eval_cache/

import { evaluateAll, evaluateDataset, rubricGrade } from '../eval.mjs';

const args = process.argv.slice(2);

if (args.includes('--list') || args.includes('-l')) {
  console.log('Available datasets:');
  console.log('  WordSim-353  (EN, 353 pairs,  Finkelstein et al. 2002)');
  console.log('  SimLex-999   (EN, 999 pairs,  Hill et al. 2014)');
  console.log('  MEN-3000     (EN, 3000 pairs, Bruni et al. 2014)');
  console.log('  PKU-500      (ZH, ~500 pairs, PKU Computational Linguistics)');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node test/run_eval.mjs [dataset_name] [--list] [--rubric]');
  console.log('  No args     → run all datasets');
  console.log('  dataset_name → run specific dataset');
  console.log('  --list      → list available datasets');
  console.log('  --rubric    → show rubric grades in results');
  process.exit(0);
}

const showRubric = args.includes('--rubric');
const datasetName = args.find(a => !a.startsWith('--'));

try {
  let results;
  if (datasetName) {
    const r = evaluateDataset(datasetName);
    results = [r];
  } else {
    results = evaluateAll();
  }

  // rubric 对照输出
  if (showRubric) {
    console.log('\n--- Rubric Grades (5-point scale) ---');
    for (const r of results) {
      const g = rubricGrade(r.spearmanRho);
      console.log(`  ${r.name}: ${g.grade}/5 (${g.label}), rho=${r.spearmanRho}`);
    }
  }

  // exit code: 全部有结果=0, 有 error=1
  const hasError = results.some(r => r.error || isNaN(r.spearmanRho));
  process.exit(hasError ? 1 : 0);
} catch (e) {
  console.error(`[FATAL] ${e.message}`);
  console.error(e.stack);
  process.exit(2);
}
