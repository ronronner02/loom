// GHOST-STAGE (e) — the CANONICAL OccupantInvalidator seam. The INTERFACE is the contract the cutover
// slice (SeatHandoverService.commit()) calls to invalidate a RETIRING occupant's seat-name-keyed
// state, so a successor — which under a cutover RESUMES INTO THE SAME PANE and REUSES the canonical
// seat name (retiringSessionName === successorSessionName) — never inherits it. dev-driver's cutover
// file imports THIS definition (one shape, no twin).
//
// Two invalidation classes (see the (e) enumeration/contract artifact):
//   Class-A (in-mem compaction maps): hard-delete by name.
//     Safe by TIMING — invoked INSIDE commit() BEFORE the successor accumulates any name-keyed state,
//     so a name-scoped delete clears exactly the retiree's entries. (The name does NOT isolate the
//     retiree from the successor — they share it — the timing does.)
//   Class-B (durable queue_items, seat-ROLE-bearing): a name-scoped drop would
//     NEUTRALIZE THE SUCCESSOR'S OWN legitimate role items, so it MUST gen-scope. That requires the
//     occupant-generation identity (atom-B). Until `retiringGeneration` is supplied, Class-B is a LOUD
//     no-op — NEVER a name-scoped drop.

export interface OccupantInvalidator {
  invalidateRetiringOccupant(args: {
    retiringSessionName: string;
    successorSessionName: string;
    retiringGeneration?: string;
  }): void;
}

/** Deps the default invalidator composes — structural so tests inject fakes. */
export interface OccupantInvalidatorDeps {
  enforcer: { invalidateOccupant(sessionName: string): void };
  /** Durable queue_items store — in-progress items claimed by the retiring generation are
   *  RELEASED to pending (never dropped: the role work is durable, the successor re-claims). Optional. */
  queue?: { releaseClaimsByGeneration(generationUuid: string): number };
  log?: (msg: string) => void;
}

export class DefaultOccupantInvalidator implements OccupantInvalidator {
  constructor(private readonly deps: OccupantInvalidatorDeps) {}

  invalidateRetiringOccupant(args: {
    retiringSessionName: string;
    successorSessionName: string;
    retiringGeneration?: string;
  }): void {
    const { retiringSessionName, retiringGeneration } = args;
    const log = this.deps.log ?? (() => {});

    // Class-A — hard-delete by name (safe by TIMING; runs at commit() before the successor writes).
    this.deps.enforcer.invalidateOccupant(retiringSessionName);

    // Class-B — gen-scoped ONLY. Never name-scope (a shared name can't discriminate retiree from
    // successor; a name-scoped drop would neutralize the successor's own live role items).
    if (retiringGeneration === undefined) {
      log(
        `[occupant-invalidator] Class-B (queue_items) invalidation for "${retiringSessionName}" ` +
          `PENDING atom-B: no occupant-generation supplied, so NOT name-scoping (that would neutralize the ` +
          `successor's own legitimate role items). No-op until the generation identity lands.`,
      );
      return;
    }
    // Queue_items: RELEASE (never drop) every in-progress item CLAIMED by the retiring generation
    // back to pending — the role work is durable and the successor re-claims it; only the retiree's
    // stale claim is the ghost. Gen-scoped via the claimant generation (the successor's own claims,
    // under the reused name but its live gen, are untouched).
    const released = this.deps.queue?.releaseClaimsByGeneration(retiringGeneration) ?? 0;
    if (released > 0) {
      log(
        `[occupant-invalidator] Class-B: released ${released} in-progress queue item(s) claimed by retired ` +
          `generation ${retiringGeneration} (seat "${retiringSessionName}") back to pending — successor re-claims.`,
      );
    }
  }
}
