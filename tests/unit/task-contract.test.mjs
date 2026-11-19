import '../helpers/isolate-home.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inScope, parseTaskContract, taskPolicy, usageEvidence } from '../../scripts/task-contract.mjs'

const root = process.cwd()
const task = (overrides = {}) => parseTaskContract({ version: 1, id: 'test-task', task: 'Fix a typo', repository: root,
  scope: ['README.md'], coverage: 'complete', complexity: 'small', ...overrides })

test('contract rejects unsupported versions, command injection fields, unsafe paths and invalid limits', () => {
  for (const overrides of [{ version: 2 }, { id: '../draft' }, { repository: '.' }, { scope: ['../outside'] }, { scope: ['.git/config'] },
    { scope: ['x/*.mjs'] }, { protectedPaths: ['C:/out'] }, { scope: ['readme.md:stream'] }, { scope: ['NUL.md'] },
    { verify: 'arbitrary model command' }, { limits: { maxAttempts: 0 } }, { limits: { timeoutMs: Infinity } }, { limits: { unknown: 1 } }]) {
    assert.throws(() => task(overrides), undefined, JSON.stringify(overrides))
  }
})

test('risk is independent of complexity and cannot be lowered by a requested profile', () => {
  const plain = taskPolicy(task(), root, [])
  const complex = taskPolicy(task({ complexity: 'complex' }), root, [])
  assert.equal(plain.risk, complex.risk)
  assert.equal(plain.profile, 'DIRECT')
  assert.equal(complex.profile, 'MANAGED')
  assert.equal(complex.review, true)
  const destructive = taskPolicy(task({ task: 'Delete one line of credentials', profile: 'DIRECT' }), root, [])
  assert.equal(destructive.risk, 'HIGH')
  assert.equal(destructive.profile, 'ISOLATED')
  assert.equal(taskPolicy(task({ protectedPaths: ['README.md'] }), root, []).risk, 'HIGH')
  assert.equal(taskPolicy(task({ scope: [] }), root, []).risk, 'UNKNOWN')
  const mandated = taskPolicy(task(), root, [], { requireSandbox: true })
  assert.equal(mandated.risk, 'LOW')
  assert.equal(mandated.profile, 'ISOLATED')
  assert.equal(inScope('src/app.mjs', ['src']), true)
  assert.equal(inScope('src-other/app.mjs', ['src']), false)
})

test('one backend with incomplete usage does not turn unknown token fields into zero', () => {
  const evidence = usageEvidence([{ phase: 'worker', attempt: 1, turns: [{ input_tokens: 0, output_tokens: 2, cached_input_tokens: 0 }] },
    { phase: 'verify', attempt: 1, turns: [] }], 1, 5)
  assert.equal(evidence.worker.inputTokens, 0)
  assert.equal(evidence.total.inputTokens, 'UNKNOWN')
  assert.equal(evidence.total.cachedInputTokens, 'UNKNOWN')
  assert.equal(evidence.verifier.calls, 1)
  assert.equal(evidence.router.calls, 0)
})
