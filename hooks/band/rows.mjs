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

// Each task also records the user question it belongs to ({ question, answered }); a task-notification is not a question.
// A task is hidden (answered: true) once its question's turn gave a final answer that is not waiting for its result; it
// stays in the list, so its end notification still removes it and records its duration.
// Heuristic and limits: the plugin runtime gives turn.complete only the turn's last reply text (answer), with no flag for
// "Claude is waiting on a task". So a reply counts as waiting when it is empty or unreadable, or mentions waiting, a
// background run or a later notification (English or Chinese keywords below). Anything uncertain is shown. A final answer
// that happens to use those words keeps its rows visible until the task ends; a wait phrased in other words is hidden.
const WAITING = /wait|pending|in progress|in the background|background|still running|running|notif|will (let you know|report|check|get back)|once (it|they) (finish|complete)|等|稍後|稍后|背景|後台|后台|通知|進行中|进行中|執行中|执行中|完成後|完成后/i
export const isWaitingAnswer = (answer) => typeof answer !== 'string' || !answer.trim() || WAITING.test(answer)

// Sets answered on every task of one question.
export const markAnswered = (list, question, answered) => list.map((t) => (t.question === question && Boolean(t.answered) !== answered ? { ...t, answered } : t))

// They show only for work the screen does not otherwise show: not while the main session runs a turn, and not while a
// ladder agent runs; and not for a task whose question already has its final answer.
export const backgroundRows = (list, isWorking, anyAgentRunning) => (isWorking || anyAgentRunning ? [] : list.filter((t) => !t.answered))

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

// The raw past durations behind one agent's expectation: its phase+model+effort samples, else its phase's; [] when none.
export const agentSamples = (table, phase, model, effort) => {
  if (!EXPECTED_PHASES.includes(phase)) return []
  const list = table?.samples?.[`${phase}/${model}/${effort}`] ?? table?.samples?.[phase]
  return Array.isArray(list) ? list.filter((ms) => Number.isFinite(ms) && ms > 0) : []
}

// A running row's expected duration as { ms, approx }, recalibrated once the agent overruns it. While elapsed is below
// the expected value it is shown as is. Once over, the median of at least 2 past runs (samples, from agentSamples) that
// took longer than elapsed is used; with fewer it grows in steps of max(1 minute, half the expected value) to the first
// value above elapsed (approx: true), so the denominator jumps in steps and never changes every second.
// null when the expected value is null or invalid.
export const liveExpected = (elapsedMs, expectedMs, samples = []) => {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) return null
  if (!(elapsedMs >= expectedMs)) return { ms: expectedMs, approx: false }
  const longer = (Array.isArray(samples) ? samples : []).filter((ms) => Number.isFinite(ms) && ms > elapsedMs).sort((a, b) => a - b)
  if (longer.length >= 2) return { ms: longer[Math.floor(longer.length / 2)], approx: false }
  const step = Math.max(60000, expectedMs / 2)
  return { ms: expectedMs + (Math.floor((elapsedMs - expectedMs) / step) + 1) * step, approx: true }
}

// Past durations of background shell commands, keyed by the command's first line: the newest ten per key.
export const recordDuration = (history, key, ms, keep = 10) => {
  if (!key || !Number.isFinite(ms) || ms <= 0) return history
  const past = Array.isArray(history?.[key]) ? history[key] : []
  return { ...history, [key]: [...past, ms].slice(-keep) }
}

// The median of past durations, or null without any.
export const medianDuration = (samples) => {
  const list = (Array.isArray(samples) ? samples : []).filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b)
  return list.length ? list[Math.floor(list.length / 2)] : null
}

// What an agent is doing now, from its messages ($.session.messages({ agentId })): the newest assistant message's
// last tool use as "<Tool>: <short detail>". null when nothing readable.
export const activityText = (messages) => {
  if (!Array.isArray(messages)) return null
  const use = messages.filter((m) => m?.role === 'assistant' && Array.isArray(m.toolUses) && m.toolUses.length).at(-1)?.toolUses.at(-1)
  if (typeof use?.tool !== 'string' || !use.tool) return null
  const input = use.input && typeof use.input === 'object' ? use.input : {}
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const base = (p) => str(p)?.split(/[\\/]/).filter(Boolean).at(-1) ?? null
  const first = (v) => str(v)?.split('\n')[0].trim() ?? null
  const detail = use.tool === 'Bash' ? str(input.description) ?? first(input.command)
    : ['Read', 'Edit', 'Write'].includes(use.tool) ? base(input.file_path ?? input.path)
    : ['Grep', 'Glob'].includes(use.tool) ? str(input.pattern)
    : null
  return detail ? `${use.tool}: ${detail}` : use.tool
}
