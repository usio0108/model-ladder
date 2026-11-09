import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Background, Row } from './types'
import { roundSpan } from './remaining.mjs'
import { formatContext } from './context.mjs'
import { activityText, addBackground, isWaitingAnswer, markAnswered, medianDuration, recordDuration, addRow, agentExpected, agentSamples, anyRunning, backgroundRows, finishRow, isRedo, liveExpected, removeBackground, removeRow, runCount } from './rows.mjs'
import { GUARD_DEFAULT, mergeConfig, parseThreshold, pluginLayer, projectPins, projectSkills, setGuard, userConfigPath } from '../config-layers.mjs'

const rows = atom({ plugin: 'model-ladder', key: 'rows' } as const, [])
// In-flight background tasks of this session (Bash background calls, async Workflow launches), shown while nothing else is.
// The $.store key for past background-command durations (rows.mjs recordDuration), kept across sessions.
const DURATIONS = 'backgroundDurations'
const background = atom({ plugin: 'model-ladder', key: 'background' } as const, [] as Background[])
const isFolded = atom({ plugin: 'model-ladder', key: 'isFolded' } as const, false)
const areSkillsFolded = atom({ plugin: 'model-ladder', key: 'areSkillsFolded' } as const, true)
// Latest context window usage from session.measure as shown text ("ctx 35k/1M"); empty when unknown.
const contextText = atom({ plugin: 'model-ladder', key: 'contextText' } as const, '')


type Config = { usageGuard?: { enabled?: boolean; threshold?: number }; worker_skills?: unknown; verifier_skills?: unknown; [key: string]: unknown }

