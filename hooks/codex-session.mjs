import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { autorunText } from './autorun.mjs'
import { loadLayered, readLayers } from '../scripts/config.mjs'
import { mergeConfig } from './config-layers.mjs'
import { ensureHud as installHud, resolveDocumentsDir } from '../scripts/codex-hud-setup.mjs'

const DEFAULTS = { autoRun: true, band: true, hudTakeover: true }
const pluginRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')

// Windows only: keeps `codex` in PowerShell opening inside the HUD. The block lives in the user's profile, so only the
// user's own Codex config decides it, not one project's file. Never throws.
function takeover(cwd, env, { platform = process.platform, ensureHud = installHud, documentsDir = resolveDocumentsDir } = {}) {
  if (platform !== 'win32') return ''
  try {
    const documents = documentsDir()
    if (!documents) return ''
    const config = mergeConfig(DEFAULTS, readLayers(cwd, 'codex').user)
    const result = ensureHud({ pluginRoot, documentsDir: documents, env, platform, config })
    if (env.MODEL_LADDER_HUD !== '1' && result?.changed && ['installed', 'updated'].includes(result.status)) {
      return 'model-ladder HUD: the next `codex` you launch in a new PowerShell window opens inside the model-ladder HUD. Tell the user once; do not run anything for this.'
    }
  } catch {}
  return ''
}

export function sessionText(input = {}, env = process.env, deps = {}) {
  if (env.MODEL_LADDER_ROLE) return ''
  const cwd = input.cwd ?? process.cwd()
  const config = loadLayered(cwd, 'codex', DEFAULTS)
  const parts = []
  if (env.MODEL_LADDER_HUD === '1') {
    parts.push('model-ladder HUD is already running in this terminal. Reuse it; do not start a separate watcher.')
  } else if (config.band !== false && !['0', 'false', 'off', 'no'].includes(String(env.MODEL_LADDER_BAND ?? '').toLowerCase())) {
    const hud = fileURLToPath(new URL('../scripts/codex-hud.mjs', import.meta.url))
    const watcher = fileURLToPath(new URL('../scripts/watch.mjs', import.meta.url))
    parts.push(`model-ladder panel: before the next top-level task, ensure one live panel for this repository. Reuse the existing watcher terminal in this chat on resume/compact. Otherwise start Node with script ${JSON.stringify(watcher)} and arguments --cwd ${JSON.stringify(cwd)} in a persistent PTY terminal, then show that terminal using open_in_codex when available. Keep the watcher running between tasks; do not wait for it to exit. If this surface cannot show a terminal panel, use the runner's progress output and explain that limitation. For an integrated CLI HUD, install this package's npm dependencies and launch node ${JSON.stringify(hud)} --cwd ${JSON.stringify(cwd)} -- resume before entering the session. It cannot attach to an already-running CLI. Panel setup is an internal ladder step; never route it through the ladder. The panel is independent of autoRun.`)
  }
  parts.push(takeover(cwd, env, deps))
  if (config.autoRun !== false) parts.push(autorunText({ ...env, PLUGIN_DATA: env.PLUGIN_DATA ?? 'codex' }))
  return parts.filter(Boolean).join('\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    const text = sessionText(input)
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) + '\n')
  } catch (error) { process.stderr.write(`model-ladder session setup: ${error.message}\n`); process.exitCode = 1 }
}
