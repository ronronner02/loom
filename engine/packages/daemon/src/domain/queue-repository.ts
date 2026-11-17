import { assertDirectQueueWriteAllowed, assertGovernedQueueWrite, isGovernedDatabase } from "./plan-governance.js";
import { TEAM_QUEUE_STATES as QUEUE_STATES } from "../contracts/team-control.js";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { loadHumanRegistry, type LoadResult } from "./queue-routing/human-registry.js";
import type { PersistedEvent } from "./types.js";
import { QueueTransitionLog, type OwnerNotificationLevel, type QueueTransition } from "./queue-transition-log.js";
import { parseSessionName } from "./session-name.js";
import { validateClosure, type ClosureReason } from "./hot-potato-enforcer.js";
import { isHumanSeatSession, validateHumanPark, validateHumanRoute } from "./human-route-enforcer.js";

export { QUEUE_STATES };
export type QueueState = (typeof QUEUE_STATES)[number];

/** The queue's terminal state set, named once so the closure guards and the
 *  workflow's handoff exits read one list. */
export const TERMINAL_QUEUE_STATES = ["done", "handed-off"] as const satisfies readonly QueueState[];
export function isTerminalState(state: string): boolean {
  return (TERMINAL_QUEUE_STATES as readonly string[]).includes(state);
}

/** The ACTIVE (still-progressing) states. A blocker is live iff active; any
 *  other state means the block will never lift. */
export const ACTIVE_QUEUE_STATES = ["pending", "in-progress", "blocked"] as const satisfies readonly QueueState[];
export function isBlockerLive(state: string): boolean {
  return (ACTIVE_QUEUE_STATES as readonly string[]).includes(state);
}

/** Typed non-qitem gate blocker prefixes. A park may be gated on a fold / auth / external
 *  condition that is not a qitem and not a human seat; the prefix makes it a first-class,
 *  legible blocker. */
export const TYPED_GATE_BLOCKER_PREFIXES = ["fold:", "auth:", "external:"] as const;
export function typedGateBlockerPrefix(value: string): string | null {
  return TYPED_GATE_BLOCKER_PREFIXES.find((prefix) => value.startsWith(prefix)) ?? null;
}
/** A well-formed typed gate blocker: a recognized prefix AND a non-empty gate body. */
export function isTypedGateBlocker(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const prefix = typedGateBlockerPrefix(value);
  return prefix != null && value.slice(prefix.length).trim().length > 0;
}

export const QUEUE_PRIORITIES = ["routine", "urgent", "critical"] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export interface QueueItem {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: QueueState;
  priority: QueuePriority;
  tier: string | null;
  tags: string[] | null;
  blockedOn: string | null;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  expiresAt: string | null;
  chainOfRecord: string[] | null;
  body: string;
  /** Explicit human delivery intent; null/omitted preserves legacy decisions. */
  humanIntent?: "decision" | "update" | null;
  /** One authored supplemental thread reply; the body remains a complete brief. */
  humanDetail?: string | null;
  /** The earlier qitem whose thread this update posts into; null = own root. */
  replyTo?: string | null;
  /** Short human-readable subject; null for callers that omit it. */
  summary: string | null;
  /** Pointer to the durable artifact a human judges. NULL for non-human-routed items;
   *  required at the domain write path only when the item is human-routed. */
  evidenceRef: string | null;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
  closureRequiredAt: string | null;
  claimedAt: string | null;
  lastNudgeAttempt: string | null;
  /** #165: the wake result as presented. A claimed row whose wire result was never
   *  confirmed (`delivered-ack-pending`, `indeterminate:*`) reads `claimed`; see
   *  `lastNudgeWireResult` for the result as recorded. */
  lastNudgeResult: string | null;
  /** #165: the wake send's result exactly as recorded, never rewritten by a claim. */
  lastNudgeWireResult: string | null;
  lastHeartbeat: string | null;
  resolution: string | null;
  /** Typed repo scope for the qitem, validated by the route layer against the
   *  source rig's declared repos. Null when the task is the rig's default repo. */
  targetRepo: string | null;
}

interface QueueItemRow {
  qitem_id: string;
  ts_created: string;
  ts_updated: string;
  source_session: string;
  destination_session: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string | null;
  blocked_on: string | null;
  handed_off_to: string | null;
  handed_off_from: string | null;
  expires_at: string | null;
  chain_of_record: string | null;
  body: string;
  human_intent?: "decision" | "update" | null;
  human_detail?: string | null;
  reply_to?: string | null;
  summary: string | null;
  evidence_ref: string | null;
  closure_reason: string | null;
  closure_target: string | null;
  closure_required_at: string | null;
  claimed_at: string | null;
  last_nudge_attempt: string | null;
  last_nudge_result: string | null;
  last_heartbeat: string | null;
  resolution: string | null;
  target_repo: string | null;
}

export interface QueueCreateInput {
  qitemId?: string;
  sourceSession: string;
  destinationSession: string;
  body: string;
  priority?: QueuePriority;
  tier?: string;
  tags?: string[];
  expiresAt?: string;
  chainOfRecord?: string[];
  /** Supersession back-link: the row this one replaced, so the pair is traversable. */
  handedOffFrom?: string | null;
  /** Typed repo scope for this qitem, validated against the source rig's declared repos. */
  targetRepo?: string | null;
  /** Explicit human delivery intent; omission preserves legacy decisions. */
  humanIntent?: "decision" | "update" | null;
  /** Explicit supplemental thread content, never an automatic split of the primary body. */
  humanDetail?: string | null;
  /** Post this update into the named earlier qitem's thread. Updates only. */
  replyTo?: string | null;
  /** The item whose thread a person's reply was typed in. Stored as this row's replyTo. */
  inboundReplyTo?: string | null;
  summary?: string | null;
  /** Optional durable-artifact pointer. Required at the domain layer only for human-routed items. */
  evidenceRef?: string | null;
  /** Accepted for the workflow callers' shape; nothing stages a wake any more. */
  nudge?: boolean;
  /** How actorSession was established; absence = claimed-era. */
  identityProvenance?: string | null;
}

export interface QueueUpdateInput {
  qitemId: string;
  actorSession: string;
  state?: QueueState;
  /** Explicit acknowledgment for a deliberate terminal → active repair. */
  reopen?: boolean;
  transitionNote?: string;
  closureReason?: string;
  closureTarget?: string;
  /** Persists the queue_items.handed_off_to column for a handed-off transition. */
  handedOffTo?: string;
  /** Persists the queue_items.blocked_on column for a blocked transition. */
  blockedOn?: string;
  /** Park-time inputs. summary + evidence_ref are updatable AT THE PARK MOMENT
   *  (state=blocked with a human-seat blocker), not create-only; supplying them on
   *  a non-park transition is rejected before any mutation. */
  summary?: string | null;
  evidenceRef?: string | null;
  /** How actorSession was established; absence = claimed-era. */
  identityProvenance?: string | null;
  /** System-owned ceremony kind. Never exposed as a free-form route field. */
  ownerNotificationKind?: "human-decision-resolved";
}

