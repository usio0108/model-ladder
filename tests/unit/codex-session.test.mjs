import '../helpers/isolate-home.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionText } from '../../hooks/codex-session.mjs'

// Never touch the real PowerShell profile from a test.
const OFF = { platform: 'linux' }

test('session reuses an active HUD, preserves panel fallback and skips internal roles', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-session-'))
  try {
    assert.match(sessionText({ cwd }, {}, OFF), /codex-hud\.mjs/)
    assert.match(sessionText({ cwd }, {}, OFF), /cannot attach/)
    assert.match(sessionText({ cwd }, {}, OFF), /open_in_codex/)
    assert.match(sessionText({ cwd }, {}, OFF), /persistent PTY/)
    assert.match(sessionText({ cwd }, {}, OFF), /model-ladder skill/)
    assert.match(sessionText({ cwd }, { MODEL_LADDER_AUTORUN: '0' }, OFF), /model-ladder panel/)
    assert.doesNotMatch(sessionText({ cwd }, { MODEL_LADDER_AUTORUN: '0' }, OFF), /installed and on/)
    assert.equal(sessionText({ cwd }, { MODEL_LADDER_ROLE: 'worker' }, OFF), '')
    const hud = sessionText({ cwd }, { MODEL_LADDER_HUD: '1', MODEL_LADDER_BAND: '0' }, OFF)
    assert.match(hud, /HUD is already running/)
    assert.doesNotMatch(hud, /open_in_codex/)
    mkdirSync(join(cwd, '.codex'))
    writeFileSync(join(cwd, '.codex/model-ladder.json'), JSON.stringify({ autoRun: false, band: false }))
    assert.equal(sessionText({ cwd }, {}, OFF), '')
    const hooks = JSON.parse(readFileSync(new URL('../../hooks/codex-hooks.json', import.meta.url)))
    assert.match(hooks.hooks.SessionStart[0].matcher, /fork/)
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /PLUGIN_ROOT.*codex-session/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

function stubs(result = { status: 'installed', changed: true }) {
  const calls = []
  return { calls, ensureHud: (options) => { calls.push(options); return result }, documentsDir: () => 'C:/Docs' }
}

test('session installs the Windows HUD takeover only on win32 and tells the user once', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-session-'))
  try {
    const deps = stubs()
    const text = sessionText({ cwd }, {}, { ...deps, platform: 'win32' })
    assert.equal(deps.calls.length, 1)
    assert.equal(deps.calls[0].documentsDir, 'C:/Docs')
    assert.equal(deps.calls[0].platform, 'win32')
    assert.equal(deps.calls[0].config.hudTakeover, true)
    assert.equal(deps.calls[0].pluginRoot, join(import.meta.dirname, '../..'))
    assert.match(text, /next `codex` you launch in a new PowerShell window opens inside the model-ladder HUD/)
    assert.match(text, /model-ladder panel/)
    for (const platform of ['linux', 'darwin']) {
      const other = stubs()
      assert.doesNotMatch(sessionText({ cwd }, {}, { ...other, platform }), /new PowerShell window/)
      assert.equal(other.calls.length, 0)
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('session leaves internal roles and an already running HUD out of the takeover notice', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-session-'))
  try {
    const role = stubs()
    assert.equal(sessionText({ cwd }, { MODEL_LADDER_ROLE: 'worker' }, { ...role, platform: 'win32' }), '')
    assert.equal(role.calls.length, 0)
    const inHud = stubs()
    const text = sessionText({ cwd }, { MODEL_LADDER_HUD: '1', MODEL_LADDER_BAND: '0' }, { ...inHud, platform: 'win32' })
    assert.equal(inHud.calls.length, 1)
    assert.doesNotMatch(text, /new PowerShell window/)
    assert.match(text, /HUD is already running/)
    for (const result of [{ status: 'unchanged', changed: false }, { status: 'removed', changed: true }, { status: 'error', changed: false }]) {
      assert.doesNotMatch(sessionText({ cwd }, {}, { ...stubs(result), platform: 'win32' }), /new PowerShell window/)
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('session takeover follows the user config only and survives setup failures', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-session-'))
  try {
    mkdirSync(join(cwd, '.codex'))
    writeFileSync(join(cwd, '.codex/model-ladder.json'), JSON.stringify({ hudTakeover: false, band: false }))
    const project = stubs()
    sessionText({ cwd }, {}, { ...project, platform: 'win32' })
    assert.equal(project.calls[0].config.hudTakeover, true)
    assert.equal(project.calls[0].config.band, true)
    const user = process.env.MODEL_LADDER_USER_CONFIG
    mkdirSync(dirname(user), { recursive: true })
    writeFileSync(user, JSON.stringify({ hudTakeover: false }))
    const disabled = stubs({ status: 'removed', changed: true })
    sessionText({ cwd }, {}, { ...disabled, platform: 'win32' })
    assert.equal(disabled.calls[0].config.hudTakeover, false)
    rmSync(user)
    const broken = { platform: 'win32', documentsDir: () => 'C:/Docs', ensureHud() { throw new Error('boom') } }
    assert.doesNotMatch(sessionText({ cwd }, {}, broken), /PowerShell window/)
    const unresolved = stubs()
    assert.doesNotMatch(sessionText({ cwd }, {}, { ...unresolved, platform: 'win32', documentsDir: () => undefined }), /PowerShell window/)
    assert.equal(unresolved.calls.length, 0)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
