import '../helpers/isolate-home.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { codexExec, EnvironmentError, processRun } from '../../scripts/codex-exec.mjs'
import { sandboxVerification } from '../../scripts/codex-verify.mjs'

const partialOutput = `
  const bytes = Buffer.from('中文🙂');
  process.stdout.write(bytes.subarray(0, 1));
  setTimeout(() => {
    process.stdout.write(bytes.subarray(1));
    process.stderr.write('診斷🙂');
  }, 30);
  setInterval(() => {}, 1000);
`

test('timeout preserves decoded Unicode from split UTF-8 chunks', async () => {
  await assert.rejects(processRun(process.execPath, ['-e', partialOutput], { timeoutMs: 1500 }), (error) => {
    assert.ok(error instanceof EnvironmentError)
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.stdout, '中文🙂')
    assert.equal(error.stderr, '診斷🙂')
    return true
  })
})

test('cancellation retains output from the running child', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-cancel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ready = join(dir, 'ready')
  const controller = new AbortController()
  const script = `process.stdout.write('取消🙂', () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready')); setInterval(() => {}, 1000)`
  const pending = processRun(process.execPath, ['-e', script], { signal: controller.signal, timeoutMs: 10000 })
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, 'CANCELLED')
    assert.equal(error.stdout, '取消🙂')
    return true
  })
  for (let i = 0; i < 100 && !existsSync(ready); i++) await delay(20)
  controller.abort()
  await rejected
  assert.ok(existsSync(ready), 'child produced output before cancellation')
})

test('pre-cancelled execution reports empty captured streams', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(processRun(process.execPath, [], { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'CANCELLED')
    assert.equal(error.stdout, '')
    assert.equal(error.stderr, '')
    return true
  })
})

test('cancelling the real process tree also closes the grandchild pipe', async (t) => {
  const run = mkdtempSync(join(tmpdir(), 'ladder-tree-'))
  const ready = join(run, 'grandchild')
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => {}, 15000)`
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setTimeout(() => {}, 15000)`
  const controller = new AbortController()
  const pending = processRun(process.execPath, ['-e', parent], { signal: controller.signal })
  let treeStopped = false
  t.after(() => {
    if (!treeStopped && existsSync(ready)) { try { process.kill(Number(readFileSync(ready)), 'SIGKILL') } catch {} }
    rmSync(run, { recursive: true, force: true })
  })
  const rejection = assert.rejects(pending, { code: 'CANCELLED' })
  for (let i = 0; i < 100 && !existsSync(ready); i++) await delay(20)
  controller.abort()
  await rejection
  treeStopped = true
  assert.ok(existsSync(ready), 'grandchild was running at cancellation')
})

test('native verification rejects a launcher that runs without isolation', async (t) => {
  const run = mkdtempSync(join(tmpdir(), 'ladder-verify-'))
  t.after(() => rmSync(run, { recursive: true, force: true }))
  const cwd = join(run, 'candidate')
  mkdirSync(cwd)
  const marker = join(cwd, 'unisolated-command-ran')
  const command = 'echo should-never-run > unisolated-command-ran'
  const launcher = `
    const args = process.argv.slice(1);
    if (!args.includes('--include-managed-config') || !args.some((arg) => arg.endsWith('.network.enabled=false'))) process.exit(20);
    const native = args.slice(args.indexOf('--') + 1);
    const actual = require('node:child_process').spawnSync(native.shift(), native, { stdio: 'inherit' });
    process.exitCode = actual.status;
  `
  await assert.rejects(sandboxVerification({ run, cwd, command, timeoutMs: 5000,
    executable: { command: process.execPath, prefixArgs: ['-e', launcher, '--'] },
  }), (error) => {
    assert.equal(error.code, 'VERIFY_SANDBOX_ENFORCEMENT_FAILED')
    assert.deepEqual(error.sandboxEvidence, { launcherExitCode: 125, hostNetworkBefore: true, hostNetworkAfter: true, hostFileControl: true, read: 'ALLOWED', write: 'ALLOWED', network: 'ALLOWED' })
    return true
  })
  assert.equal(existsSync(marker), false)
})

