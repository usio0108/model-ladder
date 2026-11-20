// Local Fast Path: the calling session (Claude Code or Codex) is the native agent. No router, worker or reviewer
// process is started. `begin` applies the deterministic Execution v2 policy and snapshots the checkout; the session
// then edits only the contract scope; `check` runs the trusted verify command on that exact snapshot in a clean
// worktree and records evidence and telemetry in .model-ladder/history.jsonl.
//   node fast-path.mjs begin --input <contract.json>   -> READY | NOT_ELIGIBLE | BLOCKED
//   node fast-path.mjs check --run <fast-...>          -> VERIFIED | FAILED | CONFLICT | BLOCKED
// Only a LOW-risk DIRECT contract is eligible; anything else goes to the existing ladder.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEST_PATTERNS } from '../hooks/guard.mjs'
import { artifactDir, ensureGitExclude } from './common.mjs'
import { changedNpmScripts, discoverVerify, executionConfig, readInput, sandboxEnv, uvSyncRequired, verifyProtection } from './codex-run.mjs'
import { processRun } from './codex-exec.mjs'
import { readLocks, withMutex } from './runs.mjs'
import { inScope, parseTaskContract, taskPolicy, usageEvidence } from './task-contract.mjs'
import { changed, git, makeWorktree, protectedChange, removeOwned, snapshot } from './codex-worktree.mjs'

const RUN_ID = /^fast-[0-9a-f-]{36}$/

// The clean verification worktree never has node_modules, so an npm-style check of a project with dependencies cannot run there.
function needsNodeModules(root, verify) {
  if (!/\b(?:npm|npx|pnpm|yarn|bun)\b/i.test(verify)) return false
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0
  } catch { return false }
}

// Shared by begin and check: a ladder run that started after begin must stop the fast path too.
function activeRun(root) {
  const active = readLocks(root).filter((lock) => !lock.stale)
  return active.length ? { status: 'BLOCKED', errorCode: 'ACTIVE_RUN', runs: active.map((lock) => lock.runId), message: 'Another model-ladder run is active in this repository; use the ladder, which checks overlaps.' } : null
}

// Every begin failure is a JSON BLOCKED result, so the skill can always fall back to the ladder.
export function begin(input, { cwd = process.cwd() } = {}) {
  try { return prepare(input, cwd) } catch (error) { return { status: 'BLOCKED', errorCode: 'FAST_PATH_UNAVAILABLE', message: error.message } }
}