export interface QueueListOptions {
  /** Exact tag selection before the result bound (used by diagnostic occurrences). */
  tag?: string;
  destinationSession?: string;
  sourceSession?: string;
  state?: QueueState | QueueState[];
  /** Filter qitems by target_repo. Exact match. */
  targetRepo?: string;
  limit?: number;
  asSession?: string;
  compact?: boolean;
  /** End-anchored rig suffix: matches a source or destination on that rig. */
  rig?: string;
  activeOnly?: boolean;
}

export class QueueRepositoryError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

/** Exported so the workflow domain can PREALLOCATE a gate packet's id. The queue
 *  still mints ids for every caller that does not preallocate. */
export function newQitemId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `qitem-${ts}-${hex}`;
}

/**
 * Is this the SQLite PRIMARY KEY conflict on queue_items.qitem_id? better-sqlite3
 * sets `.code` on its SqliteError; the message check is a defensive twin so a
 * driver-name change never silently turns an idempotent absorb into a 500.
 */
export function isQitemPrimaryKeyConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code ?? "";
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return /UNIQUE constraint failed: queue_items\.qitem_id/.test(err.message);
}

/** Defensive column probe. Older test fixtures bypass the canonical migration list. */
function detectQueueColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db.prepare("PRAGMA table_info(queue_items)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
}

function detectTable(db: Database.Database, tableName: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  } catch {
    return false;
  }
}

/**
 * The refusal teaching for a rejected destination whose rig token contains '@': the
 * greedy parse folded a host suffix into the rig name, so the destination is not a
 * local address. Names the out-of-band `--host` path and never auto-strips a self
 * suffix. Undefined for a well-formed two-part address (that refusal is unchanged).
 */
export function destinationRigTeaching(session: string): Record<string, unknown> | undefined {
  const parsed = parseSessionName(session);
  if (parsed.kind !== "canonical" || !parsed.rig.includes("@")) return undefined;
  const at = parsed.rig.lastIndexOf("@");
  const rig = parsed.rig.slice(0, at);
  const host = parsed.rig.slice(at + 1);
  const bare = `${parsed.member}@${rig}`;
  return {
    destinationSplit: { member: parsed.member, rig, host },
    hint: `host does not ride in the session string; use --host ${host} with destination ${bare}`,
  };
}

function destinationValidationError(
  field: "destination_session" | "to_session",
  session: string,
  loadRegistry: () => LoadResult,
): QueueRepositoryError {
  const teaching = destinationRigTeaching(session);
  if (teaching?.registryLoadError === true) {
    return new QueueRepositoryError(
      "human_registry_unavailable",
      `${field} ${session} cannot be admitted because the human registry failed to load: ${String(teaching.registryError)}`,
      teaching,
    );
  }
  return new QueueRepositoryError(
    "unknown_destination_rig",
    `${field} ${session} references an unknown rig`,
    teaching,
  );
}

export interface QueueDestinationAdvisory {
  code: "unmatched_destination_seat";
  destinationSession: string;
  availableDestinations: string[];
  message: string;
}

export class QueueRepository {
  readonly db: Database.Database;
  readonly transitionLog: QueueTransitionLog;
  private readonly eventBus: EventBus;
  readonly destinationAdvisory: (sessionRef: string) => QueueDestinationAdvisory | null;
  private readonly validateRig: (sessionRef: string) => boolean;
  private resolveOccupantGeneration?: (sessionName: string) => string | null;
  private readonly loadHumanRegistryFn: () => LoadResult;
  /** True when migration 038 has applied the queue_items.target_repo column. Older test
   *  fixtures that bypass the canonical migration list don't have it, and INSERTs degrade
   *  to the pre-038 statement. Production daemons always have the column. */
  private readonly hasTargetRepoColumn: boolean;
  private readonly hasSummaryColumn: boolean;
  private readonly hasHumanIntentColumn: boolean;
  private readonly hasReplyToColumn: boolean;
  private readonly hasEvidenceRefColumn: boolean;
  private readonly hasMintingGenColumn: boolean;
  private readonly hasClaimedGenColumn: boolean;
  private readonly hasQueueTransitionsTable: boolean;
  private readonly hasTransitionProvenanceColumn: boolean;
  private readonly hasOwnerNotificationColumns: boolean;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    opts?: {
      validateRig?: (sessionRef: string) => boolean;
      destinationAdvisory?: (sessionRef: string) => QueueDestinationAdvisory | null;
      /**
       * Resolve the SOURCE seat's occupant generation so a created row carries the
       * composing generation. The queue never imports the session domain; startup
       * wires SessionRegistry in. Absent ⇒ UNKNOWN ⇒ the stamp is omitted (never forged).
       */
      resolveOccupantGeneration?: (sessionName: string) => string | null;
      loadHumanRegistry?: () => LoadResult;
    }
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.transitionLog = new QueueTransitionLog(db);
    this.validateRig = opts?.validateRig ?? (() => true);
    this.destinationAdvisory = opts?.destinationAdvisory ?? (() => null);
    this.resolveOccupantGeneration = opts?.resolveOccupantGeneration;
    this.loadHumanRegistryFn = opts?.loadHumanRegistry ?? (() => loadHumanRegistry());
    this.hasTargetRepoColumn = detectQueueColumn(db, "target_repo");
    this.hasSummaryColumn = detectQueueColumn(db, "summary");
    this.hasHumanIntentColumn = detectQueueColumn(db, "human_intent");
    this.hasReplyToColumn = detectQueueColumn(db, "reply_to");
    this.hasEvidenceRefColumn = detectQueueColumn(db, "evidence_ref");
    this.hasQueueTransitionsTable = detectTable(db, "queue_transitions");
    const transitionColumns = this.hasQueueTransitionsTable
      ? new Set((db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((column) => column.name))
      : new Set<string>();
    this.hasTransitionProvenanceColumn = transitionColumns.has("identity_provenance");
    this.hasOwnerNotificationColumns = transitionColumns.has("owner_notification_kind")
      && transitionColumns.has("owner_notification_level");
    this.hasMintingGenColumn = detectQueueColumn(db, "minting_generation_uuid");
    this.hasClaimedGenColumn = detectQueueColumn(db, "claimed_by_generation_uuid");

    // Register the EXACT human-seat regex predicate as a SQLite function so the
    // attention query applies the strict check BEFORE LIMIT. better-sqlite3's
    // db.function is idempotent; safe to call once at construction.
    db.function("is_human_seat_session", { deterministic: true }, (value: unknown) =>
      typeof value === "string" && isHumanSeatSession(value) ? 1 : 0
    );
  }

