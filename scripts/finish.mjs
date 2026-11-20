// Applies a verified result, cleans up, appends history, and prints the report.
// stdin: JSON { "task": "...", "result": <workflow result> }
//    or  { "task": "...", "error": "..." }    the workflow crashed
//    or  { "task": "...", "aborted": "..." }  the user stopped before the run
// Each input also carries "runId", the runId preflight printed.
// `--handoff` (no stdin) writes the template .model-ladder/HANDOFF.md from the last history entry instead.
// Always removes this run's lock, so a crash or a "no" never leaves the guard armed for it.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical } from '../hooks/guard.mjs'
import { artifactDir, git, print, pruneLeftoverBranches, removeWorktree, repoRoot, runDir, samePath, worktrees } from './common.mjs'
import { readLocks, releaseLock } from './runs.mjs'
import { applyResult, changed, protectedChange, snapshot } from './codex-worktree.mjs'
import { inScope } from './task-contract.mjs'
import { updateNote } from './update-check.mjs'
import { claudeGuard, forceStopRuns } from './usage-guard.mjs'
import { finishForecast, history } from './forecast.mjs'

const pathKey = (path) => process.platform === 'win32' ? canonical(path).toLowerCase() : canonical(path)
const under = (path, dir) => pathKey(path).startsWith(`${pathKey(dir)}${sep}`)
const sameCandidatePath = (a, b) => pathKey(a) === pathKey(b)
const proofPath = (run, attempt, phase) => join(run, `candidate-${attempt}-${phase}.json`)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function candidateLocation(root, cwd, state) {
  return sameCandidatePath(root, cwd) || (under(cwd, join(root, '.claude', 'worktrees')) &&
    !state.before.some((path) => sameCandidatePath(path, cwd)) && worktrees(root).some(({ path }) => sameCandidatePath(path, cwd)))
}

function observeCandidate(cwd, run, state) {
  if (git(cwd, 'rev-parse', 'HEAD') !== state.baseCommit) throw new Error('Candidate base commit changed')
  return { worktreePath: canonical(cwd), tree: snapshot(cwd, run, `candidate-${randomUUID()}`) }
}

