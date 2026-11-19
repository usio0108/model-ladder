# Benchmark security boundary

November 19, 2026. This report covers the trusted-controller boundary for the Execution v2 benchmark on WSL2 and the final offline checks. It follows the [Claude handoff validation](claude-handoff-validation.md).

**Status.** Every required Codex security condition passed offline through the real `codex exec` tool path. Claude's checked tool paths are confined, but Claude stays **BLOCKED**. The Codex-only pilot is ready to wire, but it is not run. It waits for a Codex login and a pilot driver that uses this wrapper.

## Decisions applied

- Host integrity is the required write standard. Operation denial is recorded and is still **FAIL** for the Codex tool sandbox. The strict `codex-sandbox-smoke.mjs` is unchanged and still exits `1` with `write: ALLOWED`.
- No change to the frozen legacy arm (`c31e536…`) or the frozen v2 arm (`e6fe5b9…`). No gateway, VM or agent framework. Claude is not signed in.

## Architecture

| Component | Can read controller credentials | Enforcement |
| --- | --- | --- |
| Harness, runner, native CLI | Yes, their own | Host view, a private `/etc/codex` and `/etc/claude-code`, and an `env -i` allowlist |
| Codex tools, worker or legacy reviewer | No | Managed `requirements.toml` forces profile `bench` over every `--sandbox` mode |
| Codex tools, role started with `--sandbox read-only` | No | The `codex` shim selects profile `bench-ro`. The workspace is read-only too. |
| Runner host-shell gate (`node …`) | No | The `node` shim runs it in bwrap with only the worktree writable and a read-only root |
| Claude Bash | No | Managed settings: sandbox required and fail-closed, `denyRead` on controller directories, credential variables denied |
| Claude Read, Edit, Write, Glob, Grep, Agent | No | Managed settings deny rules and blocked outside reads and writes. These are checks inside the CLI. |

The wrapper is `tests/e2e/bench-boundary.mjs`, `BOUNDARY_VERSION = 1`. A trial runs as `--trial <dir> [--read <fixture repo>] -- <controller command>` inside an unprivileged user namespace. The namespace replaces `/etc` with a tmpfs, binds the original entries back read-only, and adds the generated policy files. Nothing on the host system changes. The `codex` and `node` shims lead the controller `PATH`, and `CODEX_BINARY` points at the `codex` shim. Both frozen runners honor `CODEX_BINARY` and `CLAUDE_BINARY`.

## Files

| File | Purpose |
| --- | --- |
| `tests/e2e/bench-boundary.mjs` | Wrapper, its policy generators, `escapingSymlinks`, and the gate `--self-test` |
| `tests/e2e/codex-exec-canary.mjs` | Real `codex exec` tool path against a loopback Responses API mock |
| `tests/e2e/claude-tool-canary.mjs` | Real Claude tools against a loopback Messages API mock and a dummy API key |
| `tests/e2e/host-integrity-smoke.mjs` | Host integrity for the strict verification sandbox |
| `scripts/codex-verify.mjs` | Strict verifier fixes from the handoff. Not used by the frozen arms. |

## 1. Codex real execution path

`codex-exec-canary.mjs` starts a mock Responses API on loopback. Codex `0.169.0` sends `POST /v1/responses` to it with no credential. For `gpt-6-luna`, Codex offers only the code-mode tool `exec`. The mock returns one `exec` call whose JavaScript calls every nested tool:

- `exec_command`, with and without `sandbox_permissions: "require_escalated"`
- `apply_patch` and `view_image`
- the collaboration `spawn_agent` tool

The canaries are fake: `auth.json` in `CODEX_HOME`, `.credentials.json` in `CLAUDE_CONFIG_DIR`, and an unrelated secret. **The verdict comes from tool outputs, host state and Codex logs. The startup banner is not used.**

| Probe | Control (no wrapper) | Worker under wrapper, `workspace-write` | Reviewer under wrapper, `read-only` |
| --- | --- | --- | --- |
| Read the three fake secrets | All readable and sent to the model | `ENOENT` ×3 | `ENOENT` ×3 |
| `require_escalated` read | Rejected: approval policy `never` | Rejected | Rejected |
| `view_image` on `auth.json` | Opened, rejected as an image | `No such file or directory` | `No such file or directory` |
| Append, mkdir, unlink outside | `Read-only file system` | `ENOENT`, host unchanged | `ENOENT`, host unchanged |
| `apply_patch` outside the project | Rejected | Rejected | Rejected, read-only sandbox |
| Write inside the worktree | Allowed | Allowed | **Denied**, read-only file system |
| `git commit` in the worktree | `index.lock` read-only | `index.lock` read-only, commit count unchanged | Same |
| Network to loopback | `Operation not permitted` | `Operation not permitted` | `Operation not permitted` |
| Secrets in Codex logs (`sessions`, `thread_history`) | 6 hits | 0 | 0 |
| `spawn_agent` | `agent thread limit reached` | `agent thread limit reached` | Not run |

