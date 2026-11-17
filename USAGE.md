# Advanced usage

[README](README.md#how-to-use) · [繁體中文](USAGE.zh-TW.md) · [Design](DESIGN.md)

## Reports

Reports summarize the task, attempts, changed files, verification, and remaining limits in your session language.

| Result | Meaning |
|---|---|
| `VERIFIED` | Verification passed; editing tasks apply the verified change. |
| `DIRECT` | An unverified draft needs caller work and independent verification. |
| `DIRTY` | Confirm whether to build on existing uncommitted changes. |
| `NEEDS_INPUT` | Clarify the task, approve criteria, answer a usage-risk question, or resolve an overlap. |
| `STALE_RUN` | Inspect the listed locks and processes before authorizing cleanup. |
| `CONFLICT` | The patch could not apply; inspect the retained patch and worktree. |
| `STOPPED` / `FAILED` / `ERROR` | Read the reason and resolve the blocker before retrying. |

Claude quota stops return `USAGE_LIMIT`; Codex returns `STOPPED` with `errorCode: "USAGE_LIMIT"`.
Run history is stored in `.model-ladder/history.jsonl`.

Without an existing verify command or skill, supply explicit acceptance criteria or use `create-verification-skill` and `maintain-verification-skill`.
Claude generates `.claude/skills/verify/`; Codex generates `.agents/skills/verify/` and also accepts the Claude path.
The generators are adapted from pstack under MIT; see [NOTICE.md](NOTICE.md).

## Codex runner and HUD

| Goal | Command |
|---|---|
| Run a task | `node scripts/codex-run.mjs "<task>"` |
| Supply JSON input | `node scripts/codex-run.mjs --input <file>` |
| Open a panel | `node scripts/watch.mjs --cwd <repo>` |
| Start a CLI HUD | `npm ci`, then `node scripts/codex-hud.mjs --cwd <repo>` |
| Resume with the HUD | Add `-- resume` to the HUD command. |

Only `VERIFIED` exits with code 0; `DIRECT`, `DIRTY`, `NEEDS_INPUT`, and `STALE_RUN` exit 2, and other results exit 1.
Input also accepts JSON on stdin; on Windows, use a UTF-8 input file in the system temp directory.

Reuse the panel across tasks; without a visible terminal, read runner progress in tool output.
The HUD must launch Codex and cannot attach to an existing session. On Windows the Codex SessionStart hook sets this up by itself: it adds a marked `codex` function to your PowerShell profiles (PowerShell 7 and Windows PowerShell), so from the next new PowerShell window typing `codex` opens the HUD. The function uses the newest complete installed plugin version each time it runs, and management subcommands such as `plugin`, `review` or `update` run the native `codex.exe` directly. Subcommands such as `exec` or `login`, redirected input or output, and a missing `node-pty` or Node.js run the native `codex.exe` directly; `node-pty` is installed in the background the first time, and SessionStart shows whether it is still installing or ready. Set `"hudTakeover": false` in `~/.codex/model-ladder.json` to remove the function again.
Windows requires native `codex.exe`, selected through PATH or `CODEX_BINARY`, rather than a `.cmd` or `.bat` shim.
In the CLI HUD, Ctrl+] (or Alt+H, which an IME such as Bopomofo does not turn into 】) writes a run handoff template when available and shows how to invoke `$handoff` for conversation context. The HUD uses two terminal rows; Ctrl+\ expands it to show every agent, skills and the usage guard (up to half the terminal height) and collapses it back.

## Concurrent runs

| Situation | Behavior or action |
|---|---|
| Separate file scopes | Runs may proceed together across both runtimes. |
| Overlap | `NEEDS_INPUT` with `reason: "OVERLAP"`; wait for the other run, then retry. |
| Empty, wildcard-only, or out-of-repo scope | Counts as the whole repository. |
| Patch conflicts despite scope checks | Keep the patch and worktree for review. |
| Another run left uncommitted changes | Confirm `DIRTY` before building on its snapshot. |
| Dead, unreadable, or legacy lock | Inspect it, then authorize `--clear-stale` or `clearStale: true`. |
| Crashed Claude session | Clear its confirmed inactive run ID with `--clear-stale=<runId>` or `clearStale: "<runId>"`. |

Never clear a lock with a live process; Claude locks have no persistent process ID and remain active until finish or confirmed cleanup.
Results apply one run at a time; guards protect all active scopes.
Shared `live.json`, the panel, and `HANDOFF.md` show the last writer, while automatic Codex quota handoffs use per-run live state.

