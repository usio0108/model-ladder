// Uses the installed native Codex launcher. No agent, login, external endpoint or elevation.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { artifactDir } from '../../scripts/common.mjs'
import { processRun } from '../../scripts/codex-exec.mjs'
import { sandboxVerification } from '../../scripts/codex-verify.mjs'

const address = '127.0.0.1'
const networkDenials = ['EACCES', 'EPERM', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']
const fileDenials = ['EACCES', 'EPERM', 'ENOENT']
const parent = join(artifactDir(process.cwd()), 'verification')
mkdirSync(parent, { recursive: true })
const run = mkdtempSync(join(parent, 'sandbox-smoke-'))
const cwd = join(run, 'fixture')
mkdirSync(cwd)
const result = { platform: process.platform, node: process.version, artifact: run, checks: [] }

async function fixture() {
  const fs = await import('node:fs')
  const { spawn, spawnSync } = await import('node:child_process')
  const { createConnection } = await import('node:net')
  const { mode, outside, port } = JSON.parse(fs.readFileSync('fixture-input.json', 'utf8'))
  const child = process.argv[2] === 'child'
  if (mode === 'lifecycle') {
    const depth = Number(process.argv[2] ?? 0)
    const name = ['parent', 'child', 'grandchild'][depth]
    if (depth < 2) spawn(process.execPath, ['sandbox-fixture.mjs', String(depth + 1)], { stdio: 'inherit' })
    fs.writeFileSync(`${name}.pid`, String(process.pid))
    const tick = setInterval(() => fs.writeFileSync(`${name}.tick`, String(Date.now())), 60)
    setTimeout(() => { clearInterval(tick); fs.writeFileSync(`${name}.natural-exit`, 'done') }, 3200)
    return
  }

  const observe = (fn) => {
    try { fn(); return 'ALLOWED' } catch (error) { return error.code ?? 'UNKNOWN' }
  }
  const read = observe(() => fs.readFileSync(outside))
  const write = observe(() => fs.appendFileSync(outside, '\nmodified'))
  const network = await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (code) => { socket.destroy(); resolve(code) }
    socket.once('connect', () => done('ALLOWED'))
    socket.once('error', (error) => done(error.code ?? 'UNKNOWN'))
    socket.setTimeout(1000, () => done('TIMEOUT'))
  })
  const value = fs.readFileSync('allowed.txt', 'utf8')
  fs.writeFileSync(child ? 'child-write.txt' : 'allowed-write.txt', value)
  console.log(JSON.stringify({ child, read, write, network, value }))
  if (!child) {
    const outcome = spawnSync(process.execPath, ['sandbox-fixture.mjs', 'child'], { stdio: 'inherit' })
    console.error('sandbox-fixture-stderr')
    process.exitCode = outcome.status === 0 ? 17 : 18
  }
}

function hostControl(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, port })
    let response = ''
    socket.once('connect', () => socket.write('control'))
    socket.setEncoding('utf8').on('data', (text) => { response += text })
    socket.once('error', reject)
    socket.setTimeout(1000, () => socket.destroy(new Error('Host control timed out')))
    socket.once('end', () => response === 'fixture-listener' ? resolve() : reject(new Error('Host received the wrong listener response')))
  })
}

const command = 'node sandbox-fixture.mjs'
const prepare = (path, input) => {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'fixture-input.json'), JSON.stringify(input))
  writeFileSync(join(path, 'sandbox-fixture.mjs'), `await (${fixture.toString()})();\n`)
}

