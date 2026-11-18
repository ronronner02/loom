import { pendingFinalization } from "./attempt-finalization.js";
import { bindingCovers } from "./binding-scope.js";
import { documentPaths, documentDispatchRefusal, type DocumentEvidence } from "./project-documents.js";
import { leadRosterPath, parseLeadRoster, type LeadRosterEvidence } from "./lead-roster.js";
import { ScopeExtensions } from "./scope-extension.js";
import { PlanGovernance, hashBinding, hashBytes } from "./plan-governance.js";
import { ACTIVE_QUEUE_STATES } from "./queue-repository.js";
import { LeadActivation, prepareTeamAssignment, type AssignmentInput } from "./team-assignment.js";
import { createContextManifest, recordedContextManifest, roleConfiguration, roleInstructionEntries, within,
  type ContextFile, type ContextInput, type ContextManifest, type ContextObservation } from "../integrations/framework/context-manifest.js";
import { WorkerMailboxBridge } from "../adapters/worker-mailbox-bridge.js";
import { MAILBOX_SOCKET_NAME } from "./mailbox-endpoint.js";
import { isWindows } from "./platform.js";
import type { ManagedAttempt } from "./runtime-adapter.js";
import type { MailboxDelivery } from "./mailbox-delivery.js";
import type { MailboxRepository } from "./mailbox-repository.js";
import type { TeamControlCredentials } from "../middleware/auth-bearer-token.js";
import { ReviewEvidenceLedger, deliveryVerdict, evaluateProgressGate, type AssigneeFacts, type CandidateIdentity } from "./review-evidence.js";
import {
  acceptSourceRefMove,
  candidateIdentity,
  candidateManifest,
  checkedOutBranch,
  createCandidateWorkspace,
  createReviewPacket,
  isSourceWorktree,
  recordSnapshotCandidate,
  removeCandidateWorkspace,
  resolveWorkspaceBase,
  snapshotCandidateRecorded,
  sourceFingerprint,
  sourceWorktrees,
  TEAM_BRANCH_PREFIX,
  verifySourceUnchanged,
  type CandidateWorkspace,
  type SourceRefMove,
  type WorkspaceBase,
} from "./team-workspace.js";
import { readWorkspacePath } from "./workspace-read.js";
import { LEAD_ESCALATION_PATH, LEAD_PROPOSAL_PATH, LeadProposalMissingError, parseLeadEscalation, parseLeadProposalFile, type LeadProposal,
  type LeadEscalation, type LeadTask } from "./lead-proposal.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { canonicalJson, type TeamRole, type PlanBinding } from "../contracts/team-control.js";
// The candidate runtime: it owns where a task's work tree is created, reads the files a
// lead and a worker write at the boundary that owns worker output, and re-homes or releases
// a tree as its attempts start and stop. It does not drive a workflow.

import type Database from "better-sqlite3";
import { parseTaskReport, type TaskReport } from "./task-report.js";
import type { WorkflowSpec } from "./workflow-types.js";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import type { QueueRepository } from "./queue-repository.js";

export interface WorkflowRuntimeDeps {
  db: Database.Database;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  now?: () => Date;
  /**
   * Where a task's candidate tree is materialized. Must sit outside
   * every repository the run can write to, because a candidate inside its own
   * repository would let git discovery in the snapshot lane find the parent repo
   * and hide an isolation bug. Supplied by startup; absent disables candidate
   * isolation, which the launch boundary then refuses.
   *
   * The worker is a parameter because the assignment requires the tree to
   * live under `assignment_root/<that attempt's worker>`. Hardcoding one identity
   * would make every attempt projected onto another worker unlaunchable.
   */
  candidateRoot?: (runId: string, taskId: string, worker: string) => string;
  /**
   * The control-private root the kernel will mount as an assignment tree
   * (`paths.assignment_root` in the installed worker policy). A candidate is
   * only launchable from here; a candidate anywhere else is not admissible.
   * A function so a re-installed policy is read at launch, not at boot.
   */
  assignmentRoot?: () => string;
  /**
   * Where a snapshot-lane candidate's control-owned creation record is written. The
   * snapshot lane has no git registry, so this record is the only proof that a directory at a
   * candidate path was created by this runtime; it must sit in the control state directory, which
   * only the daemon can reach. Absent, the snapshot lane refuses to create or adopt a candidate
   * rather than adopting a directory it cannot account for.
   * Candidates also keep their starting base here for recovery after a restart.
   */
  candidateRecordsRoot?: () => string;
  /**
   * The worker whose assignment directory holds a candidate when the caller
   * does not name one. Only the non-launch accessors (identity, packet, source
   * check) fall back to it; the launch path always passes the attempt's own worker.
   */
  defaultWorker?: () => string;
  /**
   * Where the daemon may create an attempt's context projection and mailbox
   * endpoint, read from the installed worker policy.
   *
   * Supplied as one object rather than three callbacks because all of it has to come
   * from the same policy bytes: the projection root is where the control writes and
   * where `inspectManagedWorker` reads, and the mailbox root is the one the launcher
   * requires the endpoint's private ancestry to descend from. Reading them separately
   * would let a re-installed policy split them. Absent disables the producer, which the
   * managed launch boundary then refuses rather than launching without a projection.
   */
  managedAttemptRoots?: () => {
    contextRoot: string;
    mailboxRoot: string;
    controlStateDir: string;
    policyRevision: number;
    workerIdentities: readonly string[];
    frameworkRoot: string;
    frameworkRevision: string;
    /** Where the pinned clients and their native policy live; the projection reads both. */
    toolchainDir: string;
  };
  /**
   * The worker is the daemon's own user.
   *
   * The projection's private-ownership checks exist to prove a separate worker cannot rewrite
   * the instructions it reads. With one identity there is no such boundary, so those checks
   * are skipped rather than made trivially true; everything else about the projection (bytes,
   * hashes, canonical paths, the plan, the role charter) is unchanged.
   */
  sameIdentity?: boolean;
  /**
   * The owners that supply the producer's per-attempt inputs, so an attempt can be
   * produced from production state rather than from whatever a call site happens to hold.
   *
   * Issuance and reading are separate: the endpoint authenticates every request by *reading*
   * the credential list, so a read that minted would let a request against a revoked seat
   * bring its own token back. The producer issues once, before the endpoint exists, and the
   * bridge only ever reads.
   */
  managedAttemptInputs?: {
    /** Mint this seat's token if it has none. Called once per produced attempt. */
    issueCredential: (runId: string, sessionId: string) => void;
    /** Whether the seat already has a live token, so an existing one is never re-issued. */
    hasCredential: (runId: string, sessionId: string) => boolean;
    /** The live credential list; never mints. */
    readCredentials: () => TeamControlCredentials;
    mailboxCapability: (runId: string, sessionId: string) => string;
    workerIdentity: (worker: string) => { uid: number; gid: number; groupIds: number[] };
  };
  /**
   * An attempt's worker credential lives exactly as long as its endpoint, so it is
   * revoked on the same retirement already owns. Synchronous: the row and the live
   * token both go, and the bridge is already closed by the time this runs.
   */
  onManagedAttemptRetired?: (attempt: { runId: string; sessionId: string }) => void;
}

/**
 * What the producer hands back: the attempt object for the binding, the live
 * endpoint, and the candidate the assignment will run in. Frozen so a caller cannot
 * substitute a different attempt after it was registered.
 */
/** What the producer hands back: the attempt object for the binding, the live
 * endpoint, and the candidate the assignment will run in. Frozen so a caller cannot
 * substitute a different attempt after it was registered.
 */
export interface ProducedManagedAttempt {
  readonly attempt: ManagedAttempt;
  readonly bridge: WorkerMailboxBridge;
  readonly candidate: string;
  readonly manifestDigest: string;
}

/** Everything `produceManagedAttempt` takes. */
export interface ProduceManagedAttemptInput {
  attemptId: string;
  worker: string;
  assignment: AssignmentInput["assignment"];
  outputs: readonly string[];
  permissions: readonly string[];
  /** Everything about the attempt the projection needs; the producer derives the rest. */
  context: Omit<ContextInput, "root" | "projection" | "runId" | "files" | "binding" | "assignment"
    | "outputs" | "permissions" | "role" | "frameworkRoot" | "frameworkRevision" | "nativePolicy"
    | "workerUid" | "workerGroups"> & { workerUid?: number; workerGroups?: number[] };
  role: TeamRole;
  client: "claude-code" | "codex" | "gemini";
  /** The workspace the assignment will actually run in, candidate. */
  candidate: string;
  /** The session whose capability the mailbox accepts, and the seat it belongs to. */
  sessionId: string;
  rigId: string;
  taskId: string;
  recipients: readonly string[];
  /** The recipient's own mailbox capability: the secret its poll and consume are scoped by. */
  mailboxCapability?: string;
  /** The worker's own gid in the projection; the control side is this process. */
  workerGid?: number;
  delivery: MailboxDelivery;
  chat: MailboxRepository;
  /** The credentials this attempt's endpoint authenticates against. */
  readCredentials?: () => TeamControlCredentials;
  /** The launcher's own liveness question for this attempt; false closes the generation. */
  isCurrent: () => boolean;
  deadline: number;
  previous?: ManagedAttempt["previous"];
  /** The pinned framework files this attempt loads. */
  frameworkFiles: readonly { path: string; source: string }[];
}

/**
 * Does `taskId` satisfy a dependency, following handoff custody?
 *
 * A `done` task satisfies only with validated evidence: an exit code or a
 * completed process is not a result (R18). A `handed-off` task satisfies
 * nothing by itself — it names a successor, and the successor's own validated
 * completion is what counts, followed hop by hop. The visited set is the cycle
 * guard for a chain that closes on itself, which is unsatisfied rather than an
 * infinite walk.
 */
export function dependencySatisfied(
  db: Database.Database,
  queueRepo: Pick<QueueRepository, "getById">,
  validated: (qitemId: string) => boolean,
  runId: string,
  taskId: string,
): boolean {
  // Resolve the task to its queue row once; every hop after that is queue
  // custody, because a handoff successor is a row, not necessarily a task.
  const rows = db.prepare("SELECT qitem_id AS id FROM team_queue_authority WHERE run_id = ? AND task_id = ?").all(runId, taskId) as { id: string }[];
  if (rows.length !== 1) return false;
  const seen = new Set<string>();
  let current: string | null = rows[0]!.id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const item = queueRepo.getById(current);
    if (!item) return false;
    if (item.state === "done") {
      if (!validated(item.qitemId)) return false;
      // Completion starts review; only integration makes a reviewed implementer's
      // files available in the base from which a dependent candidate is staged.
      const awaitingIntegration = db.prepare(`SELECT 1 FROM team_queue_authority a
        JOIN team_runs r ON r.id = a.run_id WHERE a.qitem_id = ?
          AND r.reviewer_seat IS NOT NULL AND json_extract(a.assignment_json, '$.role') = 'implementer'
          AND COALESCE(json_extract(a.workflow_json, '$.readOnly'), 0) = 0
          AND NOT EXISTS (SELECT 1 FROM team_integration_commits c
            WHERE c.run_id = a.run_id AND c.task_id = a.task_id)`).get(item.qitemId);
      return awaitingIntegration === undefined;
    }
    if (item.state !== "handed-off" || !item.handedOffTo) return false;
    const successor = db.prepare("SELECT qitem_id AS id FROM queue_items WHERE handed_off_from = ? AND destination_session = ?")
      .all(item.qitemId, item.handedOffTo) as { id: string }[];
    current = successor.length === 1 ? successor[0]!.id : null;
  }
  return false;
}

