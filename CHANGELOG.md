# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

Versions follow semantic versioning; Claude Code updates require a new `.claude-plugin/plugin.json` version.

## [1.2.10] - 2026-11-13

- On Windows, a run no longer stops with EPERM while writing `.model-ladder/live.json` before analysis starts. The file is written to a temp file and renamed over the target, and Windows refuses the rename while another process (a panel reading live.json, an antivirus or an editor watcher) has the target open. The write now retries for about a second on EPERM, EBUSY or EACCES, as lock files already did. The usage forecast and config writes share the same fix.

## [1.2.9] - 2026-11-12

- New opt-in `"network": true` in `.codex/model-ladder.json` (default `false`) enables network access in the Codex workspace-write sandbox for workers and verifiers. Report tasks then run in `workspace-write` because network has no effect in `read-only`; the read-only edit guard and prompt stay. Prompts drop the "no network" wording, diagnosis no longer treats plain network failures as `stop_environment`, and roles are told to fetch with Python (urllib/requests) instead of curl, which fails in the Windows sandbox with schannel `SEC_E_NO_CREDENTIALS`.
- Codex workers, verify commands and verifiers now get `TEMP`, `TMP` and `TMPDIR` pointing at a gitignored `.ml-tmp` folder inside the attempt worktree, for every project. Before, the sandbox could not write the system temp dir on Windows, so `tempfile.gettempdir()` raised "No usable temporary directory found" and pytest `tmp_path` failed. The runner's own environment is unchanged.
- Codex now runs the verify command and the verifier in a fresh `attempt-<n>-verify` worktree built from the worker's snapshot instead of the worker's own worktree. On Windows the worker and verifier run as different sandbox accounts, so gitignored files the worker created (`.pytest_cache`, `.pytest_tmp`, `.ml-tmp`, `.uv-cache`) were unreadable to them and tmp_path tests failed with PermissionError ("147 passed, 9 errors"). The worker worktree is still the one retained on failure or conflict. The diagnose prompt and sandbox hint now say that a PermissionError on files an earlier role created is a sandbox identity issue that `uv sync` does not fix.

## [1.2.8] - 2026-11-12

- Codex workers and verifiers can now run a uv project's tests in their sandbox, which has no network and whose worktree has no `.venv`. Before, `uv run pytest` failed on the uv cache (access denied) or on the network, diagnosis returned `stop_environment`, and the run stopped. The worker, the verify command and the verifier now get `UV_PROJECT_ENVIRONMENT` pointing at the main checkout's `.venv` with `UV_NO_SYNC`, `UV_OFFLINE`, `PYTHONDONTWRITEBYTECODE` and a `UV_CACHE_DIR` inside the worktree, passed to Codex through `shell_environment_policy.set`. Nothing writes to the main `.venv`, no `.venv` appears in the worktree, and no global variable changes.
- When a uv verification has no main `.venv`, the Codex run stops before routing with `errorCode: "UV_SYNC_REQUIRED"` and "Run uv sync in the main checkout first", and does not retry.
- A failing npm-style verify command in a Node project whose worktree has no `node_modules` now stops as "Frontend checks not run", never as a pass or a retry. No `node_modules` junction is created.
- Worker and verifier prompts state the sandbox limits, and a `stop_environment` diagnosis ends with an actionable hint (run `uv sync` in the main checkout, or set `verify`). The Claude runtime is unchanged.

## [1.2.7] - 2026-11-12

