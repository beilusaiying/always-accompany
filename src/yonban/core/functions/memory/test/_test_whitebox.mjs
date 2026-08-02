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

let md = '# P1 全节点白盒输出 (2026-06-01 常驻白盒)\n\n';

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
  md += '- swowPool: ' + tr.recall?.swowPoolSize + '\n\n';

  md += '## 节点3 (' + (tr.axis?.ms||'?') + 'ms)\n';
  md += '- topAxes: ' + JSON.stringify(tr.axis?.topAxes) + '\n';
  const ap = tr.axis?.axisPool || {};
  md += '- axisPool: ' + Object.entries(ap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+'='+Number(v).toFixed(2)).join(', ') + '\n';

  md += '\n### domainSignals\n';
  const ds = tr.axis?.domainSignals;
  if (ds) {
    for (const [ax, d] of Object.entries(ds)) {
      if (!d?.topTag) continue;
      const tags = d.tags ? Object.entries(d.tags).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([t,w])=>t+'='+Number(w).toFixed(2)).join(', ') : '';
      md += '- **' + ax + '**: `' + d.topTag + '` w=' + Number(d.topWeight||0).toFixed(2) + ' | ' + tags + '\n';
    }
  } else md += '- 无\n';

  md += '\n### subAxisPool\n';
  if (tr.axis?.subAxisPool?.length > 0) {
    for (const s of tr.axis.subAxisPool) md += '- ' + s.axis + '=' + s.score + '\n';
  } else md += '- 无\n';

  const n3wb = wb['node3'];
  if (n3wb) {
    const n3out = n3wb[n3wb.length-1]?.output;
    if (n3out?.faceByAxis) {
      md += '\n### faceByAxis\n';
      for (const [ax, face] of Object.entries(n3out.faceByAxis)) {
        if (face?.length > 0) {
          md += '- **' + ax + '**: ' + face.slice(0,6).map(f => {
            let s = f.word + '(' + f.v;
            if (f.dimSignals?.length) s += '|' + f.dimSignals.slice(0,2).join(',');
            return s + ')';
          }).join(', ') + '\n';
        }
      }
    }
  }
  md += '\n';

  md += '## 节点4\n';
  const n4kl = wb['node4:keyLoss'];
  if (n4kl?.[0]?.output) md += '- keyLoss: scoreLossRate=' + (n4kl[0].output.scoreLossRate||'?') + '\n';
  md += '\n## verify (' + (tr.verify?.ms||'?') + 'ms) dims=' + tr.verify?.activatedDimCount + '\n\n';

  md += '## 节点5\n';
  const n5wb = wb['node5:R1'];
  if (n5wb) {
    const last = n5wb[n5wb.length-1];
    if (last?.output) md += '- R1: ' + JSON.stringify(last.output).slice(0,300) + '\n';
  }
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
    md += '- **node6Main**: ranked=' + o.ranked + ' demoted=' + o.demoted + '\n';
    if (o.top5ranked) md += '  - top5: ' + o.top5ranked.map(x=>x.term+'('+Number(x.score).toFixed(1)+')').join(', ') + '\n';
  }
  md += '\n';

  md += '## 节点7\n- hop2:' + ttf.hop2 + ' causal:' + ttf.causal + ' analogy:' + ttf.analogy + ' relay:' + ttf.relayCausal + '/' + ttf.relayAnalogy + '\n\n';

  md += '## 节点8 cleanInfoWords(' + ciw.length + ')\n\n';
  md += '| # | 信息词 | source | axis | score | elig | confirm |\n';
  md += '|---|--------|--------|------|-------|------|---------|\n';
  for (let i=0; i<Math.min(ciw.length,30); i++) {
    const iw = ciw[i];
    md += '| ' + (i+1) + ' | ' + iw.term + ' | ' + (iw._source||'?') + ' | ' + (iw.axis||'') + ' | ' + Number(iw.score||0).toFixed(3) + ' | ' + (iw.eligible?'Y':'N') + ' | ' + (iw.confirmCount||0) + ' |\n';
  }
  md += '\n';

  md += '## 节点9 方向词\n\n';
  const n9h = wb['node9:hough'];
  if (n9h?.[0]) {
    md += '- hough: eligible=' + (n9h[0].input?.eligibleCandidates||'?') + ' passed=' + (n9h[0].output?.passedCandidates||'?') + '\n\n';
  }
  md += '| # | 方向词 | axis | score | vc | tv | dimKey | source |\n';
  md += '|---|--------|------|-------|----|-----|--------|--------|\n';
  for (let i=0; i<dw.length; i++) {
    const d=dw[i];
    md += '| ' + (i+1) + ' | ' + d.term + ' | ' + (d.axis||'') + ' | ' + Number(d.score||0).toFixed(4) + ' | ' + (d._voteCount||'') + ' | ' + (d._totalVote||'') + ' | ' + (d.dimKey||'') + ' | ' + (d._source||d.source||'') + ' |\n';
  }
  md += '\n';

  md += '## 节点10\n- ' + JSON.stringify(tr.node10) + '\n';
  md += '- **p1_act**: ' + JSON.stringify(r?.p1_act) + '\n\n';

  md += '## 白盒节点(' + Object.keys(wb).length + ')\n';
  for (const [k,v] of Object.entries(wb).sort((a,b)=>a[0].localeCompare(b[0]))) {
    md += '- ' + k + ': ' + v.length + '\n';
  }
  md += '\n';
}

const outPath = '<PROJECT_ROOT>/beilu的工作日志和项目日志/前端计划/P1自驱动_知识库/代码md/P1_4case全节点白盒输出_20260601.md';
fs.writeFileSync(outPath, md);
console.log('DONE: ' + outPath + ' (' + md.length + ' chars)');
