import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(
  repoRoot,
  'src/public/parts/shells/beilu-chat/public/src/panels/settings/slots/apiSlot.mjs',
), 'utf8')

const listPopulation = source.indexOf('listEl.innerHTML = models.map')
const emptyGuard = source.indexOf('if (!modelInput.value.trim() && listEl.value)')
const saveRead = source.indexOf("model: $('sa-api-model').value.trim()")

assert.ok(listPopulation >= 0, 'model options must be populated from the fetched list')
assert.ok(emptyGuard > listPopulation, 'the visually selected first option must populate an empty model field')
assert.ok(saveRead >= 0, 'save must continue reading the existing model input as the single source')
assert.doesNotMatch(
  source.slice(emptyGuard, emptyGuard + 160),
  /dispatchEvent|sendAction|saveAISource/,
  'default selection must not create a second save or event chain',
)

console.log('api slot first-model contract test passed')
