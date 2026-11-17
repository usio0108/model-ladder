import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { applyResult, changed, git, makeWorktree, protectedChange, snapshot } from '../../scripts/codex-worktree.mjs'
import { artifactDir, pruneLeftoverBranches, removeWorktree, samePath } from '../../scripts/common.mjs'
import { nodeModulesMissing, runLadder, sandboxEnv, uvSyncRequired } from '../../scripts/codex-run.mjs'

test('removeWorktree removes a locked worktree, prunes it and deletes its worktree-wf_* branch', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ml-locked-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(root, '.claude', 'worktrees', 'wf_x')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'worktree-wf_x')
  git(root, 'worktree', 'lock', '--reason', 'claude agent', wt)
  assert.throws(() => git(root, 'worktree', 'remove', '--force', wt), 'a single --force cannot remove a locked worktree')
  assert.equal(removeWorktree(root, wt).ok, true)
  assert.equal(existsSync(wt), false)
  assert.ok(!git(root, 'worktree', 'list').includes('wf_x'), 'worktree unregistered')
  assert.equal(git(root, 'branch', '--list', 'worktree-wf_x'), '', 'branch deleted')
})

test('pruneLeftoverBranches deletes worktree-wf_* branches without a worktree and keeps the rest', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ml-leftover-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git(root, 'branch', 'worktree-wf_old')
  git(root, 'branch', 'feature')
  pruneLeftoverBranches(root)
  assert.equal(git(root, 'branch', '--list', 'worktree-wf_old'), '')
  assert.match(git(root, 'branch', '--list', 'feature'), /feature/)
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ml-artifacts-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'test')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'core.autocrlf', 'false')
  const write = (cwd, file, value) => { mkdirSync(join(cwd, file, '..'), { recursive: true }); writeFileSync(join(cwd, file), value) }
  for (const file of ['dist/source.js', 'build/source.js', 'target/source.js', 'dist/check.test.js', 'src/[ab].js', 'src/a.js']) write(root, file, 'original\n')
  write(root, '.gitignore', '.model-ladder/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'baseline')
  const commit = git(root, 'rev-parse', 'HEAD')
  const base = git(root, 'rev-parse', 'HEAD^{tree}')
  const run = join(root, '.model-ladder')
  mkdirSync(run)
  const worker = makeWorktree(root, run, 1, commit, base)
  t.after(() => { git(root, 'worktree', 'remove', '--force', worker); rmSync(root, { recursive: true, force: true }) })
  return { root, worker, run, base, commit, write, result: () => snapshot(worker, run, 'result') }
}

test('worktree creation retries one transient failure without advancing the attempt', (t) => {
  const f = fixture(t)
  let calls = 0, waits = 0
  const runGit = (cwd, ...args) => {
    if (args[0] === 'worktree' && ++calls === 1) throw Object.assign(new Error('git failed'), { stderr: 'Resource temporarily unavailable' })
    return git(cwd, ...args)
  }
  const worker = makeWorktree(f.root, f.run, 2, f.commit, f.base, { runGit, wait: () => { waits++ } })
  assert.equal(calls, 2)
  assert.equal(waits, 1)
  assert.equal(git(worker, 'rev-parse', 'HEAD'), f.commit)
  git(f.root, 'worktree', 'remove', '--force', worker)
  let failures = 0
  assert.throws(() => makeWorktree(f.root, f.run, 3, f.commit, f.base, { runGit: () => { failures++; throw new Error('invalid revision') }, wait: () => {} }), /invalid revision/)
  assert.equal(failures, 1)
})

