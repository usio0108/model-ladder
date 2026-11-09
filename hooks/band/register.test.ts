import { expect, mock, test } from 'claude-code/testing'

for (const scenario of [
  { name: 'matching project', instructions: 'model-ladder: use ponytail when coding\nother: wrong project', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: ponytail / coding' },
  { name: 'other project', instructions: 'other: wrong project', project: 'model-ladder', root: '/repos/model-ladder', expected: null },
  { name: 'global instruction', instructions: 'use ponytail when coding', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: ponytail / coding' },
  { name: 'compact namespaced skill', instructions: 'model-ladder: plugin:code-review / code-review/coding', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: plugin:code-review / code-review/coding' },
  { name: 'natural language and multiple lines', instructions: 'model-ladder: Follow docs: read /docs and use plugin:skill\nuse ponytail when coding', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: Follow docs: read /docs and use plugin:skill\nmodel-ladder: ponytail / coding' },
  { name: 'cwd project fallback', instructions: 'use ponytail when coding', project: 'fallback', root: null, expected: 'fallback: ponytail / coding' },
]) {
  test(`instruction disclosure: ${scenario.name}`, async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/home/test' })
    on('session.cwd', () => ({ value: `/repos/${scenario.project}` }))
    on('session.repo', () => ({ value: { root: scenario.root, remote: null } }))
    on('session.usage', () => ({ value: { rateLimits: [] } }))
    on('fs.read', ($, e) => {
      return e.path.replace(/\\/g, '/').endsWith(`/repos/${scenario.project}/.claude/model-ladder.json`)
        ? { value: JSON.stringify({ worker_skills: scenario.instructions }) }
        : { deny: 'File does not exist' }
    })

    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({
        plugin: 'model-ladder', component: 'AbovePrompt', surface,
        requestId: 'band-test', viewport: { columns: 60, rows: 20 },
        props: { hasSurvey: false, isWorking: false, bodyColumns: 60, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })
      expect(await ui.find({ key: 'guard' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /skill instructions:|wrong project|worker |verifier / })).toBeUndefined()
      if (scenario.expected === null) {
        expect(await ui.find({ key: 'skills-fold' })).toBeUndefined()
      } else {
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▸' } })
        const foldedLine = scenario.expected.replace(/\s+/g, ' ').slice(0, 20)
        if (scenario.expected.length < 60) {
          expect(await ui.find({ type: 'Text', text: new RegExp(`^${foldedLine}`) })).toMatchObject({ props: { wrap: 'truncate-end' } })
        }
        await ui.press({ key: 'skills-fold' })
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▾' } })
        const expanded = await ui.find({ type: 'Text', text: scenario.expected })
        expect(expanded).toBeDefined()
        expect(expanded?.props.wrap).toBeUndefined()
        await ui.press({ key: 'skills-fold' })
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▸' } })
        if (scenario.expected.length < 60) {
          expect(await ui.find({ type: 'Text', text: new RegExp(`^${foldedLine}`) })).toMatchObject({ props: { wrap: 'truncate-end' } })
        }
      }
      await ui.unmount()
    }
  })
}

const BAND = {
  plugin: 'model-ladder', component: 'AbovePrompt', requestId: 'band-test', viewport: { columns: 100, rows: 20 },
  props: { hasSurvey: false, isWorking: false, bodyColumns: 100, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
// The engine hands fs hooks resolved paths: on Windows /repos/app arrives as C:\repos\app.
const slash = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

for (const scenario of [
  { name: 'a .git above the cwd', cwd: '/repos/app/px1', git: '/repos/app/.git', root: '/repos/app' },
  { name: 'no .git anywhere falls back to the cwd', cwd: '/repos/loose/px1', git: null, root: '/repos/loose/px1' },
]) {
  test(`state files go to the repo root .model-ladder: ${scenario.name}`, async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    mock.env(on, { HOME: '/home/test' })
    const exists: string[] = []
    const writes: string[] = []
    on('session.cwd', () => ({ value: scenario.cwd }))
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('fs.exists', ($, e) => { exists.push(slash(e.path)); return { value: slash(e.path) === scenario.git } })
    on('fs.write', ($, e) => { writes.push(slash(e.path)); return { value: undefined } })

    const measure = (tokens: number) => $.session.measure({
      context: { tokens, window: 1_000_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
      changed: ['context', 'rateLimits'],
    })
    await measure(1000)
    expect([...writes].sort()).toEqual([`${scenario.root}/.model-ladder/context.json`, `${scenario.root}/.model-ladder/usage.json`])

    // The walk ran once; a later turn in the same cwd reuses it.
    const walked = exists.length
    expect(walked).toBeGreaterThan(0)
    await measure(2000)
    expect(exists.length).toBe(walked)
    expect(writes.length).toBe(4)
  })
}


// Locks as scripts/preflight.mjs writes them. scripts/forecast.mjs adds phaseExpected (each agent's expected duration) at
// every boundary and expectedMs (the run's forecast total) once routing has one.
type Expected = { cells: Record<string, number>; phases: Record<string, number> }
const lockFile = (runId: string, task: string, phaseExpected?: Expected, expectedMs?: number, phase = 'claimed') => ({ runId, runtime: 'claude', pid: null, task, phase, startedAt: new Date(1_700_000_000_000 - 60_000).toISOString(), ...(phaseExpected && { phaseExpected }), ...(expectedMs && { expectedMs }) })

test('time column shows each agent\'s elapsed over its own expected duration, read live, elapsed alone when unknown, and a finished row keeps its value', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const locks: Record<string, Record<string, unknown>> = {
    // The run's forecast total (1h) is not what an agent row shows.
    'claude-a.json': lockFile('claude-a', 'Fix greeting', undefined, 3_600_000),
    'claude-b.json': lockFile('claude-b', 'Other run', { cells: {}, phases: { worker: 60_000 } }),
  }
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs'
    ? { value: Object.keys(locks).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => {
    const lock = locks[slash(e.path).split('/').at(-1) ?? '']
    return slash(e.path).startsWith('/repos/app/.model-ladder/runs/') && lock ? { value: JSON.stringify(lock) } : { deny: 'File does not exist' }
  })
  on('agent.spawn', ($, e) => ({ agentId: `${e.workflow?.runId}:${e.description}`, model: 'claude-haiku-5-5' }))
  on('turn.complete', () => ({ text: '' }))
  const spawn = (description: string, task: string, run: string, type = 'worker') => $.agent.spawn({ subagentType: `model-ladder:${type}`, description, prompt: `TASK (as the user wrote it)\n  ${task}`, workflow: { runId: run } })
  // The first run's lock has no expectations yet when its agents spawn: they must show up later, not be missed for good.
  await spawn('worker haiku/low', 'Fix greeting', 'host-a')
  await spawn('verify sonnet/low', 'Fix greeting', 'host-a', 'verifier')
  await spawn('worker haiku/low', 'Other run', 'host-b')
  await spawn('worker haiku/low', 'No lock for this one', 'host-c')
  await clock.advance(5000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // No expectations anywhere in the first run, no lock for the third: elapsed alone. The second run's phase fallback shows.
    expect(await ui.findAll({ type: 'Text', text: /^5s$/ })).toHaveLength(3)
    expect(await ui.findAll({ type: 'Text', text: /^5s[/]/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: '5s/1m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /[/]1h/ })).toBeUndefined()
    await ui.unmount()
  }

  // Forecast.mjs writes the first run's expectations while its agents run: a phase+model+effort entry beats the phase
  // median, and each agent shows its own value (the verifier's differs from the worker's).
  locks['claude-a.json'] = lockFile('claude-a', 'Fix greeting', { cells: { 'worker/haiku/low': 720_000, 'verify/sonnet/low': 180_000 }, phases: { worker: 300_000, verify: 120_000 } }, 3_600_000)
  await clock.advance(1000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '6s/12m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '6s/3m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '6s/1m' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^6s$/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /[/]1h/ })).toBeUndefined()
    await ui.unmount()
  }

  // A cell without its own samples falls back to its phase; a change in the lock moves a running row.
  locks['claude-a.json'] = lockFile('claude-a', 'Fix greeting', { cells: {}, phases: { worker: 300_000, verify: 120_000 } })
  await clock.advance(1000)
  const running = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await running.find({ type: 'Text', text: '7s/5m' })).toBeDefined()
  expect(await running.find({ type: 'Text', text: '7s/2m' })).toBeDefined()
  await running.unmount()

  // A finished row keeps the value it finished with; a later change in the lock does not move it.
  await $.turn.complete({ agentId: 'host-a:worker haiku/low', durationMs: 7000, answer: '' })
  locks['claude-a.json'] = lockFile('claude-a', 'Fix greeting', { cells: { 'worker/haiku/low': 3_600_000 }, phases: {} })
  await clock.advance(2000)
  const frozen = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await frozen.find({ type: 'Text', text: '✓ 7s/5m' })).toBeDefined()
  expect(await frozen.find({ type: 'Text', text: /[/]1h/ })).toBeUndefined()
  await frozen.unmount()
})

test('router, diagnose and final-diagnosis rows show elapsed only, whatever the table holds for their phase', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const lock = lockFile('claude-a', 'Fix greeting', { cells: { 'route/haiku/low': 600_000 }, phases: { route: 600_000, diagnose: 600_000, final: 600_000, worker: 300_000 } })
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs'
    ? { value: [{ name: 'claude-a.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs/claude-a.json' ? { value: JSON.stringify(lock) } : { deny: 'File does not exist' }))
  on('agent.spawn', ($, e) => ({ agentId: `${e.workflow?.runId}:${e.description}`, model: 'claude-haiku-5-5' }))
  on('turn.complete', () => ({ text: '' }))
  const spawn = (description: string, type: string) => $.agent.spawn({ subagentType: `model-ladder:${type}`, description, prompt: 'TASK (as the user wrote it)\n  Fix greeting', workflow: { runId: 'host-a' } })
  await spawn('route haiku/low', 'router')
  await spawn('diagnose haiku/low', 'router')
  await spawn('final diagnosis haiku/low', 'router')
  await spawn('worker haiku/low', 'worker')
  await clock.advance(5000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.findAll({ type: 'Text', text: /^5s$/ })).toHaveLength(3)
    expect(await ui.findAll({ type: 'Text', text: '5s/5m' })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /[/]10m/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('an overrun expected duration is recalibrated in steps for running rows, and a finished row keeps its original value', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const locks: Record<string, Record<string, unknown>> = {
    'claude-a.json': lockFile('claude-a', 'Fix greeting', { cells: {}, phases: { worker: 420_000 } }),
  }
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs'
    ? { value: Object.keys(locks).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => {
    const lock = locks[slash(e.path).split('/').at(-1) ?? '']
    return slash(e.path).startsWith('/repos/app/.model-ladder/runs/') && lock ? { value: JSON.stringify(lock) } : { deny: 'File does not exist' }
  })
  on('agent.spawn', ($, e) => ({ agentId: `${e.workflow?.runId}:${e.description}`, model: 'claude-haiku-5-5' }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ subagentType: 'model-ladder:worker', description: 'worker haiku/low', prompt: 'TASK (as the user wrote it)\n  Fix greeting', workflow: { runId: 'host-a' } })

  const show = async (text: string) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found
  }
  await clock.advance(300_000)
  expect(await show('5m/7m')).toBeDefined()
  // At 12m elapsed the 7m expectation is over: it shows 14m (step 3.5m) and holds until 14m elapsed.
  await clock.advance(420_000)
  expect(await show('12m/~14m')).toBeDefined()
  await clock.advance(120_000)
  expect(await show('14m/~17m')).toBeDefined()

  // A finished row keeps the expectation it finished with, so the overrun stays visible.
  await $.turn.complete({ agentId: 'host-a:worker haiku/low', durationMs: 720_000, answer: '' })
  expect(await show('✓ 12m/7m')).toBeDefined()
  locks['claude-a.json'] = lockFile('claude-a', 'Fix greeting', { cells: {}, phases: { worker: 60_000 } })
  await clock.advance(2000)
  expect(await show('✓ 12m/7m')).toBeDefined()
})

test('an overrun row shows ~ when approximate and what the agent is doing now; a non-overrun row keeps the task text', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const locks: Record<string, Record<string, unknown>> = {
    'claude-a.json': lockFile('claude-a', 'Fix greeting', { cells: {}, phases: { worker: 420_000 }, samples: { worker: [420_000, 1_500_000] } } as Expected),
  }
  let readable = true
  const asked: unknown[] = []
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('session.messages', ($, e: any) => {
    asked.push(e.agentId)
    return readable
      ? { value: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/repos/app/src/greeting.ts' } }, { tool_use_id: 't2', tool: 'Bash', input: { description: 'Run unit tests', command: 'npm test' } }] }] }
      : { deny: 'not readable' }
  })
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs'
    ? { value: Object.keys(locks).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => {
    const lock = locks[slash(e.path).split('/').at(-1) ?? '']
    return slash(e.path).startsWith('/repos/app/.model-ladder/runs/') && lock ? { value: JSON.stringify(lock) } : { deny: 'File does not exist' }
  })
  on('agent.spawn', ($, e) => ({ agentId: `${e.workflow?.runId}:${e.description}`, model: 'claude-haiku-5-5' }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ subagentType: 'model-ladder:worker', description: 'worker haiku/low', prompt: 'TASK (as the user wrote it)\n  Fix greeting', workflow: { runId: 'host-a' } })

  const show = async (text: string) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found
  }
  // Before the expected duration: the task text, and the agent's messages are not read.
  await clock.advance(300_000)
  expect(await show('Fix greeting')).toBeDefined()
  expect(asked).toEqual([])
  // Overrun with one longer sample only: approximate, and the last tool use replaces the task text.
  await clock.advance(420_000)
  expect(await show('12m/~14m')).toBeDefined()
  expect(await show('Bash: Run unit tests')).toBeDefined()
  expect(asked.at(-1)).toBe('host-a:worker haiku/low')
  // Not readable: the task text again.
  readable = false
  expect(await show('Fix greeting')).toBeDefined()
})

test('usage percentages are colored by level, not bold: plain under 50, yellow to the guard threshold, red at it', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  let used = 0
  on('session.cwd', () => ({ value: '/repos/model-ladder' }))
  on('session.repo', () => ({ value: { root: '/repos/model-ladder', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [{ kind: 'five_hour', percentUsed: used, resetsAt: null }] } }))
  on('fs.read', () => ({ deny: 'File does not exist' }))
  on('fs.list', () => ({ value: [] }))

  for (const [percent, color] of [[41, undefined], [60, 'yellow'], [90, 'red']] as const) {
    used = percent
    const ui = await $.ui.mount({
      plugin: 'model-ladder', component: 'AbovePrompt', surface: 'terminal',
      requestId: `band-usage-${percent}`, viewport: { columns: 80, rows: 20 },
      props: { hasSurvey: false, isWorking: false, bodyColumns: 80, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    const cell = await ui.find({ type: 'Text', text: `${percent}%` })
    expect(cell?.props.bold).toBeUndefined()
    expect(cell?.props.color).toBe(color)
    expect(await ui.find({ type: 'Text', text: /5h $/ })).toMatchObject({ props: { dimColor: true } })
  }
})

// Background task id per command, for tests that run several background commands (default bg-1).
const bgIds: Record<string, string> = { 'npm run second': 'bg-2', 'job two': 'bg-2' }
// Background rows: one per in-flight background task, only while Claude is not working and no ladder agent runs.
const mountBackground = async ($: any, on: any, workflowName = 'ladder') => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($: any, e: any) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('tool.call', { tool: 'Bash' }, ($: any, e: any) => ({ result: e.run_in_background ? { backgroundTaskId: bgIds[e.command] ?? 'bg-1' } : { stdout: 'ok' } }))
  on('tool.call', { tool: 'Workflow' }, () => ({ result: { status: 'async_launched', taskId: 'wf-1', workflowName } }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('agent.spawn', ($: any, e: any) => ({ agentId: `${e.workflow?.runId}:${e.description}`, model: 'claude-haiku-5-5' }))
  return { clock, mount: (isWorking = false) => $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking } }) }
}
const notify = ($: any, ids: string[]) => $.prompt.submit({ text: ids.map((id) => `<task-id>${id}</task-id>`).join('\n'), origin: { kind: 'task-notification' } })

test('a Bash background call adds a row only while Claude is not working, and a task-notification removes it', async ($, on) => {
  const { clock, mount } = await mountBackground($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run watch\nsecond line', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(65_000)

  let ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'shell: npm run watch' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· idle/ })).toBeUndefined()
  await ui.unmount()

  ui = await mount(true)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  await ui.unmount()

  await notify($, ['bg-1'])
  ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /· idle/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent background Bash call adds no row, since its task-notification never reaches this session', async ($, on) => {
  const { mount } = await mountBackground($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run verify', run_in_background: true, agentId: 'host-a:verifier' })
  const ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /shell: npm run verify/ })).toBeUndefined()
  await ui.unmount()
})

