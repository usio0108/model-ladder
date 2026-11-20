import '../helpers/isolate-home.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { begin, check } from '../../scripts/fast-path.mjs'
import { latestPerRun, summarize, telemetryRecord } from '../../scripts/telemetry.mjs'
import { checksStatus, ciEvidence, cloudCapability, cloudHandoff, deliveryGate } from '../../scripts/ci-evidence.mjs'
import { parseTaskContract } from '../../scripts/task-contract.mjs'
import { artifactDir } from '../../scripts/common.mjs'

const dirs = []
after(() => { for (const dir of dirs) { rmSync(artifactDir(dir), { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) } })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (root, file, value) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), value) }
// A binary that records any launch: the fast path must never start one.
const sentinel = join(mkdtempSync(join(tmpdir(), 'ml-sentinel-')), 'launched')
process.env.CODEX_BINARY = process.env.CLAUDE_BINARY = sentinel
function fixture(verify = 'node --test tests/check.test.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'ml-fast-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 'test@example.test')
  git(dir, 'config', 'core.autocrlf', 'false')
  write(dir, '.gitignore', '.model-ladder/\n')
  write(dir, 'greeting.mjs', 'export default "Wellcome"\n')
  write(dir, 'other.mjs', 'export default 1\n')
  write(dir, 'tests/check.test.mjs', 'import assert from "node:assert/strict"\nimport greeting from "../greeting.mjs"\nassert.equal(greeting,"Welcome")\n')
  write(dir, '.codex/model-ladder.json', JSON.stringify({ verify }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'fixture')
  return dir
}
const contract = (dir, overrides = {}) => ({ contract: { version: 1, id: 'greeting', task: 'Fix the greeting typo', repository: dir, scope: ['greeting.mjs'], coverage: 'complete', complexity: 'small', ...overrides } })
const history = (dir) => readFileSync(join(dir, '.model-ladder/history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)

test('fast path verifies a session edit with no router, worker process or reviewer', async () => {
  const dir = fixture()
  const ready = begin(contract(dir), { cwd: dir })
  assert.equal(ready.status, 'READY')
  assert.equal(ready.profile, 'DIRECT')
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  const result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'VERIFIED', result.message)
  assert.equal(result.delivery.status, 'LOCAL_CHECKOUT')
  assert.equal(result.delivery.ci, 'UNVERIFIED')
  assert.deepEqual(result.evidence.files, ['greeting.mjs'])
  assert.equal(result.evidence.command.status, 'PASSED')
  assert.equal(result.evidence.review.status, 'SKIPPED')
  assert.equal(existsSync(sentinel), false)
  const [line] = history(dir)
  assert.equal(line.telemetry.router.calls, 0)
  assert.equal(line.telemetry.verifier.calls, 0)
  assert.equal(line.telemetry.worker.calls, 1)
  assert.equal(line.telemetry.worker.inputTokens, 'UNKNOWN')
  const record = telemetryRecord(line)
  assert.equal(record.path, 'FAST')
  assert.equal(record.tokens.router.inputTokens, 0)
  assert.equal(record.tokens.total.inputTokens, 'UNKNOWN')
  assert.equal(git(dir, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1)
})

test('fast path refuses delivery when the mandatory check fails, scope is exceeded or tests are edited', async () => {
  const dir = fixture()
  let ready = begin(contract(dir), { cwd: dir })
  write(dir, 'greeting.mjs', 'export default "Still wrong"\n')
  let result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'FAILED')
  assert.equal(result.evidence.command.status, 'FAILED')
  assert.equal(result.delivery.status, 'NOT_DELIVERED')
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'VERIFIED')
  assert.equal(telemetryRecord(history(dir).at(-1)).attempts, 2)
  git(dir, 'checkout', '--', '.')
  ready = begin(contract(dir), { cwd: dir })
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  write(dir, 'other.mjs', 'export default 2\n')
  result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'FAILED')
  assert.match(result.message, /other\.mjs/)
  git(dir, 'checkout', '--', '.')
  ready = begin(contract(dir), { cwd: dir })
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  write(dir, 'tests/check.test.mjs', '')
  result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'FAILED')
  assert.match(result.message, /protected/)
  assert.equal(result.evidence.command.status, 'SKIPPED')
})

