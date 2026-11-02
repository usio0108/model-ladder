import { freshUserConfig } from '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { displayWidth, truncate, renderLive, visibleAgents } from '../../scripts/codex-live.mjs'
import { configureGuard, parseArgs, panelCommand } from '../../scripts/watch.mjs'

test('truncation counts Chinese as two cells and preserves graphemes and single-line output', () => {
  assert.equal(displayWidth('整理 README'), 11)
  assert.equal(truncate('整理 README 文件', 10), '整理 READ…')
  assert.equal(truncate('中文', 2), '…')
  assert.equal(truncate('中文', 4), '中文')
  assert.equal(truncate('e\u0301中文', 4), 'e\u0301中…')
  assert.equal(truncate('🙂中文', 4), '🙂…')
  assert.equal(truncate('中文', 0), '')
  assert.equal(truncate('a\nb\t\x1b[31mc', 20), 'a b c')
})
test('completed rows freeze elapsed time and disappear at ten seconds; active rows remain', () => {
  const start = Date.parse('2026-10-23T00:00:00Z')
  const done = { phase: 'worker', model: 'luna', effort: 'low', task: '整理中文 README'.repeat(8), startedAt: new Date(start).toISOString(), endedAt: new Date(start + 5000).toISOString(), pass: true }
  const state = { agents: [done], usage: { fiveHour: 15, sevenDay: 44 } }
  const frame = renderLive(state, { now: start + 14999, width: 50 })
  assert.match(frame, /✓ 5s/)
  assert.match(frame, /5h 15% · 7d 44% · idle/)
  assert.ok(frame.split('\n').every((line) => displayWidth(line) <= 50))
  assert.match(frame, /…/)
  assert.equal(visibleAgents([done], start + 15000).length, 0)
  assert.doesNotMatch(renderLive(state, { now: start + 15000 }), /luna/)
  assert.equal(renderLive(state, { now: start + 15000 }).split('\n')[1], frame.split('\n')[1])
  const running = { ...done, endedAt: null, pass: null }
  assert.equal(visibleAgents([running], start + 50000).length, 1)
  assert.match(renderLive({ agents: [running] }, { now: start + 12000, guard: { enabled: false } }), /12s/)
  assert.doesNotMatch(renderLive({ agents: [running] }, { now: start + 12000, guard: { enabled: false } }), /idle|threshold/)
})
const NL = String.fromCharCode(10)
test('a running agent past its expected duration shows a recalibrated expectation in steps; a finished row keeps the original', () => {
  const start = Date.parse('2026-10-23T00:00:00Z')
  const agent = { phase: 'worker', model: 'luna', effort: 'low', task: 'Fix greeting', startedAt: new Date(start).toISOString(), endedAt: null, pass: null, expectedMs: null }
  const expected = { cells: { 'worker/luna/low': 420000 }, phases: {} }
  const timeCell = (frame) => frame.split(NL)[2].slice(14).split('  ')[0].trim()
  assert.equal(timeCell(renderLive({ agents: [agent], expected }, { now: start + 300000 })), '300s/7m')
  assert.equal(timeCell(renderLive({ agents: [agent], expected }, { now: start + 720000 })), '720s/14m')
  assert.equal(timeCell(renderLive({ agents: [agent], expected }, { now: start + 839000 })), '839s/14m')
  assert.equal(timeCell(renderLive({ agents: [agent], expected }, { now: start + 840000 })), '840s/18m')
  // Without an expectation an overrun changes nothing.
  assert.equal(timeCell(renderLive({ agents: [agent] }, { now: start + 720000 })), '720s')
  // A finished row keeps the expected duration it finished with, so the overrun stays visible.
  const done = { ...agent, endedAt: new Date(start + 720000).toISOString(), pass: true, expectedMs: 420000 }
  assert.equal(timeCell(renderLive({ agents: [done], expected }, { now: start + 725000 })), '✓ 720s/7m')
})
test('time column shows each agent\'s elapsed over its own expected duration, read live, freezing with the row; elapsed alone without samples', () => {
  const start = Date.parse('2026-10-23T00:00:00Z')
  const agent = { phase: 'worker', model: 'luna', effort: 'low', task: 'Fix greeting', startedAt: new Date(start).toISOString(), endedAt: null, pass: null, expectedMs: null }
  const expected = { cells: { 'worker/luna/low': 720000 }, phases: { worker: 300000, verify: 120000 } }
  const timeCell = (frame, row = 0) => frame.split(NL)[2 + row].slice(14).split('  ')[0].trim()
  assert.equal(timeCell(renderLive({ agents: [agent], expected }, { now: start + 5000 })), '5s/12m')
  // First-run router estimates fill worker/verifier rows, while router, diagnose and final rows stay elapsed-only.
  const firstRun = { cells: {}, phases: { worker: 120000, verify: 60000 } }
  assert.equal(timeCell(renderLive({ agents: [agent], expected: firstRun }, { now: start + 5000 })), '5s/2m')
  assert.equal(timeCell(renderLive({ agents: [{ ...agent, phase: 'verify' }], expected: firstRun }, { now: start + 5000 })), '5s/1m')
  for (const phase of ['route', 'diagnose', 'final']) {
    assert.equal(timeCell(renderLive({ agents: [{ ...agent, phase }], expected: { ...firstRun, phases: { ...firstRun.phases, [phase]: 600000 } } }, { now: start + 5000 })), '5s')
  }
  // The model+effort entry wins; without one the phase alone is the fallback; each row has its own expectation.
  const other = { ...agent, model: 'sol', effort: 'high', phase: 'verify' }
  const two = renderLive({ agents: [agent, { ...agent, model: 'sol', effort: 'high' }, other], expected }, { now: start + 5000 })
  assert.deepEqual([0, 1, 2].map((i) => timeCell(two, i)), ['5s/12m', '5s/5m', '5s/2m'])
  // Read live: the same row shows a new expectation as soon as the table changes, and the run's forecast total is not used.
  assert.equal(timeCell(renderLive({ agents: [agent], expected: { cells: { 'worker/luna/low': 1800000 }, phases: {} }, forecast: { original: { mostLikely: 9999999 } } }, { now: start + 5000 })), '5s/30m')
  // A finished row keeps the value it ended with, whatever the table says later.
  const done = { ...agent, endedAt: new Date(start + 5000).toISOString(), pass: true, expectedMs: 720000 }
  assert.equal(timeCell(renderLive({ agents: [done], expected: { cells: {}, phases: { worker: 60000 } } }, { now: start + 14000 })), '✓ 5s/12m')
  assert.equal(timeCell(renderLive({ agents: [{ ...done, pass: false }] }, { now: start + 14000 })), '✗ 5s/12m')
  // Router, diagnose and final rows show elapsed only, even with a table entry for their phase; test-writer shows one.
  const table = { cells: { 'route/luna/low': 600000 }, phases: { route: 600000, diagnose: 600000, final: 600000, 'test-writer': 180000 } }
  for (const phase of ['route', 'diagnose', 'final']) assert.equal(timeCell(renderLive({ agents: [{ ...agent, phase }], expected: table }, { now: start + 5000 })), '5s')
  assert.equal(timeCell(renderLive({ agents: [{ ...agent, phase: 'test-writer' }], expected: table }, { now: start + 5000 })), '5s/3m')
  // No samples (no table, empty table, unknown phase, unusable values): elapsed only.
  for (const table of [undefined, null, {}, { cells: {}, phases: {} }, { cells: { 'worker/luna/low': 0 }, phases: { worker: NaN } }, { cells: {}, phases: { verify: 120000 } }]) {
    assert.equal(timeCell(renderLive({ agents: [agent], expected: table }, { now: start + 5000 })), '5s')
  }
  for (const expectedMs of [undefined, null, 0, NaN]) assert.equal(timeCell(renderLive({ agents: [{ ...done, expectedMs }] }, { now: start + 14000 })), '✓ 5s')
  // The time column is wider than 9 and every line still fits the panel.
  const long = renderLive({ agents: [agent], expected: { cells: {}, phases: { worker: 90 * 3600000 } } }, { now: start + 100000000, width: 60 })
  assert.equal(timeCell(long), '100000s/4d')
  const header = long.split(NL)[1]
  assert.ok(header.indexOf('task') - header.indexOf('time') > 9 + 2)
  assert.ok(long.split(NL).every((line) => displayWidth(line) <= 60))
})
test('watch flags write the user file, preserve its other settings and leave the project file alone; every invalid threshold exits without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ml-watch-'))
  const path = freshUserConfig()
  try {
    mkdirSync(join(root, '.codex'))
    mkdirSync(join(path, '..'), { recursive: true })
    const projectPath = join(root, '.codex/model-ladder.json')
    const project = { router: { model: 'custom', effort: 'low' }, extra: [1, 2] }
    writeFileSync(projectPath, JSON.stringify(project))
    const user = { tiers: 'mine', usageGuard: { enabled: true, threshold: 90, extra: 'keep' } }
    writeFileSync(path, JSON.stringify(user))
    assert.deepEqual(configureGuard(root, parseArgs(['--guard', 'off', '--threshold', '75'])), { enabled: false, threshold: 75, extra: 'keep' })
    assert.deepEqual(JSON.parse(readFileSync(path)), { ...user, usageGuard: { enabled: false, threshold: 75, extra: 'keep' } })
    assert.deepEqual(JSON.parse(readFileSync(projectPath)), project)
    for (const value of ['0', '101', '-1', 'NaN', 'Infinity', 'no', '90oops', '1e2', '']) {
      const before = readFileSync(path, 'utf8')
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/watch.mjs', import.meta.url)), '--cwd', root, '--guard', 'on', '--threshold', value], { encoding: 'utf8' })
      assert.equal(result.status, 1, value)
      assert.match(result.stderr, /threshold/)
      assert.equal(readFileSync(path, 'utf8'), before)
    }
    for (const value of ['1', '100', '90.5']) assert.equal(parseArgs(['--threshold', value]).threshold, Number(value))
    assert.throws(() => parseArgs(['--guard', 'yes']), /on or off/)
    assert.throws(() => parseArgs(['--threshold']), /requires/)
    assert.throws(() => configureGuard(root, { threshold: NaN }), /between/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('panel shows phase lights, reset countdown and skill instructions', () => {
  const now = Date.now()
  const agent = { phase: 'worker', model: 'luna', effort: 'low', task: 'fix', startedAt: new Date(now).toISOString(), endedAt: null }
  const state = { agents: [agent], usage: { fiveHour: 15, fiveHourResetsAt: now / 1000 + 16440 }, skills: { worker: 'ponytail' } }
  assert.match(renderLive(state, { now }), /🟢 model-ladder.*5h\/5h 15%/)
  assert.match(renderLive(state, { now }), /worker ponytail/)
  assert.doesNotMatch(renderLive(state, { now }), /skill instructions:/)
  assert.match(renderLive({ ...state, agents: [{ ...agent, retry: true }] }), /🔴/)
  assert.match(renderLive({ ...state, agents: [{ ...agent, phase: 'verify-command' }] }), /🔵/)
})

test('panel controls persist settings and hand off active and completed runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'ml-panel-'))
  freshUserConfig()
  try {
    mkdirSync(join(root, '.model-ladder'))
    const state = { runId: 'codex-demo', task: '整理 README', input: { task: '整理 README', allowDirty: true }, agents: [{ phase: 'worker', model: 'luna', effort: 'low', endedAt: null }] }
    writeFileSync(join(root, '.model-ladder/live.json'), JSON.stringify(state))
    assert.match(panelCommand(root, 'g'), /off/)
    assert.equal(configureGuard(root, {}).enabled, false)
    assert.match(panelCommand(root, 't 75'), /75%/)
    assert.equal(configureGuard(root, {}).threshold, 75)
    assert.throws(() => panelCommand(root, 't 101'), /threshold/)
    panelCommand(root, 'h')
    const handoff = () => readFileSync(join(root, '.model-ladder/HANDOFF.md'), 'utf8')
    assert.match(handoff(), /still active/)
    assert.match(handoff(), /整理 README/)
    state.agents = []
    state.result = { status: 'STOPPED', errorCode: 'USAGE_LIMIT', runId: state.runId, checkpointPath: '/checkpoint', worktreePath: '/worktree', attempts: [] }
    writeFileSync(join(root, '.model-ladder/live.json'), JSON.stringify(state))
    panelCommand(root, 'h')
    assert.match(handoff(), /quota reset/)
    assert.match(handoff(), /"resumeRun": "codex-demo"/)
    assert.match(handoff(), /"allowDirty": true/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