test('tracked artifact edits and deletions are checked, protected and applied', (t) => {
  const f = fixture(t)
  f.write(f.worker, 'dist/source.js', 'updated\n')
  f.write(f.worker, 'target/source.js', 'updated\n')
  f.write(f.worker, 'dist/check.test.js', 'tampered\n')
  rmSync(join(f.worker, 'build/source.js'))
  const tree = f.result()
  assert.deepEqual(changed(f.root, f.base, tree), ['build/source.js', 'dist/check.test.js', 'dist/source.js', 'target/source.js'])
  assert.equal(protectedChange(f.root, f.base, tree, ['**/*.test.js']), 'dist/check.test.js')
  assert.equal(applyResult(f.root, f.run, f.base, tree, f.commit).applied, true)
  assert.equal(readFileSync(join(f.root, 'dist/source.js'), 'utf8'), 'updated\n')
  assert.equal(readFileSync(join(f.root, 'target/source.js'), 'utf8'), 'updated\n')
  assert.equal(existsSync(join(f.root, 'build/source.js')), false)
})

test('new generated artifacts are ignored without producing an empty patch', (t) => {
  const f = fixture(t)
  f.write(f.worker, 'dist/generated.js', 'generated\n')
  const tree = f.result()
  assert.deepEqual(changed(f.root, f.base, tree), [])
  assert.deepEqual(applyResult(f.root, f.run, f.base, tree, f.commit), { applied: false, files: [], note: 'No file changes' })
  assert.equal(existsSync(join(f.run, 'result.patch')), false)
})

test('patch uses literal filenames and excludes added artifacts', (t) => {
  const f = fixture(t)
  f.write(f.worker, 'src/[ab].js', 'updated\n')
  f.write(f.worker, 'dist/generated.js', 'generated\n')
  const tree = f.result()
  const result = applyResult(f.root, f.run, f.base, tree, f.commit)
  assert.equal(result.applied, true)
  assert.deepEqual(result.files, ['src/[ab].js'])
  assert.equal(readFileSync(join(f.root, 'src/[ab].js'), 'utf8'), 'updated\n')
  assert.equal(readFileSync(join(f.root, 'src/a.js'), 'utf8'), 'original\n')
  assert.equal(existsSync(join(f.root, 'dist/generated.js')), false)
})

test('verifier artifact changes use the original tracked baseline', (t) => {
  const f = fixture(t)
  f.write(f.worker, 'dist/generated.js', 'worker output\n')
  f.write(f.worker, 'build/generated.js', 'worker output\n')
  const workerTree = f.result()
  f.write(f.worker, 'dist/generated.js', 'verifier output\n')
  rmSync(join(f.worker, 'build/generated.js'))
  assert.deepEqual(changed(f.root, workerTree, f.result(), f.base), [])
  f.write(f.worker, 'dist/source.js', 'verifier tampered\n')
  assert.deepEqual(changed(f.root, workerTree, f.result(), f.base), ['dist/source.js'])
})