/**
 * The run's declared work graph, checked before any task launches.
 *
 * Three rejections needs up front, because each one otherwise surfaces as
 * work that can never finish: an edge to a task the run does not contain, a
 * dependency cycle, and two tasks that claim the same write path. Paths are
 * directories or files in the binding, so a claim overlaps when it is the same
 * path or when one contains the other; disjoint files under one directory do
 * not conflict.
 */
export interface GraphTask {
  taskId: string;
  role: string;
  readOnly?: boolean;
  paths: readonly string[];
  dependencies: readonly string[];
}
export type GraphVerdict = { ok: true } | { ok: false; reason: string; taskIds: string[] };

/** The managed run's task ceiling, matching the admission limit `createTask` enforces. */
const MANAGED_TASK_LIMIT = 100;

/** One spelling per claimed path, so `./src/api`, `src/api/` and `src\api` cannot hide an overlap. */
const normalizeClaim = (path: string): string => path.replace(/\\/g, "/").split("/")
  .reduce<string[]>((segments, segment) => {
    // `.` and empty segments (from `src//api`) name the same path as their absence.
    if (segment === "" || segment === ".") return segments;
    if (segment === "..") segments.pop();
    else segments.push(segment);
    return segments;
  }, []).join("/");

export function validateDependencyGraph(tasks: readonly GraphTask[]): GraphVerdict {
  // The 100-task admission limit bound the run, not one createTask call: a run
  // that admits more than this cannot be prepared as one plan.
  if (tasks.length > MANAGED_TASK_LIMIT) return { ok: false, reason: `run declares ${tasks.length} tasks, above the ${MANAGED_TASK_LIMIT}-task limit`, taskIds: [] };
  const byId = new Map<string, GraphTask>();
  for (const task of tasks) {
    if (byId.has(task.taskId)) return { ok: false, reason: `duplicate task ${task.taskId}`, taskIds: [task.taskId] };
    byId.set(task.taskId, task);
  }
  for (const task of tasks) {
    const missing = task.dependencies.filter(dependency => !byId.has(dependency));
    if (missing.length) return { ok: false, reason: `${task.taskId} depends on unknown task(s) ${missing.join(", ")}`, taskIds: [task.taskId, ...missing] };
  }
  // Iterative DFS: a back edge to a node still on the stack is a cycle.
  const state = new Map<string, "visiting" | "visited">();
  for (const root of tasks) {
    if (state.get(root.taskId) === "visited") continue;
    const stack: Array<{ taskId: string; next: number }> = [{ taskId: root.taskId, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const task = byId.get(frame.taskId)!;
      if (frame.next === 0) state.set(frame.taskId, "visiting");
      if (frame.next === task.dependencies.length) {
        state.set(frame.taskId, "visited");
        stack.pop();
        continue;
      }
      const dependency = task.dependencies[frame.next]!;
      frame.next += 1;
      if (state.get(dependency) === "visiting") {
        const cycle = stack.slice(stack.findIndex(entry => entry.taskId === dependency)).map(entry => entry.taskId);
        return { ok: false, reason: `dependency cycle ${[...cycle, dependency].join(" -> ")}`, taskIds: cycle };
      }
      if (state.get(dependency) !== "visited") stack.push({ taskId: dependency, next: 0 });
    }
  }
  const claimed = new Map<string, string>();
  for (const task of tasks) {
    // The lead writes no assigned tree: its permission vocabulary has no
    // `write-assigned-tree`, and its one output is its own decomposition. C2's reviewer is
    // exempt for the same reason, so neither contributes a claim another task could conflict
    // with; their dependency edges still count.
    if (task.role === "reviewer" || task.role === "lead" || task.readOnly) continue;
    for (const path of task.paths) {
      const normalized = normalizeClaim(path);
      for (const [owned, owner] of claimed) {
        if (owned === normalized || normalized.startsWith(`${owned}/`) || owned.startsWith(`${normalized}/`)) {
          return { ok: false, reason: `write path ${path} of ${task.taskId} overlaps ${owner}'s ${owned}`, taskIds: [task.taskId, owner] };
        }
      }
      claimed.set(normalized, task.taskId);
    }
  }
  return { ok: true };
}

/** Read an existing projection's entries back as descriptors, for a resumed attempt. */
function readProjectedDescriptors(root: string, frameworkFiles: readonly { path: string; source: string }[]): ContextFile[] {
  // Each projected framework copy is matched back to the pinned source it came from by
  // its projected name, so the rebuilt descriptor points at the source the manifest
  // re-verifies rather than at the copy inside the attempt root. The rule must be the
  // same one `frameworkName` applies when creating, or a resume would map a path the
  // create path refuses onto a sanitized name.
  const projectedName = (path: string) => `framework/${path}`;
  const sourceOf = new Map(frameworkFiles.map(file => [projectedName(file.path), file.source]));
  const files: ContextFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      // The projected names are POSIX-relative on every host, so a Windows path separator
      // must not hide a recorded entry from the rebuild.
      const relative = path.slice(root.length + 1).replaceAll("\\", "/");
      const kind: ContextFile["kind"] | undefined = relative === "plan" ? "plan" : relative === "role" ? "role"
        : relative === "core" ? "core" : relative === "charter" ? "charter" : relative === "soul" ? "soul" : relative === "workflow" ? "workflow"
        : relative === "team" ? "team"
        : relative === "protocol" ? "protocol" : relative === "roster" ? "roster"
        : relative === "run" ? "run" : sourceOf.has(relative) ? "framework" : undefined;
      if (!kind) continue;
      const source = sourceOf.get(relative);
      files.push({ path, hash: hashBytes(readFileSync(path)), kind, readOnly: true, ...(source ? { source } : {}) });
    }
  };
  walk(root);
  return files;
}

/**
 * Create the part of a path this producer owns, from `anchor` down, and check it.
 *
 * The anchor and everything above it belong to the installed control, which provisions
 * them for the worker; re-creating them here would invent a second owner for
 * directories the policy already describes. Only the segment below the anchor is ours.
 *
 * The group is a parameter because the two chains differ on purpose, and each difference
 * is enforced by a validator on the other side of the boundary:
 *
 * - The **context** chain carries what the worker must read, so `privateProjection`
 *   requires every directory from the attempt root up to the worker root to carry the
 *   **worker's** gid. `<context_root>/<worker>` is installed setgid for exactly this, so
 *   a child created beneath it inherits the worker group rather than the daemon's.
 * - The **mailbox** chain is control-private, and the launcher's ancestry walk requires
 *   the control's own gid.
 *
 * One predicate for both would make the context chain unsatisfiable on a real host: the
 * setgid directory hands the child the worker group, and a check demanding the daemon's
 * group would throw on every produce.
 */
function ensureOwnedDirectory(path: string, anchor: string, mode: number, gid: number,
  sameIdentity = false): void {
  // Both ends must be canonical absolute paths before anything walks between them. A
  // relative anchor would pass `within` yet never be reached by the loop below, which
  // would then chmod its way to `/` and spin there — a write primitive and a hang from
  // one malformed policy field.
  for (const candidate of [anchor, path]) {
    if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
      throw new Error("Managed attempt directory must be a canonical absolute path");
    }
  }
  if (!within(anchor, path) || path === anchor) throw new Error("Managed attempt directory is outside the policy root");
  mkdirSync(path, { recursive: true, mode });
  // Under a setgid parent the child already carries the parent's group; the explicit
  // chmod keeps the mode exact without touching that group.
  for (let p = path; p !== anchor; p = dirname(p)) chmodSync(p, mode);
  // Windows has no POSIX uid/gid; the ownership check is only meaningful on POSIX hosts.
  if (typeof process.getuid === "function") {
    const stat = statSync(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.gid !== gid
      || (stat.mode & 0o7777) !== mode) {
      throw new Error("Managed attempt directory is not owned as the policy requires");
    }
  }
}

/** Seal every directory in a projection: the launcher refuses any its owner could write. */
function sealProjectionTree(root: string): void {
  const seal = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) seal(join(directory, entry.name));
    }
    // 0550, not 0700: the worker reads this tree through its group, and the launcher
    // rejects any directory below the worker root that still carries an owner write bit.
    chmodSync(directory, 0o550);
  };
  seal(root);
}

/** Remove a projection this producer created and failed to finish, so the attempt id is reusable. */
function removeAttemptRoot(root: string): void {
  try {
    const writable = (path: string): void => {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
      }
    };
    if (existsSync(root)) { writable(root); rmSync(root, { recursive: true, force: true }); }
  } catch { /* A projection that cannot be removed is evidence, not a second failure. */ }
}

/**
 * Remove a mailbox directory this production created but never published an endpoint for.
 *
 * The directory is created before `listen` so the endpoint has somewhere to bind, and a listen
 * that fails leaves nothing worth keeping: the attempt id is fresh, so no later caller can adopt
 * the directory or find the missing endpoint either. Without this, a host whose socket bind fails
 * accumulates one directory per retry — measured on a Windows host whose AF_UNIX bind is refused,
 * where a day of retries would have been tens of thousands of directories.
 */
function removeMailboxDirectory(directory: string): void {
  if (!existsSync(directory)) return;
  try { rmSync(directory, { recursive: true, force: true }); }
  catch { /* A directory that cannot be removed is evidence, not a second failure. */ }
}

/**
 * The projection root, created below the worker's own context directory.
 *
 * Group searchable for the worker and grouped to it, because the manifest requires both;
 * the root is sealed by the caller once its entries exist, so nothing can be added to a
 * projection after it was hashed.
 */
function ensureAttemptRoot(path: string, roots: { contextRoot: string; worker: string; workerGid: number }): void {
  ensureOwnedDirectory(path, join(roots.contextRoot, roots.worker), 0o2750, roots.workerGid);
}

/**
 * The mailbox directory, which is control-private rather than worker-readable.
 *
 * The bridge re-checks this 0700, control-gid shape, so
 * it is created to exactly that here instead of being loosened for the worker.
 */
function ensureMailboxDirectory(path: string, roots: { mailboxRoot: string; worker: string; controlStateDir: string },
  sameIdentity = false): void {
  // The mailbox root sits directly under `control_state_dir`, so an inconsistent roots
  // object is refused here rather than discovered as a launch refusal later. The local
  // mailbox root is kept shallow so its socket path fits AF_UNIX.
  if (!sameIdentity && roots.mailboxRoot !== join(roots.controlStateDir, "mailboxes")) {
    throw new Error("Managed mailbox root is not beneath the control state directory");
  }
  ensureOwnedDirectory(path, join(roots.mailboxRoot, roots.worker), 0o700, typeof process.getgid === "function" ? process.getgid() : 0);
}

