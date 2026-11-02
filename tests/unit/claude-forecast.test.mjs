import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { artifactDir } from '../../scripts/common.mjs'
import { agentExpectations } from '../../scripts/forecast.mjs'
import { agentExpected } from '../../hooks/band/rows.mjs'

const script = (name) => fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url))
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const workflow = new AsyncFunction('args', 'agent', 'budget', 'phase', 'log', readFileSync(new URL('../../workflows/ladder.js', import.meta.url), 'utf8').replace(/^export /m, ''))
const artifacts = artifactDir(process.cwd())
mkdirSync(artifacts, { recursive: true })

test('Claude preflight, real boundary CLI, workflow journal and finish persist calibration without extra agent calls', async (t) => {
  const dir = mkdtempSync(join(artifacts, 'claude-forecast-'))
  t.after(() => { rmSync(artifactDir(dir), { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'fixture')
  const run = (name, input, ...flags) => execFileSync(process.execPath, [script(name), ...flags], {
    cwd: dir, input: input ? JSON.stringify(input) : undefined, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MODEL_LADDER_NO_UPDATE_CHECK: '1' },
  })
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const route = { model: 'haiku', effort: 'low', reason: 'report', goal: 'Inspect fixture', scope: [],
    verify: null, acceptance: ['Report repository state'], allowTests: false, allowTestsReason: 'report', question: null,
    small: false, smallReason: '', readOnly: true, estimatedMinutes: 30, optimisticMinutes: 10, pessimisticMinutes: 60 }
  const calls = []
  const agent = async (_prompt, opts) => {
    calls.push(opts.label.split(' ')[0])
    if (opts.label.startsWith('route')) return route
    if (opts.label.startsWith('worker')) return { status: 'done', worktreePath: dir, filesChanged: [], summary: 'Empty repository', selfCheck: 'inspected', blockedReason: null }
    return { pass: true, reason: 'Inspected repository', output: '', usage: '{}' }
  }
  let journeys = 0
  async function journey() {
    const journeyNo = ++journeys
    const preflight = JSON.parse(run('preflight'))
    assert.equal(preflight.status, 'READY')
    let args = { ...preflight.workflowArgs, task: 'Inspect fixture', acceptance: ['Report repository state'] }
    const statePath = join(artifactDir(dir), preflight.runId, 'state.json')
    assert.equal(read(statePath).forecast.original, null)
    let result, firstForecast
    for (let i = 0; i < 3; i++) {
      run('forecast', { runId: preflight.runId, event: 'start' })
      // The router spawns inside this first call, so its expectations are in the lock before any forecast total exists.
      const lock = read(join(dir, '.model-ladder/runs', `${preflight.runId}.json`))
      if (i === 0) {
        assert.equal(lock.expectedMs, undefined)
        // First run: no history, so no agent has samples. Second run: one earlier success, so phases (not yet cells) have them.
        assert.deepEqual(Object.keys(lock.phaseExpected.cells), [])
        assert.deepEqual(Object.keys(lock.phaseExpected.phases).sort(), journeyNo === 1 ? [] : ['route', 'verify', 'worker'])
        assert.equal(agentExpected(lock.phaseExpected, 'worker', 'haiku', 'low'), journeyNo === 1 ? null : lock.phaseExpected.phases.worker)
      }
      let spent = 0
      result = await workflow(args, async (...a) => { spent += 10; return agent(...a) }, { spent: () => spent }, () => {}, () => {})
      if (i === 1) {
        const changed = structuredClone(result)
        changed.journal[0].effort = 'high'
        assert.throws(() => run('forecast', { runId: preflight.runId, event: 'end', result: changed }), /journal prefix changed/)
      }
      const end = JSON.parse(run('forecast', { runId: preflight.runId, event: 'end', result }))
      if (i === 0) {
        assert.equal(result.status, 'ROUTED')
        firstForecast = end.forecast.original
        // The band reads the run's forecast total from its own lock.
        assert.ok(firstForecast.mostLikely > 0)
        assert.equal(read(join(dir, '.model-ladder/runs', `${preflight.runId}.json`)).expectedMs, firstForecast.mostLikely)
        assert.equal(read(statePath).forecast.runId, preflight.runId)
        assert.equal(JSON.parse(run('claim', { runId: preflight.runId, scope: result.plan.scope, readOnly: true })).status, 'READY')
        args.plan = result.plan
      }
      args.journal = result.journal
    }
    assert.equal(result.status, 'VERIFIED')
    const state = read(statePath)
    assert.deepEqual(state.forecast.original, firstForecast)
    assert.deepEqual(state.forecast.phases.map((p) => p.phase), ['route', 'worker', 'verify'])
    assert.ok(state.forecast.phases.every((p) => p.durationMs > 0 && p.provenance === 'host-workflow-boundary' && p.tokens === 10))
    assert.equal(state.forecast.current.usage.five_hour.status, 'unknown')
    run('finish', { task: 'Inspect fixture', runId: preflight.runId, result })
    const rows = readFileSync(join(dir, '.model-ladder/history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.at(-1).forecast.actual.censored, false)
    assert.deepEqual(rows.at(-1).forecast.original, firstForecast)
    assert.equal(rows.at(-1).forecast.current.remaining.mostLikely, 0)
    return rows.at(-1).forecast
  }
  const first = await journey()
  assert.equal(first.original.sampleCount, 0)
  assert.equal((await journey()).original.sampleCount, 1)
  assert.deepEqual(calls, ['route', 'worker', 'verify', 'route', 'worker', 'verify'])
  const preflight = JSON.parse(run('preflight'))
  run('forecast', { runId: preflight.runId, event: 'start' })
  assert.throws(() => run('forecast', { runId: preflight.runId, event: 'start' }), /Previous workflow boundary/)
  run('finish', { task: 'Inspect fixture', runId: preflight.runId, error: 'host interrupted' })
  const last = JSON.parse(readFileSync(join(dir, '.model-ladder/history.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.equal(last.forecast.actual.censored, true)
  assert.equal(last.forecast.error, null)
  assert.equal(last.forecast.openBoundary.censored, true)
})

test('agentExpectations: median per phase+model+effort once there are two samples, phase alone before that, successful comparable runs only', () => {
  const NOW = 1_800_000_000_000
  const phase = (name, model, effort, durationMs, extra = {}) => ({ phase: name, model, effort, durationMs, complete: true, pass: true, ...extra })
  const run = (phases, extra = {}) => ({ forecast: { version: 1, runtime: 'claude', phases, actual: { status: 'VERIFIED', completed: true, censored: false, endedAt: NOW - 1000 }, ...extra } })
  const rows = [
    run([phase('worker', 'haiku', 'low', 100_000), phase('verify', 'sonnet', 'low', 40_000)]),
    run([phase('worker', 'haiku', 'low', 300_000), phase('worker', 'opus', 'high', 900_000), phase('verify', 'sonnet', 'low', 60_000)]),
    run([phase('worker', 'haiku', 'low', 200_000)]),
    // Not comparable: another runtime, failed, censored, stale, future, incomplete or invalid phases, other version.
    run([phase('worker', 'haiku', 'low', 9_000_000)], { runtime: 'codex' }),
    run([phase('worker', 'haiku', 'low', 9_000_000)], { actual: { status: 'FAILED', completed: true, censored: false, endedAt: NOW - 1000 } }),
    run([phase('worker', 'haiku', 'low', 9_000_000)], { actual: { status: 'VERIFIED', completed: false, censored: true, endedAt: NOW - 1000 } }),
    run([phase('worker', 'haiku', 'low', 9_000_000)], { actual: { status: 'VERIFIED', completed: true, censored: false, endedAt: NOW - 91 * 86400000 } }),
    run([phase('worker', 'haiku', 'low', 9_000_000)], { actual: { status: 'VERIFIED', completed: true, censored: false, endedAt: NOW + 5000 } }),
    run([phase('worker', 'haiku', 'low', 9_000_000, { complete: false }), phase('worker', 'haiku', 'low', NaN), phase('worker', 'haiku', 'low', 0)]),
    run([phase('worker', 'haiku', 'low', 9_000_000)], { version: 2 }),
    { forecast: null }, {},
  ]
  const table = agentExpectations(rows, 'claude', NOW)
  assert.deepEqual(table.cells, { 'worker/haiku/low': 200_000, 'verify/sonnet/low': 60_000 })
  assert.equal(table.phases.worker, 300_000)
  assert.equal(table.phases.verify, 60_000)
  // The cell with two or more samples wins; a cell with one sample falls back to the phase median.
  assert.equal(agentExpected(table, 'worker', 'haiku', 'low'), 200_000)
  assert.equal(agentExpected(table, 'worker', 'opus', 'high'), 300_000)
  assert.equal(agentExpected(table, 'route', 'haiku', 'low'), null)
  assert.deepEqual(agentExpectations([], 'claude', NOW), { cells: {}, phases: {} })
  assert.equal(agentExpected(undefined, 'worker', 'haiku', 'low'), null)
})
