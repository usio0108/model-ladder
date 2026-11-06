import '../helpers/isolate-home.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { addRow, finishRow, removeRow, anyRunning, runCount, isRedo, agentExpected, addBackground, removeBackground, backgroundRows, liveExpected, agentSamples, activityText } from '../../hooks/band/rows.mjs'

const row = (id, run) => ({ id, run, role: 'worker', redo: false, cell: 'x', task: 't', status: 'running', ms: null, startedAt: 0 })

test('rows of two interleaved runs are all kept', () => {
  let l = []
  for (const [id, run] of [['a1', 'A'], ['b1', 'B'], ['a2', 'A'], ['b2', 'B']]) l = addRow(l, row(id, run))
  assert.deepEqual(l.map((r) => r.id), ['a1', 'b1', 'a2', 'b2'])
  assert.equal(runCount(l), 2)
})

test('each row finishes on its own and is removed on its own', () => {
  let l = addRow(addRow([], row('a1', 'A')), row('b1', 'B'))
  l = finishRow(l, 'a1', 500)
  assert.equal(l[0].status, 'done')
  assert.equal(l[0].ms, 500)
  assert.equal(l[1].status, 'running')
  assert.equal(anyRunning(l), true)
  l = finishRow(l, 'b1', 7)
  assert.equal(anyRunning(l), false)
  l = removeRow(l, 'a1')
  assert.deepEqual(l.map((r) => r.id), ['b1'])
})

test('redo only looks at the same run verifier', () => {
  const verified = new Set(['A'])
  assert.equal(isRedo(verified, 'A', true), true)
  assert.equal(isRedo(verified, 'B', true), false)
  assert.equal(isRedo(verified, 'A', false), false)
})

test('only worker, test-writer and verify agents have an expected duration', () => {
  const table = { cells: { 'worker/haiku/low': 720000 }, phases: { worker: 300000, 'test-writer': 240000, verify: 120000, route: 60000, diagnose: 60000, final: 60000 } }
  assert.equal(agentExpected(table, 'worker', 'haiku', 'low'), 720000)
  assert.equal(agentExpected(table, 'worker', 'opus', 'high'), 300000)
  assert.equal(agentExpected(table, 'test-writer', 'haiku', 'low'), 240000)
  assert.equal(agentExpected(table, 'verify', 'sonnet', 'low'), 120000)
  for (const phase of ['route', 'diagnose', 'final', 'final diagnosis', 'bogus']) assert.equal(agentExpected(table, phase, 'haiku', 'low'), null)
  // A phase+model+effort entry of a phase that shows no expectation is ignored too.
  assert.equal(agentExpected({ cells: { 'route/haiku/low': 600000 }, phases: {} }, 'route', 'haiku', 'low'), null)
})

test('liveExpected keeps the expected duration until the agent overruns it, then grows it in steps', () => {
  const m = 60000
  const step = (...args) => liveExpected(...args)?.ms ?? null
  // Below the expectation: unchanged.
  assert.equal(step(0, 7 * m), 7 * m)
  assert.equal(step(7 * m - 1, 7 * m), 7 * m)
  // At the expectation: the first step (max(1m, 3.5m) = 3.5m).
  assert.equal(step(7 * m, 7 * m), 10.5 * m)
  // Over it: 7m expected shows 14m at 12m elapsed, 17.5m at 14m elapsed.
  assert.equal(step(12 * m, 7 * m), 14 * m)
  assert.equal(step(14 * m - 1, 7 * m), 14 * m)
  assert.equal(step(14 * m, 7 * m), 17.5 * m)
  // Several steps over: the smallest step count that lands above elapsed.
  assert.equal(step(30 * m, 7 * m), 31.5 * m)
  for (let elapsed = 7 * m; elapsed < 60 * m; elapsed += 1000) {
    const shown = step(elapsed, 7 * m)
    assert.ok(shown > elapsed)
    assert.ok(shown - elapsed <= 3.5 * m)
  }
  // A small expectation uses the 1-minute minimum step, not half of it.
  assert.equal(step(30000, 60000), 60000)
  assert.equal(step(60000, 60000), 2 * m)
  assert.equal(step(100000, 60000), 2 * m)
  assert.equal(step(2 * m, 60000), 3 * m)
  assert.equal(step(5 * m, 2 * m), 6 * m)
  // No usable expectation: null.
  for (const bad of [null, undefined, NaN, 0, -5, Infinity, 'x']) assert.equal(step(12 * m, bad), null)
})

test('addBackground appends a task and ignores a duplicate id', () => {
  const a = { id: 'b1', kind: 'shell', label: 'npm test', startedAt: 1 }
  const b = { id: 'w1', kind: 'workflow', label: 'ladder', startedAt: 2 }
  assert.deepEqual(addBackground([], a), [a])
  assert.deepEqual(addBackground([a], b), [a, b])
  assert.deepEqual(addBackground([a], { ...a, label: 'other' }), [a])
})

