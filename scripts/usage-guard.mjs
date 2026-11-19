// Claude Code usage guard, read live: the settings as they are now (user file, then project file) and the
// subscription usage now. preflight calls it before a run; the workflow's verifier runs it after every attempt
// (`node usage-guard.mjs --root <repo>`), so turning the guard off or on, or changing the threshold, mid-run
// counts at the next check. Prints one JSON line: {"enabled":true,"threshold":90,"usage":42}
// usage is null when unknown; "error" is set when the settings cannot be read. Only enabled with a known usage at
// or above the threshold stops a run. usageGuard stays one personal setting shared by every project.
//
// Over the limit, Codex runners stop live: forceStopRuns() kills every other registered model-ladder runner on this
// machine (with its Codex child processes) and writes that repository's .model-ladder/HANDOFF.md. Runners register
// in one machine-wide directory (activeDir) while they run. `--enforce` does the same from the command line when the
// guard says stop, and adds the stopped run IDs: {"enabled":true,"threshold":90,"usage":95,"stopped":["codex-..."]}
// Claude Code agents are not killed mid-call: a Claude run stops at its next check (preflight, or the verifier after
// an attempt), and the band (hooks/band/register.tsx) asks the main session for an AI-written handoff as soon as a
// usage window reaches the threshold.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GUARD_DEFAULT } from '../hooks/config-layers.mjs'
import { writeHandoff } from './codex-handoff.mjs'
import { loadLayered } from './config.mjs'
import { killWindowsTree } from './process-tree.mjs'
import { alive, releaseLock } from './runs.mjs'
import { projectUsageFile, readClaudeUsage } from './usage-statusline.mjs'

export function claudeGuard(root) {
  let guard
  try {
    guard = loadLayered(root, 'claude', { usageGuard: GUARD_DEFAULT }).usageGuard
  } catch (e) {
    return { enabled: false, threshold: null, usage: null, error: e.message }
  }
  const usage = guard.enabled === true ? readClaudeUsage(projectUsageFile(root)) ?? readClaudeUsage() : null
  return { enabled: guard.enabled === true, threshold: guard.threshold, usage }
}

export const guardStops = (state) => state.enabled && typeof state.usage === 'number' && typeof state.threshold === 'number' && state.usage >= state.threshold

// Machine-wide, not per repository: one entry per running runner process, { runId, pid, root, runtime }.
export const activeDir = () => process.env.MODEL_LADDER_ACTIVE_DIR ?? join(tmpdir(), 'model-ladder', 'active')
const entryPath = (runId) => join(activeDir(), `${runId}.json`)

export function registerRun(entry) {
  mkdirSync(activeDir(), { recursive: true })
  writeFileSync(entryPath(entry.runId), JSON.stringify(entry))
}

export function unregisterRun(runId) {
  rmSync(entryPath(runId), { force: true })
}

// Registered runs whose process is still alive; entries of dead processes are removed.
export function activeRuns() {
  let names
  try { names = readdirSync(activeDir()).filter((name) => name.endsWith('.json')) } catch { return [] }
  return names.flatMap((name) => {
    const path = join(activeDir(), name)
    let entry
    try { entry = JSON.parse(readFileSync(path, 'utf8')) } catch { return [] }
    if (entry.terminationFailed) return []
    const running = alive(entry?.pid)
    if (running === false && !entry.stopRequested) rmSync(path, { force: true })
    if (running !== true) return []
    return [entry]
  })
}

// On POSIX the runner owns detached child groups. It acknowledges shutdown by removing its registration.
function stopRegisteredRun(entry) {
  if (process.platform === 'win32') return killWindowsTree(entry.pid)
  registerRun({ ...entry, stopRequested: true })
  process.kill(entry.pid, 'SIGTERM')
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 5000
  do {
    try { readFileSync(entryPath(entry.runId)) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    Atomics.wait(wait, 0, 0, 50)
  } while (Date.now() < deadline)
  throw new Error('Runner did not acknowledge tree termination after SIGTERM')
}

// Stops every registered run except `exclude` (and this process) and writes each stopped run's HANDOFF.md with
// `handoff(root, { stopped: reason })` (default: the handoff from that repository's live.json). Returns the run IDs
// it stopped.
export function forceStopRuns({ exclude = null, reason = 'Force-stopped: usage reached the usageGuard threshold.', handoff = writeHandoff, terminate = stopRegisteredRun, onFailure } = {}) {
  const stopped = []
  for (const entry of activeRuns()) {
    if (entry.runId === exclude || entry.pid === process.pid) continue
    try { terminate(entry) }
    catch (error) {
      const message = `Could not stop run ${entry.runId} (PID ${entry.pid}): ${error.message}. Active registration retained; no stopped handoff was written.`
      process.stderr.write(`model-ladder: ${message}\n`)
      onFailure?.({ runId: entry.runId, pid: entry.pid, message })
      continue
    }
    unregisterRun(entry.runId)
    if (typeof entry.root === 'string') {
      try { handoff(entry.root, { stopped: reason, runId: entry.runId }) } catch {}
      // Killed outright on Windows, so its own cleanup never runs; its lock would only look stale.
      if (process.platform === 'win32' && typeof entry.runId === 'string') releaseLock(entry.root, entry.runId)
    }
    stopped.push(entry.runId)
  }
  return stopped
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--root')
  const state = claudeGuard(at > 0 ? process.argv[at + 1] : process.cwd())
  if (process.argv.includes('--enforce') && guardStops(state)) {
    const failures = []
    state.stopped = forceStopRuns({ onFailure: (failure) => failures.push(failure) })
    if (failures.length) state.terminationFailures = failures
  }
  console.log(JSON.stringify(state))
}