function prepare(input, cwd) {
  let contract
  try { contract = parseTaskContract(input?.contract) } catch (error) { return { status: 'BLOCKED', errorCode: 'INVALID_CONTRACT', message: error.message } }
  const root = git(cwd, 'rev-parse', '--show-toplevel')
  ensureGitExclude(root)
  const config = executionConfig(root, contract.backend)
  const verify = config.verify ?? discoverVerify(root)
  const protection = ['.codex/model-ladder.json', '.claude/model-ladder.json', ...config.protected, ...verifyProtection(verify, null), ...(contract.allowTests ? [] : TEST_PATTERNS)]
  const policy = taskPolicy(contract, root, protection, { configuredNetwork: config.network, requireSandbox: process.env.MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX === '1' })
  const summary = { risk: policy.risk, signals: policy.signals, profile: policy.profile }
  // Same blockers as the v2 runner, checked before any edit so the session never starts work it cannot verify.
  if (!contract.scope.length) return { status: 'BLOCKED', errorCode: 'SCOPE_REQUIRED', ...summary, message: 'Supply an explicit repository-relative execution scope.' }
  if (policy.profile !== 'DIRECT' || policy.review) return { status: 'NOT_ELIGIBLE', ...summary, message: `Policy selected ${policy.profile}; use the managed ladder.` }
  if (!verify) return { status: 'BLOCKED', errorCode: 'VERIFY_COMMAND_REQUIRED', ...summary, message: 'A trusted configured or discovered verification command is required.' }
  if (uvSyncRequired(root, verify)) return { status: 'BLOCKED', errorCode: 'UV_SYNC_REQUIRED', ...summary, message: `Run uv sync in ${root} first.` }
  if (needsNodeModules(root, verify)) return { status: 'BLOCKED', errorCode: 'MISSING_DEPENDENCIES', ...summary, message: `${verify} needs node_modules, which the clean verification worktree does not have. Set verify to a command that needs no install.` }
  // The session edits the live checkout without a lock, so it runs only when no ladder run is active here.
  const blocked = activeRun(root)
  if (blocked) return { ...blocked, ...summary }
  // Uncommitted changes would enter the baseline unchecked (including protected files); the ladder asks about them.
  const dirty = withMutex(root, 'apply', () => git(root, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':!.model-ladder', ':!.claude/worktrees'))
  if (dirty && input.allowDirty !== true) return { status: 'BLOCKED', errorCode: 'DIRTY', ...summary, files: dirty.split('\n').filter(Boolean).map((line) => line.slice(3)), message: 'The checkout has uncommitted changes.' }
  const runId = `fast-${randomUUID()}`
  const run = join(artifactDir(root), runId)
  mkdirSync(run, { recursive: true })
  const baseCommit = git(root, 'rev-parse', 'HEAD')
  const baseTree = withMutex(root, 'apply', () => snapshot(root, run, 'base'))
  const state = { version: 1, runId, startedAt: Date.now(), contract: { ...contract, repository: root }, policy, verify, verifySource: config.verify ? 'CONFIG' : 'DISCOVERY', protection, baseCommit, baseTree, checks: 0 }
  writeFileSync(join(run, 'state.json'), JSON.stringify(state, null, 2))
  return { status: 'READY', runId, ...summary, scope: contract.scope, protected: protection, verify,
    message: `Edit only ${contract.scope.join(', ')} in this checkout. Do not run the verify command yourself. Then run: fast-path.mjs check --run ${runId}` }
}

