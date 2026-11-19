import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { isAbsolute, join, delimiter } from 'node:path'
import { EnvironmentError, processRun } from './codex-exec.mjs'

const unavailable = (detail, evidence = {}) => sandboxError('SANDBOX_UNAVAILABLE', detail, evidence)
const sandboxError = (sandbox, detail, evidence) => Object.assign(new EnvironmentError(detail), { code: `VERIFY_${sandbox}`, sandbox, sandboxEvidence: evidence })
const filesystemDenials = ['EACCES', 'EPERM', 'ENOENT']
const networkDenials = ['EACCES', 'EPERM', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']
// Codex's Linux seccomp hides the socket type of the inherited stdio, so Node children write into a black hole.
// FIFOs in the private scratch dir give the command real pipes. stdout and stderr stay separate and the exit code is kept.
const fifoRelay = 'd=$(mktemp -d) && mkfifo "$d/o" "$d/e" || exit 125; cat "$d/o" & cat "$d/e" >&2 & /bin/sh -c "$1" >"$d/o" 2>"$d/e"; s=$?; wait; rm -rf "$d"; exit $s'

function confirmHostListener(port, marker) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let data = ''
    socket.once('connect', () => socket.write('control'))
    socket.setEncoding('utf8').on('data', (chunk) => { data += chunk })
    socket.setTimeout(1000, () => socket.destroy(new Error('Host loopback control timed out')))
    socket.once('error', reject)
    socket.once('end', () => data === marker ? resolve() : reject(new Error('Host loopback control received the wrong response')))
  })
}