- The router no longer writes commit, push, tag, release or "working tree is clean" into acceptance criteria, because a worker works in an isolated worktree, must not commit, and cannot meet them, so a task could never pass. `dropUnachievableAcceptance` also filters such criteria out if the router still writes them. This applies to both Claude and Codex. The Codex router may now propose acceptance criteria when you gave none.
- Claude's confirmation step now lists the acceptance criteria one by one in the option's preview, in your language, so you can see exactly what the run will be judged on before approving. Codex likewise asks for the criteria to be listed one by one in your language.
- The Codex runner's `--help` now lists the full set of `.model-ladder` files, so you can see what it writes to your repository.
- Documentation: the README gains Requirements and compatibility, Side effects and data, Uninstall, and Beta and known limitations sections; USAGE gains a troubleshooting table for first-run problems; the outdated split description is removed; the zh-TW docs are kept in sync.
- The repository gains issue and PR templates, CONTRIBUTING and SECURITY. `package.json` gains `engines` and an `npm test` script, both plugin manifests gain `homepage`, `repository`, `license` and `keywords`, and CI now also runs on macOS.
- In Codex you can change the usage guard by asking, for example "set the model-ladder threshold to 80" or "turn the usage guard off". The Codex skill runs the new `watch.mjs --set`, which saves `--threshold` and `--guard` to your own `~/.codex/model-ladder.json` and exits instead of opening the watcher, and reports the guard in effect, including a note when the project file overrides it.

## [1.2.6] - 2026-11-11

- A refused isolation worktree no longer ends the Workflow call. In 1.2.5 the refusal returned a boundary, and the worker created its own worktree only on the next call; a main session that stopped at that boundary never got there, so runs still failed on sessions where Claude Code refuses every worktree. The refused agent never started, so it is no longer journaled or counted as the call's agent, and the own-worktree rerun follows in the same call.
- Worker skill instructions are now mandatory and checked strictly in both runtimes. `used` is true only when the worker itself invoked the capability in this attempt (a Skill tool call, or a direct tool call; in Codex, reading and following the skill's SKILL.md). Rules injected by hooks, a mode that was already active, or following a skill in spirit count as `used: false`, which fails the attempt. Before, a worker could report ponytail as used because a SubagentStart hook had injected its rules.
- Each attempt's skill report (name, applies, available, used, note) is written to `.model-ladder/history.jsonl` in both runtimes, so you can check afterwards whether a skill really ran.

## [1.2.5] - 2026-11-11

- When Claude Code refuses a worker's isolation worktree, the worker now creates its own worktree with `git worktree add --detach` under `.claude/worktrees/` and works only there, for that attempt and every later one in the run. Retrying host isolation did not help on Windows sessions where Claude Code compares `c:\` and `C:/` as different paths and refuses every worktree. The protected-path hook now resolves paths against the worktree that holds the file, so it still applies when the worker starts in the main checkout. Worker errors keep 600 characters instead of 200, so a refusal shows both paths.
- The Codex HUD also accepts Alt+H for the handoff. With an IME such as Bopomofo, Ctrl+] arrives as `】` even in the IME's English mode, so the HUD could not see it; Alt+H arrives as `ESC h` (or a win32-input-mode Alt+H) and is not forwarded to Codex. Ctrl+Alt+H (AltGr) is still a character. The header hint reads `^]/Alt+H handoff`.
- The Codex HUD now shows a run that Codex started in another repository, for example a scratch repository under the temp directory, when its own repository has no run. It reads the machine-wide registry of running runners and puts that repository's folder name in front of the task. Before, the HUD showed `idle` for the whole run.

## [1.2.4] - 2026-11-11

- The Codex HUD now finds the session itself. Interactive Codex runs the SessionStart hook in the shared `codex app-server` daemon with the daemon's environment, so the HUD token never reached the hook, no marker was written, and the HUD showed "Session hook not detected" with no context usage. The HUD now falls back to the newest `codex-tui` rollout under `$CODEX_HOME/sessions` for the same folder that started after the HUD did, rescans every 3 s at most, and switches to a newer rollout after `/new` or `/resume`. It reads the whole first line, which is about 19 KB in real rollouts.
- The SessionStart hook prints "model-ladder HUD is already running" only when `MODEL_LADDER_HUD_TOKEN` is a valid UUID, so sessions that inherit a stale `MODEL_LADDER_HUD=1` from the daemon no longer get it.
- The HUD's session warning and handoff notices go at the end of the first line instead of replacing the second, so the `model/effort  act./est.  task` header row and the agent row stay visible. On narrow terminals the context goes first, then the key hints. The warning now reads `⚠ session ?`. Missing context shows `ctx ?`.
- Codex router, verifier and tiers default to the family names `terra`, `luna` and `sol`, resolved at load time to the highest version in `$CODEX_HOME/models_cache.json` (for example `terra` → `gpt-6.1-terra`). When the cache has no match they fall back to `gpt-6-luna`, `gpt-6.1-terra` and `gpt-6.1-sol`. Full model names are used as given.
- **Claude band background rows** no longer stay hidden while their task still runs. A reply that waits on the background now shows every task still running, not only the current question's, so a task hidden because an earlier reply was misread as a final answer comes back (for example a background test whose question was answered with "I'll report back when the rerun finishes", then a later "you'll get a notification when it's done"). The waiting keywords also cover `回報`, `回报`, `跑完` and `重跑`.

