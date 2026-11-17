// Makes `codex` in Windows PowerShell open inside the model-ladder HUD (scripts/codex-hud.mjs) without manual setup.
// One marked block holding `function codex` goes into the current user's all-hosts profiles; everything else in those
// files is left alone. The function falls back to the plain native codex whenever the HUD cannot run.
// The pure helpers (hudBlock, applyBlock, ...) take and return text; ensureHud does the file work and never throws.
import * as nodeFs from 'node:fs'
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { artifactDir } from './common.mjs'

export const START_MARKER = '# >>> model-ladder codex HUD >>>'
export const END_MARKER = '# <<< model-ladder codex HUD <<<'
// Subcommands and flags that are not an interactive session: the HUD has nothing to wrap, so codex runs untouched.
export const PASSTHROUGH = ['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'apply', 'completion', 'debug', 'proto', 'help', '--help', '-h', '--version', '-V',
  'plugin', 'review', 'update', 'doctor', 'queue', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'features', 'exec-server', 'remote-control', 'app', 'cloud', 'sandbox']
const SEMVER = /^\d+\.\d+\.\d+$/
// Files that must all exist for a plugin folder to be usable; a half-deleted cache folder fails this.
const COMPLETE = ['.codex-plugin/plugin.json', 'scripts/codex-hud.mjs', 'hooks/band/remaining.mjs', 'node_modules/node-pty']
const NPM_ARGS = ['ci', '--omit=dev', '--no-audit', '--no-fund']
const LOCK_MS = 10 * 60 * 1000
const OFF = ['0', 'false', 'off', 'no']

const slash = (path) => String(path).replace(/\\/g, '/')
const psQuote = (text) => `'${String(text).replace(/'/g, "''")}'`

export function hudBlock(pluginRoot) {
  const root = slash(pluginRoot).replace(/\/+$/, '')
  const name = root.slice(root.lastIndexOf('/') + 1)
  const parent = root.slice(0, root.lastIndexOf('/'))
  // A Codex cache folder is <name>/<version>: scan its siblings on every run so an update never leaves a stale path.
  const candidates = SEMVER.test(name) && parent
    ? [
      `  $candidates = @(Get-ChildItem -LiteralPath ${psQuote(parent)} -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\\d+\\.\\d+\\.\\d+$' } | Sort-Object { [version]$_.Name } -Descending | ForEach-Object { $_.FullName })`,
    ]
    : [`  $candidates = @(${psQuote(root)})`]
  return [
    START_MARKER,
    '# Managed by the model-ladder plugin and rewritten on every Codex session start. Set hudTakeover to false in',
    '# ~/.codex/model-ladder.json (or delete this block) to go back to plain codex.',
    'function codex {',
    ...candidates,
    '  $root = $null',
    '  foreach ($candidate in $candidates) {',
    `    $complete = $true; foreach ($part in @(${COMPLETE.map(psQuote).join(', ')})) { if (-not (Test-Path -LiteralPath "$candidate/$part")) { $complete = $false; break } }`,
    '    if ($complete) { $root = $candidate; break }',
    '  }',
    '  $exe = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -like \'*.exe\' } | Select-Object -First 1',
    '  if (-not $exe) {',
    '    $other = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
    '    if (-not $other) { Write-Error \'codex was not found on PATH\'; return }',
    '    & $other.Source @args',
    '    return',
    '  }',
    '  $plain = $env:MODEL_LADDER_HUD -eq \'1\' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected -or $MyInvocation.ExpectingInput',
    `  if (-not $plain -and $args.Count -gt 0 -and @(${PASSTHROUGH.map(psQuote).join(', ')}) -contains [string]$args[0]) { $plain = $true }`,
    '  if (-not $plain -and -not $root) { $plain = $true }',
    '  if (-not $plain -and -not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) { $plain = $true }',
    '  if ($plain) { & $exe.Source @args; return }',
    '  $previous = $env:CODEX_BINARY',
    '  $env:CODEX_BINARY = $exe.Source',
    '  try {',
    '    node "$root/scripts/codex-hud.mjs" --cwd (Get-Location).Path -- @args',
    '  } finally {',
    '    if ($null -eq $previous) { Remove-Item Env:CODEX_BINARY -ErrorAction SilentlyContinue } else { $env:CODEX_BINARY = $previous }',
    '  }',
    '}',
    END_MARKER,
  ].join('\n')
}

// The takeover is on unless the user's Codex config turns off hudTakeover or the band, or MODEL_LADDER_BAND is off.
// Inside the HUD itself the runner sets MODEL_LADDER_BAND=0 for the Codex child; that is not the person's choice.
export function hudEnabled(config = {}, env = {}) {
  if (config.hudTakeover === false || config.band === false) return false
  if (env.MODEL_LADDER_HUD !== '1' && OFF.includes(String(env.MODEL_LADDER_BAND ?? '').toLowerCase())) return false
  return true
}

export const profilePaths = (documentsDir) => [
  join(documentsDir, 'PowerShell', 'profile.ps1'),
  join(documentsDir, 'WindowsPowerShell', 'profile.ps1'),
]

