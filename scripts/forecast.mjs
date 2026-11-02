// Node owns clocks and files. The workflow uses the same generated pure estimators.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { atomicJson } from './codex-live.mjs'
import { artifactDir, repoRoot } from './common.mjs'
import { createLock, lockPath, withMutex } from './runs.mjs'
import { readCodexUsage } from './codex-usage.mjs'
import { projectUsageFile, usageFile } from './usage-statusline.mjs'
import { claudeGuard } from './usage-guard.mjs'
import { durationForecast, remainingForecast, assessUsage, calibrationError } from './ladder-rules.mjs'

export function history(root) {
  try { return readFileSync(join(root, '.model-ladder/history.jsonl'), 'utf8').split('\n').flatMap((s) => { try { return [JSON.parse(s)] } catch { return [] } }) } catch { return [] }
}

export function usageSnapshot(root, runtime, now = Date.now()) {
  if (runtime === 'codex') return readCodexUsage(undefined, now / 1000, { evidence: true })
  for (const file of [projectUsageFile(root), usageFile()]) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (!(data.updatedAt * 1000 <= now && now - data.updatedAt * 1000 <= 900000)) continue
      return { sampledAt: data.updatedAt * 1000, source: file, windows: Object.fromEntries(Object.entries(data).filter(([, w]) => typeof w?.used_percentage === 'number').map(([key, w]) => [key, { used: w.used_percentage, resetsAt: w.resets_at * 1000 || null }])) }
    } catch {}
  }
  return { sampledAt: null, windows: {}, reason: 'No fresh subscription sample' }
}

export function startForecast(root, runtime, config, now = Date.now()) {
  return { version: 1, runtime, startedAt: now, config: { router: config.router, verifier: config.verifier, maxAttempts: config.maxAttempts }, original: null, current: null, phases: [], updates: [], usageStart: usageSnapshot(root, runtime, now) }
}

export function routeForecast(state, route, verify, rows, now = Date.now()) {
  if (state.original) return
  const chosen = route.start ?? { model: route.model, effort: route.effort }
  const start = typeof chosen === 'string' ? { model: chosen.split('/')[0], effort: chosen.split('/')[1] } : chosen
  state.key = JSON.stringify({ runtime: state.runtime, ...state.config, start, verify, continuation: state.continuation ?? null, routerMinutes: route.estimatedMinutes, readOnly: route.readOnly === true, allowTests: route.allowTests === true })
  state.routerMinutes = route.estimatedMinutes
  state.original = { ...durationForecast(state.key, route, rows, now), issuedAt: now }
  if (state.continuation && !state.original.sampleCount) state.original = { optimistic: null, mostLikely: null, pessimistic: null, unit: 'ms', sampleCount: 0, issuedAt: now, provenance: 'insufficient-data', reason: 'No comparable completed continuation; the earlier full-run forecast is retained in previousOriginal' }
}

export function updateForecast(root, state, rows, guard, boundary, now = Date.now(), usage = usageSnapshot(root, state.runtime, now)) {
  const remaining = remainingForecast(state, rows, now)
  state.current = { boundary, at: now, elapsedMs: now - state.startedAt,
    remaining, observation: usage,
    usage: assessUsage(state.key, rows, usage, guard, now, remaining) }
  state.updates.push(state.current)
  // Samples are observations, never proof that other account activity was absent.
  state.usageEnd = usage
  return state.current
}

export function finishForecast(root, state, rows, guard, status, now = Date.now()) {
  updateForecast(root, state, rows, guard, 'finish', now)
  const completed = ['VERIFIED', 'FAILED'].includes(status) && !state.openBoundary
  state.actual = { status, completed, censored: !completed, durationMs: now - state.startedAt, endedAt: now }
  state.error = status === 'VERIFIED' && completed ? calibrationError(state.original, state.actual.durationMs) : null
  if (completed) state.current.remaining = { optimistic: 0, mostLikely: 0, pessimistic: 0, unit: 'ms', provenance: 'completed', sampleCount: 0 }
  return state
}

