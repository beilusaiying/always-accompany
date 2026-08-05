import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { modelsRequestFor } from '../src/public/pages/scripts/modelListRequest.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const presetSource = read('src/public/parts/shells/beilu-chat/public/src/panels/airp/preset.mjs')
const sharedSource = read('src/public/parts/shells/beilu-chat/public/src/shared/state/sharedState.mjs')
const backendSource = read('src/yonban/core/functions/memory/handler/setDataActions.mjs')
const apiChannelsSource = read('src/public/parts/shells/beilu-chat/public/src/panels/settings/apiChannels.mjs')

assert.ok(fs.existsSync(path.join(repoRoot, 'src/public/pages/scripts/modelListRequest.mjs')), 'browser /scripts contract module must exist under the static pages root')
assert.match(apiChannelsSource, /from '\/scripts\/modelListRequest\.mjs'/, 'browser import must target the static /scripts URL')
assert.equal(new URL('/scripts/modelListRequest.mjs', 'http://localhost/parts/shells:beilu-chat/src/panels/settings/apiChannels.mjs').pathname, '/scripts/modelListRequest.mjs')

function extractBalancedFunction(source, signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `missing function: ${signature}`)
  const bodyStart = source.indexOf(') {', start) + 2
  assert.ok(bodyStart > 1, `missing function body: ${signature}`)
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated function: ${signature}`)
}

const fetchModelsSource = extractBalancedFunction(presetSource, 'async function fetchModels')
const getModelsCaseStart = backendSource.indexOf('case "getModels":')
const getModelsCaseEnd = backendSource.indexOf('case "testClone":', getModelsCaseStart)
assert.ok(getModelsCaseStart >= 0 && getModelsCaseEnd > getModelsCaseStart, 'backend getModels case must exist')
const getModelsCase = backendSource.slice(getModelsCaseStart, getModelsCaseEnd)

// API URL and response shape remain one contract for both backend and browser fallback.
const ollamaRequest = modelsRequestFor({ generator: 'ollama' }, 'http://localhost:11434')
assert.equal(ollamaRequest.url, 'http://localhost:11434/api/tags')
assert.deepEqual(ollamaRequest.normalize({ models: [{ name: 'qwen3' }, { name: 'gemma3' }] }), ['qwen3', 'gemma3'])
const openAiRequest = modelsRequestFor({ generator: 'proxy', provider: 'deepseek' }, 'https://api.example.test/v1')
assert.equal(openAiRequest.url, 'https://api.example.test/v1/models')
assert.deepEqual(openAiRequest.normalize({ data: [{ id: 'model-b' }, { id: 'model-a' }] }), ['model-b', 'model-a'])

assert.match(fetchModelsSource, /getElementById\("api-select"\)\?\.value\?\.trim\(\)/, 'preset must read the saved source name')
assert.match(fetchModelsSource, /getCachedModelList\(sourceName, \{ force: true \}\)/, 'preset must use the shared forced-refresh path')
assert.doesNotMatch(fetchModelsSource, /apiConfig|getCurrentChannelEntry|modelsRequestFor|normalizeModelsUrl|fetch\(/, 'preset must not retain a direct or temporary-config request path')
assert.match(fetchModelsSource, /请先选择已保存的 API 源/, 'empty source must have an explicit user-facing error')
assert.match(fetchModelsSource, /savedModel && select && _seq === _fetchModelsSeq/, 'failure fallback must retain the saved model only for the newest request')

assert.match(sharedSource, /payload: \{ sourceName \}/, 'shared backend request must carry sourceName')
assert.match(sharedSource, /modelsRequestFor\(\{[\s\S]*?generator: src\?\.generator,[\s\S]*?provider:/, 'browser fallback must derive the request from the saved source metadata')
assert.match(sharedSource, /request\.normalize\(d\)/, 'browser fallback must use the shared response normalizer')

assert.match(getModelsCase, /generator = sourceData\.generator/, 'backend must read generator from the saved source')
assert.match(getModelsCase, /provider = sourceConfig\.convert_config\?\.provider/, 'backend must read provider from the saved source')
assert.match(getModelsCase, /sourceConfig\.host/, 'backend must support the Ollama host field')
assert.match(getModelsCase, /modelsRequestFor\(\{ generator, provider \}, url\)/, 'backend must use the shared endpoint contract')
assert.match(getModelsCase, /request\.normalize\(result\)/, 'backend must use the shared response normalizer')
assert.doesNotMatch(getModelsCase, /\/api\/tags|\/v1\/models|\(未指定\)/, 'backend must not hand-code endpoints or emit an unspecified-source diagnostic')

class FakeClassList {
  constructor(...names) { this.names = new Set(names) }
  add(name) { this.names.add(name) }
  remove(name) { this.names.delete(name) }
  contains(name) { return this.names.has(name) }
}

class FakeSelect {
  constructor() {
    this.options = []
    this.classList = new FakeClassList('hidden')
    this._value = ''
  }
  get value() { return this._value }
  set value(value) { this._value = String(value ?? '') }
  set innerHTML(html) {
    this.options = []
    this._value = ''
    if (html.includes('<option')) this.options.push({ value: '', textContent: '选择模型...', selected: true })
  }
  appendChild(option) {
    this.options.push(option)
    if (option.selected) this._value = option.value
  }
}

const sourceSelect = new FakeSelect()
const modelSelect = new FakeSelect()
const savedModelInput = { value: '' }
const button = { disabled: false, classList: new FakeClassList() }
const elements = new Map([
  ['api-select', sourceSelect],
  ['api-model', savedModelInput],
])
const document = {
  getElementById: (id) => elements.get(id) || null,
  createElement: () => ({ value: '', textContent: '', selected: false }),
}
const toasts = []
const calls = []
const pending = []
const fakeGetCachedModelList = (sourceName, opts) => {
  calls.push({ sourceName, opts })
  return new Promise((resolve) => pending.push({ sourceName, resolve }))
}
const makeFetchModels = new Function(
  'document',
  'apiFetchModelsBtn',
  'apiModelSelect',
  'showToast',
  'getCachedModelList',
  'console',
  `let _fetchModelsSeq = 0; ${fetchModelsSource}; return fetchModels;`,
)
const fetchModels = makeFetchModels(
  document,
  button,
  modelSelect,
  (message, type) => toasts.push({ message, type }),
  fakeGetCachedModelList,
  { error() {} },
)

sourceSelect.value = ''
await fetchModels()
assert.equal(toasts.at(-1)?.message, '请先选择已保存的 API 源')

sourceSelect.value = 'source-a'
const older = fetchModels({ silent: true })
sourceSelect.value = 'source-b'
const newer = fetchModels({ silent: true })
assert.deepEqual(calls.slice(0, 2), [
  { sourceName: 'source-a', opts: { force: true } },
  { sourceName: 'source-b', opts: { force: true } },
])
pending.find((item) => item.sourceName === 'source-b').resolve(['model-b2', 'model-b1'])
await newer
pending.find((item) => item.sourceName === 'source-a').resolve(['model-a'])
await older
assert.deepEqual(modelSelect.options.map((option) => option.value).filter(Boolean), ['model-b1', 'model-b2'], 'the later request must win even when the older response arrives last')
assert.equal(button.disabled, false)
assert.equal(button.classList.contains('loading'), false)

savedModelInput.value = 'saved-model'
sourceSelect.value = 'source-c'
const failed = fetchModels()
pending.find((item) => item.sourceName === 'source-c').resolve([])
await failed
assert.deepEqual(modelSelect.options.map((option) => option.value), ['saved-model'], 'an empty/failed refresh must retain the saved model')
assert.equal(modelSelect.value, 'saved-model')
assert.equal(toasts.at(-1)?.type, 'error')

sourceSelect.value = 'source-d'
const supersededByEmptySource = fetchModels({ silent: true })
assert.equal(button.classList.contains('loading'), true)
sourceSelect.value = ''
await fetchModels({ silent: true })
assert.equal(button.disabled, false, 'an empty-source request must terminate loading from an older request')
assert.equal(button.classList.contains('loading'), false)
pending.find((item) => item.sourceName === 'source-d').resolve(['model-d'])
await supersededByEmptySource
assert.equal(button.classList.contains('loading'), false)

console.log('model fetch single-path contract test passed')