## Run files

| Location | Contents |
|---|---|
| `.model-ladder/runs/` | Run locks and Claude transient state, setup patches, and conflict patches. |
| `.model-ladder/` | Shared history, live state, usage, context, and `HANDOFF.md`. |
| `<system temp>/model-ladder/<repo hash>/codex-<uuid>/` | Codex worktrees, logs, outputs, snapshots, checkpoints, and `result.json`. |

Use the paths returned by the runner rather than guessing them.
Pruning removes completed artifacts but preserves active runs, conflicts, patches, checkpoints, unfinished runs, and failed attempts requested through `keepFailed`.

## Codex DIRECT, commits, and recovery

| Operation | Required steps |
|---|---|
| DIRECT | Supply actual `contextTokens` and `contextWindow`; the router must also judge the task small. |
| Complete DIRECT | Edit only the returned `worktreePath`, then resubmit the original input with `directRun` and `directSummary`. |
| Force normal ladder | Use `forceLadder: true`, which disables DIRECT. |
| Run a large task | If the forecast says usage may run out, answer the usage-risk question (`acceptUsageRisk: true` continues). |
| Commit | Explicitly enable `commit: true` to commit verified files without unrelated staged changes. |
| Resume a timeout | Reuse the original input and returned `resumeRun`; the skill retries automatically at most twice. |

DIRECT is never completion; obey returned protection rules and independently verify before applying.
If the caller cannot edit the draft under its sandbox, use the normal ladder without bypassing permissions.
Resume validates the original checkout, configuration, task, and acceptance criteria, then continues the draft in a fresh worktree.
Do not automatically resume cancellations, quota stops, or unresolved environment errors.
Files with pre-existing or concurrent edits skip the commit, and skipped or failed commits leave the verified change applied with `outcome.note`.
No run pushes changes.

## Advanced settings

Settings resolve as defaults, personal file, then project file; `usageGuard` merges field by field.
Personal files are `~/.claude/model-ladder.json` and `~/.codex/model-ladder.json`; project files use `.claude/` and `.codex/` respectively.

| Key | Default | Meaning |
|---|---|---|
| `router` | Claude: `sonnet/low`; Codex: `terra/low` | Route tasks and diagnose failures. |
| `verifier` | Claude: `haiku/low`; Codex: `luna/low` | Independently check results. |
| `tiers` | Haiku, Sonnet, Opus; Codex uses `luna`, `terra`, `sol` | Ordered models and efforts, with `maxEffortJump` limiting effort increases. Codex family names (`luna`, `terra`, `sol`) resolve automatically to the latest version in `$CODEX_HOME/models_cache.json` (fallback `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol`); full names such as `gpt-5.6-terra` are used as written. |
| `maxAttempts` | `4` | Maximum attempts. |
| `verify` | Discovered | Existing command or project verification skill. |
| `protected` | `[]` | Extra paths workers cannot modify. |
| `commit` | `false` | Commit verified changes when explicitly enabled. |
| `keepFailed` | `false` | Retain failed worktrees. |
| `network` | `false` | Codex only. When `true`, worker and verifier sandboxes get network access (`sandbox_workspace_write.network_access`), report tasks run in `workspace-write` (network has no effect in `read-only`) while edits stay forbidden and detected, and prompts tell roles to fetch with Python rather than curl. |
| `timeoutMs` | `600000` | Codex idle timeout per role or verify command. |
| `usageGuard` | Enabled, `90%` | Usage protection, preferably stored in the personal file. |
| `worker_skills` / `verifier_skills` | Empty | Natural-language role instructions. Named capabilities that apply are mandatory: the worker must actually invoke them, not just follow them in spirit. |
| `direct_threshold` | `30` | Context percentage for small-task DIRECT, or `"off"`. |
| `autoRun` / `band` | `true` | Default routing and display controls. |

Claude model aliases follow available versions; configure Codex model IDs and efforts for your account.
Claude's plugin picker offers DIRECT values 20–80 in steps of 10, plus `off`.
Without explicit `verify`, Codex prefers a project verify skill, then discovers existing npm, pytest, Cargo, Go, Maven, or Make checks.

### Codex sandbox: uv and Node projects

Codex workers and verifiers run in a sandbox with no network that may write only inside the attempt worktree. A fresh worktree has no `.venv` and no `node_modules`. The runner does not loosen the sandbox and does not change your global environment variables.

