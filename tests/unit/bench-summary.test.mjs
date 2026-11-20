import '../helpers/isolate-home.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UNKNOWN, fmtCost, fmtTokens, summarize } from '../e2e/bench-summary.mjs'

test('missing cost and tokens format as UNKNOWN, not 0 or NaN', () => {
  for (const v of [null, undefined]) {
    assert.equal(fmtCost(v), UNKNOWN)
    assert.equal(fmtTokens(v), UNKNOWN)
  }
  assert.equal(fmtCost(0), '0.00')
  assert.equal(fmtTokens(0), '0')
})

test('summary sums only measured values and counts exclusions', () => {
  const s = summarize([
    { solved: true, cost: 1, outputTokens: 100, seconds: 5 },
    { solved: true, cost: null, outputTokens: undefined, seconds: 5 },
    { solved: false, cost: 3, outputTokens: 50, seconds: 5 },
  ])
  assert.equal(s.cost, 4)
  assert.equal(s.tokens, 150)
  assert.equal(s.costExcluded, 1)
  assert.equal(s.tokensExcluded, 1)
  assert.equal(s.perSolved, 4) // 4 known cost / 1 solved row with known cost
})

test('all values missing gives UNKNOWN, not 0', () => {
  const s = summarize([{ solved: true, cost: null, seconds: 1 }])
  assert.equal(s.cost, UNKNOWN)
  assert.equal(s.tokens, UNKNOWN)
  assert.equal(s.perSolved, UNKNOWN)
  assert.equal(s.costExcluded, 1)
  assert.equal(s.tokensExcluded, 1)
})
