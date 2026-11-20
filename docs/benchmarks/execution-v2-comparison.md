# Execution v2 controlled comparison

**INCOMPLETE.** On November 19, 2026, all five fixtures passed their offline controls. Live pilot and formal trials stopped at the fixture read boundary. Both native clients were signed in, but the Windows Codex sandbox read synthetic files outside its fixture. No qualified alternative had the required clients and authentication boundary. Live results are **0 of 8 pilot slots** and **0 of 102 formal slots**. The data cannot rank Execution v2, legacy Ladder, or native execution. [Machine-readable record](execution-v2-comparison.raw.json)

## Claude handoff status

The Claude Code handoff on November 19, 2026 ran no pilot slot. Coverage is still **0/8** pilot and **0/102** formal. Every per-slot field remains `UNKNOWN`, and the raw record is unchanged. The live run did not start for three reasons:

- Both Linux controller clients are signed out.
- The frozen arms' Codex legacy sandbox modes let tool commands read a fake credential file in `$CODEX_HOME`.
- Claude file-tool and Workflow containment has no live evidence.

The frozen sources are unchanged: B at `c31e536` and C at `e6fe5b9`. A working-tree fix to the strict verifier is not part of either arm. The pilot design does not depend on that fix.

**Codex pilot driver.** `tests/e2e/codex-pilot.mjs` now runs the four Codex pilot slots under the verified boundary. Its offline mock flow and nine security regression cases pass. Mock rows are pipeline checks and are never recorded as trials. The Codex slots wait for a sign-in and a passing live canary. The Claude slots remain BLOCKED. Live pilot coverage is still **0/8** and formal coverage **0/102**. [Driver and commands](benchmark-environment.md#codex-pilot-driver)

## Environment recovery

Linux Node `24.20.0`, Codex `0.169.0`, and Claude Code `2.1.318` now start from an unprivileged WSL2 install. The independent Node evaluator and a standalone strict Codex command profile passed offline controls. Codex's default workspace profile still read an outside fake file. Both Linux CLI controller profiles are unsigned, and the frozen runner and Claude Workflow are unqualified for the complete boundary. Live coverage remains **0/8** pilot and **0/102** formal. [WSL2 enablement evidence and interactive login](benchmark-environment.md#wsl2-live-enablement)

Explicit Windows MXC startup returned `native MXC is unavailable on this executor`. Ubuntu WSL2 passed offline read, write, network, exit-code, and process termination checks under an unprivileged `bwrap` namespace. A dedicated WSL2 distro is the selected setup path. The Linux CLI versions and credential-separated model connectivity still need qualification. The eight live pilot slots remain **BLOCKED**. The formal trials remain unrun. [Environment recovery and setup](benchmark-environment.md)

## Frozen source and environment

| Arm | Source |
| --- | --- |
| A. Native | Codex CLI `0.169.0` and Claude Code `2.1.318` |
| B. Legacy Ladder | `execution-v2-baseline-20261119` at `c31e53681e53cca92dd3d1fb6f2ae041208f179a`. Tree `806fb521204178edf25f93e2416b24b5867e377a`. |
| C. Execution v2 | `e6fe5b91af7ac71c3d0851cae0a1bbb2cb90b5a2`. Tree `a0521b46f54154964a84a44b381a0fc9f7a66d93`. Parent `98db16dcb4ae0b4b6f08e29f0b3682677a3115bf`. |

The v2 commit freezes the existing working-tree implementation and its live integration fixes. It exists in a local, detached temporary clone created with `git clone --no-hardlinks --no-checkout --no-tags`. The preparation copied current tracked and unignored files, committed inside the clone, and removed its remote. The main checkout and legacy branch refs stayed at their original hashes. Historical benchmark scripts and results matched between the two source snapshots. [Architecture](../architecture/execution-v2.md) · [Migration](../migration/execution-v2.md) · [Legacy architecture baseline](../audits/architecture-baseline.md) · [Previous live integration](../audits/execution-v2-live-validation.md)

Windows x64 `10.0.26300.8697` ran on a 16-logical-processor Intel Core i5-14400, with Node `24.20.0` and Git `2.55.0.windows.5`. Both `codex.exe login status` and `claude.exe auth status` returned exit `0` and signed-in status in an approved local process. The benchmark pins `gpt-6-luna` and `claude-haiku-5-5` at `low` effort, with the same role model within each backend. Earlier live integration observed both IDs. This benchmark made zero model calls, so actual model and effort on benchmark trials are **UNVERIFIED**.

## Live pilot gate

| Check | Status | Observation |
| --- | --- | --- |
| Codex native Windows fixture boundary | FAIL | The default native sandbox exited `0` and read the in-fixture control plus both outside canaries. A host control confirmed all three files were readable. |
| Claude Code native Windows fixture boundary | UNVERIFIED | No independently enforced Windows file-read boundary was established for both legacy Workflow tools and the v2 file tools. A host login and fixture edit approvals do not establish it. |
| Ubuntu under WSL2 | BLOCKED | Managed enumeration returned `E_ACCESSDENIED`. Approved enumeration found Ubuntu under WSL2. The Ubuntu probe found `bwrap` and found no Node, Codex, or Claude on its PATH. Enforcement with the agents was unverified. |
| Restricted Docker execution | BLOCKED | Approved Docker engine `29.9.2` ran the local `python:3.12-slim` image without host mounts or network, as UID `65534`. It could not see the host repository path and had none of the three required binaries. Authenticated tool and network controls remain unverified. |
| Windows Execution v2 `ISOLATED` | BLOCKED | Excluded from benchmarking. The earlier integration recorded both backends stopping before a worker, with no host fallback. [Previous live integration](../audits/execution-v2-live-validation.md#acceptance-decisions) |

The Windows probe used only fake files under the temp artifact directory. Its observation applies to the default standalone sandbox policy tested. It provides no evidence that a worker accessed a real credential or unrelated repository. No login state, credential store, host workspace, or unrelated repo was mounted or passed to a fixture. The provider calls and end-to-end pilot remain blocked pending a fixture boundary that can use the required CLI and keep its authentication out of tool reach.

### Commands executed

```powershell
cmd.exe /d /c ver
node --version
git.exe --version
codex.exe --version
claude.exe --version
codex.exe login status
claude.exe auth status
docker.exe version --format '{{.Server.Version}}'
docker.exe image ls --format '{{.Repository}}:{{.Tag}}'
wsl.exe --list --verbose
wsl.exe -d Ubuntu --exec sh -lc 'command -v node; command -v codex; command -v claude; command -v bwrap; exit 0'
docker.exe run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 --read-only python:3.12-slim python -I -c "import os,shutil; print(dict(uid=os.getuid(),host_repo=os.path.exists('/mnt/c/neil_personal/model-ladder'),node=bool(shutil.which('node')),codex=bool(shutil.which('codex')),claude=bool(shutil.which('claude'))))"
node tests/e2e/execution-v2-comparison-fixtures.mjs
node tests/e2e/execution-v2-comparison-fixtures.mjs
node --check tests/e2e/execution-v2-comparison-fixtures.mjs
git.exe diff --check
```

The canary command was `codex.exe sandbox -- C:\nvm4w\nodejs\node.exe -e <read-probe> <allowed> <fake-credential> <fake-unrelated-repo>`, with the fixture as its working directory. It printed `["READABLE","READABLE","READABLE"]`. The full argv, paths, and exit status are in `windows-worker-boundary.json` under `%TEMP%/model-ladder/981e99050113eb7a/verification/execution-v2-comparison-rFpvQq/`. That folder also holds the v2 source clone, `source-snapshots.json`, and `record-benchmark-preflight.mjs`. Running the latter with the folder path produced the policy checks and machine-readable record. The login probes retained only booleans and exit codes.

## Task and evaluator controls

| Category | Fixture | Starting Git commit | Starter / reference / independent after test edit |
| --- | --- | --- | --- |
| Small bug fix | `small-bug` | `a43022e53721a86f7dc29f652fef5b5e59345a7b` | 1 / 0 / 1 |
| Simple feature | `simple-feature` | `7b1148c27d5594ca058ec742b54cb97513a0b315` | 1 / 0 / 1 |
| Medium refactor | `medium-refactor` | `b28066c652698a5027411afd1ef1b47feb41e963` | 1 / 0 / 1 |
| Multi-module modification | `multi-module` | `c44933b1e84558c126115635f05227a4a273f18f` | 1 / 0 / 1 |
| Regression-sensitive task | `regression-sensitive` | `fd7b28af6cf6926993606abfda1ee3d21ed47600` | 1 / 0 / 1 |

Both fixture preparations exited `0` and generated identical descriptions, commits, and trees. The seeds contain JavaScript modules, both pinned Ladder configurations, and `node tests/check.mjs`. They use the same Node version and zero third-party dependencies. Separate reference checkouts proved the tests fail against known starter code and pass against known corrected code. When a fixture-local check was replaced with exit `0`, its outside copy still returned exit `1` against the starter. Each path check identified both the modified test and an unexpected source file. No model produced these controls. Two acceptance checks use source-level checks for the expected helper call, in addition to behavioral assertions. [Fixture generator](../../tests/e2e/execution-v2-comparison-fixtures.mjs)

The raw record contains frozen descriptions, scopes, acceptance text, snapshot trees, and the rotated strategy order. The temp manifests under `execution-v2-fixtures-1Is3H8` and `execution-v2-fixtures-Njabsy` retain both preparations. A policy check against frozen v2 confirmed 14 backend/profile selections, including conditional review on the three complex MANAGED tasks. The standalone evaluator imports candidate modules, so a live harness must run it within the same qualified fixture boundary.

## Trial design and comparability

- Start every trial from a fresh clone of the category's frozen seed. Pass the same task and acceptance text to all arms. Use fresh sessions, the same runtime versions, a 240-second overall timeout, one worker attempt, and no third-party dependencies. The raw plan rotates arms across three repetitions and varies the starting arm across tasks and backends.
- Run A through the native CLI, B through the frozen legacy Codex runner or Claude Workflow, and C through the v2 contract runner. The legacy arm pins a single model cell and disables delegation to an already-running caller. Its router and reviewer remain part of the measured path. Results from this design would apply to those fixed settings.
- Test v2 DIRECT on the small bug and simple feature only. It is inapplicable to the other three contracts under the frozen complexity policy. Test v2 MANAGED on all five. Native and legacy run all five for both backends.
- Require equivalent exact-file Claude edit preapprovals for workers across arms and read-only reviews. Legacy requires Workflow and host orchestration tools. v2 uses a file-tool allowlist and deterministic host checks. These differences are part of the workflows. The pilot would need to demonstrate consistent permissions and no extra per-arm project instructions without removing the legacy Workflow.
- Pin CLI versions and model IDs, then check the actual provider model per role. Preserve native system prompts, structured role prompts, and review context as part of the strategies. Backend comparisons are separate. Cache hits and tool-added context can differ. Report both observed cache usage and wall time.

## Results and validity

| Trial set | Live coverage | Result |
| --- | --- | --- |
| Native Codex and Claude | 0 pilot / 30 formal slots | Pilot slots 2 of 2 blocked. All formal slots unrun. |
| Legacy Codex runner and Claude Workflow | 0 pilot / 30 formal slots | Pilot slots 2 of 2 blocked. All formal slots unrun. |
| v2 DIRECT | 0 pilot / 12 formal slots | Pilot slots 2 of 2 blocked. All formal slots unrun. |
| v2 MANAGED | 0 pilot / 30 formal slots | Pilot slots 2 of 2 blocked. All formal slots unrun. |

The raw trial array is empty. The eight pilot slots record their prelaunch blocker. No candidates were produced, so per-trial statuses, agent calls by role, retry count, token fields, durations, exits, candidate trees, regressions, and incidental changes have no observations. Provider and subscription consumption per trial and estimated API cost are **UNKNOWN**. Zero benchmark model launches is the observed session count. It does not supply zero token or cost values for unrun trials.

Once live trials run, the external evaluator should verify the delivered Git tree or record a withheld candidate separately. A correct withheld candidate does not count as successful delivery. Keep all attempts, including interrupted work, in the usage and wall-time denominators. Sum inclusive input and output across roles, and report cached input as a subset of input. Record router, reviewer, diagnosis, verification, and retry overhead separately using observed events. Claude Workflow may require CLI-level usage totals and may leave per-role input and cache use unknown. Measure planned slot coverage alongside success rate. Define tokens and time per verified task from total observed trial usage or time divided by verified deliveries, and leave the result undefined when measurements are incomplete or there are zero verified deliveries. Keep any dated API list-price estimates separate from subscription consumption.

**Validity verdict:** fixture preparation and offline evaluator controls passed. Live telemetry capture, CLI permission parity, protected execution, and end-to-end performance remain unverified for this benchmark. No claim about outperformance against legacy or native, or measured benefits of DIRECT or MANAGED, follows from this run. A complete authenticated pilot in a credential-separated environment is the next benchmark gate.