test('a main-session background Bash call still adds a row', async ($, on) => {
  const { mount } = await mountBackground($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run verify', run_in_background: true })
  const ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'shell: npm run verify' })).toBeDefined()
  await ui.unmount()
})

test('a non-ladder Workflow launch still adds a background row named after the workflow', async ($, on) => {
  const { mount } = await mountBackground($, on, 'review')
  await $.tool.call({ tool: 'Workflow', workflow: 'review' })
  const ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'workflow: review' })).toBeDefined()
  await ui.unmount()
})

test('a subagent Workflow launch adds no background row', async ($, on) => {
  const { mount } = await mountBackground($, on, 'review')
  await $.tool.call({ tool: 'Workflow', workflow: 'review', agentId: 'host-a:verifier' })
  const ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'workflow: review' })).toBeUndefined()
  await ui.unmount()
})

test('a ladder Workflow launch adds no background row', async ($, on) => {
  const { mount } = await mountBackground($, on)
  await $.tool.call({ tool: 'Workflow', workflow: 'ladder' })
  const ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'workflow: ladder' })).toBeUndefined()
  await ui.unmount()
})

test('a running ladder agent row hides background rows', async ($, on) => {
  const { mount } = await mountBackground($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run watch', run_in_background: true })
  await $.agent.spawn({ subagentType: 'model-ladder:worker', description: 'worker haiku/low', prompt: 'TASK (as the user wrote it)\n  Fix greeting', workflow: { runId: 'host-a' } })
  const ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /shell: npm run watch/ })).toBeUndefined()
  await ui.unmount()
})

