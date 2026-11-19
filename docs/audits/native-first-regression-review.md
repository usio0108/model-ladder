# Native-first regression review

**Verdict: REVIEW_REQUIRED.** All required local tests pass, and no CRITICAL or HIGH issue remains open. No known security protection got weaker, and legacy compatibility checks pass. The verdict is not `VERIFIED` for three reasons:

- No live Claude Code or Codex session has run the new skill step.
- Remote CI has not run on these changes. They are uncommitted, and the CI `version` job will require a plugin version bump.
- Two LOW review findings remain open (section 4).

Date: 2026-11-19. Platform: Windows 11 (Node 24.20.0, Git 2.55) and Ubuntu WSL2 (Node 24.20.0, Linux).

## 1. Scope and revision

- Base revision: `aed25ab998086e46eccff0c3cf0085b3a48a0dfe` on branch `benchmark-harness-codex-pilot-v1`. It was clean before the change. `main` is `98db16d`, unchanged.
- Changes: 19 files, 877 insertions and 12 deletions, all in the working tree. Nothing was committed, pushed or merged. New files are marked intent-to-add (`git add -N`) so they appear in `git diff`.
- Frozen items checked unchanged: branch `execution-v2-baseline-20261119` = `c31e53681e53cca92dd3d1fb6f2ae041208f179a`. `git diff --name-only HEAD` is empty for `tests/e2e`, `workflows`, `.github`, `hooks`, `scripts/task-contract.mjs`, `scripts/codex-verify.mjs`, `docs/benchmarks/execution-v2-comparison.raw.json` and `docs/benchmarks/execution-v2-comparison.md`. The source bundle sits outside the repository and was not touched.

| File | Change |
| --- | --- |
| `scripts/fast-path.mjs` | New. Local Fast Path `begin` and `check`. |
| `scripts/telemetry.mjs` | New. Passive history report. |
| `scripts/ci-evidence.mjs` | New. GitHub CI evidence, delivery gate, cloud CLI detection and handoff. |
| `scripts/codex-run.mjs` | Extracts `executionConfig` from the inline `configFor` closure with the same logic. Exports `verifyProtection` and `changedNpmScripts`. |
| `scripts/finish.mjs` | Writes history `tokens: null` instead of `0` when the Workflow reports no total. |
| `skills/run/SKILL.md`, `codex-skills/model-ladder/SKILL.md` | Adds the fast-path step before the existing ladder. |
| `tests/unit/native-first.test.mjs` | New, 9 tests. |
| `tests/unit/claude-forecast.test.mjs` | Fixes a stale fake verifier (section 4, finding R0). |
| README, DESIGN and USAGE (English and zh-TW), three new docs, benchmark archive note | Documentation |

## 2. Before and after

| Function | Before | After | Result |
| --- | --- | --- | --- |
| `/model-ladder:run <task>`, Codex skill | Router, worker and verifier agents for every task | Fast path first for eligible one-file tasks. Otherwise the identical ladder. | Ladder steps 1 to 3 unchanged. `--ladder` and `forceLadder` skip the fast path. |
| `codex-run.mjs` CLI, inputs, exit codes | — | Unchanged | `codex.test.mjs`, `scripts.test.mjs` pass |
| Execution v2 DIRECT, MANAGED, ISOLATED | — | Unchanged. Config validation moved into an exported function. | `codex.test.mjs` v2 cases, `task-contract.test.mjs` pass |
| Legacy Claude Workflow, preflight, claim, finish | — | Unchanged except finish's unknown-token default | `flow.test.mjs`, `finish.test.mjs`, `claude-forecast.test.mjs` pass |
| Snapshot, worktree, scope lock, apply mutex | — | Reused by the fast path, not modified | `codex-worktree.test.mjs`, `runs.test.mjs` pass |
| Usage guard, handoff, history | — | Unchanged. The fast path appends v2-shaped history lines. | `handoff.test.mjs`, `usage-statusline.test.mjs` pass |
| Telemetry of old data | v2 runs only | Reads v2, fast, legacy Codex and legacy Claude lines | Real history: 82 lines read, 81 runs |
| Sandbox and permissions | — | Unchanged. The fast path is ineligible when a verification sandbox is required. | Test `sends anything but a LOW-risk DIRECT contract` |
| Benchmark harness and frozen arms | — | Unchanged, archived in the docs | Section 1 |
| GitHub Actions | `test.yml` | Unchanged | — |

