import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(
  repoRoot,
  'src/public/parts/shells/beilu-chat/public/src/panels/feature/featureControls.mjs',
), 'utf8')

const fnAt = source.indexOf('async function _doSwitchModeInner(targetMode, opts = {})')
const tabResolveAt = source.indexOf('if (opts.tab) {', fnAt)
const afterResolveAt = source.indexOf('const _tab = opts.tab || undefined;', tabResolveAt)
assert.ok(fnAt >= 0 && tabResolveAt > fnAt && afterResolveAt > tabResolveAt, 'tab target resolution block must exist')

const beforeResolve = source.slice(fnAt, tabResolveAt)
const tabResolve = source.slice(tabResolveAt, afterResolveAt)

// 用户意图 UI 先翻转；解析失败必须在本函数内回滚并返回确定失败，供 layout 回退 tab。
assert.match(beforeResolve, /updateModeSwitchUI\(targetMode\);/, 'mode intent UI must still flip before authoritative resolution')
assert.match(tabResolve, /catch \(err\) \{[\s\S]*?模式目标对话解析失败/, 'authoritative resolution errors must be caught visibly')
assert.match(tabResolve, /_publicToast\("error", `模式切换失败: \$\{err\.message\}`\);/, 'resolution failure must be visible to the user')
assert.match(tabResolve, /updateModeSwitchUI\(currentMode\);[\s\S]*?return false;/, 'resolution failure must roll UI back and resolve false')

// tab 联动目标只来自服务端 mode_active_chats 在 fetchChatList 上的投影。
assert.match(tabResolve, /const \{ fetchChatList \} = await import/, 'tab switch must read the authoritative chat list')
assert.match(tabResolve, /await fetchChatList\(\)/, 'authoritative list read must complete before choosing a target')
assert.match(tabResolve, /c\?\.primaryCharName === _targetChar/, 'authoritative target must be scoped to the current character')
assert.match(tabResolve, /c\.usedByModes\.includes\(targetMode\)/, 'authoritative target must be selected by server-projected mode usage')
assert.match(tabResolve, /\?\.chatid/, 'authoritative projection must yield the target chat id')

// 权威表缺线时只复用既有服务端幂等创建口；本地缓存/hash 不得成为目标 fallback。
assert.match(tabResolve, /if \(!_tgtCid\)[\s\S]*?verb: "ensureModeChats"/, 'missing authoritative line must reuse ensureModeChats')
assert.match(tabResolve, /_rep\?\.modeChats\?\.\[targetMode\]/, 'ensureModeChats result must be resolved by target mode')
assert.match(tabResolve, /if \(!_tgtCid \|\| !isValidChatId\(_tgtCid\)\) throw new Error/, 'missing or invalid authoritative coordinates must fail closed')
assert.doesNotMatch(tabResolve, /storage\.get\(_tgtKey\)/, 'local mode cache must not choose the tab target')
assert.doesNotMatch(tabResolve, /_beiluGetChatId/, 'current hash must not be used as a tab target fallback')
assert.match(tabResolve, /_chatid = _tgtCid;/, 'tab scope must be replaced only by the authoritative target')

console.log('mode chat switch race contract test passed')
