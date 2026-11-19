import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { artifactDir } from '../../scripts/common.mjs'

const fixtures = [
  {
    id: 'small-bug', category: 'Small bug fix', direct: true,
    task: 'In src/greeting.mjs, fix the exported greeting from Wellcome to Welcome. Preserve the named export.',
    acceptance: ['The named greeting export is the string Welcome.'],
    files: { 'src/greeting.mjs': ['export const greeting = "Wellcome"', 'export const greeting = "Welcome"'] },
    check: `const { greeting } = await load('greeting'); assert.equal(greeting, 'Welcome')`,
  },
  {
    id: 'simple-feature', category: 'Simple feature', direct: true,
    task: 'In src/slug.mjs, implement slug(value) for ASCII strings. Trim leading and trailing whitespace, lowercase letters, and convert each interior whitespace run to one hyphen. Preserve punctuation and return an empty string for blank input.',
    acceptance: ['ASCII slugs trim whitespace, lowercase letters, hyphenate whitespace runs, and preserve punctuation.', 'Blank and empty input return an empty string.'],
    files: { 'src/slug.mjs': ['export const slug = value => value', String.raw`export const slug = value => value.trim().toLowerCase().replace(/\s+/g, '-')`] },
    check: String.raw`const { slug } = await load('slug')
assert.equal(slug('  Hello\t WORLD!  '), 'hello-world!')
assert.equal(slug('A\nB--C'), 'a-b--c')
assert.equal(slug('   '), '')
assert.equal(slug(''), '')`,
  },
  {
    id: 'medium-refactor', category: 'Medium refactor', direct: false,
    task: 'Refactor src/inventory.mjs to remove the duplicated index-building loops in quantities and labels. Both named exports must call one new private helper named indexItems. Preserve last-row-wins behavior for duplicate SKUs, ordinary object output, and support for an empty collection. Neither function may mutate its input.',
    acceptance: ['Both exports call one private indexItems helper.', 'Duplicate SKUs use the last row. Empty input returns an ordinary empty object. Frozen input works.'],
    files: { 'src/inventory.mjs': [
      `export function quantities(rows) { const result = {}; for (const row of rows) result[row.sku] = row.qty; return result }
export function labels(rows) { const result = {}; for (const row of rows) result[row.sku] = row.label; return result }`,
      `function indexItems(rows, key) { const result = {}; for (const row of rows) result[row.sku] = row[key]; return result }
export const quantities = rows => indexItems(rows, 'qty')
export const labels = rows => indexItems(rows, 'label')`,
    ] },
    check: String.raw`const inventory = await load('inventory')
const rows = Object.freeze([{ sku: 'A', qty: 4, label: 'first' }, { sku: 'B', qty: 0, label: '' }, { sku: 'A', qty: 2, label: 'last' }].map(Object.freeze))
assert.deepEqual(inventory.quantities(rows), { A: 2, B: 0 })
assert.deepEqual(inventory.labels(rows), { A: 'last', B: '' })
for (const fn of [inventory.quantities, inventory.labels]) {
  assert.deepEqual(fn([]), {})
  assert.match(Function.prototype.toString.call(fn), /\bindexItems\s*\(/)
}
assert.deepEqual(Object.keys(inventory).sort(), ['labels', 'quantities'])`,
  },
  {
    id: 'multi-module', category: 'Multi-module modification', direct: false,
    task: 'Update src/label.mjs and src/totals.mjs. formatLabel must render Total: <value>. summarize must sum all input numbers and call the imported formatLabel with that total. Return total and label. Treat empty input as zero, preserve both exports, and keep the input array intact.',
    acceptance: ['Format labels as Total: <value>.', 'summarize sums positive and negative inputs, handles an empty array, and uses the imported helper without mutating the array.'],
    files: {
      'src/label.mjs': ['export const formatLabel = value => "Row: " + value', 'export const formatLabel = value => "Total: " + value'],
      'src/totals.mjs': [
        `import { formatLabel } from './label.mjs'; export const summarize = values => ({ total: values.length, label: formatLabel(values.length) })`,
        `import { formatLabel } from './label.mjs'; export function summarize(values) { const total = values.reduce((sum, value) => sum + value, 0); return { total, label: formatLabel(total) } }`,
      ],
    },
    check: String.raw`const { summarize } = await load('totals')
const { formatLabel } = await load('label')
assert.equal(formatLabel(-2), 'Total: -2')
assert.deepEqual(summarize(Object.freeze([2,-3,5])), { total: 4, label: 'Total: 4' })
assert.deepEqual(summarize([]), { total: 0, label: 'Total: 0' })
assert.match(Function.prototype.toString.call(summarize), /\bformatLabel\s*\(/)`,
  },
  {
    id: 'regression-sensitive', category: 'Regression-sensitive task', direct: false,
    task: 'Fix src/expiry.mjs so a coupon remains eligible on its expiration date. Preserve all existing behavior: dates before expiration remain eligible for enabled coupons, dates after expiration and disabled coupons are ineligible, and null expiration never expires when enabled. Inputs are calendar dates in YYYY-MM-DD format or a null expiration.',
    acceptance: ['An enabled coupon is eligible before and on its expiration date, and ineligible after it.', 'Disabled coupons are ineligible. Null expiration leaves an enabled coupon eligible.'],
    files: { 'src/expiry.mjs': [
      `export const eligible = (enabled, date, expiry) => enabled && (expiry === null || date < expiry)`,
      `export const eligible = (enabled, date, expiry) => enabled && (expiry === null || date <= expiry)`,
    ] },
    check: `const { eligible } = await load('expiry')
const expiry = '2027-01-01'
assert.equal(eligible(true, '2026-12-31', expiry), true)
assert.equal(eligible(true, expiry, expiry), true)
assert.equal(eligible(true, '2027-01-02', expiry), false)
assert.equal(eligible(false, expiry, expiry), false)
assert.equal(eligible(true, expiry, null), true)
assert.equal(eligible(false, expiry, null), false)`,
  },
]