test('a background subagent of the main session shows as an agent row until its turn completes', async ($, on) => {
  const { mount } = await mountBackground($, on)
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ subagentType: 'general-purpose', description: 'Verify member reorder only', prompt: 'Check only.', background: true })
  await $.agent.spawn({ subagentType: 'general-purpose', description: 'Foreground helper', prompt: 'Look.' })
  let ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'agent: Verify member reorder only' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Foreground helper/ })).toBeUndefined()
  await ui.unmount()

  await $.turn.complete({ agentId: 'undefined:Verify member reorder only', durationMs: 5000, answer: '' })
  ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  await ui.unmount()
})

test('background rows follow their question: a final answer hides them, a waiting reply and a new question do not', async ($, on) => {
  const { mount } = await mountBackground($, on)
  on('turn.complete', () => ({ text: '' }))
  const shows = async (text: string) => {
    const ui = await mount(false)
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found !== undefined
  }
  const turn = (answer: string) => $.turn.complete({ durationMs: 1000, answer })
  // Question 1 starts a shell task and Claude replies that it is waiting: still shown.
  await $.prompt.submit({ text: 'run the watcher' })
  await $.tool.call({ tool: 'Bash', command: 'npm run watch', run_in_background: true })
  await turn('Started it in the background, waiting for the result.')
  expect(await shows('shell: npm run watch')).toBe(true)
  // A new question does not hide it.
  await $.prompt.submit({ text: 'something else' })
  expect(await shows('shell: npm run watch')).toBe(true)
  // Question 2 ends with a plain final answer: question 1 is still unfinished, so its task keeps showing.
  await turn('Here is the other answer.')
  expect(await shows('shell: npm run watch')).toBe(true)
  // Question 3 starts its own task and ends with a final answer: that task hides, question 1's still shows.
  await $.prompt.submit({ text: 'third question' })
  await $.tool.call({ tool: 'Bash', command: 'npm run second', run_in_background: true })
  await turn('All done, nothing left to do.')
  expect(await shows('shell: npm run second')).toBe(false)
  expect(await shows('shell: npm run watch')).toBe(true)
  // Hidden but tracked: its notification removes it, and a later look shows nothing.
  await notify($, ['bg-2'])
  expect(await shows('shell: npm run second')).toBe(false)
  expect(await shows('shell: npm run watch')).toBe(true)
})

