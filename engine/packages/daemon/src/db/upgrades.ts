/**
 * One additive step that carries a database marked `from` to `to`. The SQL runs in one
 * transaction with the new marker, after a copy of the database is written beside it.
 */
export interface SchemaUpgrade { from: number; to: number; sql: string; rebuildsTables?: boolean }

/**
 * Steps from the first shipped baseline (version 2) to today's. A schema change edits
 * BASELINE_SQL for fresh installs, bumps BASELINE_VERSION, and appends the step that brings
 * the previous version to the same schema. The parity test in `db-upgrades.test.ts` holds
 * the chain to the baseline.
 */
/** one immutable revision of a team's prompt section overrides. Shared by the baseline and step 4→5. */
export const TEAM_PROMPT_VERSIONS_SQL = `CREATE TABLE team_prompt_versions (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      overrides_json TEXT NOT NULL CHECK (json_valid(overrides_json)),
      bases_json TEXT NOT NULL CHECK (json_valid(bases_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, revision)
    )`;

/** the pull request a run's branch is delivered through. Shared by the baseline and step 5→6. */
export const TEAM_PULL_REQUESTS_SQL = `CREATE TABLE team_pull_requests (
      run_id TEXT PRIMARY KEY REFERENCES team_runs(id),
      repository TEXT NOT NULL,
      number INTEGER NOT NULL CHECK (number > 0),
      url TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
      updated_at TEXT NOT NULL
    )`;

/** the GitHub items a run's source has already delivered. Shared by the baseline and step 6→7. */
export const TEAM_GITHUB_SEEN_SQL = `CREATE TABLE team_github_seen (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      item TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (run_id, item)
    )`;

/**
 * A team's versioned intake policy, the GitHub items it has seen, and where each
 * team's polling resumes. Shared by the baseline and step 7→8.
 */
export const TEAM_INTAKE_SQL = [`CREATE TABLE team_intake_policies (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      mode TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'auto')),
      rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, revision)
    )`, `CREATE TABLE team_intake_items (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      item TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('issue', 'comment', 'ci')),
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      explicit INTEGER NOT NULL CHECK (explicit IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('pending', 'would_start', 'started', 'skipped', 'unavailable', 'dismissed')),
      matched_json TEXT NOT NULL CHECK (json_valid(matched_json)),
      policy_revision INTEGER,
      run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, item)
    )`, `CREATE TABLE team_intake_sources (
      rig_id TEXT PRIMARY KEY REFERENCES rigs(id) ON DELETE CASCADE,
      repository TEXT NOT NULL,
      since TEXT NOT NULL
    )`].join(";\n");

/**
 * A GitHub review comment a task took, and the reply its outcome owes: a resolved
 * thread once the fix is pushed, or one sentence of reason. Shared by the baseline and step 8→9.
 */
export const TEAM_GITHUB_THREADS_SQL = `CREATE TABLE team_github_threads (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      message_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL CHECK (number > 0),
      comment_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('fixed', 'declined')),
      reason TEXT,
      head_sha TEXT,
      state TEXT NOT NULL CHECK (state IN ('open', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, message_id)
    )`;

/** Unfinished stop effects only; historical stopped attempts are not enrolled on upgrade. */
export const TEAM_ATTEMPT_FINALIZATIONS_SQL = `CREATE TABLE team_attempt_finalizations (
      attempt_id TEXT PRIMARY KEY REFERENCES team_attempts(id),
      progress_json TEXT NOT NULL CHECK (json_valid(progress_json))
    )`;

/** The exact Git write to recover before reading another mutable candidate. */
export const TEAM_INTEGRATION_INTENTS_SQL = `CREATE TABLE team_integration_intents (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      task_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      worktree TEXT NOT NULL,
      branch TEXT NOT NULL,
      parent_sha TEXT NOT NULL,
      tree_sha TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      repair_reason TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, task_id)
    )`;

