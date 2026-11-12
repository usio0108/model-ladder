<div align="center">

# 🪜 model-ladder

**Route each task to a suitable model, complete it, verify the result, and deliver only after verification.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](README.md#install)
[![release](https://img.shields.io/github/v/release/usio0108/model-ladder?label=release&color=blue)](CHANGELOG.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Install](#install) · [繁體中文](README.zh-TW.md) · [How to use](#how-to-use) · [Configure](#configure) · [Band](#band-claude-code) · [Usage guard](#usage-guard) · [Design](DESIGN.md)

</div>

---

## What it does

model-ladder is a [Claude Code](https://code.claude.com) and Codex plugin. The Router selects a suitable model for each task, the Worker executes it, and the Verifier checks the result. Verified changes are delivered.

## Features

- **Isolated Git worktrees**: each attempt runs in its own worktree.
- **Escalation when appropriate**: verification failure may lead to a stronger model or higher effort.
- **DIRECT for small tasks**: when actual session context reaches the configured threshold, the session handles small tasks and still submits them for independent verification.
- **Forecasts**: each agent row's time column shows that agent's own elapsed time over its own expected duration (for example `5s/12m`; once a running agent overruns it, the expected duration is recalibrated in steps, and a finished row keeps its original value) on worker, test-writer and verifier rows, from earlier successful runs or, before any history, the router's per-attempt minutes; router, diagnose and final-diagnosis rows show elapsed only, and when the startup forecast says a subscription window is insufficient or at risk, the ladder asks once before any worker starts.
- **Concurrent runs**: runs with separate file scopes can proceed together, with overlap checks and serialized application of results.
- **Automatic routing and layered settings**: session hooks enable the ladder by default, with personal settings and project overrides.
- **Protected tests**: workers cannot modify tests unless the task explicitly asks for test changes.
- **Usage protection**: a detected usage stop ends the current run and force-stops other registered runs on the machine, with Codex checking every 2 seconds during execution.
- **Handoff document**: usage stops or `/model-ladder:handoff` create `.model-ladder/HANDOFF.md`, which the main session rewrites from the conversation while preserving the program-generated verification appendix.
- **The band / panel / HUD**: view active roles, usage, and guard controls in the Claude band or Codex terminal displays; the CLI HUD also shows context when its session can be identified.
- **Custom role instructions**: `worker_skills` and `verifier_skills` select available skills and tools within each role's permissions, while the Claude Router has only Read, Grep, and Glob.
- **Codex timeout recovery**: `TIMEOUT` results with a checkpoint support `resumeRun` to continue the draft and verify it before application.
- **Optional Codex commits**: `commit: true` commits verified files while preserving unrelated staged changes and skipping files with pre-existing or concurrent edits.

## Install

Check the [requirements](#requirements-and-compatibility) first, and use it in a Git repository with at least one commit.

To update the Codex plugin:

1. Run `codex plugin marketplace upgrade model-ladder`, then `codex plugin add model-ladder@model-ladder` to fetch and install the new version.
2. Open `/hooks` in Codex CLI. If the model-ladder SessionStart hook is marked modified, review and re-trust it. Until trusted, Codex skips it, and automatic panel/HUD setup and autorun instructions are unavailable.
3. Start a new Codex session. The hook points the `codex` function in your PowerShell profile at the new version automatically.
4. On Windows, the first launch of the new version installs node-pty in the background, so that launch may start plain `codex`. Open a new PowerShell window and run `codex` to get the new HUD.

Install and sign in to Claude Code first.

```text
# Claude Code
/plugin marketplace add usio0108/model-ladder
/plugin install model-ladder@model-ladder
```

```sh
claude plugin marketplace add usio0108/model-ladder
claude plugin install model-ladder@model-ladder

# Codex CLI 0.160.1+ (restart Codex afterwards; needs an authenticated native `codex`)
codex plugin marketplace add usio0108/model-ladder
codex plugin add model-ladder@model-ladder
```

Restart Claude Code after installing; top-level tasks then go through `/model-ladder:run` automatically. If the first run asks whether to allow Workflow, choose "don't ask again". Update with `claude plugin update model-ladder@model-ladder` (automatic when the marketplace has auto-update on); reports announce new versions ([CHANGELOG.md](CHANGELOG.md)).

## Requirements and compatibility

| Item | Minimum | Tested status |
|---|---|---|
| Claude Code | Any version with plugins and the Workflow tool; the band needs 2.1.290+ | Developed on Claude Code; no version matrix in CI. On Pro, enable Workflow in `/config` first |
| Codex CLI | 0.160.1+, authenticated native `codex`; trust the plugin hooks in `/hooks` | Developed on Codex; no version matrix in CI |
| Node.js | 20 (the plugin does not install it) | CI unit tests on 20 and 22 |
| Git | Any recent Git; use a repository with at least one commit | Used by CI, no minimum version pinned |
| Windows | Codex HUD needs a native `codex.exe` | CI unit tests on `windows-latest`; the main development platform |
| Linux | | CI unit tests on `ubuntu-latest` |
| macOS | | Untested (not in the CI matrix) |

Source: [`.github/workflows/test.yml`](.github/workflows/test.yml) (ubuntu-latest and windows-latest, Node 20 and 22) and the version notes above. CI runs unit tests only; it does not run Claude Code or Codex.

## What it changes, what leaves your machine, and how to turn it off

| What | Details | How to turn it off |
|---|---|---|
| Daily update check | At most once a day, fetches `.claude-plugin/plugin.json` from `raw.githubusercontent.com` (3 s timeout, silent on failure), caches the result in `model-ladder-update-check.json` in the system temp directory, and the report mentions a newer version. No repository data is sent. | Set `MODEL_LADDER_NO_UPDATE_CHECK=1` |
| `.git/info/exclude` | Appends `.model-ladder/` and `.claude/worktrees/` there (worktree-safe), so you do not edit `.gitignore`. Your tracked files are not changed. | Delete those two lines |
| PowerShell profile (Windows, Codex only) | The Codex SessionStart hook adds one marked `function codex` block to your PowerShell 7 and Windows PowerShell profiles. It runs `codex` inside the HUD and falls back to native `codex.exe` when the HUD cannot run. | Set `"hudTakeover": false` in `~/.codex/model-ladder.json` (`band: false` also does); the next Codex session start removes the block. See [Uninstall](#uninstall) to remove it by hand |
| `.model-ladder/` | Holds `runs/` (run locks), `history.jsonl`, `live.json`, `usage.json`, `context.json` and `HANDOFF.md`. Per-run Codex worktrees, logs and checkpoints are in the system temp directory under `model-ladder/<repo hash>/`. | Delete the directories (see [Uninstall](#uninstall)) |
| Model calls and quota | One task can run a router, a worker, a verifier and, after a failure, further escalated worker and verifier attempts. This uses more of your Claude or Codex quota than doing the task directly. Your task text and code go to the models as in normal Claude Code or Codex use. | Say "no ladder" for a task, or turn off `autoRun` |
| Usage guard | At the configured threshold (default 90%) a usage stop ends the current run and force-stops other registered model-ladder runs on the same machine. | Turn off `usageGuard` in the band or panel; hard limits still stop runs |
| `autoRun` | On by default: top-level tasks go through the ladder automatically. | Set `autoRun` to `false` (Claude: `/plugin configure model-ladder`; Codex: `~/.codex/model-ladder.json`), or set `MODEL_LADDER_AUTORUN=0` |

## Uninstall

1. Remove the plugins:

   ```sh
   claude plugin uninstall model-ladder@model-ladder
   codex plugin remove model-ladder@model-ladder
   ```

   Optionally also `claude plugin marketplace remove model-ladder` and `codex plugin marketplace remove model-ladder`.
2. Remove the PowerShell profile block (Windows, Codex). First set `"hudTakeover": false` and start a Codex session so the hook removes it, or edit by hand: open `Documents\PowerShell\profile.ps1` and `Documents\WindowsPowerShell\profile.ps1` and delete everything from the line `# >>> model-ladder codex HUD >>>` through `# <<< model-ladder codex HUD <<<`. Leave the rest of the file alone.
3. In each repository you used it in, delete `.model-ladder/` and `.claude/worktrees/`, and optionally the two matching lines in `.git/info/exclude`.
4. Clean up leftover Git worktrees: `git worktree list`, then `git worktree remove --force <path>` for any model-ladder attempt, then `git worktree prune`.
5. Delete `model-ladder/<repo hash>/` (and `model-ladder-update-check.json`) in the system temp directory.

## Beta status and known limitations

model-ladder is **Beta**: behavior, settings and file layouts may change between versions (see [CHANGELOG.md](CHANGELOG.md)). Known limitations:

- On Windows, stopping a run kills the whole process tree with `taskkill`. If Windows denies it, the run reports the failure and keeps its registration rather than claiming it stopped ([USAGE.md](USAGE.md#usage-protection-details)). A force-killed run may lack a checkpoint or `result.json`; restart the original task ([USAGE.md](USAGE.md#usage-protection-details)).
- The separate Codex terminal panel does not show context usage ([Band](#band-claude-code)).
- On Pro, Workflow must be enabled in `/config` before you install the plugin, or automation is unavailable.
- Windows requires a native `codex.exe` (PATH or `CODEX_BINARY`); a `.cmd` or `.bat` shim is not supported ([USAGE.md](USAGE.md#codex-runner-and-hud), `scripts/codex-hud.mjs`).
- The Codex HUD must launch Codex; it cannot attach to a running session, and the automatic PowerShell setup is Windows only ([USAGE.md](USAGE.md#codex-runner-and-hud)).
- Claude usage readings exist only on Pro/Max plans; with unknown usage the guard does not block ([USAGE.md](USAGE.md#usage-protection-details)).
- macOS is untested (see the table above).

## How to use

1. **Everyday use**: describe your task in a Git repository and the ladder runs automatically by default.
2. **Start manually**: use `/model-ladder:run <task>` in Claude Code, or ask Codex to use the `model-ladder` skill.
3. **Describe the task**: state the goal and expected result, and explicitly request test changes or a review without edits when needed.
4. **Skip or force the ladder**: say "no ladder" to skip it, or add `--ladder` to the Claude command to force it.
5. **Answer prompts**: confirm work on uncommitted changes, clarify unclear tasks, and choose to continue or stop when the usage forecast warns that a window may run out.
6. **Read the result**: completion requires verification, and the report lists changed files, checks, and remaining limits, with no commit or push by default.
7. **Hand off and resume**: request a handoff when needed, or wait for quota reset after a usage stop and follow `.model-ladder/HANDOFF.md` to resume.
8. **Set up project verification**: model-ladder bundles the pstack-derived [`create-verification-skill`](skills/create-verification-skill/SKILL.md) and [`maintain-verification-skill`](skills/maintain-verification-skill/SKILL.md) for Claude Code, with [Codex versions](codex-skills/) in the Codex plugin. In Claude Code, run `/model-ladder:create-verification-skill` or `/model-ladder:maintain-verification-skill`. In Codex, ask it to use the `create-verification-skill` or `maintain-verification-skill` skill. These skills generate or maintain a verification driver tailored to the target project. This repository already has its own driver at [`.agents/skills/verify/SKILL.md`](.agents/skills/verify/SKILL.md); it verifies model-ladder and is not a generic driver for other projects. See the [third-party notice](NOTICE.md) for the source and license.

See [advanced usage](USAGE.md) for report examples, runner commands, concurrent runs, and run files, and [Band](#band-claude-code) for panel controls.

## Configure

Defaults work without a settings file.

Claude Code: open `/plugin configure model-ladder`; Codex: edit `~/.codex/model-ladder.json`.
For Claude settings outside the plugin screen, use `~/.claude/model-ladder.json`.

| Setting | Default | Purpose |
|---|---|---|
| `autoRun` | `true` | Use the ladder by default. |
| `band` | `true` | Show the band or panel. |
| `worker_skills` (**Worker skill instructions**) | Empty | Skills or tools for workers and test-writers. Each worker reports every named capability; one that applies and is available but was not used fails the attempt. |
| `verifier_skills` (**Verifier skill instructions**) | Empty | Skills or tools for verification. |
| `direct_threshold` | `30` | Context percentage for small tasks to use DIRECT; `off` disables it. |
| `usageGuard` | On, `90%` | Stop at the configured usage threshold. |

Project settings in `.claude/model-ladder.json` or `.codex/model-ladder.json` override personal settings; keep usage protection in your personal file unless the project needs an override.

Use one rule per line: `project: instructions` matches the main repo folder name exactly, while lines without a `project: ` prefix apply everywhere.

```json
{
  "worker_skills": "model-ladder: use <skills> to simplify code",
  "verifier_skills": "model-ladder: use <skills> to review without edits"
}
```

See [advanced settings](USAGE.md#advanced-settings) for models, retries, verification, protected files, and environment variables, or [Codex execution](USAGE.md#codex-direct-commits-and-recovery) for DIRECT, commits, and timeout recovery.

## Band (Claude Code)

The band appears above the Claude Code prompt and requires Claude Code 2.1.290+.

```text
▴ 🟢 model-ladder ── 2h/5h 15% · 3d/7d 44% · ctx 287k/1M (28.7%)
▸ worker use ponytail when coding
model/effort        act./est.  task
haiku-5.5/low       5s         Summarize the README install steps
[usage guard: on]  threshold [90] %  [handoff now]
```

| Display or control | Meaning |
|---|---|
| Usage | Each window shows time to reset, window length, and usage percentage. |
| Context | `ctx 287k/1M (28.7%)` shows tokens used, window size, and percentage; unknown tokens show only the window. |
| Status | 🟢 worker or router, 🔵 verifier, 🔴 retrying worker, and `✓` for a finished row. |
| Task rows | Show the model, effort, the agent's elapsed time (worker, test-writer and verifier rows add "/" and their own expected duration, from history or the router's minutes; other rows show elapsed only), and task. A `background` row (elapsed time, task `<kind>: <label>`) appears for each in-flight Bash background task or async Workflow launch the main session started (not the ladder's own Workflow, not a subagent's call), only while Claude is not running a turn and no ladder agent runs. |
| `▴` / `▾` | Collapse or expand the band. |
| Instruction arrow | Show only applicable instructions without the `skill instructions:` prefix; expand the single-line preview with `▸` and collapse with `▾`. |
| `usage guard` | Toggle usage protection. When a usage window reaches the threshold, the band hands off once on its own, as `handoff now` does; it hands off again only after that window drops below the threshold or resets. |
| `threshold` | Set a threshold from 1 to 100%, saved on Enter or after 5 seconds without typing. |
| `handoff now` | Write the handoff template and run `/model-ladder:handoff` for the main session to rewrite it without cancelling the run. |

Guard controls save to your personal settings, and project overrides still take priority.

The separate Codex terminal panel does not show context usage; enter `g` to toggle the guard, `t 90` to set the threshold, `h` to write a handoff template, or `q` to close the panel, followed by Enter.

See [band and panel details](USAGE.md#band-and-panel-details) for handoff fallbacks, settings behavior, and troubleshooting.

## Usage guard

- Enabled by default, with a 90% threshold for the 5-hour or weekly limit.
- Use the Band controls or Codex panel commands `g` and `t 90` to change protection settings.
- A usage stop returns `USAGE_LIMIT` and force-stops other registered model-ladder runs on this machine.
- Check `.model-ladder/HANDOFF.md` for retained work and resume instructions after quota reset.
- Hard limits still stop runs when the guard is off, while unknown usage does not block execution.

See [usage protection details](USAGE.md#usage-protection-details) for check timing, handoff behavior, and platform limits.

---

Design and lessons: [DESIGN.md](DESIGN.md). [MIT License](LICENSE), (c) 2026 usio0108. Found a problem? [Open an issue](https://github.com/usio0108/model-ladder/issues).
