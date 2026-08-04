import assert from 'node:assert/strict';

import { applyConfig } from '../config_map.mjs';
import { PARAMS, classifyExclusion, jaccardBigram, recallSelect } from '../node0_recall.mjs';

assert.equal(PARAMS.COPY_JACCARD_THRESHOLD, 0.7);

const copiedText = 'abcdef';
const assistantText = 'abcxef';
const similarity = jaccardBigram(copiedText, assistantText);
assert.equal(similarity, 3 / 7);

let configResult = applyConfig({ copyJaccardThreshold: 0.4 });
assert.equal(configResult.applied.copyJaccardThreshold, 0.4);
let classified = classifyExclusion(copiedText, assistantText);
assert.deepEqual(classified, {
  excluded: true,
  reason: 'copy',
  jaccard: 0.429,
  threshold: 0.4,
  copyMatched: true,
});

let selected = recallSelect({
  currentUserText: 'current message',
  messages: [
    { role: 'assistant', content: assistantText },
    { role: 'user', content: copiedText },
  ],
});
assert.equal(selected.params.COPY_JACCARD_THRESHOLD, 0.4);
let contextUnit = selected.units.find(unit => unit.type === 'user_context');
assert.equal(contextUnit?.excludeReason, 'copy');
assert.equal(contextUnit?.jaccard, 0.429);
assert.equal(contextUnit?.threshold, 0.4);
assert.equal(contextUnit?.copyMatched, true);

configResult = applyConfig({ copyJaccardThreshold: 0.5 });
assert.equal(configResult.applied.copyJaccardThreshold, 0.5);
classified = classifyExclusion(copiedText, assistantText);
assert.deepEqual(classified, {
  excluded: false,
  jaccard: 0.429,
  threshold: 0.5,
  copyMatched: false,
});

selected = recallSelect({
  currentUserText: 'current message',
  messages: [
    { role: 'assistant', content: assistantText },
    { role: 'user', content: copiedText },
  ],
});
assert.equal(selected.params.COPY_JACCARD_THRESHOLD, 0.5);
contextUnit = selected.units.find(unit => unit.type === 'user_context');
assert.equal(contextUnit?.excluded, false);
assert.equal(contextUnit?.jaccard, 0.429);
assert.equal(contextUnit?.threshold, 0.5);
assert.equal(contextUnit?.copyMatched, false);

classified = classifyExclusion('请你继续这段文字', '请你继续这段文字');
assert.deepEqual(classified, {
  excluded: true,
  reason: 'ai_command',
  jaccard: 1,
  threshold: 0.5,
  copyMatched: true,
});

selected = recallSelect({
  currentUserText: 'current message',
  messages: [{ role: 'user', content: 'context without assistant' }],
});
contextUnit = selected.units.find(unit => unit.type === 'user_context');
assert.equal(contextUnit?.excluded, false);
assert.equal(contextUnit?.jaccard, null);
assert.equal(contextUnit?.threshold, 0.5);
assert.equal(contextUnit?.copyMatched, false);

assert.equal(applyConfig({ copyJaccardThreshold: -1 }).applied.copyJaccardThreshold, 0);
assert.equal(applyConfig({ copyJaccardThreshold: 2 }).applied.copyJaccardThreshold, 1);

applyConfig({ copyJaccardThreshold: 0.7 });
assert.equal(classifyExclusion('same text', 'same text').reason, 'copy');

console.log(JSON.stringify({
  pass: true,
  similarity,
  copyAtThreshold: 0.4,
  notCopyAtThreshold: 0.5,
  paramsKey: 'COPY_JACCARD_THRESHOLD',
  defaultRestored: 0.7,
}));