test('sandbox receipt distinguishes recognized denial from an unrelated socket error', async (t) => {
  const run = mkdtempSync(join(tmpdir(), 'ladder-receipt-'))
  t.after(() => rmSync(run, { recursive: true, force: true }))
  const cwd = join(run, 'candidate')
  mkdirSync(cwd)
  // Protocol double only. The e2e smoke uses the installed native launcher.
  const launcher = `
    const [network, ...args] = process.argv.slice(1);
    const marker = args.at(-2);
    console.log(marker + ' ' + JSON.stringify({ read: 'EACCES', write: 'EPERM', network }));
    if (network === 'ECONNREFUSED') {
      console.log(marker + ' ready');
      console.log('fixture-stdout');
      console.error('fixture-stderr');
      process.exitCode = 17;
    } else process.exitCode = 125;
  `
  const runWith = (network) => sandboxVerification({ run, cwd, command: 'unused fixture command', executable: {
    command: process.execPath, prefixArgs: ['-e', launcher, '--', network],
  } })
  await assert.rejects(runWith('ECONNRESET'), (error) => {
    assert.equal(error.sandbox, 'SANDBOX_ENFORCEMENT_FAILED')
    assert.equal(error.sandboxEvidence.network, 'ECONNRESET')
    return true
  })
  const observed = await runWith('ECONNREFUSED')
  assert.equal(observed.sandbox, 'SANDBOX_VERIFIED')
  assert.equal(observed.code, 17)
  assert.equal(observed.stdout.trim(), 'fixture-stdout')
  assert.equal(observed.stderr.trim(), 'fixture-stderr')
})

test('captured output stays bounded without splitting surrogate pairs', async () => {
  const script = "process.stdout.write('🙂'.repeat(70000) + 'a'); process.stderr.write('🙂'.repeat(10000) + 'b')"
  const result = await processRun(process.execPath, ['-e', script])
  assert.equal(result.code, 0)
  assert.ok(result.stdout.length <= 131072)
  assert.ok(result.stderr.length <= 16384)
  assert.ok(result.stdout.isWellFormed())
  assert.ok(result.stderr.isWellFormed())
  assert.ok(result.stdout.endsWith('🙂a'))
  assert.ok(result.stderr.endsWith('🙂b'))
})

test('codex timeout persists partial events and stderr with phase context', async (t) => {
  const run = mkdtempSync(join(tmpdir(), 'ladder-timeout-'))
  t.after(() => rmSync(run, { recursive: true, force: true }))
  const stdout = '{"type":"thread.started","thread_id":"途中🙂"}\n'
  const stderr = '途中診斷🙂'
  const script = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); setInterval(() => {}, 1000)`
  await assert.rejects(codexExec({
    phase: 'worker', cell: { model: 'test', effort: 'low' }, cwd: run, run,
    prompt: 'test', sandbox: 'read-only', timeoutMs: 1500,
    executable: { command: process.execPath, prefixArgs: ['-e', script, '--'] },
  }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.phase, 'worker')
    assert.equal(error.cwd, run)
    return true
  })
  const files = readdirSync(run)
  const eventsFile = files.find((file) => file.endsWith('.events.jsonl'))
  assert.ok(eventsFile, 'partial event log exists')
  assert.equal(readFileSync(join(run, eventsFile), 'utf8'), stdout)
  assert.equal(readFileSync(join(run, eventsFile.replace('.events.jsonl', '.stderr.txt')), 'utf8'), stderr)
})

test('timeout is an idle limit: steady output outlives timeoutMs', async () => {
  const script = `let n = 0; const t = setInterval(() => { process.stdout.write('.'); if (++n === 8) { clearInterval(t) } }, 250)`
  const result = await processRun(process.execPath, ['-e', script], { timeoutMs: 1000 })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '........')
})

test('codexExec hands env to the child and to its sandboxed commands without changing the runner environment', async (t) => {
  const run = mkdtempSync(join(tmpdir(), 'ladder-env-'))
  t.after(() => rmSync(run, { recursive: true, force: true }))
  const before = process.env.UV_CACHE_DIR
  const cache = join(run, '.uv-cache')
  // Prints what it received, then writes the schema-valid worker output Codex would write with -o.
  const script = `const args = process.argv.slice(1); const out = args[args.indexOf('-o') + 1]
    require('node:fs').writeFileSync(out, JSON.stringify({ status: 'done', summary: JSON.stringify({ args, cache: process.env.UV_CACHE_DIR, offline: process.env.UV_OFFLINE }), blockedReason: null }))`
  const { value } = await codexExec({
    phase: 'worker', cell: { model: 'test', effort: 'low' }, cwd: run, run, prompt: 'test', sandbox: 'workspace-write', timeoutMs: 5000,
    env: { UV_CACHE_DIR: cache, UV_OFFLINE: '1' }, executable: { command: process.execPath, prefixArgs: ['-e', script, '--'] },
  })
  const seen = JSON.parse(value.summary)
  assert.equal(seen.cache, cache)
  assert.equal(seen.offline, '1')
  assert.ok(seen.args.includes(`shell_environment_policy.set.UV_CACHE_DIR=${JSON.stringify(cache)}`))
  assert.ok(seen.args.includes('shell_environment_policy.set.UV_OFFLINE="1"'))
  assert.equal(seen.args[seen.args.indexOf('-c') + 1], 'model_reasoning_effort="low"')
  assert.equal(process.env.UV_CACHE_DIR, before)
})
