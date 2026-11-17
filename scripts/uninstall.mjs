// One-command cleanup of model-ladder state: this repo's dirs, exclude lines, worktrees and temp artifacts, plus the
// global PowerShell profile block and update-check cache. `node scripts/uninstall.mjs [--dry-run] [--force]`, run inside the repo.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXCLUDE_LINES, artifactDir, git, print, repoRoot, runDir, tryGit, worktrees } from './common.mjs'
import { START_MARKER, applyBlock, decodeProfile, encodeProfile, profilePaths, resolveDocumentsDir } from './codex-hud-setup.mjs'
import { canonical } from '../hooks/guard.mjs'
import { readLocks } from './runs.mjs'

const flat = (path) => canonical(path).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
const under = (path, dir) => flat(path).startsWith(`${flat(dir)}/`)

// Returns { lines, failed, blocked }; changes nothing when dryRun. documentsDir/updateCheckPath/platform are injectable for tests.
export function uninstall({ root, dryRun = false, force = false, documentsDir, platform = process.platform, updateCheckPath = join(tmpdir(), 'model-ladder-update-check.json') }) {
  const lines = []
  const live = readLocks(root).filter((lock) => !lock.stale)
  if (live.length && !force) {
    return { lines: [`A model-ladder run is active in this repo (${live.map((lock) => lock.runId).join(', ')}). Stop it or pass --force.`], failed: false, blocked: true }
  }
  let failed = false
  const verb = dryRun ? 'would remove' : 'removed'
  const item = (label, present, remove) => {
    if (!present) return lines.push(`absent: ${label}`)
    try { if (!dryRun) remove(); lines.push(`${verb}: ${label}`) } catch (error) { failed = true; lines.push(`error: ${label}: ${error.message}`) }
  }
  const art = artifactDir(root)

  // Worktrees first: git must unregister them before their folders go.
  const ours = worktrees(root).filter((w) => under(w.path, join(root, '.claude', 'worktrees')) || under(w.path, art))
  for (const w of ours) item(`git worktree ${w.path}`, true, () => { git(root, 'worktree', 'remove', '--force', '--force', w.path) })
  if (!dryRun) tryGit(root, 'worktree', 'prune')

  for (const dir of [runDir(root), join(root, '.claude', 'worktrees'), art]) item(dir, existsSync(dir), () => rmSync(dir, { recursive: true, force: true }))

  const rel = tryGit(root, 'rev-parse', '--git-path', 'info/exclude')
  const file = rel.ok ? (isAbsolute(rel.out) ? rel.out : resolve(root, rel.out)) : null
  const text = file && existsSync(file) ? readFileSync(file, 'utf8') : ''
  for (const line of EXCLUDE_LINES) {
    const present = text.split(/\r?\n/).some((l) => l.trim() === line)
    item(`exclude line ${line}`, present, () => {
      writeFileSync(file, readFileSync(file, 'utf8').split(/(?<=\n)/).filter((l) => l.trim() !== line).join(''))
    })
  }

  if (platform === 'win32' && documentsDir) {
    for (const path of profilePaths(documentsDir)) {
      let has = false
      try { has = existsSync(path) && decodeProfile(readFileSync(path)).text.includes(START_MARKER) } catch (error) { failed = true; lines.push(`error: ${path}: ${error.message}`); continue }
      item(`profile block in ${path}`, has, () => {
        const current = decodeProfile(readFileSync(path))
        writeFileSync(path, encodeProfile(current.encoding, applyBlock(current.text, null)))
      })
    }
  }
  item(updateCheckPath, existsSync(updateCheckPath), () => rmSync(updateCheckPath, { force: true }))
  lines.push('Next: remove the plugin now, or the Codex SessionStart hook re-adds the PowerShell block on the next Codex session.',
    '  claude plugin uninstall model-ladder@model-ladder', '  codex plugin remove model-ladder@model-ladder')
  return { lines, failed, blocked: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = new Set(process.argv.slice(2))
  let root
  try { root = repoRoot() } catch { print('Run this inside a git repository.'); process.exit(1) }
  const documentsDir = process.platform === 'win32' ? resolveDocumentsDir() : undefined
  const { lines, failed, blocked } = uninstall({ root, dryRun: flags.has('--dry-run'), force: flags.has('--force'), documentsDir })
  print(lines.join('\n'))
  process.exit(blocked || failed ? 1 : 0)
}
