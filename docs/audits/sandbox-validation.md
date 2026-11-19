# Sandbox enforcement validation

Validation on November 19, 2026. The installed native Codex launcher could not start a strict sandbox in this session. The real smoke test confirmed that required mode stopped without running the command. Positive native execution and native command-level denials remain **UNVERIFIED**. The existing boundaries and prior Windows elevated-backend result are in the [architecture baseline](architecture-baseline.md) and [verification safety audit](verification-safety.md).

## Environment and capability probes

| Platform or tool | Executed command | Observed result |
| --- | --- | --- |
| Managed Windows native | `cmd.exe /d /c ver` | `10.0.26300.8697`, exit `0`. |
| Node and Git | `node --version`, `git.exe --version` | Node `v24.20.0`, Git `2.55.0.windows.5`, exit `0`. |
| Installed Codex | `codex.exe --version` | `codex-cli 0.169.0`. |
| Installed Claude Code | `claude.exe --version` | `2.1.318 (Claude Code)`. This gate uses Codex. Claude documents its shell sandbox for macOS, Linux, and WSL2. No Claude sandbox run was performed. [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) |
| Windows native Codex sandbox | `codex.exe sandbox -- node --version`, then `node tests/e2e/codex-sandbox-smoke.mjs` | Native launcher exit `1`, `Could not find home directory`. The strict smoke exit was `2`, `SANDBOX_UNAVAILABLE`. The prior elevated Windows probe separately rejected the deny-root policy. |
| Ubuntu under WSL | `wsl.exe --list --verbose`, then `wsl.exe -d Ubuntu --exec sh -c 'uname -srm; command -v node; command -v codex; command -v bwrap'` | Both returned `-1` in PowerShell with `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`. Distro version and WSL2 enforcement are **UNVERIFIED** in this session. |
| Standalone Linux | No accessible Linux runtime | Native enforcement and process lifecycle are **UNVERIFIED**. |
| Docker fallback | `docker.exe version --format '{{.Server.Os}} {{.Server.Version}}'` | Exit `1`, Docker engine pipe permission denied. No container ran. |

