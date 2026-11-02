// Pure row-list updates for the band. Rows from several workflow runs live in one list, each tagged with its run id.

export const addRow = (list, row) => [...list, row]

// A finished row keeps its elapsed time and its expected duration as they were when it finished.
export const finishRow = (list, id, ms, expectedMs = null) => list.map((r) => (r.id === id ? { ...r, status: 'done', ms, expectedMs } : r))

export const removeRow = (list, id) => list.filter((r) => r.id !== id)

export const anyRunning = (list) => list.some((r) => r.status === 'running')

export const runCount = (list) => new Set(list.map((r) => r.run)).size

// A worker spawned after its own run's verifier is a redispatch; other runs' verifiers do not count.
export const isRedo = (verified, run, isWorker) => isWorker && verified.has(run)

// Background tasks of this session (Bash background calls, async Workflow launches): { id, kind, label, startedAt }.
// A duplicate id is ignored.
export const addBackground = (list, task) => (list.some((t) => t.id === task.id) ? list : [...list, task])

export const removeBackground = (list, ids) => list.filter((t) => !ids.includes(t.id))

// They show only for work the screen does not otherwise show: not while the main session runs a turn, and not while a ladder agent runs.
export const backgroundRows = (list, isWorking, anyAgentRunning) => (isWorking || anyAgentRunning ? [] : list)

// Only these agents show an expected duration; router, diagnose and final-diagnosis rows show elapsed only.
export const EXPECTED_PHASES = ['worker', 'test-writer', 'verify']

// One agent's expected duration in ms from an expectations table (scripts/forecast.mjs agentExpectations):
// its phase+model+effort entry, else its phase alone; null for a phase outside EXPECTED_PHASES, or when there are
// no samples or no usable table.
export const agentExpected = (table, phase, model, effort) => {
  if (!EXPECTED_PHASES.includes(phase)) return null
  const ms = table?.cells?.[`${phase}/${model}/${effort}`] ?? table?.phases?.[phase]
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

// A running row's expected duration, recalibrated once the agent overruns it: the expected value while elapsed is
// below it, else it grows in steps of max(1 minute, half the expected value) to the first value above elapsed, so
// the denominator jumps in steps and never changes every second. null when the expected value is null or invalid.
export const liveExpected = (elapsedMs, expectedMs) => {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) return null
  if (!(elapsedMs >= expectedMs)) return expectedMs
  const step = Math.max(60000, expectedMs / 2)
  return expectedMs + (Math.floor((elapsedMs - expectedMs) / step) + 1) * step
}
