# Passive telemetry

`node scripts/telemetry.mjs` summarizes `.model-ladder/history.jsonl`. Add `--json` for per-run records. It starts no model call and keeps no store of its own. Runs write history as before, so it works during normal development without a benchmark.

## Sources

| History line | Path | Token source |
| --- | --- | --- |
| Execution v2 runner | `V2` | `telemetry` from `usageEvidence`, from native `turn.completed.usage` (Codex) or JSON `usage` (Claude) |
| Local Fast Path | `FAST` | Router 0 and reviewer 0 calls. The session's own tokens are not observable, so they are `UNKNOWN`. |
| Legacy Codex runner | `LEGACY_CODEX` | `usage[]` per role call |
| Legacy Claude Workflow | `LEGACY_CLAUDE` | Workflow output tokens per phase (`forecast.phases`) and in total. Input tokens are `UNKNOWN`. |

## Fields per run

`taskId`, `backend`, `path`, `profile`, `models`, `status`, `attempts`, `agentCalls` and `tokens`. The `tokens` field holds total, router, worker, reviewer and retry figures, each with calls and input, output and cached input tokens. A record also has `durationMs`, `verification`, `delivery` (with `ci`), `evidenceRefs`, `billing` and `subscriptionDelta`.

- `models.source` is `observed` when the provider reported model IDs. It is `configured` when only the configured cell is known.
- Router tokens include routing and failure diagnosis. Reviewer tokens are the verifier or reviewer role. Retry tokens are a subset of the stage totals. For legacy Codex, retry covers everything from the first diagnosis on.
- `UNKNOWN` is never zero. A stage with no calls is zero. Older Claude lines that wrote `0` for a run with attempts are `UNKNOWN`. `finish.mjs` writes `null` when the Workflow reports no total.
- `billing` is `UNKNOWN`. History cannot tell API billing from subscription use. `subscriptionDelta` gives the percentage-point change between the subscription samples taken at run start and end. Other activity on the account can be included. No money cost is computed or estimated.
- Records copy only whitelisted fields. They exclude task text, prompts, summaries, reasons, command output and credentials. History lines themselves still hold the task text, as before.

## Summary

A fast-path run writes one history line per check. The report keeps only the last line for each run ID, so a repaired run counts as one run with its attempt count.

The summary reports runs by profile, the most-used profile, retried runs, and the reviewer share of input and output tokens. It also gives the mean observed tokens per `VERIFIED` run, failures by path and status, and router and reviewer call counts. Each ratio lists how many runs were excluded as `UNKNOWN`. Every value is observed. The report adds no estimates.

Result on this repository's history from 2026-11-19 (82 history lines, 81 runs after keeping the last line per run ID, all legacy):

- 49 runs were `VERIFIED`, 18 failed and 7 were retried.
- There were 86 router calls and 53 reviewer calls.
- Reviewer share was 0.056 of input and 0.156 of output tokens.
- Each `VERIFIED` run used a mean of 19,024 output tokens across 49 runs.
- Input tokens were known for 10 of the 49 `VERIFIED` runs, with a mean of 2,299,203 for Codex legacy runs.
