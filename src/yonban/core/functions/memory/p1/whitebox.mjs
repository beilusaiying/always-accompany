// whitebox.mjs — 白盒报告渲染器
//
// 原则(凛倾 2026-08-01): 白盒远比任何实验好。
// 任意一条输入都能打出全链路因果: 哪条被排除(为什么)、哪个词被哪层滤掉(数值多少)、
// 谁被保留(凭什么)。参数定档靠读这份报告,不靠盲测分数。

// 链位置: 只渲染 node0→node1 段(召回单元/保留词/滤除层/时间锚/截断/环境);
// node2-4 段的渲染在 pipeline.mjs renderFullWhitebox(唯一调用方),两处拼成全链报告
export function renderNode01(node0Result, node1Result) {
  const L = [];
  L.push('══════════ 白盒报告 node0→node1 ══════════');

  L.push('── 召回单元 ──');
  node0Result.units.forEach((u, i) => {
    const mark = u.excluded ? `✗排除[${u.excludeReason}${u.jaccard !== undefined ? ` J=${u.jaccard}` : ''}]` : '✓';
    L.push(`[${i}] ${u.type} ${mark} ${u.raw.slice(0, 40)}${u.raw.length > 40 ? '…' : ''}`);
  });

  const toks = node1Result.contextTokens;
  L.push('── 保留词 ──');
  for (const t of toks.filter(t => !t.filtered)) {
    const extra = t.lang === 'zh'
      ? `bcc=${t.bccFreq} conc=${t.conc ?? '-'}`
      : `conc=${t.conc ?? '-'}`;
    L.push(`  ✓ ${t.word}  [${t.lang}/${t.pos}${t.oov ? '/OOV' : ''}] u${t.unit} 留因=${t.keptBy} ${extra}`);
  }
  L.push('── 滤除词(按层) ──');
  for (const reason of ['stop', 'bcc', 'conc', 'pos', 'punct', 'time', 'frag', 'colloq']) {
    const group = toks.filter(t => t.filtered && t.reason === reason);
    if (!group.length) continue;
    const detail = group.map(t => {
      if (reason === 'bcc') return `${t.word}(${t.bccFreq})`;
      if (reason === 'conc') return `${t.word}(${t.conc})`;
      if (reason === 'pos') return `${t.word}(${t.pos})`;
      return t.word;
    });
    L.push(`  ✗ ${reason}: ${detail.join(' ')}`);
  }

  if (node1Result.timeAnchors.length) {
    L.push('── 时间锚(不进发散) ──');
    L.push('  ' + node1Result.timeAnchors.map(a => `${a.raw}@u${a.unit}`).join('  '));
  }
  if (node1Result.truncation.length) {
    L.push('── 截断 ──');
    L.push('  ' + node1Result.truncation.map(t => `u${t.unit} 丢弃${t.dropped}词`).join('  '));
  }
  L.push(`── 环境 ── 分词=${node1Result.provider.segmenter} 词性=${node1Result.provider.pos} hanlp=${node1Result.provider.hanlp}`);
  L.push(`资源: ${Object.entries(node1Result.resources).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return L.join('\n');
}
