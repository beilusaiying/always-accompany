import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(repoRoot, 'src/server/autoupdate.mjs'), 'utf8')

const ancestryGuard = source.indexOf("gitAsync(['merge-base', '--is-ancestor', local, remote])")
const markerWrite = source.indexOf('markP1RestartAfterUpdate(remote)')
const pull = source.indexOf("gitAsync(['pull', '--ff-only', UPDATE_REMOTE, 'main'])")
const appliedCheck = source.indexOf('if (appliedCommit !== remote)')
const compensation = source.indexOf('clearP1RestartAfterFailedUpdate()', appliedCheck)
const unchangedGuard = source.indexOf('if (appliedCommit === local)', appliedCheck)
const restart = source.indexOf('setTimeout(restartor, 2000)')

assert.ok(ancestryGuard >= 0 && ancestryGuard < markerWrite, 'must reject non-fast-forward updates before writing the P1 restart marker')
assert.ok(markerWrite < pull, 'P1 restart marker must be durable before source update')
assert.ok(pull < appliedCheck && appliedCheck < unchangedGuard && unchangedGuard < compensation, 'marker compensation is allowed only when HEAD is proven unchanged')
assert.ok(compensation < restart, 'restart may only be scheduled after update verification')
assert.match(source, /existsSync\(P1_RESTART_MARKER\)/, 'an unfinished prior recovery marker must block another update')
assert.match(source, /if \(!appliedCommit\)[\s\S]*?已保留 P1 恢复标记/, 'unreadable post-pull HEAD must retain the P1 recovery marker')

console.log('autoupdate failure compensation contract test passed')