## 3. Code review method

The Claude Code `/code-review` skill exists in this environment (levels low to max, plus ultra). It ran twice at level `high` as a forked reviewer on the full working-tree diff. That reviewer had no access to the implementer's reasoning. This is the two-round maximum.

## 4. Findings and resolution

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| R0 | HIGH (pre-existing) | The full suite found `claude-forecast.test.mjs` failing at base `aed25ab`; it passes on `main`. The candidate-proof change (`CANDIDATE` and `candidateTree` in `workflows/ladder.js`) was not reflected in the test's fake verifier. | The fake verifier now runs the real `finish.mjs --candidate` helper. The test asserts `CANDIDATE`, then that finish records `VERIFIED` with no error. No assertion was removed. |
| 1.1 | MEDIUM | `begin` accepted npm checks that cannot run in a clean worktree. | `begin` returns `BLOCKED MISSING_DEPENDENCIES`. |
| 1.2 | MEDIUM | A verify timeout or spawn error escaped as a crash with no JSON. | It now returns `INCONCLUSIVE` or `BLOCKED` JSON (test added). |
| 1.3 | MEDIUM | Each check line counted as a separate run. | `latestPerRun` keeps the last line per run ID. |
| 1.4 | MEDIUM | A 404 with a token was read as not protected. | Only GitHub's explicit "not protected" message counts. Otherwise `UNKNOWN`. |
| 1.5 | MEDIUM | Commit statuses and check-run pages after the first were ignored. | Pagination added, and the status API is read. |
| 1.6 | MEDIUM | Some `begin` errors gave no JSON. | Every `begin` failure is JSON `BLOCKED`. |
| 1.7 | MEDIUM | The fast path skipped the runner's Claude config validation. | It reuses `executionConfig`. |
| 1.8 to 1.10 | LOW | Inconsistent status list, missing-origin crash, Windows `.cmd` shims | Fixed |
| 2.1 | MEDIUM | Uncommitted changes, including protected test files, entered the baseline unchecked. | `BLOCKED DIRTY` unless `allowDirty` (test added) |
| 2.2 | MEDIUM | `error` commit status was not a failure. | Mapped to `FAIL` (test added) |
| 2.3 | MEDIUM | `maxAttempts` was not enforced. | `ATTEMPTS_EXHAUSTED` (test added) |
| 2.4 | MEDIUM | Skill preamble rules moved into step 0, and "never commit" was over-scoped. | Restored and scoped to the fast path |
| 2.5 | MEDIUM | No coordination with concurrent ladder runs | `begin` returns `BLOCKED ACTIVE_RUN` while any live lock exists (test added). `check` still rejects foreign scope changes and snapshot drift. |
| 2.6 | MEDIUM | zh-TW doc pairs were not updated. | Updated |
| 2.7, 2.9 | LOW | Handoff probed both CLIs and ignored `*_BINARY`. `deliveryGate` was unreachable from the CLI. | Fixed. `ci --local <status>` added. |
| 2.8 | LOW | Duplicate npm dependency check | The dead post-run branch was removed. |
| 2.10 | LOW | `telemetry.mjs` `measure` repeats the `usageEvidence` summing rule. | **Open.** The copy reports a no-call stage as 0 where `usageEvidence` reports `UNKNOWN`. A shared helper would change v2 output. |
| — | LOW | A lock created after `begin` is not detected until `check` sees its changes. | **Open.** It is documented. Overlapping edits fail `check`. |

