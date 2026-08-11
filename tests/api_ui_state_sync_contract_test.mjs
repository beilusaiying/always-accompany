import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const apiConfig = read('src/public/parts/shells/beilu-chat/public/src/panels/settings/apiConfig.mjs')
const apiSlot = read('src/public/parts/shells/beilu-chat/public/src/panels/settings/slots/apiSlot.mjs')
const smart = read('src/public/parts/shells/beilu-chat/public/src/panels/smart/smart.mjs')

// 隐藏设置页时 resource 事件仍须被消费；自身派发则继续同步抑制，避免重复刷新。
for (const [name, source] of [['apiConfig', apiConfig], ['apiSlot', apiSlot]]) {
  const listenerAt = source.lastIndexOf("window.addEventListener('resource:api-changed'")
  assert.ok(listenerAt >= 0, `${name} must consume resource:api-changed`)
  const listener = source.slice(listenerAt, listenerAt + 700)
  assert.doesNotMatch(listener, /whenVisible\s*\(/, `${name} must not drop the resource event while hidden`)
  assert.match(listener, /_suppressApiReload/, `${name} must retain self-dispatch suppression`)
}
assert.match(apiConfig, /assertApiSourceReadback\(persisted,[\s\S]*?'保存'\)/, 'apiConfig save must retain authoritative readback')
assert.match(apiSlot, /assertApiSourceReadback\(persisted,[\s\S]*?'保存'\)/, 'apiSlot save must retain authoritative readback')

// 列表失败必须显式终止；外部删除当前项后只可选择仍存在项、首项或清空。
const loadListAt = apiSlot.indexOf('const loadList = async () =>')
const loadSourceAt = apiSlot.indexOf('const loadSource = async', loadListAt)
const loadList = apiSlot.slice(loadListAt, loadSourceAt)
assert.match(loadList, /return true;/, 'loadList must report success')
assert.match(loadList, /catch[\s\S]*return false;/, 'loadList must report failure')
assert.doesNotMatch(loadList, /loadSource\s*\(/, 'loadList must not create an implicit second source load')

const externalListenerAt = apiSlot.lastIndexOf("window.addEventListener('resource:api-changed'")
const externalListener = apiSlot.slice(externalListenerAt, externalListenerAt + 900)
assert.match(externalListener, /if \(!await loadList\(\)\) return;/, 'list failure must stop external refresh')
assert.match(externalListener, /apiSources\.includes\(currentName\)/, 'current source must be revalidated against refreshed inventory')
assert.match(externalListener, /apiSources\[0\] \|\| ''/, 'deleted current source must fall back to the first existing source')
assert.match(externalListener, /else clearForm\(\)/, 'empty inventory must clear the form')

// SMART source/model 不得进入通用镜像或改写 apiConfig 编辑对象；唯一写点是 awaited runtime bridge。
const mirrorAt = smart.indexOf('const SMART_MIRROR_PAIRS')
const mirrorEnd = smart.indexOf('let _smartMirrorBound', mirrorAt)
const mirrorPairs = smart.slice(mirrorAt, mirrorEnd)
assert.doesNotMatch(mirrorPairs, /"smart-api-(?:source|model)"\s*,/, 'SMART API controls must not use generic DOM mirroring')
assert.doesNotMatch(smart, /_beiluSetModel/, 'SMART model changes must not rewrite apiConfig model DOM/shared edit state')
assert.doesNotMatch(smart, /getElementById\("api-fetch-models"\)/, 'SMART model refresh must not click the apiConfig current-edit-source button')

const sourceHandlerAt = smart.indexOf('smartSrc?.addEventListener("change", async () =>')
const modelHandlerAt = smart.indexOf('smartModel?.addEventListener("change", async () =>', sourceHandlerAt)
const inventoryObserverAt = smart.indexOf('if (sourceInventory)', modelHandlerAt)
const sourceHandler = smart.slice(sourceHandlerAt, modelHandlerAt)
const modelHandler = smart.slice(modelHandlerAt, inventoryObserverAt)
assert.match(sourceHandler, /await syncRuntime\(\{ api_source: sourceName \}\)/, 'source write must await the runtime single writer')
assert.match(modelHandler, /await syncRuntime\(\{ model: modelName \}\)/, 'model write must await the runtime single writer')
for (const [name, handler] of [['source', sourceHandler], ['model', modelHandler]]) {
  const successAt = handler.indexOf('showToast("success"')
  const okAt = handler.indexOf('if (ok)')
  const failureAt = handler.indexOf('} else {', okAt)
  const readbackAt = handler.indexOf('const restored = await _restoreSmartApiOverrides()', failureAt)
  assert.ok(okAt >= 0 && successAt > okAt, `${name} success feedback must be gated by a true write result`)
  assert.ok(failureAt > successAt && readbackAt > failureAt, `${name} failure path must read back authority before rollback`)
}

// 模型库存按 SMART 当前源强制实时读；角色、runtime 与源库存变化均回读，latestOnly 抵御重复/乱序事件。
assert.match(smart, /getModels\(sourceName, \{ force: true \}\)/, 'model inventory must be fetched for the SMART source with force=true')
assert.match(smart, /const _restoreSmartApiOverrides = latestOnly\(/, 'repeated restore events must not let stale reads win')
assert.match(smart, /new MutationObserver\([\s\S]*?_projectSmartApiSources\(\);[\s\S]*?_restoreSmartApiOverrides\(\)/, 'source inventory changes must project then read back valid overrides')
assert.match(smart, /addEventListener\("beilu:char-changed", \(\) => \{ void _restoreSmartApiOverrides\(\); \}\)/, 'character changes must read back runtime overrides')
assert.match(smart, /addEventListener\("beilu:runtime-params-changed", \(\) => \{ void _restoreSmartApiOverrides\(\); \}\)/, 'runtime changes must read back runtime overrides')

console.log('api UI state sync contract test passed')
