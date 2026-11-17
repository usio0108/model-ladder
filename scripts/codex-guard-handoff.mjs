import { closeSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HANDOFF_PROMPT = 'The usage guard reached its threshold. Use the handoff skill to write a handoff from this conversation.'

// A known reset identifies a quota window; unknown windows never trigger an automatic action.
export function guardHandoff(root, usage, guard, deliver) {
  const dir = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'model-ladder-guard')
  const windows = ['fiveHour', 'sevenDay'].filter((kind) => Number.isFinite(usage?.[kind]) && Number.isFinite(usage?.[`${kind}ResetsAt`]))
  if (!windows.length) return false
  mkdirSync(dir, { recursive: true })
  const fresh = []
  for (const kind of windows) {
    const key = `${kind}@${usage[`${kind}ResetsAt`]}`
    const over = guard.enabled && usage[kind] >= guard.threshold
    for (const name of readdirSync(dir)) if (name.startsWith(`${kind}@`) && (!over || name !== key)) rmSync(join(dir, name), { force: true })
    if (over) try { const path = join(dir, key); closeSync(openSync(path, 'wx')); fresh.push(path) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  if (!fresh.length) return false
  try { if (deliver(HANDOFF_PROMPT)) return true } catch { /* Keep the window armed when delivery fails. */ }
  for (const path of fresh) rmSync(path, { force: true })
  return false
}
