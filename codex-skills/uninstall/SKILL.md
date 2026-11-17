---
name: uninstall
description: Remove model-ladder state from this repo and machine before removing the plugin.
---

# model-ladder uninstall

Run from the repository root, resolving the script relative to this skill. Do not run the ladder. This must run before the plugin is removed.

1. Run `node ../../scripts/uninstall.mjs --dry-run` and show the user the list. If it reports an active run, tell the user to stop it; use `--force` only if they insist.
2. Ask the user to confirm. Stop if they decline.
3. Run `node ../../scripts/uninstall.mjs` (with `--force` only if chosen) and show the result.
4. Print these commands for the user to run themselves:

   ```sh
   claude plugin uninstall model-ladder@model-ladder
   codex plugin remove model-ladder@model-ladder
   ```

   Say that on Windows the Codex SessionStart hook re-adds the PowerShell block until the plugin is removed.
