# Benchmark environment recovery

**BLOCKED for live execution.** The pinned Linux tools are installed in an unprivileged staging directory on Ubuntu WSL2. The dedicated benchmark environment still needs authenticated controller isolation across both backends. Live pilot coverage remains **0/8**, formal coverage **0/102**, and Windows `ISOLATED` **BLOCKED**. [Controlled comparison](execution-v2-comparison.md)

**Archived on 2026-11-19.** The benchmark harness, frozen arms and source bundle are kept unchanged. Sandbox work is not being extended. Usage and quality evidence now come passively from normal runs through `scripts/telemetry.mjs`. See [passive telemetry](../telemetry/passive-telemetry.md). The live pilot is paused until the person decides to sign in to the controller.

## Claude handoff update

On November 19, 2026 the Claude Code handoff re-ran the Linux checks. Its full evidence is in the [handoff validation](../audits/claude-handoff-validation.md). The outcome is still **BLOCKED**.

- Both controller profiles are still signed out. `codex login status` printed `Not logged in` and `claude auth status` reported `loggedIn: false`. Each exited `1`.
- The frozen strict verifier failed for three reasons. It passed an obsolete `linux` subcommand. Its deny-root profile hid the Codex binary that re-executes itself inside bwrap. The socket-based stdio also made Node children discard their output. A minimal fix in the working-tree `scripts/codex-verify.mjs` now qualifies the launcher, the receipt, the exit code, output capture, network denial, and native normal, timeout and cancel lifecycle. The strict smoke still exits `1`, because writes to outside paths succeed inside the sandbox. Those writes never reach the host. The frozen arms keep the old verifier and do not use it unless strict mode is requested.
- The Codex legacy `--sandbox workspace-write` and `read-only` modes used by the frozen arms let tool commands read files outside the workspace, including a fake `$CODEX_HOME/fake-auth.json`. Credential separation for the Codex arms is therefore not met.
- Claude Bash sandboxing does not cover the file tools, hooks or local MCP servers. Live canaries for those tools need a signed-in client.

**Boundary resolution.** The versioned wrapper `tests/e2e/bench-boundary.mjs` (v1) adds a trusted-controller boundary without changing the frozen arms. A managed `requirements.toml`, bind-mounted in a user namespace, forces a deny-root Codex profile over every legacy `--sandbox` mode. A `node` shim confines the runner's host-shell gate. The offline self-test passed with fake canaries. Host integrity passed and operation denial is still recorded as failing for the Codex tool sandbox. Live `codex exec` and all Claude tool paths remain unverified. [Security boundary](../audits/benchmark-security-boundary.md)

**Final boundary checks.** These supersede the paragraph above.

- **Codex.** Loopback mocks of the provider APIs drove the real `codex exec` tool path without a login: `codex-exec-canary.mjs` passed all ten checks.
  - Every nested tool returned `ENOENT` for the fake credentials, including `exec_command`, escalation, `view_image` and `apply_patch`.
  - Host integrity held. No credential appeared in the Codex logs.
  - A `codex` shim keeps `--sandbox read-only` roles read-only through a second forced profile.
  - `escapingSymlinks` flags candidate symlinks that point outside the worktree, which the frozen runners would otherwise collect.
- **Claude.** `claude-tool-canary.mjs` showed that wrapper-mounted managed settings load and fail closed.
  - Bash, Read, Edit, Write, Glob, Grep, a sub-agent, and the absent WebFetch and MCP tools were all confined.
  - The settings now deny `ANTHROPIC_API_KEY` and `CLAUDE_CODE_MESSAGING_TOKEN` to sandboxed commands. Both were otherwise visible there.
  - Hooks, the legacy Workflow, and v2 Edit allow rules remain unverified, so Claude stays **BLOCKED**.
- **Codex-only pilot.** The security conditions pass. The pilot waits only for the Codex login below and a driver that runs each arm under the wrapper.

## Codex pilot driver

