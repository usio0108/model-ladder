import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, runLadder } from '../../scripts/codex-run.mjs'
import { artifactDir } from '../../scripts/common.mjs'
import { renderLive } from '../../scripts/codex-live.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const evidenceRoot = artifactDir(repo)
mkdirSync(evidenceRoot, { recursive: true })
const root = mkdtempSync(join(evidenceRoot, 'codex-smoke-'))
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
const model = process.env.MODEL_LADDER_SMOKE_MODEL ?? 'gpt-6-luna'
const effort = process.env.MODEL_LADDER_SMOKE_EFFORT ?? 'low'
git('init', '-q')
git('config', 'user.name', 'model-ladder smoke')
git('config', 'user.email', 'smoke@example.test')
mkdirSync(join(root, '.codex'))
writeFileSync(join(root, '.gitignore'), '.model-ladder/\n')
writeFileSync(join(root, 'greeting.mjs'), 'export default "Wellcome"\n')
writeFileSync(join(root, 'greeting.test.mjs'), 'import assert from "node:assert/strict"\nimport greeting from "./greeting.mjs"\nassert.equal(greeting, "Welcome")\n')
writeFileSync(join(root, '.codex/model-ladder.json'), JSON.stringify({ router: DEFAULTS.router, verifier: DEFAULTS.verifier, tiers: [{ model, efforts: [effort], maxEffortJump: 1 }], maxAttempts: 1, verify: 'node --test greeting.test.mjs' }))
git('add', '-A')
git('commit', '-qm', 'smoke fixture')
const rows = {}
const result = await runLadder({ task: 'Fix the typo in greeting.mjs so the existing greeting test passes. Do not modify tests.' }, { cwd: root, onProgress: (text) => {
  console.error(text)
  const live = JSON.parse(readFileSync(join(root, '.model-ladder/live.json'), 'utf8'))
  const active = live.agents.find((agent) => agent.endedAt === null && ['worker', 'verify'].includes(agent.phase))
  if (active) rows[active.phase] = { expectedMs: live.expected.phases[active.phase], frame: renderLive(live) }
} })
const evidence = join(evidenceRoot, `codex-smoke-${Date.now()}.json`)
writeFileSync(evidence, JSON.stringify({ fixture: root, model, effort, result, rows }, null, 2) + '\n')
console.log(JSON.stringify({ fixture: root, evidence, ...result }, null, 2))
if (result.status === 'VERIFIED') {
  assert.match(readFileSync(join(root, 'greeting.mjs'), 'utf8'), /Welcome/)
  assert.equal(git('diff', '--cached').length, 0)
  for (const phase of ['worker', 'verify']) {
    assert.ok(Number.isFinite(rows[phase]?.expectedMs) && rows[phase].expectedMs > 0, `${phase} lacked a first-run estimate; evidence: ${evidence}`)
    // The time column comes before the task column, so the elapsed/expected cell precedes the phase label.
    assert.match(rows[phase].frame, new RegExp(`\\d+s/\\S+\\s+${phase}:`),`${phase} row did not show elapsed/expected; evidence: ${evidence}`)
  }
  rmSync(root, { recursive: true, force: true })
} else process.exitCode = 1