function nativeExecutable() {
  const executable = process.env.CODEX_BINARY ?? (process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (isAbsolute(executable)) return executable
  return (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
    .map((dir) => join(dir, executable)).find(existsSync)
}

// Launcher configuration resolves outside the repository. The shell starts only inside the native policy.
export async function sandboxVerification({ run, cwd, command, signal, timeoutMs, executable, terminate }) {
  const binary = executable?.command ?? nativeExecutable()
  if (!binary || !existsSync(binary)) throw unavailable('Native Codex sandbox launcher was not found')
  const launcher = join(run, 'verify-launcher')
  mkdirSync(launcher, { recursive: true })
  const scratch = join(launcher, 'tmp')
  mkdirSync(scratch, { recursive: true })
  const marker = randomUUID()
  const canary = join(run, `verify-private-${marker}`)
  writeFileSync(canary, marker, { flag: 'wx' })
  const node = realpathSync(process.execPath)
  const profile = `ladder-verify-${randomUUID()}`
  const settings = `permissions.${profile}`
  // The Linux launcher re-executes its own binary inside bwrap, so that one file must stay readable.
  // An npm shim resolves to its .js file, not the native binary; set CODEX_BINARY to the native executable there.
  const filesystem = { ':root': 'deny', ':minimal': 'read', [node]: 'read', [realpathSync(binary)]: 'read', [launcher]: 'read', [scratch]: 'write', [cwd]: 'write' }
  const policy = Object.entries(filesystem).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|HOME|CODEX_HOME|LANG|LC_ALL)$/i.test(key)))
  Object.assign(env, { TEMP: scratch, TMP: scratch, TMPDIR: scratch })

  const code = `
    const [cwd, canary, port, marker, command] = process.argv.slice(1);
    const fs = require('node:fs');
    const observe = (operation) => {
      try { operation(); return 'ALLOWED' } catch (error) { return error.code || 'UNKNOWN' }
    };
    const read = observe(() => fs.readFileSync(canary));
    const write = observe(() => fs.closeSync(fs.openSync(canary, 'r+')));
    const socket = require('node:net').connect(Number(port), '127.0.0.1');
    function report(network) {
      socket.destroy();
      fs.writeSync(1, marker + ' ' + JSON.stringify({ read, write, network }) + '\\n');
      if (!${JSON.stringify(filesystemDenials)}.includes(read) || !${JSON.stringify(filesystemDenials)}.includes(write) || !${JSON.stringify(networkDenials)}.includes(network)) {
        process.exitCode = 125;
        return;
      }
      process.chdir(cwd);
      fs.writeSync(1, marker + ' ready\\n');
      if (command !== undefined) {
        const relay = ${JSON.stringify(process.platform === 'linux' ? fifoRelay : null)};
        const options = { stdio: 'inherit', env: ${JSON.stringify(env)} };
        const result = relay ? require('node:child_process').spawnSync('/bin/sh', ['-c', relay, 'sh', command], options)
          : require('node:child_process').spawnSync(command, { ...options, shell: true });
        process.exitCode = result.status ?? 125;
      }
    }
    socket.setTimeout(1000, () => report('TIMEOUT'));
    socket.once('connect', () => report('ALLOWED'));
    socket.once('error', (error) => report(error.code || 'UNKNOWN'));
  `
  let pending = '', receipt, ready = false
  let result, processError
  const server = createServer((connection) => {
    connection.setTimeout(1000, () => connection.destroy())
    connection.on('error', () => connection.destroy())
    connection.once('data', () => connection.end(marker))
  })
  const evidence = {}
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await confirmHostListener(port, marker)
    evidence.hostNetworkBefore = true
    closeSync(openSync(canary, 'r+'))
    result = await processRun(binary, [...(executable?.prefixArgs ?? []), 'sandbox',
      '-C', launcher, '--permission-profile', profile, '--include-managed-config', '-c', `${settings}.filesystem={${policy}}`,
      '-c', `${settings}.network.enabled=false`, '--', node, '-e', code, '--', cwd, canary, String(port), marker,
      ...(command === undefined ? [] : [command])], {
      cwd: launcher, env, inheritEnv: false, timeoutMs, signal, terminate,
      onStdout: (chunk) => {
        const lines = (pending + chunk).split(/\r?\n/)
        pending = lines.pop().slice(-4096)
        for (const line of lines) {
          if (!receipt && line.startsWith(`${marker} {`)) receipt = line.slice(marker.length + 1)
          if (line === `${marker} ready`) ready = true
        }
      },
    }).catch((error) => {
      if (['CANCELLED', 'TERMINATION_FAILED'].includes(error.code)) throw error
      processError = error
      evidence.launcherErrorCode = error.code
      return { code: null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    })
    evidence.launcherExitCode = result.code
    await confirmHostListener(port, marker)
    evidence.hostNetworkAfter = true
    if (readFileSync(canary, 'utf8') !== marker) throw new Error('Host file control changed during the sandbox probe')
    evidence.hostFileControl = true
  } catch (error) {
    if (['CANCELLED', 'TERMINATION_FAILED'].includes(error.code)) throw error
    throw unavailable(`Native sandbox probe could not complete (${error.code ?? error.message})`, evidence)
  } finally {
    server.close()
  }
  if (!receipt) throw unavailable('Native sandbox launcher did not reach the enforcement checks', { ...evidence, launcherStderr: result.stderr.trim().slice(-2000) })
  let observations
  try { observations = JSON.parse(receipt) } catch { throw unavailable('Native sandbox enforcement receipt was unreadable', evidence) }
  const { read, write, network } = observations
  Object.assign(evidence, { read, write, network })
  if (!filesystemDenials.includes(read) || !filesystemDenials.includes(write) || !networkDenials.includes(network)) {
    throw sandboxError('SANDBOX_ENFORCEMENT_FAILED', 'Native sandbox did not establish the required file and loopback restrictions', evidence)
  }
  if (!ready || (command === undefined && result.code !== 0)) throw unavailable('Native sandbox could not enter the verification worktree', evidence)
  if (processError) throw Object.assign(processError, { sandbox: 'SANDBOX_VERIFIED', sandboxEvidence: evidence })
  const stdout = result.stdout.replace(new RegExp(`^${marker} (?:\\{[^\\r\\n]*\\}|ready)\\r?\\n`, 'gm'), '')
  return { ...result, stdout, sandbox: 'SANDBOX_VERIFIED', sandboxEvidence: evidence }
}