`tests/e2e/codex-pilot.mjs` (driver v1) runs the four Codex pilot slots on the frozen `small-bug` fixture. The slots are `A_NATIVE`, `B_LEGACY`, `C_V2_DIRECT` and `C_V2_MANAGED`, at `gpt-6-luna`, effort `low`, with a 240-second runner limit.

**Inputs.** The driver checks each input before any trial:

- **Fixture.** It reuses the existing fixture generator and requires commit `a43022e…` with tree `d3eb8d0…`.
- **Frozen sources.** It exports the frozen legacy and v2 sources from the source bundle with `git archive`, after checking trees `806fb52…` and `a0521b4…`.
- **Policy.** It applies the same boundary policy, contract or input, and acceptance text to every arm.

**Trial flow.** Every arm runs inside `bench-boundary.mjs` v1:

1. Clone the fixture.
2. Run the controller: the native CLI or the frozen runner.
3. Run the worker, the gate and any reviewer.
4. Snapshot the candidate and the delivered checkout.
5. Run the independent evaluator through the gate shim.
6. Record telemetry.

**Security stops.** Any of these stops the pilot with exit `3` before the next trial:

- a canary marker in trial files or new Codex rollouts
- a changed host canary
- an escaping symlink in the candidate tree or the delivered checkout
- a surviving process
- a runner exit code that does not match its status

A failed boundary self-test, a missing login, or a missing or mismatched canary receipt blocks with exit `2` and runs no trial.

**Telemetry.** Per trial the driver records the backend, model, CLI version, arm, sandbox and gate boundary, and observed Codex launches. It also records runner-reported calls by phase, input, output and cached tokens, duration, runner status, gate exit, independent evaluator result, Git seed, candidate and delivered trees, out-of-scope paths, security checks and errors.

- Tokens come from `turn.completed` events for native and from the runners' own `usage` records, aggregated with the v2 `usageEvidence`.
- A missing usage record, or more launches than usage records, gives `UNKNOWN`, never zero.
- The resolved model and cost remain `UNKNOWN`.

The boundary now runs the controller in a private PID namespace. This fixed a real leak: a hung v2 trial left the runner's detached `codex exec` alive after the timeout.

| Offline result (mock provider, not a benchmark result) | Status |
| --- | --- |
| End-to-end flow, four arms: fixture to controller, runner, worker, gate, candidate, evaluator and telemetry | PASS. Native delivered with 1 Codex launch. Legacy `VERIFIED` with 3 (route, worker, verify). v2 DIRECT and MANAGED `VERIFIED` with 1 each, since small complete coverage needs no review. All evaluators pass, the canary probe gets `ENOENT`, all changes are in scope, tokens are recorded. |
| `codex-pilot-regression.mjs`, 9 cases | PASS. The cases cover the clean flow, a confined gate, an unconfined gate, an unconfined worker, symlink escape for native and legacy, legacy reviewer tamper (withheld, checkout at seed), hang with timeout (no survivors, tokens `UNKNOWN`), and an unavailable sandbox (blocked, no trials). |
| `bench-boundary.mjs --self-test`, `codex-exec-canary.mjs`, `claude-tool-canary.mjs`, `host-integrity-smoke.mjs` | PASS after the PID namespace change. |
| `codex-sandbox-smoke.mjs` | Exit `1`, `write: ALLOWED`. Operation denial is recorded as FAIL, as decided. |

### After sign-in

Run the live safety canary first. It asks the real model to read a fake canary beside the credential and one outside the fixture, and to write inside its workspace.

- It passes only if the reads appear denied in the transcript, the write ran, no marker reached any trial file or rollout, and the host canary is intact.
- On a pass it writes `canary-receipt.json`. The pilot refuses to start without a receipt that matches the boundary hash, Codex version and controller.
- If the model does not run the commands, the canary is `INCONCLUSIVE` and must be repeated.

## WSL2 live enablement