async function nativeSmoke() {
  const outside = join(run, 'fake-sensitive.txt')
  const server = createServer((socket) => {
    socket.setTimeout(1000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('data', () => socket.end('fixture-listener'))
  })
  writeFileSync(outside, 'fake-secret')
  writeFileSync(join(cwd, 'allowed.txt'), 'allowed-fixture')
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, address, resolve))
    const { port } = server.address()
    await hostControl(port)
    prepare(cwd, { mode: 'security', outside, port })
    try {
      const check = await sandboxVerification({ run, cwd, command, timeoutMs: 10000 })
      result.native = { status: check.sandbox, code: check.code, stdout: check.stdout, stderr: check.stderr, evidence: check.sandboxEvidence }
      assert.equal(check.sandbox, 'SANDBOX_VERIFIED')
      assert.equal(check.code, 17)
      assert.match(check.stderr, /sandbox-fixture-stderr/)
      const reports = check.stdout.split(/\r?\n/).filter((line) => line.startsWith('{"child":')).map(JSON.parse)
      assert.deepEqual(reports.map(({ child }) => child), [false, true])
      for (const report of reports) {
        assert.ok(fileDenials.includes(report.read), `read: ${report.read}`)
        assert.ok(fileDenials.includes(report.write), `write: ${report.write}`)
        assert.ok(networkDenials.includes(report.network), `network: ${report.network}`)
        assert.equal(report.value, 'allowed-fixture')
      }
      for (const name of ['allowed-write.txt', 'child-write.txt']) assert.equal(readFileSync(join(cwd, name), 'utf8'), 'allowed-fixture')
      result.checks.push({ name: 'native command and child restrictions', status: 'PASS' })
    } catch (error) {
      if (!error.sandbox) throw error
      result.native = { status: error.sandbox, code: error.code, evidence: error.sandboxEvidence, message: error.message }
      assert.equal(existsSync(join(cwd, 'allowed-write.txt')), false, 'strict mode ran the command without proven isolation')
      result.checks.push({ name: 'native command and child restrictions', status: 'UNVERIFIED' }, { name: 'no host fallback', status: 'PASS' })
      process.exitCode = error.sandbox === 'SANDBOX_UNAVAILABLE' ? 2 : 1
    }
    await hostControl(port)
    assert.equal(readFileSync(outside, 'utf8'), 'fake-secret')
    result.hostControl = 'PASS'
  } finally { server.close() }
}

async function lifecycle(runCommand) {
  for (const mode of ['normal', 'timeout', 'cancel']) {
    const path = join(cwd, mode)
    prepare(path, { mode: 'lifecycle' })
    const signal = new AbortController()
    const pending = runCommand(path, mode === 'timeout' ? 1400 : 10000, signal.signal)
      .then(({ code }) => ({ code }), ({ code, childPid, message }) => ({ code, childPid, message }))
    if (mode === 'cancel') {
      for (let n = 0; n < 100 && !existsSync(join(path, 'grandchild.tick')); n++) await delay(25)
      signal.abort()
    }
    const observed = await pending
    const names = ['parent', 'child', 'grandchild']
    const armed = names.every((name) => existsSync(join(path, `${name}.pid`)))
    const expected = { normal: 0, timeout: 'TIMEOUT', cancel: 'CANCELLED' }[mode]
    const naturalExitBefore = names.filter((name) => existsSync(join(path, `${name}.natural-exit`)))
    const ticks = () => names.map((name) => {
      const tick = join(path, `${name}.tick`)
      return existsSync(tick) ? readFileSync(tick, 'utf8') : null
    })
    const before = ticks()
    await delay(observed.code === 'TERMINATION_FAILED' ? 3400 : 200)
    const after = ticks()
    const stopped = JSON.stringify(before) === JSON.stringify(after)
    const pass = armed && stopped && observed.code === expected && naturalExitBefore.length === (mode === 'normal' ? names.length : 0)
    const record = { name: mode, expected, observed, allPids: armed, naturalExitBefore, heartbeatStopped: stopped, status: pass ? 'PASS' : 'FAIL' }
    if (observed.code === 'TERMINATION_FAILED') {
      await delay(200)
      record.fixtureSelfExited = names.every((name) => existsSync(join(path, `${name}.natural-exit`))) && JSON.stringify(after) === JSON.stringify(ticks())
    }
    result.checks.push(record)
    if (!pass) process.exitCode = 1
  }
}

try {
  if (process.argv.includes('--host-lifecycle')) {
    result.sandbox = 'HOST_UNSANDBOXED'
    await lifecycle((path, timeoutMs, signal) => processRun(process.execPath, ['sandbox-fixture.mjs'], { cwd: path, timeoutMs, signal }))
  } else {
    await nativeSmoke()
    if (!process.exitCode) await lifecycle((path, timeoutMs, signal) => sandboxVerification({ run, cwd: path, command, timeoutMs, signal }))
    else result.checks.push({ name: 'native normal, timeout and cancel', status: 'UNVERIFIED' })
  }
} catch (error) {
  result.error = error.message
  process.exitCode = 1
} finally {
  result.exitCode = process.exitCode ?? 0
  writeFileSync(join(run, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