export class WorkflowRuntime {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly now: () => Date;
  private readonly events: EventBus;
  private readonly reviewEvidence: ReviewEvidenceLedger;
  /** Candidate trees this runtime materialized, keyed by run and task. */
  private readonly candidates = new Map<string, CandidateWorkspace>();
  /** Which attempts still hold each candidate; the tree survives until this is empty. */
  private readonly candidateOwners = new Map<string, Set<string>>();
  /** The worker whose assignment directory holds each candidate, so reuse cannot cross workers. */
  private readonly candidateWorker = new Map<string, string>();
  /** Candidates refused because the source moved; kept so their owners can still release them. */
  private readonly invalidCandidates = new Set<string>();
  /** Keeps two quarantined directories at one candidate path from colliding. */
  private quarantineSeq = 0;
  private readonly candidateRoot?: WorkflowRuntimeDeps["candidateRoot"];
  private readonly assignmentRoot?: () => string;
  private readonly candidateRecordsRoot?: () => string;
  private readonly defaultWorker?: () => string;
  /** The roots the producer writes into, read at call time. */
  private readonly managedAttemptRoots?: WorkflowRuntimeDeps["managedAttemptRoots"];
  private readonly managedAttemptInputs?: WorkflowRuntimeDeps["managedAttemptInputs"];
  private readonly onManagedAttemptRetired?: WorkflowRuntimeDeps["onManagedAttemptRetired"];
  /** The worker is the daemon's own user, so the private-ownership checks are skipped. */
  private readonly sameIdentity: boolean;
  /** Attempt projections and endpoints this daemon produced, keyed by attempt id. */
  private readonly managedAttempts = new Map<string, ProducedManagedAttempt>();
  /** Productions still starting, so a duplicate caller awaits the same one. */
  private readonly producing = new Map<string, Promise<ProducedManagedAttempt>>();
  /**
   * Attempts whose endpoint is still listening, and the seat each will hold. A sibling
   * retirement consults this so it does not revoke a credential an in-flight endpoint needs;
   * it is deliberately not `managedAttempts`, which is the published record a caller receives.
   */
  private readonly startingAttempts = new Map<string, { runId: string; sessionId: string }>();

  /**
   * One candidate tree per task, created or resumed exactly once.
   *
   * The candidate is resolved before the launch preflight, because the control
   * reads the assigned tree out of the policy's `assignment_root` and refuses a
   * tree anywhere else. A resumed attempt reuses the recorded workspace rather
   * than creating a second one, so re-entering the launch cannot fork a task's
   * work across two trees.
   *
   * The source repository is only read: `createCandidateWorkspace` fingerprints
   * it and materializes the base elsewhere. Refusals are raised, never returned,
   * so a caller cannot proceed on a workspace it did not get.
   */
  candidateFor(runId: string, taskId: string, worker?: string, options?: { adoptOnly?: boolean }): CandidateWorkspace {
    const key = `${runId}\u0000${taskId}`;
    // An invalidated candidate stays recorded so its owners can still release it,
    // but no caller may enter it again.
    if (this.invalidCandidates.has(key)) throw new Error("Source checkout changed while the candidate was staged");
    const existing = this.candidates.get(key);
    if (existing) {
      // A candidate lives in one worker's assignment directory, and only that
      // worker's launches can mount it. Handing it to another worker would produce
      // a tree the kernel refuses, so the mismatch cannot be papered over.
      //
      // Which way it resolves depends on whether anybody is using the tree. A
      // *claimed* candidate belongs to its attempts and a launch on another worker
      // is refused: staging a second tree would fork one task's work across two,
      // which is exactly what one-candidate-per-task forbids. An *unclaimed* one is
      // only a path a reader guessed at, because the packet and identity accessors
      // name no worker and fall back to the default; re-homing it is safe and is
      // what keeps a reader from deciding where a later launch has to run.
      //
      // A record with no worker can also sit in *this* worker's directory: the reader
      // fell back to the same worker the launch is about to use. That is not a
      // disagreement to re-home — re-homing would delete the very tree the launch
      // asks for — so the tree is kept.
      const owner = this.candidateWorker.get(key);
      const samePlace = owner === undefined && this.candidateRoot !== undefined
        && worker !== undefined && existing.root === this.candidateRoot(runId, taskId, worker);
      if (worker !== undefined && (owner !== undefined ? owner !== worker : !samePlace)) {
        // Re-homing is a mutation: it drops the record and asks for the tree's removal. An
        // adopt-only caller is a reader that must never destroy state — a review launch
        // refused here would otherwise deregister and remove the very candidate it was
        // asked to review, so it refuses without touching anything. The tree stays
        // accounted for, and the worker that does own it can still launch into it.
        if (options?.adoptOnly) throw new Error("Reviewed candidate belongs to a different worker");
        // A record with no worker was staged by a reader that names none (packet,
        // identity, source check) in the default worker's directory. It belongs to
        // no attempt, so it is re-homed rather than allowed to decide where the
        // real launch runs.
        const claimed = (this.candidateOwners.get(key)?.size ?? 0) > 0;
        if (claimed) throw new Error("Candidate belongs to a different worker");
        this.candidates.delete(key);
        this.candidateWorker.delete(key);
        this.removeWorkspace(existing);
      } else {
        // Recording an owner is bookkeeping for a tree about to be launched into. An
        // adopt-only caller is not launching yet, so it leaves the record as it found it
        // and the real launch does the recording.
        if (samePlace && !options?.adoptOnly) this.candidateWorker.set(key, worker!);
        // A candidate is only usable while the source checkout it was staged
        // from is unmoved. Handing one back after the owner's tree changed would
        // present a tree as evidence of work the source no longer supports, so this
        // refuses rather than returning it — and every packet, identity and delivery
        // path goes through here.
        if (!verifySourceUnchanged(existing).unchanged) {
          // The record is *kept*: the tree still exists on disk and the attempts that
          // hold it are the only ones who can release it, so dropping it here would
          // leave `releaseCandidate` with nothing to remove and strand the bytes.
          // It is refused rather than returned, so no launch can enter it again.
          this.invalidCandidates.add(key);
          throw new Error("Source checkout changed while the candidate was staged");
        }
        return this.scopedCandidate(runId, taskId, existing);
      }
    }
    if (!this.candidateRoot || !this.assignmentRoot) throw new Error("Candidate isolation is not configured");
    const run = new PlanGovernance(this.db, this.eventBus, this.queueRepo).getRun(runId);
    const owner = worker ?? this.defaultWorkerName();
    const workspaceRoot = this.candidateRoot(runId, taskId, owner);
    // A candidate outside the kernel's assignment root could never be mounted, so
    // refusing here is the difference between an isolated launch and a lost tree.
    if (!within(this.assignmentRoot(), workspaceRoot)) throw new Error("Candidate root is outside the assignment root");
    // A restart forgets the in-memory record but not the tree. Re-entering a task
    // whose candidate is already on disk must adopt that tree, not stage a second
    // one over it: `git worktree add` refuses an existing path, so the alternative
    // is that every resumed task is unlaunchable after a restart, and its work is
    // stranded in a directory nothing can name. Adoption re-derives the same
    // workspace shape from the recorded base and re-fingerprints the source, so the
    // adopted tree is held to exactly the checks a created one is.
    //
    // A caller that names no worker is not adopting: it is only reading (packet,
    // identity, source check), and it has no way to know which worker the task
    // belongs to. Recording `defaultWorker` for it would pin the task to that
    // worker and refuse the real launch on any other one.
    // Adoption decides provenance from control-owned records only: the source repository's
    // worktree registry for the commit lane, and the creation record the control wrote under its
    // own state directory for the snapshot lane. Nothing on or in the candidate is consulted.
    //
    // The delivery base is the run's integration worktree once it has one. That worktree
    // carries exactly the commits earlier tasks landed, so a later task builds on their work;
    // the binding's own root is the base before the first integration.
    const sourceRoot = this.deliverySource(run);
    const base = resolveWorkspaceBase(sourceRoot);
    const recordPath = base.kind === "snapshot" ? this.snapshotRecordPath(runId, taskId) : undefined;
    const integratedSource = (checkedOutBranch(sourceRoot) ?? "").startsWith(TEAM_BRANCH_PREFIX);
    const adopted = this.adoptCandidate(runId, taskId, workspaceRoot, base, recordPath, sourceRoot);
    // Every in-flight task keeps its starting base when another task lands across a restart.
    const basePath = this.candidateRecordsRoot && this.candidateBasePath(runId, taskId);
    if (adopted && basePath && existsSync(basePath)) {
      adopted.base = JSON.parse(readFileSync(basePath, "utf8")) as WorkspaceBase;
    }
    // A review launch may adopt the tree a restart left behind, but must never
    // create one. Staging here would hand the reviewer a checkout nobody wrote — the
    // defect this task exists to close — so absence is a refusal, not a cue to build.
    if (options?.adoptOnly) {
      if (!adopted) throw new Error("Reviewed task has no candidate");
      // The record is written only so a later caller in this process sees the same tree;
      // the launch that actually enters it records the owner, exactly as a non-review
      // launch does. Refusing above leaves everything untouched.
      const workspace = { ...adopted, integrationSource: integratedSource };
      this.candidates.set(key, workspace);
      return this.scopedCandidate(runId, taskId, workspace);
    }
    if (run.state !== "approved") throw new Error("Run is not approved for this assignment");
    let workspace: CandidateWorkspace;
    if (adopted) workspace = adopted;
    else {
      // Anything at the candidate path the control cannot account for is moved aside, never
      // deleted and never adopted. The path is under the worker's own assignment directory, so
      // leaving the entry in place would block this task on every retry — a directory or a plain
      // file alike, since `git worktree add` refuses any occupied path. The quarantine name is
      // chosen here and keeps whatever was in it.
      if (this.present(workspaceRoot)) this.quarantineCandidate(workspaceRoot);
      try {
        workspace = createCandidateWorkspace({ root: sourceRoot, base, workspaceRoot, label: taskId });
      } catch (error) {
        // A creation that failed partway is no more accounted for than a planted entry, and the
        // next retry has to be able to try again.
        if (this.present(workspaceRoot)) this.quarantineCandidate(workspaceRoot);
        throw error;
      }
      // Persist control-owned provenance before returning a newly created candidate.
      try {
        if (recordPath) {
          recordSnapshotCandidate(recordPath, { runId, taskId, root: workspace.root });
          workspace = { ...workspace, recordPath };
        }
        if (basePath) {
          mkdirSync(dirname(basePath), { recursive: true });
          writeFileSync(basePath, JSON.stringify(workspace.base), { mode: 0o600 });
        }
      } catch (error) {
        removeCandidateWorkspace(workspace);
        throw error;
      }
    }
    workspace = { ...workspace, integrationSource: integratedSource };
    // Only a caller that named a worker tells us who owns the task's tree.
    if (worker !== undefined) this.candidateWorker.set(key, worker);
    this.candidates.set(key, workspace);
    return this.scopedCandidate(runId, taskId, workspace);
  }