The current staging distro is Ubuntu 26.04 LTS, x86-64, on kernel `6.18.33.2-microsoft-standard-WSL2`. The launcher ran as UID `1000`. Existing Git `2.53.0`, APT, and bubblewrap `0.11.1` were reused. Windows interop and its `/mnt/c` mount are still enabled outside the namespace. The Windows-imported npm path was excluded from installs and probes.

| Tool | Observed version | Installation |
| --- | --- | --- |
| Node and npm | `v24.20.0` and `11.19.0` | Extracted the official Linux x64 tar archive after matching SHA-256 `2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2` with the Node release manifest. [Node release directory](https://nodejs.org/download/release/v24.20.0/) |
| Codex | `0.169.0` | Installed `@openai/codex@0.169.0` from the official npm registry with its Linux x64 native dependency. [Codex CLI installation](https://learn.chatgpt.com/docs/codex/cli) |
| Claude Code | `2.1.318` | Installed `@anthropic-ai/claude-code@2.1.318` from the official npm registry with its Linux x64 native dependency. [Claude npm installation](https://code.claude.com/docs/en/setup#install-with-npm) |
| socat | `1.8.1.1` | Used `apt-get download` and `dpkg-deb -x` for `socat=1.8.1.1-1` and `libwrap0=7.6.q-36build2`. Starting socat required the extracted library directory in its process environment. |

The installation prefix is `/var/tmp/model-ladder/981e99050113eb7a/benchmark-live-tools-faoead52`. Its `cli/package-lock.json` records the resolved packages and npm integrity values. The first attempt used `/tmp`, which disappeared on WSL restart. `/var/tmp` survived later launches. The installation required no `sudo`, system package installation, PATH change, or WSL policy change. It used official Linux artifacts and carried over no Windows credentials, CLI executable, or settings.

### Controller policy and the frozen arms

Codex on WSL2 uses the Linux bubblewrap and seccomp command sandbox. The trusted Codex client uses its own login and model connection. Its model-directed shell commands receive the effective filesystem and network policy. Security depends on that effective policy and the inherited environment. A successful standalone profile probe applies only to the profile tested. The frozen legacy and v2 runners pass `codex exec --sandbox`. OpenAI documents that this flag selects legacy settings over a local named default profile unless a managed requirement forces permission profiles. This difference matters because the tested `:workspace` profile read a fake file outside the workspace. [Codex Linux sandbox](https://learn.chatgpt.com/docs/sandboxing) · [Profile precedence](https://learn.chatgpt.com/docs/permissions)

Claude uses bubblewrap and socat for sandboxed Bash commands. Set `sandbox.enabled`, `sandbox.failIfUnavailable`, and `sandbox.allowUnsandboxedCommands=false` to require that boundary. Read and Edit use separate file-tool rules. Workflow, hooks, and MCP paths need separate qualification. The installed CLI exposes `--restricted`, `--tools`, and `--permission-prompts`. Removing Workflow to use a more restrictive mode would change the legacy comparison arm. Both the exact tool inventory and effective file restrictions need live canary evidence. [Claude Bash sandbox scope](https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox) · [Claude built-in file permissions](https://code.claude.com/docs/en/permissions#block-file-tool-reads-and-writes-outside-the-working-directories)

The candidate evaluator runs candidate code. The frozen DIRECT and MANAGED runner invokes its deterministic gate using a host-side process. An outer boundary must cover that process too. No model-directed command or evaluator should inherit a controller credential variable or have a mount that contains controller auth files. Confirm that policy without changing the frozen arms. If the dedicated WSL2 configuration cannot do so, use a dedicated Linux VM with no Windows host shares. Keep provider access in a trusted controller or approved gateway and run tools and candidate tests under a restricted identity or namespace. A VM alone does not hide credentials shared within the guest. If that separation is unavailable, keep the pilot blocked.

### Observed Linux smoke results

| Check | Status | Evidence |
| --- | --- | --- |
| Node evaluator in offline bwrap | **PASS** | The frozen small-bug evaluator received only the mounted fixture and tests. The starter exited `1` with `AssertionError`. The reference exited `0` with `ACCEPTANCE_PASS`. Both CLIs and socat also returned their version strings inside the namespace. |
| Codex default workspace read boundary | **FAIL** | `codex sandbox --permission-profile :workspace` read an existing fake file outside the fixture. It exited `0` and reported `OUTSIDE_READ=True`. The host control verified the file. |
| Codex standalone explicit strict profile | **PASS** for the command path tested | The profile denied `:root`, allowed the CLI and Node binaries to be read, and gave fixture-only write access. Parent and child read the fixture and wrote JSON evidence there. Both got `ENOENT` opening the outside canary for read and `r+`. Both got `EPERM` connecting to the same numeric loopback listener that answered the host before and after. The host canary was unchanged. |
| Codex standalone stdout, stderr, and exit | **PASS** | The direct strict run captured parent and child markers on both streams and returned the deliberate exit code `17`. An exploratory create-mode write produced only a private shadow file. The final probe used `r+` to test the existing host canary without creating a shadow. |
| Codex standalone normal completion, timeout, cancellation | **PASS** for the command path tested | The strict profile returned `0` after natural completion, `124` under the timeout supervisor, and `-15` after cancellation. Linux pidfds confirmed three Node processes exited in each case. Heartbeats stopped and timeout and cancellation produced no natural completion markers. Lifecycle with authenticated agents remains **UNVERIFIED**. |
| Frozen Codex strict verifier | **FAIL** to qualify, with no host fallback | The frozen smoke exits `2`. Linux Codex `0.169.0` treats the runner's literal `linux` argument as the command and exits `101`. The installed CLI accepts `codex sandbox --permission-profile … -- COMMAND`. An argv-only diagnostic then hit a missing read grant for the exact Codex helper executable. With that executable granted read access, a separate diagnostic returned an enforcement receipt and exit `17`, but the smoke still failed because the expected nested stderr marker was absent. The direct standalone probe above did capture both streams. None of these diagnostic adjustments changed the frozen runner. The Claude handoff traced the missing marker to Node discarding output on inherited socket stdio. It fixed all three causes in the working tree only. [Handoff validation](../audits/claude-handoff-validation.md#3-blockers-found) |
| Codex legacy worker modes | **FAIL** for credential separation | `codex sandbox -c sandbox_mode="workspace-write"` and `"read-only"` read an outside file and a fake `$CODEX_HOME/fake-auth.json`. Outside writes were denied. |
| Claude real Bash, built-in tools, and Workflow | **UNVERIFIED** | Native CLI and socat startup succeeded. No authenticated tool session or legacy Workflow executed under the final permission policy. |
| Authenticated model connectivity | **BLOCKED** | Both dedicated Linux controller profiles reported exit `1` and unsigned status. The probes retained only the status and exit codes. No model request ran. |

The exact commands and results are in the recovery artifact folder listed below. `wsl-native-probes.jsonl` records the frozen smoke. `wsl-codex-native-existing.json` records the direct Codex parent and child probe. `wsl-codex-native-lifecycle-by-exe.json` records the three lifecycle cases. `wsl-node-evaluator.json` records the independent Node evaluator. The corresponding Python scripts reproduce each check with fake data and unsigned controller profiles.

### Sign in interactively from the controller

Open `wsl.exe -d Ubuntu --cd /tmp` in a separate terminal. Use the staged paths below for the controller login. Keep the controller directories out of fixture mounts and tool access. Use the intended benchmark accounts and perform browser authorization yourself.

```bash
base=/var/tmp/model-ladder/981e99050113eb7a/benchmark-live-tools-faoead52
bench_path="$base/node-v24.20.0-linux-x64/bin:$base/cli/node_modules/.bin:/usr/bin:/bin"
umask 077
cd "$base/controller-home"
env -i PATH="$bench_path" HOME="$PWD" CODEX_HOME="$base/codex-controller" \
  TERM="${TERM:-xterm}" LANG=C.UTF-8 codex login --device-auth
env -i PATH="$bench_path" HOME="$PWD" CLAUDE_CONFIG_DIR="$base/claude-controller" \
  TERM="${TERM:-xterm}" LANG=C.UTF-8 claude auth login --claudeai
```

Enable Codex device-code sign-in in the appropriate ChatGPT account or workspace if required. Follow the browser instructions in the terminal. Keep device codes and account details out of shared logs. For Claude Console accounts, use `claude auth login --console` and record that authentication choice. Verify status from the same isolated environment with `codex login status` and `claude auth status`. Successful login supplies only the controller credential. The tool-disabled connectivity smoke for the pinned models and the end-to-end permission canaries are still required. [Codex device authorization](https://learn.chatgpt.com/docs/auth?surface=cli) · [Claude authentication](https://code.claude.com/docs/en/authentication)

## Previous environment selection

Windows 11 Pro 26H2 build `26300.8697` has Codex `0.169.0`, Claude Code `2.1.318`, Node `24.20.0`, and Git `2.55.0.windows.5`. Both native CLIs reported signed-in status with exit `0` in the approved regular-user process. The managed shell could not resolve Codex's home and denied WSL enumeration and Docker engine access. The approved probes ran as a regular user and made no administrative setup changes.

| Priority | Option | Status and evidence |
| --- | --- | --- |
| 1 | Native Windows MXC | **BLOCKED**. The documented one-command MXC override exited `1` with `native MXC is unavailable on this executor`. The CLI supports selecting MXC. The current build number alone cannot establish native capability. The diagnostic did not identify a missing OS component or a policy restriction. [Codex Windows sandbox and compatibility](https://learn.chatgpt.com/docs/windows/windows-sandbox#mxc-compatibility) |
| 2 | Dedicated WSL2 | **Selected for setup.** Existing Ubuntu 26.04 LTS uses WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, bubblewrap `0.11.1`, Python `3.14.4`, and Git `2.53.0`. The distro outside the namespace exposes Windows through a `9p` mount at `/mnt/c` and has WSL interop enabled. The unprivileged sandboxed process could not see that mount. Linux `node`, `codex`, `claude`, and `socat` were absent from the probed PATH. [Per-distro WSL settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) · [Bubblewrap](https://github.com/containers/bubblewrap) |
| 3 | Dedicated Linux VM | **UNVERIFIED**. No Hyper-V, VMware, VirtualBox, QEMU, or Multipass management command was found on PATH. No guest connection was available for a probe. An already provisioned Linux VM with shared folders disabled remains an alternative. |
| 4 | Hardened container | **BLOCKED** for the benchmark. The approved Docker Linux engine `29.9.2` ran the installed `python:3.12-slim` image as UID `65534` with read-only root, no host mounts, all capabilities dropped, and `--network none`. The container exposed only `lo`, could not see the Windows repo path, and lacked Node, Git, and both CLIs. An authenticated image and its egress policy remain unverified. [Docker none network driver](https://docs.docker.com/engine/network/drivers/none/) |

Windows Codex also documents `elevated` and `unelevated`. The explicit `unelevated` startup probe printed its marker and exited `0`. Its documented lack of deny-read support disqualifies it for this benchmark. The previous explicit strict check on the installed elevated launcher rejected the deny-root profile because it required effective `:root` read. This recovery did not restart elevated setup. Native Claude file tools and Workflow processes still lack an independently verified whole-process Windows boundary. [Earlier strict probe](../audits/sandbox-validation.md) · [Windows sandbox modes](https://learn.chatgpt.com/docs/windows/windows-sandbox) · [Claude Code sandbox scope](https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox)

## Previous offline smoke results

The WSL2 smoke runs `bwrap` without elevated privileges as UID `1000`. It exposes the runtime read-only, binds only the disposable fixture for writes, and supplies a private temp directory and PID and network namespaces. It clears the inherited environment. All file probes use generated canaries. The outer WSL process that starts the smoke can reach the Windows mount, so it must remain a trusted launcher. Worker and evaluator commands must enter the sandbox before they run.

| Case | Status | Evidence |
| --- | --- | --- |
| Allowed read, write, and command execution | **PASS** for the offline WSL2 fixture | Parent and child read `test-only` and wrote separate expected markers under `/fixture`. Python exercised the controls. The real Node evaluator remains **UNVERIFIED** here. |
| Denied file read and write | **PASS** for the offline WSL2 fixture | The host WSL process opened both fake canaries for read and write. Parent and child received `ENOENT` for both paths and had no `/mnt/c`. Both canaries survived byte-for-byte. The mount namespace omitted those paths. |
| Forbidden network access | **PASS** for the offline WSL2 fixture | A numeric loopback listener in the outer namespace responded before and after. Parent and child were in a different network namespace and both got `ECONNREFUSED` from the same address and port. The test used no DNS lookup. |
| Subprocess restrictions and exit propagation | **PASS** for the offline WSL2 fixture | Child inherited the file and network restrictions, exited normally, and the parent returned the deliberate exit code `17`. The WSL2 smoke supervisor completed with exit `0`. |
| Timeout | **PASS** for the offline WSL2 fixture | Coreutils `timeout` returned `124` after the two-second deadline. Three kernel pidfds signaled exit, heartbeat files stopped changing, and no natural completion marker appeared. |
| Cancellation | **PASS** for the offline WSL2 fixture | The supervisor sent `SIGTERM` to the launched process group and observed `-15`. All three kernel pidfds signaled exit before natural completion. |
| Effective containment for native CLI tools and Workflow | **UNVERIFIED** | The offline probe launched Python. It did not exercise Codex tools, Claude built-in file tools, Claude Workflow, or the candidate evaluator under the final policy. |
| Permitted model connectivity and protected authentication | **BLOCKED** | The tested namespace has no model path by design. The Windows sign-in check established local Windows status only. Both Linux clients still need a supported authentication path and verified provider egress. |
| Native CLI timeout and cancel | **UNVERIFIED** | Repeat lifecycle tests with the actual CLI processes and the final policy. The Python fixture measured the tested supervisor and namespace only. |

### Reproduce the recorded probes

```powershell
cmd.exe /d /c ver
codex.exe --version
claude.exe --version
node --version
git.exe --version
codex.exe -c windows.sandbox=mxc sandbox --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo SANDBOX_OK
codex.exe -c windows.sandbox=unelevated sandbox --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo SANDBOX_OK
wsl.exe --list --verbose
wsl.exe -d Ubuntu --cd /tmp --exec /usr/bin/findmnt -n -o FSTYPE /mnt/c
wsl.exe -d Ubuntu --cd /tmp --exec /usr/bin/which node codex claude socat git bwrap curl python3
docker.exe version --format '{{.Server.Os}} {{.Server.Version}}'
docker.exe run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 --read-only --pids-limit 32 python:3.12-slim python -I -c "import os,shutil; print(dict(uid=os.getuid(),interfaces=os.listdir('/sys/class/net'),host_repo=os.path.exists('/mnt/c/neil_personal/model-ladder'),tools={name:shutil.which(name) for name in ('node','git','codex','claude')}))"
$recovery = Join-Path ([IO.Path]::GetTempPath()) 'model-ladder/981e99050113eb7a/verification/benchmark-environment-recovery'
Get-Content -Raw (Join-Path $recovery 'wsl-boundary-smoke.py') | wsl.exe -d Ubuntu --cd /tmp --exec /usr/bin/python3 -I -
```

The temp recovery folder retains the smoke script, `wsl-boundary-pidfd.json`, and `benchmark-sources.bundle`. The test closes its listener and removes its WSL temp fixture on exit. Docker used `--rm` for the probe container.

## Set up the dedicated WSL2 distro

1. Use a named, disposable Linux distro or an already provisioned equivalent. If provisioning requires a per-distro mount or interop change, obtain explicit approval first. Confine the changes to that distro. The documented WSL settings are `[automount] enabled=false`, `[automount] mountFsTab=false`, `[interop] enabled=false`, and `[interop] appendWindowsPath=false`. Check both the mount and process-launch paths inside the final workload. Keep the namespace even if those distro settings are applied. [Import and operate WSL distributions](https://learn.microsoft.com/en-us/windows/wsl/basic-commands) · [WSL automount and interop settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
2. Provision Linux Node `24.20.0`, Git, Codex `0.169.0`, Claude Code `2.1.318`, and their documented sandbox dependencies in the dedicated distro. Record resolved executable paths, versions, package or image digests, and any Git version difference. Keep the benchmark tool versions fixed across arms. Confirm the pinned models remain available. [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) · [Claude Linux sandbox dependencies](https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2)
3. Import only the frozen sources and fixture data. `git bundle verify` accepted the self-contained bundle with SHA-256 `a4b23159c3f89bc5cd1312268bce33c25ba40b315bd8d88a356cba88b3332477`. Fetch `refs/heads/benchmark-legacy` and `refs/heads/benchmark-v2` into a scratch Git repo and verify the pinned commits in the comparison report. Copy the current fixture generator and manifest separately. Keep source mounts read-only and create fresh fixture checkouts. Use independent scope checks and run the protected evaluator with no credential mounts or inherited credential variables.
4. Use each CLI's documented sign-in mechanism for a benchmark identity or an approved model gateway. Keep authentication files, variables, and credential helpers outside model-directed tool access. Use provider-only egress for the trusted clients and keep tool and evaluator egress restricted. For Claude, apply file-tool permissions as well as sandboxed Bash settings that fail closed. Bash sandbox settings alone do not cover built-in file tools or Workflow. For Codex, confirm the effective Linux permission profile and shell environment. Test the exact configurations of all arms, including the legacy Workflow, before using credentials. [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli) · [Codex shell environment policy](https://learn.chatgpt.com/docs/enterprise/security-cookbook) · [Claude gateway](https://code.claude.com/docs/en/llm-gateway) · [Claude tool permissions](https://code.claude.com/docs/en/permissions)
5. Repeat the canary and lifecycle checks in the final boundary. Include commands, built-in file tools, and subprocesses. Prove forbidden network access against a healthy endpoint and prove permitted connectivity with a trusted, tool-disabled smoke for each pinned model. Capture the effective policy. If credentials or unrelated files are readable, or a launcher falls back, stop with **BLOCKED**.
6. Preserve evidence outside the worker namespace. Terminate only the owned workload, verify all descendants exited, and discard the disposable fixture and benchmark login state under the approved retention policy. Stop the dedicated distro with `wsl.exe --terminate <benchmark-distro>`. Unregistering it is destructive and requires separate approval.

## Pilot and formal readiness

| Backend | A. Native | B. Legacy | C. v2 DIRECT | C. v2 MANAGED |
| --- | --- | --- | --- | --- |
| Codex `0.169.0`, planned `gpt-6-luna` | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Claude Code `2.1.318`, planned `claude-haiku-5-5` | BLOCKED | BLOCKED | BLOCKED | BLOCKED |

All eight slots use effort `low` and `small-bug` at commit `a43022e53721a86f7dc29f652fef5b5e59345a7b` and tree `d3eb8d0a246ea6fae7327c36c670513f9cd31191`. Live sandbox backend, per-slot model calls, token use, duration, exit, verification outcome, and candidate tree remain `UNKNOWN`. This enablement phase launched zero models and produced no live trial rows. [Machine-readable pilot plan and frozen inputs](execution-v2-comparison.raw.json)

Formal benchmark readiness remains **BLOCKED**. The next gate is controller login, permitted provider connectivity, and a proven credential and tool boundary for the frozen arms. Once every gate passes, run the existing eight pilot cases. Review that evidence before scheduling the 102 formal trials.
