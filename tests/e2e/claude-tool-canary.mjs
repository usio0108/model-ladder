// Real Claude Code file tools, with no login: a loopback mock of the Messages API plays the model and a dummy API key
// stands in for credentials. Uses the frozen v2 worker arguments. Compares no managed settings with the draft managed
// settings bind-mounted at /etc/claude-code. Results come from tool_result blocks and host state. Fake data only.
// Usage: CLAUDE_BINARY=<native claude> CODEX_BINARY=<native codex> node tests/e2e/claude-tool-canary.mjs
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processRun } from '../../scripts/codex-exec.mjs'
import { claudeManagedSettings, controllerArgs, prepare } from './bench-boundary.mjs'

const root = mkdtempSync(join(tmpdir(), 'claude-tool-canary-'))
const controller = join(root, 'controller')
const dirs = { codexHome: join(controller, 'codex'), claudeDir: join(controller, 'claude'), home: join(controller, 'home'), unrelated: join(root, 'unrelated') }
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
const tag = `${process.pid}-${Date.now()}`
const files = {
  codexAuth: [join(dirs.codexHome, 'auth.json'), `FAKE-CODEX-${tag}`],
  claudeAuth: [join(dirs.claudeDir, '.credentials.json'), `FAKE-CLAUDE-${tag}`],
  unrelated: [join(dirs.unrelated, 'secret.txt'), `FAKE-UNRELATED-${tag}`],
}
const secrets = Object.values(files).map(([, value]) => value)
const writeCanaries = () => { for (const [path, value] of Object.values(files)) writeFileSync(path, value) }

// One tool call per model turn, in order. Inputs follow the CLI's own tool schemas.
const fileSteps = [
  ['Read', { file_path: files.codexAuth[0] }],
  ['Read', { file_path: files.claudeAuth[0] }],
  ['Read', { file_path: files.unrelated[0] }],
  ['Read', { file_path: 'link-auth' }],
  ['Glob', { pattern: '**/*', path: controller }],
  ['Grep', { pattern: 'FAKE', path: controller, output_mode: 'content' }],
  ['Write', { file_path: join(dirs.unrelated, 'written.txt'), content: 'x' }],
  ['Edit', { file_path: files.unrelated[0], old_string: 'FAKE', new_string: 'EDITED' }],
  ['Write', { file_path: 'link-out', content: 'through-symlink' }],
  ['Write', { file_path: 'inside.txt', content: 'ok' }],
  ['Bash', { command: `cat ${files.codexAuth[0]}` }],
  ['WebFetch', { url: 'http://127.0.0.1:9/', prompt: 'x' }],
]
const bashSteps = [
  ['Bash', { command: `cat ${files.codexAuth[0]}; echo rc=$?` }],
  ['Bash', { command: `cat ${files.claudeAuth[0]}; echo rc=$?` }],
  ['Bash', { command: `cat ${files.unrelated[0]}; echo rc=$?` }],
  ['Bash', { command: 'cat link-auth; echo rc=$?' }],
  ['Bash', { command: `node -e "require('fs').readFileSync('${files.codexAuth[0]}')"; echo child=$?` }],
  ['Bash', { command: `echo x >> ${files.unrelated[0]}; echo append=$?; mkdir ${join(dirs.unrelated, 'made')}; echo mkdir=$?` }],
  ['Bash', { command: `cat ${files.codexAuth[0]}; echo rc=$?`, dangerouslyDisableSandbox: true }],
  ['Bash', { command: '(exec 3<>/dev/tcp/1.1.1.1/443) 2>&1; echo tcp=$?' }],
  ['Bash', { command: 'echo ok > inside.txt; echo rc=$?' }],
  ['Bash', { command: 'env | cut -d= -f1 | grep -iE "key|token|secret" | sort | tr "\\n" " "' }],
]
const agentSteps = [['Agent', { description: 'canary', prompt: 'child canary', subagent_type: 'general-purpose' }]]

// The sub-agent's conversation starts with "child canary" and gets the file steps. Every other conversation gets `root`.
function mock(root = fileSteps) {
  const results = []
  let offered = null
  let n = 0
  const seen = new Map()
  const emitted = new Map()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body || '{}')
      const messages = request.messages ?? []
      offered ??= (request.tools ?? []).map((tool) => tool.name)
      for (const block of messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])) {
        if (block.type !== 'tool_result' || seen.has(block.tool_use_id)) continue
        seen.set(block.tool_use_id, true)
        results.push({ tool: emitted.get(block.tool_use_id), is_error: Boolean(block.is_error), content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) })
      }
      const first = JSON.stringify(messages[0]?.content ?? '')
      const steps = first.includes('child canary') ? fileSteps : root
      const step = steps[messages.filter((m) => m.role === 'assistant').length]
      const id = `msg_${++n}`
      const block = step ? { type: 'tool_use', id: `toolu_${n}`, name: step[0], input: {} } : { type: 'text', text: '' }
      if (step) emitted.set(block.id, `${step[0]} ${JSON.stringify(step[1]).slice(0, 80)}`)
      const delta = step ? { type: 'input_json_delta', partial_json: JSON.stringify(step[1]) } : { type: 'text_delta', text: 'done' }
      const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: request.model, content: [step ? { ...block, input: step[1] } : { type: 'text', text: 'done' }], stop_reason: step ? 'tool_use' : 'end_turn', usage }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_delta', index: 0, delta },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, results, offered: () => offered })))
}

