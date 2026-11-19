import { spawnSync } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

export function killWindowsTree(pid) {
  const system = process.env.SystemRoot
  if (!system || !isAbsolute(system)) throw new Error('SystemRoot is unavailable for Windows process tree termination')
  const command = join(system, 'System32', 'taskkill.exe')
  const result = spawnSync(command, ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5000 })
  if (result.status !== 0 || result.stderr?.trim()) {
    const detail = (result.stderr || result.stdout || result.error?.message || 'No diagnostic').trim()
    throw new Error(`taskkill /T /F for PID ${pid} failed (${result.status ?? 'no exit status'}): ${detail}`)
  }
}

export function killChildTree(pid) {
  if (process.platform === 'win32') return killWindowsTree(pid)
  process.kill(-pid, 'SIGKILL')
}
