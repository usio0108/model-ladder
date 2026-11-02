# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

Versions follow semantic versioning; Claude Code updates require a new `.claude-plugin/plugin.json` version.

## [1.1.2] - 2026-11-02

- Workers now follow editing rules (Edit/Write or apply_patch only, `uv run` with cleanup, `git status` check before reporting); the router suggests `claude plugin test .` when band files change.
- The Claude Code verifier now returns `workerFiles` (the worker's unstaged and untracked paths from `git status`), and with a verify command it passes only when the command succeeds and every ACCEPTANCE item is met; a passing verdict with empty `workerFiles` becomes a failure (`worker changed nothing`) so the ladder escalates.
- A running agent row whose elapsed time has reached its expected duration now shows a recalibrated expected duration (expected plus whole steps of max(1 minute, half the expected value) until it exceeds elapsed, for example 12m/14m for a 7m expectation) in the Claude Code band and the Codex panel; a finished row keeps its original expected duration.
- The Claude Code band replaces the lock-based `no model` row with background rows: one `background` row (elapsed time and `<kind>: <label>`) per in-flight Bash background task or async Workflow launch of this session, shown only while Claude is not running a turn and no ladder agent runs, and removed when the task's notification arrives. The `direct` phase and `phase.mjs <runId> direct` step are removed.
- Only worker, test-writer and verifier rows show an expected duration; router, diagnose and final-diagnosis rows show elapsed time only.
- The router also returns `workerMinutes` and `verifyMinutes` (positive integer wall-clock minutes for one worker attempt and one verification). The plan carries them into the run lock's per-agent table as the expectation for a phase history has no sample for, so worker and verifier rows have an expected duration from the first run. History samples (phase plus model/effort, then phase) still take priority.
- The Codex router returns `workerMinutes` and `verifyMinutes` too (positive integers, schema-checked); after routing they fill the Codex panel's per-agent table only for a worker or verify phase history has no sample for, so the first Codex run shows elapsed/expected on worker and verifier rows.
- The band usage line shows each percentage bold and colored: plain under 50%, warning from 50% up to the usage guard threshold, error at or above it; the rest stays dim. The instructions row leaves a space after its fold arrow.

## [1.1.1] - 2026-11-02

- The time column of each agent row (router, worker, test-writer, verifier) in the Claude Code band and the Codex panel now shows that agent's own elapsed time over its own expected duration, not over the whole run's forecast total. The expected duration is the median of earlier comparable successful runs' phase timings, keyed by phase plus model/effort once there are two samples and by phase alone before that; with no samples only elapsed time shows.
- A running row reads its expected duration live, so it no longer goes missing when the run has no forecast yet at spawn. The `no model` row keeps run elapsed over the run's forecast total.

## [1.1.0] - 2026-10-30

- Duration forecasts: structured ranges, phase timings and per-window usage headroom are recorded in live, result and history JSON and calibrated from comparable successful runs; the split prompt is removed.
- The panel time column shows elapsed/expected (for example `5s/12m`) in the Claude Code band and the Codex panel, falling back to elapsed time when no forecast exists.
- When the startup forecast says a usage window is insufficient or at risk, Claude Code and Codex ask once before any worker starts (`acceptUsageRisk: true` continues); the usage guard still applies.
- The Claude Code band shows a `no model` row while the main session holds a run between agents (preflight, questions, finish), instead of `idle`.
- The band writes `.model-ladder` state at the repository root, not the shell's current subfolder.
- The Codex usage guard now sees live usage during role processes, and Codex usage-limit errors write `HANDOFF.md` even when stderr has sandbox warnings.
- Lines like `use ponytail:ponytail` stay global; only a `project: ` prefix scopes a role instruction.

## [1.0.3] - 2026-10-30

- Scope role instructions with `project: instructions`, while unprefixed lines remain global.
- Show only applicable instruction text in the Band, with a collapsible single-line preview and no `skill instructions:` label.
- Apply the same project selection in Claude Code, Codex, and linked worktrees.

## [1.0.2] - 2026-10-30

- Shortened plugin settings descriptions, including context-window information in the Band option.
- Added the installed version to the first configuration label.
- Simplified both language editions of the README, advanced usage, design notes, and release history.
- Updated Band examples and moved detailed operation and configuration references to the advanced guides.
- Removed unreliable performance comparisons and outdated test-result claims, preserving third-party license text.

## [1.0.1] - 2026-10-30

- Codex DIRECT uses measured caller context and an isolated draft that must pass independent verification before application.
- Optional Codex commits preserve unrelated staged changes and skip files with pre-existing or concurrent edits.
- Codex SessionStart respects personal/project autorun and panel settings, with test-writer rules aligned across runtimes.
- Quota handoffs use per-run live state, and detected usage stops terminate other registered runner process trees and write `HANDOFF.md`.
- Codex polls usage every 2 seconds during agents and verify commands.
- Recognized limit-only responses stop as `USAGE_LIMIT`.
- Windows process-tree termination failures retain registration and report the error without a false stopped handoff.
- Updated both runtime skills and bilingual documentation for DIRECT, commits, splitting, and platform limits.

## [1.0.0] - 2026-10-29

First public release, including prior development history.

- Route Claude Code and Codex tasks to suitable models, isolate attempts, verify independently, and escalate failed attempts.
- Small Claude tasks can use DIRECT at `direct_threshold`, with independent verification still required.
- Above `split_minutes`, choose sequential parts, the whole task, or stop.
- Non-overlapping runs execute concurrently and apply results one at a time.
- Usage stops preserve work and write `.model-ladder/HANDOFF.md`; `/model-ladder:handoff` creates one on request.
- `worker_skills` and `verifier_skills` select available role capabilities and report missing ones.
- Layer defaults, personal settings (`~/.claude/model-ladder.json` or `~/.codex/model-ladder.json`), and project overrides.
- Claude Band shows roles, usage, and context; Codex HUD shows status in the same terminal.
- Codex artifacts use system temp, while Git excludes `.model-ladder/` and `.claude/worktrees/` automatically.
- Local verification targets relevant tests, with the full suite left to CI.
- Hooks explain installation requirements when Node.js 20+ is missing.
