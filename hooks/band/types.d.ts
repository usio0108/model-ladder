export type Row = {
  role: 'worker' | 'test-writer' | 'router' | 'verifier'
  redo: boolean
  run: string
  id: string
  cell: string
  task: string
  status: 'running' | 'done'
  ms: number | null
  startedAt: number
  // The workflow phase (route, worker, verify, diagnose, final) and the model and effort exactly as the ladder labelled them.
  phase: string
  model: string | null
  effort: string | null
  // This agent's expected duration, set when the row finishes and so frozen; a running row reads it live, so null.
  expectedMs: number | null
}

export type Background = { id: string; kind: 'shell' | 'workflow' | 'agent'; label: string; startedAt: number; key?: string }

declare module 'claude-code' {
  interface PluginState {
    'model-ladder': { rows: Row[]; background: Background[]; isFolded: boolean; areSkillsFolded: boolean; contextText: string }
  }
}
