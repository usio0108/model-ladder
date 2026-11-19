# Move to the native-first workflow

Nothing to migrate. Plain `/model-ladder:run <task>` and the Codex skill still work. They now try the Local Fast Path first, and only when the session can name the one file the task changes and the project's verify command fully checks the result. Otherwise the existing ladder runs unchanged. Use `--ladder` (Claude Code) or `forceLadder` (Codex) to skip the fast path.

## What changes for you

- An eligible task makes no router, worker or verifier call. The session edits the one file, and `scripts/fast-path.mjs check` runs your verify command on that exact snapshot.
- A failed check delivers nothing. The unverified edit stays in your checkout, and the report says so. Nothing is committed or pushed.
- Each fast-path check adds a history line. `node scripts/telemetry.mjs` reads old and new history lines.
- `scripts/ci-evidence.mjs` can read GitHub CI for a ref. It can also print an official cloud handoff command for you to run. It never starts cloud work, pushes, merges or approves.

## Compatibility

- Execution v2 contracts, `codex-run.mjs` inputs and exit codes, legacy `directRun`, preflight, the Workflow, finish and history are unchanged. One exception: a Claude history line now records `tokens: null` instead of `0` when the Workflow reported no total.
- The Execution v2 baseline branch and the benchmark harness and bundle are unchanged.
- Fast-path verification runs on the host (`HOST_UNSANDBOXED`), like non-isolated v2. When `MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX=1` is set, no task is eligible. Those tasks use the existing sandboxed path.

See the [native-first architecture](../architecture/native-first-workflow.md) and [passive telemetry](../telemetry/passive-telemetry.md).