test('fast path rejects a checkout that changed during verification and a moved HEAD', async () => {
  const dir = fixture()
  // The verify command edits the real checkout while it runs.
  write(dir, '.codex/model-ladder.json', JSON.stringify({ verify: `node -e "require('fs').appendFileSync('${join(dir, 'greeting.mjs').replaceAll('\\', '/')}', '//late')" && node --test tests/check.test.mjs` }))
  git(dir, 'commit', '-qam', 'verify')
  let ready = begin(contract(dir), { cwd: dir })
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  let result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'CONFLICT')
  assert.equal(result.errorCode, 'SNAPSHOT_CHANGED')
  assert.equal(result.delivery.status, 'NOT_DELIVERED')
  git(dir, 'checkout', '--', '.')
  ready = begin(contract(dir), { cwd: dir })
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'moved')
  result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.errorCode, 'HEAD_MOVED')
})

test('fast path sends anything but a LOW-risk DIRECT contract to the managed ladder', () => {
  const dir = fixture()
  assert.equal(begin(contract(dir, { scope: ['greeting.mjs', 'other.mjs'] }), { cwd: dir }).status, 'NOT_ELIGIBLE')
  assert.equal(begin(contract(dir, { coverage: 'partial' }), { cwd: dir }).status, 'NOT_ELIGIBLE')
  assert.equal(begin(contract(dir, { task: 'Rotate the deploy credentials' }), { cwd: dir }).status, 'NOT_ELIGIBLE')
  assert.equal(begin(contract(dir, { scope: [] }), { cwd: dir }).errorCode, 'SCOPE_REQUIRED')
  assert.equal(begin(contract(dir, { version: 2 }), { cwd: dir }).errorCode, 'INVALID_CONTRACT')
  process.env.MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX = '1'
  try { assert.equal(begin(contract(dir), { cwd: dir }).status, 'NOT_ELIGIBLE') } finally { delete process.env.MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX }
  const bare = fixture(null)
  rmSync(join(bare, 'tests'), { recursive: true })
  assert.equal(begin(contract(bare), { cwd: bare }).errorCode, 'VERIFY_COMMAND_REQUIRED')
  // Every begin failure is JSON BLOCKED so the skill can fall back.
  assert.equal(begin(contract(dir, { repository: tmpdir() }), { cwd: dir }).status, 'BLOCKED')
  write(dir, '.claude/model-ladder.json', JSON.stringify({ verify: 42 }))
  assert.equal(begin(contract(dir, { backend: 'claude' }), { cwd: dir }).errorCode, 'FAST_PATH_UNAVAILABLE')
  // An npm check of a project with dependencies cannot run in the clean verification worktree.
  const npm = fixture('npm test')
  write(npm, 'package.json', JSON.stringify({ scripts: { test: 'node --test' }, devDependencies: { jest: '1.0.0' } }))
  git(npm, 'add', '-A')
  git(npm, 'commit', '-qm', 'npm')
  assert.equal(begin(contract(npm), { cwd: npm }).errorCode, 'MISSING_DEPENDENCIES')
})

