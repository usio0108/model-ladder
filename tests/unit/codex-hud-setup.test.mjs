import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as realFs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactDir } from '../../scripts/common.mjs'
import {
  END_MARKER, PASSTHROUGH, START_MARKER, applyBlock, decodeProfile, encodeProfile, ensureHud, hudBlock, hudEnabled, profilePaths, resolveDocumentsDir,
} from '../../scripts/codex-hud-setup.mjs'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

// A temp Documents folder and a plugin root (with or without node-pty) that are removed afterwards.
function fixture(t, { pty = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ml-hud-setup-'))
  const documentsDir = join(base, 'Documents')
  const pluginRoot = join(base, 'plugin root')
  mkdirSync(documentsDir)
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true })
  writeFileSync(join(pluginRoot, 'package.json'), '{}')
  if (pty) mkdirSync(join(pluginRoot, 'node_modules', 'node-pty'), { recursive: true })
  t.after(() => { rmSync(base, { recursive: true, force: true }); rmSync(artifactDir(pluginRoot), { recursive: true, force: true }) })
  const [pwsh, winPs] = profilePaths(documentsDir)
  return { base, documentsDir, pluginRoot, pwsh, winPs, options: { pluginRoot, documentsDir, platform: 'win32', env: {}, spawn: () => { throw new Error('unexpected spawn') } } }
}

const countingFs = () => {
  const writes = []
  return { writes, fs: { ...realFs, writeFileSync: (path, data, ...rest) => { writes.push(path); return realFs.writeFileSync(path, data, ...rest) } } }
}
const blockOf = (text) => text.slice(text.indexOf(START_MARKER), text.indexOf(END_MARKER) + END_MARKER.length)

