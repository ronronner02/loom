import { tmpdir } from "node:os";
import { recordedControlReceipt } from "./attempt-finalization.js";
import { documentDispatchRefusal } from "./project-documents.js";
import { deliveryReadiness, type DeliveryReadiness } from "./delivery-readiness.js";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import type Database from "better-sqlite3";
import { TEAM_CONTROL_VERSION, type TeamRun } from "../contracts/team-control.js";
import type { PlanGovernance } from "./plan-governance.js";
import { ensurePlanWorktree, planWorktreePath, runSlug } from "./plan-branch.js";
import { checkedOutBranch, type SourceRefMove } from "./team-workspace.js";

/**
 * The branch the run's approved work lands on, and the owner's one merge.
 *
 * Every task whose review approves lands as one commit on `team/<run-slug>`, in the
 * daemon-owned worktree already created for the run. The owner's checkout is never written
 * here; the merge is the only step that goes back into it, and it is the owner's own action.
 *
 * The hard part is what an in-flight candidate means once the branch moves. Two tasks start
 * from the same head; the first approval commits and moves it. The second task's candidate was
 * staged at the old head, and is still exactly the work its reviewer approved — so its patch is
 * applied to the new head with `git apply --3way`, and the base it recorded is kept as the
 * candidate's own record. Only a new task is staged from the new head (the runtime asks this
 * module's record which worktree is the delivery base). A candidate is refused as moved only
 * when the owner's own source changed, which is the check `verifySourceUnchanged` still makes.
 *
 * A patch is first applied to a temporary index. A conflict leaves the branch untouched; a
 * successful tree is recorded as an immutable intent before the live worktree changes. A
 * restart reconciles that exact tree and message rather than applying the candidate twice.
 */

export interface IntegrationCommit {
  /** The short hash, as the owner reads it. */
  hash: string;
  subject: string;
  /** The run's own task id, so the owner can tie a commit to the work it carries. */
  task: string;
}

export interface IntegrationStatus {
  runId: string;
  branch: string;
  repository: string | null;
  worktree: string | null;
  commits: IntegrationCommit[];
  /** Every task the run admitted as work has finished; a merge is not refused for an open one. */
  tasksDone: boolean;
  merge: { possible: boolean; reason: string | null; merged: boolean | null };
}

export interface MergeOutcome {
  status: "merged" | "refused";
  code: string | null;
  reason: string | null;
  /**
   * On a refusal, whether waiting can clear it. A delivery still landing is transient; a dirty
   * checkout, a detached head or a conflict is the owner's to act on. Every outcome names one,
   * so a caller never has to decode `code` itself.
   */
  transient: boolean;
  branch: string;
  mode: "fast-forward" | "merge-commit" | "up-to-date" | "pull-request" | null;
  head: string | null;
}

export interface IntegrationResult {
  taskId: string;
  status: "committed" | "already-integrated" | "nothing-to-commit" | "conflict" | "skipped";
  commitSha: string | null;
  reason: string | null;
}

export interface IntegrationDeps {
  db: Database.Database;
  governance: PlanGovernance;
  /** Where the daemon's per-run worktrees live: the same root plan worktree uses. */
  worktreeRoot: () => string;
  /** The candidate's own patch and manifest, the way `loom team apply` and the result read take it. */
  candidateManifest: (runId: string, taskId: string) => {
    base: "commit" | "snapshot"; baseIdentifier: string; patch: string; manifestDigest: string };
  /**
   * The run's current binding, read the way every control command reads it. Absent leaves the
   * recorded binding in place, which is right for a run bound to the owner's checkout: its
   * repository identity does not move when the daemon commits elsewhere.
   */
  currentBinding?: (runId: string) => unknown;
  sourceRefMoved?: (repository: string, move: SourceRefMove) => void;
  log?: (message: string) => void;
}

export interface Integration {
  /** Land one approved task's patch on the run's branch. Serialised: one branch, one writer. */
  integrate(runId: string, taskId: string): Promise<IntegrationResult>;
  /** The branch, the commits on it, and whether the owner can merge now. Writes nothing. */
  status(runId: string): IntegrationStatus;
  /** Merge the branch into the owner's checkout. The owner's one delivery action. */
  merge(runId: string): MergeOutcome;
}