| Project | What the runner does |
|---|---|
| Any project, Codex worker, verify command and verifier | `TEMP`, `TMP` and `TMPDIR` point at `<worktree>/.ml-tmp`, because the Codex sandbox cannot write the system temp dir (`tempfile.gettempdir()` fails, pytest `tmp_path` breaks). The folder holds its own `.gitignore` with `*`, so it is never part of the patch. The runner's own environment is unchanged. |
| uv project (`uv.lock`) whose main checkout has `.venv` | The worker, the verify command and the verifier get `UV_PROJECT_ENVIRONMENT` set to the main checkout's `.venv` (or to your own `UV_PROJECT_ENVIRONMENT`), `UV_NO_SYNC=1`, `UV_OFFLINE=1`, `UV_PYTHON_DOWNLOADS=never`, `PYTHONDONTWRITEBYTECODE=1` and `UV_CACHE_DIR=<worktree>/.uv-cache`. Codex roles receive them through `shell_environment_policy.set`. `uv run pytest` then runs offline against the main `.venv` without syncing or writing to it, and no `.venv` is created in the worktree. The cache holds its own `.gitignore`, so it is never part of the patch, and it is removed with the worktree. |
| uv project whose verify command or verify skill uses `uv`, and the main checkout has no `.venv` | The run stops before any role with `STOPPED`, `errorCode: "UV_SYNC_REQUIRED"` and "Run uv sync in the main checkout first". It does not retry. Run `uv sync` in the main checkout, then rerun the task. |
| Node project with dependencies, verify uses npm, npx, pnpm, yarn or bun, the worktree has no `node_modules`, and the command fails | The run stops with `STOPPED` and "Frontend checks not run". This is never reported as a pass, and no stronger model is tried. The runner makes no `node_modules` junction, so worktree cleanup never follows a link into the main checkout. Run the checks yourself, or set `verify` to a check that needs no install. |

Worker and verifier prompts state these limits. When diagnosis stops for an environment problem, the report adds the same actionable hint: run `uv sync` in the main checkout first, or set `verify` in `.codex/model-ladder.json` to a command that needs no install or network. The Claude runtime is unchanged.

| Environment variable | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | Change the personal settings directory. |
| `MODEL_LADDER_USER_CONFIG` | Select a personal settings file directly. |
| `MODEL_LADDER_AUTORUN=0` | Disable default routing. |
| `MODEL_LADDER_BAND=0` | Hide the Codex panel independently of autorun. |
| `CODEX_BINARY` | Select a native Codex executable. |
| `MODEL_LADDER_NO_UPDATE_CHECK=1` | Disable version checks. |

Claude plugin role instructions provide defaults that project keys override, including an explicit empty string.
Use one rule per line: `model-ladder: use plugin:skill` applies only when the main repo folder is exactly `model-ladder`; lines without a `project: ` prefix apply globally, including ones with a colon such as `use ponytail:ponytail`.
The first colon separates the project name; matching bodies retain later colons, and empty or unresolved `${...}` values add no instructions.
Unavailable capabilities are reported before execution and in the final report, for example: `ponytail` is not available in this project.
Role instructions may name skills, plugins, slash commands, or MCP servers, but cannot expand permissions, permit verifier edits, or recurse into the ladder.

## Band and panel details

