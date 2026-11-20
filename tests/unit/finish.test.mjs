import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/finish.mjs', import.meta.url))
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })

// A repo with a run marker, a state file and a leftover worktree, as preflight and a worker would leave it.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-finish-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(dir, '.claude', 'worktrees', 'w')
  git(dir, 'worktree', 'add', '-q', wt, '-b', 'worktree-w')
  const run = join(dir, '.model-ladder')
  mkdirSync(run)
  writeFileSync(join(run, 'run.json'), '{}')
  writeFileSync(join(run, 'state.json'), '{"before":[],"config":{}}')
  return { dir, wt, run }
}

const finish = (dir, input) => spawnSync('node', [script], {
  cwd: dir, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, MODEL_LADDER_NO_UPDATE_CHECK: '1' },
})

const untouched = ({ wt, run }) => {
  assert.ok(existsSync(wt), 'worktree kept')
  assert.ok(existsSync(join(run, 'run.json')), 'run marker kept')
  assert.ok(existsSync(join(run, 'state.json')), 'state.json kept')
  assert.ok(!existsSync(join(run, 'history.jsonl')), 'no history written')
}

test('a whole workflow-output wrapper is rejected and nothing is cleaned', () => {
  const s = setup()
  const wrapper = { summary: 's', agentCount: 3, logs: [], result: { status: 'VERIFIED', winner: { worktreePath: s.wt, filesChanged: ['a'] } } }
  const r = finish(s.dir, { task: 't', result: wrapper })
  assert.notEqual(r.status, 0)
  assert.match(r.stdout, /result\.status missing — pass the workflow's result field, not the whole output/)
  untouched(s)
})

test('unknown status and VERIFIED without a winner are rejected', () => {
  const s = setup()
  const unknown = finish(s.dir, { task: 't', result: { status: 'BOGUS' } })
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stdout, /BOGUS/)
  const noWinner = finish(s.dir, { task: 't', result: { status: 'VERIFIED' } })
  assert.notEqual(noWinner.status, 0)
  assert.match(noWinner.stdout, /winner/)
  untouched(s)
})

test('aborted without a result is still accepted and cleans up', () => {
  const s = setup()
  const r = finish(s.dir, { task: 't', aborted: 'no' })
  assert.equal(r.status, 0)
  assert.ok(!existsSync(join(s.run, 'run.json')))
})

