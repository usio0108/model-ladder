import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve, join } from 'node:path'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
const pty = { spawn() { throw new Error('spawn not mocked') } }
import { hudText, parseArgs, runHud, windowsCommand } from '../../scripts/codex-hud.mjs'
import { guardHandoff, HANDOFF_PROMPT } from '../../scripts/codex-guard-handoff.mjs'
import { artifactDir } from '../../scripts/common.mjs'
import { panelTitle } from '../../scripts/panel-title.mjs'

test('panel title accepts only a valid packaged manifest version', () => {
  assert.equal(panelTitle('{"version":"1.2.3"}'), 'model-ladder (v1.2.3)')
  for (const manifest of ['', '{', '{"version":"not-a-version"}', '{"version":1}']) assert.equal(panelTitle(manifest), 'model-ladder')
})

test('HUD reports the active role, model/effort and state from live.json', () => {
  const state = { runId: 'demo', agents: [
    { phase: 'router', model: 'gpt-router', effort: 'low', endedAt: '2026-10-29T00:00:00Z' },
    { phase: 'worker', model: 'gpt-worker', effort: 'medium', endedAt: null },
  ] }
  assert.match(hudText(state), /gpt-worker\/medium/)
  assert.match(hudText(state, 100), /model-ladder \(v\d+\.\d+\.\d+\)/)
  assert.doesNotMatch(hudText(state, 49), /\(v\d+\.\d+\.\d+\)/)
  assert.match(hudText({ result: { status: 'VERIFIED' } }), /idle/)
  assert.ok(hudText(state, 20).split('\n').every((line) => line.length <= 20))
  assert.deepEqual(parseArgs(['--cwd', 'fixture', '--', 'resume', '--last']), { cwd: resolve('fixture'), args: ['resume', '--last'] })
  assert.throws(() => parseArgs(['--cwd']), /requires/)
  for (const agents of [null, {}, [null, 'broken']]) assert.match(hudText({ agents }), /idle/)
})

test('HUD omits the version before either usage window at its actual header width', () => {
  const now = Date.parse('2026-11-10T00:00:00Z')
  const state = {
    agents: [{ phase: 'worker', model: 'm', effort: 'low', task: 'fix', startedAt: new Date(now).toISOString(), endedAt: null }],
    usage: { fiveHour: 33, fiveHourResetsAt: now / 1000 + 4 * 3600, sevenDay: 70, sevenDayResetsAt: now / 1000 + 2 * 86400 },
  }
  const narrow = hudText(state, 67, { now })
  assert.match(narrow, /4h\/5h 33%.*2d\/7d 70%/)
  assert.doesNotMatch(narrow, /\(v\d+\.\d+\.\d+\)/)
  // At 50 columns the key hints give way so both usage windows stay whole.
  const tight = hudText({ ...state, context: { tokens: 50, window: 100 } }, 50, { now }).split('\n')[0]
  assert.match(tight, /4h\/5h 33%.*2d\/7d 70%/)
  assert.doesNotMatch(tight, /\(v\d+\.\d+\.\d+\)|ctx/)
  assert.ok(tight.length <= 50)
  assert.match(hudText(state, 100, { now }), /\(v\d+\.\d+\.\d+\).*4h\/5h 33%.*2d\/7d 70%/)
})

