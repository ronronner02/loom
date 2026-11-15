# Durable attempt finalization

Owner decision: 2026-11-15.

## Decision

Keep outcome, integration and conversation recovery together in the F1 repair. Extend the existing SQLite persistence with internal attempt-finalization checkpoints and immutable integration intents. Do not change HTTP endpoints, worker reports or approval contracts.

A confirmed process stop and enrollment for finalization commit in one transaction. A stop is an observation, not proof that downstream effects finished. Pending finalizations survive restarts and prevent replacement launches, follow-up promotion and delivery for the affected run until their existing owners finish. Historical and manually stopped attempts are not backfilled.

## Ownership and recovery

- Existing governance receipts remain authoritative for task outcomes, review verdicts, retry accounting and continuation. Recovery reads those receipts before rebuilding requests with newer entity versions or reading changed candidate files.
- Each conversation owner acknowledges its own completion. Multi-message updates are atomic; a committed reply does not skip an unfinished continuation.
- Integration freezes its repository, branch, parent, intended tree and exact message before changing the live worktree. Recovery finds that first-parent commit even after later commits. Ordinary Git command failures remain retryable; a verified tree, message or history mismatch requires repair without reapplying the candidate.
- Telemetry is durable before seat release. Already captured telemetry is reused. Failed finalization retains its checkpoint, and successful replay leaves newer seat occupants untouched.
- Boot reconciliation precedes polling. Once polling starts, a transient sweep failure is logged and retried rather than disabling completion processing.

This extends existing domain owners rather than introducing a second scheduler or a new public recovery protocol. Hardened isolation and live-provider acceptance remain outside this repair.
