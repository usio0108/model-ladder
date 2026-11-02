// Pure row-list updates for the band. Rows from several workflow runs live in one list, each tagged with its run id.

export const addRow = (list, row) => [...list, row]

// A finished row keeps its elapsed time and its expected duration as they were when it finished.
export const finishRow = (list, id, ms, expectedMs = null) => list.map((r) => (r.id === id ? { ...r, status: 'done', ms, expectedMs } : r))

export const removeRow = (list, id) => list.filter((r) => r.id !== id)

export const anyRunning = (list) => list.some((r) => r.status === 'running')

export const runCount = (list) => new Set(list.map((r) => r.run)).size

// A worker spawned after its own run's verifier is a redispatch; other runs' verifiers do not count.
export const isRedo = (verified, run, isWorker) => isWorker && verified.has(run)

// One agent's expected duration in ms from an expectations table (scripts/forecast.mjs agentExpectations):
// its phase+model+effort entry, else its phase alone; null when there are no samples or no usable table.
export const agentExpected = (table, phase, model, effort) => {
  const ms = table?.cells?.[`${phase}/${model}/${effort}`] ?? table?.phases?.[phase]
  return Number.isFinite(ms) && ms > 0 ? ms : null
}
