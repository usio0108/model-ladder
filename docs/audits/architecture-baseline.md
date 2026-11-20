# Architecture baseline

Baseline revision `98db16dcb4ae0b4b6f08e29f0b3682677a3115bf` on `main`, November 19, 2026. This file lists only the gaps that are still open in the current code. Gaps closed by Execution v2, the Local Fast Path and release 1.3.0 are removed.

Lydia Hallie's talk motivates delegating approvals to native policy, isolation to the environment, and completion checks to tests and CI. [Rethinking Claude Code Best Practices](https://ai.engineer/talks/vlfCjWuv4es-rethinking-claude-code-best-practices)

## Open gaps

| Capability | Finding | Still open | Evidence in current code |
| --- | --- | --- | --- |
| Routing and contract | PARTIALLY IMPLEMENTED | A task contract and the Local Fast Path skip the router. A plain legacy task still costs a router model call, and the Codex and Claude route schemas still differ. | `scripts/codex-run.mjs` (`ask('route', …)` when there is no contract), `workflows/ladder.js` route schema, `scripts/fast-path.mjs` |
| Verification | PARTIALLY IMPLEMENTED | Claude still has a model verifier run the check, and no deterministic command exit is recorded at the same trusted evidence boundary as the candidate tree. | `workflows/ladder.js` (candidate snapshot before and after the verifier, no command exit), `scripts/finish.mjs` (records the tree pair only) |
| Failure and retry | PARTIALLY IMPLEMENTED | Legacy ladder runs still call an LLM diagnosis after every ordinary failure and do not detect a repeated failure first. Contract runs already classify failures and stop on a repeat. | `scripts/codex-run.mjs` (`ask('diagnose', …)`), `scripts/ladder-rules.mjs` |
| Concurrency | PARTIALLY IMPLEMENTED | A claim coordinates legacy runs but does not constrain writes. Legacy Claude finish does not compare the final diff with the claimed scope. Contract runs and the fast path do. | `scripts/runs.mjs`, `scripts/finish.mjs` (no scope check), `scripts/codex-run.mjs` (contract scope check) |
| Security | PARTIALLY IMPLEMENTED | The default verification command runs in the host shell and records `HOST_UNSANDBOXED`. The Claude edit hook covers only its matched tools and fails open on errors. | `scripts/codex-run.mjs` (`command.sandbox = 'HOST_UNSANDBOXED'`), `hooks/guard.mjs`, `hooks/hooks.json` |
| Usage guards and handoff | PARTIALLY IMPLEMENTED | The panel file `.model-ladder/live.json` and `.model-ladder/HANDOFF.md` are single shared files, so the latest writer wins. Handoff reads per-run live state and refuses state from another run, but cannot keep two runs' handoffs at once. | `scripts/codex-run.mjs` (writes both live files), `scripts/codex-handoff.mjs` |
| History and telemetry | PARTIALLY IMPLEMENTED | Codex usage comes from a bounded stdout tail (128 KiB), so an early `turn.completed` event can be missed. Raw event and stderr files stay in each run directory and can contain sensitive data. | `scripts/codex-exec.mjs` (`tail(stdout + data, 131072)`, `*.events.jsonl`) |
| Configuration | CONFIRMED | Project-provided verification commands and policy have the same trust as personal settings. They are not distinguished from managed host settings. | `scripts/codex-run.mjs` (`VERIFY_COMMAND_REQUIRED`), `scripts/config.mjs`, `hooks/config-layers.mjs` |
| CI | PARTIALLY IMPLEMENTED | The workflow has no lint step and no independent security scanning. Required-check settings have no evidence in the workflow. [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | `.github/workflows/test.yml`, `scripts/ci-evidence.mjs` (reports required checks as `UNKNOWN` without a token) |
| Comparative benchmarks | PARTIALLY IMPLEMENTED | No controlled native-versus-baseline-versus-Execution-v2 trial has run, so the routing overhead is unproven. The old `bench.mjs` still prints missing cost as zero and sums missing output tokens. | `tests/e2e/bench.mjs`, [controlled comparison](../benchmarks/execution-v2-comparison.md) (pilot 0/8, formal 0/102) |

## Native capabilities not yet used

| Capability | Claude Code | Codex | Integration decision |
| --- | --- | --- | --- |
| Worktree and background | `--worktree`, `--bg` and `--cloud` appear in local help. | `exec --worktree` appears in local help. | Reuse native worktrees where they preserve the dirty baseline and ownership semantics. The runners still create their own Git worktrees. [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Codex CLI](https://developers.openai.com/codex/cli/reference) |
| Resume and review | `--resume` and cloud `ultrareview` appear in local help. | `exec resume` and `exec review` appear in local help. | Evaluate native review separately with the same acceptance and delivery gates. The runners use their own checkpoints and review roles. [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Codex CLI](https://developers.openai.com/codex/cli/reference) |