test('HUD shows usage, guard and active work, then hides an old result', () => {
  const now = Date.now()
  const agent = { phase: 'worker', model: 'm', effort: 'low', task: 'fix', activity: 'Command: test', startedAt: new Date(now - 120000).toISOString(), endedAt: null }
  const state = { agents: [agent], expected: { phases: { worker: 60000 } }, usage: { fiveHour: 55, sevenDay: 95 } }
  const saved = process.env.NO_COLOR
  try {
    delete process.env.NO_COLOR
    const text = hudText(state, 100, { now, color: true })
    assert.match(text, /\x1b\[33m55%\x1b\[0m/)
    assert.match(text, /\x1b\[31m95%\x1b\[0m/)
    assert.match(text, /G:on.*\^\] handoff/)
    assert.match(text, /m\/low.*2m.*Command: test/)
    assert.match(hudText({ ...state, context: { tokens: 50, window: 100 } }, 120, { now }), /ctx 50\/100 \(50%\)/)
    process.env.NO_COLOR = '1'
    assert.doesNotMatch(hudText(state, 100, { now, color: true }), /\x1b/)
    const done = { ...state, agents: [{ ...agent, endedAt: new Date(now - 1000).toISOString() }], result: { status: 'STOPPED' } }
    assert.match(hudText(done, 100, { now }), /STOPPED/)
    const old = hudText(done, 100, { now: now + 10000 })
    assert.match(old, /idle/)
    assert.doesNotMatch(old, /STOPPED|m\/low/)
  } finally { if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved }
})

test('guard queues one fixed handoff per known window, persists and rearms below threshold', () => {
  const base = artifactDir(process.cwd())
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'guard-test-'))
  const stateDir = artifactDir(root)
  const usage = { fiveHour: 95, fiveHourResetsAt: 123, sevenDay: 30, sevenDayResetsAt: 456 }
  const guard = { enabled: true, threshold: 90 }
  const messages = []
  const deliver = (message) => { messages.push(message); return true }
  try {
    assert.equal(guardHandoff(root, usage, guard, deliver), true)
    assert.equal(guardHandoff(root, usage, guard, deliver), false)
    assert.deepEqual(messages, [HANDOFF_PROMPT])
    guardHandoff(root, { ...usage, fiveHour: 20 }, guard, deliver)
    assert.equal(guardHandoff(root, usage, guard, () => false), false)
    assert.equal(guardHandoff(root, usage, guard, deliver), true)
    assert.equal(guardHandoff(root, { ...usage, fiveHourResetsAt: 789 }, guard, deliver), true)
    assert.equal(messages.length, 3)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }) }
})

test('HUD sends a fixed guard request only to the session identified by its hook', async (t) => {
  const base = artifactDir(process.cwd())
  mkdirSync(base, { recursive: true })
  const cwd = mkdtempSync(join(base, 'hud-guard-test-'))
  const artifacts = artifactDir(cwd)
  const home = process.env.CODEX_HOME
  const id = 'abcdefab-1234-1234-1234-abcdefabcdef'
  process.env.CODEX_HOME = join(cwd, 'codex-home')
  mkdirSync(join(process.env.CODEX_HOME, 'sessions'), { recursive: true })
  writeFileSync(join(process.env.CODEX_HOME, 'sessions', 'fixture.jsonl'), JSON.stringify({ rate_limits: { primary: { used_percent: 95, resets_at: Date.now() / 1000 + 3600, window_minutes: 300 } } }))
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} })
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 8, write() {} })
  let onExit
  const calls = []
  t.mock.method(pty, 'spawn', (_command, _args, options) => {
    writeFileSync(join(artifacts, `hud-${options.env.MODEL_LADDER_HUD_TOKEN}.json`), JSON.stringify({ sessionId: id }))
    return { onData: () => ({ dispose() {} }), onExit(cb) { onExit = cb; return { dispose() {} } }, kill() {}, write() {}, resize() {} }
  })
  try {
    const running = runHud({ cwd, command: process.execPath, input, output, pty, queue: (...args) => calls.push(args) })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].slice(2), [id, HANDOFF_PROMPT])
    onExit({ exitCode: 0 })
    await running
  } finally {
    process.env.CODEX_HOME = home
    rmSync(cwd, { recursive: true, force: true })
    rmSync(artifacts, { recursive: true, force: true })
  }
})