/** The daemon's own commit identity on the integration branch, as plan commits use. */
const DAEMON_GIT_ENV = { GIT_AUTHOR_NAME: "loom", GIT_AUTHOR_EMAIL: "loom@localhost",
  GIT_COMMITTER_NAME: "loom", GIT_COMMITTER_EMAIL: "loom@localhost" };

function git(cwd: string, args: readonly string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8", input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 120_000,
    env: { ...process.env, ...DAEMON_GIT_ENV, ...extraEnv } });
}

function gitOrNull(cwd: string, args: readonly string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

function headOf(root: string): string {
  return git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean | null {
  try { git(root, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { return (error as { status?: number }).status === 1 ? false : null; }
}

/** Anything uncommitted in a checkout. Untracked files are the owner's own drafts. */
function dirty(root: string): boolean {
  return git(root, ["status", "--porcelain=v1", "--untracked-files=no"]).trim() !== "";
}

/** The most useful lines of a failed git command, for the recorded conflict reason. */
function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr;
  const text = (typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? "").trim();
  const informative = text.split("\n").map(line => line.trim())
    .filter(line => line && !/^hint:/i.test(line) && !/^warning:/i.test(line));
  return (informative.slice(0, 3).join("; ") || (error as Error).message).slice(0, 500);
}

/** The commit the run's plan was read at, when the binding names one. */
function baseCommit(run: TeamRun): string | undefined {
  const identity = run.binding.repository.identity;
  return identity.startsWith("git:") ? identity.slice(4) : undefined;
}

/** The branch and worktree this run delivers onto. */
interface Target { repository: string; worktree: string; branch: string }

interface IntegrationIntent extends Target {
  runId: string; taskId: string; parentSha: string; treeSha: string; subject: string; message: string; repairReason: string | null;
}

export class IntegrationRepairRequired extends Error {
  readonly code = "integration_repair_required";
  constructor(readonly runId: string, readonly taskId: string, readonly reason: string) {
    super(`Integration of ${taskId} requires repair: ${reason}`);
    this.name = "IntegrationRepairRequired";
  }
}

/** Build immutable Git objects without changing the live index or worktree before the intent commits. */
function frozenIntegrationTree(worktree: string, parentSha: string, patch: string): string {
  const directory = mkdtempSync(join(tmpdir(), "loom-integration-"));
  const env = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    git(worktree, ["read-tree", parentSha], undefined, env);
    git(worktree, ["apply", "--cached", "--3way", "-"], patch, env);
    return git(worktree, ["write-tree"], undefined, env).trim();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Match the exact first-parent child, not a display name or a branch's later tip. */
function integrationWitness(intent: IntegrationIntent): string | null {
  const ref = `refs/heads/${intent.branch}`;
  const tip = git(intent.repository, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const branch = git(intent.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== intent.branch) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The integration worktree is no longer on its recorded branch");
  if (headOf(intent.worktree) !== tip) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The recorded repository and worktree disagree about the branch head");
  if (tip === intent.parentSha) return null;
  const commits = git(intent.repository, ["rev-list", "--first-parent", "--reverse", `${intent.parentSha}..${ref}`]).trim();
  const sha = commits ? commits.split("\n")[0]! : null;
  if (!sha) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The integration branch moved behind the recorded parent");
  const object = git(intent.repository, ["cat-file", "commit", sha]);
  const separator = object.indexOf("\n\n");
  if (separator < 0) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The recovery commit is malformed");
  const headers = object.slice(0, separator).split("\n");
  const parents = headers.filter(line => line.startsWith("parent ")).map(line => line.slice(7));
  const tree = headers.find(line => line.startsWith("tree "))?.slice(5);
  if (parents.length !== 1 || parents[0] !== intent.parentSha) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The recorded parent is not the first-parent predecessor of the recovery commit");
  if (tree !== intent.treeSha || object.slice(separator + 2) !== intent.message) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The recovery commit differs from the recorded tree or message");
  return sha;
}

function commitIntegrationIntent(intent: IntegrationIntent): string {
  const existing = integrationWitness(intent);
  if (existing) return existing;
  const worktree = intent.worktree;
  const parentTree = git(worktree, ["rev-parse", `${intent.parentSha}^{tree}`]).trim();
  const stagedTree = git(worktree, ["write-tree"]).trim();
  if (git(worktree, ["diff", "--name-only", "--"]).trim()) {
    throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The integration worktree has unstaged changes");
  }
  if (stagedTree !== parentTree && stagedTree !== intent.treeSha) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The integration index differs from both the parent and intended tree");
  // The two-tree update retains collision checks; it does not reset unrelated files.
  if (stagedTree === parentTree) git(worktree, ["read-tree", "-m", "-u", parentTree, intent.treeSha]);
  if (git(worktree, ["write-tree"]).trim() !== intent.treeSha) throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The staged integration tree differs from its intent");
  if (git(worktree, ["diff", "--name-only", "--"]).trim()) {
    throw new IntegrationRepairRequired(intent.runId, intent.taskId, "The integration worktree has unstaged changes");
  }
  let commitFailure: unknown;
  try { git(worktree, ["commit", "--quiet", "--cleanup=verbatim", "--file=-"], intent.message); }
  catch (error) { commitFailure = error; }
  const committed = integrationWitness(intent);
  if (committed) return committed;
  if (commitFailure !== undefined) throw new Error(`Git commit failed: ${gitFailure(commitFailure)}`);
  throw new Error("Git commit returned without creating the intended commit");
}

export function composeIntegration(deps: IntegrationDeps): Integration {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const governance = deps.governance;
  // The branch has one writer. An integration waits for the one before it rather than racing it,
  // and a failed one never stops the queue behind it.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => T): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const readIntent = (runId: string, taskId: string): IntegrationIntent | undefined => deps.db.prepare(`
    SELECT run_id AS runId, task_id AS taskId, repository, worktree, branch, parent_sha AS parentSha,
      tree_sha AS treeSha, subject, message, repair_reason AS repairReason FROM team_integration_intents
    WHERE run_id = ? AND task_id = ?`).get(runId, taskId) as IntegrationIntent | undefined;

  const requireRepair = (intent: IntegrationIntent, reason: string): never => {
    deps.db.prepare("UPDATE team_integration_intents SET repair_reason = ? WHERE run_id = ? AND task_id = ?")
      .run(reason, intent.runId, intent.taskId);
    throw new IntegrationRepairRequired(intent.runId, intent.taskId, reason);
  };

  const recordCommittedIntent = (intent: IntegrationIntent, commitSha: string): IntegrationResult => {
    const key = `daemon-integration-commit:${intent.taskId}:${commitSha}`;
    const prior = recordedControlReceipt(deps.db, intent.runId, key);
    if (prior) return requireRepair(intent, `The integration has a ${prior.status} receipt but no completed record: ${prior.reason ?? "inconsistent storage"}`);
    let binding: unknown;
    try { binding = deps.currentBinding?.(intent.runId); }
    catch (error) { log(`team integration: binding refresh after ${commitSha} failed: ${error instanceof Error ? error.message : String(error)}`); }
    // A SQLite failure leaves the Git intent resumable, never a candidate conflict.
    const receipt = governance.recordIntegrationCommit({
      protocolVersion: TEAM_CONTROL_VERSION, runId: intent.runId, actionId: intent.taskId,
      expectedEntityVersion: governance.getRun(intent.runId).entityVersion, idempotencyKey: key,
      payload: { taskId: intent.taskId, commitSha, subject: intent.subject, branch: intent.branch,
        worktree: intent.worktree, repository: intent.repository, ...(binding === undefined ? {} : { binding }) },
    }, { kind: "daemon", sessionId: "daemon" });
    if (receipt.status !== "observed") return requireRepair(intent, `The commit exists but its recording was ${receipt.status}: ${receipt.reason}`);
    return { taskId: intent.taskId, status: "committed", commitSha, reason: null };
  };

  const finishIntent = (intent: IntegrationIntent): IntegrationResult => {
    if (intent.repairReason !== null) throw new IntegrationRepairRequired(intent.runId, intent.taskId, intent.repairReason);
    let commitSha: string;
    try { commitSha = commitIntegrationIntent(intent); }
    catch (error) {
      if (error instanceof IntegrationRepairRequired) return requireRepair(intent, error.reason);
      throw error;
    }
    return recordCommittedIntent(intent, commitSha);
  };

  /** The run's branch name. The record holds it once something landed; the slug derives it before. */
  const branchOf = (run: TeamRun): string =>
    governance.integrationRecord(run.id).branch ?? runSlug({ runId: run.id, name: run.displayName });

  /**
   * The owner's repository — the checkout `loom team merge` writes into.
   *
   * A planning run's binding root is already the run's own worktree, so the owner's repository
   * is the one that worktree was added to: a linked worktree's common git directory lives in
   * the main working tree. A run bound anywhere else is bound in the owner's checkout itself.
   */
  const repositoryOf = (run: TeamRun): string => {
    const recorded = governance.integrationRecord(run.id).repository;
    if (recorded !== null) return recorded;
    const root = realpathSync(run.binding.repository.root);
    const planned = planWorktreePath(deps.worktreeRoot(), run.id);
    if (checkedOutBranch(root) !== branchOf(run) && (!existsSync(planned) || realpathSync(planned) !== root)) return root;
    const common = git(root, ["rev-parse", "--git-common-dir"]).trim();
    return dirname(isAbsolute(common) ? common : resolve(root, common));
  };

  /** The run's worktree, creating it at the run's base commit when the run has none yet. */
  const targetOf = (run: TeamRun): Target => {
    const recorded = governance.integrationRecord(run.id);
    if (recorded.worktree !== null && recorded.repository !== null && existsSync(recorded.worktree)) {
      return { repository: recorded.repository, worktree: recorded.worktree, branch: recorded.branch ?? branchOf(run) };
    }
    const repository = repositoryOf(run);
    const created = ensurePlanWorktree({ repositoryRoot: repository, worktreeRoot: deps.worktreeRoot(),
      runId: run.id, name: run.displayName, base: baseCommit(run) });
    return { repository, worktree: created.path, branch: created.branch };
  };

  /** Local checkout restrictions apply only after shared delivery readiness. */
  const readiness = (run: TeamRun, delivery: DeliveryReadiness): { possible: boolean; reason: string | null } => {
    if (!delivery.possible) return { possible: false, reason: delivery.reason };
    let repository: string;
    try { repository = repositoryOf(run); } catch (error) { return { possible: false, reason: (error as Error).message }; }
    if (!existsSync(repository)) return { possible: false, reason: "The owner's repository is not on this machine." };
    if (dirty(repository)) return { possible: false, reason: "The owner's checkout has uncommitted changes." };
    if (checkedOutBranch(repository) === null) return { possible: false, reason: "The owner's checkout has no branch checked out." };
    if (gitOrNull(repository, ["rev-parse", "--verify", `refs/heads/${branchOf(run)}`]) === null) {
      return { possible: false, reason: "The integration branch does not exist yet." };
    }
    return { possible: true, reason: null };
  };

  /**
   * Record that the approved work could not land.
   *
   * The task is failed through the same observed-outcome command every daemon outcome uses, with
   * the reason code that names this case, so a reader — and the lead's wake policy — sees one
   * kind of failure whichever half of the run failed. A failure to record it is logged rather
   * than thrown: the caller is a sweep, and a throw there would stop the next tick.
   */
  const conflict = (runId: string, task: { qitemId: string; assignment: { taskId: string } }, reason: string): IntegrationResult => {
    const attempt = governance.getLatestTaskAttempt(task.qitemId);
    const actorSession = governance.taskSeat(task.qitemId);
    const current = governance.getTask(task.qitemId);
    if (attempt === null || actorSession === null || current === null) {
      log(`team integration: ${task.assignment.taskId} did not apply and has no stopped attempt to record it against: ${reason}`);
      return { taskId: task.assignment.taskId, status: "conflict", commitSha: null, reason };
    }
    const outcome = governance.recordTaskOutcome({
      protocolVersion: TEAM_CONTROL_VERSION, runId, actionId: task.qitemId,
      expectedEntityVersion: governance.getRun(runId).entityVersion,
      idempotencyKey: `daemon-integration-conflict:${task.assignment.taskId}`,
      payload: { expectedTaskVersion: current.entityVersion, state: "failed", actorSession, attemptId: attempt.id,
        expectedAttemptVersion: attempt.entityVersion,
        evidence: { ...(current.evidence ?? {}), reasonCode: "integration_conflict", integrationConflict: reason },
        transitionNote: `Integration conflict: ${reason}` },
    }, { kind: "daemon", sessionId: "daemon" });
    if (outcome.status !== "observed" && !outcome.replayed) {
      log(`team integration: ${task.assignment.taskId} did not apply and the failure was not recorded: ${outcome.reason ?? outcome.status}`);
    }
    return { taskId: task.assignment.taskId, status: "conflict", commitSha: null, reason };
  };

  /** Freeze one candidate's intended commit before touching the live integration worktree. */
  const land = (run: TeamRun, task: { qitemId: string; assignment: { taskId: string } }, patch: string, target: Target): IntegrationResult => {
    let intent: IntegrationIntent;
    try {
      const branch = checkedOutBranch(target.worktree);
      if (branch === null) throw new Error("The integration worktree has no checked-out branch");
      if (dirty(target.worktree)) throw new Error("The integration worktree has uncommitted changes");
      const parentSha = headOf(target.worktree);
      const treeSha = frozenIntegrationTree(target.worktree, parentSha, patch);
      const subject = governance.taskDisplayName(task.qitemId) ?? task.assignment.taskId;
      intent = { ...target, branch, runId: run.id, taskId: task.assignment.taskId, parentSha, treeSha, subject,
        message: `${subject}\n\nRun: ${run.displayName}\nTask: ${task.assignment.taskId}\n`, repairReason: null };
    } catch (error) { return conflict(run.id, task, gitFailure(error)); }
    deps.db.prepare(`INSERT INTO team_integration_intents (run_id, task_id, repository, worktree, branch,
      parent_sha, tree_sha, subject, message, repair_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(intent.runId, intent.taskId, intent.repository, intent.worktree, intent.branch, intent.parentSha,
        intent.treeSha, intent.subject, intent.message, new Date().toISOString());
    return finishIntent(intent);
  };

  const integrateOne = (runId: string, taskId: string): IntegrationResult => {
    const run = governance.getRun(runId);
    // A canceled or invalidated run delivers nothing: its approval no longer covers new work.
    if (run.state === "cancel_requested" || run.state === "canceled" || run.state === "invalidated") {
      return { taskId, status: "skipped", commitSha: null, reason: `run is ${run.state}` };
    }
    const task = governance.findTask(runId, taskId);
    if (!task || task.assignment.role !== "implementer") {
      return { taskId, status: "skipped", commitSha: null, reason: "not this run's implementer task" };
    }
    const documentError = documentDispatchRefusal(deps.db, run, "implementer", taskId);
    if (documentError) return { taskId, status: "skipped", commitSha: null, reason: documentError };
    if (governance.integrationRecord(runId).commits.some(commit => commit.taskId === taskId)) {
      return { taskId, status: "already-integrated", commitSha: null, reason: null };
    }
    if (governance.queueState(task.qitemId) !== "done") {
      return { taskId, status: "skipped", commitSha: null, reason: "the task has no completed outcome" };
    }
    const pending = readIntent(runId, taskId);
    if (pending) return finishIntent(pending);
    let manifest;
    try { manifest = deps.candidateManifest(runId, taskId); } catch (error) {
      return conflict(runId, task, `the task's candidate could not be read: ${(error as Error).message}`);
    }
    if (manifest.base !== "commit") {
      return conflict(runId, task, "the repository has no commit for the work to be applied to");
    }
    // A task that changed nothing has nothing to land; its absence from the commit list is the
    // honest record of that, and nothing is committed for it.
    if (manifest.patch.trim() === "") return { taskId, status: "nothing-to-commit", commitSha: null, reason: null };
    let target: Target;
    try { target = targetOf(run); } catch (error) {
      return conflict(runId, task, `the run's integration worktree could not be prepared: ${(error as Error).message}`);
    }
    return land(run, task, manifest.patch, target);
  };

  return {
    integrate: (runId, taskId) => serial(() => integrateOne(runId, taskId)),

    status(runId) {
      const run = governance.getRun(runId);
      const recorded = governance.integrationRecord(runId);
      const delivery = deliveryReadiness(deps.db, run, recorded.commits.length);
      let repository: string | null = null;
      try { repository = repositoryOf(run); } catch { /* reported by merge, not by a read */ }
      const derived = planWorktreePath(deps.worktreeRoot(), run.id);
      const branch = branchOf(run);
      const ownerBranch = repository === null ? null : checkedOutBranch(repository);
      const ownerHead = repository === null ? null : gitOrNull(repository, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
      // Read Git each time: later owner commits preserve delivery, but another checkout may not.
      const merged = recorded.commits.length === 0 ? false
        : repository !== null && ownerBranch !== null && ownerBranch !== branch && ownerHead
          ? isAncestor(repository, `refs/heads/${branch}`, ownerHead) : null;
      return {
        runId, branch, repository,
        worktree: recorded.worktree ?? (existsSync(derived) ? derived : null),
        commits: recorded.commits.map(commit => ({ hash: commit.commitSha.slice(0, 7), subject: commit.subject, task: commit.taskId })),
        tasksDone: delivery.tasksDone,
        merge: { ...readiness(run, delivery), merged },
      };
    },

    merge(runId) {
      const run = governance.getRun(runId);
      const branch = branchOf(run);
      const refuse = (code: string, reason: string, transient = false): MergeOutcome =>
        ({ status: "refused", code, reason, transient, branch, mode: null, head: null });
      const delivery = deliveryReadiness(deps.db, run, governance.integrationRecord(runId).commits.length);
      if (!delivery.possible) return refuse(delivery.code, delivery.reason, delivery.transient);
      let repository: string;
      try { repository = repositoryOf(run); } catch (error) { return refuse("merge_unavailable", (error as Error).message); }
      if (!existsSync(repository)) return refuse("merge_unavailable", "The owner's repository is not on this machine.");
      const current = checkedOutBranch(repository);
      if (current === null) return refuse("merge_detached_head", "The owner's checkout has no branch checked out; check one out and merge again.");
      if (current === branch) return refuse("merge_already_on_branch", "The owner's checkout is already on the integration branch.");
      if (dirty(repository)) return refuse("merge_checkout_dirty", "The owner's checkout has uncommitted changes; commit or stash them and merge again.");
      if (gitOrNull(repository, ["rev-parse", "--verify", `refs/heads/${branch}`]) === null) {
        return refuse("merge_no_branch", "The integration branch does not exist yet.");
      }
      const before = headOf(repository);
      const merged = (mode: "fast-forward" | "merge-commit"): MergeOutcome => {
        const head = headOf(repository);
        try { deps.sourceRefMoved?.(repository, { ref: `refs/heads/${current}`, before, after: head }); }
        catch (error) { log(`team integration: candidate source refresh failed: ${(error as Error).message}`); }
        return { status: "merged", code: null, reason: null, transient: false, branch, mode, head };
      };
      if (isAncestor(repository, branch, before)) {
        return { status: "merged", code: null, reason: null, transient: false, branch, mode: "up-to-date", head: before };
      }
      // Fast-forward when the owner's branch has not moved past the run's base, which is the
      // ordinary case; otherwise the work needs one merge commit to join the two histories.
      try {
        git(repository, ["merge", "--ff-only", "--quiet", branch]);
        return merged("fast-forward");
      } catch { /* Not a fast-forward. A refused one leaves the checkout untouched. */ }
      try {
        git(repository, ["merge", "--no-ff", "--quiet", "-m", `Merge ${branch}: ${run.displayName}`, branch]);
        return merged("merge-commit");
      } catch (error) {
        // The conflict is reported and everything is put back: the owner's working tree, index
        // and HEAD are where they were before the request, with no half-merged state behind.
        const reason = gitFailure(error);
        try { git(repository, ["merge", "--abort"]); } catch { /* Nothing to abort: the worktree was clean, so nothing was merged. */ }
        const restored = headOf(repository);
        if (restored !== before) log(`team integration: the merge abort left ${repository} at ${restored}, not ${before}`);
        return refuse("merge_conflict", reason);
      }
    },
  };
}