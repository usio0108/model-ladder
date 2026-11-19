// Passive telemetry: reads the existing .model-ladder/history.jsonl (Execution v2, fast path, legacy Codex and legacy
// Claude Workflow lines) and reports observed usage. It starts no model call and keeps no store of its own.
// Missing values stay UNKNOWN, never zero. Records copy only whitelisted fields: no task text, prompts, summaries,
// reasons or command output. Tokens are provider-reported counts; no money cost is computed or estimated.
//   node telemetry.mjs [--json]
import { pathToFileURL } from 'node:url'
import { history } from './forecast.mjs'
import { repoRoot } from './common.mjs'

const UNKNOWN = 'UNKNOWN'
const number = (value) => Number.isSafeInteger(value) && value >= 0
const plus = (a, b) => number(a) && number(b) ? a + b : UNKNOWN
// Same rule as usageEvidence: a stage is known only when every call reported every turn. No call means 0.
function measure(calls, keys = { input: 'input_tokens', output: 'output_tokens', cached: 'cached_input_tokens' }) {
  const sum = (key) => {
    if (!calls.length) return 0
    const turns = calls.flatMap(({ turns }) => turns ?? [])
    return calls.every((call) => call.turns?.length) && turns.every((turn) => number(turn[key])) ? turns.reduce((total, turn) => total + turn[key], 0) : UNKNOWN
  }
  return { calls: calls.length, inputTokens: sum(keys.input), outputTokens: sum(keys.output), cachedInputTokens: sum(keys.cached) }
}
// usageEvidence reports an uncalled stage as UNKNOWN; for the report an observed absence of calls is zero tokens.
const stage = (value) => value && value.calls === 0 ? { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } : value ?? { calls: UNKNOWN, inputTokens: UNKNOWN, outputTokens: UNKNOWN, cachedInputTokens: UNKNOWN }

function quota(forecast) {
  const start = forecast?.usageStart?.windows ?? {}, end = forecast?.usageEnd?.windows ?? {}
  // Subscription percentage points between two samples; other activity on the account can be included.
  return Object.fromEntries(Object.keys(start).filter((key) => typeof start[key]?.used === 'number' && typeof end[key]?.used === 'number')
    .map((key) => [key, end[key].used - start[key].used]))
}

export function telemetryRecord(entry) {
  const v2 = Boolean(entry.contract && entry.telemetry)
  const usage = Array.isArray(entry.usage) ? entry.usage : []
  const attempts = number(entry.telemetry?.attempts) ? entry.telemetry.attempts : Array.isArray(entry.attempts) ? entry.attempts.length : UNKNOWN
  let stages, path
  if (v2) {
    path = entry.path === 'FAST' ? 'FAST' : 'V2'
    const t = entry.telemetry
    stages = { total: stage(t.total), router: stage(t.router), worker: stage(t.worker), reviewer: stage(t.verifier), retry: stage(t.retry) }
  } else if (usage.length || entry.runtime === 'codex') {
    path = 'LEGACY_CODEX'
    // Each failed attempt is followed by a diagnosis call; that call and everything after it is retry overhead.
    const firstRetry = usage.findIndex(({ phase }) => phase === 'diagnose')
    stages = { total: measure(usage), router: measure(usage.filter(({ phase }) => ['route', 'diagnose'].includes(phase))), worker: measure(usage.filter(({ phase }) => phase === 'worker')),
      reviewer: measure(usage.filter(({ phase }) => phase === 'verify')), retry: measure(firstRetry < 0 ? [] : usage.slice(firstRetry)) }
  } else {
    path = 'LEGACY_CLAUDE'
    // The Workflow reports output tokens only. Older lines wrote 0 when the result had none.
    const phases = (entry.forecast?.phases ?? []).filter((p) => p.provenance === 'host-workflow-boundary')
    const out = (list) => list.every((p) => number(p.tokens)) ? list.reduce((total, p) => total + p.tokens, 0) : UNKNOWN
    const known = (list) => ({ calls: list.length, inputTokens: list.length ? UNKNOWN : 0, outputTokens: out(list), cachedInputTokens: list.length ? UNKNOWN : 0 })
    const ran = attempts !== 0 || phases.length
    const totalOut = number(entry.tokens) && !(entry.tokens === 0 && ran) ? entry.tokens : ran ? UNKNOWN : 0
    stages = phases.length
      ? { total: { ...known(phases), outputTokens: totalOut }, router: known(phases.filter((p) => ['route', 'diagnose'].includes(p.phase))), worker: known(phases.filter((p) => ['worker', 'test-writer'].includes(p.phase))),
        reviewer: known(phases.filter((p) => p.phase === 'verify')), retry: { calls: UNKNOWN, inputTokens: UNKNOWN, outputTokens: UNKNOWN, cachedInputTokens: UNKNOWN } }
      : { total: { calls: ran ? UNKNOWN : 0, inputTokens: ran ? UNKNOWN : 0, outputTokens: totalOut, cachedInputTokens: ran ? UNKNOWN : 0 }, router: stage(), worker: stage(), reviewer: stage(), retry: stage() }
  }
  const observedModels = [...new Set(usage.flatMap(({ models }) => Array.isArray(models) ? models : []))]
  const configured = [...new Set([...usage.map(({ cell }) => cell), ...(entry.attempts ?? []).map(({ cell }) => cell)].filter((cell) => typeof cell === 'string' && cell !== 'session'))]
  const last = entry.attempts?.at?.(-1)
  return {
    taskId: entry.contract?.id ?? entry.runId ?? null,
    runId: entry.runId ?? null,
    date: entry.date ?? null,
    backend: entry.runtime ?? entry.contract?.backend ?? UNKNOWN,
    path,
    profile: entry.contract?.profile ?? 'LEGACY',
    models: observedModels.length ? { source: 'observed', ids: observedModels } : configured.length ? { source: 'configured', ids: configured } : { source: UNKNOWN, ids: [] },
    status: entry.status ?? UNKNOWN,
    attempts,
    agentCalls: stages.total.calls,
    tokens: stages,
    durationMs: number(entry.telemetry?.durationMs) ? entry.telemetry.durationMs : number(entry.forecast?.actual?.durationMs) ? entry.forecast.actual.durationMs : UNKNOWN,
    verification: (entry.evidence ?? last?.evidence)?.command?.status ?? (entry.status === 'VERIFIED' ? 'PASSED' : UNKNOWN),
    delivery: entry.delivery ?? { status: [entry.applied, entry.outcome?.applied].includes(true) ? 'LOCAL_APPLIED' : [entry.applied, entry.outcome?.applied].includes(false) || entry.status !== 'VERIFIED' ? 'NOT_APPLIED' : UNKNOWN, ci: 'UNVERIFIED' },
    evidenceRefs: entry.contract?.evidenceRefs ?? [],
    // Billing mode (API key or subscription) is not observable from history; subscription samples are reported separately.
    billing: UNKNOWN,
    subscriptionDelta: quota(entry.forecast),
  }
}

