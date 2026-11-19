# Verification safety and delivery

This update builds on the [architecture baseline](architecture-baseline.md). It leaves routing, agent count, and merge policy in place.

## Codex command boundary

`runLadder` resolves the command from `config.verify` or repository discovery, snapshots the worker tree, checks protected inputs, and starts the deterministic gate in a fresh verification worktree. A failed gate or a changed tree blocks independent review and application. The runner checks the tree again after review.

By default, `processRun` launches the command through the host shell and inherits `process.env` plus the existing uv overrides. A configured command, a discovered test, and anything they launch can use the runner's credential variables, readable files, and network access. The Codex role's `--sandbox` setting governs its own tool calls. Git worktrees share Git metadata and provide no OS boundary.

Set `requireVerificationSandbox: true` in input JSON or set `MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX=1` in the launching environment. The runner invokes the native `codex sandbox` helper with a fresh permissions profile, managed configuration, a limited environment, restricted filesystem paths, and networking disabled. It resolves launcher configuration outside the repository. Before routing and again before starting the command, the child must fail to open an outside canary for reading and writing and fail to reach a test-only host loopback listener. It must also enter the intended worktree. A missing command, unsupported profile, or failed probe blocks required mode. A checkpoint cannot downgrade required mode on resume. The runner does not grant a shared virtual environment in this mode. [Codex sandbox helper](https://learn.chatgpt.com/docs/developer-commands), [Codex permission profiles](https://learn.chatgpt.com/docs/permissions)

These are point checks for the deterministic command. Git operations, agent roles, and toolchains retain their own boundaries. Scratch and candidate files are accessible to the command. Secrets copied into the candidate remain in scope. The default host-shell mode remains appropriate only for trusted commands and code.

An approved probe with Codex CLI `0.169.0` reached the Windows native backend, which rejected the profile with `elevated Windows sandbox requires effective :root read access`. The runner returned `VERIFY_SANDBOX_UNAVAILABLE` without broadening the profile. Ubuntu WSL has Git and bubblewrap but no Node runtime or Codex CLI on its path. Docker access was denied in the managed session and an approved local query found no Node image. A container fallback would need a provisioned image, a narrow mount and environment policy, and a confirmed network boundary. This update adds no container fallback.

## Process shutdown

A Windows probe launched an inert child and invoked `taskkill /T /F` for that PID. In the managed session the utility returned exit `1` and `ERROR: Access denied`. The child was still alive. A separately approved test outside the managed runner stopped a real child and grandchild and closed their inherited pipes. This identifies the process-access boundary as the observed difference. The precise Windows access check that rejected the managed request was unavailable. [Windows process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)

Windows termination records the native exit and its diagnostic. A failed tree stop is never substituted with a direct kill of the root process. A POSIX local stop sends `SIGKILL` to the detached process group and checks that the child streams close. A POSIX cross-run stop sends `SIGTERM` and requires the owning runner to acknowledge cleanup by removing its registration. Timeouts and access errors leave the shutdown unconfirmed. Deliberately detached descendants and a runner killed outside its shutdown path can require manual inspection.

Local failure writes `ERROR` with `TERMINATION_FAILED`, the child PID, and retained worktrees to the result and history. It preserves the run lock and registration and supplies no resume checkpoint or successful-stop handoff. Cross-run failure preserves the target's registration and emits an explicit diagnostic. The originating Codex run records those failures and reports `ERROR`.

## Claude candidate binding

Preflight records the base commit and tree. The existing verifier calls the snapshot helper before and after its check. The helper records the candidate tree and canonical worktree path by run and attempt. It uses a temporary index and rejects a changed tree. The Workflow passes a candidate hash and the verifier verdict to Finish. Finish confirms the recorded pair, the current tree, the base commit, and protected paths. It applies the confirmed Git tree through the shared patch helper. It compares affected original files with the base under the apply mutex. A stale candidate fails and a conflicting destination is reported as `CONFLICT`. Neither is recorded as `VERIFIED`.

The snapshot receipt establishes tree identity and does not attest to the verifier's semantic judgment or prove which commands it ran. A host process with write access to the evidence can alter it. Claude `DIRECT` still uses the calling session's review path. No new model role or successful-path model call is added. Existing retry policy can still act on failed or missing evidence.

## Changed files

- Codex execution and termination: `scripts/codex-run.mjs`, `scripts/codex-exec.mjs`, `scripts/codex-verify.mjs`, `scripts/process-tree.mjs`, and `scripts/usage-guard.mjs`.
- Claude verification and delivery: `scripts/preflight.mjs`, `workflows/ladder.js`, `scripts/finish.mjs`, the shared `scripts/codex-worktree.mjs`, and `skills/run/SKILL.md`.
- Offline regression: `tests/unit/codex-exec.test.mjs`, `tests/unit/codex.test.mjs`, `tests/unit/flow.test.mjs`, and `tests/unit/scripts.test.mjs`.
- Documentation: this report and the English and Traditional Chinese `DESIGN`, `USAGE`, and `CHANGELOG` files.

## Verification results

| Command | Result |
| --- | --- |
| `node --test tests/unit/flow.test.mjs tests/unit/finish.test.mjs tests/unit/scripts.test.mjs` | 121 passed on managed Windows. |
| `node --test tests/unit/codex-exec.test.mjs tests/unit/codex.test.mjs tests/unit/codex-worktree.test.mjs` | 94 passed in the approved Windows test environment. |
| `node --test tests/unit/codex-exec.test.mjs tests/unit/codex-split.test.mjs` | 21 passed in the approved Windows test environment, including a real child and grandchild. |
| Focused failure-mode rerun in the four changed test files | 9 passed on managed Windows. |
| `node .agents/skills/verify/verify.mjs doctor`, `git diff --check`, and `node --check` for changed scripts | Passed. |

The Windows native sandbox smoke confirmed that unavailable required isolation stops execution. Linux, a positive strict-native run, live model execution, and remote CI remain unverified.

## Smallest next stage

Qualify the native sandbox path with an inert positive smoke test on supported Windows and Linux CLI builds. Use the existing probes and assert a real command's exit code under the native boundary. Keep unavailable hosts fail-closed. Once qualified, record Claude's deterministic command exit at the same trusted evidence boundary where the tool permits it.
