import assert from 'node:assert/strict';

// Keep the contract test process-local: report vector unavailability through the real HTTP schema,
// without starting or contacting a service port. Node3 must then use neutral IB/Goldilocks factors.
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.endsWith('/health')) {
    return new Response(JSON.stringify({ ok: true, service: 'vector', contract: 'beilu-p1-cluster-v2' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (target.endsWith('/nb_cosine')) {
    return new Response(JSON.stringify({ available: false, why: 'contract_test_no_vector' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new Error(`unexpected fake cluster URL: ${target}`);
};

const { calcBlq, calcLogicFactors, PARAMS, scorePool } = await import('../node3_score.mjs');

const noSignal = { rels: ['RelatedTo'], sources: ['swow'] };
const withSignal = { rels: ['Causes'], sources: ['conceptnet'] };

for (const mode of ['chat', 'airp', 'code', 'work']) {
  const factors = calcLogicFactors(noSignal, mode);
  assert.deepEqual(
    {
      rawLogic: factors.rawLogic,
      logicModeWeight: factors.logicModeWeight,
      weightedLogic: factors.weightedLogic,
      hasLogicSignal: factors.hasLogicSignal,
    },
    { rawLogic: 1, logicModeWeight: 1, weightedLogic: 1, hasLogicSignal: false },
    `${mode}: a mode weight must not create a logic signal`,
  );
}

const expectedWeights = { chat: 1.0, airp: 0.8, code: 3.0, work: 1.5 };
for (const [mode, expectedWeight] of Object.entries(expectedWeights)) {
  const factors = calcLogicFactors(withSignal, mode);
  assert.equal(factors.rawLogic, 0.9, `${mode}: Causes must retain its REL_WEIGHTS raw score`);
  assert.equal(factors.logicModeWeight, expectedWeight, `${mode}: must use the design mode logic weight`);
  assert.equal(factors.weightedLogic, +(0.9 * expectedWeight).toFixed(3), `${mode}: weight must apply exactly once`);
  assert.equal(factors.hasLogicSignal, true);
}

assert.deepEqual(
  Object.fromEntries(Object.entries(expectedWeights).map(([mode]) => [mode, PARAMS.MODE_WEIGHTS[mode].logic])),
  expectedWeights,
  'chat/airp/code/work mode weights must retain the design values',
);

// Both scoring stages call the same product. With ib=1, final BLQ must equal pre-BLQ;
// a real IB factor may only scale that same already-weighted logic factor once.
const codeLogic = calcLogicFactors(withSignal, 'code');
const common = { vote: Math.pow(2, PARAMS.VOTE_ALPHA), weightedLogic: codeLogic.weightedLogic, novelty: 0.5 };
const preBlq = calcBlq(common);
const finalAtNeutralIb = calcBlq({ ...common, ib: 1 });
const finalWithIb = calcBlq({ ...common, ib: 0.4 });
assert.equal(finalAtNeutralIb, preBlq, 'pre-filter and final BLQ must agree when IB is neutral');
assert.equal(finalWithIb, preBlq * 0.4, 'final BLQ must add only IB, not a second logic mode weight');

// Exercise the production scorePool assembly as well: factors must expose the full logic chain,
// and status text must not claim EmoBank/user_pref participates in scoring.
const scoreResult = await scorePool({
  mode: 'code',
  inputWords: { zh: ['锚'], en: [] },
  pool: [{
    word: '逻辑词', rels: ['Causes'], sources: ['conceptnet'],
    strength: 1, resonance: 2, via: ['锚'],
  }],
}, { historyMode: false });
assert.equal(scoreResult.scored.length, 1);
const emitted = scoreResult.scored[0];
assert.deepEqual(
  {
    rawLogic: emitted.factors.rawLogic,
    logicModeWeight: emitted.factors.logicModeWeight,
    weightedLogic: emitted.factors.weightedLogic,
    hasLogicSignal: emitted.factors.hasLogicSignal,
  },
  { rawLogic: 0.9, logicModeWeight: 3, weightedLogic: 2.7, hasLogicSignal: true },
  'scorePool factors must expose the raw, mode, and effective logic values',
);
assert.equal(emitted.factors.logic, emitted.factors.weightedLogic, 'legacy whitebox logic alias must show the effective factor');
assert.match(scoreResult.factorStatus.emobank, /not consumed in score/);
assert.match(scoreResult.factorStatus.user_pref, /not_consumed/);
assert.equal(
  emitted.score,
  +(calcBlq({ vote: Math.pow(2, PARAMS.VOTE_ALPHA), weightedLogic: 2.7, novelty: 1 })
    + PARAMS.POOL_STRENGTH_W).toFixed(4),
  'neutral-vector final score must reuse the same single-weight BLQ as the pre-filter',
);

console.log(JSON.stringify({
  passed: true,
  noSignalModes: ['chat', 'airp', 'code', 'work'],
  signalWeights: expectedWeights,
  code: { ...codeLogic, preBlq, finalAtNeutralIb, finalWithIb },
  scorePool: {
    factors: emitted.factors,
    score: emitted.score,
    emobankStatus: scoreResult.factorStatus.emobank,
    userPrefStatus: scoreResult.factorStatus.user_pref,
  },
}, null, 2));
