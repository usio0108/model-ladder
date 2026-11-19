// Separates two write conditions for the native verification sandbox. Fake data only. No agent, login or network.
// A. Host integrity: unauthorized writes change no host file, directory or later sandbox run.
// B. Operation denial: each unauthorized write itself returns an error.
// codex-sandbox-smoke.mjs still requires B. This file records A next to B and never turns a B failure into a pass.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { artifactDir } from '../../scripts/common.mjs'
import { sandboxVerification } from '../../scripts/codex-verify.mjs'

const parent = join(artifactDir(process.cwd()), 'verification')
mkdirSync(parent, { recursive: true })
const run = mkdtempSync(join(parent, 'host-integrity-'))
const cwd = join(run, 'fixture')
mkdirSync(cwd)
const marker = `host-integrity-${process.pid}-${Date.now()}`
const existing = join(run, 'existing-outside.txt')
writeFileSync(existing, 'host-original')
const targets = {
  appendExisting: existing,
  createInRun: join(run, `${marker}-new.txt`),
  createInHome: join(homedir(), `${marker}-home.txt`),
  createInVarTmp: `/var/tmp/${marker}-vartmp.txt`,
  createInTmp: `/tmp/${marker}-tmp.txt`,
  mkdirInRun: join(run, `${marker}-dir`),
}

// Runs inside the sandbox as parent and child. Reports each operation's own result.
const probe = (role) => `
const fs = require('fs'); const t = ${JSON.stringify(targets)}; const m = ${JSON.stringify(marker)}; const o = {};
const op = (k, f) => { try { f(); o[k] = 'ALLOWED' } catch (e) { o[k] = e.code || 'UNKNOWN' } };
op('appendExisting', () => fs.appendFileSync(t.appendExisting, m));
for (const k of ['createInRun', 'createInHome', 'createInVarTmp', 'createInTmp']) op(k, () => fs.writeFileSync(t[k], m));
op('mkdirInRun', () => fs.mkdirSync(t.mkdirInRun));
op('unlinkExisting', () => fs.unlinkSync(t.appendExisting));
op('symlinkWriteThrough', () => { fs.symlinkSync(t.appendExisting, 'link-${role}'); fs.appendFileSync('link-${role}', m) });
op('readBackShadow', () => { if (fs.readFileSync(t.createInRun, 'utf8') !== m) throw Object.assign(new Error(), { code: 'ABSENT' }) });
fs.writeFileSync('report-${role}.json', JSON.stringify(o));
if (${JSON.stringify(role)} === 'parent') {
  const r = require('child_process').spawnSync(process.execPath, ['probe-child.js'], { stdio: 'inherit' });
  process.exitCode = r.status;
}`
const later = `const fs = require('fs'); const t = ${JSON.stringify(targets)};
fs.writeFileSync('report-later.json', JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, p]) => [k, fs.existsSync(p) ? 'VISIBLE' : 'ABSENT']))))`

function grepHost(dir, depth = 4) {
  const hits = []
  const walk = (path, level) => {
    let entries
    try { entries = readdirSync(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (full === cwd) continue
      if (entry.name.includes(marker)) hits.push(full)
      else if (entry.isDirectory() && level < depth) walk(full, level + 1)
      else if (entry.isFile()) {
        try { if (statSync(full).size < 1 << 20 && readFileSync(full, 'utf8').includes(marker)) hits.push(full) } catch {}
      }
    }
  }
  walk(dir, 0)
  return hits
}

const result = { platform: process.platform, artifact: run, marker }
try {
  execFileSync('git', ['init', '-q'], { cwd })
  writeFileSync(join(cwd, 'probe-parent.js'), probe('parent'))
  writeFileSync(join(cwd, 'probe-child.js'), probe('child'))
  writeFileSync(join(cwd, 'probe-later.js'), later)
  const first = await sandboxVerification({ run, cwd, command: 'node probe-parent.js', timeoutMs: 20000 })
  const second = await sandboxVerification({ run, cwd, command: 'node probe-later.js', timeoutMs: 20000 })
  result.sandbox = [first.sandbox, second.sandbox]
  result.exitCodes = [first.code, second.code]
  const read = (name) => JSON.parse(readFileSync(join(cwd, name), 'utf8'))
  result.operations = { parent: read('report-parent.json'), child: read('report-child.json') }
  result.laterRun = read('report-later.json')

  const host = Object.fromEntries(Object.entries(targets).map(([k, p]) => [k, k === 'appendExisting'
    ? (existsSync(p) ? readFileSync(p, 'utf8') : 'DELETED') : (existsSync(p) ? 'PRESENT' : 'ABSENT')]))
  const leaks = [...new Set([run, homedir(), '/var/tmp', '/tmp'].flatMap((dir) => grepHost(dir)))]
  // Authorized fixture changes are what the runner would collect as the candidate.
  const candidate = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' }).trim().split('\n').map((line) => line.slice(3)).sort()
  result.host = host
  result.hostMarkerHits = leaks
  result.candidatePaths = candidate

  const hostIntact = host.appendExisting === 'host-original' && Object.entries(host).every(([k, v]) => k === 'appendExisting' || v === 'ABSENT')
  // The outside paths are hidden from the sandbox, so a later run must see none of them, shadow or host.
  const ephemeral = Object.values(result.laterRun).every((v) => v === 'ABSENT')
  const expectedCandidate = ['link-child', 'link-parent', 'probe-child.js', 'probe-later.js', 'probe-parent.js', 'report-child.json', 'report-later.json', 'report-parent.json']
  result.hostIntegrity = hostIntact && ephemeral && leaks.length === 0 && JSON.stringify(candidate) === JSON.stringify(expectedCandidate) ? 'PASS' : 'FAIL'
  const denied = ['EACCES', 'EPERM', 'EROFS', 'ENOENT']
  const all = [...Object.entries(result.operations.parent), ...Object.entries(result.operations.child)].filter(([k]) => k !== 'readBackShadow')
  result.operationDenial = all.every(([, v]) => denied.includes(v)) ? 'PASS' : 'FAIL'
  process.exitCode = result.hostIntegrity === 'PASS' ? 0 : 1
} catch (error) {
  result.error = error.message
  result.sandboxStatus = error.sandbox
  process.exitCode = error.sandbox === 'SANDBOX_UNAVAILABLE' ? 2 : 1
} finally {
  for (const p of [targets.createInHome, targets.createInVarTmp, targets.createInTmp]) if (existsSync(p)) result.cleanupNeeded = [...(result.cleanupNeeded ?? []), p]
  writeFileSync(join(run, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
