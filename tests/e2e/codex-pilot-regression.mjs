// Offline security regression for codex-pilot.mjs, using the mock provider only. Linux only. Fake data only.
// Usage: CODEX_BINARY=<native codex> node tests/e2e/codex-pilot-regression.mjs --sources <bundle|git dir> --out <dir>
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const flag = (name) => process.argv[process.argv.indexOf(name) + 1]
const sources = resolve(flag('--sources'))
const out = resolve(flag('--out'))
mkdirSync(out, { recursive: true })

function pilot(name, extra, env = {}) {
  const dir = join(out, name)
  const run = spawnSync(process.execPath, [join(here, 'codex-pilot.mjs'), '--mock', '--sources', sources, '--out', dir, ...extra],
    { encoding: 'utf8', timeout: 900000, env: { ...process.env, ...env } })
  let record = null
  try { record = JSON.parse(readFileSync(join(dir, 'pilot.json'), 'utf8')) } catch {}
  return { exit: run.status, record, stderr: run.stderr.slice(-600) }
}
const arm = (r, name) => r.record?.trials.find((t) => t.arm === name)
const cases = []
const check = (name, r, assertions) => {
  const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([k]) => k)
  cases.push({ name, status: failed.length ? 'FAIL' : 'PASS', exit: r.exit, driverStatus: r.record?.status, reason: r.record?.reason, failed })
  console.log(JSON.stringify(cases.at(-1)))
}

// 1. Full flow under the boundary: every arm delivers, nothing leaks, runner exits match status, no process survives.
let r = pilot('clean', [])
check('clean flow, all arms', r, {
  completed: r.exit === 0 && r.record?.status === 'COMPLETED',
  fourTrials: r.record?.trials.length === 4,
  evaluatorPass: r.record?.trials.every((t) => t.verification.evaluator.pass && t.verification.evaluator.probe === 'ENOENT'),
  workerProbeNoLeak: r.record?.trials.every((t) => !t.security.markerLeaks.length && t.security.hostCanaryIntact),
  runnerExitConsistent: r.record?.trials.filter((t) => t.arm !== 'A_NATIVE').every((t) => t.runnerExitConsistent && t.runnerStatus === 'VERIFIED'),
  inScopeOnly: r.record?.trials.every((t) => t.git.outOfScope.length === 0),
  tokensRecorded: r.record?.trials.every((t) => Number.isInteger((t.usage.total ?? t.usage).inputTokens)),
  noSurvivors: r.record?.trials.every((t) => !t.security.survivors.length),
})

// 2. Gate isolation: the worker never reads the canary, so only the gate's import can reach it.
r = pilot('gate-bounded', ['--scenario', 'gate-only', '--arms', 'C_V2_DIRECT'])
check('gate under shim stays confined', r, { completed: r.exit === 0, verified: arm(r, 'C_V2_DIRECT')?.runnerStatus === 'VERIFIED' })
r = pilot('gate-unbounded', ['--scenario', 'gate-only', '--arms', 'C_V2_DIRECT', '--no-boundary'])
check('negative control: unconfined gate is caught', r, { stopped: r.exit === 3 && r.record?.status === 'SECURITY_STOP', hostChanged: /HOST_CANARY_CHANGED/.test(r.record?.reason ?? '') })

// 3. Negative control: the worker's own read without the wrapper.
r = pilot('worker-unbounded', ['--arms', 'A_NATIVE', '--no-boundary'])
check('negative control: unconfined worker is caught', r, { stopped: r.exit === 3, leak: /CREDENTIAL_CANARY_LEAK/.test(r.record?.reason ?? ''), oneTrial: r.record?.trials.length === 1 })

// 4. Symlink escape stops the pilot before the next trial, for the native and a runner arm.
for (const name of ['A_NATIVE', 'B_LEGACY']) {
  r = pilot(`symlink-${name}`, ['--scenario', 'symlink', '--arms', `${name},C_V2_DIRECT`])
  check(`symlink escape stops ${name}`, r, { stopped: r.exit === 3 && /ESCAPING_SYMLINK/.test(r.record?.reason ?? ''), noNextTrial: r.record?.trials.length === 1 })
}

// 5. Reviewer tamper: the legacy reviewer has workspace write by design. Its tree check must withhold delivery.
r = pilot('reviewer-tamper', ['--scenario', 'reviewer-tamper', '--arms', 'B_LEGACY'])
const legacy = arm(r, 'B_LEGACY')
check('reviewer tamper withheld', r, { completed: r.exit === 0, notVerified: legacy?.runnerStatus !== 'VERIFIED', checkoutAtSeed: legacy?.git.deliveredTree === legacy?.git.seedTree })

// 6. Timeout: the driver stops a hung trial and no process from it survives.
r = pilot('timeout', ['--scenario', 'hang', '--arms', 'A_NATIVE,C_V2_DIRECT', '--trial-timeout-ms', '15000'])
check('timeout leaves no process', r, {
  completed: r.exit === 0, timedOut: r.record?.trials.every((t) => t.exitCode === 'TIMEOUT'), noSurvivors: r.record?.trials.every((t) => !t.security.survivors.length),
  tokensUnknownNotZero: r.record?.trials.every((t) => [t.usage.total?.inputTokens ?? t.usage.inputTokens].every((v) => v === 'UNKNOWN')),
})

// 7. Sandbox unavailable: a bwrap that cannot start must block before any trial.
const fake = join(out, 'no-bwrap')
mkdirSync(fake, { recursive: true })
writeFileSync(join(fake, 'bwrap'), '#!/bin/sh\necho "bwrap: unavailable" >&2\nexit 1\n')
chmodSync(join(fake, 'bwrap'), 0o755)
r = pilot('sandbox-unavailable', [], { PATH: `${fake}:${process.env.PATH}` })
check('sandbox unavailable fails closed', r, { blocked: r.exit === 2 && r.record?.status === 'BLOCKED', noTrials: r.record?.trials.length === 0 })

const summary = { status: cases.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL', cases }
writeFileSync(join(out, 'regression.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ status: summary.status }))
process.exitCode = summary.status === 'PASS' ? 0 : 1
