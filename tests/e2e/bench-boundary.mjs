// Benchmark boundary wrapper, version 1. Linux only. It is harness code. It never changes the frozen runners.
// The trusted controller (runner and native CLI) keeps its credentials. Every model-directed command and the runner's
// host-shell gate run under a policy that hides everything except the fixture.
//   - Codex: a managed requirements.toml, bind-mounted at /etc/codex in a user namespace, forces one permissions
//     profile. That replaces the legacy --sandbox modes that the frozen runners pass and that can read $CODEX_HOME.
//   - Gate: a `node` shim placed first on PATH runs the deterministic check in bwrap with only the worktree mounted.
// Usage: node bench-boundary.mjs --self-test           offline canaries, fake data only, no login or model
//        node bench-boundary.mjs --trial <dir> -- cmd  run a controller command under the boundary
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export const BOUNDARY_VERSION = 1
const required = (name) => {
  const value = process.env[name]
  if (!value || !existsSync(value)) throw new Error(`${name} must name an existing native executable`)
  return realpathSync(value)
}

// A deny-root profile. Only the workspace roots of each Codex call are writable. No tool network.
// `read` lists extra read-only paths, such as the fixture repository whose .git the worktrees point to.
export function requirementsToml(codexBinary, shims, read = []) {
  return `# model-ladder bench boundary v${BOUNDARY_VERSION}
default_permissions = "bench"
[allowed_permission_profiles]
bench = true
bench-ro = true
[permissions.bench.filesystem]
":root" = "deny"
":minimal" = "read"
${JSON.stringify(codexBinary)} = "read"
${JSON.stringify(dirname(realpathSync(process.execPath)))} = "read"
${JSON.stringify(shims)} = "read"
${read.map((path) => `${JSON.stringify(realpathSync(path))} = "read"\n`).join('')}[permissions.bench.filesystem.":workspace_roots"]
"." = "write"
[permissions.bench.network]
enabled = false
[permissions.bench-ro.filesystem]
":root" = "deny"
":minimal" = "read"
${JSON.stringify(codexBinary)} = "read"
${JSON.stringify(dirname(realpathSync(process.execPath)))} = "read"
${JSON.stringify(shims)} = "read"
${read.map((path) => `${JSON.stringify(realpathSync(path))} = "read"\n`).join('')}[permissions.bench-ro.filesystem.":workspace_roots"]
"." = "read"
[permissions.bench-ro.network]
enabled = false
`
}

// The forced profile ignores --sandbox. A role the runner starts read-only gets the read-only profile instead.
// The frozen runners pass `exec ... --sandbox read-only -`; the model cannot change that argv.
export function codexShim(native) {
  return `#!/bin/sh
# model-ladder bench boundary v${BOUNDARY_VERSION}
ro=; prev=
for a in "$@"; do [ "$prev" = --sandbox ] && [ "$a" = read-only ] && ro=1; prev=$a; done
if [ -n "$ro" ] && [ "$1" = exec ]; then shift; exec ${native} exec -c 'default_permissions="bench-ro"' "$@"; fi
exec ${native} "$@"
`
}

// Runs `node` in bwrap unless the caller is already inside the Codex or Claude tool sandbox, which forbid nested namespaces.
// Codex sets CODEX_SANDBOX_NETWORK_DISABLED and Claude sets SANDBOX_RUNTIME only for their own sandboxed children.
// controllerArgs never passes either to the controller.
export function nodeShim(realNode) {
  const prefix = dirname(dirname(realNode))
  return `#!/bin/sh
# model-ladder bench boundary v${BOUNDARY_VERSION}
if [ "$MODEL_LADDER_BENCH_CONFINED" = 1 ] || [ "$CODEX_SANDBOX_NETWORK_DISABLED" = 1 ] || [ "$SANDBOX_RUNTIME" = 1 ]; then exec ${realNode} "$@"; fi
exec bwrap --unshare-all --die-with-parent --new-session --clearenv \\
  --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \\
  --ro-bind ${prefix} ${prefix} --bind "$PWD" "$PWD" --tmpfs /tmp --proc /proc --dev /dev \\
  --setenv PATH ${prefix}/bin:/usr/bin:/bin --setenv HOME /tmp --setenv TMPDIR /tmp \\
  --setenv MODEL_LADDER_BENCH_CONFINED 1 --remount-ro / --chdir "$PWD" ${realNode} "$@"
`
}

