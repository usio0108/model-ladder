import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { displayWidth, renderLive, truncate, visibleAgents } from './codex-live.mjs'
import { formatContext } from '../hooks/band/context.mjs'
import { readCodexContext, readCodexUsage } from './codex-usage.mjs'
import { configureGuard } from './watch.mjs'
import { writeHandoff } from './codex-handoff.mjs'
import { artifactDir } from './common.mjs'
import { guardHandoff } from './codex-guard-handoff.mjs'
import { readLocks } from './runs.mjs'

const HUD_ROWS = 2

export function parseArgs(argv) {
  const options = { cwd: process.cwd(), args: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { options.args.push(...argv.slice(i + 1)); break }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--cwd') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--cwd requires a value')
      options.cwd = resolve(value)
      continue
    }
    options.args.push(arg)
  }
  return options
}

export function hudText(state, width = 80, { now = Date.now(), guard = { enabled: true, threshold: 90 }, color = false, expanded = false } = {}) {
  const agents = Array.isArray(state?.agents) ? state.agents.filter((agent) => agent && typeof agent === 'object' && (!state.result || agent.endedAt)) : []
  const visible = visibleAgents(agents, now)
  const selected = visible.findLast((agent) => agent.endedAt === null) ?? visible.at(-1)
  const current = { ...state, agents: selected ? [{ ...selected, task: selected.task ?? '' }] : [] }
  // Expanded shows every visible agent of the run; collapsed shows only the selected one.
  const base = expanded ? { ...state, agents } : current
  const frame = renderLive(base, { width, now, guard, color }).split('\n')
  const context = state?.context
  const ctx = formatContext(state?.context) ? ` · ${formatContext(state.context)}` : ''
  const keys = ` · G:${guard.enabled ? 'on' : 'off'} ^] handoff ^\\ ${expanded ? 'collapse' : 'expand'}`
  // Usage stays whole: the context goes first, then renderLive drops the version, and the key hints go last.
  const whole = (text) => !renderLive(base, { width: Math.max(0, width - displayWidth(text)), now, guard }).split('\n')[0].trimEnd().endsWith('…')
  const controls = [`${ctx}${keys}`, keys, ''].find(whole) ?? ''
  const rendered = renderLive(base, { width: Math.max(0, width - displayWidth(controls)), now, guard, color }).split('\n')[0]
  // Once the key hints are gone the version has already given way, even if the freed columns would fit it.
  const header = controls ? rendered : rendered.replace(/model-ladder \(v[^)]*\)/, 'model-ladder')
  if (expanded) return [`${header}${truncate(controls, Math.max(0, width))}`, ...frame.slice(1).map((line) => truncate(line, width))].join('\n')
  const status = selected ? `${frame[2]}${selected.endedAt && state?.result?.status ? ` · ${state.result.status}` : ''}` : 'idle'
  return `${header}${truncate(controls, Math.max(0, width))}\n${truncate(status, width)}`
}

function readLive(cwd) {
  try { return JSON.parse(readFileSync(join(cwd, '.model-ladder', 'live.json'), 'utf8')) }
  catch { return undefined }
}

function terminalSize(output) {
  return { columns: Math.max(1, output.columns || 80), rows: Math.max(1, output.rows || 24) }
}
const hudRows = (size) => Math.min(HUD_ROWS, size.rows - 1)

export function windowsCommand(command, args, cwd, env = process.env) {
  const directories = isAbsolute(command) || /[\\/]/.test(command) ? [''] : [cwd, ...(env.PATH ?? '').split(';')]
  const extensions = extname(command) ? [''] : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
  let executable
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, directory.replace(/^"|"$/g, ''), command + extension)
      try { if (statSync(candidate).isFile()) { executable = candidate; break } } catch {}
    }
    if (executable) break
  }
  if (!executable) throw new Error(`Codex HUD cannot find ${command} on PATH; install Codex CLI or set CODEX_BINARY`)
  if (/\.(cmd|bat)$/i.test(executable)) throw new Error('Codex HUD requires a native executable on Windows; set CODEX_BINARY to codex.exe instead of a .cmd or .bat shim')
  return { command: executable, args }
}

// A plain codex runs outside any HUD, even when this process was itself started inside one.
const plainEnv = ({ MODEL_LADDER_HUD, MODEL_LADDER_HUD_TOKEN, ...env }) => env

// Without node-pty there is no HUD, but `codex` must still work: run it directly and hand back its exit code.
export function runPlain({ cwd, args, command, spawn = nodeSpawn, stderr = process.stderr }) {
  if (process.platform === 'win32') ({ command, args } = windowsCommand(command, args, cwd))
  stderr.write('model-ladder HUD unavailable (node-pty could not be loaded); starting plain codex.\n')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: plainEnv(process.env) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ exitCode: code ?? 1 }))
  })
}