  /** The one transition-write classifier. It consumes structured state/action facts only. */
  private classifyOwnerNotification(input: {
    action: "create" | "update";
    destinationSession: string;
    previousState?: QueueState;
    previousBlockedOn?: string | null;
    nextState: QueueState;
    nextBlockedOn?: string | null;
    explicitKind?: QueueUpdateInput["ownerNotificationKind"];
    humanIntent?: "decision" | "update" | null;
  }): { kind: string; level: OwnerNotificationLevel } | null {
    if (input.explicitKind === "human-decision-resolved") {
      return { kind: input.explicitKind, level: "NOTICE" };
    }
    void input;
    return null;
  }

  async create(input: QueueCreateInput): Promise<QueueItem & {
    /** Response-only: the retry's changed body was not written. Never stored on the row. */
    createWarning?: { code: "qitem_body_not_saved"; message: string };
  }> {
    // A LOCAL write stores the bare transport identity — no self-host suffix inside one
    // instance. Host identity is added only at the cross-host forwarding boundary.
    if (!this.validateRig(input.destinationSession)) {
      throw destinationValidationError("destination_session", input.destinationSession, this.loadHumanRegistryFn);
    }

    const txn = this.db.transaction(() => this.createInTransactionalContext(input));
    let id: string;
    let persistedEvent: PersistedEvent;
    try {
      ({ qitemId: id, persistedEvent } = txn());
    } catch (err) {
      // At-least-once cross-host forwards retry with the SAME minted qitemId, so a PK
      // conflict on an EXISTING row is an idempotent RE-DELIVERY when the identity
      // fields match — return the stored row (no second insert, no second event).
      if (input.qitemId && isQitemPrimaryKeyConflict(err)) {
        const existing = this.getById(input.qitemId);
        if (existing) {
          if (
            existing.destinationSession === input.destinationSession &&
            existing.sourceSession === input.sourceSession
          ) {
            if (existing.body !== input.body) {
              return {
                ...existing,
                createWarning: {
                  code: "qitem_body_not_saved",
                  message: `qitem ${input.qitemId} already exists with a different body. The supplied body was not saved; the existing row is returned unchanged. No new work or delivery was created.`,
                },
              };
            }
            return existing;
          }
          throw new QueueRepositoryError(
            "qitem_id_reuse",
            `qitem ${input.qitemId} already exists with a different destination/source — id reuse is a caller bug, not an idempotent retry`,
            {
              qitemId: input.qitemId,
              existingDestination: existing.destinationSession,
              existingSource: existing.sourceSession,
            },
          );
        }
      }
      throw err;
    }
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(id);
  }

  /** Creates a queue item inside the CALLER's transaction so a close and its successor
   *  commit as one act. The caller owns notifying subscribers after its transaction commits. */
  createWithinTransaction(input: QueueCreateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
    destinationSession: string;
    nudge: boolean | undefined;
  } {
    if (!this.validateRig(input.destinationSession)) {
      throw destinationValidationError("destination_session", input.destinationSession, this.loadHumanRegistryFn);
    }
    const result = this.createInTransactionalContext(input);
    return {
      qitemId: result.qitemId,
      persistedEvent: result.persistedEvent,
      destinationSession: input.destinationSession,
      nudge: input.nudge,
    };
  }

