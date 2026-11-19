# Execution v2 live integration validation

November 19, 2026. Four final live cases reached `VERIFIED` on disposable Git repositories. A live mandatory-check failure prevented delivery. Two Windows `ISOLATED` requests stopped before model execution. The run used the installed signed-in clients and no simulated agent responses. See the [v2 architecture](../architecture/execution-v2.md), [migration guide](../migration/execution-v2.md), [verification safety audit](verification-safety.md), and [sandbox validation](sandbox-validation.md).

## Environment and execution

- Windows native `10.0.26300.8697`, Node `24.20.0`, Git `2.55.0.windows.5`, Codex CLI `0.169.0`, and Claude Code `2.1.318`.
- `codex.exe login status` and `claude.exe auth status` each exited `0` and reported a signed-in client in the approved fixture execution context. The managed shell could resolve Claude authentication but the Codex status command exited `1` because its home directory was unavailable. Only sign-in booleans and exit status were retained from the authentication checks.
- The fixture driver launched `node <checkout>/scripts/codex-run.mjs --input <fixture>/contract.json` from each fixture for Codex and the initial Claude trials. The final Claude trials called the same `runLadder` entry point with a temporary launcher that forwarded the real `claude.exe` response unchanged. The launcher supplied native `--settings` rules for `Edit` on the exact worker file paths in the disposable worktree. It added no edit rules for the read-only reviewer. Native `--permission-prompts none` remained in place. The earlier Claude trials with default permissions and then project-scoped settings both returned `WORKER_BLOCKED`. [Claude permission rules](https://code.claude.com/docs/en/permissions), [Claude settings precedence](https://code.claude.com/docs/en/settings)
- Each fixture had its own Git repository, contract, protected `tests/check.mjs`, and local registry. The driver used the existing credential mechanism without exporting or editing credential stores. Fixture writes stayed under the temporary artifact root. Source changes were limited to the two runner prompt corrections, the worker-boundary evidence field, their regressions, and this report. No push or merge ran.

The `DIRECT` fixture changes only the exported greeting to `Welcome`. The `MANAGED` fixture changes two modules so a summary adds its inputs, handles empty input, leaves the input array intact, and uses the imported formatting helper. The runner's configured command for all fixtures was `node tests/check.mjs`. The driver repeated the check independently on the delivered checkout. It also confirmed the helper call by inspecting the two delivered implementations.

## Acceptance decisions

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| Load the contract | PASS | Every final case recorded version `1`, its fixture repository, task ID, and literal scope. |
| Classify risk and select profile | PASS | Both greeting cases selected `LOW` and `DIRECT`. Both summary cases selected `MODERATE` and `MANAGED`. The two explicit `ISOLATED` requests retained `LOW` risk and selected the stricter profile. |
| Run authentic native workers | PASS | Both clients launched real workers, supplied provider usage, and produced scoped Git candidates. Claude needed the explicit fixture-only edit approvals described above. |
| Skip DIRECT router and reviewer | PASS | Each final DIRECT run launched one worker, zero reviewers, and zero routers. |
| Run the MANAGED command before conditional review | PASS | Both configured commands exited `0`. Each run then launched one independent reviewer, which passed. Both independent checkout checks also exited `0`. |
| Stop delivery for a failed mandatory check | PASS | The controlled Codex case ran a real worker and exited `42` at the gate. The reviewer did not run. The checkout stayed at its base tree. A separate run of the protected check against the retained candidate emitted `SUMMARY_GATE_PASS` and `CONTROLLED_GATE_FAILURE`, then exited `42`. |
| Bind the candidate to delivery | PASS | In all four final cases the independently reconstructed checkout tree equaled the candidate tree. `HEAD` and the real index remained at the fixture baseline. Only the authorized source paths changed. |
| Apply accepted results | PASS | Four `LOCAL_APPLIED` outcomes. The initial Codex review refusal and the controlled negative both withheld changes. |
| Record native usage and timing | PASS | Provider-reported token fields, per-role launch counts, and wall-clock times are below. Unavailable token fields remain `UNKNOWN`. |
| Separate worker and verification boundaries | PASS | Each final attempt recorded requested worker permissions and `enforcement: UNVERIFIED`. Each successful deterministic check separately recorded `HOST_UNSANDBOXED`. |
| Prove OS enforcement for worker execution | UNVERIFIED | Codex requested `workspace-write` with tool network disabled and approval policy `never`. Claude used the native file-tool allowlist and fixture-specific Edit rules. The live cases did not independently probe worker OS confinement. |
| Fail closed in Windows `ISOLATED` | PASS | Both requests returned `BLOCKED` with `VERIFY_SANDBOX_UNAVAILABLE`, an empty attempt list, and zero agent launches. Codex reached the launcher, which rejected the deny-root profile. Claude stopped at its backend capability gate. |
| Prevent automatic host fallback for `ISOLATED` | PASS | Neither isolated request entered the deterministic command phase or changed the fixture checkout. The sandbox adapter and existing smoke fixture match the preserved baseline. |
| Positive `ISOLATED`, remote CI, and other platforms | UNVERIFIED | This live run evaluated Windows failure behavior and local delivery. No Linux, WSL2, Docker, or remote CI result is inferred. |

## Final run evidence

`W/V/R` counts real native worker, verifier, and router process launches. It does not count provider-internal model iterations. Duration is the driver's wall clock, including runner startup. All successful worker and verifier calls used effort `low`. Codex selected `gpt-6-luna`. Its native events did not expose a separate resolved model ID. Claude selected `haiku` and reported `claude-haiku-5-5` in `modelUsage`.

| Task ID | Profile | W/V/R | Gate exit | CLI exit and final state | Duration |
| --- | --- | --- | --- | --- | --- |
| `live-codex-direct` | DIRECT | 1/0/0 | 0 | 0 `VERIFIED` | 16,979 ms |
| `live-codex-managed` | MANAGED | 1/1/0 | 0 | 0 `VERIFIED` | 26,242 ms |
| `live-claude-direct` | DIRECT | 1/0/0 | 0 | 0 `VERIFIED` | 8,259 ms |
| `live-claude-managed` | MANAGED | 1/1/0 | 0 | 0 `VERIFIED` | 18,635 ms |
| `live-codex-negative` | MANAGED | 1/0/0 | 42 | 1 `FAILED` | 20,180 ms |
| `live-codex-isolated` | ISOLATED | 0/0/0 | Not run | 2 `BLOCKED` | 503 ms |
| `live-claude-isolated` | ISOLATED | 0/0/0 | Not run | 2 `BLOCKED` | 214 ms |

| Task ID | Base Git tree | Candidate Git tree | Checkout tree after run |
| --- | --- | --- | --- |
| `live-codex-direct` | `e483cccdf30e1779cf2b38c666890b4b46310898` | `f45a3f1b52ea6b9ddbe5144930d7ae21d8400b50` | Candidate |
| `live-codex-managed` | `a9d006b19dac3c1323882053c7fd6e4d1272d64d` | `97153647f1682df054c8e9106759ebac26cca0ad` | Candidate |
| `live-claude-direct` | `b4be215000779d232694b99986d745cbe37f7d10` | `2463cb3ccdec0c1be04fa8908f8fcffb82c8781c` | Candidate |
| `live-claude-managed` | `10c7de783545d8cd434a0705d9f3e91631b7f1fc` | `6e19066b520ba34fef78daac28edd1a96184495c` | Candidate |
| `live-codex-negative` | `a8b478d5663b4e0517b25015f6ea1346f0dd9353` | `ff34c6942fd94889c2116bcfb5e1cba1a0a445d9` | Base |
| `live-codex-isolated` | `e483cccdf30e1779cf2b38c666890b4b46310898` | No candidate | Base |
| `live-claude-isolated` | `b4be215000779d232694b99986d745cbe37f7d10` | No candidate | Base |

Token tuples are input, output, and cached input. Codex uses native `turn.completed.usage`. Claude uses native JSON `usage`, combining uncached input with reported cache creation and read counts for inclusive input. Zero in an observed field is the provider's value. An uncalled stage has no observed token usage. Monetary cost, independent OS enforcement, and provider-internal call counts remain `UNKNOWN` or `UNVERIFIED`.

| Task ID | Worker tokens | Reviewer tokens | Total tokens |
| --- | --- | --- | --- |
| `live-codex-direct` | 65,549 / 226 / 43,264 | `UNKNOWN` | 65,549 / 226 / 43,264 |
| `live-codex-managed` | 68,633 / 383 / 44,800 | 21,345 / 94 / 0 | 89,978 / 477 / 44,800 |
| `live-claude-direct` | 29,401 / 494 / 23,414 | `UNKNOWN` | 29,401 / 494 / 23,414 |
| `live-claude-managed` | 30,958 / 1,142 / 24,020 | 9,320 / 1,197 / 0 | 40,278 / 2,339 / 24,020 |
| `live-codex-negative` | 66,977 / 434 / 44,032 | `UNKNOWN` | 66,977 / 434 / 44,032 |
| Both isolated cases | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |

## Defects found and regression evidence

1. The first live Codex MANAGED reviewer returned `FAILED` after the command passed. Its native events showed no command execution and the reviewer said it had not inspected the diff. The runner now supplies the same bounded candidate diff to both backends. It computes the diff from the recorded Git trees, keeps the read-only reviewer, and still requires a passing verdict.
2. Separate live Codex DIRECT and MANAGED workers were blocked by an inherited RTK execution failure during the runner's redundant `git status` self-check. v2 now relies on the Git snapshot and changed paths the runner already captures. Legacy worker instructions are preserved.
3. Live output originally recorded the verification command's sandbox but had no independent worker-boundary field. v2 now records the requested worker mode and leaves enforcement `UNVERIFIED`. It does not change native enforcement.

Five focused regression tests, doctor, runner syntax validation, and `git diff --check` passed. The earlier live trials remain in the evidence. Across all trials, 13 real workers and three real reviewers launched, including the failures and permission controls. The sandbox adapter, process-tree helper, sandbox smoke fixture, and historical benchmark artifacts match their baseline Git object hashes.

## Evidence locations and benchmark readiness

Under `artifactDir(checkout)/verification/`, `execution-v2-live-tlidy5` holds the four final runs and their `summary.json`. `execution-v2-live-q1typv` holds the initial trials, controlled gate failure, and both isolated blocks. `execution-v2-live-pCXfI6` and `execution-v2-live-BnWssA` hold the intermediate permission and worker checks. Each case preserves `contract.json`, runner output, and `evidence.json`. Cases checked after delivery also preserve the independent command output. Claude's final cases have `native-permissions.jsonl` with the actual per-phase fixture rules. The temporary driver files are adjacent to these directories. Codex native event logs are in the per-run artifact directories referenced by the runner result.

**PASS for a controlled DIRECT and MANAGED benchmark.** Hold backend, model, CLI version, fixture state, and native permissions constant. Use equivalent fixture-scoped preapproval across Claude arms. **BLOCKED for a positive ISOLATED benchmark on this Windows host.** Positive sandbox enforcement and remote CI remain **UNVERIFIED**. No comparative benchmark ran.
