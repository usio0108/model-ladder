# Claude handoff validation

November 19, 2026. Claude Code took over the Execution v2 benchmark environment work from Codex. This report covers the takeover state, the runner sandbox diagnosis, the minimal fix, native security boundaries, authentication, and pilot readiness. **The live pilot was not run. Formal benchmark readiness is BLOCKED.** Related reports: [benchmark environment](../benchmarks/benchmark-environment.md), [controlled comparison](../benchmarks/execution-v2-comparison.md), [sandbox validation](sandbox-validation.md).

## 1. Revisions at takeover

| Item | Revision |
| --- | --- |
| Checkout `main` `HEAD` | `98db16dcb4ae0b4b6f08e29f0b3682677a3115bf` (release 1.2.11). Origin `usio0108/model-ladder`. |
| B. Legacy frozen arm | Branch `execution-v2-baseline-20261119` at `c31e53681e53cca92dd3d1fb6f2ae041208f179a`, tree `806fb521204178edf25f93e2416b24b5867e377a`. Unchanged. |
| C. Execution v2 frozen arm | `e6fe5b91af7ac71c3d0851cae0a1bbb2cb90b5a2`, tree `a0521b46f54154964a84a44b381a0fc9f7a66d93`, in the detached temp clone `execution-v2-comparison-rFpvQq/source`. Unchanged. |
| Working tree | Uncommitted. 26 modified tracked files and 8 untracked paths. A file-by-file comparison against the frozen v2 commit found only these differences: the benchmark docs, the raw record, `tests/e2e/execution-v2-comparison-fixtures.mjs`, and this handoff's change to `scripts/codex-verify.mjs`. |

The temp clone is owned by the `CodexSandboxOffline` Windows account. It was read with a one-off `git -c safe.directory=*` flag. No global Git configuration changed. The source bundle SHA-256 still matches `a4b23159c3f89bc5cd1312268bce33c25ba40b315bd8d88a356cba88b3332477`.

## 2. Confirmed architecture

The frozen v2 code matches the [architecture document](../architecture/execution-v2.md) where this review checked it. `scripts/task-contract.mjs` validates the contract and policy. `scripts/codex-run.mjs` runs both backends. `scripts/codex-exec.mjs` and `scripts/claude-exec.mjs` launch the native CLIs. The strict verification sandbox in `scripts/codex-verify.mjs` is used only when `requireVerificationSandbox` or `MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX=1` is set, or for `ISOLATED`. The `DIRECT` and `MANAGED` gates otherwise run in the host shell and record `HOST_UNSANDBOXED`.

`codex-verify.mjs`, `process-tree.mjs` and `tests/e2e/codex-sandbox-smoke.mjs` were byte-identical in the legacy branch, the frozen v2 commit and the working tree before this handoff.

## Execution chain and the boundary at each stage

| Stage | Process and boundary on the WSL2 benchmark host |
| --- | --- |
| Benchmark harness | Trusted controller process. It can see the Windows `/mnt/c` mount and has the user's WSL identity. |
| Task contract | Parsed in the runner process. It has no separate boundary. |
| Runner | `node scripts/codex-run.mjs` in the controller. Host identity, host environment, unrestricted network. |
| Native CLI | `codex exec` or `claude --print` in the controller. Each reads its own credentials and reaches its provider. |
| Codex tool execution | Commands run in the Codex Linux bwrap and seccomp sandbox. The frozen arms pass the legacy `--sandbox read-only` or `workspace-write`. Probe result: writes outside the workspace are denied. **Reads are unrestricted, including a fake auth file in `$CODEX_HOME`.** |
| Claude tool execution | Bash runs in the bwrap and socat sandbox only if the sandbox settings enable it. Read, Edit, Write, WebFetch, hooks, and local MCP servers run outside that sandbox and are checked only by permission rules. Not live-tested; see section 6. |
| Verification, default | Host shell child of the runner. It inherits the runner's environment, files and network. |
| Verification, strict | `codex sandbox` with a generated deny-root permissions profile. Before this fix it was unusable on Linux. |
| Evidence | Written by the runner on the host to `.model-ladder/` and the temp artifact directory. |

## 3. Blockers found

