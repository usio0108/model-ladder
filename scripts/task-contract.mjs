import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { canonical, isProtected } from '../hooks/guard.mjs'

const profiles = ['DIRECT', 'MANAGED', 'ISOLATED']
const effects = ['destructive', 'credentials', 'security', 'network', 'deployment', 'migration', 'hard-rollback']
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0
const choice = (value, values, field) => {
  if (!values.includes(value)) throw new Error(`Invalid contract ${field}`)
  return value
}
const list = (value, field) => {
  if (!Array.isArray(value) || value.some((item) => !text(item))) throw new Error(`Contract ${field} must be an array of nonempty strings`)
  return [...new Set(value)]
}
const limit = (value, max, field) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Contract ${field} must be an integer between 1 and ${max}`)
  return value
}
const reserved = new Set(['.git', '.model-ladder'])
const literalPath = (path) => {
  if (path.split('/').some((part) => !part || reserved.has(part.toLowerCase()) || /[. ]$|[\\:*?<>|"\u0000-\u001f]|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) || /^\.claude\/worktrees(?:\/|$)/i.test(path)) {
    throw new Error(`Invalid repository-relative contract path: ${JSON.stringify(path)}`)
  }
  return path
}

export function parseTaskContract(input) {
  if (!object(input) || input.version !== 1) throw new Error('Unsupported task contract version. Expected version 1')
  if (!text(input.id) || !/^[a-zA-Z0-9][\w.-]{0,127}$/.test(input.id)) throw new Error('Contract id must be a safe task identifier')
  if (!text(input.task)) throw new Error('Contract task description is required')
  if (!text(input.repository) || !isAbsolute(input.repository)) throw new Error('Contract repository must be an absolute local path')
  if (input.allowTests !== undefined && typeof input.allowTests !== 'boolean') throw new Error('Contract allowTests must be boolean')
  if (input.limits !== undefined && !object(input.limits)) throw new Error('Contract limits must be an object')
  const allowed = new Set(['version', 'id', 'task', 'repository', 'backend', 'scope', 'protectedPaths', 'acceptance', 'effects', 'coverage', 'complexity', 'profile', 'limits', 'allowTests'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Unknown task contract field')
  if (Object.keys(input.limits ?? {}).some((key) => !['maxAttempts', 'timeoutMs'].includes(key))) throw new Error('Unknown task contract resource limit')
  return {
    version: 1, id: input.id, task: input.task.trim(), repository: input.repository,
    backend: choice(input.backend ?? 'codex', ['codex', 'claude'], 'backend'),
    scope: list(input.scope ?? [], 'scope').map(literalPath),
    protectedPaths: list(input.protectedPaths ?? [], 'protectedPaths').map(literalPath),
    acceptance: list(input.acceptance ?? [], 'acceptance'),
    effects: list(input.effects ?? [], 'effects').map((effect) => choice(effect, effects, 'effect')),
    coverage: choice(input.coverage ?? 'unknown', ['unknown', 'partial', 'complete'], 'coverage'),
    complexity: choice(input.complexity ?? 'unknown', ['unknown', 'small', 'complex'], 'complexity'),
    profile: choice(input.profile ?? 'DIRECT', profiles, 'profile'),
    allowTests: input.allowTests === true,
    limits: { maxAttempts: limit(input.limits?.maxAttempts ?? 2, 8, 'maxAttempts'), timeoutMs: limit(input.limits?.timeoutMs ?? 600000, 3600000, 'timeoutMs') },
  }
}

const pathKey = (path) => process.platform === 'win32' ? path.toLowerCase() : path
export function inScope(file, scope) {
  const path = pathKey(file)
  return scope.some((entry) => path === pathKey(entry) || path.startsWith(`${pathKey(entry)}/`))
}

const sensitivePath = /(?:^|\/)(?:\.github|\.claude|\.codex|\.aws|\.ssh|\.env(?:\.[^/]+)?|migrations?|deploy(?:ments?)?|secrets?|credentials?)(?:[/.]|$)|(?:^|\/)(?:auth(?:entication|orization)?|permissions?|sandbox|security|crypto|access-control)(?:[._/-]|$)/i
const sensitiveTask = /\b(?:drop|truncate|wipe|delete|destroy|rm\s+-|migrat\w*|credential\w*|secret\w*|sandbox|auth(?:entication|orization)?|permissions?|deploy\w*|publish\w*|production|release|push|upload|download|curl|webhook|security)\b|(?:刪除|清空|憑證|密鑰|權限|遷移|部署|發布|上傳|外部網路)/iu

export function taskPolicy(contract, root, protectedPatterns, { configuredNetwork = false, requireSandbox = false } = {}) {
  // canonical uses realpathSync.native, which also expands Windows 8.3 names (RUNNER~1) that the JS realpath keeps on Node 20.
  if (!existsSync(contract.repository) || pathKey(canonical(root)) !== pathKey(canonical(contract.repository))) throw new Error('Contract repository does not match the current Git root')
  for (const path of [...contract.scope, ...contract.protectedPaths]) {
    const resolved = relative(canonical(root), canonical(resolve(root, path)))
    if (!resolved || isAbsolute(resolved) || resolved === '..' || resolved.startsWith(`..${sep}`)) throw new Error(`Contract path escapes the repository: ${JSON.stringify(path)}`)
  }
  const signals = [...contract.effects]
  if (configuredNetwork) signals.push('configured-network')
  if (sensitiveTask.test(contract.task)) signals.push('sensitive-task')
  if (contract.scope.some((path) => sensitivePath.test(path))) signals.push('sensitive-path')
  if (contract.scope.some((path) => isProtected(path, protectedPatterns) || isProtected(`${path}/.scope-probe`, protectedPatterns) ||
    contract.protectedPaths.some((entry) => inScope(path, [entry]) || inScope(entry, [path])))) signals.push('protected-path')
  const risk = signals.length ? 'HIGH' : contract.scope.length ? contract.scope.length === 1 && /\.[a-z0-9]+$/i.test(contract.scope[0]) && contract.coverage === 'complete' ? 'LOW' : 'MODERATE' : 'UNKNOWN'
  const minimum = requireSandbox || risk === 'HIGH' ? 'ISOLATED' : risk === 'LOW' && contract.complexity !== 'complex' ? 'DIRECT' : 'MANAGED'
  const profile = profiles[Math.max(profiles.indexOf(contract.profile), profiles.indexOf(minimum))]
  return { risk, signals, profile, review: profile === 'ISOLATED' || (profile === 'MANAGED' && (contract.coverage !== 'complete' || contract.complexity !== 'small')) }
}

// Leave a missing stage or token field unknown. A provider-reported zero is valid.
export function usageEvidence(usage, attempts, durationMs) {
  const sum = (calls, key) => {
    const turns = calls.flatMap(({ turns }) => turns)
    return calls.length && calls.every((call) => call.turns.length) && turns.every((turn) => Number.isSafeInteger(turn[key]) && turn[key] >= 0)
      ? turns.reduce((total, turn) => total + turn[key], 0) : 'UNKNOWN'
  }
  const measure = (calls) => ({ calls: calls.length, inputTokens: sum(calls, 'input_tokens'), outputTokens: sum(calls, 'output_tokens'), cachedInputTokens: sum(calls, 'cached_input_tokens') })
  return { durationMs, attempts, total: measure(usage), router: measure(usage.filter(({ phase }) => phase === 'route')), worker: measure(usage.filter(({ phase }) => phase === 'worker')), verifier: measure(usage.filter(({ phase }) => phase === 'verify')), retry: measure(usage.filter(({ attempt }) => attempt > 1)) }
}

export function failureKind(error) {
  if (error.code === 'TERMINATION_FAILED') return 'TERMINATION_FAILURE'
  if (error.code === 'USAGE_LIMIT') return 'QUOTA_EXHAUSTED'
  if (error.code === 'TIMEOUT' || error.code === 'CANCELLED') return error.code
  if (typeof error.code === 'string' && error.code.startsWith('VERIFY_SANDBOX_')) return 'SANDBOX_DENIAL'
  if (error.code === 'VERIFY_TOOL_UNAVAILABLE' || /not authenticated|unsupported model|model.{0,35}(?:not available|not found)|missing dependenc|node_modules is missing/i.test(error.message)) return 'ENVIRONMENT_FAILURE'
  if (/context.{0,30}(?:length|window|limit)|maximum context/i.test(error.message)) return 'CONTEXT_LIMIT'
  if (/permission denied|access denied|\bEPERM\b|\bEACCES\b/i.test(error.message)) return 'PERMISSION_FAILURE'
  if (/sandbox/i.test(error.message)) return 'SANDBOX_DENIAL'
  return 'TOOL_FAILURE'
}