function recordCandidate(runId, attemptText, phase) {
  const attempt = Number(attemptText)
  if (!/^claude-[0-9a-f-]{36}$/.test(runId ?? '') || !Number.isSafeInteger(attempt) || attempt < 1 || !['before', 'after'].includes(phase)) throw new Error('Expected --candidate <Claude run ID> <attempt> before|after')
  const cwd = repoRoot()
  const root = worktrees(cwd)[0]?.path
  if (!root || !readLocks(root).some((lock) => lock.runId === runId && lock.runtime === 'claude')) throw new Error('Candidate has no active Claude run')
  const run = join(artifactDir(root), runId)
  const state = readJson(join(run, 'state.json'))
  if (!candidateLocation(root, cwd, state) || attempt > state.config.maxAttempts) throw new Error('Candidate worktree or attempt is outside the run')
  const current = observeCandidate(cwd, run, state)
  if (phase === 'after') {
    const before = readJson(proofPath(run, attempt, 'before'))
    if (!sameCandidatePath(before.worktreePath, cwd) || before.tree !== current.tree) throw new Error('Verification changed the candidate snapshot')
  }
  const path = proofPath(run, attempt, phase)
  try { writeFileSync(path, JSON.stringify(current), { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = readJson(path)
    if (!sameCandidatePath(existing.worktreePath, cwd) || existing.tree !== current.tree) throw new Error('Candidate evidence cannot be replaced')
  }
  return current.tree
}

function verifiedCandidate(root, run, state, result, scope) {
  const { winner, attempts, plan } = result
  const cwd = winner.worktreePath
  const last = attempts.at(-1)
  if (typeof cwd !== 'string' || last?.pass !== true || typeof last.worktreePath !== 'string' ||
    !sameCandidatePath(cwd, last.worktreePath) || !candidateLocation(root, cwd, state)) throw new Error('Invalid candidate worktree or verifier verdict')
  if (!winner.candidateTree || !['before', 'after'].every((phase) => existsSync(proofPath(run, attempts.length, phase)))) throw new Error('Verifier candidate evidence is missing')
  for (const phase of ['before', 'after']) {
    const proof = readJson(proofPath(run, attempts.length, phase))
    if (!sameCandidatePath(proof.worktreePath, cwd) || proof.tree !== winner.candidateTree) throw new Error('Verifier evidence does not match the candidate')
  }
  const { tree } = observeCandidate(cwd, run, state)
  if (tree !== winner.candidateTree) throw new Error('Candidate snapshot changed after verification')
  const files = changed(root, state.baseTree, tree)
  if (sameCandidatePath(cwd, root)) {
    if (plan.readOnly !== true) throw new Error('Writable candidate must be in a separate worktree')
    if (files.length) throw new Error('Read-only checkout changed during verification')
    return { applied: false, files: [], note: 'read-only attempt, nothing to apply' }
  }
  if (plan.readOnly === true) throw new Error('Read-only result must refer to the original checkout')
  const protection = [...state.protection.always, ...(plan.allowTests === true ? [] : state.protection.tests)]
  const protectedFile = protectedChange(root, state.baseTree, tree, protection)
  if (protectedFile) throw new Error(`Modified protected file ${protectedFile}`)
  // An unclaimed or unbounded ('**') scope allows everything. shortcut: inScope matches literal paths only, so a glob entry would reject its matches; upgrade if the router starts claiming globs.
  const outside = Array.isArray(scope) && !scope.includes('**') ? files.find((file) => !inScope(file, scope)) : undefined
  if (outside) throw new Error(`Candidate changed ${outside}, outside the claimed scope`)
  if (!files.length) throw new Error('Candidate has no changes to apply')
  let command = null
  if (typeof plan.verify === 'string' && plan.verify.trim()) {
    const started = Date.now()
    const ran = spawnSync(plan.verify, { cwd, shell: true, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 })
    const tail = (text) => String(text ?? '').slice(-4096).replace(/^[\uDC00-\uDFFF]/, '')
    command = { command: plan.verify, exitCode: ran.status, durationMs: Date.now() - started, sandbox: 'HOST_UNSANDBOXED', stdout: tail(ran.stdout), stderr: tail(ran.stderr) }
    const fail = (message) => { throw Object.assign(new Error(message), { command }) }
    if (ran.error?.code === 'ETIMEDOUT') fail('Verify command timed out after 10 minutes')
    if (ran.status !== 0) fail(`Verify command exited ${ran.status ?? ran.signal ?? ran.error?.message}`)
    if (observeCandidate(cwd, run, state).tree !== tree) fail('Verify command changed the candidate tree')
  }
  const outcome = applyResult(root, run, state.baseTree, tree, state.baseCommit, { commit: state.config.commit, goal: plan.goal, requireBaseFiles: true })
  return outcome.patch ? { ...outcome, keep: cwd, command } : { ...outcome, command }
}

// Worktrees an earlier run kept (conflict, keepFailed, usage limit), as finish recorded them in history.
function keptByHistory(run) {
  try {
    return readFileSync(join(run, 'history.jsonl'), 'utf8').split('\n').flatMap((line) => {
      try { return JSON.parse(line).kept ?? [] } catch { return [] }
    })
  } catch { return [] }
}

// Removes this run's worktrees: those its attempts reported, and, when no other Claude Code run is
// active, any other worktree under .claude/worktrees/ created since preflight that no run kept (a
// worker that died before reporting). With another run active those may be its own, so they stay.
// keepOrphans (a run stopped by Claude's limit): an unreported worktree is the attempt that died mid-work, so it
// stays for the resume instead. Returns the orphans it kept.
function cleanup(root, state, keep, known, runId, keepOrphans = false) {
  const others = readLocks(root).filter((lock) => (runId ? lock.legacy || lock.runId !== runId : !lock.legacy) && lock.runtime !== 'codex')
  const kept = keptByHistory(runDir(root))
  const orphans = []
  for (const wt of worktrees(root)) {
    if ((state.before ?? []).some((p) => samePath(p, wt.path))) continue
    if (keep.some((p) => samePath(p, wt.path))) continue
    const mine = known.some((p) => samePath(p, wt.path))
    const orphan = !others.length && under(wt.path, join(root, '.claude', 'worktrees')) && !kept.some((p) => samePath(p, wt.path))
    if (!mine && !orphan) continue
    if (!mine && keepOrphans) { orphans.push(wt.path); continue }
    // Claude Code locks the worktrees it creates; removing a locked one takes --force twice.
    removeWorktree(root, wt.path, { branch: wt.branch ?? undefined })
  }
  pruneLeftoverBranches(root)
  return orphans
}

function report(task, result, outcome, notes, command) {
  const plan = result.plan
  const rows = result.attempts.map((a, i) => {
    const why = a.action ? `${a.action}: ${a.actionReason}` : a.pass ? '—' : a.reason
    return `${String(i + 1).padEnd(2)} ${a.cell.replace('/', ' / ').padEnd(16)} ${(a.pass ? 'PASS' : 'FAIL').padEnd(8)} ${why}`
  })
  const tests = plan.allowTests ? 'allowed' : 'protected'
  const applied = outcome.applied
    ? outcome.committed ? `committed as ${outcome.committed}` : `to the working tree (not committed)`
    : `not applied${outcome.note ? `: ${outcome.note}` : ''}`
  const lines = [
    `model-ladder ── ${result.status}`,
    '',
    `Task      ${task}`,
    `Verify    ${plan.verify ?? 'acceptance criteria'}`,
    `Tests     ${tests} (router: ${plan.allowTestsReason})`,
    `Start     ${plan.start} (router: ${plan.startReason})`,
    '',
    '#  Model / Effort   Result   Why next',
    ...rows,
    '',
    `Changed   ${outcome.files?.length ? outcome.files.join(', ') : '—'}`,
    `Applied   ${result.status === 'VERIFIED' || outcome.note ? applied : 'nothing (no verified attempt)'}`,
    `Tokens    ${result.tokens} output (route + attempts)`,
  ]
  // What each worker reported doing with the configured skill instructions.
  const skillState = (s) => (s.used ? 'used' : !s.applies ? 'not applicable' : !s.available ? 'unavailable' : 'skipped')
  const skills = (result.attempts ?? []).flatMap((a, i) => a.skills?.length ? [`#${i + 1} ${a.skills.map((s) => `${s.name} ${skillState(s)}`).join(', ')}`] : [])
  if (skills.length) lines.push(`Skills    ${skills.join(' · ')}`)
  if (command) lines.push(`Command   ${command.command} (exit ${command.exitCode}, ${command.durationMs} ms, ${command.sandbox})`)
  if (outcome.handoff) lines.push(`Handoff   ${outcome.handoff}`)
  // A read-only attempt's report is the deliverable; nothing else carries it back.
  if (result.status === 'VERIFIED' && !outcome.files?.length && result.winner?.summary) lines.push('', 'Report', '', result.winner.summary)
  if (result.final) lines.push('', `Why       ${result.final.reason}`, `Next      ${result.final.suggestion}`)
  for (const note of notes) lines.push('', note)
  return lines.join('\n')
}

// stopped: the "Stopped" line; a USAGE_LIMIT run states its reason, a manual handoff says so.
function handoff(task, result, worktree, stopped = `USAGE_LIMIT: ${result.final?.reason ?? 'usage reached the threshold'}`) {
  const attempts = result.attempts.map((a, i) => `${i + 1}. ${a.cell}: ${a.pass ? 'PASS' : 'FAIL'} ${a.reason}`)
  const contexts = result.attempts.flatMap((a) => [a.modelContext, a.diagnosisContext].filter(Boolean))
  if (result.winner?.summary && !contexts.some((c) => c.text === result.winner.summary)) contexts.push({ source: 'winning worker', text: result.winner.summary })
  return `# model-ladder handoff

## Task
${task}

## Stopped
${stopped}

## Attempts
${attempts.join('\n') || 'none'}

## Generated status and verification
Status: ${result.status}. Attempt PASS/FAIL results above are generated verification results and remain authoritative.

## Model context (unverified)
${contexts.length ? contexts.map((c) => `### ${c.source}\n${c.text}`).join('\n\n') : 'No model context was captured.'}

Context comes from the model output named above. Treat it as claims, not verification evidence. Parent conversation context was not available to this run.

## Worktree
${worktree ?? 'none kept (the last attempt had no worktree)'}

## Resume
${result.status === 'USAGE_LIMIT' ? 'After the usage limit resets, run' : 'To start the task again, run'} \`/model-ladder:run ${task}\` again.${worktree ? ` The kept worktree above holds the last attempt's code; look at it for what was already tried.` : ''}
`
}

// `finish.mjs --handoff`: the template HANDOFF.md for the last run in history.jsonl, which /model-ladder:handoff then rewrites.
function manualHandoff(root) {
  const run = runDir(root)
  let last
  try { last = JSON.parse(readFileSync(join(run, 'history.jsonl'), 'utf8').trim().split('\n').at(-1)) } catch { /* no history */ }
  if (!last) return 'model-ladder handoff: no run history in .model-ladder/history.jsonl; no template written.'
  const result = { status: last.status, attempts: last.attempts ?? [], winner: last.winner }
  const path = join(run, 'HANDOFF.md')
  writeFileSync(path, handoff(last.task, result, (last.kept ?? []).at(-1), `Manual handoff (last run ended ${last.status}, ${last.date})`))
  return `model-ladder handoff: template written to ${path}`
}

// Every status workflows/ladder.js returns.
const STATUSES = ['CANDIDATE', 'VERIFIED', 'FAILED', 'STOPPED', 'DIRECT', 'USAGE_LIMIT', 'NEEDS_INPUT']

// Runs before anything is cleaned: a wrong shape must never cost a verified worktree.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be a JSON object {task, result} | {task, error} | {task, aborted}')
  const { task, result, error, aborted } = input
  if (typeof task !== 'string' || !task) throw new Error('task missing — input must be {task, result} | {task, error} | {task, aborted}')
  if (input.runId !== undefined && (typeof input.runId !== 'string' || !/^\w[\w.-]*$/.test(input.runId))) throw new Error('runId must be the runId preflight printed')
  if (result === undefined) {
    if (aborted === undefined && error === undefined) throw new Error('input needs one of result, error or aborted')
    return
  }
  if (!result || typeof result !== 'object') throw new Error("result must be the workflow's result object")
  if (result.status === undefined) throw new Error("result.status missing — pass the workflow's result field, not the whole output")
  if (!STATUSES.includes(result.status)) throw new Error(`result.status "${result.status}" is unknown — expected one of ${STATUSES.join(', ')}`)
  if (['CANDIDATE', 'VERIFIED'].includes(result.status) && (!result.winner || !Array.isArray(result.attempts) || !result.plan)) throw new Error('Candidate requires winner, attempts and plan')
}

function main(input) {
  validate(input)
  const root = repoRoot()
  const run = runDir(root)
  const { task, error, aborted, runId } = input
  let { result } = input
  // Without a runId: a run an older preflight started, with its files and run.json in .model-ladder/.
  const currentFiles = runId ? join(artifactDir(root), runId) : run
  const legacyFiles = runId ? join(run, 'runs', runId) : run
  const files = existsSync(join(currentFiles, 'state.json')) ? currentFiles : existsSync(join(legacyFiles, 'state.json')) ? legacyFiles : currentFiles
  const statePath = join(files, 'state.json')
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { before: [], config: {} }
  if (state.forecast && Number.isFinite(state.pendingBoundary)) state.forecast.openBoundary = { startedAt: state.pendingBoundary, censored: true, reason: 'Workflow call did not return a recorded boundary' }
  const notes = []
  let outcome = { applied: false, files: [] }
  let keep = []

  let verificationError
  let command = null
  if (['CANDIDATE', 'VERIFIED'].includes(result?.status)) {
    if (!runId || !readLocks(root).some((lock) => lock.runId === runId && lock.runtime === 'claude')) throw new Error('Candidate has no active Claude run')
    try {
      if (!state.baseCommit) throw new Error('Verifier candidate evidence is missing')
      outcome = verifiedCandidate(root, files, state, result, readLocks(root).find((lock) => lock.runId === runId)?.scope)
      command = outcome.command ?? null
      result = { ...result, status: outcome.keep ? 'CONFLICT' : 'VERIFIED' }
      if (outcome.keep) keep = [outcome.keep]
    } catch (failure) {
      verificationError = failure.message
      command = failure.command ?? null
      const cwd = result.winner.worktreePath
      if (state.before && typeof cwd === 'string' && !sameCandidatePath(root, cwd) && candidateLocation(root, cwd, state)) keep = [cwd]
      result = { ...result, status: 'FAILED', final: { reason: verificationError, suggestion: 'Verify a fresh candidate before applying changes.' } }
      if (keep.length) notes.push(`Candidate worktree retained at ${keep[0]}`)
    }
  }
  if (result && !['VERIFIED', 'CONFLICT'].includes(result.status) && state.config.keepFailed) {
    keep = [...new Set([...keep, ...result.attempts.map((a) => a.worktreePath).filter(Boolean)])]
    if (keep.length) notes.push(`Failed attempts kept (keepFailed): ${keep.join(', ')}`)
  }
  // The last attempt's worktree is what a resumed run can look at. A worker stopped by Claude's limit never
  // reported its worktree; cleanup keeps such an unreported one, and it is the last attempt's.
  const limited = result?.status === 'USAGE_LIMIT'
  let lastWorktree = limited ? result.attempts.map((a) => a.worktreePath).filter(Boolean).at(-1) ?? null : null
  if (lastWorktree && !keep.includes(lastWorktree)) keep.push(lastWorktree)
  const known = [...(result?.attempts ?? []).map((a) => a.worktreePath), result?.winner?.worktreePath].filter(Boolean)
  const orphans = cleanup(root, state, keep, known, runId, limited)
  keep.push(...orphans)
  if (orphans.length && !result.attempts.at(-1)?.worktreePath) lastWorktree = orphans.at(-1)
  if (runId) {
    releaseLock(root, runId)
    // A conflict's result.patch stays for review; the rest of the run's files go.
    if (existsSync(join(files, 'result.patch'))) for (const f of ['setup.patch', 'state.json', 'index']) rmSync(join(files, f), { force: true })
    else rmSync(files, { recursive: true, force: true })
  } else {
    for (const f of ['run.json', 'setup.patch', 'state.json', 'index']) rmSync(join(run, f), { force: true })
  }

  const terminationFailures = []
  if (limited && !aborted) {
    const stopped = forceStopRuns({ reason: `Force-stopped: ${result.final?.reason ?? 'usage reached the usageGuard threshold'}`,
      onFailure: (failure) => { terminationFailures.push(failure); notes.push(failure.message) } })
    if (stopped.length) notes.push(`Also stopped (usage limit): ${stopped.join(', ')}`)
  }
  const forecast = state.forecast ? finishForecast(root, state.forecast, history(root), claudeGuard(root), aborted ? 'ABORTED' : outcome.keep ? 'CONFLICT' : result?.status ?? 'ERROR') : null
  appendFileSync(join(run, 'history.jsonl'), `${JSON.stringify({
    date: new Date().toISOString(),
    runId: runId ?? null,
    task,
    runtime: 'claude',
    status: aborted ? 'ABORTED' : result?.status ?? 'ERROR',
    forecast,
    start: result?.plan?.start ?? null,
    attempts: (result?.attempts ?? []).map((a) => ({ cell: a.cell, pass: a.pass, reason: a.reason, action: a.action, tokens: a.tokens, modelContext: a.modelContext, diagnosisContext: a.diagnosisContext, ...(a.skills?.length && { skills: a.skills.map(({ name, applies, available, used, note }) => ({ name, applies, available, used, note })) }) })),
    winner: result?.winner ? { summary: result.winner.summary, ...(!verificationError && result.winner.candidateTree && { candidateTree: result.winner.candidateTree }) } : null,
    tokens: result?.tokens ?? null,
    applied: outcome.applied,
    committed: Boolean(outcome.committed),
    command,
    kept: keep,
    ...(terminationFailures.length && { terminationFailures }),
    error: error ?? verificationError ?? null,
  })}\n`)

  if (aborted) return `model-ladder stopped before running: ${aborted}`

  if (result?.status === 'USAGE_LIMIT') {
    const text = handoff(task, result, lastWorktree)
    outcome.handoff = join(run, 'HANDOFF.md')
    writeFileSync(outcome.handoff, text)
    if (runId) {
      mkdirSync(join(run, 'runs'), { recursive: true })
      outcome.handoff = join(run, 'runs', `${runId}.HANDOFF.md`)
      writeFileSync(outcome.handoff, text)
    }
  }

  if (result?.status === 'DIRECT') {
    return [`model-ladder ── DIRECT`, '', `Task      ${task}`, `Why       ${result.plan.directReason}`,
      'Next      The calling session does the task itself. Start the task with --ladder to force the ladder.', ...notes.flatMap((n) => ['', n])].join('\n')
  }
  if (error) return [`model-ladder ── ERROR`, '', `Task      ${task}`, `Error     ${error}`, '', 'Worktrees and the run lock were cleaned up.', ...notes].join('\n')
  return report(task, result, outcome, notes, command)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--candidate') print(recordCandidate(...process.argv.slice(3)))
    else {
      const text = process.argv.includes('--handoff') ? manualHandoff(repoRoot()) : main(JSON.parse(readFileSync(0, 'utf8')))
      const update = await updateNote()
      print(update ? `${text}\n\n${update}` : text)
    }
  } catch (e) {
    print(`model-ladder finish failed: ${String(e.stderr ?? e.message)}`)
    process.exitCode = 1
  }
}