1. **The frozen strict verifier passes an obsolete `linux` subcommand.** Codex `0.169.0` on both Linux and Windows has the usage `codex sandbox [OPTIONS] [COMMAND]...` and no platform subcommand. The Linux launcher tried to execute `linux` and panicked: `Failed to execvp linux: No such file or directory`, exit `101`.
2. **The deny-root profile hides the Codex executable from itself.** The Linux launcher re-executes its own native binary inside bwrap. Under `":root"="deny"` the binary was unreadable, so `bwrap: execvp …/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex: No such file or directory`.
3. **Node output from the verified command was silently lost.** Node's `child_process` `pipe` stdio is an AF_UNIX socketpair. Inside the Codex network-disabled seccomp sandbox, Node cannot classify an inherited socket fd. It falls back to a discarding `Writable` for `process.stdout` and `process.stderr`. A probe recorded `{"out":"Writable","err":"Writable","fd1":"socket:[…]"}`. Through a real pipe it recorded `Socket`. Exit codes survived, so the command ran but its evidence vanished. Shell `echo` and errors that Node writes directly to the fd were visible. This is why the earlier diagnostic saw exit `17` and no nested stderr marker.
4. **The strict smoke's negative write check fails with the fix in place.** Inside the sandbox, `appendFileSync` on paths outside the authorized set returns success. Probed paths included the fake sensitive file, a new file in the run directory, `$HOME`, and `/var/tmp`. On the host each file stayed unchanged or absent afterward. Reads of an existing host secret returned `ENOENT`. The writes land in a sandbox-private writable filesystem and are discarded. The smoke requires an errno denial, so it correctly reports a failure. It was not relaxed.
5. **Codex legacy worker sandbox can read credentials.** `codex sandbox -c sandbox_mode="workspace-write"` and `"read-only"` both read an outside file and a fake `$CODEX_HOME/fake-auth.json`. Writing outside the workspace was denied (`Read-only file system`). The frozen arms launch workers with exactly these legacy modes. A model-directed command in either arm could therefore read the controller's Codex credential file.
6. **Both Linux CLI controller profiles are signed out.** See section 6.
7. **Claude tool and Workflow boundaries are unproven.** Live probes need authentication. The official docs place file tools, hooks and local MCP servers outside the Bash sandbox.

## 4. Files changed

Only `scripts/codex-verify.mjs`. The frozen branch and the frozen v2 clone were not modified. No test was removed or weakened.

- Removed the platform subcommand argument.
- Granted read access to the resolved launcher executable (`realpathSync(binary)`) only, and returned `SANDBOX_UNAVAILABLE` when the binary is missing. An npm `codex` shim resolves to its `.js` file. Set `CODEX_BINARY` to the native executable there, otherwise strict mode still fails closed.
- On Linux, the command now runs behind two FIFOs created in the private scratch directory. `cat` relays them to the inherited stdout and stderr. The command gets real pipes, keeps separate streams and keeps its exit status. The FIFOs live outside the candidate worktree, so the tree comparison is unaffected. Windows and macOS keep the previous `shell: true` path.

The frozen B and C arms still contain the old verifier. Their `DIRECT` and `MANAGED` gates do not use it unless strict mode is requested, so the pilot design is unaffected. Do not set `MODEL_LADDER_REQUIRE_VERIFICATION_SANDBOX=1` for the frozen arms on Linux. It would block them.

## 5. Sandbox results

WSL2 Ubuntu 26.04, kernel `6.18.33.2-microsoft-standard-WSL2`, UID `1000`, Node `24.20.0`, Codex `0.169.0` native binary via `CODEX_BINARY`. All runs used a disposable copy of the working tree under `/var/tmp/model-ladder/981e99050113eb7a/handoff-iruo4y` and fake data only.

| Check | Frozen verifier | Fixed verifier |
| --- | --- | --- |
| Launcher starts | FAIL, exit `101` | PASS |
| Verifier receipt: outside read, `r+` write, loopback | Not reached | PASS: `ENOENT`, `ENOENT`, `EPERM` |
| Allowed fixture read and write, parent and child | Not reached | PASS. `allowed-write.txt` and `child-write.txt` contain `allowed-fixture`. |
| Exit code propagation | Not reached | PASS, `17` |
| stdout and stderr capture | Not reached | PASS. Both child reports and `sandbox-fixture-stderr` were captured. |
| Outside read of the fake sensitive file | Not reached | PASS for the parent, `ENOENT`. The child read the parent's sandbox-private shadow file, not host data. |
| Outside write denial | Not reached | **FAIL** by the smoke's errno standard. The host file stayed `fake-secret`. |
| Network denial, parent and child | Not reached | PASS, `EPERM`, with host listener controls before and after |
| Normal completion, three process levels | Not reached | PASS |
| Idle timeout | Not reached | PASS, `TIMEOUT`, heartbeats stopped, no natural exit |
| Cancellation | Not reached | PASS, `CANCELLED`, heartbeats stopped, no natural exit |
| Failure is never `VERIFIED` | PASS, `SANDBOX_UNAVAILABLE` and no host fallback | Unchanged. Enforcement failure still raises `SANDBOX_ENFORCEMENT_FAILED`. |

`node tests/e2e/codex-sandbox-smoke.mjs` therefore exits `1` with `write: ALLOWED`. The lifecycle rows came from a scratch copy of the smoke that continues after that assertion. That copy is diagnostic evidence only and is not in the repository.

Codex worker boundary for the frozen arms, legacy modes, standalone launcher:

| Probe | `workspace-write` | `read-only` |
| --- | --- | --- |
| Read a file outside the workspace | Readable | Readable |
| Read a fake `$CODEX_HOME/fake-auth.json` | Readable | Readable |
| Write outside the workspace | Denied | Denied |

