---
name: handoff
description: Write a model-ladder handoff from the current conversation for another session to resume.
---

# model-ladder handoff

Run `node ../../scripts/watch.mjs --handoff --cwd <repo-root>`, resolving the script relative to this skill. Read the resulting `.model-ladder/HANDOFF.md`; for concurrent runs, confirm its task and run ID match this conversation. If there is no run history, omit the appendix.

Rewrite the file in the user's language using the whole conversation. Include `## Goal`, `## User preferences and decisions`, `## Done and not done`, `## Suggested next steps`, and `## How to resume`. Distinguish verified facts from inference; do not invent results.

Add `## Appendix: program-generated verification (authoritative)` and paste the template unchanged except its title. Explain that the script produced it and its status and verification results take precedence. Report the file path. Do not run the ladder to write the handoff.
