import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../../workflows/ladder.js', import.meta.url), 'utf8')
const pure = src.split('// <pure>')[1].split('// </pure>')[0]
const { legalMoves, defaultMove, pickMove, isCell, protectedPatterns, dropUnachievableAcceptance } = new Function(
  `${pure}; return { legalMoves, defaultMove, pickMove, isCell, protectedPatterns, dropUnachievableAcceptance }`,
)()

const tiers = [
  { model: 'haiku', efforts: ['low', 'medium', 'high'], maxEffortJump: 2 },
  { model: 'sonnet', efforts: ['low', 'medium', 'high'], maxEffortJump: 2 },
  { model: 'opus', efforts: ['low', 'medium', 'high', 'xhigh'], maxEffortJump: 1 },
]
const cell = (model, effort) => ({ model, effort })
const names = (moves) => moves.map((m) => `${m.model}/${m.effort}`)

test('same tier jumps up to maxEffortJump, plus every effort of the next tier', () => {
  assert.deepEqual(names(legalMoves(cell('haiku', 'low'), tiers)), [
    'haiku/medium', 'haiku/high', 'sonnet/low', 'sonnet/medium', 'sonnet/high',
  ])
})

test('opus moves one effort at a time', () => {
  assert.deepEqual(names(legalMoves(cell('opus', 'low'), tiers)), ['opus/medium'])
})

test('top of a tier can only change tier', () => {
  assert.deepEqual(names(legalMoves(cell('sonnet', 'high'), tiers)), [
    'opus/low', 'opus/medium', 'opus/high', 'opus/xhigh',
  ])
})

test('top cell has no moves', () => {
  assert.deepEqual(legalMoves(cell('opus', 'xhigh'), tiers), [])
  assert.equal(defaultMove(cell('opus', 'xhigh'), tiers), null)
})

test('never skips a tier', () => {
  assert.ok(!names(legalMoves(cell('haiku', 'high'), tiers)).some((n) => n.startsWith('opus')))
})

test('default move is the next effort, else the lowest effort of the next tier', () => {
  assert.deepEqual(defaultMove(cell('haiku', 'low'), tiers), cell('haiku', 'medium'))
  assert.deepEqual(defaultMove(cell('haiku', 'high'), tiers), cell('sonnet', 'low'))
})

test('a legal choice is taken; an illegal or malformed one falls back to the default', () => {
  const from = cell('sonnet', 'high')
  assert.deepEqual(pickMove(cell('opus', 'xhigh'), from, tiers), cell('opus', 'xhigh'))
  assert.deepEqual(pickMove(cell('haiku', 'low'), from, tiers), cell('opus', 'low'))
  assert.deepEqual(pickMove(undefined, from, tiers), cell('opus', 'low'))
})

test('isCell accepts grid cells only', () => {
  assert.ok(isCell(cell('opus', 'xhigh'), tiers))
  assert.ok(!isCell(cell('haiku', 'xhigh'), tiers))
  assert.ok(!isCell(null, tiers))
})

test('allowTests drops the test patterns but keeps the always-protected ones', () => {
  const protection = { always: ['.claude/model-ladder.json', 'migrations/**'], tests: ['**/tests/**'] }
  assert.deepEqual(protectedPatterns(protection, false), ['**/tests/**', '.claude/model-ladder.json', 'migrations/**'])
  assert.deepEqual(protectedPatterns(protection, true), ['.claude/model-ladder.json', 'migrations/**'])
})

test('dropUnachievableAcceptance removes router items that need a commit, push, tag, release or clean tree', () => {
  const drop = [
    'Changes are committed',
    'Working tree is clean after commit',
    'The work is committed on the current branch',
    'A commit is created with a descriptive message',
    'Create a commit for the change',
    'Changes are pushed to origin',
    'Tag v1.2.7 is created',
    'The release is published',
    'Git status is clean',
    'git status --porcelain is empty',
    'The working tree is clean',
    'Clean working tree at the end',
    'No uncommitted changes remain',
  ]
  assert.deepEqual(dropUnachievableAcceptance(drop), [])
})

test('dropUnachievableAcceptance keeps items a worker can meet, including ones that forbid commits', () => {
  const keep = [
    'Only markdown files are modified',
    'No commit is made',
    'Does not commit or push anything',
    'Nothing is committed or tagged',
    'Release notes are updated in CHANGELOG.md',
    'The commit message style in docs is unchanged',
    'The verify command passes',
  ]
  assert.deepEqual(dropUnachievableAcceptance(keep), keep)
})

test('dropUnachievableAcceptance filters a mixed list in order and tolerates a missing list', () => {
  assert.deepEqual(
    dropUnachievableAcceptance(['Only markdown files are modified', 'Changes are committed', 'No commit is made']),
    ['Only markdown files are modified', 'No commit is made'],
  )
  assert.deepEqual(dropUnachievableAcceptance(undefined), [])
})

test('ladder.js applies the filter to router acceptance only, and the router prompt forbids finish-stage items', () => {
  assert.match(src, /args\.acceptance : dropUnachievableAcceptance\(r\.acceptance\)/)
  assert.match(src, /Never list commit, push, release, tag or clean-working-tree conditions/)
})