test('block defines function codex with every passthrough rule and never mentions a shim', () => {
  const block = hudBlock('C:\\Users\\me\\plugin root\\model-ladder')
  assert.ok(block.startsWith(START_MARKER) && block.endsWith(END_MARKER))
  assert.match(block, /^function codex \{$/m)
  assert.match(block, /Get-Command codex -CommandType Application/)
  assert.match(block, /Where-Object \{ \$_\.Source -like '\*\.exe' \}/)
  assert.match(block, /& \$exe\.Source @args/)
  assert.match(block, /\$env:MODEL_LADDER_HUD -eq '1'/)
  assert.match(block, /\[Console\]::IsInputRedirected/)
  assert.match(block, /\[Console\]::IsOutputRedirected/)
  for (const word of ['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'apply', 'completion', 'debug', 'proto', 'help', '--help', '-h', '--version', '-V']) {
    assert.ok(PASSTHROUGH.includes(word))
    assert.ok(block.includes(`'${word}'`), word)
  }
  assert.match(block, /node_modules\/node-pty/)
  assert.match(block, /scripts\/codex-hud\.mjs/)
  assert.match(block, /Get-Command node -CommandType Application/)
  assert.match(block, /\$env:CODEX_BINARY = \$exe\.Source/)
  assert.match(block, /node "\$root\/scripts\/codex-hud\.mjs" --cwd \(Get-Location\)\.Path -- @args/)
  assert.match(block, /finally \{\n.*\$env:CODEX_BINARY = \$previous/)
  assert.doesNotMatch(block, /\.cmd|\.bat/i)
  assert.equal(block.includes('\r'), false)
  assert.match(hudBlock("C:\\it's here"), /\$candidates = @\('C:\/it''s here'\)/)
})

test('passthrough covers the non-interactive Codex subcommands and leaves interactive ones on the HUD', () => {
  const block = hudBlock('/x')
  for (const word of ['plugin', 'review', 'update', 'doctor', 'queue', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'features', 'exec-server', 'remote-control', 'app', 'cloud', 'sandbox']) {
    assert.ok(PASSTHROUGH.includes(word), word)
    assert.ok(block.includes(`'${word}'`), word)
  }
  for (const word of ['resume', 'fork', 'agents']) assert.equal(PASSTHROUGH.includes(word), false, word)
})

test('a semver plugin root scans its parent folder and checks every required file', () => {
  const block = hudBlock('C:\\cache\\model-ladder\\model-ladder\\1.2.0')
  assert.match(block, /Get-ChildItem -LiteralPath 'C:\/cache\/model-ladder\/model-ladder' -Directory/)
  assert.match(block, /Sort-Object \{ \[version\]\$_\.Name \} -Descending/)
  for (const part of ['.codex-plugin/plugin.json', 'scripts/codex-hud.mjs', 'hooks/band/remaining.mjs', 'node_modules/node-pty']) assert.ok(block.includes(`'${part}'`), part)
  assert.doesNotMatch(block, /\$root = 'C:/)
})

test('a non-semver plugin root is used alone with the same completeness check', () => {
  const block = hudBlock('C:\\dev\\model-ladder')
  assert.doesNotMatch(block, /Get-ChildItem/)
  assert.match(block, /\$candidates = @\('C:\/dev\/model-ladder'\)/)
  assert.match(block, /'hooks\/band\/remaining\.mjs'/)
  assert.match(block, /if \(-not \$plain -and -not \$root\) \{ \$plain = \$true \}/)
})

const powershell = process.platform === 'win32' ? ['pwsh', 'powershell.exe'].find((exe) => !nodeSpawnSync(exe, ['-NoProfile', '-Command', '1'], { windowsHide: true }).error) : ['pwsh'].find((exe) => !nodeSpawnSync(exe, ['-NoProfile', '-Command', '1']).error)

// Runs only the generated version-selection lines (everything before the native codex lookup) and prints the chosen root.
function selectedRoot(pluginRoot, base) {
  const lines = hudBlock(pluginRoot).split('\n')
  const body = lines.slice(lines.indexOf('function codex {') + 1, lines.findIndex((line) => line.startsWith('  $exe =')))
  const script = join(base, 'select.ps1')
  writeFileSync(script, `${body.join('\n')}\nif ($root) { Write-Output "ROOT=$root" } else { Write-Output 'ROOT=NONE' }\n`)
  const result = nodeSpawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true })
  return result.stdout.trim().replace(/^ROOT=/, '').replace(/\\/g, '/')
}

test('the generated PowerShell picks the newest complete version, else falls back to native codex', { skip: powershell ? false : 'no PowerShell available' }, (t) => {
  // The long path: Windows runners hand out an 8.3 temp path (RUNNER~1) that PowerShell expands.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ml-hud-select-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const cache = join(base, 'model-ladder')
  const make = (version, files) => { for (const file of files) mkdirSync(join(cache, version, file), { recursive: true }) }
  const full = ['.codex-plugin', 'scripts', 'hooks/band', 'node_modules/node-pty']
  const write = (version) => {
    writeFileSync(join(cache, version, '.codex-plugin', 'plugin.json'), '{}')
    writeFileSync(join(cache, version, 'scripts', 'codex-hud.mjs'), '')
    writeFileSync(join(cache, version, 'hooks', 'band', 'remaining.mjs'), '')
  }
  make('1.1.5', ['scripts', 'node_modules/node-pty'])
  writeFileSync(join(cache, '1.1.5', 'scripts', 'codex-hud.mjs'), '')
  make('1.2.0', full); write('1.2.0')
  make('1.10.0', ['scripts', 'node_modules/node-pty'])
  writeFileSync(join(cache, '1.10.0', 'scripts', 'codex-hud.mjs'), '')
  assert.equal(selectedRoot(join(cache, '1.1.5'), base), slash(join(cache, '1.2.0')))
  make('1.10.0', full); write('1.10.0')
  assert.equal(selectedRoot(join(cache, '1.2.0'), base), slash(join(cache, '1.10.0')))
  rmSync(join(cache, '1.10.0'), { recursive: true }); rmSync(join(cache, '1.2.0', 'hooks'), { recursive: true })
  assert.equal(selectedRoot(join(cache, '1.1.5'), base), 'NONE')
  // A non-semver root is checked on its own.
  const dev = join(base, 'dev')
  mkdirSync(join(dev, 'node_modules', 'node-pty'), { recursive: true })
  assert.equal(selectedRoot(dev, base), 'NONE')
})

const slash = (path) => path.replace(/\\/g, '/')

test('applyBlock inserts, replaces and removes only the marked block', () => {
  const one = hudBlock('/one'), two = hudBlock('/two')
  assert.equal(applyBlock('', one), `${one.replace(/\n/g, '\r\n')}\r\n`)
  const lf = 'Set-Alias ll ls\nfunction x { 1 }\n'
  const inserted = applyBlock(lf, one)
  assert.equal(inserted, `${lf}\n${one}\n`)
  assert.equal(applyBlock(inserted, one), inserted)
  const updated = applyBlock(`# top\n${one}\n# bottom\n`, two)
  assert.equal(updated, `# top\n${two}\n# bottom\n`)
  assert.equal(applyBlock(inserted, null), lf)
  assert.equal(applyBlock(lf, null), lf)
  assert.equal(applyBlock('no newline at end', one), `no newline at end\r\n\r\n${one.replace(/\n/g, '\r\n')}\r\n`)
  assert.equal(applyBlock(`a\n${one}\nb\n`, null), 'a\nb\n')
  assert.throws(() => applyBlock(`${START_MARKER}\nfunction codex {}\n`, one), /no end marker/)
  assert.equal(applyBlock(`# ${END_MARKER} mentioned in a comment\n`, null), `# ${END_MARKER} mentioned in a comment\n`)
})

test('hudEnabled honors hudTakeover, band and MODEL_LADDER_BAND, but not the HUD child environment', () => {
  assert.equal(hudEnabled({}, {}), true)
  assert.equal(hudEnabled({ hudTakeover: true, band: true }, {}), true)
  assert.equal(hudEnabled({ hudTakeover: false }, {}), false)
  assert.equal(hudEnabled({ band: false }, {}), false)
  for (const value of ['0', 'false', 'OFF', 'no']) assert.equal(hudEnabled({}, { MODEL_LADDER_BAND: value }), false)
  assert.equal(hudEnabled({}, { MODEL_LADDER_BAND: '1' }), true)
  // The runner starts Codex with BAND=0 inside the HUD; that must not remove the takeover.
  assert.equal(hudEnabled({}, { MODEL_LADDER_HUD: '1', MODEL_LADDER_BAND: '0' }), true)
  assert.equal(hudEnabled({ hudTakeover: false }, { MODEL_LADDER_HUD: '1' }), false)
})

test('ensureHud creates both profiles, then leaves them alone when nothing changed', (t) => {
  const f = fixture(t)
  const { fs, writes } = countingFs()
  const first = ensureHud({ ...f.options, fs })
  assert.equal(first.status, 'installed')
  assert.equal(first.changed, true)
  assert.deepEqual(first.errors, [])
  assert.deepEqual(first.profiles.map((profile) => [profile.path, profile.action]), [[f.pwsh, 'installed'], [f.winPs, 'installed']])
  assert.equal(f.pwsh, join(f.documentsDir, 'PowerShell', 'profile.ps1'))
  assert.equal(f.winPs, join(f.documentsDir, 'WindowsPowerShell', 'profile.ps1'))
  for (const path of [f.pwsh, f.winPs]) {
    const bytes = readFileSync(path)
    assert.deepEqual(bytes.subarray(0, 3), BOM)
    const text = bytes.subarray(3).toString('utf8')
    assert.equal(text, `${hudBlock(f.pluginRoot).replace(/\n/g, '\r\n')}\r\n`)
  }
  assert.equal(writes.length, 2)
  const second = ensureHud({ ...f.options, fs })
  assert.equal(second.status, 'unchanged')
  assert.equal(second.changed, false)
  assert.equal(writes.length, 2)
})

test('ensureHud rewrites only the block when the plugin root changes', (t) => {
  const f = fixture(t)
  const user = 'Set-PSReadLineOption -EditMode Emacs\r\n$env:FOO = "bar"\r\n'
  mkdirSync(join(f.documentsDir, 'PowerShell'))
  writeFileSync(f.pwsh, user)
  ensureHud(f.options)
  const next = join(f.base, 'plugin v2')
  mkdirSync(join(next, 'node_modules', 'node-pty'), { recursive: true })
  t.after(() => rmSync(artifactDir(next), { recursive: true, force: true }))
  const result = ensureHud({ ...f.options, pluginRoot: next })
  assert.equal(result.status, 'updated')
  assert.deepEqual(result.profiles.map((profile) => profile.action), ['updated', 'updated'])
  const text = readFileSync(f.pwsh, 'utf8')
  assert.equal(text, `${user}\r\n${hudBlock(next).replace(/\n/g, '\r\n')}\r\n`)
  assert.equal(text.split(START_MARKER).length, 2)
  assert.doesNotMatch(text, /plugin root/)
})

test('ensureHud keeps other content, line endings and the file encoding', async (t) => {
  const cases = [
    ['UTF-8 without BOM, LF', 'utf8', '# profile\n$名前 = "中文"\nfunction x { 1 }\n'],
    ['UTF-8 with BOM, CRLF', 'utf8-bom', '# profile\r\n$名前 = "中文"\r\nfunction x { 1 }\r\n'],
    ['UTF-16 LE with BOM, CRLF', 'utf16le', '# profile\r\n$名前 = "中文"\r\nfunction x { 1 }\r\n'],
    ['UTF-8 without trailing newline', 'utf8', 'Set-Alias ll ls'],
  ]
  for (const [name, encoding, original] of cases) {
    await t.test(name, () => {
      const f = fixture(t)
      mkdirSync(join(f.documentsDir, 'PowerShell'))
      const originalBytes = encodeProfile(encoding, original)
      writeFileSync(f.pwsh, originalBytes)
      assert.equal(ensureHud(f.options).status, 'installed')
      const installed = readFileSync(f.pwsh)
      assert.deepEqual(decodeProfile(installed).encoding, encoding)
      const text = decodeProfile(installed).text
      assert.ok(text.startsWith(original))
      const eol = original.includes('\r\n') || !original.includes('\n') ? '\r\n' : '\n'
      assert.equal(blockOf(text), hudBlock(f.pluginRoot).replace(/\n/g, eol))
      assert.equal(text.includes('\n') && eol === '\n' ? text.includes('\r') : text.replace(/\r\n/g, '').includes('\n'), false)
      assert.equal(ensureHud(f.options).status, 'unchanged')
      assert.deepEqual(readFileSync(f.pwsh), installed)
      // Removing the block gives back the original text in the original encoding.
      const removed = ensureHud({ ...f.options, config: { hudTakeover: false } })
      assert.equal(removed.status, 'removed')
      const after = readFileSync(f.pwsh)
      assert.deepEqual(decodeProfile(after).encoding, encoding)
      assert.equal(decodeProfile(after).text, encoding === 'utf8' && !original.endsWith('\n') ? `${original}\r\n` : original)
    })
  }
})

test('ensureHud removes the block when the takeover is disabled and creates nothing', (t) => {
  for (const [name, config, env] of [['hudTakeover', { hudTakeover: false }, {}], ['band', { band: false }, {}], ['env', {}, { MODEL_LADDER_BAND: '0' }]]) {
    const f = fixture(t)
    assert.equal(ensureHud(f.options).status, 'installed', name)
    const off = ensureHud({ ...f.options, config, env })
    assert.equal(off.status, 'removed', name)
    assert.equal(off.changed, true)
    for (const path of [f.pwsh, f.winPs]) assert.equal(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''), '', name)
    const again = ensureHud({ ...f.options, config, env })
    assert.equal(again.status, 'absent', name)
    assert.equal(again.changed, false)
  }
  const fresh = fixture(t, { pty: false })
  const none = ensureHud({ ...fresh.options, config: { hudTakeover: false } })
  assert.equal(none.status, 'absent')
  assert.equal(existsSync(fresh.pwsh) || existsSync(fresh.winPs), false)
  assert.equal(none.npm, 'skipped')
})

test('ensureHud keeps the takeover when the HUD child reports MODEL_LADDER_BAND=0', (t) => {
  const f = fixture(t)
  ensureHud(f.options)
  assert.equal(ensureHud({ ...f.options, env: { MODEL_LADDER_HUD: '1', MODEL_LADDER_BAND: '0' } }).status, 'unchanged')
})

test('ensureHud does nothing outside Windows or without a Documents folder', (t) => {
  const f = fixture(t, { pty: false })
  for (const platform of ['linux', 'darwin']) {
    const result = ensureHud({ ...f.options, platform })
    assert.equal(result.status, 'skipped')
    assert.equal(result.changed, false)
  }
  assert.equal(ensureHud({ ...f.options, documentsDir: undefined }).status, 'skipped')
  assert.equal(ensureHud({ ...f.options, pluginRoot: undefined }).status, 'skipped')
  assert.equal(ensureHud().status, 'skipped')
  assert.equal(existsSync(f.pwsh), false)
})

test('ensureHud starts npm ci detached and hidden only when node-pty is missing', (t) => {
  const missing = fixture(t, { pty: false })
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { on() {}, unref() { calls.at(-1).unref = true } }
  }
  const result = ensureHud({ ...missing.options, spawn })
  assert.equal(result.npm, 'started')
  assert.equal(result.status, 'installed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'npm')
  assert.deepEqual(calls[0].args, ['ci', '--omit=dev', '--no-audit', '--no-fund'])
  assert.equal(calls[0].options.cwd, missing.pluginRoot)
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].unref, true)
  assert.equal(calls[0].options.stdio[0], 'ignore')
  assert.equal(typeof calls[0].options.stdio[1], 'number')
  assert.ok(existsSync(join(artifactDir(missing.pluginRoot), 'npm-ci.log')))
  // A second session start while the first install is still fresh does not start another one.
  assert.equal(ensureHud({ ...missing.options, spawn }).npm, 'running')
  assert.equal(calls.length, 1)
  // An old lock (a crashed install) is retried.
  assert.equal(ensureHud({ ...missing.options, spawn, now: () => Date.now() + 11 * 60 * 1000 }).npm, 'started')
  assert.equal(calls.length, 2)

  const present = fixture(t)
  const none = []
  assert.equal(ensureHud({ ...present.options, spawn: (...a) => { none.push(a); return { on() {}, unref() {} } } }).npm, 'present')
  assert.equal(none.length, 0)

  const disabled = fixture(t, { pty: false })
  assert.equal(ensureHud({ ...disabled.options, config: { hudTakeover: false }, spawn: (...a) => { none.push(a); return {} } }).npm, 'skipped')
  assert.equal(none.length, 0)
})