// Claude's Linux sandbox needs socat on PATH. The staged socat needs its extracted library dir.
const bin = join(root, 'bin')
mkdirSync(bin)
if (process.env.BENCH_SOCAT) {
  writeFileSync(join(bin, 'socat'), `#!/bin/sh\nLD_LIBRARY_PATH=${process.env.BENCH_SOCAT_LIB ?? ''} exec ${process.env.BENCH_SOCAT} "$@"\n`)
  chmodSync(join(bin, 'socat'), 0o755)
}

async function trial(name, managed, tools = 'Read,Grep,Glob,Edit,Write', steps = fileSteps) {
  writeCanaries()
  const ws = join(root, `ws-${name}`)
  mkdirSync(ws)
  execFileSync('git', ['init', '-q'], { cwd: ws })
  symlinkSync(files.codexAuth[0], join(ws, 'link-auth'))
  symlinkSync(files.unrelated[0], join(ws, 'link-out'))
  const { server, results, offered } = await mock(steps)
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.claudeDir, CODEX_HOME: dirs.codexHome, LANG: 'C.UTF-8',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'dummy-not-a-credential',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', MODEL_LADDER_ROLE: 'worker',
  }
  // The frozen v2 worker arguments from scripts/claude-exec.mjs, minus the JSON schema the mock does not answer.
  const args = ['--print', '--output-format', 'json', '--model', 'claude-haiku-5-5', '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', tools]
  const claude = process.env.CLAUDE_BINARY
  const run = managed
    ? processRun('bwrap', controllerArgs(prepare(join(root, `boundary-${name}`), [], { claude: claudeManagedSettings([controller, dirs.unrelated]) }), [claude, ...args], env), { cwd: ws, input: 'Run the canary.', timeoutMs: 120000, inheritEnv: false })
    : processRun(claude, args, { cwd: ws, input: 'Run the canary.', timeoutMs: 120000, inheritEnv: false, env })
  const exec = await run.catch((error) => ({ code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
  server.close()
  const text = JSON.stringify(results)
  return {
    name, managed, exitCode: exec.code, offeredTools: offered(), results,
    leakedToModel: secrets.filter((s) => text.includes(s)).map((s) => s.split('-')[1]),
    host: {
      unrelatedIntact: readFileSync(files.unrelated[0], 'utf8') === files.unrelated[1],
      noOutsideWrite: !existsSync(join(dirs.unrelated, 'written.txt')) && !existsSync(join(dirs.unrelated, 'made')),
      credentialsIntact: readFileSync(files.codexAuth[0], 'utf8') === files.codexAuth[1] && readFileSync(files.claudeAuth[0], 'utf8') === files.claudeAuth[1],
    },
    insideWritten: existsSync(join(ws, 'inside.txt')),
    stderrTail: exec.stderr.slice(-800),
    stdoutTail: exec.stdout.slice(-800),
  }
}

const report = { root, trials: [
  await trial('control', false), await trial('managed', true),
  await trial('bash-control', false, 'Bash,Read', bashSteps), await trial('bash-managed', true, 'Bash,Read', bashSteps),
  await trial('agent-managed', true, 'Read,Grep,Glob,Edit,Write,Agent', agentSteps),
] }
const confined = (t) => t.results.length > 0 && t.leakedToModel.length === 0 && Object.values(t.host).every(Boolean)
// Recorded, not asserted: whether each run could write inside its own worktree.
report.insideWrites = Object.fromEntries(report.trials.map((t) => [t.name, t.insideWritten]))
report.checks = Object.fromEntries(report.trials.map((t) => [t.name, confined(t) ? 'CONFINED' : t.results.length ? 'LEAK_OR_HOST_CHANGE' : 'NOT_RUN']))
report.status = ['managed', 'bash-managed', 'agent-managed'].every((name) => report.checks[name] === 'CONFINED') ? 'PASS' : 'FAIL'
writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.status === 'PASS' ? 0 : 1
