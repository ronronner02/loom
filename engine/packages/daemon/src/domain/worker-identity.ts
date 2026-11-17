import { join } from "node:path";

/**
 * The worker identity reader.
 *
 * The producer needs the worker's uid, gid, groups, home and scratch before an attempt
 * exists. A managed worker is this daemon's own user, so those facts come from the process
 * rather than from an account provisioning created: no `/etc/passwd` read, and no account
 * has to exist on the host.
 */
export interface WorkerIdentityPolicy {
  /** `paths.worker_root`: the anchor of every worker's home and scratch. */
  workerRoot: string;
  /** `paths.assignment_root`: the anchor every assigned tree of that worker sits under. */
  assignmentRoot: string;
  /** `worker_identities`: the allow-list the policy installs. */
  identities: readonly string[];
}

export interface WorkerIdentity {
  name: string;
  uid: number;
  gid: number;
  /** Supplementary and primary group names, resolved the way the launcher resolves them. */
  groups: string[];
  /** The same groups as ids: the context manifest compares numeric modes against them. */
  groupIds: number[];
  home: string;
  scratch: string;
  /** The worker's assignment directory; a tree the launcher accepts must descend from it. */
  tree: string;
}

/** The composition handle startup injects; one owner of the worker identity. */
export class WorkerIdentities {
  constructor(private readonly policy: () => WorkerIdentityPolicy) {}

  resolve(name: string): WorkerIdentity {
    return currentUserIdentity(this.policy(), name);
  }
}

/**
 * The daemon's own identity, shaped like an assigned worker's.
 *
 * `groups` is empty because the client starts with no supplementary groups: the projection
 * is checked against the groups the process will actually carry.
 */
function currentUserIdentity(policy: WorkerIdentityPolicy, name: string): WorkerIdentity {
  if (!policy.identities.includes(name)) throw new Error("Worker identity is not in the installed policy");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  if (uid === null || gid === null) {
    // Windows has no POSIX user ids. The worker is still the daemon's own user, so what
    // matters is that the folder the daemon owns and the candidate is in is the one that
    // controls the assignment root, not what number Node.js returns for the process.
    return { name, uid: -1, gid: -1, groups: [], groupIds: [],
      home: join(policy.workerRoot, name, "home"),
      scratch: join(policy.workerRoot, name, "scratch"),
      tree: join(policy.assignmentRoot, name) };
  }
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Worker account is privileged");
  return { name, uid, gid, groups: [], groupIds: [gid],
    home: join(policy.workerRoot, name, "home"),
    scratch: join(policy.workerRoot, name, "scratch"),
    tree: join(policy.assignmentRoot, name) };
}