test('a task-notification is not a new question and brings its question tasks back until that turn ends', async ($, on) => {
  const { mount } = await mountBackground($, on)
  on('turn.complete', () => ({ text: '' }))
  await $.prompt.submit({ text: 'two jobs' })
  await $.tool.call({ tool: 'Bash', command: 'job one', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'job two', run_in_background: true })
  await $.turn.complete({ durationMs: 1, answer: 'Finished. Summary above.' })
  let ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  await ui.unmount()
  // job one ends; its notification wakes Claude on the same question, so job two shows again (not working view).
  await notify($, ['bg-1'])
  ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'shell: job two' })).toBeDefined()
  await ui.unmount()
})

test('a verifier spawned in its own boundary workflow run, with no TASK line, reads the only active lock', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  let locks: Record<string, Record<string, unknown>> = { 'claude-a.json': lockFile('claude-a', 'Fix greeting', { cells: {}, phases: { worker: 1_320_000, verify: 180_000 } }) }
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs'
    ? { value: Object.keys(locks).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => {
    const lock = locks[slash(e.path).split('/').at(-1) ?? '']
    return slash(e.path).startsWith('/repos/app/.model-ladder/runs/') && lock ? { value: JSON.stringify(lock) } : { deny: 'File does not exist' }
  })
  on('agent.spawn', ($, e) => ({ agentId: `${e.workflow?.runId}:${e.description}`, model: 'claude-haiku-5-5' }))
  await $.agent.spawn({ subagentType: 'model-ladder:verifier', description: 'verify haiku/low', prompt: 'You verify one model-ladder attempt.', workflow: { runId: 'boundary-3' } })
  await clock.advance(2000)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '2s/3m' })).toBeDefined()
  await ui.unmount()

  // Two active runs and no TASK line: the verifier's run is unknown, so elapsed alone.
  locks = { ...locks, 'claude-b.json': lockFile('claude-b', 'Other run', { cells: {}, phases: { verify: 600_000 } }) }
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^2s$/ })).toBeDefined()
  await ui.unmount()
})

