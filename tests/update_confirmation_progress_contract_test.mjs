import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')
const update = read('src/server/autoupdate.mjs')
const endpoints = read('src/server/web_server/endpoints.mjs')
const base = read('src/public/pages/base.mjs')
const server = read('src/server/server.mjs')
const psLauncher = read('path/beilu-always-accompany.ps1')
const shLauncher = read('path/beilu-always-accompany.sh')
const exeLauncher = read('path/exe-launcher.ps1')

assert.match(update, /setInterval\(detectRemoteUpdate, CHECK_INTERVAL_MS\)/, 'timer must only detect updates')
assert.doesNotMatch(update, /setInterval\(applyAvailableUpdate|setTimeout\(applyAvailableUpdate/, 'apply must never be timer-triggered')
assert.match(update, /let _applyPromise = null/, 'apply must be single-flight')
assert.match(update, /remote !== expectedCommit/, 'apply must revalidate the confirmed commit after fetch')
assert.match(update, /--untracked-files=no/, 'tracked worktree must be checked without deleting user data')
assert.match(update, /\['pull', '--ff-only', UPDATE_REMOTE, 'main'\]/, 'only fast-forward pull is allowed')
assert.match(update, /remotes\.includes\('private'\) \? 'private' : 'origin'/, 'private main must be preferred when that remote is configured')
for (const phase of ['checking', 'available', 'preflight', 'marker-written', 'pulling', 'verified', 'restart-scheduled']) {
	assert.ok(update.includes(`'${phase}'`), `missing update phase ${phase}`)
}

assert.match(endpoints, /router\.get\("\/api\/update\/status", authenticate/, 'status must require authentication')
assert.match(endpoints, /router\.post\("\/api\/update\/apply", requireOwner/, 'apply must require owner')
assert.match(endpoints, /startAvailableUpdate\(req\.body\?\.expectedCommit\)/, 'endpoint must forward the exact confirmed commit')

assert.match(base, /onServerEvent\('update-available'/, 'frontend must consume availability')
assert.match(base, /onServerEvent\('update-progress'/, 'frontend must consume progress')
assert.match(base, /commitId === _expectedUpdateCommit/, 'success must be confirmed by reconnecting target commit')
assert.match(base, /sessionStorage\.setItem\('beilu-update-expected-commit'/, 'expected commit must survive page reload during restart')
assert.match(base, /_scheduleUpdatePoll\(\)/, 'busy progress must recover through status polling')
assert.match(base, /document\.createElement\('progress'\)/, 'frontend must render a progress element')
assert.match(base, /text\.textContent =/, 'remote status must be rendered as text')
assert.doesNotMatch(base, /text\.innerHTML =/, 'remote status must never be rendered as HTML')

assert.doesNotMatch(server, /api\.github\.com\/repos\/\$\{repo\}\/releases\/latest/, 'duplicate Release detector must be removed')
assert.doesNotMatch(server, /remoteVer !== localVer/, 'string inequality must not decide update availability')
assert.doesNotMatch(psLauncher, /git .*pull --ff-only/, 'PowerShell launcher must not be a second update producer')
assert.doesNotMatch(shLauncher, /git .*pull --ff-only/, 'shell launcher must not be a second update producer')
assert.match(exeLauncher, /beilusaiying\/beilu-always-accompany\.git/, 'new installs must clone the private main repository')

console.log('update confirmation and progress contract test passed')
