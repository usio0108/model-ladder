import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyResult, changed, git, makeWorktree, protectedChange, snapshot } from '../../scripts/codex-worktree.mjs'
import { pruneLeftoverBranches, removeWorktree } from '../../scripts/common.mjs'

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