// Layers as in hooks/config-layers.mjs: defaults, the user's ~/.claude/model-ladder.json (plus the plugin's skill
// options), then the project's .claude/model-ladder.json. The band writes only the user's file, and only on a press.
const BAND_DEFAULTS = { usageGuard: GUARD_DEFAULT, worker_skills: '', verifier_skills: '' }
const projectPath = async ($: EngineInterface) => `${await $.session.cwd()}/.claude/model-ladder.json`
const userPath = async ($: EngineInterface) => userConfigPath('claude', {
  MODEL_LADDER_USER_CONFIG: await $.env.get('MODEL_LADDER_USER_CONFIG'),
  CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
}, (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~')
async function readJson($: EngineInterface, path: string): Promise<Config> {
  try { return JSON.parse(await $.fs.read(path)) } catch { return {} }
}
async function editUserConfig($: EngineInterface, edit: (c: Config) => Config) {
  const path = await userPath($)
  let text: string | null = null
  try { text = await $.fs.read(path) } catch { /* no file yet */ }
  let current: Config = {}
  try { current = text === null ? {} : JSON.parse(text) } catch {
    // Never overwrite a file the person is in the middle of editing by hand.
    return $.ui.toast(`model-ladder: ${path} is not valid JSON; fix it, then try again`)
  }
  await $.fs.write(path, `${JSON.stringify(edit(current), null, 2)}\n`)
  $.ui.invalidate('ui.render')
}

// The ladder's prompts carry the user's task on the line after a TASK header.
const taskOf = (prompt: string, fallback: string) => (prompt.match(/TASK[^\n]*\n\s*([^\n]+)/)?.[1] ?? fallback).trim()
const projectName = (root: string | undefined, cwd: string) => (root || cwd).replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || cwd
const instructionLine = (project: string, line: string) => {
  const text = line.trim()
  const compact = text.match(/^([\w.@:-]+)\s+\/\s+(.+)$/)
  const legacy = text.match(/^use\s+(\S+)\s+when\s+(.+)$/i)
  return `${project}: ${compact ? `${compact[1]} / ${compact[2]}` : legacy ? `${legacy[1]} / ${legacy[2]}` : line}`
}
const formatInstructions = (project: string, text: string) => text.split('\n').map((line) => line.trim() ? instructionLine(project, line) : '').join('\n')
// claude-haiku-5-5 -> haiku-5.5; an alias such as haiku stays as is.
const modelName = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')
// Largest unit only, floored: 42s, 5m, 4h, 3d.
const span = (ms: number) => (ms < 60000 ? `${Math.floor(ms / 1000)}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : ms < 86400000 ? `${Math.floor(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`)
const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))
const DONE_MS = 10000
const LONG_MS = 10 * 60 * 1000
const SETTLE_MS = 5000
// Cuts text to a width in cells, counting CJK and other wide characters as two.
const clip = (text: string, cols: number) => {
  let out = '', used = 0
  for (const ch of text) {
    const w = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
    if (used + w > cols - 1) return `${out}…`
    out += ch; used += w
  }
  return out
}
const WINDOW: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
// Time until a window resets, rounded to its largest unit: "54m", "2h" or "3d"; empty when unknown or already past.
const remaining = (resetsAt: string | null | undefined, now: number) => {
  const ms = Date.parse(resetsAt ?? '') - now
  return ms > 0 ? roundSpan(ms) : ''
}

// A Claude Code run's lock (.model-ladder/runs/<runId>.json, scripts/runs.mjs): preflight writes it, finish removes it.
// expectedMs is the run's forecast total (scripts/forecast.mjs writes it once routing has produced one), else null.
// phaseExpected is the per-agent expectations table (scripts/forecast.mjs agentExpectations), written at preflight and each boundary.
type Lock = { runId: string; startedAt: number; phase: string; task: string; expectedMs: number | null; phaseExpected: unknown }

// The skill that has the main session write HANDOFF.md from its conversation (skills/handoff/SKILL.md).
const HANDOFF_COMMAND = '/model-ladder:handoff'

// Template fallback, same shape as scripts/finish.mjs handoff(), for a run that is still going or just ended.
const handoffText = (running: Row[], now: number, last: any) => {
  const out = ['# model-ladder handoff', '']
  if (running.length) out.push('## Running', ...running.map((r) => `- ${r.cell}, ${span(now - r.startedAt)}: ${r.task}`), '')
  if (last) {
    out.push('## Task', last.task, '', `## Last run (${last.date}): ${last.status}`, `Start: ${last.start ? `${last.start.model}/${last.start.effort}` : 'none'}`, '', '## Attempts',
      ...(last.attempts?.length ? last.attempts.map((a: any, i: number) => `${i + 1}. ${a.cell}: ${a.pass ? 'PASS' : 'FAIL'} ${a.reason}`) : ['none']),
      '', `Applied: ${last.applied ? 'yes' : 'no'}`, '')
    const context = (last?.attempts ?? []).flatMap((a: any) => [a.modelContext, a.diagnosisContext].filter(Boolean))
    if (context.length) out.push('## Model context (unverified)', ...context.map((c: any) => `### ${c.source} — ${c.updatedAt}\n${c.text}`), '', 'Generated status and verification above are authoritative. Model context is unverified; timestamps identify its source and age.', '')
  }
  out.push('## Resume', `Run \`/model-ladder:run ${last?.task ?? running.at(-1)?.task}\` again.`, '')
  return out.join('\n')
}

// Repo root per working directory: the nearest folder up holding .git (a directory, or a worktree's file), else
// the directory itself. .model-ladder lives there, where the scripts write runs/ and history.jsonl.
const roots = new Map<string, string>()
async function repoRootOf($: EngineInterface) {
  const cwd = await $.session.cwd()
  const known = roots.get(cwd)
  if (known !== undefined) return known
  let root = cwd
  for (let dir = cwd.replace(/[\\/]+$/, ''); ;) {
    if (await $.fs.exists(`${dir}/.git`).catch(() => false)) { root = dir; break }
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    if (cut < 0) break
    dir = dir.slice(0, cut)
  }
  roots.set(cwd, root)
  return root
}

// Every Claude Code run lock in this repo, newest first, for each agent's expected duration.
async function claudeLocks($: EngineInterface): Promise<Lock[]> {
  const dir = `${await repoRootOf($)}/.model-ladder/runs`
  const entries = await $.fs.list(dir).catch(() => [])
  const found: Lock[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const lock = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
      if (lock?.runtime !== 'claude') continue
      found.push({ runId: String(lock.runId ?? entry.name), startedAt: Date.parse(lock.startedAt) || 0, phase: String(lock.phase ?? 'running'), task: String(lock.task ?? ''), expectedMs: Number.isFinite(lock.expectedMs) && lock.expectedMs > 0 ? lock.expectedMs : null, phaseExpected: lock.phaseExpected ?? null })
    } catch { /* half-written or gone: skip it */ }
  }
  return found.sort((a, b) => b.startedAt - a.startedAt)
}

// The ladder run a workflow run belongs to: the one lock whose task is that run's TASK line. Each ladder boundary is
// its own workflow run and a verifier or diagnosis prompt carries no TASK line, so with no task the only lock is it.
// None or several: unknown.
const ladderLock = (locks: Lock[], task: string | undefined) => {
  const own = task ? locks.filter((l) => l.task.trim().split('\n')[0].trim() === task) : locks
  return own.length === 1 ? own[0] : null
}

// The agent's own expected duration, read from its run's lock each time it is asked (never kept from spawn): its
// phase+model+effort entry, else its phase; null (elapsed only) when its run has no lock, no table or no samples.
const agentExpectedMs = (locks: Lock[], tasks: Map<string, string>, r: Row) =>
  agentExpected(ladderLock(locks, tasks.get(r.run))?.phaseExpected, r.phase, r.model, r.effort)

// Records one background launch from its tool result; the band only watches, so a failure here is swallowed.
// key: what its past durations are stored under (a shell command's first line), so a repeat has an expected duration.
// question: the user question it belongs to (rows.mjs backgroundRows).
const track = async ($: EngineInterface, question: number, kind: Background['kind'], id: unknown, label: unknown, key?: unknown) => {
  try {
    if (typeof id !== 'string' || !id) return
    const firstLine = (v: unknown) => String(v ?? '').trim().split('\n')[0].trim()
    const task: Background = { id, kind, label: firstLine(label), startedAt: await $.clock.now(), question, answered: false, ...(firstLine(key) && { key: firstLine(key) }) }
    await update($, background, (l) => addBackground(l, task))
  } catch { /* bookkeeping only */ }
}

// The settings in effect here: defaults, the user's file plus the plugin's options, then the project's file.
async function loadConfig($: EngineInterface, options: unknown) {
  const project = await readJson($, await projectPath($))
  const repoRoot = (await $.session.repo())?.root
  const config = projectSkills(mergeConfig(BAND_DEFAULTS, { ...(await readJson($, await userPath($))), ...pluginLayer(options as any) }, project), repoRoot)
  return { project, repoRoot, config }
}

// Writes the template HANDOFF.md, then asks the main session to write the AI version. The button calls it, and so
// does the usage guard when a window reaches its threshold (auto): the guard hands off even with no ladder run, since
// the handoff skill writes from the conversation itself.
async function handoff($: EngineInterface, auto = false) {
  const dir = `${await repoRootOf($)}/.model-ladder`
  let last = null
  try { last = JSON.parse((await $.fs.read(`${dir}/history.jsonl`)).trim().split('\n').at(-1) ?? '') } catch { /* no history yet */ }
  const live = (await read($, rows)).filter((r) => r.status === 'running')
  if (!live.length && !last && !auto) return $.ui.toast('model-ladder: no run to hand off')
  const why = auto ? 'usage reached the usage guard threshold; ' : ''
  if (live.length || last) {
    try {
      // The template is written first: it is the fallback if the main session never gets to write the AI version.
      await $.fs.write(`${dir}/HANDOFF.md`, handoffText(live, await $.clock.now(), last))
    } catch (error) {
      return $.ui.toast(`model-ladder: ${why}handoff failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Asks the main session to write the real one: $.command.run runs the skill once the session is idle, as if the person
  // typed it. Not $.prompt.submit: the host refuses a prompt that starts with "/".
  const wrote = live.length || last ? `wrote the template ${dir}/HANDOFF.md and ` : ''
  const fallback = () => $.ui.toast(`model-ladder: ${why}${wrote}could not ask this session; run ${HANDOFF_COMMAND} for the AI-written version`)
  try {
    void Promise.resolve($.command.run({ command: HANDOFF_COMMAND.slice(1) })).catch(fallback)
    $.ui.toast(`model-ladder: ${why}${wrote}asked this session to write the AI version (${HANDOFF_COMMAND})`)
  } catch {
    fallback()
  }
}

// Usage windows the guard has already handed off for, as "<kind>@<resetsAt>", kept in $.store so a reload or a new
// session in the same window does not hand off again. A window re-arms when it is below the threshold (or the guard
// is off) at a measure, or when it resets (a new resetsAt is a new key).
const HANDED_OFF = 'guardHandedOff'
async function guardHandoff($: EngineInterface, options: unknown, limits: { kind: string; percentUsed: number; resetsAt?: string | null }[]) {
  const guard = (await loadConfig($, options)).config.usageGuard ?? {}
  const enabled = guard.enabled ?? GUARD_DEFAULT.enabled
  const threshold = guard.threshold ?? GUARD_DEFAULT.threshold
  const windows = limits.filter((w) => WINDOW[w.kind] && typeof w.percentUsed === 'number')
  const over = windows.filter((w) => enabled && w.percentUsed >= threshold)
  const before = ((await $.store.get(HANDED_OFF).catch(() => undefined)) ?? []) as string[]
  const keyOf = (w: { kind: string; resetsAt?: string | null }) => `${w.kind}@${w.resetsAt ?? ''}`
  const below = new Set(windows.filter((w) => !over.includes(w)).map((w) => w.kind))
  const kept = before.filter((k) => !below.has(k.split('@')[0]))
  const fresh = over.filter((w) => !kept.includes(keyOf(w)))
  const after = [...kept, ...fresh.map(keyOf)]
  if (after.length !== before.length || after.some((k, i) => k !== before[i])) await $.store.set(HANDED_OFF, after)
  if (fresh.length) await handoff($, true)
}

export const register: Register = (on, options) => {
  // Redraws once a second while an agent runs, so its elapsed time moves.
  let tick: Timer | null = null
  // What the person typed in the threshold field, until it saves.
  let draft: string | null = null
  // Saves the typed threshold once typing pauses for a second; Enter saves at once.
  let settle: Timer | null = null
  // Bumped on Enter: the Input clears itself on submit, and a new key remounts it showing the value again.
  let submits = 0
  // Agents already told about; a long run is only reported, never stopped.
  const warned = new Set<string>()
  // The task last seen in each workflow run, for agents whose prompt has no TASK line.
  const tasks = new Map<string, string>()
  // Workflow runs whose verifier has run; a worker spawned later in the same run is a redispatch.
  const verified = new Set<string>()
  // Last context size written to .model-ladder/context.json, so it is rewritten only when it changes.
  let lastContext = ''
  // Redraws once a second while background rows show, so their elapsed time moves.
  let bgTick: Timer | null = null
  // The user question being worked on: bumped by each user prompt (never by a task-notification), set back to a task's
  // question when its notification wakes the session.
  let question = 0

  // Records the subscription usage where preflight and the verifier read it, so the usage guard needs no statusline.
  // It runs with the band hidden too: the guard depends on it, not on the drawing. At the guard's threshold it also
  // hands off once per window (guardHandoff).
  on('session.measure', async ($, e, next) => {
    const text = formatContext(e.context)
    if (text !== (await read($, contextText))) {
      await update($, contextText, () => text)
      $.ui.invalidate('ui.render')
    }
    // The measured context size, which preflight hands the workflow for its DIRECT check; unknown tokens are not written.
    const tokens = e.context?.tokens
    if (typeof tokens === 'number') {
      const key = `${tokens}/${e.context?.window ?? ''}`
      if (key !== lastContext) {
        lastContext = key
        const context = { tokens, window: e.context?.window ?? null, updatedAt: Math.floor((await $.clock.now()) / 1000) }
        await $.fs.write(`${await repoRootOf($)}/.model-ladder/context.json`, JSON.stringify(context)).catch(() => { lastContext = '' })
      }
    }
    const window = (kind: string) => {
      const w = e.rateLimits.find((r) => r.kind === kind)
      return w ? { used_percentage: w.percentUsed, resets_at: w.resetsAt ? Date.parse(w.resetsAt) / 1000 : null } : null
    }
    if (e.rateLimits.length) {
      const usage = { five_hour: window('five_hour'), seven_day: window('seven_day'), updatedAt: Math.floor((await $.clock.now()) / 1000) }
      await $.fs.write(`${await repoRootOf($)}/.model-ladder/usage.json`, JSON.stringify(usage)).catch(() => undefined)
      await guardHandoff($, options, e.rateLimits).catch(() => undefined)
    }
    return next(e)
  })

  // A reload drops its pending removals, so finished rows left from before it go now.
  on('session.start', async ($, e, next) => {
    await update($, rows, (l) => l.filter((r) => r.status === 'running'))
    await update($, background, () => [])
    return next(e)
  })

  // A background launch is tracked from its tool result; the band only watches and never blocks or fails the call.
  // A subagent's call (e.agentId set) gets no row: its task-notification goes to the subagent, never to this session.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran
    await track($, question, 'shell', ran.result?.backgroundTaskId, e.description || e.command, e.command)
    return ran
  })
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const ran = await next(e)
    // The ladder's own launch gets no row: the person already knows model-ladder is choosing a model.
    if (e.agentId || e.workflow === 'ladder' || ran.result?.workflowName === 'ladder') return ran
    await track($, question, 'workflow', ran.result?.taskId, ran.result?.workflowName || e.description)
    return ran
  })

  // A stopped background task sends no task-notification, so its row leaves when TaskStop runs.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id) await update($, background, (l) => removeBackground(l, [id])).catch(() => undefined)
    return ran
  })

  // A task-notification says which background tasks ended.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin?.kind === 'task-notification') {
        const ids = [...e.text.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)].map((m) => m[1].trim())
        // A command that ran to its end adds its duration to that command's history; a stopped one (TaskStop) does not.
        const now = await $.clock.now()
        const hit = (await read($, background)).filter((t) => ids.includes(t.id))
        // The notification wakes Claude for the question that started those tasks: its other tasks show again until that turn ends.
        const woken = hit.find((t) => t.question !== undefined)?.question
        if (woken !== undefined) {
          question = woken
          await update($, background, (l) => markAnswered(l, woken, false))
        }
        const ended = hit.filter((t) => t.key)
        if (ids.length) await update($, background, (l) => removeBackground(l, ids))
        if (ended.length) {
          let history = ((await $.store.get(DURATIONS)) ?? {}) as Record<string, number[]>
          for (const t of ended) history = recordDuration(history, t.key, now - t.startedAt)
          await $.store.set(DURATIONS, history)
        }
      } else {
        // A new user question; tasks of earlier questions keep their own state.
        question += 1
      }
    } catch { /* bookkeeping only */ }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    // A background subagent the main session spawned itself (not a ladder agent) is a background row until it ends.
    if (!e.workflow && e.background && result.agentId) await track($, question, 'agent', result.agentId, e.description)
    if (!e.workflow || !e.subagentType.startsWith('model-ladder:') || !result.agentId) return result
    const hasTask = /TASK[^\n]*\n\s*[^\n]+/.test(e.prompt)
    if (hasTask) tasks.set(e.workflow.runId, taskOf(e.prompt, ''))
    const task = hasTask ? taskOf(e.prompt, '') : (tasks.get(e.workflow.runId) ?? e.description.trim())
    // Worker rows show just the task; the others say what they do with it.
    const isWorker = /^model-ladder:(worker|test-writer)$/.test(e.subagentType)
    const what = e.description.replace(/\s*\S+\/\S+$/, '')
    // The ladder labels its agents "<phase> <model>/<effort>" (workflows/ladder.js): route, worker, verify, diagnose, final.
    const cellOf = e.description.match(/(\S+)\/(\S+)$/)
    const effort = cellOf?.[2]
    const role = e.subagentType.slice('model-ladder:'.length) as Row['role']
    // shortcut: the turn.complete event type is not available here, so FAIL is inferred from "a worker spawns after a verifier in the same run"; this assumes the ladder only redispatches a worker after a FAIL, upgrade to the verifier's actual result once turn.complete exposes its output.
    const redo = isRedo(verified, e.workflow.runId, isWorker)
    if (role === 'verifier') verified.add(e.workflow.runId)
    const row: Row = {
      role,
      redo,
      run: e.workflow.runId,
      id: result.agentId,
      cell: `${modelName(result.model)}${effort ? `/${effort}` : ''}`,
      task: isWorker ? task : `${what}: ${task}`,
      status: 'running',
      startedAt: await $.clock.now(),
      ms: null,
      phase: what.split(/\s+/)[0],
      model: cellOf?.[1] ?? null,
      effort: effort ?? null,
      // Not read here: the run's lock may not hold its expectations yet, and they are read live while the row runs.
      expectedMs: null,
    }
    await update($, rows, (list) => addRow(list, row))
    tick ??= $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
      void (async () => {
        const now = await $.clock.now()
        for (const r of await read($, rows)) {
          if (r.status !== 'running' || warned.has(r.id) || now - r.startedAt < LONG_MS) continue
          warned.add(r.id)
          $.ui.toast(`model-ladder: ${r.cell} has run for 10 minutes and is still working`)
        }
      })()
    })
    return result
    // The band only watches; a failure in its bookkeeping must never stop a ladder agent.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) await update($, background, (l) => removeBackground(l, [e.agentId!]))
    else {
      // The main session's turn ended: if its last reply is a final answer (not waiting), this question's tasks hide.
      const answered = !isWaitingAnswer((e as { answer?: unknown }).answer)
      const turnQuestion = question
      await update($, background, (l) => markAnswered(l, turnQuestion, answered)).catch(() => undefined)
    }
    const finished = e.agentId ? (await read($, rows)).find((r) => r.id === e.agentId) : undefined
    if (e.agentId && finished) {
      const id = e.agentId
      // The row keeps the expectation it showed last; it is read one final time here, as it finishes.
      const expectedMs = agentExpectedMs(await claudeLocks($).catch(() => []), tasks, finished) ?? finished.expectedMs
      const list = await update($, rows, (l) => finishRow(l, id, e.durationMs, expectedMs) as Row[])
      if (!anyRunning(list)) { tick?.cancel(); tick = null }
      // A finished row keeps its check mark for a while before it leaves.
      $.clock.after(DONE_MS, () => { void update($, rows, (l) => removeRow(l, id)) })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || options.band === false) return next(e)
    const shown = await read($, rows)
    const running = shown.filter((r) => r.status === 'running')
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const now = await $.clock.now()
    // Every lock is read on each render, so a running agent's expectation is live, not as it was at spawn.
    const locks = await claudeLocks($)
    // Elapsed, then "/" and the expected duration when known; a finished row keeps both as they were.
    const total = (ms: number | null | undefined, approx = false) => (ms ? `/${approx ? '~' : ''}${span(ms)}` : '')
    // An agent row: this agent's own elapsed over this agent's own expected duration. A running row reads its
    // expectation from the lock now; a finished row keeps the one it finished with.
    const elapsed = (r: Row) => {
      const done = r.status === 'done'
      const live = done ? null : liveExpected(now - r.startedAt, agentExpectedMs(locks, tasks, r), agentSamples(ladderLock(locks, tasks.get(r.run))?.phaseExpected, r.phase, r.model, r.effort))
      return `${done ? '✓ ' : ''}${span(r.ms ?? now - r.startedAt)}${done ? total(r.expectedMs) : total(live?.ms, live?.approx)}`
    }
    // A running agent that has reached its expected duration shows what it is doing now instead of the task text,
    // read from its own messages once per render; anything unreadable keeps the task text.
    const doing = new Map<string, string>()
    for (const r of shown) {
      const expected = r.status === 'running' ? agentExpectedMs(locks, tasks, r) : null
      if (!expected || now - r.startedAt < expected) continue
      try {
        const found: unknown = await $.session.messages({ agentId: r.id })
        const text = activityText(Array.isArray(found) ? found : null)
        if (text) doing.set(r.id, r.role === 'worker' || r.role === 'test-writer' ? text : `${r.phase}: ${text}`)
      } catch { /* not readable: keep the task text */ }
    }
    const rowTask = (r: Row) => doing.get(r.id) ?? r.task
    const usage = (await $.session.usage()).rateLimits
      .filter((w) => WINDOW[w.kind])
      .map((w) => {
        const left = remaining(w.resetsAt, now)
        return `${left ? `${left}/` : ''}${WINDOW[w.kind]} ${Math.round(w.percentUsed)}%`
      })
      .join(' · ')
    const usageLine = [usage, await read($, contextText)].filter(Boolean).join(' · ')
    const folded = await read($, isFolded)
    const fold = <Button key="fold" plain dimColor label={folded ? '▾' : '▴'} onPress={() => update($, isFolded, (v) => !v)} />
    const last = running.at(-1)
    const runs = runCount(shown)
    // With 2+ runs each row says which run it belongs to, by that run's task.
    const tag = (r: Row) => (runs > 1 ? `${fit(tasks.get(r.run) ?? '', 20).trim()} ` : '')
    const dot = last && <Text>{' ' + (last.role === 'verifier' ? '🔵' : last.redo ? '🔴' : '🟢')}</Text>
    // Background rows: this session's in-flight background tasks, only while Claude is not working and no ladder agent runs.
    const bg = backgroundRows(await read($, background), Boolean(e.props.isWorking), running.length > 0)
    if (bg.length) bgTick ??= $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    else { bgTick?.cancel(); bgTick = null }
    // A background row: elapsed, and for a command seen before its past median, recalibrated like an agent row.
    const durations = ((await $.store.get(DURATIONS).catch(() => undefined)) ?? {}) as Record<string, number[]>
    const bgElapsed = (t: Background) => {
      const samples = t.key ? durations[t.key] ?? [] : []
      const live = liveExpected(now - t.startedAt, medianDuration(samples), samples)
      return `${span(now - t.startedAt)}${live ? `/${live.approx ? '~' : ''}${span(live.ms)}` : ''}`
    }
    const bgTask = (t: Background) => `${t.kind}: ${t.label}`
    const idle = running.length || bg.length ? '' : ' · idle'

    const { project, repoRoot, config } = await loadConfig($, options)
    const guard = config.usageGuard ?? {}
    // Display only: a missing setting shows as the default (on, 90%) and is never written back.
    const enabled = guard.enabled ?? GUARD_DEFAULT.enabled
    const threshold = guard.threshold ?? GUARD_DEFAULT.threshold
    // The usage line with each percentage colored: plain under 50%, yellow from 50% up to the guard threshold, red at
    // or above it. Raw colors, not theme keys: a surface may draw a theme key it does not know as plain text.
    const level = (pct: number) => (pct >= threshold ? 'red' : pct >= 50 ? 'yellow' : undefined)
    const usageRun = (text: string) => text.split(/(\d+(?:\.\d+)?%)/).map((part, i) => i % 2
      ? <Text key={`usage-${i}`} color={level(Number.parseFloat(part))}>{part}</Text>
      : part && <Text key={`usage-${i}`} dimColor>{part}</Text>)

    if (folded) {
      return (
        <Box>
          {fold}
          {dot}
          <Text bold> model-ladder </Text>
          {usageRun(`── ${usageLine || 'usage unknown'}${last ? ' · ' : ''}`)}
          {last && runs > 1 && <Text dimColor>{runs} runs · </Text>}
          {last && <Text>{last.cell} · {elapsed(last)} · {fit(rowTask(last), 30).trim()}</Text>}
          {bg.length > 0 && <Text> · background · {bgElapsed(bg[0])} · {fit(bgTask(bg[0]), 30).trim()}{bg.length > 1 ? ` +${bg.length - 1}` : ''}</Text>}
        </Box>
      )
    }

    // Show configured instructions in effect here; this does not claim that any skill has run.
    const projectNameForDisplay = projectName(repoRoot, await $.session.cwd())
    const skill = (value: unknown) => typeof value === 'string' && value.trim() ? formatInstructions(projectNameForDisplay, value) : null
    const withs = [skill(config.worker_skills), skill(config.verifier_skills)].filter(Boolean)
    const skillText = withs.join(' · ')
    const skillsFolded = await read($, areSkillsFolded)
    // The project file can still pin a guard field; the person's change is saved, and they are told it does not apply here.
    const pinNote = (field: string) => projectPins(project, field)
      ? $.ui.toast(`model-ladder: saved to your own settings, but .claude/model-ladder.json sets usageGuard.${field} for this project and wins`)
      : undefined
    // Changes the threshold alone: an off guard stays off.
    const save = async (value: string) => {
      const n = parseThreshold(value)
      if (n === null) return $.ui.toast('threshold must be a number from 1 to 100')
      draft = null
      await editUserConfig($, (c) => setGuard(c, { threshold: n }))
      pinNote('threshold')
    }
    const toggle = async () => {
      await editUserConfig($, (c) => setGuard(c, { enabled: !enabled }))
      pinNote('enabled')
    }
    // Fixed-width columns line up in any font, unlike padding with spaces.
    // Terminal cuts the task itself; elsewhere the full task goes to the row and truncate-end adds the ellipsis at the band's edge.
    const timeCols = Math.max(12, ...shown.map((r) => elapsed(r).length + 1), ...bg.map((t) => bgElapsed(t).length + 1))
    const taskCols = Math.max(10, (e.props.bodyColumns ?? 60) - 20 - timeCols - 2)
    const row = (key: string, model: string, time: string, task: string, dim = false) => (
      <Box key={key} flexWrap="nowrap">
        <Box width={20} flexShrink={0}><Text dimColor={dim} wrap="truncate-end">{model}</Text></Box>
        <Box width={timeCols} flexShrink={0}><Text dimColor={dim}>{time}</Text></Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor={dim} wrap="truncate-end">{task}</Text></Box>
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box>
          {fold}
          {dot}
          <Text bold> model-ladder </Text>
          {usageRun(`── ${usageLine || 'usage unknown'}${idle}`)}
        </Box>
        {withs.length > 0 && (
          <Box flexWrap="nowrap">
            <Button key="skills-fold" plain dimColor label={skillsFolded ? '▸' : '▾'}
              onPress={() => update($, areSkillsFolded, (v) => !v)} />
            <Box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={1}>
              <Text dimColor wrap={skillsFolded ? 'truncate-end' : undefined}>{skillsFolded ? skillText.replace(/\s+/g, ' ') : skillText}</Text>
            </Box>
          </Box>
        )}
        {(shown.length > 0 || bg.length > 0) && row('head', 'model/effort', 'act./est.', 'task', true)}
        {bg.map((t) => row(`background-${t.id}`, 'background', bgElapsed(t), e.surface === 'terminal' ? clip(bgTask(t), taskCols) : bgTask(t)))}
        {shown.map((r) => row(r.id, r.cell, elapsed(r), e.surface === 'terminal' ? clip(tag(r) + rowTask(r), taskCols) : tag(r) + rowTask(r)))}
        <Box>
          <Button key="guard" plain label={`usage guard: ${enabled ? 'on' : 'off'}`}
            onPress={() => { void toggle() }} />
          {enabled && 'Input' in els && <Text dimColor>  threshold </Text>}
          {enabled && 'Input' in els && (
            <Box flexShrink={0} width={e.surface === 'terminal' ? 6 : 10}>
              <els.Input key={`threshold-${submits}`} value={String(threshold)}
                onInput={(value) => {
                  draft = value
                  settle?.cancel()
                  settle = $.clock.after(SETTLE_MS, () => {
                    settle = null
                    const typed = draft?.trim() ?? ''
                    if (typed && typed !== String(threshold)) void save(typed)
                  })
                }}
                onSubmit={async (value) => { settle?.cancel(); settle = null; await save(value); submits++; $.ui.invalidate('ui.render') }} />
            </Box>
          )}
          {enabled && 'Input' in els && <Text dimColor> % </Text>}
          {enabled && !('Input' in els) && <Text dimColor>  threshold {threshold}%</Text>}
          <Text dimColor>  </Text>
          <Button key="handoff" plain label="handoff now" onPress={() => { void handoff($) }} />
        </Box>
      </Box>
    )
  })
}
