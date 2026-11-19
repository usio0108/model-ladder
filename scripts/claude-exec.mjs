import { EnvironmentError, environmentFailure, processRun, usageLimitFailure, validate } from './codex-exec.mjs'

export async function claudeExec({ phase, cell, cwd, prompt, schema, timeoutMs, signal, executable, terminate }) {
  const tools = phase === 'worker' ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob'
  const args = [...(executable?.prefixArgs ?? []), '--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--model', cell.model, '--effort', cell.effort, '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', tools]
  const result = await processRun(executable?.command ?? process.env.CLAUDE_BINARY ?? 'claude', args, {
    cwd, input: `Internal model-ladder execution. Do not invoke model-ladder, workflows, or agents.\n\n${prompt}`, timeoutMs, signal, terminate,
    env: { MODEL_LADDER_ROLE: phase, MODEL_LADDER_AUTORUN: '0', MODEL_LADDER_BAND: '0' },
  })
  let payload
  try { payload = JSON.parse(result.stdout) } catch { /* a native startup failure may have no JSON */ }
  const source = payload?.usage
  const usage = source ? [{
    input_tokens: [source.input_tokens, source.cache_creation_input_tokens, source.cache_read_input_tokens].every(Number.isSafeInteger)
      ? source.input_tokens + source.cache_creation_input_tokens + source.cache_read_input_tokens : undefined,
    output_tokens: source.output_tokens,
    cached_input_tokens: source.cache_read_input_tokens,
  }] : []
  if (result.code !== 0 || payload?.is_error) {
    const detail = [result.stderr, payload?.result, ...(Array.isArray(payload?.errors) ? payload.errors : [])].filter(Boolean).join('\n').slice(-4000)
    const error = environmentFailure(detail) ? new EnvironmentError(detail) : new Error(`Claude ${phase} failed (${result.code})${detail ? `: ${detail}` : ''}`)
    throw Object.assign(error, { usage }, usageLimitFailure(detail) && { code: 'USAGE_LIMIT' })
  }
  try { return { value: validate(payload?.structured_output, schema), usage, models: Object.keys(payload?.modelUsage ?? {}) } }
  catch (error) { throw Object.assign(new Error(`Claude ${phase} returned invalid structured output: ${error.message}`), { usage }) }
}
