// Bench statistics. Missing values stay UNKNOWN, never zero (same rule as scripts/telemetry.mjs).
export const UNKNOWN = 'UNKNOWN'
const num = (v) => typeof v === 'number' && Number.isFinite(v)
const sum = (list) => list.length ? list.reduce((a, b) => a + b, 0) : UNKNOWN

export const fmtCost = (c) => num(c) ? c.toFixed(2) : UNKNOWN
export const fmtTokens = (t) => num(t) ? String(t) : UNKNOWN

export function summarize(rows) {
  const costs = rows.filter((r) => num(r.cost))
  const tokens = rows.filter((r) => num(r.outputTokens))
  const cost = sum(costs.map((r) => r.cost))
  const solvedKnown = costs.filter((r) => r.solved).length
  return {
    solved: rows.filter((r) => r.solved).length,
    rows: rows.length,
    cost,
    perSolved: solvedKnown ? cost / solvedKnown : UNKNOWN,
    tokens: sum(tokens.map((r) => r.outputTokens)),
    secs: rows.reduce((s, r) => s + (r.seconds ?? 0), 0),
    costExcluded: rows.length - costs.length,
    tokensExcluded: rows.length - tokens.length,
  }
}