  /**
   * Re-enter a candidate this runtime already staged, before a restart.
   *
   * A directory at the candidate path is adopted only when a control-owned record accounts for it:
   * the source's worktree registry for the commit lane, the creation record under the control state
   * directory for the snapshot lane. Anything that is not a directory — a file, a symlink — is left
   * to `createCandidateWorkspace`, which refuses it loudly. The base is resolved from the current
   * source, so the source-moved check downstream still applies to the adopted tree.
   */
  private adoptCandidate(runId: string, taskId: string, workspaceRoot: string, base: WorkspaceBase,
    recordPath: string | undefined, source: string): CandidateWorkspace | undefined {
    let stats;
    try { stats = lstatSync(workspaceRoot); } catch { return undefined; }
    if (!stats.isDirectory()) return undefined;
    const sourceRoot = realpathSync(source);
    const accounted = base.kind === "commit"
      ? isSourceWorktree(sourceRoot, workspaceRoot)
      : recordPath !== undefined && snapshotCandidateRecorded(recordPath, { runId, taskId, root: workspaceRoot });
    if (!accounted) return undefined;
    return { root: workspaceRoot, sourceRoot, base, source: sourceFingerprint(sourceRoot),
      ...(recordPath ? { recordPath } : {}) };
  }

  /**
   * Where a task's candidate is staged from.
   *
   * Once the run has an integration worktree, that worktree is the delivery base: it carries
   * exactly the commits earlier tasks landed, so a later task builds on their work. Before the
   * first integration — and for a run whose recorded worktree has gone — the binding's own root
   * is the base, which is where the run's plan was read.
   */
  private deliverySource(run: Pick<import("../contracts/team-control.js").TeamRun, "id" | "binding">): string {
    const recorded = new PlanGovernance(this.db, this.eventBus, this.queueRepo).integrationRecord(run.id).worktree;
    return recorded !== null && existsSync(recorded) ? recorded : run.binding.repository.root;
  }

  /**
   * Move an unaccounted directory off a candidate path, keeping everything in it.
   *
   * The candidate path sits under `assignments/<worker>`, which the worker owns, so a worker can
   * put a directory of its choosing there before its task launches. Leaving it in place would
   * refuse that task on every retry — the `EEXIST` wedge the card forbids, wearing a different
   * error — and deleting it could destroy genuine work whose record was lost. It is therefore
   * renamed, never removed: the sibling name is chosen here from the control's own counter, so
   * nothing about the worker's directory decides where it goes, and the bytes stay for the owner
   * to inspect. The task then creates its own candidate at the path it was given.
   */
  private quarantineCandidate(workspaceRoot: string): void {
    this.quarantineSeq += 1;
    renameSync(workspaceRoot, `${workspaceRoot}.rejected-${Date.now()}-${this.quarantineSeq}`);
  }

  /** Whether anything occupies a path. A broken link counts: it still blocks creation. */
  private present(path: string): boolean {
    try { lstatSync(path); return true; } catch { return false; }
  }

  /** The control-owned record path for one task's snapshot candidate. */
  private snapshotRecordPath(runId: string, taskId: string): string {
    const root = this.candidateRecordsRoot?.();
    if (!root) throw new Error("Snapshot candidate provenance is not configured");
    return join(root, `${runId}-${taskId}.json`);
  }

  /**
   * The identity a candidate contributes to the review packet.
   *
   * The candidate's own manifest is the identity; nothing about the launch can
   * name a different tree afterward.
   */
  private scopedCandidate(runId: string, taskId: string, workspace: CandidateWorkspace): CandidateWorkspace {
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    // Provenance inspection can precede task registration; only a recorded task has an effective scope.
    if (governance.findTask(runId, taskId)) workspace.checkScope = evidence => governance.stageCandidateScope(runId, taskId, evidence);
    return workspace;
  }

  /** Browsing observes existing records only; it never acquires or validates a workspace. */
  existingCandidate(runId: string, taskId: string): Pick<CandidateWorkspace, "root" | "sourceRoot" | "base"> | null {
    const key = `${runId}\u0000${taskId}`;
    const candidate = this.invalidCandidates.has(key) ? undefined : this.candidates.get(key);
    return candidate ? { root: candidate.root, sourceRoot: candidate.sourceRoot, base: candidate.base } : null;
  }


  candidateIdentityFor(runId: string, taskId: string): CandidateIdentity {
    return candidateIdentity(candidateManifest(this.candidateFor(runId, taskId)));
  }


  candidateManifestFor(runId: string, taskId: string): ReturnType<typeof candidateManifest> {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    return candidateManifest({ ...workspace, checkScope: undefined });
  }