// Claude managed settings for a controller whose credential and unrelated directories are `deny`.
// File-tool rules are checks inside the CLI. The Bash sandbox is the only OS boundary Claude applies itself.
export function claudeManagedSettings(deny) {
  return {
    permissions: {
      deny: deny.flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]),
      disableBypassPermissionsMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
    // Claude passes its own environment, API key included, to sandboxed commands unless a variable is denied here.
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { denyRead: deny },
      credentials: { envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'].map((name) => ({ name, mode: 'deny' })) } },
    allowManagedMcpServersOnly: true,
    allowedMcpServers: [],
  }
}

export function prepare(trial, read = [], { claude } = {}) {
  const codex = required('CODEX_BINARY')
  const etc = join(trial, 'boundary-etc')
  const shims = join(trial, 'boundary-bin')
  mkdirSync(etc, { recursive: true })
  mkdirSync(shims, { recursive: true })
  writeFileSync(join(etc, 'requirements.toml'), requirementsToml(codex, shims, read))
  writeFileSync(join(shims, 'node'), nodeShim(realpathSync(process.execPath)))
  writeFileSync(join(shims, 'codex'), codexShim(codex))
  for (const name of ['node', 'codex']) chmodSync(join(shims, name), 0o755)
  if (!claude) return { etc, shims }
  const claudeEtc = join(trial, 'boundary-claude-etc')
  mkdirSync(claudeEtc, { recursive: true })
  writeFileSync(join(claudeEtc, 'managed-settings.json'), JSON.stringify(claude, null, 2))
  return { etc, shims, claudeEtc }
}

// Candidate symlinks whose target leaves the worktree. The frozen runners collect and apply symlinks like any file,
// so the harness rejects a trial with any of these before delivery. A symlink carries a path, never target content.
export function escapingSymlinks(worktree) {
  const files = execFileSync('git', ['ls-files', '-coz', '--exclude-standard'], { cwd: worktree, encoding: 'utf8' }).split('\0').filter(Boolean)
  return files.flatMap((file) => {
    const path = join(worktree, file)
    if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return []
    const target = readlinkSync(path)
    const resolved = resolve(dirname(path), target)
    return resolved === worktree || resolved.startsWith(worktree + sep) ? [] : [{ path: file, target }]
  })
}

// The controller keeps the host view with a private /etc/codex. Credentials stay readable to it alone.
export function controllerArgs({ etc, shims, claudeEtc }, command, env = {}) {
  const etcEntries = readdirSync('/etc').flatMap((name) => ['--ro-bind', join('/etc', name), join('/etc', name)])
  const path = [shims, ...(env.PATH ?? process.env.PATH ?? '').split(':').filter((dir) => dir && dir !== shims)].join(':')
  const keep = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_BINARY', 'CLAUDE_BINARY', 'LANG', 'TERM', 'MODEL_LADDER_NO_UPDATE_CHECK']
  const vars = Object.entries({ ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), ...env, PATH: path, CODEX_BINARY: join(shims, 'codex') })
  return ['--dev-bind', '/', '/', '--tmpfs', '/etc', ...etcEntries, '--ro-bind', etc, '/etc/codex',
    ...(claudeEtc ? ['--ro-bind', claudeEtc, '/etc/claude-code'] : []),
    // A private PID namespace: when the controller dies, the kernel ends every process in it,
    // including the runner's Codex children that sit in their own process groups.
    '--unshare-pid', '--proc', '/proc', '--die-with-parent',
    '--', '/usr/bin/env', '-i', ...vars.map(([k, v]) => `${k}=${v}`), ...command]
}