const pinned = { codex: 'gpt-6-luna', claude: 'claude-haiku-5-5' }
const timeoutMs = 240000
const verify = 'node tests/check.mjs'
const root = process.cwd()
const parent = join(artifactDir(root), 'verification')
mkdirSync(parent, { recursive: true })
const out = mkdtempSync(join(parent, 'execution-v2-fixtures-'))
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(out, 'empty.gitconfig'),
  GIT_AUTHOR_DATE: '2026-11-19T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-19T00:00:00Z' }
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error ?? result.stderr}`)
  return result.stdout.trimEnd()
}
function put(folder, name, content) {
  const path = join(folder, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}
function check(cwd, evaluator) {
  const result = spawnSync(process.execPath, [evaluator, cwd], {
    cwd, encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
  })
  return { exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    error: result.error?.code ?? null }
}

const evidence = []
for (const fixture of fixtures) {
  const { id, category, direct, task, acceptance, files } = fixture
  const scope = Object.keys(files)
  const description = `${task}\n\nEdit only ${scope.join(', ')}. Keep the test and configuration files unchanged. Use no external dependencies. The check is node tests/check.mjs.\n\nAcceptance:\n${acceptance.map(line => `- ${line}`).join('\n')}`
  const seed = join(out, 'seed', id)
  const control = join(out, 'control', id)
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '--template=', '--initial-branch=main')
  git(seed, 'config', 'core.autocrlf', 'false')
  git(seed, 'config', 'user.name', 'Benchmark Fixture')
  git(seed, 'config', 'user.email', 'fixture@invalid.example')
  const evaluatorSource = `import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const load = name => import(pathToFileURL(resolve(process.argv[2] ?? '.', 'src', name + '.mjs')).href)
${fixture.check}\nconsole.log('ACCEPTANCE_PASS')\n`
  put(seed, 'tests/check.mjs', evaluatorSource)
  put(seed, '.gitattributes', '* text eol=lf\n')
  put(seed, '.gitignore', '.model-ladder/\n')
  for (const [backend, model] of Object.entries(pinned)) {
    const cell = { model, effort: 'low' }
    put(seed, `.${backend}/model-ladder.json`, `${JSON.stringify({
      router: cell, verifier: cell, tiers: [{ model, efforts: ['low'], maxEffortJump: 1 }],
      verify, maxAttempts: 1, timeoutMs, commit: false, network: false, direct_threshold: 'off',
    }, null, 2)}\n`)
  }
  for (const [file, [initial]] of Object.entries(files)) put(seed, file, `${initial}\n`)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', `Frozen fixture: ${id}`)
  const head = git(seed, 'rev-parse', 'HEAD')
  const tree = git(seed, 'rev-parse', 'HEAD^{tree}')
  const evaluator = put(out, `acceptance/${id}.mjs`, evaluatorSource)
  git(out, 'clone', '-q', '--no-hardlinks', '--', seed, control)
  git(control, 'remote', 'remove', 'origin')
  assert.equal(git(control, 'rev-parse', 'HEAD^{tree}'), tree)
  const failing = check(control, evaluator)
  assert.equal(failing.exitCode, 1, id)
  assert.match(failing.stderr, /AssertionError/, id)
  const testFile = 'tests/check.mjs'
  const testPath = put(control, testFile, 'process.exit(0)\n')
  const modifiedLocal = check(control, testPath)
  const independentAfterTamper = check(control, evaluator)
  assert.equal(modifiedLocal.exitCode, 0)
  assert.equal(independentAfterTamper.exitCode, 1)
  put(control, testFile, evaluatorSource)
  for (const [file, [, passing]] of Object.entries(files)) put(control, file, `${passing}\n`)
  const passing = check(control, evaluator)
  assert.equal(passing.exitCode, 0, passing.stderr)
  assert.equal(passing.stdout.trim(), 'ACCEPTANCE_PASS')
  assert.equal(check(control, testPath).exitCode, 0)
  const changed = () => git(control, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    .split('\0').filter(Boolean).map(entry => entry.slice(3))
  assert.deepEqual(changed().sort(), scope.toSorted())
  put(control, testFile, 'process.exit(0)\n')
  put(control, 'unexpected.mjs', 'export const unexpected = true\n')
  const unexpected = changed().filter(path => !scope.includes(path))
  assert.deepEqual(unexpected.sort(), [testFile, 'unexpected.mjs'])
  assert.equal(readFileSync(join(seed, testFile), 'utf8'), evaluatorSource)
  assert.equal(git(seed, 'status', '--porcelain'), '')
  evidence.push({ id, category, description, acceptance, scope, direct, head, tree,
    dependencyVersions: { node: process.version, thirdParty: [] }, evaluator: `acceptance/${id}.mjs`,
    checks: { starter: failing, reference: passing, tamperedLocal: modifiedLocal,
      independentAfterTamper, rejectedPathChanges: unexpected } })
}

const manifest = put(out, 'fixtures.json', `${JSON.stringify({ pinned, timeoutMs, verify, fixtures: evidence }, null, 2)}\n`)
console.log(manifest)