export const TEAM_ATTACHMENTS_SQL = `CREATE TABLE team_attachments (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size >= 0),
      media_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;

export const TEAM_ATTEMPTS_SQL = `CREATE TABLE "team_attempts" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      qitem_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('lead', 'implementer', 'reviewer')),
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'gemini')),
      identity_json TEXT CHECK (identity_json IS NULL OR json_valid(identity_json)),
      unknown_reason TEXT,
      state TEXT NOT NULL CHECK (state IN ('running', 'stopped', 'unknown')),
      usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
      active_ms INTEGER NOT NULL CHECK (active_ms >= 0),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
      UNIQUE (id, run_id),
      FOREIGN KEY (qitem_id, run_id) REFERENCES team_queue_authority(qitem_id, run_id),
      CHECK ((state = 'unknown' AND unknown_reason IS NOT NULL) OR
        (state <> 'unknown' AND identity_json IS NOT NULL AND unknown_reason IS NULL))
    )`;

export const TEAM_BOOTSTRAPS_SQL = `CREATE TABLE "team_bootstraps" (
      repository TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lead_client TEXT NOT NULL CHECK (lead_client IN ('claude-code', 'codex', 'gemini')),
      github_login TEXT NOT NULL,
      step TEXT NOT NULL CHECK (step IN ('pending', 'folder', 'init', 'ignore', 'commit', 'repo', 'push')),
      commit_oid TEXT,
      branch_ref TEXT,
      remote_url TEXT,
      team_id TEXT REFERENCES rigs(id) ON DELETE CASCADE,
      last_error_code TEXT
    )`;

export const SCHEMA_UPGRADES: readonly SchemaUpgrade[] = [
  // A lead message that needs no owner attention is kept as run activity.
  { from: 2, to: 3, sql: "ALTER TABLE team_chat_messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'chat' CHECK (visibility IN ('chat', 'activity'))" },
  // An owner comment on a task, a task hold, and a follow-up's original task.
  { from: 3, to: 4, sql: ["ALTER TABLE team_chat_messages ADD COLUMN task_id TEXT",
    "ALTER TABLE team_queue_authority ADD COLUMN held_at TEXT",
    "ALTER TABLE team_queue_authority ADD COLUMN follow_up_of TEXT"].join(";\n") },
  { from: 4, to: 5, sql: TEAM_PROMPT_VERSIONS_SQL },
  { from: 5, to: 6, sql: TEAM_PULL_REQUESTS_SQL },
  { from: 6, to: 7, sql: TEAM_GITHUB_SEEN_SQL },
  { from: 7, to: 8, sql: TEAM_INTAKE_SQL },
  { from: 8, to: 9, sql: TEAM_GITHUB_THREADS_SQL },
  { from: 9, to: 10, sql: [TEAM_ATTEMPT_FINALIZATIONS_SQL, TEAM_INTEGRATION_INTENTS_SQL].join(";\n") },
  { from: 10, to: 11, sql: [TEAM_ATTACHMENTS_SQL,
    "ALTER TABLE team_chat_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachments_json))"].join(";\n") },
  { from: 11, to: 12, rebuildsTables: true, sql: [
    TEAM_ATTEMPTS_SQL.replace('"team_attempts"', '"team_attempts_next"'),
    'INSERT INTO team_attempts_next (rowid, id, run_id, qitem_id, role, provider, identity_json, unknown_reason, state, usage_json, active_ms, entity_version, created_at, updated_at, failure_json) SELECT rowid, * FROM team_attempts',
    'DROP TABLE team_attempts',
    'ALTER TABLE team_attempts_next RENAME TO team_attempts',
    'CREATE INDEX idx_team_attempts_run_state ON team_attempts(run_id, state)',
    TEAM_BOOTSTRAPS_SQL.replace('"team_bootstraps"', '"team_bootstraps_next"'),
    'INSERT INTO team_bootstraps_next SELECT * FROM team_bootstraps',
    'DROP TABLE team_bootstraps',
    'ALTER TABLE team_bootstraps_next RENAME TO team_bootstraps',
  ].join(";\n") },
  // The watchdog/wake runtime, the view projector, the classifier, the inbox, the context
  // monitor, the launch-era stores and the workflow execution runtime were deleted with their
  // readers and writers, so the tables they owned carry no rows a live path could use.
  { from: 12, to: 13, sql: [
    "DROP TABLE IF EXISTS watchdog_jobs",
    "DROP TABLE IF EXISTS watchdog_history",
    "DROP TABLE IF EXISTS views_custom",
    "DROP TABLE IF EXISTS project_classifications",
    "DROP TABLE IF EXISTS classifier_leases",
    "DROP TABLE IF EXISTS classification_attempts",
    "DROP TABLE IF EXISTS inbox_entries",
    "DROP TABLE IF EXISTS outbox_entries",
    "DROP TABLE IF EXISTS context_usage",
    "DROP TABLE IF EXISTS usage_samples",
    "DROP TABLE IF EXISTS applied_launch_observation_invalidations",
    "DROP TABLE IF EXISTS applied_launch_observations",
    "DROP TABLE IF EXISTS node_permission_selections",
    "DROP TABLE IF EXISTS mission_control_actions",
    "DROP TABLE IF EXISTS queue_transitions_archive",
    "DROP TABLE IF EXISTS queue_transition_wakes",
    "DROP TABLE IF EXISTS workflow_frontier_bindings",
    "DROP TABLE IF EXISTS workflow_failure_occurrences",
    "DROP TABLE IF EXISTS workflow_instances",
    "DROP TABLE IF EXISTS workflow_step_trails",
    "DROP TABLE IF EXISTS workflow_specs",
    "DROP TABLE IF EXISTS projection_manifest",
  ].join(";\n") },
];

/** The steps from `from` to `to`, in order, or null when the chain does not reach. */
export function upgradePath(steps: readonly SchemaUpgrade[], from: number, to: number): SchemaUpgrade[] | null {
  const path: SchemaUpgrade[] = [];
  let version = from;
  while (version < to) {
    const step = steps.find(candidate => candidate.from === version);
    if (!step || step.to <= version) return null;
    path.push(step);
    version = step.to;
  }
  return version === to ? path : null;
}
