// Remote delivery evidence. Reads GitHub check runs and branch protection over the official REST API, detects the
// official cloud CLIs, and prints a cloud task handoff. It never pushes, merges, approves or starts a cloud task.
// Any state it cannot read is UNKNOWN or UNAVAILABLE, never a pass.
//   node ci-evidence.mjs ci [--ref <sha|branch>] [--branch <base>]
//   node ci-evidence.mjs cloud
//   node ci-evidence.mjs handoff --input <contract.json> [--env <codex cloud env id>]
// GITHUB_TOKEN or GH_TOKEN is used when set; it is sent only to api.github.com and never printed.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { git, repoRoot, tryGit } from './common.mjs'
import { readInput } from './codex-run.mjs'
import { parseTaskContract } from './task-contract.mjs'

const FAILED = ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']
const PASSED = ['success', 'neutral', 'skipped']

export function githubRepo(root) {
  const origin = tryGit(root, 'remote', 'get-url', 'origin')
  const match = origin.ok && /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(origin.out)
  return match ? { owner: match[1], repo: match[2] } : null
}

// One status for a set of check runs: any failure fails, anything unfinished is pending, none at all is unknown.
export function checksStatus(runs) {
  if (!runs.length) return 'UNKNOWN'
  if (runs.some((run) => FAILED.includes(run.conclusion))) return 'FAIL'
  if (runs.some((run) => run.status !== 'completed')) return 'PENDING'
  return runs.every((run) => PASSED.includes(run.conclusion)) ? 'PASS' : 'UNKNOWN'
}

export async function ciEvidence({ owner, repo, ref, branch, token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN, fetchImpl = fetch }) {
  const get = async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'model-ladder', ...(token && { authorization: `Bearer ${token}` }) } })
    let body = null
    try { body = await response.json() } catch { /* no JSON body */ }
    return { status: response.status, ok: response.ok, body }
  }
  const evidence = { ref, status: 'UNKNOWN', checks: [], required: { status: 'UNKNOWN', contexts: [] } }
  try {
    const at = `/commits/${encodeURIComponent(ref)}`
    for (let page = 1; page <= 10; page++) {
      const runs = await get(`${at}/check-runs?per_page=100&page=${page}`)
      if (!runs.ok) return { ...evidence, reason: `check runs unavailable (HTTP ${runs.status})` }
      evidence.checks.push(...runs.body.check_runs.map(({ name, status, conclusion }) => ({ name, status, conclusion })))
      if (evidence.checks.length >= runs.body.total_count || !runs.body.check_runs.length) break
    }
    // Legacy commit statuses (for example external CI) count as checks too.
    const statuses = await get(`${at}/status`)
    if (!statuses.ok) return { ...evidence, checks: evidence.checks, reason: `commit statuses unavailable (HTTP ${statuses.status})` }
    evidence.checks.push(...(statuses.body.statuses ?? []).map(({ context, state }) => ({ name: context, status: state === 'pending' ? 'in_progress' : 'completed', conclusion: state === 'pending' ? null : state })))
    evidence.status = checksStatus(evidence.checks)
    if (branch) {
      const protection = await get(`/branches/${encodeURIComponent(branch)}/protection/required_status_checks`)
      // GitHub also answers 404 when the token cannot read protection; only its explicit message means unprotected.
      if (protection.status === 404 && /not protected/i.test(protection.body?.message ?? '')) evidence.required = { status: 'NOT_PROTECTED', contexts: [] }
      else if (!protection.ok) evidence.required = { status: 'UNKNOWN', contexts: [], reason: `branch protection unreadable (HTTP ${protection.status})` }
      else {
        const contexts = protection.body.contexts ?? []
        const results = contexts.map((name) => checksStatus(evidence.checks.filter((check) => check.name === name)))
        evidence.required = { status: results.includes('FAIL') ? 'FAIL' : results.every((s) => s === 'PASS') ? 'PASS' : 'PENDING', contexts }
      }
    }
  } catch (error) { return { ...evidence, status: 'UNKNOWN', reason: error.message } }
  return evidence
}

// Ready only when local verification passed, remote CI passed and no known required check is failing or missing.
export function deliveryGate(local, ci) {
  const reasons = []
  if (local !== 'VERIFIED') reasons.push(`local status ${local}`)
  if (ci?.status !== 'PASS') reasons.push(`CI ${ci?.status ?? 'UNKNOWN'}`)
  if (['FAIL', 'PENDING'].includes(ci?.required?.status)) reasons.push(`required checks ${ci.required.status}`)
  return { ready: !reasons.length, status: reasons.length ? 'NOT_READY' : 'READY', reasons, requiredChecks: ci?.required?.status ?? 'UNKNOWN' }
}