// Statuses that ask the person something or never started work; they are neither a success nor a failure.
const NOT_RUN = ['NEEDS_INPUT', 'DIRTY', 'STALE_RUN', 'ABORTED', 'NOT_ELIGIBLE']
const failed = (r) => r.status !== 'VERIFIED' && !NOT_RUN.includes(r.status)

// A fast-path run writes one line per check; its last line carries the run's outcome and attempt count.
export function latestPerRun(records) {
  const last = new Map()
  records.forEach((r, index) => last.set(r.runId ?? `line-${index}`, r))
  return [...last.values()]
}

export function summarize(records) {
  const byProfile = {}
  for (const r of records) {
    const row = byProfile[r.profile] ??= { runs: 0, verified: 0, failed: 0 }
    row.runs++
    if (r.status === 'VERIFIED') row.verified++
    else if (failed(r)) row.failed++
  }
  for (const row of Object.values(byProfile)) row.failureRate = row.runs ? Number((row.failed / row.runs).toFixed(3)) : 0
  const share = (key) => {
    const known = records.filter((r) => number(r.tokens.reviewer[key]) && number(r.tokens.total[key]))
    const total = known.reduce((sum, r) => sum + r.tokens.total[key], 0)
    return { share: total ? Number((known.reduce((sum, r) => sum + r.tokens.reviewer[key], 0) / total).toFixed(3)) : UNKNOWN, runs: known.length, excluded: records.length - known.length }
  }
  const perVerified = (key) => {
    const verified = records.filter((r) => r.status === 'VERIFIED')
    const known = verified.filter((r) => number(r.tokens.total[key]))
    return { mean: known.length ? Math.round(known.reduce((sum, r) => sum + r.tokens.total[key], 0) / known.length) : UNKNOWN, runs: known.length, excluded: verified.length - known.length }
  }
  const failures = {}
  for (const r of records) if (failed(r)) failures[`${r.path}:${r.status}`] = (failures[`${r.path}:${r.status}`] ?? 0) + 1
  return {
    provenance: 'observed provider token counts from history; no estimates',
    runs: records.length,
    byProfile,
    mostUsedProfile: Object.entries(byProfile).sort((a, b) => b[1].runs - a[1].runs)[0]?.[0] ?? null,
    retried: records.filter((r) => number(r.attempts) && r.attempts > 1).map(({ taskId, path, attempts, status }) => ({ taskId, path, attempts, status })),
    reviewerShare: { inputTokens: share('inputTokens'), outputTokens: share('outputTokens') },
    tokensPerVerified: { inputTokens: perVerified('inputTokens'), outputTokens: perVerified('outputTokens') },
    failures,
    routerCalls: records.reduce((sum, r) => sum + (number(r.tokens.router.calls) ? r.tokens.router.calls : 0), 0),
    reviewerCalls: records.reduce((sum, r) => sum + (number(r.tokens.reviewer.calls) ? r.tokens.reviewer.calls : 0), 0),
  }
}

export function report(root) {
  const records = latestPerRun(history(root).map(telemetryRecord))
  return { records, summary: summarize(records) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { records, summary } = report(repoRoot())
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ summary, records }, null, 2)}\n`)
  else {
    const fmt = (m) => `${m.mean} (n=${m.runs}, unknown=${m.excluded})`
    process.stdout.write([
      `model-ladder telemetry: ${summary.runs} runs (${summary.provenance})`,
      `Profiles: ${Object.entries(summary.byProfile).map(([p, r]) => `${p} ${r.runs} (verified ${r.verified}, failed ${r.failed})`).join('; ')}`,
      `Most used profile: ${summary.mostUsedProfile}`,
      `Retried runs: ${summary.retried.length}`,
      `Reviewer share: input ${summary.reviewerShare.inputTokens.share}, output ${summary.reviewerShare.outputTokens.share}`,
      `Tokens per VERIFIED: input ${fmt(summary.tokensPerVerified.inputTokens)}, output ${fmt(summary.tokensPerVerified.outputTokens)}`,
      `Router calls ${summary.routerCalls}, reviewer calls ${summary.reviewerCalls}`,
      `Failures: ${Object.entries(summary.failures).map(([k, n]) => `${k} ${n}`).join('; ') || 'none'}`,
    ].join('\n') + '\n')
  }
}