  /** Internal: insert + transition + emit event. The caller supplies the transaction. */
  private createInTransactionalContext(input: QueueCreateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
  } {
    // Only a managed-control grant may create queue items.
    assertGovernedQueueWrite(this.db, "create");
    // Human-routed items require summary + evidence_ref at the domain write path.
    const humanRoute = validateHumanRoute({
      tier: input.tier ?? null,
      destinationSession: input.destinationSession,
      summary: input.summary ?? null,
      evidenceRef: input.evidenceRef ?? null,
    });
    if (!humanRoute.ok) {
      throw new QueueRepositoryError(humanRoute.code, humanRoute.message, {
        missingFields: humanRoute.missingFields,
      });
    }
    if (input.humanIntent != null && input.humanIntent !== "decision" && input.humanIntent !== "update") {
      throw new QueueRepositoryError("invalid_human_notification", "humanIntent must be decision or update; omission retains legacy decision behavior.");
    }
    if (input.humanDetail != null && (typeof input.humanDetail !== "string" || !input.humanDetail.trim())) {
      throw new QueueRepositoryError("invalid_human_notification", "humanDetail must be nonempty supplemental text or omitted.");
    }
    if (input.humanIntent != null || input.humanDetail != null) {
      if (!isHumanSeatSession(input.destinationSession)) {
        throw new QueueRepositoryError("invalid_human_notification", "humanIntent/humanDetail require a human destination; agent continuation belongs in its own qitem.");
      }
      if (!this.hasHumanIntentColumn) throw new QueueRepositoryError("invalid_human_notification", "Human notification fields require the current queue schema; they were not saved.");
    }
    if (input.replyTo != null) this.validateReplyTo(input.replyTo, input.humanIntent);
    const id = input.qitemId ?? newQitemId();
    const ts = new Date().toISOString();
    const priority = input.priority ?? "routine";
    const tier = input.tier ?? null;
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const chain = input.chainOfRecord ? JSON.stringify(input.chainOfRecord) : null;
    const expiresAt = input.expiresAt ?? null;
    const targetRepo = input.targetRepo ?? null;
    const handedOffFrom = input.handedOffFrom ?? null;

    if (this.hasTargetRepoColumn) {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, handed_off_from, body, target_repo
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, handedOffFrom, input.body, targetRepo);
    } else {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, handed_off_from, body
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, handedOffFrom, input.body);
    }
    this.persistSummary(id, input.summary ?? null);
    this.persistEvidenceRef(id, input.evidenceRef ?? null);
    if (this.hasHumanIntentColumn) {
      this.db.prepare("UPDATE queue_items SET human_intent = ?, human_detail = ? WHERE qitem_id = ?")
        .run(input.humanIntent ?? null, input.humanDetail ?? null, id);
    }
    const replyTo = input.replyTo
      ?? (input.inboundReplyTo != null && this.hasReplyToColumn && this.getById(input.inboundReplyTo) ? input.inboundReplyTo : null);
    if (replyTo != null) {
      this.db.prepare("UPDATE queue_items SET reply_to = ? WHERE qitem_id = ?").run(replyTo, id);
    }
    this.persistMintingGeneration(id, input.sourceSession);
    const notification = this.classifyOwnerNotification({
      action: "create",
      humanIntent: input.humanIntent,
      destinationSession: input.destinationSession,
      nextState: "pending",
    });
    this.transitionLog.append({
      qitemId: id,
      state: "pending",
      actorSession: input.sourceSession,
      transitionNote: "created",
      identityProvenance: input.identityProvenance ?? null,
      ownerNotificationKind: notification?.kind,
      ownerNotificationLevel: notification?.level,
    });
    const persistedEvent = this.eventBus.persistWithinTransaction({
      type: "queue.created",
      qitemId: id,
      sourceSession: input.sourceSession,
      destinationSession: input.destinationSession,
      priority,
      tier,
      summary: input.summary ?? null,
    });
    return { qitemId: id, persistedEvent };
  }

  private validateReplyTo(replyTo: string, humanIntent: QueueCreateInput["humanIntent"]): void {
    if (humanIntent !== "update") {
      throw new QueueRepositoryError("reply_to_requires_update", "replyTo is accepted only with humanIntent update; a decision keeps its own thread so its reply stays unambiguous.");
    }
    if (!this.hasReplyToColumn) throw new QueueRepositoryError("invalid_human_notification", "replyTo requires the current queue schema; it was not saved.");
    if (!this.getById(replyTo)) throw new QueueRepositoryError("reply_to_not_found", `replyTo names no qitem on this host: ${replyTo}.`);
  }

  /** General state mutator. Validates closure, writes the state, appends the transition and
   *  emits `queue.updated` atomically with the UPDATE. */
  update(input: QueueUpdateInput): QueueItem {
    const txn = this.db.transaction(() => this.updateInTransactionalContext(input));
    const result = txn();
    for (const event of result.persistedEvents) this.eventBus.notifySubscribers(event);
    return this.getByIdOrThrow(input.qitemId);
  }

  /** Same closure validation + UPDATE + transition log + `queue.updated` event as update(),
   *  inside the CALLER's transaction so it composes with a close+successor writer.
   *  The caller notifies subscribers after its own transaction commits. */
  updateWithinTransaction(input: QueueUpdateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
    persistedEvents: PersistedEvent[];
  } {
    const result = this.updateInTransactionalContext(input);
    return { qitemId: input.qitemId, ...result };
  }

  /** Internal read-only audit pointer for non-state receipts. Never searches past a state write. */
  retainedClaimBlocker(qitemId: string): string | undefined {
    const latest = this.transitionLog.listForQitem(qitemId).at(-1);
    return latest?.state === "in-progress" && latest.closureReason === null
      ? latest.closureTarget ?? undefined
      : undefined;
  }

  private updateInTransactionalContext(input: QueueUpdateInput): {
    persistedEvent: PersistedEvent;
    persistedEvents: PersistedEvent[];
  } {
    // Only a managed-control grant may update queue items.
    assertGovernedQueueWrite(this.db, "update", input.qitemId);
    const qitem = this.getById(input.qitemId);
    if (!qitem) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`
      );
    }
    const hasNote = typeof input.transitionNote === "string" && input.transitionNote.trim().length > 0;
    const isGuardedTerminal = (["done", "canceled", "handed-off"] as const).includes(
      qitem.state as "done" | "canceled" | "handed-off",
    );
    const isStatePreservingAppend = input.state === undefined || (isGuardedTerminal && input.state === qitem.state);

    if (isStatePreservingAppend) {
      if (input.state === undefined && !hasNote) {
        throw new QueueRepositoryError(
          "state_or_note_required",
          "queue update requires --state or a non-empty --note; nothing was written",
        );
      }
      const disallowed = input.reopen === true
        || input.closureReason != null
        || input.closureTarget != null
        || input.handedOffTo != null
        || input.blockedOn != null
        || input.summary != null
        || input.evidenceRef != null;
      if (disallowed) {
        throw new QueueRepositoryError(
          "note_append_fields_not_admitted",
          "a state-preserving note append accepts only --note (and an optional same --state); state-write fields were supplied, so nothing was written",
        );
      }

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: qitem.state,
        actorSession: input.actorSession,
        transitionNote: input.transitionNote,
        // A note-only append does not clear the claim's retained park gate.
        // Carry its audit pointer so a later state write can end this chain.
        closureTarget: qitem.state === "in-progress" ? this.retainedClaimBlocker(input.qitemId) : undefined,
        identityProvenance: input.identityProvenance ?? null,
      });
      const persistedEvent = this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId: input.qitemId,
        fromState: qitem.state,
        toState: qitem.state,
        closureReason: null,
        closureTarget: null,
        actorSession: input.actorSession,
        summary: qitem.summary ?? null,
      });
      return { persistedEvent, persistedEvents: [persistedEvent] };
    }
    if (!isQueueState(input.state)) {
      throw new QueueRepositoryError(
        "invalid_state",
        `state=${input.state} not valid; valid: ${QUEUE_STATES.join(", ")}`
      );
    }

    const isReopen = isGuardedTerminal && input.state !== qitem.state;
    if (isReopen && !input.reopen) {
      throw new QueueRepositoryError(
        "terminal_reopen_requires_ack",
        `qitem ${input.qitemId} is currently '${qitem.state}'; state='${input.state}' would reopen a terminal row. Re-run deliberately with --reopen --note <reason>.`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (isReopen && !isBlockerLive(input.state)) {
      throw new QueueRepositoryError(
        "terminal_reopen_target_invalid",
        `qitem ${input.qitemId} is currently '${qitem.state}'; --reopen requires an active target state (pending, in-progress, or blocked), not '${input.state}'.`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (isReopen && !hasNote) {
      throw new QueueRepositoryError(
        "reopen_note_required",
        `qitem ${input.qitemId} is currently '${qitem.state}'; deliberate reopen requires --note <reason> so the repair is auditable.`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (input.reopen && !isReopen) {
      throw new QueueRepositoryError(
        "reopen_not_applicable",
        `--reopen applies only when moving a terminal row to an active state; qitem ${input.qitemId} is currently '${qitem.state}'.`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }

    const validation = validateClosure({
      state: input.state,
      closureReason: input.closureReason ?? null,
      closureTarget: input.closureTarget ?? null,
    });
    if (!validation.ok) {
      throw new QueueRepositoryError(validation.code, validation.message, {
        validReasons: "validReasons" in validation ? validation.validReasons : undefined,
      });
    }

    // Leg-1 park (state=blocked on a HUMAN-seat blocker): enforce summary + evidence_ref at
    // the park moment, evaluated on the EFFECTIVE values. Blocking on another qitem requires
    // nothing new. A claimed item re-parked without --blocked-on retains its previous gate.
    const previousClaimBlocker = input.state === "blocked" && qitem.state === "in-progress"
      && input.blockedOn == null && qitem.blockedOn == null
      ? this.retainedClaimBlocker(input.qitemId)
      : null;
    const effectiveBlockedOn = input.blockedOn ?? qitem.blockedOn ?? previousClaimBlocker ?? null;
    if (input.state === "blocked" && effectiveBlockedOn && this.getById(effectiveBlockedOn)?.humanIntent === "update") {
      throw new QueueRepositoryError("invalid_human_notification", "An informational update is not an approval dependency. Create a separate decision request if a human decision is needed.");
    }
    if (qitem.humanIntent === "update" && input.state === "blocked" && isHumanSeatSession(effectiveBlockedOn ?? "")) {
      throw new QueueRepositoryError("invalid_human_notification", "An informational delivery cannot become a human approval park; author a separate decision request.");
    }
    const isHumanPark = input.state === "blocked" && isHumanSeatSession(effectiveBlockedOn);

    // summary/evidence_ref are persist-able ONLY at a human-seat park. Silently ignoring them
    // on any other transition is a data-loss trap, so HARD-REJECT before ANY UPDATE/log/event.
    if (!isHumanPark) {
      const invalidFields: Array<"summary" | "evidenceRef"> = [];
      if (input.summary != null) invalidFields.push("summary");
      if (input.evidenceRef != null) invalidFields.push("evidenceRef");
      if (invalidFields.length > 0) {
        const flags = invalidFields.map((f) => (f === "summary" ? "--summary" : "--evidence-ref")).join(" / ");
        throw new QueueRepositoryError(
          "summary_evidence_not_persistable",
          `${invalidFields.join(" + ")} persist only on a human-seat park (state=blocked on a human seat); the '${input.state}' transition cannot store them. Remove ${flags}, or park the item.`,
          { invalidFields },
        );
      }
    }

    // Closure/blocked-field COHERENCE: an incoherent field must never silently persist
    // (the COALESCE below would write it). Admits-map, derived from LIVE schema use:
    //   closure_reason/closure_target → state "done", OR the PARK-RECORD form
    //     (state "blocked" with closureReason "blocked_on" — the workflow gate/park writers' shape);
    //   blocked_on → state "blocked" only.
    const isParkRecord = input.state === "blocked" && input.closureReason === "blocked_on";
    // The transactional handoff closes its source as state "handed-off" with closureReason "handed_off_to".
    const isHandoffClose = input.state === "handed-off" && input.closureReason === "handed_off_to";
    // The supersession-cancel: state=canceled + closureReason=superseded + closureTarget=<successor>.
    const isSupersedeCancel = input.state === "canceled" && input.closureReason === "superseded";
    if (input.state !== "done" && !isParkRecord && !isHandoffClose && !isSupersedeCancel && (input.closureReason != null || input.closureTarget != null)) {
      throw new QueueRepositoryError(
        "closure_fields_not_admitted",
        `closure_reason/closure_target persist only on state=done, the blocked park-record form, the handoff close, or the superseded cancel; the '${input.state}' transition cannot store them. Close the item (--state done --closure-reason …) or drop the flags.`,
        {},
      );
    }
    // A supersession must name WHAT replaced this row — fail LOUD before any write.
    if (isSupersedeCancel && !input.closureTarget) {
      throw new QueueRepositoryError(
        "missing_closure_target",
        `closure_reason=superseded requires closure_target (the successor qitem that replaced this row).`,
        {},
      );
    }
    if (input.blockedOn != null && input.state !== "blocked") {
      throw new QueueRepositoryError(
        "blocked_on_not_admitted",
        `blocked_on persists only on state=blocked; the '${input.state}' transition cannot store it. Park the item or drop --blocked-on.`,
        {},
      );
    }

    // Blocker validation at the park moment. Non-human blocker kinds:
    //   qitem-ref ("qitem-…")        → must EXIST and be LIVE; a ghost or dead blocker never lifts.
    //   typed gate (fold:/auth:/…)   → first-class, but a bare prefix with no gate body is malformed.
    //   anything else                → left as-is.
    // Human-seat parks enforce their own contract below.
    if (input.state === "blocked" && !isHumanPark && typeof effectiveBlockedOn === "string") {
      if (effectiveBlockedOn.startsWith("qitem-")) {
        const blocker = this.getById(effectiveBlockedOn);
        if (!blocker) {
          throw new QueueRepositoryError(
            "blocker_not_found",
            `blocked_on names a qitem that does not exist on this daemon: ${effectiveBlockedOn}. A qitem absent from this daemon cannot be a live blocker here. If it is stored on another host, use a typed gate such as external:<host>/<id>.`,
            { rejectedBlocker: effectiveBlockedOn },
          );
        }
        if (!isBlockerLive(blocker.state)) {
          throw new QueueRepositoryError(
            "blocker_not_live",
            `blocked_on names a resolved qitem: ${effectiveBlockedOn} is '${blocker.state}'. A park must name a LIVE blocker — parking on a completed/closed row is a dead-blocker park that never self-clears.`,
            { rejectedBlocker: effectiveBlockedOn, blockerState: blocker.state },
          );
        }
      } else {
        const prefix = typedGateBlockerPrefix(effectiveBlockedOn);
        if (prefix && !isTypedGateBlocker(effectiveBlockedOn)) {
          throw new QueueRepositoryError(
            "blocker_malformed",
            `blocked_on '${effectiveBlockedOn}' is a bare '${prefix}' prefix with no gate body. A typed gate blocker must name its gate (e.g. fold:one-home+attestation).`,
            { rejectedBlocker: effectiveBlockedOn },
          );
        }
      }
    }

    let effectiveSummary = qitem.summary;
    let effectiveEvidenceRef = qitem.evidenceRef;
    if (isHumanPark) {
      effectiveSummary = input.summary ?? qitem.summary;
      effectiveEvidenceRef = input.evidenceRef ?? qitem.evidenceRef;
      const park = validateHumanPark({
        blockedOn: effectiveBlockedOn,
        summary: effectiveSummary,
        evidenceRef: effectiveEvidenceRef,
      });
      if (!park.ok) {
        throw new QueueRepositoryError(park.code, park.message, {
          missingFields: park.missingFields,
        });
      }
    }

    const ts = new Date().toISOString();
    const fromState = qitem.state;

    // Clear-on-exit: blocked_on is set EXPLICITLY, not COALESCE'd — a row keeps its blocker
    // ONLY while `state=blocked`, and any exit from blocked CLEARS it to NULL.
    const nextBlockedOn = input.state === "blocked" ? effectiveBlockedOn : null;
    const notification = this.classifyOwnerNotification({
      action: "update",
      destinationSession: qitem.destinationSession,
      previousState: qitem.state,
      previousBlockedOn: qitem.blockedOn,
      nextState: input.state,
      nextBlockedOn,
      explicitKind: input.ownerNotificationKind,
    });

    this.db
      .prepare(
        `UPDATE queue_items
           SET state = ?,
               ts_updated = ?,
               closure_reason = COALESCE(?, closure_reason),
               closure_target = COALESCE(?, closure_target),
               handed_off_to = COALESCE(?, handed_off_to),
               blocked_on = ?
         WHERE qitem_id = ?`
      )
      .run(
        input.state,
        ts,
        validation.closureReason,
        validation.closureTarget,
        input.handedOffTo ?? null,
        nextBlockedOn,
        input.qitemId
      );

    // Park-time summary/evidence_ref are PERSISTED onto the existing item, not merely validated.
    if (isHumanPark) {
      this.persistSummary(input.qitemId, input.summary ?? null);
      this.persistEvidenceRef(input.qitemId, input.evidenceRef ?? null);
    }

    this.transitionLog.append({
      qitemId: input.qitemId,
      state: input.state,
      actorSession: input.actorSession,
      transitionNote: isReopen ? `reopen acknowledged: ${input.transitionNote}` : input.transitionNote,
      closureReason: validation.closureReason ?? undefined,
      closureTarget: validation.closureTarget ?? undefined,
      identityProvenance: input.identityProvenance ?? null,
      ownerNotificationKind: notification?.kind,
      ownerNotificationLevel: notification?.level,
    });

    const persistedEvent = this.eventBus.persistWithinTransaction({
      type: "queue.updated",
      qitemId: input.qitemId,
      fromState,
      toState: input.state,
      closureReason: validation.closureReason ?? null,
      closureTarget: validation.closureTarget ?? null,
      actorSession: input.actorSession,
      summary: effectiveSummary ?? null,
    });
    // A terminal closure releases the rows parked on this one: blocked_on promises that a
    // waiter resumes when its blocker completes, and this is the one place that actuates it.
    const dependentEvents = isBlockerLive(input.state)
      ? []
      : this.propagateBlockerCompletion({
          qitemId: input.qitemId, terminalState: input.state, actorSession: input.actorSession,
          identityProvenance: input.identityProvenance ?? null, ts,
        });
    return { persistedEvent, persistedEvents: [...dependentEvents, persistedEvent] };
  }

  private blockerSatisfiesDependents(qitemId: string, terminalState: string): boolean {
    // A bare repository a harness assembled carries no run authority, and its rows carry no
    // evidence to consult: every terminal ending unparks, as it always has.
    if (!isGovernedDatabase(this.db)) return true;
    if (terminalState !== "done") return false;
    // Only called from updateInTransactionalContext, which runs before the
    // terminal state is written. A row that already reads as terminal is a
    // re-entrant write, so its own done state is the truthful half here and the
    // evidence was persisted by the transition that ended it.
    const authority = this.db.prepare("SELECT evidence_json AS evidenceJson FROM team_queue_authority WHERE qitem_id = ?")
      .get(qitemId) as { evidenceJson: string | null } | undefined;
    // A governed `done` row with no authority record has no evidence to offer,
    // so it satisfies nothing.
    if (!authority) return false;
    if (authority.evidenceJson === null) return false;
    try {
      const evidence: unknown = JSON.parse(authority.evidenceJson);
      return typeof evidence === "object" && evidence !== null && (evidence as { validated?: unknown }).validated === true;
    } catch {
      return false;
    }
  }

  private propagateBlockerCompletion(input: {
    qitemId: string;
    terminalState: string;
    actorSession: string;
    identityProvenance: string | null;
    ts: string;
  }): PersistedEvent[] {
    const dependentEvents: PersistedEvent[] = [];
    const satisfied = this.blockerSatisfiesDependents(input.qitemId, input.terminalState);
    const blockedRows = this.db
      .prepare("SELECT qitem_id, destination_session FROM queue_items WHERE blocked_on = ? AND state = 'blocked'")
      .all(input.qitemId) as Array<{ qitem_id: string; destination_session: string }>;
    for (const r of blockedRows) {
      const closed = this.getById(input.qitemId);
      const successors = input.terminalState === "handed-off" ? this.db.prepare(
        "SELECT qitem_id FROM queue_items WHERE handed_off_from = ? AND destination_session = ?",
      ).all(input.qitemId, closed?.handedOffTo ?? "") as Array<{ qitem_id: string }> : [];
      const successor = successors.length === 1 ? this.getById(successors[0]!.qitem_id) : null;
      if (successor && isBlockerLive(successor.state) && successor.destinationSession !== r.destination_session) {
        // Onward custody is a changed blocker. Returning to the waiting owner
        // below is the result arrival that actually resumes its continuation.
        this.db.prepare("UPDATE queue_items SET blocked_on = ?, ts_updated = ? WHERE qitem_id = ?")
          .run(successor.qitemId, input.ts, r.qitem_id);
        this.transitionLog.append({ qitemId: r.qitem_id, state: "blocked", actorSession: input.actorSession,
          transitionNote: `blocker custody moved from ${input.qitemId} to ${successor.qitemId}`,
          identityProvenance: input.identityProvenance });
        const event = this.eventBus.persistWithinTransaction({ type: "queue.updated", qitemId: r.qitem_id,
          fromState: "blocked", toState: "blocked", closureReason: null, closureTarget: null,
          actorSession: input.actorSession, summary: this.getById(r.qitem_id)?.summary ?? null });
        this.eventBus.registerPersistedWithinActiveEnvelope(event);
        dependentEvents.push(event);
        continue;
      }
      if (!satisfied) {
        // T011 — WITHHOLD. The blocker ended without evidence-backed success, so
        // the consumer stays parked on its own explicit gate rather than
        // inheriting a promise that was never kept. The note is the owner's only
        // signal that this row needs a decision, so it is written once per closed
        // blocker rather than on every later propagation pass.
        const note = `withheld: blocker ${input.qitemId} ended '${input.terminalState}' without validated success`;
        const alreadyRecorded = this.db.prepare("SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_note = ?")
          .get(r.qitem_id, note);
        if (!alreadyRecorded) {
          this.transitionLog.append({ qitemId: r.qitem_id, state: "blocked", actorSession: input.actorSession,
            transitionNote: note, identityProvenance: input.identityProvenance });
        }
        const withheldEvent = this.eventBus.persistWithinTransaction({
          type: "queue.updated",
          qitemId: r.qitem_id,
          fromState: "blocked",
          toState: "blocked",
          closureReason: null,
          closureTarget: null,
          actorSession: input.actorSession,
          summary: this.getById(r.qitem_id)?.summary ?? null,
        });
        this.eventBus.registerPersistedWithinActiveEnvelope(withheldEvent);
        dependentEvents.push(withheldEvent);
        continue;
      }
      this.db
        .prepare("UPDATE queue_items SET state = 'pending', blocked_on = NULL, ts_updated = ? WHERE qitem_id = ?")
        .run(input.ts, r.qitem_id);
      this.transitionLog.append({
        qitemId: r.qitem_id,
        state: "pending",
        actorSession: input.actorSession,
        transitionNote: `auto-unparked: blocker ${input.qitemId} reached terminal state '${input.terminalState}'`,
      });
      const dependentEvent = this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId: r.qitem_id,
        fromState: "blocked",
        toState: "pending",
        closureReason: null,
        closureTarget: null,
        actorSession: input.actorSession,
        summary: this.getById(r.qitem_id)?.summary ?? null,
      });
      this.eventBus.registerPersistedWithinActiveEnvelope(dependentEvent);
      dependentEvents.push(dependentEvent);
    }
    return dependentEvents;
  }


  getById(qitemId: string): QueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as QueueItemRow | undefined;
    if (!row) return null;
    return this.rowToItem(row);
  }

  list(opts: QueueListOptions & { compact: true }): CompactQueueItem[];
  list(opts?: QueueListOptions & { compact?: false }): QueueItem[];
  list(opts?: QueueListOptions): Array<QueueItem | CompactQueueItem>;
  list(opts?: QueueListOptions): Array<QueueItem | CompactQueueItem> {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.tag) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)");
      params.push(opts.tag);
    }
    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    if (opts?.activeOnly && !opts?.state) {
      conditions.push("state IN ('pending', 'in-progress', 'blocked')");
    }
    if (opts?.asSession) {
      conditions.push("(destination_session = ? OR source_session = ?)");
      params.push(opts.asSession, opts.asSession);
    }
    if (opts?.destinationSession) {
      conditions.push("destination_session = ?");
      params.push(opts.destinationSession);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }
    if (opts?.state) {
      const states = Array.isArray(opts.state) ? opts.state : [opts.state];
      const placeholders = states.map(() => "?").join(", ");
      conditions.push(`state IN (${placeholders})`);
      params.push(...states);
    }
    if (opts?.targetRepo && this.hasTargetRepoColumn) {
      conditions.push("target_repo = ?");
      params.push(opts.targetRepo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const columns = opts?.compact ? this.compactColumns() : "*";
    const orderBy = opts?.rig || opts?.asSession || opts?.activeOnly
      ? "CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END, ts_created DESC"
      : "ts_created DESC";
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT ${columns} FROM queue_items ${where} ORDER BY ${orderBy} LIMIT ?`)
      .all(...params) as QueueItemRow[];
    const items = rows.map((r) => this.rowToItem(r));
    return opts?.compact ? items.map(compactRow) : items;
  }

  listAttention(opts?: {
    limit?: number;
    state?: QueueState | QueueState[];
    destinationSession?: string;
    sourceSession?: string;
    targetRepo?: string;
  }): QueueItem[] {
    const limit = opts?.limit ?? 100;
    const states = opts?.state
      ? Array.isArray(opts.state) ? opts.state : [opts.state]
      : ["pending" as QueueState, "in-progress" as QueueState, "blocked" as QueueState];

    // Compose the WHERE clause: state-set + attention predicate +
    // optional scope filters (mirrors list() composition so
    // `attention=1` query params remain composable with
    // destinationSession/sourceSession/targetRepo — guard re-verify
    // qitem-20260518192210 BLOCKER 1).
    const statePlaceholders = states.map(() => "?").join(", ");
    // The attention predicate is EXACT in SQL (guard re-verify-3
    // qitem-20260518193005 BLOCKER 1): is_human_seat_session evaluates
    // the strict regex registered in the QueueRepository constructor.
    // Malformed rows that would have slipped through a LIKE superset
    // (e.g., 'human-@kernel' — empty name segment) are rejected at
    // the SQL stage, BEFORE LIMIT, so they cannot saturate the LIMIT
    // window and hide valid attention items.
    // OPR.0.4.4.19 FR-6 — the attention predicate gains the leg-1 park
    // clause: a qitem parked as state=blocked on a HUMAN-seat blocker is a
    // decision the human owes. Blocking on another qitem (today's shipped
    // usage) does NOT match — is_human_seat_session rejects qitem ids.
    const conditions: string[] = [
      `state IN (${statePlaceholders})`,
      `(
        is_human_seat_session(destination_session) = 1
        OR (state = 'blocked' AND is_human_seat_session(blocked_on) = 1)
      )`,
    ];
    if (this.hasHumanIntentColumn) conditions.push("COALESCE(human_intent, 'decision') <> 'update'");
    const params: unknown[] = [...states];
    if (opts?.destinationSession) {
      conditions.push("destination_session = ?");
      params.push(opts.destinationSession);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }
    if (opts?.targetRepo && this.hasTargetRepoColumn) {
      conditions.push("target_repo = ?");
      params.push(opts.targetRepo);
    }
    params.push(limit);

    const sql = `
      SELECT * FROM queue_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY ts_created DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }


  /** The compact listing's columns: the shared set plus the summary, which is what people search for. */
  private compactColumns(): string {
    return COMPACT_QUEUE_COLUMNS + (this.hasSummaryColumn ? ", summary" : "") + (this.hasHumanIntentColumn ? ", human_intent" : "");
  }

  /**
   * Find qitems whose `closure_required_at` is past now. Read-only: the caller decides what to do
   * with an overdue obligation.
   */
  findOverdue(opts: FindOverdueOptions & { compact: true }): CompactQueueItem[];
  findOverdue(opts?: FindOverdueOptions & { compact?: false }): QueueItem[];
  findOverdue(opts?: FindOverdueOptions): Array<QueueItem | CompactQueueItem>;
  findOverdue(opts?: FindOverdueOptions): Array<QueueItem | CompactQueueItem> {
    const cutoff = opts?.now ?? new Date().toISOString();
    const conditions = ["state = 'in-progress'", "closure_required_at IS NOT NULL", "closure_required_at <= ?"];
    const params: unknown[] = [cutoff];
    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    const columns = opts?.compact ? this.compactColumns() : "*";
    let sql = `SELECT ${columns} FROM queue_items WHERE ${conditions.join(" AND ")} ORDER BY closure_required_at ASC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
    const items = rows.map((r) => this.rowToItem(r));
    return opts?.compact ? items.map(compactRow) : items;
  }

  /** The transition log's rows for one qitem, oldest first. */
  listTransitions(qitemId: string): QueueTransition[] {
    return this.transitionLog.listForQitem(qitemId);
  }

  /**
   * At a seat swap, RELEASE (never hard-drop) every in-progress item CLAIMED by the RETIRING
   * generation back to pending: the role work is durable and the successor re-claims it; only
   * the retiree's stale claim is the ghost. Gen-scoped via claimed_by_generation_uuid (NOT the
   * seat name — the successor shares it). A NULL/empty generation never matches. Clears the
   * claim stamp + claimed_at and appends an audit transition per item. Pre-063 dbs no-op.
   */
  releaseClaimsByGeneration(retiringGeneration: string): number {
    assertDirectQueueWriteAllowed(this.db);
    if (!this.hasClaimedGenColumn || !retiringGeneration) return 0;
    const rows = this.db
      .prepare(`SELECT qitem_id FROM queue_items WHERE state = 'in-progress' AND claimed_by_generation_uuid = ?`)
      .all(retiringGeneration) as Array<{ qitem_id: string }>;
    if (rows.length === 0) return 0;
    const ts = new Date().toISOString();
    const txn = this.db.transaction(() => {
      for (const { qitem_id } of rows) {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'pending', ts_updated = ?, claimed_at = NULL, closure_required_at = NULL,
                   claimed_by_generation_uuid = NULL
             WHERE qitem_id = ?`
          )
          .run(ts, qitem_id);
        this.transitionLog.append({
          qitemId: qitem_id,
          state: "pending",
          actorSession: "system",
          transitionNote: "released: claimant generation retired (seat handover)",
        });
      }
    });
    txn();
    return rows.length;
  }

  private getByIdOrThrow(qitemId: string): QueueItem {
    const item = this.getById(qitemId);
    if (!item) {
      throw new QueueRepositoryError("qitem_not_found", `qitem ${qitemId} vanished inside its own transaction`);
    }
    return item;
  }

  private persistSummary(qitemId: string, summary: string | null): void {
    if (this.hasSummaryColumn && summary !== null) {
      this.db.prepare("UPDATE queue_items SET summary = ? WHERE qitem_id = ?").run(summary, qitemId);
    }
  }

  private persistEvidenceRef(qitemId: string, evidenceRef: string | null): void {
    if (this.hasEvidenceRefColumn && evidenceRef !== null) {
      this.db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(evidenceRef, qitemId);
    }
  }

  /** Persist the MINTING occupant-generation additively (NULL when unresolved/pre-063).
   *  Forensic provenance of the creator; the RELEASE discriminator is claimed_by_generation_uuid. */
  private persistMintingGeneration(qitemId: string, sourceSession: string): void {
    if (!this.hasMintingGenColumn) return;
    const gen = this.resolveOccupantGeneration?.(sourceSession) ?? null;
    if (gen === null) return;
    this.db.prepare("UPDATE queue_items SET minting_generation_uuid = ? WHERE qitem_id = ?").run(gen, qitemId);
  }

  private rowToItem(row: QueueItemRow): QueueItem {
    return {
      qitemId: row.qitem_id,
      tsCreated: row.ts_created,
      tsUpdated: row.ts_updated,
      sourceSession: row.source_session,
      destinationSession: row.destination_session,
      state: row.state as QueueState,
      priority: row.priority as QueuePriority,
      tier: row.tier,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      blockedOn: row.blocked_on,
      handedOffTo: row.handed_off_to,
      handedOffFrom: row.handed_off_from,
      expiresAt: row.expires_at,
      chainOfRecord: row.chain_of_record ? (JSON.parse(row.chain_of_record) as string[]) : null,
      body: row.body ?? "",
      // Optional columns are present only when their migrations have applied; a
      // legacy fixture degrades to null rather than inventing an empty value.
      summary: row.summary ?? null,
      evidenceRef: row.evidence_ref ?? null,
      humanIntent: row.human_intent ?? null,
      humanDetail: row.human_detail ?? null,
      replyTo: row.reply_to ?? null,
      closureReason: row.closure_reason as ClosureReason | null,
      closureTarget: row.closure_target,
      closureRequiredAt: row.closure_required_at,
      claimedAt: row.claimed_at,
      lastNudgeAttempt: row.last_nudge_attempt,
      lastNudgeResult: presentedNudgeResult(row.last_nudge_result, row.claimed_at),
      lastNudgeWireResult: row.last_nudge_result,
      lastHeartbeat: row.last_heartbeat,
      resolution: row.resolution,
      targetRepo: row.target_repo ?? null,
    };
  }
}

function isQueueState(value: unknown): value is QueueState {
  return typeof value === "string" && (QUEUE_STATES as readonly string[]).includes(value);
}

/**
 * #165: a claim is the destination acting on the row, which is stronger evidence than
 * the wake send could get. While the row is claimed, an unconfirmed wire result
 * (`delivered-ack-pending` or `indeterminate:*`) is presented as `claimed`. The stored
 * result is never rewritten.
 */
function presentedNudgeResult(wireResult: string | null, claimedAt: string | null): string | null {
  if (!claimedAt || wireResult === null) return wireResult;
  if (wireResult === "delivered-ack-pending" || wireResult.startsWith("indeterminate:")) return "claimed";
  return wireResult;
}

/** Reduced column set for compact rows. `list` and `findOverdue` select it and pass each row
 *  through compactRow, so what isn't selected is left out and named in fieldsElided rather than
 *  backfilled as empty. */
const COMPACT_ELIDED_FIELDS = [
  "body", "evidenceRef", "humanDetail", "chainOfRecord", "replyTo",
] as const;

/** A compact listing row: the elided fields are absent, not empty, and `fieldsElided` names them. */
export type CompactQueueItem = Omit<QueueItem, (typeof COMPACT_ELIDED_FIELDS)[number] | "fieldsElided"> & {
  fieldsElided: Array<(typeof COMPACT_ELIDED_FIELDS)[number]>;
};

type FindOverdueOptions = { now?: string; rig?: string; limit?: number; compact?: boolean };

function compactRow(item: QueueItem): CompactQueueItem {
  const row: Record<string, unknown> = { ...item, fieldsElided: [...COMPACT_ELIDED_FIELDS] };
  for (const field of COMPACT_ELIDED_FIELDS) delete row[field];
  return row as unknown as CompactQueueItem;
}

const COMPACT_QUEUE_COLUMNS =
  "qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, blocked_on, handed_off_to, handed_off_from, expires_at, closure_reason, closure_target, closure_required_at, claimed_at, last_nudge_attempt, last_nudge_result, last_heartbeat, resolution, target_repo";