// Windows npm installs are .cmd shims that only a shell can start; the arguments here are fixed literals.
const help = (command, args) => process.platform === 'win32'
  ? spawnSync(`"${command}" ${args.join(' ')}`, { encoding: 'utf8', timeout: 20000, shell: true })
  : spawnSync(command, args, { encoding: 'utf8', timeout: 20000 })
const binary = (backend) => backend === 'codex' ? process.env.CODEX_BINARY ?? 'codex' : process.env.CLAUDE_BINARY ?? 'claude'
export function cloudCapability(run = help, backends = ['codex', 'claude']) {
  const probe = (command, args, test) => {
    const result = run(command, args)
    return result.status === 0 && test(`${result.stdout}${result.stderr}`)
  }
  return {
    ...(backends.includes('codex') && { codex: probe(binary('codex'), ['cloud', 'exec', '--help'], (text) => /--env/.test(text)) ? 'AVAILABLE_EXPERIMENTAL' : 'UNAVAILABLE' }),
    ...(backends.includes('claude') && { claude: probe(binary('claude'), ['--help'], (text) => /--cloud\b/.test(text)) ? 'AVAILABLE' : 'UNAVAILABLE' }),
    authentication: 'UNVERIFIED',
  }
}

export function cloudHandoff(contract, { env, capability }) {
  const brief = [`Task ${contract.id}: ${contract.task}`, `Edit only: ${contract.scope.join(', ') || '(scope required)'}`,
    ...(contract.protectedPaths.length ? [`Do not edit: ${contract.protectedPaths.join(', ')}`] : []),
    ...contract.acceptance.map((item, index) => `Acceptance ${index + 1}: ${item}`),
    'Open a pull request. Do not merge, push to the default branch, deploy or change branch protection. GitHub CI decides readiness.'].join('\n')
  const state = capability[contract.backend]
  if (state !== 'AVAILABLE' && state !== 'AVAILABLE_EXPERIMENTAL') return { status: 'UNAVAILABLE', backend: contract.backend, message: `The ${contract.backend} CLI on this machine has no official cloud command.`, brief }
  if (!contract.scope.length) return { status: 'BLOCKED', errorCode: 'SCOPE_REQUIRED', brief }
  if (contract.backend === 'codex' && !env) return { status: 'BLOCKED', errorCode: 'CLOUD_ENV_REQUIRED', message: 'Pass --env with a Codex Cloud environment ID (see codex cloud).', brief }
  const command = contract.backend === 'codex' ? [binary('codex'), 'cloud', 'exec', '--env', env, brief] : [binary('claude'), '--cloud', brief]
  return { status: 'HANDOFF_READY', backend: contract.backend, cloud: state, command, brief,
    message: 'Run the command yourself after signing in. Track it with codex cloud status <task> or the claude.ai/code session, then run ci-evidence.mjs ci on the pull request head.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  try {
    let result
    if (args[0] === 'ci') {
      const root = repoRoot()
      const target = githubRepo(root)
      result = target ? await ciEvidence({ ...target, ref: flag('--ref') ?? git(root, 'rev-parse', 'HEAD'), branch: flag('--branch') }) : { status: 'UNKNOWN', reason: 'origin is not a GitHub repository' }
      // --local <status>: the local result (for example a fast-path VERIFIED) to combine with CI into a delivery gate.
      if (flag('--local')) result.delivery = deliveryGate(flag('--local'), result)
    } else if (args[0] === 'cloud') result = cloudCapability()
    else if (args[0] === 'handoff') {
      const contract = parseTaskContract(readInput(['--input', flag('--input')]).contract)
      result = cloudHandoff(contract, { env: flag('--env'), capability: cloudCapability(help, [contract.backend]) })
    } else result = { status: 'ERROR', message: 'Usage: ci-evidence.mjs ci [--ref r] [--branch b] [--local <status>] | cloud | handoff --input <contract.json> [--env id]' }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = ['PASS', 'HANDOFF_READY'].includes(result.status) || args[0] === 'cloud' ? 0 : ['BLOCKED', 'UNAVAILABLE', 'PENDING'].includes(result.status) ? 2 : 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