test('a locked worktree and its branch are removed (remove needs --force twice)', () => {
  const s = setup()
  const lock = git(s.dir, 'worktree', 'lock', '--reason', 'claude agent test', s.wt)
  assert.equal(lock.status, 0, lock.stderr)
  assert.match(git(s.dir, 'worktree', 'list').stdout, /locked/)
  const r = finish(s.dir, { task: 't', aborted: 'no' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(s.wt), 'locked worktree directory removed')
  assert.ok(!git(s.dir, 'worktree', 'list').stdout.includes('worktrees'), 'worktree unregistered')
  assert.equal(git(s.dir, 'branch', '--list', 'worktree-w').stdout.trim(), '', 'its branch deleted')
})

test('history attempts carry compact per-attempt skill reports', () => {
  const s = setup()
  const skills = [{ name: 'ponytail', applies: true, available: true, used: false, note: 'hook only', extra: 'dropped' }]
  const r = finish(s.dir, { task: 't', result: { status: 'FAILED', plan: { allowTests: false, allowTestsReason: 'r' }, attempts: [{ cell: 'a', pass: false, reason: 'x', skills }, { cell: 'b', pass: false, reason: 'y' }], tokens: 1 } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const row = JSON.parse(readFileSync(join(s.run, 'history.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.deepEqual(row.attempts[0].skills, [{ name: 'ponytail', applies: true, available: true, used: false, note: 'hook only' }])
  assert.equal('skills' in row.attempts[1], false)
})

// A real preflight + claim + candidate flow: a worker worktree that edited `files`, under a run that claimed `scope`.
function claimedRun(scope, files, verify) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-finish-scope-'))
  dirs.push(dir)
  const run = (name, args, opts = {}) => spawnSync('node', [fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url)), ...args], { cwd: dir, encoding: 'utf8', ...opts })
  for (const args of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@t'], ['config', 'core.autocrlf', 'false']]) git(dir, ...args)
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, '.gitignore'), '.model-ladder/\n.claude/worktrees/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  const { runId } = JSON.parse(run('preflight', []).stdout)
  assert.equal(JSON.parse(run('claim', [], { input: JSON.stringify({ runId, scope, readOnly: false }) }).stdout).status, 'READY')
  const wt = join(dir, '.claude', 'worktrees', 'w')
  git(dir, 'worktree', 'add', '-q', wt, '-b', 'worktree-w')
  for (const file of files) writeFileSync(join(wt, file), 'changed\n')
  const tree = (phase) => spawnSync('node', [script, '--candidate', runId, '1', phase], { cwd: wt, encoding: 'utf8' }).stdout.trim()
  tree('before')
  const result = {
    status: 'CANDIDATE', tokens: 1,
    plan: { goal: 'g', verify, start: 'haiku/low', startReason: 's', allowTests: false, allowTestsReason: 'r' },
    attempts: [{ cell: 'haiku/low', pass: true, reason: 'ok', worktreePath: wt }],
    winner: { worktreePath: wt, filesChanged: files, candidateTree: tree('after') },
  }
  return { dir, report: finish(dir, { task: 't', runId, result }) }
}

test('a legacy Claude candidate that changes a file outside the claimed scope is rejected and nothing is applied', () => {
  const { dir, report } = claimedRun(['a.txt'], ['a.txt', 'b.txt'])
  assert.match(report.stdout, /FAILED/)
  assert.match(report.stdout, /b\.txt, outside the claimed scope/)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a\n')
  assert.ok(!existsSync(join(dir, 'b.txt')))
})

test('a legacy Claude candidate whose changes are all inside the claimed scope is applied', () => {
  const { dir, report } = claimedRun(['a.txt', 'src'], ['a.txt'])
  assert.match(report.stdout, /VERIFIED/)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'changed\n')
})

const lastHistory = (dir) => JSON.parse(readFileSync(join(dir, '.model-ladder', 'history.jsonl'), 'utf8').trim().split('\n').at(-1))

test('plan.verify exit 0 applies the candidate and records the command evidence', () => {
  const { dir, report } = claimedRun(['a.txt'], ['a.txt'], 'node -e "console.log(1)"')
  assert.match(report.stdout, /VERIFIED/)
  assert.match(report.stdout, /Command +node -e .*exit 0.*HOST_UNSANDBOXED/)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'changed\n')
  const { command } = lastHistory(dir)
  assert.equal(command.exitCode, 0)
  assert.equal(command.sandbox, 'HOST_UNSANDBOXED')
  assert.equal(command.stdout.trim(), '1')
  assert.equal(typeof command.durationMs, 'number')
})

test('plan.verify exit 1 applies nothing, reports the exit code and keeps the evidence in history', () => {
  const { dir, report } = claimedRun(['a.txt'], ['a.txt'], 'node -e "console.error(\'boom\');process.exit(1)"')
  assert.match(report.stdout, /FAILED/)
  assert.match(report.stdout, /Verify command exited 1/)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a\n')
  const row = lastHistory(dir)
  assert.equal(row.applied, false)
  assert.equal(row.command.exitCode, 1)
  assert.match(row.command.stderr, /boom/)
})

test('plan.verify that changes the candidate worktree is rejected', () => {
  const { dir, report } = claimedRun(['a.txt', 'c.txt'], ['a.txt'], 'node -e "require(\'fs\').writeFileSync(\'c.txt\',\'x\')"')
  assert.match(report.stdout, /Verify command changed the candidate tree/)
  assert.ok(!existsSync(join(dir, 'c.txt')))
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'a\n')
  assert.equal(lastHistory(dir).command.exitCode, 0)
})

test('without plan.verify nothing runs and the evidence is null', () => {
  const { dir, report } = claimedRun(['a.txt'], ['a.txt'], '')
  assert.match(report.stdout, /VERIFIED/)
  assert.doesNotMatch(report.stdout, /Command /)
  assert.equal(lastHistory(dir).command, null)
})
