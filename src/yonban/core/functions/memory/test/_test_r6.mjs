import fs from 'node:fs';
import { runPipeline } from '../p1/p1_pipeline.mjs';
await runPipeline('w', [], 'chat');
await runPipeline('w', [], 'airp');
await runPipeline('w', [], 'code');
await runPipeline('w', [], 'work');

const cases = [
  { mode: 'chat', input: '你觉得这个方案怎么样?甲方让改了很多个版本,但是好像都是不满意.我觉得是为什么' },
  { mode: 'airp', input: '走吧,今天就回家吧,今天经历了好多事情啊' },
  { mode: 'ide',  input: '为什么这个前端保存之后,刷新,结果又变成没有保存的状态了' },
  { mode: 'work', input: '帮我把今天群里的任务进行颗粒度对齐,同时进行ddl' },
];

for (const c of cases) {
  const t0 = Date.now();
  const r = await runPipeline(c.input, [], c.mode);
  const ms = Date.now() - t0;
  const dw = r?.directionWords || [];
  const tr = r?.trace || {};
  const ttf = tr.transfer || {};
  
  console.log('=== ' + c.mode.toUpperCase() + ' (' + ms + 'ms) ===');
  console.log('topAxes:', JSON.stringify(tr.axis?.topAxes));
  console.log('decay:', Object.entries(tr.axis?.decay||{}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+'='+Number(v).toFixed(3)).join(', '));
  console.log('sixDegree:', ttf.sixDegree || 0, '| relay:', ttf.relayCausal||0, '/', ttf.relayAnalogy||0);
  
  // 金字塔
  const pyr = r?.pyramid;
  if (pyr) {
    console.log('pyramid: apex=' + (pyr.apex||[]).join('/') + ' | mid=' + (pyr.mid||[]).join('/') + ' | base=' + (pyr.base||[]).join('/'));
  }
  
  // 方向词
  console.log('方向词(' + dw.length + '):');
  for (let i=0; i<dw.length; i++) {
    const d = dw[i];
    console.log('  ' + (i+1) + '. ' + d.term + ' [' + (d._pyramid||'?') + '|' + (d.axis||'') + '|' + (d._source||'') + '] ' + Number(d.score||0).toFixed(4) + ' vc=' + (d._voteCount||''));
  }
  
  // node10
  if (tr.node10?.filteredWords?.length) {
    console.log('node10过滤:', tr.node10.filteredWords.map(w=>w.term).join(', '));
  }
  console.log('');
}
