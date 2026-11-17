---
name: uninstall
description: Remove model-ladder state from this repo and machine (dirs, exclude lines, worktrees, temp files, PowerShell profile block) before removing the plugin. Use for /model-ladder:uninstall or when the user asks to uninstall or clean up model-ladder.
---

# model-ladder uninstall

Do not run the ladder, the Workflow tool or any model-ladder runner here. Run commands from the repository root. This must run before the plugin is removed, because the script ships with the plugin.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.mjs" --dry-run` and show the user the list.
2. If it says a run is active, tell the user to stop it; use `--force` only if they insist.
3. Ask the user to confirm. Stop if they decline.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.mjs"` (add `--force` only if the user chose it) and show the result.
5. Print these commands for the user to run themselves, in their own terminal:

   ```sh
   claude plugin uninstall model-ladder@model-ladder
   codex plugin remove model-ladder@model-ladder
   ```

   Say that on Windows with Codex the SessionStart hook re-adds the PowerShell block until the plugin is removed. Other repositories must be cleaned by running this skill inside each one.