test('removeBackground drops the listed ids only', () => {
  const list = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]
  assert.deepEqual(removeBackground(list, ['b1', 'b3']), [{ id: 'b2' }])
  assert.deepEqual(removeBackground(list, ['nope']), list)
  assert.deepEqual(removeBackground(list, []), list)
})

test('backgroundRows show only while Claude is not working and no agent runs', () => {
  const list = [{ id: 'b1', kind: 'shell', label: 'x', startedAt: 1 }]
  assert.deepEqual(backgroundRows(list, false, false), list)
  assert.deepEqual(backgroundRows(list, true, false), [])
  assert.deepEqual(backgroundRows(list, false, true), [])
  assert.deepEqual(backgroundRows(list, true, true), [])
  assert.deepEqual(backgroundRows([], false, false), [])
})

test('liveExpected: below expected is exact, 2+ longer samples give their median, otherwise the step rule is approximate', () => {
  const m = 60000
  assert.deepEqual(liveExpected(5 * m, 7 * m, [9 * m, 10 * m]), { ms: 7 * m, approx: false })
  // Only samples longer than elapsed count; the median of those (upper median for an even count).
  assert.deepEqual(liveExpected(12 * m, 7 * m, [5 * m, 20 * m, 30 * m, 40 * m]), { ms: 30 * m, approx: false })
  assert.deepEqual(liveExpected(12 * m, 7 * m, [13 * m, 15 * m]), { ms: 15 * m, approx: false })
  // One longer sample is not enough: the step rule, marked approximate.
  assert.deepEqual(liveExpected(12 * m, 7 * m, [5 * m, 20 * m]), { ms: 14 * m, approx: true })
  assert.deepEqual(liveExpected(12 * m, 7 * m, []), { ms: 14 * m, approx: true })
  assert.deepEqual(liveExpected(12 * m, 7 * m), { ms: 14 * m, approx: true })
  assert.deepEqual(liveExpected(12 * m, 7 * m, 'x'), { ms: 14 * m, approx: true })
})

test('agentSamples takes the cell samples, else the phase samples, like agentExpected', () => {
  const table = { cells: {}, phases: {}, samples: { 'worker/haiku/low': [1, 2, 3], worker: [4, 5], verify: [6] } }
  assert.deepEqual(agentSamples(table, 'worker', 'haiku', 'low'), [1, 2, 3])
  assert.deepEqual(agentSamples(table, 'worker', 'opus', 'high'), [4, 5])
  assert.deepEqual(agentSamples(table, 'verify', 'sonnet', 'low'), [6])
  assert.deepEqual(agentSamples(table, 'route', 'haiku', 'low'), [])
  for (const bad of [undefined, null, {}, { samples: { worker: 'x' } }]) assert.deepEqual(agentSamples(bad, 'worker', 'haiku', 'low'), [])
})

test('activityText names the newest assistant message\'s last tool use, or null when unreadable', () => {
  const a = (...toolUses) => ({ role: 'assistant', text: '', toolUses })
  assert.equal(activityText([a({ tool: 'Bash', input: { description: 'Run tests', command: 'npm test' } })]), 'Bash: Run tests')
  assert.equal(activityText([a({ tool: 'Bash', input: { command: 'npm test\nnpm run x' } })]), 'Bash: npm test')
  assert.equal(activityText([a({ tool: 'Read', input: { file_path: 'C:\\repo\\src\\a.mjs' } })]), 'Read: a.mjs')
  assert.equal(activityText([a({ tool: 'Edit', input: { file_path: '/repo/b.ts' } })]), 'Edit: b.ts')
  assert.equal(activityText([a({ tool: 'Grep', input: { pattern: 'foo.*' } })]), 'Grep: foo.*')
  assert.equal(activityText([a({ tool: 'WebFetch', input: { url: 'x' } })]), 'WebFetch')
  // Last tool use of the newest assistant message that has one; a later user message does not matter.
  assert.equal(activityText([a({ tool: 'Glob', input: { pattern: '*.md' } }), a({ tool: 'Read', input: { file_path: 'x/1' } }, { tool: 'Write', input: { file_path: 'y/2' } }), { role: 'user', text: '', toolUses: [] }]), 'Write: 2')
  for (const bad of [undefined, null, 'x', [], [{ role: 'user', text: '', toolUses: [] }], [a()]]) assert.equal(activityText(bad), null)
})

test('background command durations keep the newest ten per command and give a median', async () => {
  const { recordDuration, medianDuration } = await import('../../hooks/band/rows.mjs')
  let history = {}
  for (let i = 1; i <= 12; i++) history = recordDuration(history, 'node --test a', i * 1000)
  assert.deepEqual(history['node --test a'], [3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000])
  assert.equal(recordDuration(history, '', 5000), history)
  assert.equal(recordDuration(history, 'k', 0), history)
  assert.equal(medianDuration([300000, 100000, 200000]), 200000)
  assert.equal(medianDuration([]), null)
  assert.equal(medianDuration(undefined), null)
})
