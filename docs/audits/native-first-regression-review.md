# Native-first regression review

**Verdict: REVIEW_REQUIRED.** Date: 2026-11-19. The review of the Local Fast Path, passive telemetry and CI evidence change found no open CRITICAL or HIGH issue. This file keeps only what is still open, and the verdict stays `REVIEW_REQUIRED` until these items are closed.

## Open findings

| ID | Severity | Finding |
| --- | --- | --- |
| 2.10 | LOW | `scripts/telemetry.mjs` `measure` repeats the `usageEvidence` summing rule. The copy reports a no-call stage as `0` where `usageEvidence` reports `UNKNOWN`. A shared helper would change v2 output. |
| — | LOW | A lock created after `fast-path.mjs begin` is not detected until `check` sees its changes. `begin` only checks active locks once. Overlapping edits still fail `check`. |

## Not verified

- **UNVERIFIED:** a live Claude Code or Codex session following skill step 0 (the fast path). Only the script behavior is tested.
- **UNVERIFIED:** cloud sign-in, `codex cloud exec`, `claude --cloud`, cloud PR creation and status tracking. These are outward-facing and need the person's sign-in.
- **UNVERIFIED:** branch protection required checks. The GitHub API needs an authorized token, so `scripts/ci-evidence.mjs` reports them as `UNKNOWN`.
