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
let md = '# P1 第五轮(空间结构+多投票者) 全节点输出\n\n';
for (const c of cases) {
  const t0 = Date.now();
  const r = await runPipeline(c.input, [], c.mode);
  const ms = Date.now() - t0;
  const tr = r?.trace || {};
  const ttf = tr.transfer || {};
  const dw = r?.directionWords || [];
  const ciw = r?.cleanInfoWords || [];
  const wb = r?.whitebox || {};

  md += '---\n# ' + c.mode.toUpperCase() + ' (' + ms + 'ms)\n';
  md += '**输入**: `' + c.input + '`\n\n';
  md += '## 节点0-2 (' + (tr.recall?.ms||'?') + 'ms)\n';
  md += '- inputWords: ' + JSON.stringify(tr.recall?.inputWords) + '\n';
  md += '- swowPool: ' + JSON.stringify(tr.recall?.swowPool?.slice?.(0,20) || tr.recall?.swowPoolSize) + '\n\n';

  md += '## 节点3 (' + (tr.axis?.ms||'?') + 'ms)\n';
  md += '- topAxes: ' + JSON.stringify(tr.axis?.topAxes) + '\n';
  const ap = tr.axis?.axisPool || {};
  md += '- axisPool: ' + Object.entries(ap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+'='+Number(v).toFixed(2)).join(', ') + '\n';
  const ds = tr.axis?.domainSignals;
  if (ds) { md += '- domainSignals:\n'; for (const [ax, d] of Object.entries(ds)) { if (d?.topTag) md += '  - ' + ax + ': `' + d.topTag + '` w=' + Number(d.topWeight||0).toFixed(2) + '\n'; } }
  if (tr.axis?.subAxisPool?.length > 0) { md += '- subAxisPool: ' + tr.axis.subAxisPool.slice(0,6).map(s=>s.axis+'='+s.score).join(', ') + '\n'; }
  md += '\n';

  md += '## 节点6\n';
  const n6 = ttf.node6Obs;
  if (n6) {
    md += '- circle: T=' + n6.circle?.temperature + ' radius=' + n6.circle?.radius + ' in=' + n6.circle?.inCount + ' out=' + n6.circle?.outCount + '\n';
    md += '- anchors(' + (n6.anchors||[]).length + '): ' + (n6.anchors||[]).slice(0,5).map(a=>a.term+'(d='+Number(a.density||0).toFixed(1)+',vc='+a.voterCount+')').join(', ') + '\n';
  }
  const n6mwb = wb['transfer:node6Main'];
  if (n6mwb?.[0]?.output) {
    const o = n6mwb[0].output;
    md += '- node6Main: ranked=' + o.ranked + ' demoted=' + o.demoted + '\n';
    if (o.top5ranked) md += '  - top5: ' + o.top5ranked.map(x=>x.term+'('+Number(x.score).toFixed(1)+')').join(', ') + '\n';
  }
  md += '- spaceStruct: ' + (ttf.spaceStruct||'?') + '\n\n';

  md += '## 节点8 cleanInfoWords(' + ciw.length + ')\n\n';
  md += '| # | 信息词 | source | axis | score | elig | confirm | _scores |\n';
  md += '|---|--------|--------|------|-------|------|---------|---------|\n';
  for (let i=0; i<Math.min(ciw.length,20); i++) {
    const iw = ciw[i];
    const sc = iw._scores ? Object.entries(iw._scores).filter(([k,v])=>v>0).map(([k,v])=>k+'='+Number(v).toFixed(2)).join(',') : '';
    md += '| ' + (i+1) + ' | ' + iw.term + ' | ' + (iw._source||'?') + ' | ' + (iw.axis||'') + ' | ' + Number(iw.score||0).toFixed(3) + ' | ' + (iw.eligible?'Y':'N') + ' | ' + (iw.confirmCount||0) + ' | ' + sc + ' |\n';
  }
  md += '\n';

  md += '## 节点9 方向词(' + dw.length + ')\n\n';
  const n9h = wb['node9:hough'];
  if (n9h?.[0]) md += '- hough: eligible=' + (n9h[0].input?.eligibleCandidates||'?') + ' passed=' + (n9h[0].output?.passedCandidates||'?') + ' multivoter=' + (n9h[0].input?.multivoter||'?') + '\n\n';
  md += '| # | 方向词 | axis | score | vc | tv | dimKey | source |\n';
  md += '|---|--------|------|-------|----|-----|--------|--------|\n';
  for (let i=0; i<dw.length; i++) {
    const d=dw[i];
    md += '| ' + (i+1) + ' | ' + d.term + ' | ' + (d.axis||'') + ' | ' + Number(d.score||0).toFixed(4) + ' | ' + (d._voteCount||'') + ' | ' + (d._totalVote||'') + ' | ' + (d.dimKey||'') + ' | ' + (d._source||d.source||'') + ' |\n';
  }
  md += '\n';

  md += '## 节点10\n';
  if (tr.node10) {
    md += '- before=' + tr.node10.before + ' after=' + tr.node10.after + ' filtered=' + tr.node10.filtered + '\n';
    if (tr.node10.filteredWords?.length) {
      md += '- 被过滤的词: ' + tr.node10.filteredWords.map(w=>w.term+'('+Number(w.score||0).toFixed(3)+')').join(', ') + '\n';
    }
  }
  md += '- **p1_act**: ' + JSON.stringify(r?.p1_act) + '\n\n';
}

const outPath = '<PROJECT_ROOT>/beilu的工作日志和项目日志/前端计划/P1自驱动_知识库/代码md/P1_第五轮_空间结构_全节点输出_20260601.md';
fs.writeFileSync(outPath, md);
console.log('DONE: ' + outPath + ' (' + md.length + ' chars)');