test('fast path refuses a dirty checkout, an active ladder run and checks beyond the contract limit', async () => {
  const dir = fixture()
  // A weakened test that is already uncommitted would enter the baseline unchecked.
  write(dir, 'tests/check.test.mjs', '')
  const dirty = begin(contract(dir), { cwd: dir })
  assert.equal(dirty.errorCode, 'DIRTY')
  assert.deepEqual(dirty.files, ['tests/check.test.mjs'])
  git(dir, 'checkout', '--', '.')
  mkdirSync(join(dir, '.model-ladder/runs'), { recursive: true })
  const lock = join(dir, '.model-ladder/runs/codex-00000000-0000-0000-0000-000000000000.json')
  writeFileSync(lock, JSON.stringify({ runId: 'codex-00000000-0000-0000-0000-000000000000', runtime: 'codex', pid: process.pid, startedAt: new Date().toISOString() }))
  assert.equal(begin(contract(dir), { cwd: dir }).errorCode, 'ACTIVE_RUN')
  rmSync(lock)
  // A lock that appears after begin blocks check before verify; without it check runs as usual.
  const late = begin(contract(dir), { cwd: dir })
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  writeFileSync(lock, JSON.stringify({ runId: 'codex-00000000-0000-0000-0000-000000000000', runtime: 'codex', pid: process.pid, startedAt: new Date().toISOString() }))
  const blocked = await check(late.runId, { cwd: dir })
  assert.equal(blocked.status, 'BLOCKED')
  assert.equal(blocked.errorCode, 'ACTIVE_RUN')
  assert.equal(blocked.delivery.status, 'NOT_DELIVERED')
  rmSync(lock)
  assert.equal((await check(late.runId, { cwd: dir })).status, 'VERIFIED')
  git(dir, 'checkout', '--', '.')
  const ready = begin(contract(dir, { limits: { maxAttempts: 1 } }), { cwd: dir })
  write(dir, 'greeting.mjs', 'export default "Wrong"\n')
  assert.equal((await check(ready.runId, { cwd: dir })).status, 'FAILED')
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  const exhausted = await check(ready.runId, { cwd: dir })
  assert.equal(exhausted.errorCode, 'ATTEMPTS_EXHAUSTED')
  assert.equal(exhausted.delivery.status, 'NOT_DELIVERED')
})

test('fast path reports a verification timeout as INCONCLUSIVE JSON, not a crash', async () => {
  const dir = fixture('node -e "setTimeout(() => {}, 60000)"')
  const ready = begin(contract(dir, { limits: { timeoutMs: 1500 } }), { cwd: dir })
  write(dir, 'greeting.mjs', 'export default "Welcome"\n')
  const result = await check(ready.runId, { cwd: dir })
  assert.equal(result.status, 'INCONCLUSIVE')
  assert.equal(result.errorCode, 'TIMEOUT')
  assert.equal(result.delivery.status, 'NOT_DELIVERED')
  assert.equal(history(dir).at(-1).status, 'INCONCLUSIVE')
})