Regression runs: `node --test tests/unit/codex-exec.test.mjs` passed 10 of 10 on Windows and on WSL2 Linux. The sandbox-related subset of `tests/unit/codex.test.mjs` passed 3 of 3 on Windows.

### Claude Code boundary, from official documentation

Live verification is **UNVERIFIED** because the Linux client is signed out.

- Permission modes: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `--permission-prompts none` denies prompts in unattended runs. [Permissions](https://code.claude.com/docs/en/permissions) · [CLI reference](https://code.claude.com/docs/en/cli-reference)
- The Bash sandbox is off by default. Use `sandbox.enabled`, `sandbox.failIfUnavailable: true` and `sandbox.allowUnsandboxedCommands: false` to require it. Linux needs bubblewrap and socat. It covers Bash, PowerShell, Monitor and their children. [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- Read, Edit, Write, WebFetch and WebSearch are outside that sandbox. Command hooks, local MCP servers, LSP servers, the status line and `apiKeyHelper` are also outside it. `blockReadsOutsideWorkingDirectories` and `blockWritesOutsideWorkingDirectories` are tool-level checks, not OS enforcement. The docs do not state whether subagents or Workflow agents are covered. [Sandboxing](https://code.claude.com/docs/en/sandboxing) · [Permissions](https://code.claude.com/docs/en/permissions)
- Hooks run locally with the parent environment. `PreToolUse` blocks with exit `2` or `permissionDecision: "deny"`. [Hooks](https://code.claude.com/docs/en/hooks-guide)
- `--strict-mcp-config --mcp-config <file>` loads only the listed MCP servers. [MCP](https://code.claude.com/docs/en/mcp)
- `--cloud` runs on Anthropic infrastructure from a fresh clone and ignores local settings. `--bg` is a local background session. Neither changes the local tool boundary. [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- `sandbox.filesystem.denyRead` and `sandbox.credentials` can hide credential paths and variables from sandboxed commands only. Default read protection for `~/.claude` or `.credentials.json` is not documented.

A Claude worker's file tools therefore have only a rule-level boundary. Proving that `CLAUDE_CONFIG_DIR` is unreadable requires live canaries for the Read tool, Bash, and the legacy Workflow agents.

## 6. Authentication and model connectivity

Probed in the controller environment that the [setup guide](../benchmarks/benchmark-environment.md#sign-in-interactively-from-the-controller) defines. Only exit codes and the sign-in flag were kept.

| Client | Command | Result |
| --- | --- | --- |
| Codex `0.169.0` | `codex login status` | `Not logged in`, exit `1` |
| Claude Code `2.1.318` | `claude auth status` | `loggedIn: false`, `authMethod: none`, exit `1` |

No model request ran. No Windows credential was copied. No token was printed or written to a fixture. Model connectivity is **BLOCKED**.

## 7. Pilot results

**Not run.** The prerequisites failed: sections 3.4 to 3.7. Live pilot coverage remains **0/8** and formal coverage **0/102**. Backend, model, token, cache, duration, verification and Git-snapshot fields remain `UNKNOWN` for all eight slots, not zero. Zero model calls were made in this handoff. The raw record `execution-v2-comparison.raw.json` is unchanged.

## 8. Open issues and required user actions

1. **Sign in.** Only the user can do this. Run the device or browser logins in a separate WSL terminal from the documented controller block. Then run `codex login status` and `claude auth status` in the same environment. Do not copy Windows credentials.
2. **Codex credential exposure in the frozen arms.** Legacy `--sandbox` modes give tools full read access. The options that do not touch the frozen arms are:
   - A managed Codex requirement that forces a deny-read permission profile for every `codex exec`. This needs a system-level config path such as `/etc/codex`, so it needs explicit user approval.
   - An outer namespace per trial that hides `$CODEX_HOME`. This is not possible while the same Codex process must read it.
   - A credential-holding gateway, so the client has no long-lived token on disk.
   Until one of these passes a canary test, the Codex pilot is BLOCKED.
3. **Claude canaries.** After sign-in, run the Read tool, Edit tool, Bash, and the legacy Workflow against fake canaries in `CLAUDE_CONFIG_DIR`, `$HOME` and an unrelated repo. Use the exact settings of each arm.
4. **Ephemeral writes inside the Codex sandbox.** Decide whether "not persisted and not visible to the host" meets the write requirement. Until that decision is made, the strict smoke stays failing.
5. **Host-shell gate.** The frozen `DIRECT` and `MANAGED` gates inherit the runner's environment. They need an outer boundary that excludes controller credentials, as already recorded.
6. The working-tree fix is uncommitted and lives only in this checkout. It is not in either frozen arm.

## 9. Formal benchmark readiness

**BLOCKED.** No pilot evidence exists, both Linux clients are signed out, and the Codex worker can read its credential directory under the frozen arms' sandbox modes. Claude tool and Workflow containment is unproven. Do not schedule the 102 formal trials. The next gate is items 1 to 3 above, then the eight pilot slots.
