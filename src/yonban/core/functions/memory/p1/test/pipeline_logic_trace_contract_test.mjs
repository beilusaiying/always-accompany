import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildScoredPoolTrace,
  renderFullWhitebox,
  SCORED_POOL_TRACE_LIMIT,
} from '../pipeline.mjs';

const signalCandidate = {
  word: '逻辑词',
  score: 3.7,
  sources: ['conceptnet'],
  resonance: 2,
  factors: {
    vote: 2,
    ib: 1,
    d: 0,
    logic: 2.7,
    rawLogic: 0.9,
    logicModeWeight: 3,
    weightedLogic: 2.7,
    hasLogicSignal: true,
    logicDims: { deductive: 0.9 },
    novelty: 1,
    nbCos: null,
    goldilocks: { factor: 1, zone: 'neutral' },
    modeBonus: 0,
  },
};
const neutralCandidate = {
  word: '中性词',
  score: 2,
  sources: ['swow'],
  resonance: 1,
  factors: {
    vote: 1,
    ib: 1,
    d: 0,
    logic: 1,
    rawLogic: 1,
    logicModeWeight: 1,
    weightedLogic: 1,
    hasLogicSignal: false,
    logicDims: {},
    novelty: 1,
    nbCos: null,
    goldilocks: { factor: 1, zone: 'neutral' },
    modeBonus: 0,
  },
};

const mapped = buildScoredPoolTrace([signalCandidate, neutralCandidate]);
assert.deepEqual(mapped.map(({ factors }) => factors), [
  {
    logic: 2.7,
    rawLogic: 0.9,
    logicModeWeight: 3,
    weightedLogic: 2.7,
    hasLogicSignal: true,
  },
  {
    logic: 1,
    rawLogic: 1,
    logicModeWeight: 1,
    weightedLogic: 1,
    hasLogicSignal: false,
  },
]);

const oversized = Array.from({ length: SCORED_POOL_TRACE_LIMIT + 7 }, (_, index) => ({
  ...neutralCandidate,
  word: `neutral-${index}`,
}));
assert.equal(buildScoredPoolTrace(oversized).length, SCORED_POOL_TRACE_LIMIT, 'production scoredPool trace must stay bounded');

const fakePipelineResult = {
  mode: 'code',
  n0: { units: [] },
  n1: {
    contextTokens: [],
    timeAnchors: [],
    truncation: [],
    provider: { segmenter: 'fake', pos: 'fake', hanlp: 'fake' },
    resources: {},
  },
  n2: {
    status: 'ok', errors: [], mechanisms: [], pool: [],
    wnDomainFiltered: [], removedBySecondPass: [],
  },
  n3: {
    factorStatus: { logic: 'live(contract-test)' },
    scored: [signalCandidate, neutralCandidate],
    droppedByNb: [],
  },
  n4: {
    llmTokenizer: 'fake', docTokensMode: 'fake', fusion: 'weighted',
    nbDedupAvailable: false, nbDedupWhy: 'contract_test',
    nbDedupCoveredPairs: 0, nbDedupPairCount: 0,
    dedupTrace: [], ranked: [],
  },
  storageDiagnostics: [],
};
const whitebox = renderFullWhitebox(fakePipelineResult);
assert.match(whitebox, /raw×mode=weighted: 0\.9×3=2\.7; signal/);
assert.match(whitebox, /raw×mode=weighted: 1×1=1; no-signal neutral/);

// The process-local shape mapper above is the exact function wired into the
// production stdio response; keep this assertion at the producer→trace boundary.
const stdioSource = readFileSync(new URL('../p1_service_stdio.mjs', import.meta.url), 'utf8');
assert.match(stdioSource, /scoredPool:\s*buildScoredPoolTrace\(r\.n3\?\.scored\)/);

console.log(JSON.stringify({
  passed: true,
  traceLimit: SCORED_POOL_TRACE_LIMIT,
  signal: mapped[0].factors,
  neutral: mapped[1].factors,
  whiteboxLines: whitebox.split('\n').filter((line) => line.includes('raw×mode=weighted')),
}, null, 2));