The commands installed no tools, changed no system security settings, and requested no elevation. Native Codex used the existing managed configuration with an explicit restricted profile. [Codex sandbox CLI](https://learn.chatgpt.com/docs/developer-commands), [Codex permissions](https://learn.chatgpt.com/docs/permissions)

## Real native fixture

Run `node tests/e2e/codex-sandbox-smoke.mjs` on a compatible host. Exit `0` means the real native fixture and its lifecycle checks passed. Exit `2` means the native launcher was unavailable. Exit `1` means an enforcement or fixture check failed. The fixture uses the installed launcher, a disposable directory, fake data, and a numeric loopback address. It does not start an agent.

| Check | Expected hosted behavior | Actual on Windows native |
| --- | --- | --- |
| Allowed read and write | Parent and child read `allowed.txt` and write the expected content to their own files inside the candidate. | **UNVERIFIED**. The launcher stopped before the command. |
| Exit and output | The security command exits `17`, reports parent and child probes on stdout, and emits the expected stderr line. | **UNVERIFIED**. The launcher itself exited `1`. |
| Outside file read | Parent and child report `EACCES`, `EPERM`, or `ENOENT` for the fake sensitive file. The host can read the file. | Host control passed. The native parent and child checks are **UNVERIFIED**. |
| Outside file write | Parent and child cannot append to the fake file. The host sees its original contents afterward. | The file was unchanged. The native parent and child checks are **UNVERIFIED**. |
| Network denial | Host receives the expected response from the same listener before and after the command. Parent and child cannot connect to that listener. | Both host controls passed. Native parent and child denial is **UNVERIFIED**. |
| Unavailable sandbox | Return `SANDBOX_UNAVAILABLE` and never write the command's in-worktree marker through a host shell. | **PASS**. Launcher exit `1`, fixture exit `2`, marker absent. |
| Native normal completion, timeout, and cancel | Normal run exits `0`. Timeout and cancel stop the parent, child, and grandchild before their natural exit. | **UNVERIFIED**. The native fixture did not enter its lifecycle cases. |

The adapter runs a separate host control for each native launch. It verifies that the outside canary exists and is readable and writable on the host. It verifies the loopback listener's response immediately before and after the launch. The child uses `127.0.0.1` directly, which eliminates DNS. `ECONNREFUSED` is accepted when the same host listener responds on both sides of the probe. Timeouts, resets, or bad controls cannot establish a successful denial. These are checks for the tested file locations and endpoint. The native runtime still owns wider policy enforcement.

## Host lifecycle and offline regression

`node tests/e2e/codex-sandbox-smoke.mjs --host-lifecycle` exited `1`. This fixture is recorded as `HOST_UNSANDBOXED` because it checks lifecycle independently of the native sandbox. All three levels produced PID and heartbeat evidence.

| Check | Expected | Observed |
| --- | --- | --- |
| Normal completion | Exit `0`, all levels exit naturally and stop updating heartbeat files. | **PASS**. Exit `0`, all three natural exit markers, and no further heartbeats. |
| Idle timeout | `TIMEOUT` after the full tree stops. | **FAIL** for successful termination on this OS boundary. `taskkill` exited `1`, the runner returned `TERMINATION_FAILED`, and fixture heartbeats continued. All fixture processes then exited by their safety timer. |
| User cancellation | `CANCELLED` after the full tree stops. | **FAIL** for successful termination on this OS boundary. `taskkill` exited `1`, the runner returned `TERMINATION_FAILED`, and the fixture confirmed eventual self-exit. |
| Failure retention | Retain registration, run lock, worktree, and error evidence without claiming a successful stop. | **PASS** in the targeted regression. A separate real `taskkill.exe /PID <fixture PID> /T /F` returned `ERROR: Access denied`, exit `1`. The process remained alive until its timer expired. |

The focused regression command below passed 11 tests with exit `0`. It covers the unisolated launcher rejection, generic socket errors, native receipt parsing, the unchanged host-shell path, and worktree and termination failure handling. The positive receipt test uses a protocol double. It does not count as native enforcement evidence.

```powershell
$env:MODEL_LADDER_NO_UPDATE_CHECK = '1'
node --test --test-name-pattern='first pass applies|passing command that changes|launcher that runs without isolation|required verification sandbox|runner retains the worktree|denied cross-run|failed test escalates|pre-cancelled|captured output|idle limit|sandbox receipt' tests/unit/codex-exec.test.mjs tests/unit/codex.test.mjs
node .agents/skills/verify/verify.mjs doctor
git diff --check
```

Doctor and `git diff --check` exited `0`. The native and host fixture evidence remains under `artifactDir(root)/verification/` in `sandbox-smoke-yCorfJ/result.json` and `sandbox-smoke-Htog50/result.json`.

## Compatibility and cost

- `HOST_UNSANDBOXED` records a host-shell verification command. It retains the existing low-risk execution path.
- `SANDBOX_VERIFIED` records successful native controls for the stated stage. It is independent of the verification command's exit status. A preflight success alone does not record a sandboxed command.
- `SANDBOX_UNAVAILABLE` records a missing launcher, an incomplete launch, or missing host controls.
- `SANDBOX_ENFORCEMENT_FAILED` records a launcher that reached the checks without establishing the required denials. Neither failure state permits host fallback.

The change adds two loopback control connections per native sandbox invocation, with no extra launcher invocation or model call. Wall-clock overhead was not benchmarked. The smoke runner uses no model or external network service. Container fallback remains unnecessary on a host with a verified native backend. A host that must execute the gate and lacks such a backend needs a separately qualified container or another supported host. Docker access and containment have not been verified here.
