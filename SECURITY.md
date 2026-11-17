# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (direct link: <https://github.com/usio0108/model-ladder/security/advisories/new>).
3. Describe the problem, the affected version (from `plugin.json`), and steps to reproduce. Mask secrets and private data.

English or Traditional Chinese (中文) is fine. Reports are handled on a best-effort basis; there is no guaranteed response time.

## Supported versions

Only the latest release receives fixes.

## Scope

model-ladder runs locally inside Claude Code or Codex. What it touches on your machine is listed in the [README](README.md#what-it-changes-what-leaves-your-machine-and-how-to-turn-it-off); reports about those behaviors, such as hooks, run locks, worktrees or the PowerShell profile block, are in scope. Vulnerabilities in Claude Code, Codex or Node.js themselves should go to their vendors.
