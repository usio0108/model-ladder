import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactDir } from '../../scripts/common.mjs'
import { hudBlock, profilePaths } from '../../scripts/codex-hud-setup.mjs'
import { uninstall } from '../../scripts/uninstall.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ml-uninstall-')))
  const root = join(base, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  mkdirSync(join(root, '.model-ladder', 'runs'), { recursive: true })
  mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true })
  mkdirSync(artifactDir(root), { recursive: true })
  const exclude = join(root, '.git', 'info', 'exclude')
  mkdirSync(join(exclude, '..'), { recursive: true })
  writeFileSync(exclude, '# keep\n.model-ladder/\nmine/\n.claude/worktrees/\n')
  const documentsDir = join(base, 'Documents')
  const [pwsh, winPs] = profilePaths(documentsDir)
  for (const path of [pwsh, winPs]) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `Set-Alias ll ls\r\n\r\n${hudBlock('C:/p/1.0.0').replace(/\n/g, '\r\n')}\r\n`)
  }
  const updateCheckPath = join(base, 'update-check.json')
  writeFileSync(updateCheckPath, '{}')
  t.after(() => { rmSync(base, { recursive: true, force: true }); rmSync(artifactDir(root), { recursive: true, force: true }) })
  return { base, root, exclude, pwsh, winPs, updateCheckPath, options: { root, documentsDir, platform: 'win32', updateCheckPath } }
}

test('removes dirs, exclude lines and profile blocks, keeps unrelated content', (t) => {
  const f = fixture(t)
  const result = uninstall(f.options)
  assert.equal(result.failed, false)
  assert.ok(!existsSync(join(f.root, '.model-ladder')) && !existsSync(join(f.root, '.claude', 'worktrees')) && !existsSync(artifactDir(f.root)) && !existsSync(f.updateCheckPath))
  assert.equal(readFileSync(f.exclude, 'utf8'), '# keep\nmine/\n')
  for (const path of [f.pwsh, f.winPs]) assert.equal(readFileSync(path, 'utf8'), 'Set-Alias ll ls\r\n')
  assert.match(result.lines.join('\n'), /claude plugin uninstall model-ladder@model-ladder/)
})

test('removes only worktrees under .claude/worktrees', (t) => {
  const f = fixture(t)
  git(f.root, 'worktree', 'add', '-q', '--detach', join(f.root, '.claude', 'worktrees', 'wt'))
  git(f.root, 'worktree', 'add', '-q', '--detach', join(f.base, 'other-wt'))
  uninstall(f.options)
  const listed = git(f.root, 'worktree', 'list')
  assert.doesNotMatch(listed, /\.claude/)
  assert.match(listed, /other-wt/)
})

test('dry run changes nothing', (t) => {
  const f = fixture(t)
  const read = () => [f.exclude, f.pwsh, f.winPs].map((p) => readFileSync(p, 'utf8'))
  const before = read()
  const result = uninstall({ ...f.options, dryRun: true })
  assert.ok(existsSync(join(f.root, '.model-ladder')) && existsSync(artifactDir(f.root)) && existsSync(f.updateCheckPath))
  assert.deepEqual(read(), before)
  assert.match(result.lines.join('\n'), /would remove/)
})

test('second run reports everything absent', (t) => {
  const f = fixture(t)
  uninstall(f.options)
  const again = uninstall(f.options)
  assert.equal(again.failed, false)
  const items = again.lines.filter((l) => /^(absent|removed|would remove|error):/.test(l))
  assert.ok(items.length >= 7 && items.every((l) => l.startsWith('absent:')))
})

test('refuses while a run is live unless forced', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, '.model-ladder', 'runs', 'r1.json'), JSON.stringify({ runId: 'r1', pid: process.pid, scope: ['**'] }))
  const refused = uninstall(f.options)
  assert.equal(refused.blocked, true)
  assert.ok(existsSync(join(f.root, '.model-ladder')))
  assert.equal(uninstall({ ...f.options, force: true }).blocked, false)
  assert.ok(!existsSync(join(f.root, '.model-ladder')))
})
