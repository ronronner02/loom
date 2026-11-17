---
kind: as-built
title: Living Notes — Review Ledgers
status: active
topics: [observability, knowledge-and-context]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need the review record a task's rounds are folded from, or which findings
  block a round.
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Living Notes — Review Ledgers

Source snapshot: this page describes the surface that remains after the living-notes
composers were deleted; it does not establish the version or behavior of a running daemon.

The composed review payload — a mission brief built from scope documents, proof artifacts,
judgments, frozen slice exports and fleet views — had no route, no CLI verb and no UI caller.
Its entry point (`ReviewGatherer` and the `review/` composers) had no production importer, so
the document composers, the proof judgment reader, the `scope/` helpers and `markdown-address`
were deleted.

What remains is the review *ledger*, which is live:

| File / symbol | Responsibility |
|---|---|
| [`domain/review-evidence.ts`](../../../packages/daemon/src/domain/review-evidence.ts) | The review record: issuer, rounds, findings and the two delivery decisions. |
| [`domain/review-loop.ts`](../../../packages/daemon/src/domain/review-loop.ts) | The pure rules: which findings block a round, and when a task is deliverable. |

A review round is admitted and closed through the governance owner: `admitForLaunch` issues
the candidate, `recordReviewEvidence` records the reviewer's findings, and the acceptance or
rework it produces moves the task. The read model folds the result for the owner (`team_read`).

The documents a planning run writes — `docs/plans`, `docs/requirements`, `docs/solutions` on
the run's plan branch — are still read directly by the workspace routes; the daemon does not
compose them into a brief any more.

## See also

- [daemon-core.md](daemon-core.md) — the composition root and the route tree.
- [mission-control.md](mission-control.md) — queue and run observability.
