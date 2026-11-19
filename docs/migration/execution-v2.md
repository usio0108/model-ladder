# Run a task with Execution v2

Keep using the existing `/model-ladder:run` or a plain task string for legacy behavior. Choose Execution v2 when you can specify the authorized files and verification coverage. Execution v2 is opt-in through the JSON envelope below.

## Create and run a contract

Save this JSON to a temporary file. Replace the repository path, scope, and criteria with values for your project. Select `codex` or `claude` as the backend. Set the project's existing `verify` setting to an appropriate trusted command if discovery cannot find one or if you need a narrower check.

```json
{
  "contract": {
    "version": 1,
    "id": "fix-greeting",
    "task": "Fix the greeting typo in src/greeting.mjs.",
    "repository": "C:/work/project",
    "backend": "codex",
    "scope": ["src/greeting.mjs"],
    "protectedPaths": ["tests"],
    "acceptance": ["The greeting is Welcome."],
    "coverage": "complete",
    "complexity": "small",
    "limits": { "maxAttempts": 2, "timeoutMs": 120000 }
  }
}
```

From the repository root, run `node scripts/codex-run.mjs --input <contract-file>`. For an installed plugin, use the same script from the plugin package. Existing native authentication and settings still apply. Claude's existing approval settings must permit the headless worker's file operations. The v2 launcher denies prompts that would require interactive approval.

Scope and protected entries are literal repository-relative files or directories. Directory entries include descendants. Report coverage as `complete` only when the mandatory check establishes the criteria. Set `coverage` to `partial` or leave it unknown when semantic review is needed. Use `effects` for `destructive`, `credentials`, `security`, `network`, `deployment`, `migration`, or `hard-rollback`. The task should describe a local change. Delivery does not execute external side effects. `allowTests: true` can authorize editing tests within scope. Existing protected paths and command inputs remain protected.

Set `profile` to `MANAGED` or `ISOLATED` to request a higher policy minimum. The runner can also choose either profile from the contract. Supply acceptance criteria for both. Sandbox requirements remain in force, including `MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX=1`. An unavailable required sandbox produces `BLOCKED`. Existing plain input and existing configuration keys require no migration.

## Read the result

| Result | How to proceed |
| --- | --- |
| `VERIFIED` | Inspect the local changes and evidence. Remote CI remains `UNVERIFIED`. |
| `REVIEW_REQUIRED` | Inspect the retained worktree. Run independent CI and obtain human approval through your delivery process. |
| `BLOCKED` | Read `errorCode` and the evidence. Resolve the blocker before retrying. |
| `FAILED` or `INCONCLUSIVE` | Inspect the failed or missing gate and retained evidence. An `IMPLEMENTED` attempt is only a draft. |
| `CONFLICT` | Inspect the retained patch and worktree before applying any change. |

The CLI exits `0` for `VERIFIED`, `2` for `BLOCKED` or `REVIEW_REQUIRED`, and `1` for other v2 failure states. Dirty checkout consent stays an explicit top-level `allowDirty: true`. To resume a checkpoint, reuse the original JSON with `resumeRun` set to the reported ID. Keep the contract and environment policy in effect. If termination is unconfirmed, inspect the recorded process and workspace before any reuse.

Legacy Codex `DIRECT` still returns a caller-editable draft and requires `directRun` with independent verification. Legacy Claude `DIRECT` still returns to the caller session. Execution v2 `DIRECT` runs one native worker and returns the ordinary v2 completion state. The v2 contract cannot resume a legacy `directRun` draft. [Execution v2 architecture](../architecture/execution-v2.md)