export async function runHud({ cwd = process.cwd(), args = [], input = process.stdin, output = process.stdout, command = process.env.CODEX_BINARY ?? 'codex', pty: injectedPty, loadPty = () => import('node-pty'), spawn, stderr, queue = (executable, directory, session, message) => execFileSync(executable, ['queue', '--thread', session, '--message', message], { cwd: directory, stdio: 'ignore', timeout: 5000, windowsHide: true }) } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Codex HUD requires an interactive terminal')
  let pty = injectedPty
  if (!pty) try {
    const module = await loadPty()
    pty = module.default ?? module
  } catch {
    return runPlain({ cwd, args, command, spawn, stderr })
  }
  const size = () => terminalSize(output)
  let dimensions = size()
  const token = randomUUID(), marker = join(artifactDir(cwd), `hud-${token}.json`)
  mkdirSync(artifactDir(cwd), { recursive: true })
  const startedAt = Date.now()
  if (process.platform === 'win32') ({ command, args } = windowsCommand(command, args, cwd))
  const child = pty.spawn(command, args, {
    name: process.env.TERM ?? 'xterm-256color',
    cols: dimensions.columns,
    rows: dimensions.rows - hudRows(dimensions),
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
    cwd,
    env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color', MODEL_LADDER_HUD: '1', MODEL_LADDER_BAND: '0', MODEL_LADDER_HUD_TOKEN: token },
  })
  // Ctrl+\ toggles the multi-line view; `rows` is the live HUD height and `hudLines` the last composed frame.
  let expanded = false, rows = hudRows(dimensions), hudLines = []
  const wantedRows = (dims) => expanded ? Math.max(1, Math.min(hudLines.length, Math.floor(dims.rows / 2), dims.rows - 1)) : hudRows(dims)
  const wasRaw = Boolean(input.isRaw)
  let exited = false
  let timer
  let pending = ''
  let outputFailed = false
  let usage, context, usageAt = 0
  let handoffNoticeUntil = 0, handoffNotice = ''
  const subscriptions = []
  let rejectRun
  const guard = (callback) => (...values) => {
    try { callback(...values) } catch (error) { rejectRun(error) }
  }
  const draw = () => {
    if (pending) return
    const live = readLive(cwd)
    const running = Boolean(live?.runId && !live.result && readLocks(cwd).some((lock) => lock.runId === live.runId && !lock.stale))
    const state = live && !running && !live.result ? { ...live, agents: Array.isArray(live.agents) ? live.agents.filter((agent) => agent?.endedAt) : [] } : live
    const guardConfig = configureGuard(cwd, {})
    if (Date.now() - usageAt >= 5000) {
      usage = readCodexUsage(undefined, undefined, { details: true, resets: true }); usageAt = Date.now()
      context = readCodexContext(cwd, statMarker())
      if (!running && ['fiveHour', 'sevenDay'].some((kind) => Number.isFinite(usage?.[kind]) && Number.isFinite(usage?.[`${kind}ResetsAt`]))) try {
        guardHandoff(cwd, usage, guardConfig, (message) => {
          const session = statMarker()
          if (!session) return false
          try {
            queue(command, cwd, session, message)
            handoffNotice = 'Usage guard: handoff requested.'; handoffNoticeUntil = Date.now() + 10000
            return true
          } catch { handoffNotice = 'Could not queue handoff; use $handoff in Codex.'; handoffNoticeUntil = Date.now() + 10000; return false }
        })
      } catch { /* A concurrent HUD or unavailable state leaves the guard armed. */ }
    }
    const lines = hudText({ ...state, usage, context }, Math.max(0, dimensions.columns - 1), { guard: guardConfig, color: output.isTTY, expanded }).split('\n')
    if (!hudRows(dimensions)) return
    if (Date.now() < handoffNoticeUntil) lines[1] = truncate(handoffNotice, Math.max(0, dimensions.columns - 1))
    else if (Date.now() - startedAt > 15000 && !statMarker()) lines[1] = truncate('Session hook not detected; review model-ladder in /hooks.', Math.max(0, dimensions.columns - 1))
    hudLines = lines
    const wanted = wantedRows(dimensions)
    if (wanted !== rows) { relayout(dimensions, wanted); return }
    output.write(`\x1b7${lines.slice(0, rows).map((line, i) => `\x1b[${dimensions.rows - rows + 1 + i};1H\x1b[2K${line}`).join('')}\x1b8`)
  }
  const statMarker = () => { try { const id = JSON.parse(readFileSync(marker, 'utf8')).sessionId; return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null } catch { return null } }
  // Clear the old HUD rows, then reset the scroll region and the child's height for the new size and HUD height.
  const relayout = (next, nextRows) => {
    output.write(`\x1b7${Array.from({ length: rows }, (_, i) => `\x1b[${Math.max(1, Math.min(dimensions.rows, next.rows) - i)};1H\x1b[2K`).join('')}\x1b8`)
    dimensions = next
    rows = Math.min(nextRows, dimensions.rows - 1)
    output.write(`\x1b[1;${dimensions.rows - rows}r`)
    child.resize(dimensions.columns, dimensions.rows - rows)
    draw()
  }
  const resize = () => { const next = size(); relayout(next, wantedRows(next)) }
  const decoder = new StringDecoder('utf8')
  // Windows Terminal sends keys as ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ once ConPTY enables win32-input-mode.
  const win32Key = /\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/y
  const win32Prefix = /\x1b\[[\d;]{0,40}$/
  let held = '', heldTimer
  // Split input into forwarded text and HUD keys; press events become keys, releases are dropped.
  const tokenize = (text) => {
    const parts = [''], keys = []
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '\x1c' || ch === '\x1d') { keys.push(ch); parts.push(''); continue }
      if (ch === '\x1b' && text[i + 1] === '[') {
        win32Key.lastIndex = i
        const m = win32Key.exec(text)
        if (m) {
          const [vk, , uc, kd, cs] = m.slice(1).map(Number)
          const key = uc === 28 || (uc === 0 && vk === 220 && cs & 0x0c) ? '\x1c' : uc === 29 || (uc === 0 && vk === 221 && cs & 0x0c) ? '\x1d' : ''
          if (key) {
            if (kd === 1) { keys.push(key); parts.push('') }
            i += m[0].length - 1
            continue
          }
          parts[parts.length - 1] += m[0]; i += m[0].length - 1
          continue
        }
        const tail = win32Prefix.exec(text.slice(i))
        if (tail) { held = tail[0]; break }
      }
      parts[parts.length - 1] += ch
    }
    return { parts, keys }
  }
  const forward = guard((data) => {
    clearTimeout(heldTimer)
    const incoming = typeof data === 'string' ? data : decoder.write(data)
    const text = held + incoming
    held = ''
    const { parts, keys } = tokenize(text)
    if (held) heldTimer = setTimeout(guard(() => { const rest = held; held = ''; if (rest) child.write(rest) }), 50)
    for (let i = 0; i < parts.length; i++) {
      if (i && keys[i - 1] === '\x1c') { expanded = !expanded; draw() }
      else if (i) {
        try {
          const live = readLive(cwd)
          const active = live?.runId && readLocks(cwd).some((lock) => lock.runId === live.runId && !lock.stale)
          if (!active && !(live?.result && Date.now() - Date.parse(live.updatedAt) < 10000)) throw new Error('No current run')
          writeHandoff(cwd); handoffNotice = 'Handoff saved; use $handoff for conversation context.'
        }
        catch { handoffNotice = 'Use $handoff in Codex to write conversation context.' }
        handoffNoticeUntil = Date.now() + 10000; draw()
      }
      if (parts[i]) child.write(parts[i])
    }
  })
  const stop = guard(() => child.kill())
  const onResize = guard(resize)
  const onInputError = (error) => rejectRun(error)
  const onOutputError = (error) => { outputFailed = true; rejectRun(error) }
  try {
    return await new Promise((resolve, reject) => {
      rejectRun = reject
      subscriptions.push(child.onExit((event) => { exited = true; resolve(event) }))
      subscriptions.push(child.onData(guard((data) => {
        // Do not insert HUD escapes inside a split CSI, OSC or control string.
        const text = pending + data
        const incomplete = /\x1b(?:\[[0-?]*[ -/]*|[ -/]*|[\]PX^_](?:(?!\x1b\\)[^\x07])*)$/.exec(text)
        pending = incomplete?.[0] ?? ''
        // ConPTY reports its smaller viewport as an xterm window resize request.
        const complete = pending ? text.slice(0, -pending.length) : text
        output.write(complete.replace(/\x1b\[8;\d+;\d+t/g, ''))
        draw()
      })))
      output.on('resize', onResize)
      output.on('error', onOutputError)
      input.on('data', forward)
      input.on('error', onInputError)
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
      input.setRawMode(true)
      input.resume()
      output.write(`\x1b[1;${dimensions.rows - rows}r`)
      draw()
      timer = setInterval(guard(draw), 500)
    })
  } finally {
    rmSync(marker, { force: true })
    if (timer) clearInterval(timer)
    clearTimeout(heldTimer)
    output.off('resize', onResize)
    output.off('error', onOutputError)
    input.off('data', forward)
    input.off('error', onInputError)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop)
    for (const subscription of subscriptions) subscription.dispose()
    try { if (!exited) child.kill() } finally {
      input.pause()
      try { input.setRawMode(wasRaw) } finally {
        if (!outputFailed) output.write(`\x1b[r${Array.from({ length: rows }, (_, i) => `\x1b[${dimensions.rows - i};1H\x1b[2K`).join('')}`)
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write('Usage: node scripts/codex-hud.mjs [--cwd <repo-root>] [-- <Codex arguments>]\nStarts a new Codex CLI session inside the model-ladder HUD. It cannot attach to an already-running Codex CLI.\n')
    else {
      const { exitCode } = await runHud(options)
      // Windows PTY worker threads can remain referenced after their child exits.
      process.stdout.write('', () => process.exit(exitCode))
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