// Per-agent expected durations for the time column, from the phases earlier runs recorded in forecast.phases.
// Samples are the same successful runs the run-level forecast calibrates on (VERIFIED, completed, uncensored, recent),
// of this runtime. A phase+model+effort entry needs MIN_CELL_SAMPLES complete phases; phase alone is the fallback.
// Shape (read by agentExpected in hooks/band/rows.mjs): { cells: { 'worker/haiku/low': ms }, phases: { worker: ms } }.
const MIN_CELL_SAMPLES = 2
const EXPECTED_MAX_AGE = 90 * 86400000
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
export function agentExpectations(rows, runtime, now = Date.now()) {
  const byCell = new Map(), byPhase = new Map()
  const add = (map, key, ms) => map.set(key, [...(map.get(key) ?? []), ms])
  for (const f of rows.map((r) => r?.forecast)) {
    if (f?.version !== 1 || f.runtime !== runtime || f.actual?.status !== 'VERIFIED' || f.actual.completed !== true || f.actual.censored !== false ||
      !Number.isFinite(f.actual.endedAt) || f.actual.endedAt > now || now - f.actual.endedAt > EXPECTED_MAX_AGE) continue
    for (const p of Array.isArray(f.phases) ? f.phases : []) {
      if (typeof p?.phase !== 'string' || p.complete !== true || !Number.isFinite(p.durationMs) || p.durationMs <= 0) continue
      add(byCell, `${p.phase}/${p.model}/${p.effort}`, p.durationMs)
      add(byPhase, p.phase, p.durationMs)
    }
  }
  return {
    cells: Object.fromEntries([...byCell].filter(([, v]) => v.length >= MIN_CELL_SAMPLES).map(([k, v]) => [k, median(v)])),
    phases: Object.fromEntries([...byPhase].map(([k, v]) => [k, median(v)])),
  }
}

// The band's run lock carries the run's forecast total (the no-model row) and each agent's expected duration, so
// the band reads both live as the run goes. It is written at every boundary start too: the router spawns inside the
// first call, before any forecast total exists.
function lockExpected(root, runId, forecast, now) {
  const expectedMs = forecast.original?.mostLikely
  const phaseExpected = agentExpectations(history(root), forecast.runtime, now)
  withMutex(root, 'registry', () => {
    let lock
    try { lock = JSON.parse(readFileSync(lockPath(root, runId), 'utf8')) } catch { return }
    const next = { ...lock, phaseExpected, ...(Number.isFinite(expectedMs) && expectedMs > 0 && { expectedMs }) }
    if (!isDeepStrictEqual(next, lock)) createLock(root, next)
  })
}

// Claude's host invokes this around each workflow call. One call executes at most one
// agent; replaying its structured journal does not call a model or read a clock.
export function claudeBoundary(root, input, now = Date.now()) {
  if (!/^claude-[\w-]+$/.test(input.runId ?? '')) throw new Error('A Claude runId from preflight is required')
  const path = join(artifactDir(root), input.runId, 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const forecast = state.forecast
  if (!forecast) throw new Error('Preflight forecast state is missing')
  if (input.event === 'start') {
    if (Number.isFinite(state.pendingBoundary)) throw new Error('Previous workflow boundary has not ended')
    state.pendingBoundary = now
    lockExpected(root, input.runId, forecast, now)
  } else if (input.event === 'end') {
    if (!Number.isFinite(state.pendingBoundary)) throw new Error('No workflow boundary start')
    if (now < state.pendingBoundary) throw new Error('Clock moved backwards; phase timing is unavailable')
    const result = input.result
    if (!result || !Array.isArray(result.journal)) throw new Error('Pass the workflow result unchanged')
    const previous = state.journal ?? []
    if (!isDeepStrictEqual(result.journal.slice(0, previous.length), previous)) throw new Error('Workflow journal prefix changed')
    const fresh = result.journal.slice(previous.length)
    if (fresh.length > 1) throw new Error('Expected at most one new agent at a boundary')
    if (fresh.some((entry) => typeof entry?.phase !== 'string' || typeof entry.model !== 'string' || typeof entry.effort !== 'string' || !Number.isFinite(entry.measurement?.tokens) || entry.measurement.tokens < 0)) throw new Error('Invalid workflow measurement')
    for (const entry of fresh) forecast.phases.push({ phase: entry.phase, model: entry.model, effort: entry.effort, tokens: entry.measurement.tokens, startedAt: state.pendingBoundary, endedAt: now, elapsedMs: now - forecast.startedAt, durationMs: now - state.pendingBoundary, provenance: 'host-workflow-boundary', complete: !entry.measurement.error, pass: !entry.measurement.error && (entry.measurement.result?.pass ?? entry.measurement.result?.status !== 'blocked') })
    state.journal = result.journal
    delete state.pendingBoundary
    if (result.plan?.estimatedMinutes !== undefined) routeForecast(forecast, result.plan, result.plan.verify, history(root), now)
    updateForecast(root, forecast, history(root), claudeGuard(root), fresh.at(-1)?.phase ?? result.status, now)
    lockExpected(root, input.runId, forecast, now)
  } else throw new Error('event must be start or end')
  atomicJson(path, state)
  return { forecast }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(claudeBoundary(repoRoot(), JSON.parse(readFileSync(0, 'utf8'))))) }
  catch (e) { console.error(e.message); process.exitCode = 1 }
}