test('Windows PATH preserves native arguments and rejects command shims', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-path-'))
  try {
    mkdirSync(join(cwd, 'bin with spaces'))
    writeFileSync(join(cwd, 'bin with spaces/codex.EXE'), '')
    const env = { PATH: join(cwd, 'missing') + ';' + join(cwd, 'bin with spaces'), PATHEXT: '.EXE;.CMD', SystemRoot: 'C:/Windows' }
    assert.deepEqual(windowsCommand('codex', ['resume', '--last'], cwd, env), { command: join(cwd, 'bin with spaces/codex.EXE'), args: ['resume', '--last'] })
    assert.throws(() => windowsCommand('absent', [], cwd, env), /cannot find/)
    const args = ['a&echo.HUD_INJECTED', "a'b & $()", '中文 空白', '"quoted"']
    assert.deepEqual(windowsCommand('codex', args, cwd, env).args, args)
    for (const extension of ['CMD', 'BAT']) {
      writeFileSync(join(cwd, `codex.${extension}`), '@echo HUD_INJECTED')
      assert.throws(() => windowsCommand(`codex.${extension}`, args, cwd, env), /native executable/)
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('HUD restores raw mode, pauses input and cleans up after exit and callback failures', async (t) => {
  for (const failure of [null, 'draw', 'resize', 'input', 'setup', 'input stream', 'output stream']) {
    await t.test(failure ?? 'normal exit', async (t) => {
      const input = Object.assign(new EventEmitter(), {
        isTTY: true, isRaw: failure === null, paused: true,
        setRawMode(value) { this.isRaw = value },
        resume() { this.paused = false; if (failure === 'setup') throw new Error('setup failure') },
        pause() { this.paused = true },
      })
      let outputText = '', inputText = '', throwWrite = false, killed = 0, onData, onExit, disposed = 0
      const output = Object.assign(new EventEmitter(), {
        isTTY: true, columns: 60, rows: 8,
        write(data) { if (throwWrite) { throwWrite = false; throw new Error('draw failure') } outputText += data },
      })
      const child = {
        onData(callback) { onData = callback; return { dispose() { disposed++ } } },
        onExit(callback) { onExit = callback; return { dispose() { disposed++ } } },
        kill() { killed++ },
        write(text) { if (failure === 'input') throw new Error('input failure'); inputText += text },
        resize(cols, rows) { assert.equal(cols, 50); assert.equal(rows, 4); if (failure === 'resize') throw new Error('resize failure') },
      }
      t.mock.method(pty, 'spawn', (command, args, options) => {
        assert.equal(command.toLowerCase(), process.execPath.toLowerCase())
        assert.equal(options.env.MODEL_LADDER_HUD, '1')
        assert.equal(options.env.MODEL_LADDER_BAND, '0')
        return child
      })
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal))
      const running = runHud({ command: process.execPath, input, output, pty })
      const settled = failure ? assert.rejects(running, new RegExp(`${failure} failure`)) : running
      // runHud imports the PTY asynchronously; wait until setup has completed.
      await new Promise((resolve) => setImmediate(resolve))
      if (failure === 'draw') { throwWrite = true; onData('hello') }
      else if (failure === 'resize') { output.columns = 50; output.rows = 6; output.emit('resize') }
      else if (failure === 'input') input.emit('data', Buffer.from('hello'))
      else if (failure === 'input stream') input.emit('error', new Error('input stream failure'))
      else if (failure === 'output stream') output.emit('error', new Error('output stream failure'))
      else if (!failure) {
        input.emit('data', Buffer.from([0xe4, 0xb8]))
        input.emit('data', Buffer.from([0xad]))
        assert.equal(inputText, '\u4e2d')
        onData('\x1b[')
        const previous = outputText
        onData('2Jprompt')
        assert.match(outputText.slice(previous.length), /^\x1b\[2Jprompt\x1b7/)
        onData('\x1b]0;title')
        onData('\x1b\\')
        assert.match(outputText, /\x1b\]0;title\x1b\\\x1b7/)
        onData('\x1b[8;5;40t')
        assert.doesNotMatch(outputText, /\x1b\[8;5;40t/)
        output.columns = 50; output.rows = 6; output.emit('resize')
        onExit({ exitCode: 7 })
        assert.equal((await running).exitCode, 7)
      }
      await settled
      assert.equal(input.isRaw, failure === null)
      assert.equal(input.paused, true)
      assert.equal(input.listenerCount('data'), 0)
      assert.equal(output.listenerCount('resize'), 0)
      assert.equal(input.listenerCount('error'), 0)
      assert.equal(output.listenerCount('error'), 0)
      assert.equal(killed, failure ? 1 : 0)
      assert.equal(disposed, 2)
      assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal)), signals)
      if (failure !== 'output stream') assert.match(outputText, /\x1b\[r/)
    })
  }
})