  /** Read only the report assigned to this run and worker attempt through the existing file boundary. */
  taskReportFor(runId: string, attemptId: string, turnStateRoot: string): TaskReport | null {
    const attempt = this.db.prepare("SELECT role FROM team_attempts WHERE id = ? AND run_id = ?").get(attemptId, runId) as
      { role: string } | undefined;
    if (!attempt || !["implementer", "reviewer"].includes(attempt.role)
      || !attemptId || /[/\\\x00-\x1f]/.test(attemptId) || [".", ".."].includes(attemptId)) {
      throw new Error("Task report requires this run's worker attempt");
    }
    const read = readWorkspacePath(turnStateRoot, "turns/" + attemptId + "/report/task-report.json", () => false);
    if (read.kind === "missing") return null;
    if (read.kind !== "file") throw new Error("Task report is not a regular file");
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("Task report is not valid JSON"); }
    return parseTaskReport(value);
  }

  /**
   * The decomposition a lead wrote, read at the boundary that owns worker-written data.
   *
   * The lead's only output is this one file in its own candidate tree, so the read goes
   * through `readWorkspacePath` — the same pinned, no-follow, size-bounded reader every other
   * read of worker output uses — and never through a second reader of the tree. A lead that
   * wrote nothing, or wrote something that is not the shape the protocol states, refuses here
   * with a reason the owner can act on. What the caller does with the batch is not this
   * method's decision: the governance owner validates it against the approved binding and
   * records an owner decision.
   */

  leadProposalFor(runId: string, taskId: string): LeadTask[] {
    return this.leadProposalWithSeatsFor(runId, taskId).tasks;
  }

  leadProposalWithSeatsFor(runId: string, taskId: string): LeadProposal {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, LEAD_PROPOSAL_PATH, () => false);
    if (read.kind !== "file") throw new LeadProposalMissingError();
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("The lead's proposal is not valid JSON"); }
    return parseLeadProposalFile(value);
  }

  /**
   * The decision a lead asked the owner for, read at the same boundary as its proposal.
   *
   * One file, one reader: the escalation goes through `readWorkspacePath` exactly as the
   * proposal does, so a lead cannot reach the owner with anything but bytes the daemon itself
   * read. Null means the turn wrote no escalation, which is every ordinary turn; a file the
   * boundary refuses refuses here with a reason the turn-end owner can log.
   */
  leadEscalationFor(runId: string, taskId: string): LeadEscalation | null {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, LEAD_ESCALATION_PATH, () => false);
    if (read.kind !== "file") return null;
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("The lead's escalation is not valid JSON"); }
    return parseLeadEscalation(value);
  }

  /**
   * The plan the lead wrote, read at the same boundary as its proposal.
   *
   * A planning lead's one deliverable is the plan file in its own candidate tree, so the owner's
   * approval reads it through `readWorkspacePath` like every other read of worker output. The
   * path is the run's recorded plan path: the candidate and the binding cannot name different
   * files, because the approval is what makes the binding real.
   */
  rosterFor(runId: string, taskId: string, planRef: string): LeadRosterEvidence {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, leadRosterPath(planRef), () => false);
    if (read.kind !== "file") throw new Error("The lead wrote no readable lead-roster.json beside the plan.");
    let value: unknown;
    try { value = JSON.parse(read.content); } catch { throw new Error("The lead's roster is not valid JSON."); }
    return { seats: parseLeadRoster(value), digest: read.hash };
  }

  documentsFor(runId: string, taskId: string, planRef: string): DocumentEvidence {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const evidence: DocumentEvidence = {};
    for (const [kind, path] of Object.entries(documentPaths(planRef))) {
      const read = readWorkspacePath(workspace.root, path, () => false);
      if (read.kind === "directory") throw new Error("A document path is a directory");
      if (read.kind === "file") evidence[kind as keyof DocumentEvidence] = { content: read.content, hash: read.hash };
    }
    return evidence;
  }

  planFor(runId: string, taskId: string, planRef: string): { content: string; hash: string } {
    const workspace = this.candidateFor(runId, taskId, undefined, { adoptOnly: true });
    const read = readWorkspacePath(workspace.root, planRef, () => false);
    if (read.kind !== "file") throw new Error("The lead wrote no plan at " + planRef);
    return { content: read.content, hash: read.hash };
  }

  /** Keep candidate proofs current after this repository's owner Merge, without re-adoption. */
  acceptOwnerMerge(repository: string, move: SourceRefMove): void {
    const sources = sourceWorktrees(repository);
    for (const [key, workspace] of this.candidates) {
      if (this.invalidCandidates.has(key) || !sources.has(workspace.sourceRoot)) continue;
      try { acceptSourceRefMove(workspace, move); }
      catch { /* An unreadable source keeps its old proof and stays unavailable. */ }
    }
  }

  /**
   * Let a task's candidate be adopted again after its source moved.
   *
   * Approving a plan commits those bytes to the run's own branch, which moves the source
   * worktree's HEAD. The tree the lead worked in is untouched, but the source-moved check reads
   * the *recorded* fingerprint and would refuse it from then on. The tree is still the same
   * task's candidate and still registered in the source's own worktree registry, so dropping the
   * in-memory record lets the next launch adopt it — the same path a restart already takes — at
   * the commit the plan was approved at. No bytes are moved, and nothing is released: the tree
   * keeps every file the lead wrote.
   */
  forgetCandidate(runId: string, taskId: string): void {
    const key = `${runId}\u0000${taskId}`;
    this.candidates.delete(key);
    this.candidateWorker.delete(key);
    this.invalidCandidates.delete(key);
  }

  /** Start a delivery lead's next management turn from the integration head. */
  prepareDeliveryLeadTurn(runId: string, taskId: string): boolean {
    if (pendingFinalization(this.db, runId)) throw new Error("managed_finalization_pending");
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    const run = governance.getRun(runId);
    if (run.phase !== "delivery" || run.state !== "approved"
      || governance.findTask(runId, taskId)?.assignment.role !== "lead") return false;
    const basePath = this.candidateBasePath(runId, taskId);
    const previous = this.candidateFor(runId, taskId);
    this.removeWorkspace(previous);
    this.forgetCandidate(runId, taskId);
    this.candidateOwners.delete(`${runId}\u0000${taskId}`);
    rmSync(basePath, { force: true });
    const candidate = this.candidateFor(runId, taskId);
    // Native sessions can resume after a tree refresh when their cwd stays the same.
    return candidate.root !== previous.root;
  }

  private candidateBasePath(runId: string, taskId: string): string {
    const root = this.candidateRecordsRoot?.();
    if (!root) throw new Error("Candidate provenance is not configured");
    // Fixed-width UUID runs keep safe legacy names so active turns survive an upgrade.
    // Other identifiers use a separate tuple-keyed namespace, never caller-controlled path segments.
    const legacy = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(runId) && !/[\\/]/.test(taskId);
    return legacy ? join(root, `${runId}-${taskId}.lead-base.json`)
      : join(root, "keyed-bases", `${hashBytes(JSON.stringify([runId, taskId])).slice(7)}.lead-base.json`);
  }

  /**
   * Release one candidate tree, but only when this caller still owns it.
   *
   * A candidate is shared by every attempt that launches into it: a resume reuses
   * the recorded tree, and a second attempt for the same task must not delete work
   * a live one owns. So release is reference-counted by attempt. `retain` is called
   * once admission hands an attempt a candidate; `release` is called once that
   * attempt is finished with it. The tree goes away only when the last owner does.
   *
   * An unretained release is a no-op rather than a guess: an attempt that never
   * obtained the candidate has nothing to give back. A review attempt is exactly that
   * case — it reads the implementer's tree and never owns it, so this is the no-op that
   * keeps a refused review from deleting the work it was asked to review.
   */
  releaseCandidate(runId: string, taskId: string, attemptId: string): void {
    const key = `${runId}\u0000${taskId}`, owners = this.candidateOwners.get(key);
    if (!owners?.delete(attemptId) || owners.size > 0) return;
    this.candidateOwners.delete(key);
    this.invalidCandidates.delete(key);
    const workspace = this.candidates.get(key);
    if (!workspace) return;
    this.candidates.delete(key);
    this.candidateWorker.delete(key);
    this.removeWorkspace(workspace);
  }

  /** Record that this attempt holds the task's candidate. Idempotent per attempt. */
  private retainCandidate(key: string, attemptId: string): void {
    const owners = this.candidateOwners.get(key);
    if (owners) owners.add(attemptId);
    else this.candidateOwners.set(key, new Set([attemptId]));
  }

  /**
   * The read-only packet a reviewer receives for the exact candidate.
   *
   * `destination` must not overlap the candidate or the source checkout; the
   * packet builder enforces that itself rather than trusting this call site.
   */
  reviewPacketFor(runId: string, taskId: string, destination: string) {
    return createReviewPacket(this.candidateFor(runId, taskId), destination);
  }

  /**
   * Proof that staging the candidate did not move the owner's checkout.
   *
   * Called by the delivery boundary: a candidate whose source tree changed while
   * the task ran is not evidence that the task's own work is complete.
   */
  candidateSourceUnchanged(runId: string, taskId: string) {
    return verifySourceUnchanged(this.candidateFor(runId, taskId));
  }

  /**
   * Release one candidate tree, but only when this caller still owns it.
   *
   * A candidate is shared by every attempt that launches into it: a resume reuses
   * the recorded tree, and a second attempt for the same task must not delete work
   * a live one owns. So release is reference-counted by attempt. `retain` is called
   * once admission hands an attempt a candidate; `release` is called once that
   * attempt is finished with it. The tree goes away only when the last owner does.
   *
   * An unretained release is a no-op rather than a guess: an attempt that never
   * obtained the candidate has nothing to give back. A review attempt is exactly that
   * case — it reads the implementer's tree and never owns it, so this is the no-op that

  /**
   * Admit one assignment for launch and place its candidate.
   *
   * The launcher must know the assigned tree before the control preflights it, because the
   * control reads that tree out of the policy's `assignment_root` and refuses a tree anywhere
   * else. Every refusal is decided first — the run is approved, the binding still matches, the
   * role and paths sit inside the approval, dependencies hold with validated evidence, and the
   * graph admits the task — and only then is exactly one candidate materialized.
   */
  admitForLaunch(runId: string, input: {
    attemptId: string;
    /** The attempt's own worker: the candidate must sit in that worker's assignment directory. */
    worker: string;
    assignment: AssignmentInput["assignment"];
    outputs: readonly string[];
    permissions: readonly string[];
    context: ContextManifest;
  }): { candidate: string; manifestDigest: string } {
    if (pendingFinalization(this.db, runId)) throw new Error("managed_finalization_pending");
    const { governance, run } = this.approvedRunForAssignment(runId, input.context.runId, input.context.binding);
    const binding = run.binding, assignment = input.assignment;
    const documentError = documentDispatchRefusal(this.db, run, assignment.role, assignment.taskId, input.context.binding);
    if (documentError) throw new Error(documentError);
    if (assignment.role !== input.context.role || !binding.roles.includes(assignment.role)) throw new Error("Assignment role is outside the approval");
    // The link is checked against the run's own recorded rows, never against the
    // launch's claim. A reviewer naming a task this run did not record as an implementer is
    // refused before any tree is touched. The role gate is repeated here rather than left to
    // `parseAssignment`, because admission is what decides which tree a launch enters and what
    // access it gets: an implementer carrying a link would be handed another task's candidate
    // and mounted writable.
    if (assignment.reviewOf !== undefined && (assignment.role !== "reviewer" || !this.isRunImplementer(runId, assignment.reviewOf))) {
      throw new Error("Review target is not this run's implementer");
    }
    const readOnly = input.context.workflow?.readOnly === true;
    if (readOnly && (input.outputs.length || input.permissions.includes("write-assigned-tree"))) throw new Error("Read-only workflows cannot declare tree writes");
    const allowed = assignment.role === "reviewer" || readOnly ? [...binding.readPaths, ...binding.writePaths] : binding.writePaths;
    const covered = (path: string) => bindingCovers(path, allowed);
    for (const path of [...assignment.paths, ...input.outputs]) if (!covered(path)) throw new Error("Assignment or output expands the approved scope");
    // The task's own record is the store for outputs and permissions, so admission is
    // where a caller's claim is checked — both the producer and a direct launch pass through
    // here, and neither should be able to declare production inputs the run never recorded.
    // A row that predates the record has nothing to disagree with.
    const task = governance.findTask(runId, assignment.taskId);
    if (!task && assignment.role !== "reviewer") throw new Error("Task not found in this run");
    const differs = (claimed: readonly string[], stored: string[] | null) =>
      stored !== null && canonicalJson([...claimed].sort()) !== canonicalJson([...stored].sort());
    if (task && (differs(input.outputs, task.outputs) || differs(input.permissions, task.permissions))) {
      throw new Error("Assignment inputs disagree with the recorded task");
    }
    if (assignment.dependencies.some(id => !this.dependencySatisfied(governance, runId, id))) throw new Error("Dependency lacks validated success");
    // done signal requires a cyclic or over-limit graph and overlapping write
    // claims to refuse the launch, so the graph is derived from the run's own
    // authority rows rather than taken from the caller. A caller cannot skip this by
    // omitting an argument: the run is the only source of what its tasks claim.
    const verdict = validateDependencyGraph(this.runGraph(runId, run.bindingDigest, assignment));
    if (!verdict.ok) throw new Error(`Dependency graph refused: ${verdict.reason}`);
    // A reviewer enters the candidate under review; every other assignment gets its own.
    // The reviewer path is lookup-only on purpose — see `reviewedCandidateFor`.
    const candidate = assignment.reviewOf === undefined
      ? this.candidateFor(runId, assignment.taskId, input.worker)
      : this.reviewedCandidateFor(runId, assignment.reviewOf, input.worker);
    // Only an attempt that is actually handed the candidate owns it. Recording
    // ownership here is what lets a later refusal tell "my tree" from "someone
    // else's live tree" instead of guessing. The digest is read first on purpose: a
    // manifest failure after the claim was taken would leave an owner that never
    // received anything, and the reference count would then hold the tree forever
    // because nothing knows to release it.
    //
    // A review attempt takes no claim. It reads a tree another task owns, so a
    // claim from it would make the reviewer the owner — a refused review would then be
    // allowed to delete the implementer's work, and a completed one would keep the tree
    // alive past the implementer's own release. Its release is the no-op that ownership
    // never existed, which is exactly the behaviour a reader wants.
    const manifestDigest = candidateManifest(candidate).manifestDigest;
    if (assignment.reviewOf === undefined) this.retainCandidate(`${runId}\u0000${assignment.taskId}`, input.attemptId);
    return { candidate: candidate.root, manifestDigest };
  }

  /**
   * The tree a managed launch of this assignment mounts.
   *
   * The production composition asks this before the control's policy check sees the path,
   * so it is the one place that decides "my own candidate" versus "the candidate I review".
   * Kept as a runtime method rather than inline in `startup.ts` so the decision the launch
   * actually uses is the one under test; the composition stays a call site.
   *
   * A review launch never creates here: the adopt-only path refuses an absent candidate,
   * which is what stops a reviewer being handed a checkout nobody wrote.
   */
  assignedTreeFor(runId: string, assignment: { taskId: string; reviewOf?: string }): string {
    return (assignment.reviewOf === undefined
      ? this.candidateFor(runId, assignment.taskId)
      : this.reviewedCandidateFor(runId, assignment.reviewOf)).root;
  }

  /** Whether this run recorded the task as an implementer. */
  private isRunImplementer(runId: string, taskId: string): boolean {
    const row = this.db.prepare(
      `SELECT assignment_json AS assignment FROM team_queue_authority WHERE run_id = ? AND task_id = ?`)
      .get(runId, taskId) as { assignment: string } | undefined;
    if (!row) return false;
    return (JSON.parse(row.assignment) as { role?: string }).role === "implementer";
  }

  /**
   * Enter the candidate a reviewer reviews, or refuse.
   *
   * The reviewed tree is the one its own task would enter, so this goes through the same
   * lookup-and-adopt path `candidateFor` owns. It differs in exactly one way: it passes
   * `adoptOnly`, so a tree a restart left behind is adopted from its control-owned record
   * while a missing one is refused. Staging would hand the reviewer a checkout nobody
   * wrote, which is the defect this task closes.
   */
  private reviewedCandidateFor(runId: string, reviewedTaskId: string, worker?: string): CandidateWorkspace {
    return this.candidateFor(runId, reviewedTaskId, worker, { adoptOnly: true });
  }

  /** The worker a non-launch accessor falls back to when it has no attempt. */
  private defaultWorkerName(): string {
    if (!this.defaultWorker) throw new Error("Candidate isolation is not configured");
    return this.defaultWorker();
  }

  /**
   * Produce the attempt an admitted assignment launches from.
   *
   * Composes the three things the composed launch chain expects but nothing produced:
   * the context projection under the policy's `context_root`, the per-attempt
   * mailbox endpoint in the control-private `mailbox_root`, and the bootstrap written
   * beside that socket. attaches the result to a seat.
   *
   * Order matters for the same reason it does in `admitForLaunch`. Admission is the
   * only thing that may say no, and it is asked first: a refused assignment must
   * leave no projection, no endpoint and no attempt, because a projection on disk is
   * evidence of work that never started and an endpoint is a channel a worker could
   * be pointed at. Only after admission is the projection built, then the endpoint —
   * the projection directory's private ancestry is what the bridge's own
   * `checkDirectory` proves, so it has to exist first.
   *
   * One projection per attempt, not per task: an attempt id is the projection's final
   * path component, so a resume asks for the attempt it recorded and gets the bytes
   * that attempt was reviewed under, never today's source.
   */
  async produceManagedAttempt(runId: string, input: ProduceManagedAttemptInput): Promise<ProducedManagedAttempt> {
    // One production per attempt id, including while it is still starting. An attempt is
    // published as soon as it exists so a sibling retirement can see it, which means a duplicate
    // caller must wait for that production rather than receive a half-built endpoint: returning
    // the record while `listen` is still pending would hand out an endpoint that may never
    // listen, and a failed start would then delete the entry under the duplicate's feet.
    //
    // `producing` is the only gate for "one production per attempt id". `managedAttempts` holds
    // only endpoints that finished listening, so a duplicate can never receive a half-started one.
    const inFlight = this.producing.get(input.attemptId);
    if (inFlight) return inFlight;
    const settled = this.managedAttempts.get(input.attemptId);
    if (settled) return settled;
    const production = this.produceManagedAttemptOnce(runId, input);
    this.producing.set(input.attemptId, production);
    try {
      return await production;
    } finally {
      this.producing.delete(input.attemptId);
    }
  }

  private async produceManagedAttemptOnce(runId: string, input: ProduceManagedAttemptInput): Promise<ProducedManagedAttempt> {
    const roots = this.managedAttemptRoots?.();
    if (!roots) throw new Error("Managed attempt production is not configured");
    const { attemptId, worker } = input;
    // An attempt id reaches a filesystem path, so it is validated before admission
    // rather than trusted from whoever supplied it.
    if (![worker, runId, attemptId].every(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))) {
      throw new Error("Invalid managed attempt identity");
    }
    // The composition is the authority for every input it owns. A caller may still name
    // them, as contract allows, but only a value that agrees with the owner is accepted:
    // silently preferring either side would let a caller pick a seat, capability or identity the
    // run never recorded, which is exactly the grant this task exists to stop issuing twice.
    const owned = this.managedAttemptInputs;
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    const recorded = governance.findTask(runId, input.assignment.taskId);
    if (owned && !recorded) throw new Error("Managed attempt task is not recorded");
    // A seat is a recorded fact, not a caller's claim: the capability and the credential are
    // keyed on `(run, seat)`, so a produce for any other session would mint authority for a
    // seat this task does not have.
    if (recorded) {
      const item = this.queueRepo.getById(recorded.qitemId);
      if (!item || item.destinationSession !== input.sessionId) throw new Error("Managed attempt seat is not the task's destination");
    }
    // The endpoint's mailbox scope is the attempt's task, so the caller cannot name a different
    // one: a task id here that the recorded assignment does not have would register a mailbox
    // for a task this run never admitted.
    if (input.taskId !== input.assignment.taskId) throw new Error("Managed attempt task is not the assignment's task");
    /** The owner's value when it exists; a caller value that disagrees is refused. */
    const agree = <T>(field: string, claimed: T | undefined, owner: T | undefined): T | undefined => {
      if (claimed !== undefined && owner !== undefined && canonicalJson(claimed) !== canonicalJson(owner)) {
        throw new Error(`Managed attempt ${field} disagrees with the composition`);
      }
      return claimed ?? owner;
    };
    if (owned && input.readCredentials) throw new Error("Managed attempt credentials come from the composition");
    // The bridge reads this list on every request, so the token must be live before `listen`
    // writes the bootstrap. Issuance happens inside the try below, where a failure can revoke.
    const readCredentials = owned ? owned.readCredentials : input.readCredentials;
    if (!readCredentials) throw new Error("Managed attempt credentials are not configured");
    const mailboxCapability = agree("mailbox capability", input.mailboxCapability, owned?.mailboxCapability(runId, input.sessionId));
    if (mailboxCapability === undefined) throw new Error("Managed attempt mailbox capability is not configured");
    if (!/^mailbox:[A-Za-z0-9_-]{43}$/.test(mailboxCapability)) throw new Error("Invalid mailbox capability");
    // The identity owner answers the ownership questions a caller cannot: the gid the
    // projection and mailbox are created under, and the uid/groups the manifest uses to prove
    // the projection is worker-readable without being worker-writable.
    const identity = owned?.workerIdentity(worker);
    const workerGid = agree("worker gid", input.workerGid, identity?.gid);
    const workerUid = agree("worker uid", input.context.workerUid, identity?.uid);
    const workerGroups = agree("worker groups", input.context.workerGroups, identity?.groupIds);
    if (workerGid === undefined || workerUid === undefined || workerGroups === undefined) {
      throw new Error("Managed attempt worker identity is not configured");
    }
    const context = { ...input.context, workerUid, workerGroups };

    const admitted = this.admitForLaunch(runId, { attemptId, worker, assignment: input.assignment,
      outputs: input.outputs, permissions: input.permissions,
      context: { binding: this.managedBinding(runId), runId, role: input.role, workflow: context.workflow } as ContextManifest });
    const binding = governance.getRun(runId).binding;
    const root = resolve(roots.contextRoot, worker, runId, attemptId);
    // Declared outside the try because the failure path needs it: only a projection this
    // call created may be removed.
    let resumed = false;
    // The mailbox directory is created before `listen`, so the failure path needs the same
    // "did this call create it" answer the projection has.
    let mailboxDirectory = "";
    try {
      // Read before anything else can throw. The failure path below removes only a
      // projection this call created, and an earlier attempt's projection is run
      // evidence that must survive a later refusal — including one decided before the
      // projection work starts, such as a candidate mismatch.
      resumed = existsSync(root);
      // The tree the caller named has to be the one admission just handed this attempt.
      // Admission already resolved it — for a review launch that is the candidate under
      // review — so this compares against its answer rather than re-resolving here, which
      // would let the two disagree about whether a reviewer may create a tree.
      if (admitted.candidate !== input.candidate) {
        // The projection names the tree the worker will work in, so a caller that names
        // another tree would produce a context describing work that cannot happen.
        throw new Error("Managed attempt candidate mismatch");
      }
      // A projection already on disk belongs to the attempt that made it, so it is used
      // as it stands. A new one is created and sealed below.
      if (!resumed) ensureAttemptRoot(root, { contextRoot: roots.contextRoot, worker, workerGid });
      const manifest = this.projectAttemptContext({ runId, root, worker, attemptId, roots, binding,
        role: input.role, client: input.client, assignment: input.assignment, outputs: [...input.outputs],
        permissions: [...input.permissions], context,
        workerGid, frameworkFiles: input.frameworkFiles, resume: resumed,
        previousContextHash: input.previous?.attemptId === attemptId ? input.previous.contextHash : undefined });

      // An endpoint's path has to fit AF_UNIX's 108 bytes, and it is built from two UUIDs. A
      // provisioned host installs its mailbox root deep enough to afford that; the unisolated
      // root sits under the user's home, where two UUIDs do not. An attempt id is already unique
      // per attempt, so the run segment is what an unisolated endpoint can leave out — nothing
      // else reaches this directory, and the launcher that requires the four-segment shape is
      // not composed on this host.
      const mailboxDirectoryPath = this.sameIdentity
        ? resolve(roots.mailboxRoot, worker, attemptId)
        : resolve(roots.mailboxRoot, worker, runId, attemptId);
      const mailboxAtStart = existsSync(mailboxDirectoryPath);
      ensureMailboxDirectory(mailboxDirectoryPath,
        { mailboxRoot: roots.mailboxRoot, worker, controlStateDir: roots.controlStateDir }, this.sameIdentity);
      // Named only once this call has established the directory: the failure path removes it
      // only when this production created it.
      mailboxDirectory = mailboxAtStart ? "" : mailboxDirectoryPath;
      // A socket left by a daemon that died is still a file; the bridge refuses to
      // listen over one, so it is removed first. It can only ever be this attempt's,
      // because the path is built from the attempt id. A Windows named pipe needs no
      // such cleanup: it stops existing when its server closes, and a name that is
      // still served is refused rather than replaced.
      if (!isWindows()) {
        const staleSocket = resolve(mailboxDirectoryPath, MAILBOX_SOCKET_NAME);
        if (existsSync(staleSocket)) rmSync(staleSocket);
      }
      // Issued once, immediately before the endpoint that authenticates with it, and inside
      // the try so every later failure revokes it below. A token minted and then abandoned
      // would stay live for that seat with no endpoint to bound it.
      if (owned && !owned.hasCredential(runId, input.sessionId)) owned.issueCredential(runId, input.sessionId);
      const bridge = new WorkerMailboxBridge({ directory: mailboxDirectoryPath, workerId: worker, sessionId: input.sessionId,
        runId, attemptId, rigId: input.rigId, taskId: input.taskId, recipients: input.recipients,
        capability: mailboxCapability },
      input.delivery, input.chat, readCredentials, input.isCurrent);
      // Claimed for this seat before the endpoint awaits anything, so a sibling attempt retiring
      // during `listen` sees that this seat's credential is in use and does not revoke it. This
      // is a separate record from `managedAttempts` on purpose: that map is what a caller is
      // handed, and an attempt is only published there once its endpoint actually listens. A
      // half-started record in that map is what a duplicate caller would receive.
      const starting = { runId, sessionId: input.sessionId };
      this.startingAttempts.set(attemptId, starting);
      try {
        await bridge.listen();
      } catch (error) {
        this.startingAttempts.delete(attemptId);
        throw error;
      }
      const attempt: ManagedAttempt = { attemptId, deadline: input.deadline, context: manifest,
        ...(input.previous ? { previous: input.previous } : {}) };
      const produced = Object.freeze({ attempt, bridge, candidate: admitted.candidate, manifestDigest: admitted.manifestDigest });
      this.managedAttempts.set(attemptId, produced);
      this.startingAttempts.delete(attemptId);
      return produced;
    } catch (error) {
      // Only a fresh admission gives its claim back. An exact resume retained the previous
      // attempt's owner key, so releasing it here would delete that attempt's durable work.
      if (!input.previous) this.releaseCandidate(runId, input.assignment.taskId, attemptId);
      // A half-written projection would also wedge the attempt id for good: the next
      // produce would find the directory, treat it as a resume, and be refused for an
      // owner-writable root. Only a projection this call created is removed; one that
      // was already there belongs to an earlier attempt and is left as evidence.
      if (!resumed) removeAttemptRoot(root);
      // The mailbox directory is created before `listen`, and a failed listen leaves it behind.
      // Every attempt id is fresh, so a host that cannot bind the socket — as measured on this
      // one, where an AF_UNIX bind in a temp directory is refused — accumulated one directory
      // per retry and would have grown without bound. Only a directory this call created is
      // removed: an earlier attempt's is evidence, exactly as its projection is.
      if (mailboxDirectory !== "") removeMailboxDirectory(mailboxDirectory);
      // A credential for an attempt that never started is revoked here: the attempt has no
      // endpoint and no retirement path, so nothing else would ever bound it. The helper only
      // revokes when no sibling attempt of the seat remains, which is what keeps this from
      // taking a token a live attempt is using — including one a *sibling* minted.
      this.revokeSeatCredential(runId, input.sessionId, attemptId);
      throw error;
    }
  }

  /**
   * Revoke a seat's credential only when no other produced attempt of that seat remains.
   *
   * A seat has one credential, so a retirement or a failed production must not take the token a
   * live attempt is authenticating with. `except` names the attempt being removed, which is still
   * in the map while another attempt of the seat may be finishing its own endpoint.
   */
  private revokeSeatCredential(runId: string, sessionId: string, except: string): void {
    const held = (id: string, run: string, session: string) => id !== except && run === runId && session === sessionId;
    const shared = [...this.managedAttempts.entries()].some(([id, other]) =>
      held(id, other.bridge.binding.runId, other.bridge.binding.sessionId))
      || [...this.startingAttempts.entries()].some(([id, other]) => held(id, other.runId, other.sessionId));
    if (!shared) this.onManagedAttemptRetired?.({ runId, sessionId });
  }

  /**
   * Retire a produced attempt: close its endpoint and forget the projection.
   *
   * Closing is what removes the bootstrap and unlinks the socket, so a retired
   * attempt cannot be relaunched against a stale endpoint. The projection stays on
   * disk as run evidence, exactly as `projectContext` documents for failed attempts.
   */
  /**
   * Retire a produced attempt: close its endpoint and forget the projection.
   *
   * Closing is what removes the bootstrap and unlinks the socket, so a retired
   * attempt cannot be relaunched against a stale endpoint. The projection stays on
   * disk as run evidence, exactly as `projectContext` documents for failed attempts.
   */
  async retireManagedAttempt(attemptId: string): Promise<void> {
    const produced = this.managedAttempts.get(attemptId);
    if (!produced) return;
    this.managedAttempts.delete(attemptId);
    try {
      await produced.bridge.close();
    } finally {
      // The attempt's worker credential is revoked on the same retirement that closes its
      // endpoint, so the two never outlive each other. In `finally` because a throwing close
      // must not strand the token: by here the entry is gone and nothing else can reach it.
      this.revokeSeatCredential(produced.bridge.binding.runId, produced.bridge.binding.sessionId, attemptId);
    }
  }

  /** The attempt a seat's launch should attach, if this daemon produced one. */
  managedAttemptFor(attemptId: string): ProducedManagedAttempt | undefined {
    return this.managedAttempts.get(attemptId);
  }

  /**
   * Close every endpoint this daemon owns; a restart owns none of the old ones.
   *
   * A production that is still inside `listen` is not in `managedAttempts` yet, so it has
   * to be drained first — otherwise this returns while an endpoint is still coming up, and that
   * endpoint then publishes and keeps its credential alive past a close that reported success.
   * Awaiting each production settles it either way: a success lands in `managedAttempts` and the
   * loop below retires it; a failure has already cleaned itself up. Retiring before the await,
   * or in parallel with it, would let a success publish after its own retirement had run.
   */
  async closeManagedAttempts(): Promise<void> {
    await Promise.allSettled([...this.producing.values()]);
    await Promise.all([...this.managedAttempts.keys()].map(id => this.retireManagedAttempt(id)));
  }

  /** The approved binding, re-read so a producer call cannot be admitted against a stale one. */
  private managedBinding(runId: string) {
    return new PlanGovernance(this.db, this.eventBus, this.queueRepo).getRun(runId).binding;
  }

  /** Build the attempt's manifest; every entry is written private, read-only and hash-pinned. */
  private projectAttemptContext(input: {
    runId: string; root: string; worker: string; attemptId: string; workerGid: number;
    roots: NonNullable<ReturnType<NonNullable<WorkflowRuntimeDeps["managedAttemptRoots"]>>>;
    binding: PlanBinding; role: TeamRole; client: "claude-code" | "codex" | "gemini";
    assignment: AssignmentInput["assignment"]; outputs: string[]; permissions: string[];
    context: Omit<ContextInput, "root" | "projection" | "runId" | "files" | "binding" | "assignment"
      | "outputs" | "permissions" | "role" | "frameworkRoot" | "frameworkRevision" | "nativePolicy">;
    /** The pinned framework files this attempt loads, already resolved from the pin. */
    frameworkFiles: readonly { path: string; source: string }[];
    /** True when the projection root already exists: rebuild from its own recorded bytes. */
    resume: boolean;
    previousContextHash?: string;
  }): ContextManifest {
    const { roots, root, role, client } = input;
    const context = { ...input.context };
    const frameworkRoot = roots.frameworkRoot;
    // The projection holds more than instructions: the plan the approval bound, the
    // role configuration, the pinned framework entries, and the shared core
    // and this role's own charter. `createContextManifest` refuses a projection missing
    // any of them, which is the point: the producer cannot quietly omit what a worker
    // is supposed to follow, or substitute today's bytes for the approved ones.
    const write = (name: string, content: string, kind: ContextFile["kind"], source?: string): ContextFile => {
      const path = join(root, name);
      writeFileSync(path, content, { mode: 0o440 });
      chmodSync(path, 0o440);
      return { path, hash: hashBytes(content), kind, readOnly: true as const, ...(source ? { source } : {}) };
    };
    // The projected name keeps the framework entry's own relative path: the catalog is
    // `skills/<name>/SKILL.md`, so a basename would map every entry onto one file. The
    // name is confined to the attempt root, and the source to the pinned framework tree:
    // a caller-named path would otherwise be a write primitive into the boundary this
    // projection sits inside.
    const frameworkName = (path: string) => {
      const normalized = normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
      if (normalized !== path || normalized.startsWith("../") || isAbsolute(normalized)
        || !/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error("Invalid pinned framework entry path");
      return `framework/${normalized}`;
    };
    const frameworkEntries = () => input.frameworkFiles.flatMap(file => {
      if (!within(frameworkRoot, file.source) || realpathSync(file.source) !== resolve(file.source)) {
        throw new Error("Framework source is outside the pinned framework tree");
      }
      const name = frameworkName(file.path);
      mkdirSync(dirname(join(root, name)), { recursive: true, mode: 0o750 });
      return [write(name, readFileSync(file.source, "utf8"), "framework", file.source)];
    });
    let files: ContextFile[];
    if (input.resume) {
      // An existing projection is adopted as it stands. Rewriting it would fail: the
      // root is sealed and every entry is 0440. Descriptors are rebuilt from the bytes
      // that projection already recorded, and each framework entry keeps pointing at
      // the pinned framework source it was copied from — the manifest re-verifies that
      // source, so a projection copied into the attempt root could not stand in for it.
      files = readProjectedDescriptors(root, input.frameworkFiles);
      const recordedSoul = files.find(file => file.kind === "soul");
      if (recordedSoul) context.soul = JSON.parse(readFileSync(recordedSoul.path, "utf8")) as ContextInput["soul"];
      else delete context.soul;
      const recordedTeam = files.find(file => file.kind === "team");
      if (recordedTeam) context.teamSections = readFileSync(recordedTeam.path, "utf8");
      else delete context.teamSections;
      const recordedWorkflow = files.find(file => file.kind === "workflow");
      if (recordedWorkflow) context.workflow = JSON.parse(readFileSync(recordedWorkflow.path, "utf8")) as ContextInput["workflow"];
      else delete context.workflow;
    } else {
      files = [
        ...frameworkEntries(),
        write("plan", readFileSync(join(input.binding.repository.root, input.binding.planRef), "utf8"), "plan"),
        write("role", canonicalJson(roleConfiguration), "role"),
        ...roleInstructionEntries(role).map(([kind, content]) => write(kind, content, kind)),
        ...(context.soul ? [write("soul", canonicalJson(context.soul), "soul")] : []),
        ...(context.teamSections ? [write("team", context.teamSections, "team")] : []),
        ...(context.workflow ? [write("workflow", canonicalJson(context.workflow), "workflow")] : []),
        // A lead activation's roster and run instructions. The protocol entry is already
        // written above: `roleInstructionEntries("lead")` projects it as this role's charter,
        // and the manifest requires exactly one. A member role adds nothing here.
        ...(input.context.lead ? [
          write("roster", canonicalJson(input.context.lead.roster), "roster"),
          write("run", input.context.lead.instructions, "run"),
        ] : []),
      ];
      // Sealed only after the entries exist: the manifest refuses a projection root its
      // own owner could still write to, which is what stops anything being added to a
      // projection after it was hashed.
      chmodSync(root, 0o550);
    }
    // The launcher re-checks the whole projection read-only, and it refuses any directory
    // below the worker root that its owner can still write. Sealing only the attempt root
    // would leave every subdirectory (`framework/`, `native/`, …) writable, and the launch
    // would be refused as an unverified context source at the only policy revision a
    // provisioned host carries. So the seal covers everything this producer created.
    sealProjectionTree(root);
    // A resumed attempt is held to the bytes its own projection recorded; a new one must
    // also match today's pinned source. That difference is `recordedContextManifest`'s
    // whole purpose, and it is what keeps a later charter edit from breaking a resume.
    const build = input.resume ? recordedContextManifest : createContextManifest;
    // Sorted so a resumed attempt, whose descriptors come back in directory order, hashes
    // to the same manifest as the one that created it. The hash covers the file list, so
    // an order that depended on how the entries were produced would make every resume
    // look like a changed context.
    files.sort((left, right) => left.path.localeCompare(right.path));
    const input_ = {
      ...context,
      ...(this.sameIdentity ? { sameIdentity: true } : {}),
      runId: input.runId,
      role,
      client,
      binding: input.binding,
      assignment: { ...input.assignment, role },
      outputs: input.outputs,
      permissions: input.permissions,
      root,
      frameworkRoot,
      frameworkRevision: roots.frameworkRevision,
      projection: { worker: input.worker, attemptId: input.attemptId, controlUid: typeof process.getuid === "function" ? process.getuid() : 0,
        workerGid: input.workerGid,
        policy: { policy_revision: roots.policyRevision, worker_identities: [...roots.workerIdentities],
          paths: { context_root: roots.contextRoot, framework_dir: frameworkRoot },
          sandbox: { context: "/context", framework: "/framework" } } },
      files,
    } as ContextInput;
    const manifest = build(input_);
    if (input.resume && input.previousContextHash && manifest.generatedHash !== input.previousContextHash
      && input_.lead?.phase !== undefined && input_.lead.roster.length) {
      // Legacy attempts did not record phase. Adopt that representation only when
      // the complete hash matches this same attempt's receipt; all other checks stand.
      const lead = { ...input_.lead };
      delete lead.phase;
      const legacy = recordedContextManifest({ ...input_, lead });
      if (legacy.generatedHash === input.previousContextHash) return legacy;
    }
    return manifest;
  }

  /** Release a workspace this runtime owns, whichever path handed it back. */
  private removeWorkspace(workspace: CandidateWorkspace): void {
    try { removeCandidateWorkspace(workspace); } catch { /* A removed tree is already released. */ }
  }

  /**
   * The run's declared work graph, read from its own authority rows.
   *
   * The task being admitted contributes its approved assignment; every other task
   * the run recorded contributes what its row says it claims. A run with more than
   * the managed task limit therefore refuses at admission instead of being
   * discovered unusable later.
   *
   * Only **live** tasks can conflict on a write path. A finished task's claim is
   * history: the work is over, and a later task may legitimately re-touch the same
   * file. Its row still contributes its dependency edges — cycle detection and the
   * task limit are properties of the whole run, not of its live fringe — but it
   * contributes no claim. This is the same "other live tasks" contract
   * `admitTeamAssignment` states for its caller-supplied graph.
   */
  private runGraph(runId: string, bindingDigest: string, admitted: AssignmentInput["assignment"]): GraphTask[] {
    const rows = this.db.prepare(
      `SELECT a.task_id AS taskId, a.assignment_json AS assignment, q.state AS state,
         COALESCE(json_extract(a.workflow_json, '$.readOnly'), 0) AS readOnly
       FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
       WHERE a.run_id = ?`)
      .all(runId) as { taskId: string; assignment: string; state: string; readOnly: number }[];
    // The repository already names this set: `blocked` is still in play (it can
    // resume), while `handed-off` is terminal, so a local list would both miss a
    // live claim and keep a finished one.
    const live = (state: string) => (ACTIVE_QUEUE_STATES as readonly string[]).includes(state);
    const extensions = new ScopeExtensions(this.db);
    const extended = (taskId: string) => extensions.records(runId, taskId)
      .filter(record => record.state === "approved" && record.bindingDigest === bindingDigest)
      .flatMap(record => record.paths.flatMap(path => [path.path, path.canonicalPath]));
    const tasks = rows.map(row => {
      const assignment = JSON.parse(row.assignment) as { role?: string; paths?: string[]; dependencies?: string[] };
      return { taskId: row.taskId, role: assignment.role ?? admitted.role, readOnly: row.readOnly === 1,
        // A settled task keeps its edges but drops its claim.
        paths: live(row.state) ? [...(assignment.paths ?? []), ...extended(row.taskId)] : [],
        dependencies: [...(assignment.dependencies ?? [])] };
    });
    // The admitted assignment wins over its stored row: a stale row would otherwise
    // let an earlier, narrower claim stand in for the one about to launch.
    return [...tasks.filter(task => task.taskId !== admitted.taskId),
      { taskId: admitted.taskId, role: admitted.role, readOnly: tasks.find(task => task.taskId === admitted.taskId)?.readOnly,
        paths: [...admitted.paths, ...extended(admitted.taskId)], dependencies: [...admitted.dependencies] }];
  }

  reviewState(runId: string, taskId: string) {
    return this.reviewEvidence.state(runId, taskId);
  }

  /** Record the candidate the daemon issued; the only writer that moves the current candidate. */
  issueReviewCandidate(runId: string, rigId: string, taskId: string, identity: CandidateIdentity) {
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.issue({ runId, rigId, taskId, identity, register }));
  }

  /**
   * Record a reviewer's findings.
   *
   * The reviewer is named by its queue item and resolved against the run's own
   * authority rows. The write itself consults the progress gate, so a round the
   * gate refuses is not recorded rather than merely advised against.
   */
  recordReviewEvidence(runId: string, rigId: string, input: Omit<Parameters<ReviewEvidenceLedger["record"]>[0], "runId" | "rigId" | "register">) {
    // Limits and the run clock are read from run state by the ledger's own deps,
    // so no clock figure reaches the write path from a request.
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.record({ ...input, runId, rigId, register }));
  }

  /** Record integrated acceptance for the candidate the task currently holds. */
  recordReviewAcceptance(runId: string, rigId: string, taskId: string, manifestDigest: string, passed: boolean, reason: string) {
    return this.events.withNotifyEnvelope(register =>
      this.reviewEvidence.accept({ runId, rigId, taskId, manifestDigest, passed, reason, register }));
  }

  /** Record that the candidate moved, retiring every earlier review. */
  recordReviewRework(runId: string, rigId: string, taskId: string, identity: CandidateIdentity) {
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.rework({ runId, rigId, taskId, identity, register }));
  }

  /** single diagnosed recoverable retry, counted from durable state. */
  recordReviewRetry(runId: string, rigId: string, taskId: string, reasonCode: string, resumeSafe: boolean) {
    return this.events.withNotifyEnvelope(register => this.reviewEvidence.retry({ runId, rigId, taskId, reasonCode, resumeSafe, register }));
  }

  /**

  /**
   * The two decisions a task's delivery depends on: may another review
   * round start, and is the task deliverable at all. Both are computed here so a
   * caller cannot take a lenient answer from one and cite the other.
   *
   * The remaining clock is read from the run's own binding rather than accepted
   * from the caller, so the time check cannot be switched off by omission.
   */
  reviewProgress(runId: string, taskId: string) {
    const state = this.reviewEvidence.state(runId, taskId);
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo);
    const scope = governance.findTask(runId, taskId) ? governance.scopeForTask(runId, taskId) : undefined;
    return { state, gate: this.progressGate(runId, state), delivery: { ...deliveryVerdict({ state }), ...(scope ? { scope } : {}) } };
  }

  /**
   * The gate, with its clock derived from the run's own accounting.
   *
   * `active_ms` advances only when a control command runs, so the interval since
   * the last accounting point must be deducted too; otherwise a live attempt
   * would make the run look slower than it is and over-report the time left.
   */
  private progressGate(runId: string, state: ReturnType<ReviewEvidenceLedger["state"]>) {
    const run = new PlanGovernance(this.db, this.eventBus, this.queueRepo).getRun(runId);
    const live = run.accountedAt === null ? 0 : Math.max(0, this.now().getTime() - Date.parse(run.accountedAt));
    const remainingActiveMs = Math.max(0, run.binding.limits.maxActiveMs - run.activeMs - live);
    return evaluateProgressGate({ state, maxRounds: run.binding.limits.maxReviewRounds, remainingActiveMs,
      longestRoundMs: state.longestRoundMs });
  }


  /**
   * The launcher's full preparation path.
   *
   * The launcher holds the post-preflight assignment, but it must not call
   * `prepareTeamAssignment` itself: the runtime is what supplies the approved
   * binding and the validated-evidence dependency check. This is the same
   * method the lead-activation path uses, so a managed launch cannot observe a
   * different set of rules than any other production caller.
   */
  prepareLaunchAssignment(input: Omit<AssignmentInput, "binding" | "dependencySatisfied">) {
    return this.prepareTeamAssignment(input.context.runId, input);
  }

  prepareTeamAssignment(runId: string, input: Omit<AssignmentInput, "binding" | "dependencySatisfied">) {
    const { governance, run } = this.approvedRunForAssignment(runId, input.context.runId, input.currentBinding);
    const dependencySatisfied = (taskId: string) => this.dependencySatisfied(governance, runId, taskId);
    return prepareTeamAssignment({ ...input, binding: run.binding, dependencySatisfied });
  }

  /**
   * Admit a task onto the run's work graph.
   *
   * The caller declares what this task claims and depends on plus the claims of
   * the run's other live tasks. The merged graph must hold before the task is
   * prepared, so an unknown edge, a cycle, or a write path two tasks both claim
   * is refused here rather than discovered as work that cannot finish.
   *
   * A caller that supplies no `graph` keeps the previous behavior; the graph is
   * an addition to the launch boundary, not a new precondition on every caller.
   */
  async admitTeamAssignment(runId: string, input: Omit<AssignmentInput, "binding" | "dependencySatisfied" | "taskPack"> & {
    taskPack?: AssignmentInput["taskPack"];
    graph?: { claimedBy: readonly GraphTask[]; declared: { paths: readonly string[]; dependencies: readonly string[] } };
  }) {
    if (input.graph) {
      const { declared, claimedBy } = input.graph;
      const verdict = validateDependencyGraph([...claimedBy.filter(task => task.taskId !== input.assignment.taskId), {
        taskId: input.assignment.taskId,
        role: input.assignment.role,
        readOnly: input.context.workflow?.readOnly,
        paths: [...declared.paths],
        dependencies: [...declared.dependencies],
      }]);
      if (!verdict.ok) throw new Error(`Dependency graph refused: ${verdict.reason}`);
    }
    return this.prepareTeamAssignment(runId, input);
  }

  /**
   * A dependency is satisfied only by evidence-backed completion.
   *

  /** A dependency is satisfied only by evidence-backed completion: the same test the
   *  launch preflight applies, read from this run's own authority rows. */
  private dependencySatisfied(governance: PlanGovernance, runId: string, taskId: string): boolean {
    return dependencySatisfied(this.db, this.queueRepo, qitemId => governance.getTask(qitemId)?.evidence?.validated === true, runId, taskId);
  }
  async startLeadActivation(manifest: ContextManifest, observed: ContextObservation, currentBinding: AssignmentInput["currentBinding"]) {
    await this.prepareTeamAssignment(manifest.runId, { currentBinding, assignment: manifest.assignment, outputs: manifest.outputs, permissions: manifest.permissions, context: manifest, observed });
    return new LeadActivation(manifest, observed);
  }


  private approvedRunForAssignment(runId: string, contextRunId: string, currentBinding: PlanBinding) {
    const governance = new PlanGovernance(this.db, this.eventBus, this.queueRepo), run = governance.getRun(runId);
    if (run.state !== "approved" || contextRunId !== runId || hashBinding(run.binding) !== hashBinding(currentBinding)) {
      throw new Error("Run is not approved for this assignment");
    }
    return { governance, run };
  }

  /** Who the run recorded for a queue item: the role from the task's authority
   *  assignment and the session from the queue row, never from a caller's string. */
  private resolveAssignee(runId: string, qitemId: string): AssigneeFacts | null {
    const row = this.db.prepare(`SELECT a.assignment_json AS assignment, q.destination_session AS session
      FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
      WHERE a.run_id = ? AND a.qitem_id = ?`).get(runId, qitemId) as { assignment: string; session: string } | undefined;
    if (!row) return null;
    const assignment = JSON.parse(row.assignment) as { taskId?: unknown; role?: unknown };
    if (typeof assignment.taskId !== "string") return null;
    return { session: row.session, taskId: assignment.taskId, role: assignment.role as TeamRole };
  }

  constructor(deps: WorkflowRuntimeDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.now = deps.now ?? (() => new Date());
    this.events = deps.eventBus;
    this.candidateRoot = deps.candidateRoot;
    this.assignmentRoot = deps.assignmentRoot;
    this.candidateRecordsRoot = deps.candidateRecordsRoot;
    this.defaultWorker = deps.defaultWorker;
    this.managedAttemptRoots = deps.managedAttemptRoots;
    this.managedAttemptInputs = deps.managedAttemptInputs;
    this.onManagedAttemptRetired = deps.onManagedAttemptRetired;
    this.sameIdentity = deps.sameIdentity === true;
    this.reviewEvidence = new ReviewEvidenceLedger({ db: this.db, events: deps.eventBus, now: this.now,
      resolveAssignee: (runId, qitemId) => this.resolveAssignee(runId, qitemId),
      // The approved binding's limits and the run's own clock, read at write time.
      limits: runId => {
        const run = new PlanGovernance(this.db, deps.eventBus, deps.queueRepo).getRun(runId);
        return { maxRetries: run.binding.limits.maxRetries, maxReviewRounds: run.binding.limits.maxReviewRounds };
      },
      clock: runId => {
        const run = new PlanGovernance(this.db, deps.eventBus, deps.queueRepo).getRun(runId);
        const live = run.accountedAt === null ? 0 : Math.max(0, this.now().getTime() - Date.parse(run.accountedAt));
        return { remainingActiveMs: Math.max(0, run.binding.limits.maxActiveMs - run.activeMs - live) };
      } });
  }
}