export async function check(runId, { cwd = process.cwd(), terminate, signal } = {}) {
  if (!RUN_ID.test(runId ?? '')) return { status: 'FAILED', errorCode: 'INVALID_RUN', message: 'check needs --run fast-<uuid>.' }
  const root = git(cwd, 'rev-parse', '--show-toplevel')
  const run = join(artifactDir(root), runId)
  if (!existsSync(join(run, 'state.json'))) return { status: 'FAILED', errorCode: 'INVALID_RUN', message: `No fast-path state for ${runId} in this repository.` }
  const state = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8'))
  const { contract, baseCommit, baseTree, protection, verify } = state
  state.checks += 1
  writeFileSync(join(run, 'state.json'), JSON.stringify(state, null, 2))
  const command = { source: state.verifySource, status: 'SKIPPED', exitCode: null, sandbox: 'HOST_UNSANDBOXED' }
  const evidence = { version: 1, backend: contract.backend, host: 'session', baseCommit, baseTree, candidateTree: null, files: [], command,
    review: { status: 'SKIPPED', reason: 'DETERMINISTIC_COVERAGE' }, remainingRisks: ['CALLER_DECLARED_COVERAGE', 'HOST_VERIFICATION', 'REMOTE_CI_UNVERIFIED'] }
  const result = { status: 'FAILED', runId, path: 'FAST', contract: { ...contract, risk: state.policy.risk, riskSignals: state.policy.signals, profile: 'DIRECT' }, evidence, delivery: { status: 'NOT_DELIVERED', ci: 'UNVERIFIED' } }
  const owned = []
  try {
    if (state.checks > contract.limits.maxAttempts) return Object.assign(result, { status: 'BLOCKED', errorCode: 'ATTEMPTS_EXHAUSTED', message: `The contract allows ${contract.limits.maxAttempts} checks; use the ladder.` })
    if (git(root, 'rev-parse', 'HEAD') !== baseCommit) return Object.assign(result, { status: 'BLOCKED', errorCode: 'HEAD_MOVED', message: 'HEAD changed since begin; start a new fast path.' })
    const blocked = activeRun(root)
    if (blocked) return Object.assign(result, blocked)
    const tree = withMutex(root, 'apply', () => snapshot(root, run, `candidate-${state.checks}`))
    const files = changed(root, baseTree, tree)
    Object.assign(evidence, { candidateTree: tree, files })
    const tampered = protectedChange(root, baseTree, tree, protection) ?? changedNpmScripts(root, baseTree, tree, verify)
    const denied = files.find((file) => !inScope(file, contract.scope) || inScope(file, contract.protectedPaths))
    if (tampered) return Object.assign(result, { message: `Modified protected file ${tampered}` })
    if (denied) return Object.assign(result, { message: `Contract forbids changes to ${denied}` })
    if (!files.length) return Object.assign(result, { message: 'No change in scope' })
    const vcwd = makeWorktree(root, run, `verify-${state.checks}`, baseCommit, tree)
    owned.push(vcwd)
    command.status = 'INCONCLUSIVE'
    let ran
    try { ran = await processRun(verify, [], { cwd: vcwd, shell: true, timeoutMs: contract.limits.timeoutMs, signal, terminate, env: sandboxEnv(root, vcwd) }) }
    catch (error) {
      if (['TIMEOUT', 'CANCELLED'].includes(error.code)) return Object.assign(result, { status: 'INCONCLUSIVE', errorCode: error.code, message: error.message.slice(-1000) })
      return Object.assign(result, { status: 'BLOCKED', errorCode: error.code ?? 'VERIFY_DID_NOT_RUN', message: error.message.slice(-1000) })
    }
    command.exitCode = ran.code
    if ([126, 127, 9009].includes(ran.code)) return Object.assign(result, { status: 'BLOCKED', errorCode: 'VERIFY_TOOL_UNAVAILABLE', message: `Verification tool could not start (exit ${ran.code})` })
    if (ran.code === null) return Object.assign(result, { status: 'INCONCLUSIVE', message: 'Verification produced no exit status' })
    command.status = ran.code === 0 ? 'PASSED' : 'FAILED'
    const after = snapshot(vcwd, run, `after-${state.checks}`)
    if (after !== tree && changed(vcwd, tree, after, baseTree).length) return Object.assign(result, { message: 'Verification changed repository files' })
    if (ran.code !== 0) return Object.assign(result, { message: `Verification exited ${ran.code}`, output: (ran.stdout + ran.stderr).slice(-4000) })
    // The verified tree must still be what the checkout holds; anything edited meanwhile was not verified.
    const now = withMutex(root, 'apply', () => snapshot(root, run, `final-${state.checks}`))
    if (now !== tree) return Object.assign(result, { status: 'CONFLICT', errorCode: 'SNAPSHOT_CHANGED', message: 'The checkout changed during verification; run check again.' })
    return Object.assign(result, { status: 'VERIFIED', delivery: { status: 'LOCAL_CHECKOUT', ci: 'UNVERIFIED' }, message: 'Verified in place. Remote CI is not verified.' })
  } finally {
    result.cleanup = removeOwned(root, owned)
    result.contract.status = result.status
    result.contract.evidenceRefs = [join(run, 'result.json')]
    // The session's own tokens are not observable here: one worker call, tokens UNKNOWN; no router or reviewer call.
    result.telemetry = usageEvidence([{ phase: 'worker', cell: 'session', attempt: state.checks, turns: [] }], state.checks, Date.now() - state.startedAt)
    writeFileSync(join(run, 'result.json'), JSON.stringify(result, null, 2))
    appendFileSync(join(root, '.model-ladder', 'history.jsonl'), `${JSON.stringify({ date: new Date().toISOString(), runtime: contract.backend, task: contract.task, ...result })}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, flag, value] = process.argv.slice(2)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  try {
    const result = mode === 'begin' && flag === '--input' ? begin(readInput([flag, value]))
      : mode === 'check' && flag === '--run' ? await check(value, { signal: controller.signal })
        : { status: 'ERROR', message: 'Usage: fast-path.mjs begin --input <contract.json> | check --run <fast-id>' }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = ['READY', 'VERIFIED'].includes(result.status) ? 0 : ['NOT_ELIGIBLE', 'BLOCKED'].includes(result.status) ? 2 : 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