function harness(t, { cwd, command = process.execPath } = {}) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: true, paused: true,
    setRawMode(value) { this.isRaw = value },
    resume() { this.paused = false },
    pause() { this.paused = true },
  })
  const writes = []
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 60, rows: 8, write(data) { writes.push(data) } })
  const calls = { kill: 0, resize: [], spawn: undefined }
  let exitCallback, dataCallback
  const child = {
    onData(cb) { dataCallback = cb; return { dispose() {} } },
    onExit(cb) { exitCallback = cb; return { dispose() {} } },
    kill() { calls.kill++; exitCallback?.({ exitCode: 130 }) },
    write() {},
    resize(cols, rows) { calls.resize.push([cols, rows]) },
  }
  t.mock.method(pty, 'spawn', (spawnCommand, args, options) => { calls.spawn = { command: spawnCommand, args, options }; return child })
  const intervals = new Set()
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  globalThis.setInterval = (...a) => { const id = realSet(...a); intervals.add(id); return id }
  globalThis.clearInterval = (id) => { intervals.delete(id); realClear(id) }
  t.after(() => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; for (const id of intervals) realClear(id) })
  const start = async () => {
    const running = runHud({ cwd, command, input, output, pty })
    await new Promise((resolve) => setImmediate(resolve))
    return { running }
  }
  return { input, output, writes, calls, intervals, child, start, onData: (d) => dataCallback(d), exit: (e) => exitCallback(e) }
}

test('spawn passes useConptyDll on Windows only', async (t) => {
  const h = harness(t)
  const { running } = await h.start()
  h.exit({ exitCode: 0 })
  await running
  if (process.platform === 'win32') assert.equal(h.calls.spawn.options.useConptyDll, true)
  else assert.equal(h.calls.spawn.options.useConptyDll, undefined)
})

