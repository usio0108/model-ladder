# Execution v2 live integration validation

November 19, 2026, on Windows native `10.0.26300.8697` with Codex CLI `0.169.0` and Claude Code `2.1.318`, using the installed signed-in clients on disposable Git repositories. This file keeps only the checks that remain open. See the [v2 architecture](../architecture/execution-v2.md), [migration guide](../migration/execution-v2.md) and [sandbox validation](sandbox-validation.md).

## Acceptance decisions

| Acceptance item | Status | Still open |
| --- | --- | --- |
| Prove OS enforcement for worker execution | UNVERIFIED | Codex requested `workspace-write` with tool network disabled and approval policy `never`. Claude used the native file-tool allowlist and fixture-specific `Edit` rules. The live cases did not independently probe worker OS confinement, and every attempt records `enforcement: UNVERIFIED` in `attempt.evidence.workerBoundary`. |
| Positive `ISOLATED`, remote CI, and other platforms | UNVERIFIED | Only the Windows failure behavior and local delivery were evaluated. No positive `ISOLATED` run, Linux, WSL2, Docker or remote CI result exists. |

## Benchmark readiness

A controlled DIRECT and MANAGED benchmark is possible if backend, model, CLI version, fixture state and native permissions are held constant, with equivalent fixture-scoped preapproval across Claude arms. A positive `ISOLATED` benchmark is **BLOCKED** on this Windows host, and no comparative benchmark has run.
