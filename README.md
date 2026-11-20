<div align="center">

# 🪜 model-ladder

**Route each task to a suitable model, complete it, verify the result, and deliver only after verification.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](README.md#install)
[![release](https://img.shields.io/github/v/release/usio0108/model-ladder?label=release&color=blue)](CHANGELOG.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Install](#install) · [繁體中文](README.zh-TW.md) · [Verification skills](#project-verification-skill-generator) · [Advanced usage](USAGE.md) · [Design](DESIGN.md)

</div>

---

model-ladder is a [Claude Code](https://code.claude.com) and Codex plugin that runs each task on the cheapest model likely to succeed, verifies it, and escalates only on failure.

## How it works

1. A Router picks the cheapest model and effort likely to succeed.
2. A Worker does the task in an isolated Git worktree.
3. A Verifier checks the result independently, and protected tests cannot be edited.
4. Only if verification fails does it escalate to a stronger model or higher effort; verified changes are delivered, with no commit or push by default.

## Install

Use it in a Git repository with at least one commit. Install and sign in to Claude Code or Codex first.

```text
# Claude Code
/plugin marketplace add usio0108/model-ladder
/plugin install model-ladder@model-ladder
```

```sh
# Codex CLI 0.160.1+ (restart Codex afterwards; needs an authenticated native `codex`)
codex plugin marketplace add usio0108/model-ladder
codex plugin add model-ladder@model-ladder
```

Restart Claude Code after installing. Codex updates, hook trust and requirements: [Install notes](USAGE.md#install-notes), [Requirements](USAGE.md#requirements-and-compatibility).

## Use

Describe a task in a Git repository and the ladder runs automatically, or start it with `/model-ladder:run <task>` (Codex: ask for the `model-ladder` skill). Say "no ladder" to skip it. Steps, reports and handoff: [Using it step by step](USAGE.md#using-it-step-by-step).

## Project verification skill generator

> Adapted from [pstack](https://github.com/michael-denyer/pstack-claude) (upstream `cursor/plugins/pstack`); source and license in [NOTICE.md](NOTICE.md).

model-ladder also ships skills that generate and maintain a project-local verification driver, one that exercises your app the way a user does:

- `/model-ladder:create-verification-skill` builds a verification skill for a project that has no scripted way to prove its behavior.
- `/model-ladder:maintain-verification-skill` audits it periodically and proposes at most one PR of proven corrections.

Codex versions are in [`codex-skills/`](codex-skills/): ask Codex to use the `create-verification-skill` or `maintain-verification-skill` skill. The Claude Code versions live in [`skills/`](skills/).

## What it changes, what leaves your machine, and how to turn it off

It appends two lines to `.git/info/exclude`, keeps run state in `.model-ladder/`, and on Windows with Codex adds a marked block to your PowerShell profile. The only network call is an optional daily update check that sends no repository data (`MODEL_LADDER_NO_UPDATE_CHECK=1` disables it); your task and code go to the models as in normal Claude Code or Codex use, with extra quota for the router and verifier. Details and switches: [what it changes](USAGE.md#what-it-changes-and-what-leaves-your-machine).

**Uninstall**: run `/model-ladder:uninstall` in each repository, then `claude plugin uninstall model-ladder@model-ladder` and `codex plugin remove model-ladder@model-ladder`. Manual fallback: [Uninstall](USAGE.md#uninstall).

## More

- **Beta**: behavior and file layouts may change; see [known limitations](USAGE.md#beta-status-and-known-limitations).
- **Configure**: defaults work without a settings file. Edit `~/.claude/model-ladder.json` or `~/.codex/model-ladder.json`; `worker_skills` appears as **Worker skill instructions** in `/plugin configure model-ladder`. See [advanced settings](USAGE.md#advanced-settings).
- **Band**: the Claude Code band and Codex panel show roles, usage and guard controls ([band](USAGE.md#band-display-and-controls)).
- **Usage guard**: on by default at 90%; a usage stop returns `USAGE_LIMIT`, writes `.model-ladder/HANDOFF.md` (also via `/model-ladder:handoff`), and force-stops other registered runs ([usage guard](USAGE.md#usage-protection-details)).
- **Features**: [full list](USAGE.md#features).

---

Design and lessons: [DESIGN.md](DESIGN.md). [MIT License](LICENSE), (c) 2026 usio0108. Found a problem? [Open an issue](https://github.com/usio0108/model-ladder/issues).