// Text <-> bytes without losing the file's encoding. A file in an encoding we cannot round-trip is refused, never rewritten.
export function decodeProfile(buffer) {
  if (!buffer.length) return { encoding: 'utf8-bom', text: '', empty: true }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: 'utf16le', text: buffer.subarray(2).toString('utf16le') }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) throw new Error('UTF-16 BE profiles are not supported')
  const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  if (!bom && buffer.includes(0)) throw new Error('profile looks like UTF-16 without a BOM')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(bom ? 3 : 0)) } catch { throw new Error('profile is not valid UTF-8') }
  return { encoding: bom ? 'utf8-bom' : 'utf8', text }
}

export function encodeProfile(encoding, text) {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  return Buffer.concat([encoding === 'utf8-bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')])
}

export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return lf > crlf ? '\n' : '\r\n'
}

// Returns text with exactly one block (block = hudBlock text) or none (block = null). Every other character stays as it was.
export function applyBlock(text, block) {
  const eol = detectEol(text)
  const start = new RegExp(`^${START_MARKER}[ \\t]*$`, 'm').exec(text)
  if (start) {
    const end = new RegExp(`^${END_MARKER}[ \\t]*$`, 'gm')
    end.lastIndex = start.index
    const stop = end.exec(text)
    if (!stop) throw new Error('model-ladder block has no end marker')
    const before = text.slice(0, start.index)
    let after = text.slice(stop.index + stop[0].length)
    if (block !== null) return before + block.replace(/\n/g, eol) + after
    after = after.replace(/^\r?\n/, '')
    // The blank separator that insertion adds goes away with the block when the block closes the file.
    const separator = new RegExp(`${eol}${eol}$`)
    return after === '' && separator.test(before) ? before.slice(0, -eol.length) : before + after
  }
  if (block === null) return text
  const head = text.trim() === '' ? text : `${text}${/\n$/.test(text) ? '' : eol}${eol}`
  return `${head}${block.replace(/\n/g, eol)}${eol}`
}

// One profile: returns the action taken, writes only when the bytes change.
function syncProfile(path, block, fs) {
  if (!fs.existsSync(path)) {
    if (block === null) return 'absent'
    fs.mkdirSync(dirname(path), { recursive: true })
    fs.writeFileSync(path, encodeProfile('utf8-bom', applyBlock('', block)))
    return 'installed'
  }
  const current = decodeProfile(fs.readFileSync(path))
  const next = applyBlock(current.text, block)
  if (next === current.text) return block === null ? 'absent' : 'unchanged'
  fs.writeFileSync(path, encodeProfile(current.encoding, next))
  if (block === null) return 'removed'
  return current.text.includes(START_MARKER) ? 'updated' : 'installed'
}

function startInstall(pluginRoot, { fs, spawn, platform, now }) {
  if (fs.existsSync(join(pluginRoot, 'node_modules', 'node-pty'))) return 'present'
  if (!fs.existsSync(join(pluginRoot, 'package.json'))) return 'skipped'
  const dir = artifactDir(pluginRoot)
  fs.mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'npm-ci.lock')
  try {
    if (fs.existsSync(lock) && now() - fs.statSync(lock).mtimeMs < LOCK_MS) return 'running'
  } catch {}
  const log = fs.openSync(join(dir, 'npm-ci.log'), 'a')
  try {
    fs.writeFileSync(lock, String(now()))
    // npm is npm.cmd on Windows, which spawn only starts through a shell; the arguments are fixed.
    const child = spawn('npm', NPM_ARGS, { cwd: pluginRoot, detached: true, stdio: ['ignore', log, log], windowsHide: true, shell: platform === 'win32' })
    child.on?.('error', () => {})
    child.unref?.()
  } finally { fs.closeSync(log) }
  return 'started'
}

// Windows Documents folder as PowerShell reports it (OneDrive and other redirections included).
export function resolveDocumentsDir({ spawnSync = nodeSpawnSync, timeout = 5000 } = {}) {
  const command = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout, windowsHide: true })
  const dir = String(result?.stdout ?? '').replace(/^﻿/, '').trim()
  return result?.status === 0 && dir ? dir : undefined
}

// config: the Codex config (hudTakeover, band). Returns { status, changed, profiles, npm, errors }; never throws.
export function ensureHud({ pluginRoot, documentsDir, env = process.env, platform = process.platform, config = {}, fs = nodeFs, spawn = nodeSpawn, now = Date.now } = {}) {
  const result = { status: 'skipped', changed: false, profiles: [], npm: 'skipped', errors: [] }
  try {
    if (platform !== 'win32' || !pluginRoot || !documentsDir) return result
    const root = pluginRoot
    const enabled = hudEnabled(config, env)
    const block = enabled ? hudBlock(root) : null
    for (const path of profilePaths(documentsDir)) {
      try { result.profiles.push({ path, action: syncProfile(path, block, fs) }) }
      catch (error) { result.profiles.push({ path, action: 'error' }); result.errors.push(`${path}: ${error.message}`) }
    }
    const actions = result.profiles.map((profile) => profile.action)
    result.changed = actions.some((action) => ['installed', 'updated', 'removed'].includes(action))
    result.status = actions.includes('installed') ? 'installed' : actions.includes('updated') ? 'updated' : actions.includes('removed') ? 'removed'
      : actions.includes('error') ? 'error' : enabled ? 'unchanged' : 'absent'
    if (enabled) {
      try { result.npm = startInstall(root, { fs, spawn, platform, now }) }
      catch (error) { result.npm = 'error'; result.errors.push(`npm ci: ${error.message}`) }
    }
  } catch (error) {
    result.status = 'error'
    result.errors.push(error.message)
  }
  return result
}
