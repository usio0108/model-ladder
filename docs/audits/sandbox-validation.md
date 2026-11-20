# Sandbox enforcement validation

Validation on November 19, 2026 with Codex CLI `0.169.0` on managed Windows. This file keeps only what is still open. Positive native execution and native command-level denials remain **UNVERIFIED**. The related Linux results and the boundary used for benchmarks are in the [benchmark security boundary](benchmark-security-boundary.md).

## Open items

| Area | Still open | How to check |
| --- | --- | --- |
| Windows native launcher | `codex.exe sandbox -- node --version` exits `1` with `Could not find home directory`. The strict smoke exits `2` with `SANDBOX_UNAVAILABLE`, so no command ran under the native sandbox. | `node tests/e2e/codex-sandbox-smoke.mjs` on a Windows host whose launcher starts |
| Native fixture on Windows | Allowed read and write, exit code `17` with output capture, outside-file read and write denial, loopback denial, and normal, timeout and cancel lifecycle are all **UNVERIFIED**. Only the host controls passed. | Same smoke. Exit `0` means every native check passed. |
| Outside-write denial on Linux | The smoke asserts an errno for an outside write. The Codex Linux sandbox lets that write succeed in a private layer that is discarded, so the smoke exits `1` with `write: ALLOWED`. Host integrity is covered separately by `tests/e2e/host-integrity-smoke.mjs`. | `node tests/e2e/codex-sandbox-smoke.mjs` on Linux or WSL2 |
| Other hosts | macOS and standalone Linux were not available. Claude's shell sandbox (macOS, Linux and WSL2 only) was not run. [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) | Run the smoke and the verification sandbox on each host |
| Container fallback | There is none. Docker engine access was denied in the managed session and no container ran. A host that must run the gate and has no verified native backend needs a separately qualified container or another supported host. | Qualify an image with a narrow mount and environment policy and a confirmed network boundary |
