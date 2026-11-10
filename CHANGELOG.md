# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

Versions follow semantic versioning; Claude Code updates require a new `.claude-plugin/plugin.json` version.

## [Unreleased]

## [1.2.0] - 2026-11-10

Codex reaches parity with the Claude Code side for the panel, usage handoff, skills and safety checks.

- **Codex CLI HUD**: shows the plugin version, current usage with reset countdowns, guard state, context (`ctx 52k/258k (20.2%)`) and the running agent's elapsed/expected time, using the same formats as the Claude band (`12m`, not `720s`). Ctrl+\ expands it to every agent, skills and the usage guard (up to half the terminal height) and collapses it back to two rows. On narrow terminals the context goes first, then the version, then the key hints; both usage percentages always stay whole.
- **Codex usage handoff**: with the SessionStart hook trusted, the CLI HUD queues a fixed handoff request once per known usage window; other surfaces get a reminder at SessionStart. Codex has a `handoff` skill, and a usage stop tells the session to write the AI handoff; the generated template stays the fallback at a hard limit.
- **Codex worker skills are enforced**: workers report each configured capability, and an applicable, available one left unused fails the attempt before verification. The report is self-declared.
- **Codex router safety**: a read-only route for a task that looks like an edit stops with `NEEDS_INPUT` before any worker runs, instead of reporting a false no-change success; it never grants write access on its own. An explicit no-edit instruction (for example 「別動任何檔案」, 「不修改」, "do not modify") keeps a read-only route even when the task contains edit words.
- Codex and Claude panel titles show their packaged plugin version (`model-ladder (v1.2.0)`) and drop it before usage on narrow layouts. The Claude band now measures the whole header for this.
- Codex DIRECT and the CLI HUD read token counts only from the rollout matching the session ID and cwd. Overrunning Codex agent rows show the latest command when the exec event stream provides one.
- Without `node-pty`, the HUD starts plain `codex` without passing on its own HUD environment variables.
- Codex retries a transient worktree creation failure once before reporting an error.
- **Worktree cleanup**: every worktree removal (finish, run pruning, Codex attempts) goes through one helper that removes locked worktrees with `--force --force`, prunes, and deletes the leftover `worktree-wf_*` branch; branches left by earlier runs are swept too. A removal blocked by a Windows file lock is retried briefly, then left for the next run's pruning without blocking the current run.
- **Claude band background rows** show only tasks whose user question is still unfinished. A final answer that is not waiting on a task hides that question's tasks (still tracked, so their end notification removes them and records the duration); a new question does not hide an earlier question's tasks. Limit: `turn.complete` gives only the reply text, so a reply counts as waiting when it is empty or mentions waiting, the background or a notification (English or Chinese keywords).
- README documents how to update the Codex plugin: upgrade the marketplace, re-add the plugin, re-trust the modified SessionStart hook in `/hooks`, start a new session, then open a new PowerShell window once `node-pty` is installed.
- Known limits: Codex does not track background tasks yet, and the watcher handoff remains manual.

## [1.1.5] - 2026-11-06

- The usage guard now hands off on its own in Claude Code: when the five-hour or seven-day window reaches the threshold, the band writes the handoff template and runs `/model-ladder:handoff` so the main session writes the AI version. It does this once per window, persisted across reloads and new sessions, and again only after the window drops below the threshold or resets. It hands off even with no ladder run, since the handoff skill writes from the conversation.
- `handoff now` now actually asks the main session for the AI-written handoff. It used `$.prompt.submit`, which Claude Code refuses for text that starts with `/`, so it only ever showed the fallback toast; it now uses `$.command.run`.
- Worker skill instructions are enforced, not just suggested: with `worker_skills` set, the worker reports every capability they name (applies, available, used, note), and an attempt where one applies and is available but was not used fails before verification (`worker skipped required skills: ...`). Unavailable or not-applicable capabilities do not fail. The finish report shows a `Skills` line per attempt.
- On the DIRECT path the main session now follows `worker_skills` itself and passes `verifier_skills` to its verifier, as the Codex runner already did.

## [1.1.4] - 2026-11-03

- The Claude Code band no longer shows a `background` row for the ladder's own Workflow launch (`workflow: ladder`); you already know model-ladder is choosing a model. Other async Workflow launches still get a row.
- A background Bash call or Workflow launch made inside a subagent (for example a verifier running a test command in the background) no longer adds a background row. Its task-notification goes to the subagent, never to the main session, so the row used to stay after the task ended.
- When Claude Code refuses a worker's isolation worktree ("git could not be run to resolve it"), a transient failure, the worker or test-writer now retries once with the same model and effort instead of the run stopping with `stop_environment`.
- Cleanup removes worktrees with `git worktree remove --force --force`, so the worktrees Claude Code locks no longer linger with their `worktree-wf_*` branches.

## [1.1.3] - 2026-11-02

- Overrun estimates now use history: once an agent row passes its expected duration, the expected value becomes the median of at least 2 past runs that took longer (agentExpectations now also returns the raw samples), else the step estimate shown with a leading `~` (for example `12m/~14m`) in the Claude Code band and the Codex panel; and in the Claude Code band an overrun agent row shows its current tool activity (for example `Bash: Run unit tests`) in place of the task text, falling back to the task text when it cannot be read.
- Codex on Windows: the SessionStart hook adds a marked `codex` function to the PowerShell profiles, so typing `codex` in a new PowerShell window opens the model-ladder HUD; subcommands, redirected IO and a missing `node-pty` or Node.js run the native `codex.exe`, `node-pty` installs in the background, and `"hudTakeover": false` removes the function. The HUD also falls back to plain Codex when `node-pty` cannot load.
- Band usage percentages are no longer bold and use raw colors (yellow from 50% up to the usage guard threshold, red at or above it), since some surfaces drew the theme colors as plain text.
- Background rows also cover subagents the main session starts in the background (the Agent tool with run_in_background): an `agent: <description>` row shows while Claude is idle and leaves when that agent finishes.
- A background row also leaves when its task is stopped with TaskStop, which sends no task-notification, so stopped tasks no longer linger in the band.
- A background shell row shows an expected duration once the same command (its first line) has finished before: the median of its last ten runs, kept across sessions and recalibrated like an agent row when overrun; a first run shows elapsed only.
- The time column header in the Claude Code band and the Codex panel reads `act./est.` (actual elapsed over expected) instead of `time`.
- Claude Code verifier and diagnosis rows now show their expected duration too: their prompts carry no TASK line and each ladder boundary is its own workflow run, so the band now uses the only active ladder lock when it cannot match a task (two or more active runs still show elapsed only).

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