test('CODEX_BINARY overrides the default codex command', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-hud-bin-'))
  const saved = process.env.CODEX_BINARY
  try {
    const exe = join(dir, 'custom-codex.exe')
    writeFileSync(exe, '')
    process.env.CODEX_BINARY = exe
    const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() {}, resume() {}, pause() {} })
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 60, rows: 8, write() {} })
    let exitCallback, spawned
    t.mock.method(pty, 'spawn', (command) => {
      spawned = command
      return { onData: () => ({ dispose() {} }), onExit(cb) { exitCallback = cb; return { dispose() {} } }, kill() {}, write() {}, resize() {} }
    })
    const running = runHud({ cwd: dir, input, output, pty })
    await new Promise((resolve) => setImmediate(resolve))
    exitCallback({ exitCode: 0 })
    await running
    assert.equal(spawned.toLowerCase(), exe.toLowerCase())
  } finally {
    if (saved === undefined) delete process.env.CODEX_BINARY; else process.env.CODEX_BINARY = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('windowsCommand honors an absolute CODEX_BINARY path without searching PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-hud-abs-'))
  try {
    const exe = join(dir, 'my-codex.exe')
    writeFileSync(exe, '')
    assert.deepEqual(windowsCommand(exe, ['x'], dir, { PATH: '' }), { command: exe, args: ['x'] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('SIGINT kills the child and leaves no interval or raw mode behind', async (t) => {
  const h = harness(t)
  const { running } = await h.start()
  assert.equal(h.intervals.size, 1)
  assert.equal(h.input.paused, false)
  process.emit('SIGINT')
  assert.equal((await running).exitCode, 130)
  assert.equal(h.calls.kill >= 1, true)
  assert.equal(h.intervals.size, 0)
  assert.equal(h.input.paused, true)
  assert.equal(h.input.isRaw, true)
})

test('missing or corrupt live.json shows the waiting state and keeps redrawing', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-live-'))
  try {
    const h = harness(t, { cwd })
    const { running } = await h.start()
    assert.match(h.writes.join(''), /idle/)
    mkdirSync(join(cwd, '.model-ladder'))
    writeFileSync(join(cwd, '.model-ladder', 'live.json'), '{ not json')
    const before = h.writes.length
    h.onData('child output')
    assert.equal(h.writes.length > before, true)
    assert.match(h.writes.slice(before).join(''), /idle/)
    mkdirSync(join(cwd, '.model-ladder', 'runs'))
    writeFileSync(join(cwd, '.model-ladder', 'runs', 'r.json'), JSON.stringify({ runId: 'r', pid: process.pid }))
    writeFileSync(join(cwd, '.model-ladder', 'live.json'), JSON.stringify({ runId: 'r', agents: [{ phase: 'worker', model: 'm', effort: 'low', endedAt: null }] }))
    h.onData('more')
    assert.match(h.writes.join(''), /m\/low/)
    rmSync(join(cwd, '.model-ladder', 'runs', 'r.json'))
    const staleAt = h.writes.length
    h.onData('stale')
    assert.match(h.writes.slice(staleAt).join(''), /idle/)
    assert.doesNotMatch(h.writes.slice(staleAt).join(''), /m\/low/)
    h.exit({ exitCode: 0 })
    await running
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('Ctrl+] writes a handoff and tells the user how to add conversation context', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-handoff-'))
  try {
    mkdirSync(join(cwd, '.model-ladder'))
    writeFileSync(join(cwd, '.model-ladder', 'live.json'), JSON.stringify({ task: 'test', runId: 'r', agents: [] }))
    mkdirSync(join(cwd, '.model-ladder', 'runs'))
    writeFileSync(join(cwd, '.model-ladder', 'runs', 'r.json'), JSON.stringify({ runId: 'r', pid: process.pid }))
    const h = harness(t, { cwd })
    const { running } = await h.start()
    h.input.emit('data', Buffer.from('\x1d'))
    assert.ok(existsSync(join(cwd, '.model-ladder', 'HANDOFF.md')))
    assert.match(h.writes.join(''), /Handoff saved; use \$handoff/)
    h.exit({ exitCode: 0 })
    await running
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('resize shrinks the pty by the HUD row and redraws the HUD without clobbering output', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-resize-'))
  try {
    const h = harness(t, { cwd })
    const { running } = await h.start()
    assert.deepEqual([h.calls.spawn.options.cols, h.calls.spawn.options.rows], [60, 6])
    h.writes.length = 0
    h.output.columns = 40; h.output.rows = 12
    h.output.emit('resize')
    assert.deepEqual(h.calls.resize, [[40, 10]])
    const text = h.writes.join('')
    assert.match(text, /\x1b\[1;10r/)
    assert.match(text, /\x1b7\x1b\[11;1H\x1b\[2K▴/)
    assert.ok(text.indexOf('\x1b[1;10r') < text.indexOf('\x1b[11;1H\x1b[2K▴'))
    h.exit({ exitCode: 0 })
    await running
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('tiny terminals retain at least one row for Codex', async (t) => {
  const h = harness(t)
  h.output.rows = 1
  const { running } = await h.start()
  assert.equal(h.calls.spawn.options.rows, 1)
  assert.doesNotMatch(h.writes.join(''), /\x1b\[2;1H/)
  h.output.rows = 2
  h.output.emit('resize')
  assert.deepEqual(h.calls.resize, [[60, 1]])
  h.exit({ exitCode: 0 })
  await running
})

test('HUD runs plain codex and returns its exit code when node-pty cannot be loaded', async () => {
  const input = Object.assign(new EventEmitter(), { isTTY: true })
  const output = Object.assign(new EventEmitter(), { isTTY: true })
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    setImmediate(() => child.emit('close', 7))
    return child
  }
  let notice = ''
  const stderr = { write(text) { notice += text } }
  const loadPty = () => Promise.reject(new Error('Cannot find module node-pty'))
  const result = await runHud({ cwd: process.cwd(), args: ['resume', '--last'], command: process.execPath, input, output, loadPty, spawn, stderr })
  assert.deepEqual(result, { exitCode: 7 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command.toLowerCase(), process.execPath.toLowerCase())
  assert.deepEqual(calls[0].args, ['resume', '--last'])
  assert.equal(calls[0].options.stdio, 'inherit')
  assert.notEqual(calls[0].options.env.MODEL_LADDER_HUD, '1')
  assert.match(notice, /node-pty/)
  // A signal exit has no code: report failure rather than success.
  const killed = () => { const child = new EventEmitter(); setImmediate(() => child.emit('close', null, 'SIGTERM')); return child }
  assert.deepEqual(await runHud({ command: process.execPath, input, output, loadPty, spawn: killed, stderr }), { exitCode: 1 })
  const failing = () => { const child = new EventEmitter(); setImmediate(() => child.emit('error', new Error('spawn failed'))); return child }
  await assert.rejects(runHud({ command: process.execPath, input, output, loadPty, spawn: failing, stderr }), /spawn failed/)
  // The TTY check still comes first, with or without node-pty.
  await assert.rejects(runHud({ input: { isTTY: false }, output, loadPty, spawn, stderr }), /interactive terminal/)
})

test('Ctrl+\\ expands the HUD to every agent row and collapses it back, resizing the child each time', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-hud-expand-'))
  const now = Date.now()
  const ended = new Date(now).toISOString()
  const agents = ['router', 'worker', 'verifier'].map((phase, i) => ({ phase, model: `model-${i}`, effort: 'low', task: `task-${phase}`, startedAt: new Date(now - 5000).toISOString(), endedAt: ended }))
  mkdirSync(join(cwd, '.model-ladder'), { recursive: true })
  writeFileSync(join(cwd, '.model-ladder', 'live.json'), JSON.stringify({ runId: 'r', result: { status: 'VERIFIED' }, agents, skills: { worker: 'skill-alpha' } }))
  const h = harness(t, { cwd })
  h.output.rows = 20; h.output.columns = 120
  const forwarded = []
  h.child.write = (text) => forwarded.push(text)
  try {
    const { running } = await h.start()
    assert.equal(h.calls.spawn.options.rows, 18)
    const before = h.writes.length
    h.input.emit('data', Buffer.from('a\x1cb'))
    assert.deepEqual(forwarded, ['a', 'b'])
    // 3 agents + header + column row + skills + guard = 7 rows, below the half-terminal cap of 10.
    assert.deepEqual(h.calls.resize.at(-1), [120, 13])
    const expanded = h.writes.slice(before).join('')
    assert.match(expanded, /\x1b\[1;13r/)
    for (const text of ['model-0/low', 'model-1/low', 'model-2/low', 'task-worker', 'worker skill-alpha', 'usage guard: on', '^\\ collapse']) assert.ok(expanded.includes(text), text)
    const mark = h.writes.length
    h.input.emit('data', Buffer.from('\x1c'))
    assert.deepEqual(h.calls.resize.at(-1), [120, 18])
    const collapsed = h.writes.slice(mark).join('')
    assert.match(collapsed, /\x1b\[1;18r/)
    assert.ok(collapsed.includes('^\\ expand'))
    assert.ok(!collapsed.includes('usage guard'))
    // A terminal resize keeps the current state, here expanded and capped at half of 10 rows.
    h.input.emit('data', Buffer.from('\x1c'))
    h.output.rows = 10
    h.output.emit('resize')
    assert.deepEqual(h.calls.resize.at(-1), [120, 5])
    h.exit({ exitCode: 0 })
    await running
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

const win32 = (vk, uc, kd, cs = 8, rc = 1) => `\x1b[${vk};0;${uc};${kd};${cs};${rc}_`

async function win32Harness(t, name) {
  const cwd = mkdtempSync(join(tmpdir(), `ml-hud-${name}-`))
  mkdirSync(join(cwd, '.model-ladder', 'runs'), { recursive: true })
  writeFileSync(join(cwd, '.model-ladder', 'live.json'), JSON.stringify({ task: 'test', runId: 'r', agents: [{ phase: 'worker', model: 'm', effort: 'low', startedAt: new Date().toISOString(), endedAt: null }] }))
  writeFileSync(join(cwd, '.model-ladder', 'runs', 'r.json'), JSON.stringify({ runId: 'r', pid: process.pid }))
  const h = harness(t, { cwd })
  h.output.rows = 20; h.output.columns = 120
  const forwarded = []
  h.child.write = (text) => forwarded.push(text)
  const { running } = await h.start()
  const done = async () => { h.exit({ exitCode: 0 }); await running; rmSync(cwd, { recursive: true, force: true }) }
  return { h, cwd, forwarded, done }
}

test('Windows Terminal win32-input-mode Ctrl+\\ press and release toggles expand and is not forwarded', async (t) => {
  const { h, forwarded, done } = await win32Harness(t, 'w32-expand')
  const before = h.calls.resize.length
  h.input.emit('data', Buffer.from(win32(220, 28, 1) + win32(220, 28, 0)))
  assert.deepEqual(forwarded, [])
  assert.equal(h.calls.resize.length, before + 1)
  h.input.emit('data', Buffer.from(win32(220, 28, 1, 8, 3)))
  assert.equal(h.calls.resize.length, before + 2, 'repeat count above 1 fires once')
  h.input.emit('data', Buffer.from(win32(220, 28, 0)))
  assert.deepEqual(forwarded, [])
  await done()
})

test('win32-input-mode Ctrl+] triggers the handoff and is not forwarded', async (t) => {
  const { h, cwd, forwarded, done } = await win32Harness(t, 'w32-handoff')
  h.input.emit('data', Buffer.from(win32(221, 29, 1) + win32(221, 29, 0)))
  assert.deepEqual(forwarded, [])
  assert.ok(existsSync(join(cwd, '.model-ladder', 'HANDOFF.md')))
  assert.match(h.writes.join(''), /Handoff saved; use \$handoff/)
  await done()
})

test('win32-input-mode Ctrl+\\ with no Unicode character is recognized by virtual key and Ctrl state only', async (t) => {
  const { h, forwarded, done } = await win32Harness(t, 'w32-vk')
  const before = h.calls.resize.length
  h.input.emit('data', Buffer.from(win32(220, 0, 1, 0x04)))
  assert.equal(h.calls.resize.length, before + 1)
  h.input.emit('data', Buffer.from(win32(220, 0, 1, 0)))
  assert.equal(h.calls.resize.length, before + 1, 'no Ctrl state means a plain backslash')
  assert.deepEqual(forwarded, [win32(220, 0, 1, 0)])
  await done()
})

test('other win32-input-mode sequences and bytes are forwarded unchanged and in order', async (t) => {
  const { h, forwarded, done } = await win32Harness(t, 'w32-pass')
  const a = win32(65, 97, 1, 0), aUp = win32(65, 97, 0, 0)
  h.input.emit('data', Buffer.from(`x${a}${aUp}\x1b[A`))
  assert.equal(forwarded.join(''), `x${a}${aUp}\x1b[A`)
  forwarded.length = 0
  h.input.emit('data', Buffer.from(`${a}${win32(220, 28, 1)}${aUp}`))
  assert.equal(forwarded.join(''), a + aUp)
  await done()
})

test('a win32 sequence split across data events works and a stray ESC [ is not stalled', async (t) => {
  const { h, forwarded, done } = await win32Harness(t, 'w32-split')
  const before = h.calls.resize.length
  const seq = win32(220, 28, 1)
  h.input.emit('data', Buffer.from(seq.slice(0, 2)))
  assert.deepEqual(forwarded, [], 'a partial prefix is held')
  h.input.emit('data', Buffer.from(seq.slice(2, 9)))
  h.input.emit('data', Buffer.from(seq.slice(9)))
  assert.deepEqual(forwarded, [])
  assert.equal(h.calls.resize.length, before + 1)
  // A held fragment that never completes is forwarded after a short delay.
  h.input.emit('data', Buffer.from('\x1b['))
  assert.deepEqual(forwarded, [])
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(forwarded.join(''), '\x1b[')
  forwarded.length = 0
  // A fragment that cannot become a win32 sequence is forwarded with the next data in order.
  h.input.emit('data', Buffer.from('\x1b['))
  h.input.emit('data', Buffer.from('Ab'))
  assert.equal(forwarded.join(''), '\x1b[Ab')
  await done()
})

test('HUD header hint offers ^\\ and drops it after ctx and the version on narrow widths', () => {
  const now = Date.parse('2026-11-10T00:00:00Z')
  const state = {
    agents: [{ phase: 'worker', model: 'm', effort: 'low', task: 'fix', startedAt: new Date(now).toISOString(), endedAt: null }],
    context: { tokens: 50, window: 100 },
    usage: { fiveHour: 33, fiveHourResetsAt: now / 1000 + 4 * 3600, sevenDay: 70, sevenDayResetsAt: now / 1000 + 2 * 86400 },
  }
  assert.match(hudText(state, 140, { now }), /ctx.*\^\] handoff \^\\ expand/)
  assert.match(hudText(state, 140, { now, expanded: true }), /\^\\ collapse/)
  const tight = hudText(state, 50, { now, expanded: true }).split('\n')[0]
  assert.match(tight, /4h\/5h 33%.*2d\/7d 70%/)
  assert.doesNotMatch(tight, /ctx|\(v1/)
})
