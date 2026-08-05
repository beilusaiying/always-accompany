import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'src/yonban/core/functions/memory/p1/serviceRuntime.mjs'), 'utf8')
const dirs = source.indexOf('mkdirSync(dir, { recursive: true })')
const deps = source.indexOf('await _ensurePythonDeps()')
assert.ok(dirs >= 0, 'P1 runtime must create its runtime directories')
assert.ok(deps > dirs, 'Python dependencies must install after the marker parent directory exists')
assert.match(source, /DEPS_MARKER/, 'dependency installation must retain a persistent marker')
console.log('P1 service runtime start order contract test passed')