test('ensureHud never throws on file system or spawn errors', (t) => {
  const f = fixture(t, { pty: false })
  const boom = () => { throw new Error('disk on fire') }
  const broken = { ...realFs, existsSync: boom, readFileSync: boom, writeFileSync: boom, mkdirSync: boom, openSync: boom }
  const result = ensureHud({ ...f.options, fs: broken })
  assert.equal(result.status, 'error')
  assert.equal(result.changed, false)
  assert.ok(result.errors.length >= 2)
  assert.match(result.errors.join('\n'), /disk on fire/)
  assert.equal(result.npm, 'error')

  const failingSpawn = ensureHud({ ...f.options, spawn: boom })
  assert.equal(failingSpawn.status, 'installed')
  assert.equal(failingSpawn.npm, 'error')
  assert.match(failingSpawn.errors[0], /npm ci: disk on fire/)

  // Not even a hostile config or fs object gets an exception out.
  assert.doesNotThrow(() => ensureHud({ ...f.options, fs: null, config: null, env: null }))
  assert.equal(ensureHud({ ...f.options, fs: null }).status, 'error')
})

test('ensureHud leaves a profile it cannot round-trip untouched and still handles the other one', (t) => {
  const cases = [
    ['UTF-16 BE', Buffer.from([0xfe, 0xff, 0x00, 0x61]), /UTF-16 BE/],
    ['UTF-16 LE without BOM', Buffer.from('a\r\nb\r\n', 'utf16le'), /without a BOM/],
    ['ANSI bytes', Buffer.from([0x23, 0x20, 0xe9, 0x0d, 0x0a]), /not valid UTF-8/],
    ['unterminated block', Buffer.from(`${START_MARKER}\nfunction codex {}\n`), /no end marker/],
  ]
  for (const [name, bytes, message] of cases) {
    const f = fixture(t)
    mkdirSync(join(f.documentsDir, 'PowerShell'))
    writeFileSync(f.pwsh, bytes)
    const result = ensureHud(f.options)
    assert.equal(result.status, 'installed', name)
    assert.deepEqual(result.profiles.map((profile) => profile.action), ['error', 'installed'], name)
    assert.match(result.errors[0], message, name)
    assert.deepEqual(readFileSync(f.pwsh), bytes, name)
  }
})