test('a background task stopped with TaskStop leaves the band without a task-notification', async ($, on) => {
  const { mount } = await mountBackground($, on)
  on('tool.call', { tool: 'TaskStop' }, () => ({ result: { message: 'stopped' } }))
  await $.tool.call({ tool: 'Bash', command: 'node --test tests/unit/codex.test.mjs', run_in_background: true })
  let ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'TaskStop', task_id: 'bg-1' })
  ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: 'background' })).toBeUndefined()
  await ui.unmount()
})

test('a background command seen before shows its past median as the expected duration', async ($, on) => {
  const { clock, mount } = await mountBackground($, on)
  const store: Record<string, unknown> = {}
  on('store.get', ($: any, e: any) => ({ value: store[e.key] }))
  on('store.set', ($: any, e: any) => { store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  const run = async (ms: number) => {
    await $.tool.call({ tool: 'Bash', command: 'node --test tests/unit/codex.test.mjs', description: 'Run codex tests', run_in_background: true })
    await clock.advance(ms)
    await $.prompt.submit({ text: '<task-id>bg-1</task-id>', origin: { kind: 'task-notification' } })
  }
  // First run: no history, elapsed only.
  await $.tool.call({ tool: 'Bash', command: 'node --test tests/unit/codex.test.mjs', description: 'Run codex tests', run_in_background: true })
  await clock.advance(60_000)
  let ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: '1m' })).toBeDefined()
  await ui.unmount()
  await clock.advance(780_000)
  await $.prompt.submit({ text: '<task-id>bg-1</task-id>', origin: { kind: 'task-notification' } })
  await run(840_000)
  // Third run: two 14m samples, so 2m elapsed shows 2m/14m.
  await $.tool.call({ tool: 'Bash', command: 'node --test tests/unit/codex.test.mjs', description: 'Run codex tests', run_in_background: true })
  await clock.advance(120_000)
  ui = await mount(false)
  expect(await ui.find({ type: 'Text', text: '2m/14m' })).toBeDefined()
  await ui.unmount()
})