## [1.2.3] - 2026-11-10

- The Codex HUD now recognizes Ctrl+\ and Ctrl+] sent as Windows Terminal win32-input-mode sequences (`ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`), which ConPTY switches on. Before, the keys never matched the raw 0x1c/0x1d bytes and went to Codex. Both the press and release sequences are now dropped from forwarded input, an action fires once per press, sequences split across reads are reassembled, and all other input is forwarded unchanged.

## [1.2.2] - 2026-11-10

- The Codex SessionStart hook now has a `statusMessage` ("Loading model-ladder..."), so `/hooks` no longer lists it as an unnamed hook. On Windows it also shows the user a `systemMessage` about the background `node-pty` install: an installing notice with the `npm-ci.log` path, and a one-time ready notice per plugin version.
- The Codex runner reads the usage sample before the clock at each forecast boundary. A sample taken a millisecond later counted as from the future, so the usage-risk question was occasionally skipped.

## [1.2.1] - 2026-11-10

- The PowerShell `codex` function no longer hardcodes one plugin version folder: each run it picks the newest complete installed version (`.codex-plugin/plugin.json`, `scripts/codex-hud.mjs`, `hooks/band/remaining.mjs`, `node_modules/node-pty`) and runs native `codex` when none is complete. This fixes `codex` breaking after an update removed part of the old cached version.
- `plugin`, `review`, `update`, `doctor`, `queue`, `archive`, `delete`, `unarchive`, `migrate-rollouts`, `migrate-nfs-db`, `features`, `exec-server`, `remote-control`, `app`, `cloud` and `sandbox` now run native `codex` instead of the HUD.

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
- The Claude Code band no longer shows a `background` row for the ladder's own Workflow launch (`workflow: ladder`); you already know model-ladder is choosing a model. Other async Workflow launches still get a row.
- A background Bash call or Workflow launch made inside a subagent (for example a verifier running a test command in the background) no longer adds a background row. Its task-notification goes to the subagent, never to the main session, so the row used to stay after the task ended.
- When Claude Code refuses a worker's isolation worktree ("git could not be run to resolve it"), a transient failure, the worker or test-writer now retries once with the same model and effort instead of the run stopping with `stop_environment`.
- Cleanup removes worktrees with `git worktree remove --force --force`, so the worktrees Claude Code locks no longer linger with their `worktree-wf_*` branches.
- Overrun estimates now use history: once an agent row passes its expected duration, the expected value becomes the median of at least 2 past runs that took longer (agentExpectations now also returns the raw samples), else the step estimate shown with a leading `~` (for example `12m/~14m`) in the Claude Code band and the Codex panel; and in the Claude Code band an overrun agent row shows its current tool activity (for example `Bash: Run unit tests`) in place of the task text, falling back to the task text when it cannot be read.
- Codex on Windows: the SessionStart hook adds a marked `codex` function to the PowerShell profiles, so typing `codex` in a new PowerShell window opens the model-ladder HUD; subcommands, redirected IO and a missing `node-pty` or Node.js run the native `codex.exe`, `node-pty` installs in the background, and `"hudTakeover": false` removes the function. The HUD also falls back to plain Codex when `node-pty` cannot load.
- Band usage percentages are no longer bold and use raw colors (yellow from 50% up to the usage guard threshold, red at or above it), since some surfaces drew the theme colors as plain text.
- Background rows also cover subagents the main session starts in the background (the Agent tool with run_in_background): an `agent: <description>` row shows while Claude is idle and leaves when that agent finishes.
- A background row also leaves when its task is stopped with TaskStop, which sends no task-notification, so stopped tasks no longer linger in the band.
- A background shell row shows an expected duration once the same command (its first line) has finished before: the median of its last ten runs, kept across sessions and recalibrated like an agent row when overrun; a first run shows elapsed only.
- The time column header in the Claude Code band and the Codex panel reads `act./est.` (actual elapsed over expected) instead of `time`.
- Claude Code verifier and diagnosis rows now show their expected duration too: their prompts carry no TASK line and each ladder boundary is its own workflow run, so the band now uses the only active ladder lock when it cannot match a task (two or more active runs still show elapsed only).
- Workers now follow editing rules (Edit/Write or apply_patch only, `uv run` with cleanup, `git status` check before reporting); the router suggests `claude plugin test .` when band files change.
- The Claude Code verifier now returns `workerFiles` (the worker's unstaged and untracked paths from `git status`), and with a verify command it passes only when the command succeeds and every ACCEPTANCE item is met; a passing verdict with empty `workerFiles` becomes a failure (`worker changed nothing`) so the ladder escalates.
- A running agent row whose elapsed time has reached its expected duration now shows a recalibrated expected duration (expected plus whole steps of max(1 minute, half the expected value) until it exceeds elapsed, for example 12m/14m for a 7m expectation) in the Claude Code band and the Codex panel; a finished row keeps its original expected duration.
- The Claude Code band replaces the lock-based `no model` row with background rows: one `background` row (elapsed time and `<kind>: <label>`) per in-flight Bash background task or async Workflow launch of this session, shown only while Claude is not running a turn and no ladder agent runs, and removed when the task's notification arrives. The `direct` phase and `phase.mjs <runId> direct` step are removed.
- Only worker, test-writer and verifier rows show an expected duration; router, diagnose and final-diagnosis rows show elapsed time only.
- The router also returns `workerMinutes` and `verifyMinutes` (positive integer wall-clock minutes for one worker attempt and one verification). The plan carries them into the run lock's per-agent table as the expectation for a phase history has no sample for, so worker and verifier rows have an expected duration from the first run. History samples (phase plus model/effort, then phase) still take priority.
- The Codex router returns `workerMinutes` and `verifyMinutes` too (positive integers, schema-checked); after routing they fill the Codex panel's per-agent table only for a worker or verify phase history has no sample for, so the first Codex run shows elapsed/expected on worker and verifier rows.
- The band usage line shows each percentage bold and colored: plain under 50%, warning from 50% up to the usage guard threshold, error at or above it; the rest stays dim. The instructions row leaves a space after its fold arrow.
- The time column of each agent row (router, worker, test-writer, verifier) in the Claude Code band and the Codex panel now shows that agent's own elapsed time over its own expected duration, not over the whole run's forecast total. The expected duration is the median of earlier comparable successful runs' phase timings, keyed by phase plus model/effort once there are two samples and by phase alone before that; with no samples only elapsed time shows.
- A running row reads its expected duration live, so it no longer goes missing when the run has no forecast yet at spawn. The `no model` row keeps run elapsed over the run's forecast total.
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
- Shortened plugin settings descriptions, including context-window information in the Band option.
- Added the installed version to the first configuration label.
- Simplified both language editions of the README, advanced usage, design notes, and release history.
- Updated Band examples and moved detailed operation and configuration references to the advanced guides.
- Removed unreliable performance comparisons and outdated test-result claims, preserving third-party license text.
- Codex DIRECT uses measured caller context and an isolated draft that must pass independent verification before application.
- Optional Codex commits preserve unrelated staged changes and skip files with pre-existing or concurrent edits.
- Codex SessionStart respects personal/project autorun and panel settings, with test-writer rules aligned across runtimes.
- Quota handoffs use per-run live state, and detected usage stops terminate other registered runner process trees and write `HANDOFF.md`.
- Codex polls usage every 2 seconds during agents and verify commands.
- Recognized limit-only responses stop as `USAGE_LIMIT`.
- Windows process-tree termination failures retain registration and report the error without a false stopped handoff.
- Updated both runtime skills and bilingual documentation for DIRECT, commits, splitting, and platform limits.
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