test('a zero-byte profile is treated as new and gets a BOM', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.documentsDir, 'PowerShell'))
  writeFileSync(f.pwsh, '')
  assert.equal(ensureHud(f.options).profiles[0].action, 'installed')
  assert.deepEqual(readFileSync(f.pwsh).subarray(0, 3), BOM)
})

test('resolveDocumentsDir reads the folder from a short PowerShell call and gives up on failure', () => {
  const calls = []
  const ok = (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: '\uFEFFD:\\OneDrive\\Documents\r\n' } }
  assert.equal(resolveDocumentsDir({ spawnSync: ok }), 'D:\\OneDrive\\Documents')
  assert.equal(calls[0].command, 'powershell.exe')
  assert.ok(calls[0].args.includes('-NoProfile'))
  assert.match(calls[0].args.at(-1), /GetFolderPath\('MyDocuments'\)/)
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout < 15000)
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(resolveDocumentsDir({ spawnSync: () => ({ status: 1, stdout: 'x' }) }), undefined)
  assert.equal(resolveDocumentsDir({ spawnSync: () => ({ status: null, error: new Error('ETIMEDOUT'), stdout: '' }) }), undefined)
  assert.equal(resolveDocumentsDir({ spawnSync: () => ({ status: 0, stdout: '  \r\n' }) }), undefined)
})