// The usage guard hands off on its own: at the threshold a measure writes the template and submits the handoff skill,
// once per window, again only after the window drops below the threshold or resets, and never with the guard off.
const mountGuard = ($: any, on: any, guard: { enabled: boolean; threshold: number }) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const submits: string[] = []
  const writes: string[] = []
  const store: Record<string, unknown> = {}
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('fs.exists', ($: any, e: any) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.read', ($: any, e: any) => slash(e.path).endsWith('/home/test/.claude/model-ladder.json')
    ? { value: JSON.stringify({ usageGuard: guard }) }
    : { deny: 'File does not exist' })
  on('fs.write', ($: any, e: any) => { writes.push(slash(e.path)); return { value: undefined } })
  on('store.get', ($: any, e: any) => ({ value: store[e.key] }))
  on('store.set', ($: any, e: any) => { store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  // The band runs the handoff skill as a command, as if the person typed it.
  on('command.run', ($: any, e: any) => { submits.push(`/${e.command}`); return { text: '' } })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  const measure = (fiveHour: number, resetsAt = '2023-11-14T23:00:00Z') => $.session.measure({
    context: { tokens: 1000, window: 1_000_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour, resetsAt }, { kind: 'seven_day', percentUsed: 10, resetsAt: '2023-11-20T00:00:00Z' }],
    changed: ['rateLimits'],
  })
  return { submits, writes, measure }
}

test('usage guard: crossing the threshold submits the handoff once, re-arms below it or on a reset', async ($, on) => {
  const { submits, measure } = mountGuard($, on, { enabled: true, threshold: 90 })
  await measure(80)
  expect(submits).toEqual([])
  await measure(90)
  expect(submits).toEqual(['/model-ladder:handoff'])
  // Still above: no second submit.
  await measure(93)
  await measure(97)
  expect(submits.length).toBe(1)
  // Below, then above again: hands off again.
  await measure(50)
  await measure(91)
  expect(submits.length).toBe(2)
  // A reset is a new window: above in it hands off again.
  await measure(95, '2023-11-15T04:00:00Z')
  expect(submits.length).toBe(3)
})

test('usage guard: off never submits the handoff, whatever the usage', async ($, on) => {
  const { submits, writes, measure } = mountGuard($, on, { enabled: false, threshold: 90 })
  await measure(95)
  await measure(99)
  expect(submits).toEqual([])
  expect(writes.some((p) => p.endsWith('/HANDOFF.md'))).toBe(false)
})