## 5. Tests

| Check | Platform | Result |
| --- | --- | --- |
| `node --test tests/unit/*.test.mjs` (CI command): unit, CLI, workflow, contract, risk policy, verification, telemetry and security regressions | Windows | **468 pass, 0 fail** |
| Related suites: `native-first`, `task-contract`, `claude-forecast`, `finish`, `codex`, `scripts`, `flow` | Linux (WSL2, `process.platform` `linux`) | **222 pass, 0 fail** |
| `tests/unit/native-first.test.mjs` | Windows | 9 pass |
| `node --check` on every `scripts`, `hooks`, `hooks/band`, `tests/unit` and `tests/e2e` module | Windows | Pass |
| Doctor: `node .agents/skills/verify/verify.mjs doctor` | Windows | Exit 0, 6 PASS |
| `git diff --check` | — | Pass |
| `node scripts/telemetry.mjs` on real history | Windows | 81 runs, 86 router calls, 53 reviewer calls |
| `node scripts/ci-evidence.mjs ci --ref main --branch main --local VERIFIED` (live GitHub API, unauthenticated) | Windows | CI `PASS` (7 checks). Required checks `UNKNOWN` (HTTP 401). Gate `READY`. |
| `node scripts/ci-evidence.mjs cloud` | Windows | Codex `AVAILABLE_EXPERIMENTAL`, Claude `AVAILABLE`, authentication `UNVERIFIED` |

The new tests cover the requested cases:

- The fast path launches no router, worker or reviewer. A sentinel binary is never created.
- A low-risk task gets no reviewer.
- A failed check is not delivered.
- A snapshot mismatch is `CONFLICT`.
- Retry and reviewer tokens are summed.
- Missing tokens stay `UNKNOWN`.
- A secret in task text or a message is absent from records.
- An unavailable cloud CLI returns `UNAVAILABLE`.
- Failing, pending or unreadable CI is never delivery-ready.

## 6. Not verified

- **UNVERIFIED:** a live Claude Code or Codex session following the new skill step 0. Only the script behavior is tested.
- **UNVERIFIED at review time:** remote GitHub Actions on these changes, including macOS and Node 20. Both plugin manifests were then set to `1.3.0` for release.
- **UNVERIFIED:** cloud sign-in, `codex cloud exec`, `claude --cloud`, cloud PR creation and status tracking. These are outward-facing and need the person's sign-in.
- **UNVERIFIED:** branch protection required checks. The API needs an authorized token, and this report contains none.
- **UNVERIFIED:** WSL2 full suite. Linux ran the 7 related files only.

## 7. Model calls

| Path | Router | Worker | Reviewer | Diagnosis |
| --- | --- | --- | --- | --- |
| Legacy ladder (still the fallback) | 1 | 1 or more | 1 or more | 1 per retry |
| Local Fast Path | 0 | 0 extra (the session itself) | 0 | 0 |

No change adds a model call. `telemetry.mjs` and `ci-evidence.mjs` make none. On this repository's history, the fast path would have removed up to 86 router calls and 53 reviewer calls for the subset of tasks that are eligible. That subset was not measured.

## 8. Final delivery gate

| Condition | State |
| --- | --- |
| All required local tests pass | Yes |
| No open CRITICAL or HIGH | Yes |
| No known security regression | Yes. Sandbox requirement, protected paths, scope and snapshot checks are kept or extended. |
| Legacy compatibility | Yes, on local tests |
| Changes within allowed scope | Yes. No frozen benchmark, push, merge or deploy. |
| Review recorded | Yes, this report |
| Remote CI and live session | Not run |

The result is **REVIEW_REQUIRED**. Before delivery, the person needs to bump the plugin version, push a branch, let GitHub Actions run, and try one live fast-path task.