Basic fields and controls are shown in the [README](README.md#band-claude-code).

| Detail | Behavior |
|---|---|
| Context | Claude shows `ctx 287k/1M (28.7%)`, only the window if tokens are unknown, or nothing without a known window. |
| Codex context | The runner reads token counts only from the rollout matching the current session ID and cwd; the HUD uses the ID provided by its trusted SessionStart hook. If a match is unavailable, context is omitted. Never invent numbers. |
| Guard controls | Save only the changed field to personal settings; project overrides remain effective. |
| Threshold | Enter or 5 seconds without typing saves it without changing the guard switch. |
| Instructions | Only matching and global rules appear, without a label prefix; the Band previews one line and its arrow expands or collapses the text. |
| Claude handoff | `handoff now` writes a template, then runs `/model-ladder:handoff` when the session is idle. With the usage guard on, the band does the same once when a usage window reaches the threshold. |
| Handoff fallback | If submission fails, a toast gives the command; the template remains available. |
| Codex controls | Enter `g`, `t 90`, `h`, or `q`, followed by Enter. |
| CLI controls | `watch.mjs` accepts `--guard on|off`, `--threshold 1-100`, and `--handoff`; add `--set` to save and exit without watching. In Codex you can also just ask, for example "set the model-ladder threshold to 80". |

The Claude Code band also shows one `background` row per in-flight background task of this session (a Bash call with `run_in_background`, or an async Workflow launch other than the ladder's own) that the main session started, not a subagent: elapsed time only, with the task `<kind>: <label>` (`shell` or `workflow`). The rows show only while Claude is not running a turn and no ladder agent runs, and each leaves when its task-notification arrives.
Manual handoff does not cancel the run.
If Codex autorun or its panel is missing, check that the plugin is enabled, restart the session, and review/trust its hooks in `/hooks`.
Hook trust applies to the current definition and content: after an update, open `/hooks` in Codex CLI, review and re-trust the model-ladder SessionStart hook if marked modified, then start a new session. Codex skips untrusted or modified hooks; manually running the script does not establish trust. See [OpenAI's hook documentation](https://learn.chatgpt.com/docs/hooks).
Explicitly invoking the ladder skill also initializes the panel; no editor UI extension is installed.

## Usage protection details

| Condition | Behavior |
|---|---|
| Claude usage threshold | Checked before a run and after failed attempts. |
| Codex usage threshold | Checked at role boundaries and every 2 seconds during execution. |
| Usage stop in an active run | Stops the run and other registered runner process trees on the machine. |
| Unknown usage | Does not block execution. |
| Hard quota limit | Stops even when the guard is off, including recognized limit-only responses. |
| Auth, sandbox, or model-access error | Stops as an environment error rather than a quota handoff. |
| Windows denies tree termination | Report the failure, retain registration, and never claim the process stopped. |

Do not bypass the sandbox, clear a live lock, or replace process-tree termination with a single-PID kill.
Registered runner termination does not imply control over arbitrary Claude host sessions or hosted agents.
Claude usage comes from the Band or `scripts/usage-statusline.mjs`; only Pro/Max plans report it.

`USAGE_LIMIT` retains available draft work and writes `.model-ladder/HANDOFF.md`.
The main session adds the goal, decisions, completed work, next steps, and resume instructions above the unchanged generated verification appendix, which remains authoritative.
If the session cannot call a model, keep the template as the fallback.
A force-killed run may lack a checkpoint or `result.json`; inspect its draft and restart the original task after quota reset instead of inventing `resumeRun`.

## Forecasts and calibration

Duration forecasts are stored in live/result/history JSON; the panel time column shows elapsed/expected.
A worker, test-writer or verifier row shows its own elapsed time over its own expected duration (router, diagnose and final-diagnosis rows show elapsed time only): the median phase duration from `forecast.phases` of comparable successful runs (VERIFIED, completed, uncensored, within 90 days, same runtime), keyed by phase plus model/effort once at least two runs have it and by phase alone before that. With no samples for a phase, the router's `workerMinutes` and `verifyMinutes` (positive integer wall-clock minutes for one worker attempt and one verification, carried in the plan and written into the run lock's `phaseExpected` after routing; Codex writes them into `live.expected`) stand in for it; history samples keep priority. Without either the row shows elapsed time only.
Claude Code reads the table live from the run lock's `phaseExpected` (written at each workflow boundary) and the Codex panel reads `expected` in `live.json`; a finished row keeps the value it ended with. Once a running row has been running at least as long as its expected duration, the shown expected duration is recalibrated in steps: the expected value plus the smallest whole number of steps of max(1 minute, half the expected value) that lands above the elapsed time (7m expected shows 14m at 12m elapsed and 17.5m at 14m, so the denominator changes only at step boundaries). A finished row keeps its original expected duration, so an overrun stays visible as `✓ 12m/7m`.

Forecast ranges cover routing, implementation and self-checks, test commands, independent
verification and retry risk. Router ranges are uncalibrated judgments until
comparable successful histories supply empirical min/median/max error ratios.
Those ranges are observations, not confidence intervals or accuracy claims.
Original forecasts, boundary updates, phase models, efforts, tokens and clock timings,
actual elapsed time and signed/absolute error remain in history. Interrupted,
DIRECT, errored and aborted runs are censored; failed runs are retained but never
used as successful calibration evidence. Comparability requires the same runtime,
starting cell, router, verifier, verification command, attempt limit, router estimate and task mode;
only the last 90 days are used. Continuations use separate histories and retain
the earlier original forecast. Without comparable continuation data, their bounds
remain unknown.

Usage is assessed separately for each available subscription window, against both
100% headroom and the enabled guard threshold. Minutes and tokens never convert to
subscription percentages. Evidence needs fresh before/after samples, the same
source, account identity and reset, nondecreasing percentages and attributable
exclusive account activity. Boundary checks conservatively compare full-run
consumption with current headroom. They do not assume a linear consumption rate.
The current providers cannot prove absence of other account activity,
so their observations normally yield unknown with reasons. Missing timestamps,
stale samples, resets, incomplete and failed runs cannot establish sufficiency.
Estimates do not bypass or replace the existing live usage guard.

Claude records wall-clock boundaries through the Node forecast recorder around
each Workflow call; the workflow itself reads no clock and imports nothing. A
structured journal continues one agent at a time without repeating model calls.
These timings include host overhead and gaps inside each call; preflight-to-finish
elapsed time includes user/host waits. Open boundaries are censored on errors.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Claude Code on Pro does not offer or run the Workflow tool, so automation is unavailable. | The ladder runs as a Workflow, and Pro needs it enabled first ([README](README.md#requirements-and-compatibility)). | Enable Workflow in `/config` before installing the plugin. If the first run asks whether to allow Workflow, choose "don't ask again". |
| Preflight returns `ERROR`: "model-ladder needs a git repository with at least one commit". | The folder is not a Git repository, or `HEAD` does not resolve because there is no commit (`scripts/preflight.mjs`). | Run `git init` and make a first commit, or work in an existing repository. Otherwise do the task directly. |
| On Windows, the worker error says `Refusing to use <path> as an isolation worktree`. | Claude Code can refuse every isolation worktree, for example by comparing `c:\` and `C:/` as different paths (CHANGELOG 1.2.5). | Update to 1.2.6 or later. A refused worktree no longer ends the call: the worker runs `git worktree add --detach` under `.claude/worktrees/` and works only there, within the same call. Errors keep 600 characters so both paths show. If it still fails, check `git worktree list` and `git worktree prune`. |
| Codex autorun, the panel or the HUD is missing, or the hook is marked modified in `/hooks`. | Codex skips SessionStart hooks that are untrusted or modified, and trust applies to the current definition and content, so every plugin update needs it again. Running the script by hand does not establish trust. | Open `/hooks` in Codex CLI, review and re-trust the model-ladder SessionStart hook, then start a new session ([Band and panel details](#band-and-panel-details)). |
| On Windows, the HUD refuses to start with "Codex HUD requires a native executable". | An npm-installed `codex` is a `.cmd` or `.bat` shim, which the HUD does not support (`scripts/codex-hud.mjs`). | Put the native `codex.exe` on PATH, or set `CODEX_BINARY` to it ([Codex runner and HUD](#codex-runner-and-hud)). |
| The HUD prints "node-pty could not be loaded" and starts plain `codex`. | `node-pty` is installed in the background (`npm ci --omit=dev`) the first time and may still be installing or have failed. Without it there is no HUD, but `codex` still runs. | Wait for SessionStart to report it ready, or run `npm ci` in the plugin directory. The install log is `npm-ci.log` in `<system temp>/model-ladder/<repo hash>/`. Then open a new PowerShell window. |
| Scripts fail on an old Node.js. | The plugin requires Node.js 20 and does not install it; CI tests 20 and 22 ([README](README.md#requirements-and-compatibility)). | Install Node.js 20 or later. |
| The Claude Code band does not appear. | The band requires Claude Code 2.1.290 or later. | Update Claude Code. |
| The report is `DIRTY`. | Another run, or you, left uncommitted changes in the checkout. | Confirm whether to build on those changes ([Concurrent runs](#concurrent-runs)). |
| The report is `STALE_RUN`. | A lock is dead, unreadable or legacy, or belongs to a crashed Claude session. | Inspect the listed locks and processes, then authorize `--clear-stale` or `clearStale: true`, or use `--clear-stale=<runId>` for a crashed Claude session. Never clear a lock with a live process ([Concurrent runs](#concurrent-runs)). |
| Ctrl+] does nothing in the Codex HUD with an IME such as Bopomofo. | The IME turns Ctrl+] into the character `】`, so the HUD cannot see it (CHANGELOG 1.2.5). | Press Alt+H instead; it is not forwarded to Codex ([Codex runner and HUD](#codex-runner-and-hud)). |
| You cannot find a run's files or logs. | Locks and patches are in `.model-ladder/runs/`; Codex worktrees, logs and `result.json` are in the system temp directory. | See [Run files](#run-files), and use the paths the runner returns. |