const turn = (input, output, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached })
test('telemetry sums reviewer and retry usage, keeps missing tokens UNKNOWN and copies no task text', () => {
  const secret = 'sk-live-DO-NOT-LEAK'
  const v2 = { date: 'd', runtime: 'codex', task: `use ${secret}`, status: 'VERIFIED', message: secret, contract: { id: 'v2', profile: 'MANAGED', evidenceRefs: ['r.json'] },
    attempts: [{}, {}], usage: [{ phase: 'worker', attempt: 1, turns: [turn(100, 10)], models: ['gpt-x'] }, { phase: 'worker', attempt: 2, turns: [turn(50, 5)] }, { phase: 'verify', attempt: 2, turns: [turn(40, 4)] }],
    telemetry: { durationMs: 9, attempts: 2, total: { calls: 3, inputTokens: 190, outputTokens: 19, cachedInputTokens: 0 }, router: { calls: 0, inputTokens: 'UNKNOWN', outputTokens: 'UNKNOWN', cachedInputTokens: 'UNKNOWN' },
      worker: { calls: 2, inputTokens: 150, outputTokens: 15, cachedInputTokens: 0 }, verifier: { calls: 1, inputTokens: 40, outputTokens: 4, cachedInputTokens: 0 }, retry: { calls: 2, inputTokens: 90, outputTokens: 9, cachedInputTokens: 0 } } }
  const legacyCodex = { runtime: 'codex', status: 'VERIFIED', task: secret, attempts: [{ cell: 'a/low' }, { cell: 'b/low' }],
    usage: [{ phase: 'route', cell: 'r/low', turns: [turn(10, 1)] }, { phase: 'worker', cell: 'a/low', turns: [turn(20, 2)] }, { phase: 'verify', cell: 'v/low', turns: [turn(5, 1)] },
      { phase: 'diagnose', cell: 'r/low', turns: [turn(7, 1)] }, { phase: 'worker', cell: 'b/low', turns: [] }] }
  const claudeZero = { runtime: 'claude', status: 'ERROR', task: secret, attempts: [{ cell: 'haiku/low' }], tokens: 0 }
  const claudeNull = { runtime: 'claude', status: 'FAILED', attempts: [{ cell: 'haiku/low' }], tokens: null }
  const aborted = { runtime: 'claude', status: 'ABORTED', attempts: [], tokens: 0 }
  const records = [v2, legacyCodex, claudeZero, claudeNull, aborted].map(telemetryRecord)
  assert.equal(JSON.stringify(records).includes(secret), false)
  assert.deepEqual(records[0].models, { source: 'observed', ids: ['gpt-x'] })
  assert.equal(records[0].tokens.reviewer.inputTokens, 40)
  assert.equal(records[0].tokens.retry.outputTokens, 9)
  assert.equal(records[0].tokens.router.inputTokens, 0)
  assert.equal(records[1].tokens.router.calls, 2)
  assert.equal(records[1].tokens.retry.calls, 2)
  assert.equal(records[1].tokens.retry.inputTokens, 'UNKNOWN')
  assert.equal(records[1].tokens.total.inputTokens, 'UNKNOWN')
  assert.equal(records[1].tokens.reviewer.inputTokens, 5)
  assert.equal(records[2].tokens.total.outputTokens, 'UNKNOWN')
  assert.equal(records[3].tokens.total.outputTokens, 'UNKNOWN')
  assert.equal(records[4].tokens.total.outputTokens, 0)
  for (const record of records) assert.equal(record.billing, 'UNKNOWN')
  const summary = summarize(records)
  assert.equal(summary.reviewerShare.inputTokens.share, 0.211)
  assert.equal(summary.reviewerShare.inputTokens.runs, 1)
  assert.equal(summary.tokensPerVerified.inputTokens.mean, 190)
  assert.equal(summary.tokensPerVerified.inputTokens.excluded, 1)
  assert.deepEqual(summary.retried.map(({ taskId }) => taskId), ['v2', null])
  assert.equal(summary.byProfile.LEGACY.failed, 2)
  // A repaired fast-path run is one run: its last check line wins.
  const fast = (status, attempts) => telemetryRecord({ runId: 'fast-1', status, path: 'FAST', contract: { id: 'f', profile: 'DIRECT' }, telemetry: { attempts, durationMs: 1, total: { calls: attempts }, router: { calls: 0 }, worker: { calls: attempts }, verifier: { calls: 0 }, retry: { calls: attempts - 1 } } })
  const once = summarize(latestPerRun([fast('FAILED', 1), fast('VERIFIED', 2)]))
  assert.deepEqual(once.byProfile.DIRECT, { runs: 1, verified: 1, failed: 0, failureRate: 0 })
  assert.deepEqual(once.failures, {})
  assert.deepEqual(summarize([{ ...fast('STALE_RUN', 1), runId: 's' }]).failures, {})
})