async function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'bench-boundary-'))
  const trial = join(root, 'trial')
  const ws = join(trial, 'fixture')
  const secrets = join(root, 'controller')
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(secrets, 'codex'), { recursive: true })
  mkdirSync(join(secrets, 'claude'), { recursive: true })
  const canaries = { codexAuth: join(secrets, 'codex', 'auth.json'), claudeAuth: join(secrets, 'claude', '.credentials.json'), outside: join(root, 'unrelated.txt') }
  for (const [name, path] of Object.entries(canaries)) writeFileSync(path, `fake-${name}`)
  const boundary = prepare(trial)
  const env = { HOME: join(secrets, 'home'), CODEX_HOME: join(secrets, 'codex'), CLAUDE_CONFIG_DIR: join(secrets, 'claude') }
  mkdirSync(env.HOME)
  // Same probe for Codex tool commands and for the gate. Reads canaries, writes inside and outside, opens a socket.
  writeFileSync(join(ws, 'probe.mjs'), `import fs from 'node:fs'; import net from 'node:net'
const o = {}; for (const [k, p] of Object.entries(${JSON.stringify(canaries)})) { try { fs.readFileSync(p); o[k] = 'READABLE' } catch (e) { o[k] = e.code } }
try { fs.writeFileSync('inside.txt', process.argv[2]); o.insideWrite = 'OK' } catch (e) { o.insideWrite = e.code }
try { fs.appendFileSync(${JSON.stringify(canaries.outside)}, 'x'); o.outsideWrite = 'ALLOWED' } catch (e) { o.outsideWrite = e.code }
o.envSecrets = Object.keys(process.env).filter((k) => /CODEX_HOME|CLAUDE_CONFIG_DIR|TOKEN|KEY|SECRET/.test(k))
o.network = await new Promise((r) => { const s = net.connect(443, '1.1.1.1'); s.once('connect', () => { s.destroy(); r('ALLOWED') }); s.once('error', (e) => r(e.code)); s.setTimeout(3000, () => { s.destroy(); r('TIMEOUT') }) })
fs.writeFileSync('report-' + process.argv[2] + '.json', JSON.stringify(o))`)
  // Reports go to a file: Node's socket stdio is discarded inside the Codex sandbox (see scripts/codex-verify.mjs).
  const inBoundary = (command, name) => {
    const r = spawnSync('bwrap', controllerArgs(boundary, [...command, name], env), { cwd: ws, encoding: 'utf8', timeout: 60000 })
    const file = join(ws, `report-${name}.json`)
    return { status: r.status, report: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null, stderr: r.stderr.slice(-400) }
  }
  const codex = process.env.CODEX_BINARY
  const result = { version: BOUNDARY_VERSION, root, cases: {} }
  for (const mode of ['workspace-write', 'read-only', 'danger-full-access']) {
    result.cases[`codex sandbox_mode=${mode}`] = inBoundary([codex, 'sandbox', '-c', `sandbox_mode="${mode}"`, '--', 'node', 'probe.mjs'], mode)
  }
  // The frozen runner's gate: a host shell that resolves `node` from PATH.
  result.cases.gate = inBoundary(['/bin/sh', '-c', 'node probe.mjs "$0"'], 'gate')
  const hostIntact = Object.entries(canaries).every(([k, p]) => readFileSync(p, 'utf8') === `fake-${k}`)
  execFileSync(process.execPath, ['probe.mjs', 'control'], { cwd: ws, env: { ...process.env, ...env } })
  result.cases.controlWithoutBoundary = { report: JSON.parse(readFileSync(join(ws, 'report-control.json'), 'utf8')) }

  const denied = (v) => ['ENOENT', 'EACCES', 'EPERM', 'EROFS'].includes(v)
  const confined = (r) => r.report && ['codexAuth', 'claudeAuth', 'outside'].every((k) => denied(r.report[k])) && r.report.insideWrite === 'OK' && r.report.network !== 'ALLOWED'
  result.checks = {
    codexToolsConfined: ['workspace-write', 'read-only', 'danger-full-access'].every((m) => confined(result.cases[`codex sandbox_mode=${m}`])),
    gateConfined: confined(result.cases.gate) && result.cases.gate.report.envSecrets.length === 0,
    controlReadsCanaries: result.cases.controlWithoutBoundary.report.codexAuth === 'READABLE',
    hostCanariesIntact: hostIntact,
  }
  // Operation denial is reported, not required: the Codex profile turns outside writes into discarded private writes.
  result.operationDenial = Object.fromEntries(Object.entries(result.cases).filter(([k]) => k !== 'controlWithoutBoundary').map(([k, r]) => [k, r.report?.outsideWrite ?? null]))
  result.status = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL'
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.status === 'PASS' ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) await selfTest()
  else if (process.argv[2] === '--trial' && process.argv.includes('--')) {
    const split = process.argv.indexOf('--')
    const read = process.argv.slice(4, split).flatMap((arg, i, all) => all[i - 1] === '--read' ? [arg] : [])
    const r = spawnSync('bwrap', controllerArgs(prepare(process.argv[3], read), process.argv.slice(split + 1)), { stdio: 'inherit' })
    process.exitCode = r.status ?? 1
  } else {
    console.error('Usage: node bench-boundary.mjs --self-test | --trial <dir> [--read <path>]... -- <command...>')
    process.exitCode = 2
  }
}