// Codex sandbox: worker and verifier worktrees have no .venv, no node_modules and no network.
const fakeCodex = fileURLToPath(new URL('../helpers/fake-codex.mjs', import.meta.url))
// Stands in for `uv run pytest` as the sandbox sees it: without UV_PROJECT_ENVIRONMENT it creates .venv in the
// worktree and needs the network; with a cache outside the worktree it is denied; with sync or online mode it would
// download. Otherwise it runs against the borrowed environment, writing only into UV_CACHE_DIR.
const FAKE_UV = `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const cwd = process.cwd()
const log = fileURLToPath(new URL('uv-log.jsonl', import.meta.url))
const env = process.env.UV_PROJECT_ENVIRONMENT, cache = process.env.UV_CACHE_DIR
const done = (ok, message) => {
  appendFileSync(log, JSON.stringify({ cwd, ok, message, env: env ?? null, cache: cache ?? null, venvInWorktree: existsSync(join(cwd, '.venv')) }) + '\\n')
  ;(ok ? console.log : console.error)(message)
  process.exit(ok ? 0 : 2)
}
if (!env) { mkdirSync(join(cwd, '.venv'), { recursive: true }); done(false, 'error: Failed to fetch: https://pypi.org/simple/pytest/ (network unreachable)') }
const rel = cache ? relative(cwd, cache) : '..'
if (rel.startsWith('..') || isAbsolute(rel)) done(false, 'error: Failed to initialize cache: Access is denied. (os error 5)')
if (process.env.UV_NO_SYNC !== '1' || process.env.UV_OFFLINE !== '1') done(false, 'error: Failed to fetch while syncing (network unreachable)')
if (!existsSync(join(env, 'pyvenv.cfg'))) done(false, 'error: No virtual environment found')
if (existsSync(join(env, 'broken'))) done(false, "ModuleNotFoundError: No module named 'pytest'")
writeFileSync(join(cache, 'entry'), 'cached')
done(true, '1 passed')
`
function uvRepo(t, { venv = true, scenario = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ml-uv-'))
  const tools = mkdtempSync(join(tmpdir(), 'ml-uv-tools-'))
  t.after(() => {
    for (const line of git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).slice(1)) git(root, 'worktree', 'remove', '--force', '--force', line.slice(9))
    rmSync(artifactDir(root), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(tools, { recursive: true, force: true })
  })
  const uv = join(tools, 'uv.mjs')
  writeFileSync(uv, FAKE_UV)
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'test')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'core.autocrlf', 'false')
  const write = (file, value) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), value) }
  write('.gitignore', '.model-ladder/\n')
  write('pyproject.toml', '[project]\nname = "shop"\nversion = "0.1.0"\n')
  write('uv.lock', 'version = 1\n')
  write('tests/test_shop.py', 'def test_ok():\n    assert True\n')
  write('greeting.mjs', 'export default "Wellcome"\n')
  write('scenario.json', JSON.stringify({ commands: { worker: uv, verify: uv }, ...scenario }))
  write('.codex/model-ladder.json', JSON.stringify({
    router: { model: 'cheap', effort: 'low' }, verifier: { model: 'cheap', effort: 'low' },
    tiers: [{ model: 'cheap', efforts: ['low', 'medium'], maxEffortJump: 1 }],
    verify: `node "${uv}" run pytest`, maxAttempts: 2,
  }))
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'fixture')
  // What uv sync leaves in the main checkout: an environment that ignores itself.
  if (venv) { write('.venv/.gitignore', '*\n'); write('.venv/pyvenv.cfg', 'home = python\n') }
  const uvLog = () => existsSync(join(tools, 'uv-log.jsonl')) ? readFileSync(join(tools, 'uv-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []
  const calls = () => existsSync(join(root, '.model-ladder', 'fake-calls.jsonl')) ? readFileSync(join(root, '.model-ladder', 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []
  const run = (input = {}) => runLadder({ task: 'Fix greeting typo', ...input }, { cwd: root, executable: { command: process.execPath, prefixArgs: [fakeCodex, root] } })
  return { root, uv, write, uvLog, calls, run }
}

test('sandboxEnv lends a uv project the main .venv read-only with an ignored cache inside the worktree', (t) => {
  const f = uvRepo(t)
  const before = { cache: process.env.UV_CACHE_DIR, project: process.env.UV_PROJECT_ENVIRONMENT, temp: process.env.TEMP }
  const commit = git(f.root, 'rev-parse', 'HEAD'), base = git(f.root, 'rev-parse', 'HEAD^{tree}')
  const run = mkdtempSync(join(tmpdir(), 'ml-uv-run-'))
  t.after(() => rmSync(run, { recursive: true, force: true }))
  // uvRepo's cleanup removes this worktree with the others before the repository goes.
  const worker = makeWorktree(f.root, run, 1, commit, base)
  const env = sandboxEnv(f.root, worker)
  assert.ok(samePath(env.UV_PROJECT_ENVIRONMENT, join(f.root, '.venv')))
  assert.equal(env.UV_NO_SYNC, '1')
  assert.equal(env.UV_OFFLINE, '1')
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1')
  assert.ok(samePath(env.UV_CACHE_DIR, join(worker, '.uv-cache')))
  writeFileSync(join(env.UV_CACHE_DIR, 'entry'), 'cached')
  assert.deepEqual(changed(worker, base, snapshot(worker, run, 'after')), [], 'the cache is never part of the attempt')
  assert.equal(existsSync(join(worker, '.venv')), false)
  assert.deepEqual({ cache: process.env.UV_CACHE_DIR, project: process.env.UV_PROJECT_ENVIRONMENT, temp: process.env.TEMP }, before, 'the runner environment is unchanged')
  const plain = mkdtempSync(join(tmpdir(), 'ml-plain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  const plainEnv = sandboxEnv(plain, plain)
  assert.deepEqual(Object.keys(plainEnv).sort(), ['TEMP', 'TMP', 'TMPDIR'], 'not a uv project: only temp variables')
  assert.ok(samePath(plainEnv.TEMP, join(plain, '.ml-tmp')))
  assert.equal(readFileSync(join(plain, '.ml-tmp', '.gitignore'), 'utf8'), '*\n')
  assert.equal(existsSync(join(plain, '.uv-cache')), false)
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.ok(samePath(env[key], join(worker, '.ml-tmp')), `uv project ${key}`)
  assert.equal(readFileSync(join(worker, '.ml-tmp', '.gitignore'), 'utf8'), '*\n')
})

test('uvSyncRequired only for a uv verification without a main .venv', (t) => {
  const f = uvRepo(t, { venv: false })
  assert.equal(uvSyncRequired(f.root, 'uv run pytest'), true)
  assert.equal(uvSyncRequired(f.root, 'npm test'), false)
  assert.equal(uvSyncRequired(f.root, null), false)
  f.write('.venv/pyvenv.cfg', 'home = python\n')
  assert.equal(uvSyncRequired(f.root, 'uv run pytest'), false)
})

test('uv project with a synced main .venv: worker, verify command and verifier run offline and leave no .venv', async (t) => {
  const f = uvRepo(t)
  const venvBefore = readdirSync(join(f.root, '.venv')).sort()
  const cacheBefore = process.env.UV_CACHE_DIR
  const result = await f.run()
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  const roles = f.calls().filter((call) => call.phase === 'worker' || call.phase === 'verify')
  assert.deepEqual(roles.map((call) => call.phase), ['worker', 'verify'])
  for (const call of roles) {
    assert.ok(samePath(call.shellEnv.UV_PROJECT_ENVIRONMENT, join(f.root, '.venv')), call.phase)
    assert.equal(call.shellEnv.UV_NO_SYNC, '1')
    assert.equal(call.shellEnv.UV_OFFLINE, '1')
    assert.ok(samePath(call.shellEnv.UV_CACHE_DIR, join(call.cwd, '.uv-cache')))
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.ok(samePath(call.shellEnv[key], join(call.cwd, '.ml-tmp')), `${call.phase} ${key}`)
    // The fake Codex child only echoes UV_* and PYTHONDONTWRITEBYTECODE, so compare those.
    const sharedKeys = Object.keys(call.shellEnv).filter((key) => !['TEMP', 'TMP', 'TMPDIR'].includes(key))
    assert.deepEqual(call.childEnv, Object.fromEntries(sharedKeys.map((key) => [key, call.shellEnv[key]])), 'the Codex child gets the same values')
    assert.equal(call.command.code, 0, call.command.output)
    assert.match(call.prompt, /SANDBOX LIMITS/)
    assert.match(call.prompt, /UV_PROJECT_ENVIRONMENT/)
  }
  const log = f.uvLog()
  assert.equal(log.length, 3, 'worker self-check, verify command and verifier each ran uv')
  assert.ok(log.every((entry) => entry.ok && !entry.venvInWorktree), JSON.stringify(log))
  assert.deepEqual(readdirSync(join(f.root, '.venv')).sort(), venvBefore, 'nothing wrote into the main .venv')
  assert.deepEqual(result.outcome.files, ['greeting.mjs'])
  assert.equal(existsSync(join(f.root, '.uv-cache')), false)
  assert.equal(process.env.UV_CACHE_DIR, cacheBefore)
})

test('uv project without a main .venv stops before any role and says to run uv sync in the main checkout first', async (t) => {
  const f = uvRepo(t, { venv: false })
  const result = await f.run()
  assert.equal(result.status, 'STOPPED', JSON.stringify(result))
  assert.equal(result.errorCode, 'UV_SYNC_REQUIRED')
  assert.match(result.message, /run uv sync in the main checkout first/i)
  assert.deepEqual(f.calls(), [], 'no router, worker or retry ran')
  assert.deepEqual(f.uvLog(), [])
  assert.equal(git(f.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1)
  assert.equal(existsSync(join(f.root, '.venv')), false, 'the runner never syncs on its own')
})

test('a sandbox failure with no network stops once with an actionable hint instead of retrying', async (t) => {
  const f = uvRepo(t, { scenario: { stopEnvironment: true } })
  f.write('.venv/broken', '')
  const result = await f.run()
  assert.equal(result.status, 'STOPPED', JSON.stringify(result))
  assert.deepEqual(f.calls().map((call) => call.phase), ['route', 'worker', 'diagnose'])
  assert.match(f.calls().at(-1).prompt, /no network/)
  assert.match(result.message, /run uv sync in the main checkout first/i)
  assert.match(result.message, /set verify in \.codex\/model-ladder\.json/)
  assert.equal(f.uvLog()[0].venvInWorktree, false)
})

test('a Node project without node_modules reports frontend checks as not run, never passed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ml-node-'))
  t.after(() => {
    for (const line of git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).slice(1)) git(root, 'worktree', 'remove', '--force', '--force', line.slice(9))
    rmSync(artifactDir(root), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'test')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'core.autocrlf', 'false')
  const write = (file, value) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), value) }
  write('.gitignore', '.model-ladder/\nnode_modules/\n')
  write('greeting.mjs', 'export default "Wellcome"\n')
  // Stands in for a frontend test runner that is only present after npm install.
  write('package.json', JSON.stringify({ name: 'web', private: true, scripts: { test: 'node check.mjs' }, devDependencies: { vitest: '1.0.0' } }))
  write('check.mjs', 'import { existsSync } from "node:fs"\nif (!existsSync("node_modules/vitest")) { console.error("vitest: not found"); process.exit(127) }\n')
  write('scenario.json', '{}')
  write('.codex/model-ladder.json', JSON.stringify({ router: { model: 'cheap', effort: 'low' }, verifier: { model: 'cheap', effort: 'low' }, tiers: [{ model: 'cheap', efforts: ['low', 'medium'], maxEffortJump: 1 }], verify: 'npm test', maxAttempts: 2 }))
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'fixture')
  // The main checkout has its dependencies; the attempt worktree does not, and no junction lends them.
  write('node_modules/vitest/package.json', '{}')
  const result = await runLadder({ task: 'Fix greeting typo' }, { cwd: root, executable: { command: process.execPath, prefixArgs: [fakeCodex, root] } })
  assert.equal(result.status, 'STOPPED', JSON.stringify(result))
  assert.match(result.message, /Frontend checks not run/)
  assert.match(result.message, /not a pass/)
  assert.equal(result.attempts[0].pass, false)
  const phases = readFileSync(join(root, '.model-ladder', 'fake-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).phase)
  assert.deepEqual(phases, ['route', 'worker'], 'no verifier pass and no retry')
  assert.equal(nodeModulesMissing(result.worktreePath), true)
  assert.equal(existsSync(join(result.worktreePath, 'node_modules')), false)
  assert.equal(readFileSync(join(root, 'greeting.mjs'), 'utf8'), 'export default "Wellcome"\n', 'nothing applied')
  assert.ok(existsSync(join(root, 'node_modules/vitest/package.json')), 'main checkout dependencies untouched')
})