test('remote CI decides delivery readiness and unreadable CI is UNKNOWN', async () => {
  assert.equal(checksStatus([]), 'UNKNOWN')
  assert.equal(checksStatus([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }]), 'PENDING')
  assert.equal(checksStatus([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]), 'FAIL')
  assert.equal(deliveryGate('VERIFIED', { status: 'FAIL' }).ready, false)
  assert.equal(deliveryGate('VERIFIED', { status: 'UNKNOWN' }).ready, false)
  assert.equal(deliveryGate('FAILED', { status: 'PASS' }).ready, false)
  assert.equal(deliveryGate('VERIFIED', { status: 'PASS', required: { status: 'PENDING' } }).ready, false)
  assert.equal(deliveryGate('VERIFIED', { status: 'PASS', required: { status: 'UNKNOWN' } }).ready, true)
  const offline = await ciEvidence({ owner: 'o', repo: 'r', ref: 'abc', fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(offline.status, 'UNKNOWN')
  const reply = (status, body) => ({ status, ok: status === 200, json: async () => body })
  const unit = { name: 'unit', status: 'completed', conclusion: 'success' }
  const routes = { page1: reply(200, { total_count: 2, check_runs: [unit] }), page2: reply(200, { total_count: 2, check_runs: [{ ...unit, name: 'lint' }] }),
    status: reply(200, { statuses: [] }), protection: reply(401, null) }
  const fetchImpl = async (url) => routes[url.includes('check-runs') ? (url.endsWith('page=1') ? 'page1' : 'page2') : url.endsWith('/status') ? 'status' : 'protection']
  const ci = () => ciEvidence({ owner: 'o', repo: 'r', ref: 'abc', branch: 'main', token: 't', fetchImpl })
  let evidence = await ci()
  assert.equal(evidence.status, 'PASS')
  assert.deepEqual(evidence.checks.map(({ name }) => name), ['unit', 'lint'])
  assert.equal(evidence.required.status, 'UNKNOWN')
  // A token that cannot read protection also gets 404; only GitHub's explicit message means unprotected.
  routes.protection = reply(404, { message: 'Not Found' })
  assert.equal((await ci()).required.status, 'UNKNOWN')
  routes.protection = reply(404, { message: 'Branch not protected' })
  assert.equal((await ci()).required.status, 'NOT_PROTECTED')
  routes.protection = reply(200, { contexts: ['unit', 'ci/jenkins'] })
  evidence = await ci()
  assert.equal(evidence.required.status, 'PENDING')
  assert.equal(deliveryGate('VERIFIED', evidence).ready, false)
  // A required context reported through the commit status API is seen, and a failing one fails CI.
  routes.status = reply(200, { statuses: [{ context: 'ci/jenkins', state: 'success' }] })
  evidence = await ci()
  assert.equal(evidence.required.status, 'PASS')
  assert.equal(deliveryGate('VERIFIED', evidence).ready, true)
  routes.status = reply(200, { statuses: [{ context: 'ci/jenkins', state: 'failure' }] })
  evidence = await ci()
  assert.equal(evidence.status, 'FAIL')
  assert.equal(deliveryGate('VERIFIED', evidence).ready, false)
  routes.status = reply(200, { statuses: [{ context: 'ci/jenkins', state: 'error' }] })
  assert.equal((await ci()).required.status, 'FAIL')
  routes.status = reply(403, { message: 'rate limited' })
  assert.equal((await ci()).status, 'UNKNOWN')
})

test('cloud handoff stops when no official cloud command is available and never runs one', () => {
  const missing = cloudCapability(() => ({ status: 1, stdout: '', stderr: 'unknown command' }))
  assert.deepEqual([missing.codex, missing.claude], ['UNAVAILABLE', 'UNAVAILABLE'])
  const task = parseTaskContract(contract(tmpdir()).contract)
  assert.equal(cloudHandoff(task, { capability: missing }).status, 'UNAVAILABLE')
  const present = cloudCapability(() => ({ status: 0, stdout: 'Usage: --env <ENV_ID> --cloud [description]', stderr: '' }))
  assert.equal(cloudHandoff(task, { capability: present }).errorCode, 'CLOUD_ENV_REQUIRED')
  const ready = cloudHandoff(task, { capability: present, env: 'env_1' })
  assert.equal(ready.status, 'HANDOFF_READY')
  assert.deepEqual(ready.command.slice(0, 5), [process.env.CODEX_BINARY, 'cloud', 'exec', '--env', 'env_1'])
  assert.match(ready.brief, /Do not merge/)
  assert.equal(cloudHandoff({ ...task, backend: 'claude' }, { capability: present }).command[1], '--cloud')
})