All ten checks pass. Tool environments contain variable names such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_PERMISSION_PROFILE`, but no key, token or secret value. `codex exec` rejected the sub-agent with or without the wrapper, so that path is unreachable with the runners' default configuration. It was not proven confined.

## 2. Reviewer permissions

The forced profile ignores `--sandbox`, so a read-only role would have gained workspace write. The `codex` shim restores read-only behavior without touching the runners. When argv contains `exec … --sandbox read-only`, it adds `-c default_permissions="bench-ro"`. `bench-ro` is listed in `allowed_permission_profiles` and has a read-only workspace. Arguments come from the runner, not the model. The canary reviewer could not write `inside.txt`, create a symlink, or apply a patch, and its candidate stayed empty.

Both frozen runners also re-snapshot the verification worktree after review (`checkVerificationTree`, legacy line 497, v2 line 601). A changed tree there fails the attempt. The legacy reviewer runs `workspace-write` by design and keeps that behavior and that check.

## 3. Symlink tests

| Case | Result |
| --- | --- |
| New symlink in the worktree to `auth.json`, then read | Created. The read returns `ENOENT` in the Codex tool sandbox, in the gate and in Claude Bash. Claude Read is denied. |
| New symlink to an outside file, then write through it | Write returns `ENOENT`. The host file is unchanged. Claude Write is denied by the Read deny rule. |
| Retarget a committed symlink (`ln -sfn`) to `auth.json` | Worker: retargeted, read `ENOENT`. Reviewer: `Already exists`, not changed. |
| Commit the symlinks | Fails, because the fixture repository is read-only. |
| Runner collection | `git status` lists `link-auth`, `link-out` and modified `link-base` as candidate paths. The frozen runners apply symlinks like files. |
| Harness defense | `escapingSymlinks(worktree)` lists every tracked or untracked symlink whose target leaves the worktree. It detected all three. The pilot driver must call it on each candidate and delivered checkout and fail the trial on any hit. A symlink carries a target path, never target content. |

## 4. Host integrity and operation denial

| Boundary | Host integrity | Operation denial |
| --- | --- | --- |
| Strict verifier sandbox, `host-integrity-smoke.mjs` | **PASS**: no host change, no marker anywhere, nothing left for the next run, and only authorized files in the candidate | **FAIL**: outside writes, mkdir and unlink succeed in a private layer |
| Codex `codex sandbox` under the wrapper | **PASS** | **FAIL**: private writes |
| Codex `codex exec` tools under the wrapper | **PASS** | **PASS**: `ENOENT` for append, mkdir and unlink |
| Gate shim | **PASS** | **PASS**: `EROFS` |
| Claude Bash under managed settings | **PASS** | **FAIL**: append and mkdir in a denied directory succeed privately |

Private writes are visible only to the same sandbox invocation and its children. They are gone in the next run. They are not collected by the runner because they are outside the worktree, and they never reached the host. A test that expects an outside write to fail can behave differently from the host. The fixture checks do not write outside the worktree.

## 5. Controller credential isolation

| Requirement | Evidence | Status |
| --- | --- | --- |
| Worker cannot read credentials | Codex worker `ENOENT`. Claude Read, Glob, Grep and Bash denied. | PASS (Codex), PASS offline (Claude) |
| Verifier and gate cannot read credentials | Codex reviewer `ENOENT`. Gate `ENOENT` with only `PATH`, `HOME`, `TMPDIR` and its marker in the environment. | PASS |
| No sensitive variables reach the fixture | The controller uses an `env -i` allowlist. The gate clears the environment. Codex tools see path names only. Claude Bash had `ANTHROPIC_API_KEY` and `CLAUDE_CODE_MESSAGING_TOKEN` until `sandbox.credentials.envVars` denied them. | PASS with the managed settings |
| No access through symlinks or mounts | Section 3. The gate mounts only the worktree and the runtime. | PASS |
| Logs hold no credentials | No fake secret appeared in Codex `sessions` or `thread_history` under the wrapper. The control run had six hits. Claude logs were not scanned. | PASS (Codex) |

The controller credentials live in `/var/tmp/model-ladder/981e99050113eb7a/benchmark-live-tools-faoead52/{codex,claude}-controller`, mode `0700`, outside every fixture. Use file-based logins. Never authenticate Claude through `ANTHROPIC_API_KEY` without the `envVars` deny rule.

## 6. Claude offline checks

`claude-tool-canary.mjs` runs Claude Code `2.1.318` against a loopback Messages API. It uses a dummy key, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and the frozen v2 worker arguments: `--permission-prompts none`, `--strict-mcp-config` with no servers, and `--tools`.

| Item | Result |
| --- | --- |
| Managed settings loading | **PASS.** `/etc/claude-code/managed-settings.json` from the wrapper was read. Without socat, `sandbox.failIfUnavailable` stopped startup: `sandbox required but unavailable … refusing to start`. Deny rules changed tool results compared with the control run. |
| Native sandbox | Bash ran sandboxed and was auto-allowed. Reads of all canaries returned `ENOENT`. `dangerouslyDisableSandbox: true` stayed sandboxed. Network required approval and was denied. Outside writes were private. A `node` child stayed confined. The `node` shim now passes through when Claude sets `SANDBOX_RUNTIME=1`, after nested bwrap failed. |
| Read, Edit, Write, Glob, Grep | Managed: controller and unrelated paths are `denied by your permission settings`. Symlink reads and writes are denied. Control run without settings: everything outside the working directory is denied because no one can approve. |
| Worktree writes for the v2 worker | Denied in both runs. The v2 Claude worker needs fixture-specific `Edit` allow rules, as in the earlier live validation. Their interaction with the managed settings is **UNVERIFIED**. |
| Bash versus hooks | Bash is OS-sandboxed. Command hooks run unsandboxed in the controller by design. No hook was exercised: **UNVERIFIED**. The legacy plugin's hooks are trusted controller code, and `allowManagedHooksOnly` would remove them from the legacy arm. |
| Agent subagent | **PASS.** The sub-agent got the same denials for every file tool. Bash and WebFetch were unavailable. |
| Workflow | Not offered under the v2 `--tools`. The legacy Workflow in an interactive host session: **UNVERIFIED**. |
| MCP, WebFetch | No MCP tools were offered. `WebFetch` returned `No such tool available` from the root and the sub-agent. |

Claude remains **BLOCKED**. The open items are the legacy Workflow session, hooks, the v2 Edit allow rules under managed settings, Claude log scanning, and a live run.

## 7. Frozen versions

Unchanged. Legacy `c31e53681e53cca92dd3d1fb6f2ae041208f179a`, tree `806fb521204178edf25f93e2416b24b5867e377a`. v2 `e6fe5b91af7ac71c3d0851cae0a1bbb2cb90b5a2`, tree `a0521b46f54154964a84a44b381a0fc9f7a66d93`, with a clean temp clone. Fixtures and the raw record are unchanged.

## 8. Codex-only pilot readiness

**Update.** The pilot driver now exists: `tests/e2e/codex-pilot.mjs` with `codex-pilot-regression.mjs`. The controller boundary also gained a private PID namespace after a timeout regression found a surviving `codex exec`. The driver's flow, commands and results are in [benchmark-environment.md](../benchmarks/benchmark-environment.md#codex-pilot-driver). The only remaining step before the pilot is the sign-in followed by the live canary. The text below is the earlier assessment.


The security conditions pass offline. Two items remain before the four Codex slots can run, and neither weakens a boundary:

1. **User:** sign in to Codex in a separate WSL terminal with a dedicated benchmark account. Use the controller block in [benchmark-environment.md](../benchmarks/benchmark-environment.md#sign-in-interactively-from-the-controller). Then run `codex login status` in the same environment.
2. **Harness:** a pilot driver that runs each arm under `bench-boundary.mjs --trial <dir> --read <fixture repo>`. It sets `CODEX_BINARY` to the native executable before the wrapper replaces it with the shim. It calls `escapingSymlinks` on each candidate and delivered checkout. It runs the evaluator through the `node` shim, and it records the fields required by the pilot plan.

Recommended before the first pilot slot: repeat `codex-exec-canary.mjs` once against the real provider with fake canaries. This confirms that the signed-in configuration resolves to the same profile.

Claude slots stay BLOCKED. The formal 102 trials stay unscheduled.
