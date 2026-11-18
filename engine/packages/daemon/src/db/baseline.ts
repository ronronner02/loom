import type Database from "better-sqlite3";

import { TEAM_ATTEMPTS_SQL, TEAM_BOOTSTRAPS_SQL, TEAM_ATTACHMENTS_SQL, TEAM_ATTEMPT_FINALIZATIONS_SQL, TEAM_INTEGRATION_INTENTS_SQL, SCHEMA_UPGRADES, TEAM_GITHUB_SEEN_SQL, TEAM_GITHUB_THREADS_SQL, TEAM_INTAKE_SQL, TEAM_PROMPT_VERSIONS_SQL, TEAM_PULL_REQUESTS_SQL, upgradePath, type SchemaUpgrade } from "./upgrades.js";

/**
 * Marker written to PRAGMA user_version in the same transaction as the fresh team schema.
 * Any change to BASELINE_SQL bumps it and appends the matching step to SCHEMA_UPGRADES, so a
 * database the shipped app created is upgraded rather than refused. 2 adds
 * team_seat_mailbox_capabilities and is the first shipped version; 3 adds
 * team_chat_messages.visibility; 4 adds task comments (team_chat_messages.task_id) and task holds
 * and follow-up links (team_queue_authority.held_at, follow_up_of); 5 adds team_prompt_versions; 6 adds team_pull_requests; 7 adds team_github_seen; 8 adds the team_intake_* tables; 9 adds team_github_threads; 10 adds attempt-finalization and Git-integration checkpoints; 11 adds project chat attachments; 12 admits the Gemini execution client; 13 drops the tables of the deleted watchdog, view, classifier, inbox, context-monitor, launch-store and workflow-runtime subsystems.
 */
export const BASELINE_VERSION = 13;

/**
 * The one-shot schema for the retained team product. The statements are kept as one SQL
 * payload so SQLite can commit the complete schema atomically.
 */
const BASELINE_SQL = String.raw`-- rigs
CREATE TABLE rigs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , workspace_json TEXT, archived_at TEXT, permission_policy TEXT, rig_policy_origin TEXT, rig_policy_resolved_target TEXT, rig_policy_declaring_dir TEXT, rig_policy_launch_posture TEXT, claude_managed_block_file TEXT, non_interruptive INTEGER NOT NULL DEFAULT 0 CHECK (non_interruptive IN (0, 1)), install_root TEXT, team_model_allowlist TEXT
      CHECK (team_model_allowlist IS NULL OR json_valid(team_model_allowlist)), team_kind TEXT NOT NULL DEFAULT 'project'
      CHECK (team_kind IN ('project', 'test')));
-- nodes
CREATE TABLE nodes (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      logical_id  TEXT NOT NULL,
      role        TEXT,
      runtime     TEXT,
      model       TEXT,
      cwd         TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')), surface_hint TEXT, workspace TEXT, restore_policy TEXT, package_refs TEXT, pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL, agent_ref TEXT, profile TEXT, label TEXT, resolved_spec_name TEXT, resolved_spec_version TEXT, resolved_spec_hash TEXT, occupant_lifecycle TEXT, continuity_outcome TEXT, handover_result TEXT, previous_occupant TEXT, handover_at TEXT, codex_config_profile TEXT, permission_policy TEXT, policy_origin TEXT, policy_resolved_target TEXT, policy_declaring_dir TEXT, policy_launch_posture TEXT, session_source_json TEXT, effort TEXT, retired_at TEXT, soul_id TEXT,
      UNIQUE(rig_id, logical_id)
    );
-- edges
CREATE TABLE edges (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- bindings
CREATE TABLE bindings (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
      tmux_session    TEXT,
      tmux_window     TEXT,
      tmux_pane       TEXT,
      cmux_workspace  TEXT,
      cmux_surface    TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    , attachment_type TEXT NOT NULL DEFAULT 'tmux', external_session_name TEXT);
-- sessions
CREATE TABLE sessions (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      session_name    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    , resume_type TEXT, resume_token TEXT, restore_policy TEXT NOT NULL DEFAULT 'resume_if_possible', origin TEXT NOT NULL DEFAULT 'launched', startup_status TEXT NOT NULL DEFAULT 'pending', startup_completed_at TEXT, resume_provenance TEXT, resume_last_verified TEXT, resume_last_probe_status TEXT, resume_launch_token TEXT, resume_rotated_from TEXT, resume_rotated_process TEXT, resume_launch_process TEXT, intentionally_stopped INTEGER NOT NULL DEFAULT 0
      CHECK (intentionally_stopped IN (0, 1)));
-- events
CREATE TABLE events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      -- INTENTIONALLY NOT AN FK to rigs(id).
      -- Events are an append-only history log. They must survive rig deletion
      -- so the full timeline is preserved for replay and audit.
      rig_id      TEXT,
      -- INTENTIONALLY NOT AN FK to nodes(id).
      -- Same rationale: events must survive node deletion.
      node_id     TEXT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- pods
CREATE TABLE pods (
      id                      TEXT PRIMARY KEY,
      rig_id                  TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      label                   TEXT NOT NULL,
      summary                 TEXT,
      continuity_policy_json  TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    , namespace TEXT NOT NULL DEFAULT '');
-- chat_messages
CREATE TABLE chat_messages (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      sender      TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'message',
      body        TEXT NOT NULL DEFAULT '',
      topic       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- rig_services
CREATE TABLE rig_services (
      rig_id TEXT PRIMARY KEY REFERENCES rigs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      rig_root TEXT NOT NULL,
      compose_file TEXT NOT NULL,
      project_name TEXT NOT NULL,
      latest_receipt_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- stream_items
CREATE TABLE stream_items (
      stream_item_id TEXT PRIMARY KEY,
      ts_emitted TEXT NOT NULL,
      stream_sort_key TEXT NOT NULL,
      source_session TEXT NOT NULL,
      body TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'text',
      hint_type TEXT,
      hint_urgency TEXT,
      hint_destination TEXT,
      hint_tags TEXT,
      interrupt INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    , identity_provenance TEXT);
-- queue_items
CREATE TABLE queue_items (
      qitem_id TEXT PRIMARY KEY,
      ts_created TEXT NOT NULL,
      ts_updated TEXT NOT NULL,
      source_session TEXT NOT NULL,
      destination_session TEXT NOT NULL,
      state TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'routine',
      tier TEXT,
      tags TEXT,
      blocked_on TEXT,
      handed_off_to TEXT,
      handed_off_from TEXT,
      expires_at TEXT,
      chain_of_record TEXT,
      body TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT,
      closure_required_at TEXT,
      claimed_at TEXT,
      last_nudge_attempt TEXT,
      last_nudge_result TEXT,
      last_heartbeat TEXT,
      resolution TEXT
    , target_repo TEXT, summary TEXT, evidence_ref TEXT, minting_generation_uuid TEXT, claimed_by_generation_uuid TEXT, human_intent TEXT CHECK (human_intent IN ('decision', 'update')), human_detail TEXT, reply_to TEXT, human_questions TEXT, human_answers TEXT);
-- queue_transitions
CREATE TABLE queue_transitions (
      transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
      qitem_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      state TEXT NOT NULL,
      transition_note TEXT,
      actor_session TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT
    , identity_provenance TEXT, owner_notification_kind TEXT, owner_notification_level TEXT);
-- occupant_tenures
CREATE TABLE occupant_tenures (
      id                        TEXT PRIMARY KEY,
      node_id                   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      generation_ordinal        INTEGER NOT NULL,
      generation_uuid           TEXT NOT NULL UNIQUE,
      kind                      TEXT NOT NULL,
      native_session_id_at_boot TEXT,
      boot_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(node_id, generation_ordinal)
    );
-- daemon_lifecycle
CREATE TABLE daemon_lifecycle (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      boot_epoch TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      stopped_at TEXT
    );
-- operator_context_mode_bindings
CREATE TABLE "operator_context_mode_bindings" (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global_host', 'rig', 'project', 'mission', 'workstream', 'qitem')),
      qualifier TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('sleep', 'desk', 'mobile', 'away', 'focus', 'debug', 'human-led', 'delegated')),
      record_json TEXT NOT NULL,
      set_at TEXT NOT NULL,
      set_by TEXT NOT NULL CHECK (set_by = 'operator')
    );
-- team_approvals
CREATE TABLE team_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      kind TEXT NOT NULL CHECK (kind IN ('orchestrator', 'native')),
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      payload_digest TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      expires_at TEXT NOT NULL,
      decision_actor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (id, run_id)
    );
-- team_control_requests
CREATE TABLE team_control_requests (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, idempotency_key)
    );
-- team_queue_authority
CREATE TABLE team_queue_authority (
      qitem_id TEXT PRIMARY KEY REFERENCES queue_items(qitem_id),
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      task_id TEXT NOT NULL,
      assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)), outputs_json TEXT
      CHECK (outputs_json IS NULL OR json_valid(outputs_json)), permissions_json TEXT
      CHECK (permissions_json IS NULL OR json_valid(permissions_json)), display_name TEXT, document_versions_json TEXT
      CHECK (document_versions_json IS NULL OR json_valid(document_versions_json)), workflow_json TEXT
      CHECK (workflow_json IS NULL OR json_valid(workflow_json)), held_at TEXT, follow_up_of TEXT,
      UNIQUE (run_id, task_id),
      UNIQUE (qitem_id, run_id)
    );
-- team_attempts
${TEAM_ATTEMPTS_SQL};
-- team_approval_consumptions
CREATE TABLE team_approval_consumptions (
      approval_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'confirmed', 'ambiguous')),
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (approval_id, run_id) REFERENCES team_approvals(id, run_id),
      FOREIGN KEY (attempt_id, run_id) REFERENCES team_attempts(id, run_id)
    );
-- owner_pairing_codes
CREATE TABLE owner_pairing_codes (
      code_hash TEXT PRIMARY KEY, owner_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
-- owner_sessions
CREATE TABLE owner_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
      owner_hash TEXT NOT NULL, origin TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
-- team_scope_extensions
CREATE TABLE team_scope_extensions (
      approval_id TEXT PRIMARY KEY REFERENCES team_approvals(id),
      task_id TEXT NOT NULL,
      chain_head TEXT,
      automatic INTEGER NOT NULL CHECK (automatic IN (0, 1))
    );
-- team_worker_credentials
CREATE TABLE team_worker_credentials (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      session_id TEXT NOT NULL,
      token_digest TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      PRIMARY KEY (run_id, session_id)
    );
-- team_seat_mailbox_capabilities
CREATE TABLE team_seat_mailbox_capabilities (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      session_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, session_id)
    );
-- team_runs
CREATE TABLE "team_runs" (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id),
      binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
      binding_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'cancel_requested', 'canceled', 'invalidated', 'blocked')),
      state_reason TEXT,
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
      accounted_at TEXT,
      retries_used INTEGER NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
      review_rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (review_rounds_used >= 0),
      reviewer_seat TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , display_name TEXT, phase TEXT NOT NULL DEFAULT 'delivery' CHECK (phase IN ('planning', 'delivery')), integration_branch TEXT, integration_worktree TEXT, integration_repository TEXT, response_language TEXT
    CHECK (response_language IS NULL OR response_language IN ('en', 'zh-CN')));
-- team_integration_commits
CREATE TABLE team_integration_commits (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      task_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      subject TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (run_id, task_id)
    );
-- team_bootstraps
${TEAM_BOOTSTRAPS_SQL};
-- attempt_telemetry
CREATE TABLE attempt_telemetry (
      attempt_id TEXT PRIMARY KEY REFERENCES team_attempts(id) ON DELETE CASCADE,
      native_session_id TEXT,
      native_usage_json TEXT CHECK (native_usage_json IS NULL OR json_valid(native_usage_json)),
      seat_name TEXT,
      started_at TEXT NOT NULL,
      stopped_at TEXT NOT NULL,
      active_ms INTEGER NOT NULL CHECK (active_ms >= 0),
      usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
      activity_json TEXT NOT NULL CHECK (json_valid(activity_json)),
      activity_status TEXT NOT NULL CHECK (activity_status IN ('available', 'partial', 'unavailable')),
      outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('succeeded', 'failed', 'canceled', 'unknown')),
      retry_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (retry_scheduled IN (0, 1))
    );
-- team_document_workflows
CREATE TABLE team_document_workflows (
      run_id TEXT PRIMARY KEY REFERENCES team_runs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK (stage IN ('exploration', 'requirements', 'plan')),
      confirmed_brainstorm TEXT,
      confirmed_requirements TEXT,
      confirmed_plan TEXT,
      pending_stage TEXT CHECK (pending_stage IN ('exploration', 'requirements', 'plan')),
      error TEXT
    );
-- team_document_versions
CREATE TABLE team_document_versions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('brainstorm', 'requirements', 'plan')),
      version INTEGER NOT NULL CHECK (version > 0),
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      requirements_version_id TEXT REFERENCES team_document_versions(id),
      source_attempt_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      confirmed_by TEXT,
      UNIQUE (run_id, kind, version),
      UNIQUE (run_id, kind, source_attempt_id)
    );
-- team_document_captures
CREATE TABLE team_document_captures (
      run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      PRIMARY KEY (run_id, attempt_id)
    );
-- team_chat_messages
CREATE TABLE "team_chat_messages" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      sender TEXT NOT NULL CHECK (sender IN ('owner', 'lead')),
      body TEXT NOT NULL CHECK (length(body) <= 65536 OR
        (sender = 'owner' AND id IS (run_id || ':initial') AND length(body) <= 65536 + 256)),
      attempt_id TEXT,
      delivered_attempt TEXT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      options_json TEXT,
      answered_by TEXT, response_language TEXT
    CHECK (response_language IS NULL OR response_language IN ('en', 'zh-CN')), visibility TEXT NOT NULL DEFAULT 'chat' CHECK (visibility IN ('chat', 'activity')), task_id TEXT, attachments_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachments_json)),
      CHECK ((sender = 'lead') = (attempt_id IS NOT NULL)),
      CHECK (sender = 'owner' OR delivered_attempt IS NULL)
    );
-- team_intake_policies, team_intake_items, team_intake_sources
${TEAM_INTAKE_SQL};
-- team_github_threads
${TEAM_GITHUB_THREADS_SQL};
${TEAM_ATTEMPT_FINALIZATIONS_SQL};
${TEAM_INTEGRATION_INTENTS_SQL};
${TEAM_ATTACHMENTS_SQL};
-- team_github_seen
${TEAM_GITHUB_SEEN_SQL};
-- team_pull_requests
${TEAM_PULL_REQUESTS_SQL};
-- team_prompt_versions
${TEAM_PROMPT_VERSIONS_SQL};
-- team_soul_versions
CREATE TABLE team_soul_versions (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      soul_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      name TEXT NOT NULL,
      roles_json TEXT NOT NULL CHECK (json_valid(roles_json)),
      content TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, soul_id, version)
    );
-- team_workflow_outcomes
CREATE TABLE team_workflow_outcomes (
      attempt_id TEXT NOT NULL,
      qitem_id TEXT NOT NULL REFERENCES team_queue_authority(qitem_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      entrypoint TEXT NOT NULL,
      revision TEXT NOT NULL,
      outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (attempt_id, generation)
    );
-- indexes/triggers
-- idx_events_rig_seq
CREATE INDEX idx_events_rig_seq ON events(rig_id, seq);
-- idx_chat_messages_rig_created
CREATE INDEX idx_chat_messages_rig_created
      ON chat_messages (rig_id, created_at);
-- idx_pods_rig_namespace
CREATE UNIQUE INDEX idx_pods_rig_namespace ON pods(rig_id, namespace) WHERE namespace != '';
-- idx_stream_items_source
CREATE INDEX idx_stream_items_source ON stream_items(source_session);
-- idx_stream_items_hint_destination
CREATE INDEX idx_stream_items_hint_destination ON stream_items(hint_destination);
-- idx_stream_items_chronological
CREATE INDEX idx_stream_items_chronological ON stream_items(ts_emitted, stream_sort_key);
-- idx_stream_items_archived
CREATE INDEX idx_stream_items_archived ON stream_items(archived_at);
-- idx_queue_items_destination_state
CREATE INDEX idx_queue_items_destination_state ON queue_items(destination_session, state);
-- idx_queue_items_source
CREATE INDEX idx_queue_items_source ON queue_items(source_session);
-- idx_queue_items_state
CREATE INDEX idx_queue_items_state ON queue_items(state);
-- idx_queue_items_handed_off_to
CREATE INDEX idx_queue_items_handed_off_to ON queue_items(handed_off_to);
-- idx_queue_items_closure_overdue
CREATE INDEX idx_queue_items_closure_overdue ON queue_items(state, closure_required_at) WHERE state = 'in-progress';
-- idx_queue_transitions_qitem
CREATE INDEX idx_queue_transitions_qitem ON queue_transitions(qitem_id, ts);
-- idx_queue_transitions_actor
CREATE INDEX idx_queue_transitions_actor ON queue_transitions(actor_session);
-- idx_queue_items_target_repo
CREATE INDEX idx_queue_items_target_repo ON queue_items(target_repo);
-- idx_rigs_archived
CREATE INDEX idx_rigs_archived ON rigs(archived_at);
-- idx_events_node_type_seq
CREATE INDEX idx_events_node_type_seq ON events(node_id, type, seq);
-- idx_sessions_node_created_id
CREATE INDEX idx_sessions_node_created_id
      ON sessions(node_id, created_at DESC, id DESC);
-- idx_occupant_tenures_node
CREATE INDEX idx_occupant_tenures_node ON occupant_tenures(node_id);
-- idx_operator_context_mode_bindings_scope_qualifier
CREATE UNIQUE INDEX idx_operator_context_mode_bindings_scope_qualifier
      ON operator_context_mode_bindings(scope, qualifier);
-- idx_queue_human_intent_updated
CREATE INDEX idx_queue_human_intent_updated ON queue_items(human_intent, ts_updated DESC);
-- idx_queue_transitions_handoff_ts
CREATE INDEX idx_queue_transitions_handoff_ts
      ON queue_transitions(ts DESC)
      WHERE closure_reason = 'handed_off_to';
-- idx_queue_items_ts_updated
CREATE INDEX idx_queue_items_ts_updated
      ON queue_items(ts_updated);
-- idx_events_restore_seq
CREATE INDEX idx_events_restore_seq ON events(seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
-- idx_events_restore_rig_seq
CREATE INDEX idx_events_restore_rig_seq ON events(rig_id, seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
-- idx_events_startup_node_seq
CREATE INDEX idx_events_startup_node_seq ON events(node_id, seq DESC)
      WHERE type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected');
-- idx_queue_transitions_qitem_id_order
CREATE INDEX idx_queue_transitions_qitem_id_order
      ON queue_transitions(qitem_id, transition_id);
-- idx_queue_items_recovery_tags
CREATE INDEX idx_queue_items_recovery_tags
      ON queue_items(qitem_id)
      WHERE (tags LIKE '%"recovery-for:%' OR tags LIKE '%\%') OR tags LIKE '%"stuck-sweep:%';
-- idx_team_approvals_run_state
CREATE INDEX idx_team_approvals_run_state ON team_approvals(run_id, state);
-- idx_team_attempts_run_state
CREATE INDEX idx_team_attempts_run_state ON team_attempts(run_id, state);
-- idx_owner_sessions_expiry
CREATE INDEX idx_owner_sessions_expiry ON owner_sessions(expires_at);
-- team_scope_extensions_task
CREATE INDEX team_scope_extensions_task ON team_scope_extensions(task_id);
-- idx_attempt_telemetry_native_session
CREATE INDEX idx_attempt_telemetry_native_session ON attempt_telemetry(native_session_id);
-- idx_attempt_telemetry_stopped
CREATE INDEX idx_attempt_telemetry_stopped ON attempt_telemetry(stopped_at);
-- team_document_versions_run
CREATE INDEX team_document_versions_run ON team_document_versions(run_id, kind, version DESC);
-- idx_team_chat_messages_run
CREATE INDEX idx_team_chat_messages_run ON team_chat_messages (run_id);
-- idx_team_chat_messages_lead_attempt
CREATE UNIQUE INDEX idx_team_chat_messages_lead_attempt ON team_chat_messages (run_id, attempt_id) WHERE sender = 'lead';
-- team_workflow_owner_request
CREATE UNIQUE INDEX team_workflow_owner_request ON team_queue_authority(json_extract(workflow_json, '$.ownerMessageId'))
      WHERE json_extract(workflow_json, '$.ownerMessageId') IS NOT NULL;
-- edge_same_rig_insert
CREATE TRIGGER edge_same_rig_insert
    BEFORE INSERT ON edges
    BEGIN
      SELECT RAISE(ABORT, 'edge source and target must belong to the same rig')
      WHERE (SELECT rig_id FROM nodes WHERE id = NEW.source_id)
         != (SELECT rig_id FROM nodes WHERE id = NEW.target_id);
      SELECT RAISE(ABORT, 'edge rig_id must match source node rig_id')
      WHERE NEW.rig_id != (SELECT rig_id FROM nodes WHERE id = NEW.source_id);
    END;
`;

export class LegacyDatabaseError extends Error {
  readonly code = "legacy_database";
  constructor(public readonly databasePath: string) {
    super(`legacy_database: ${databasePath}`);
    this.name = "LegacyDatabaseError";
  }
}

export class NewerDatabaseError extends Error {
  readonly code = "newer_database";
  constructor(public readonly databasePath: string, public readonly version: number) {
    super(`newer_database: version ${version} at ${databasePath}`);
    this.name = "NewerDatabaseError";
  }
}

export class UpgradeFailedError extends Error {
  readonly code = "upgrade_failed";
  constructor(public readonly databasePath: string, public readonly backupPath: string, cause: unknown) {
    super(`upgrade_failed: ${databasePath} (backup ${backupPath}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "UpgradeFailedError";
  }
}

export interface BaselineOptions {
  /** Test-only failure injection. The callback runs inside the schema or upgrade transaction. */
  injectFailure?: () => void;
  /** The upgrade chain; tests inject one, production uses SCHEMA_UPGRADES. */
  upgrades?: readonly SchemaUpgrade[];
}

function writeBaseline(db: Database.Database, options?: BaselineOptions): void {
  db.transaction(() => {
    db.exec(BASELINE_SQL);
    db.pragma(`user_version = ${BASELINE_VERSION}`);
    options?.injectFailure?.();
  })();
}

function hasUserTables(db: Database.Database): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%' LIMIT 1",
  ).get());
}

function userVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }));
}

/**
 * Inspect schema metadata only; legacy application rows are never read. A database marked
 * with an older version the upgrade chain reaches is supported; it is upgraded on open.
 */
export function assertSupportedDatabase(db: Database.Database, databasePath: string,
  upgrades: readonly SchemaUpgrade[] = SCHEMA_UPGRADES): void {
  const version = userVersion(db);
  if (version === BASELINE_VERSION || !hasUserTables(db)) return;
  if (version > BASELINE_VERSION) throw new NewerDatabaseError(databasePath, version);
  if (version === 0 || !upgradePath(upgrades, version, BASELINE_VERSION)) throw new LegacyDatabaseError(databasePath);
}

/** Copy the database beside itself before an upgrade. VACUUM INTO writes a consistent copy from a WAL database. */
function backupBeforeUpgrade(db: Database.Database, databasePath: string, version: number): string {
  if (databasePath === ":memory:" || databasePath === "") return ":memory:";
  const backupPath = `${databasePath}.v${version}-${Date.now()}.bak`;
  db.prepare("VACUUM INTO ?").run(backupPath);
  return backupPath;
}

function upgrade(db: Database.Database, databasePath: string, upgrades: readonly SchemaUpgrade[], options?: BaselineOptions): void {
  const from = userVersion(db);
  const path = upgradePath(upgrades, from, BASELINE_VERSION)!;
  const backupPath = backupBeforeUpgrade(db, databasePath, from);
  const rebuildsTables = path.some(step => step.rebuildsTables);
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  try {
    // SQLite table rebuilds otherwise cascade deletes into the retained dependent rows.
    if (rebuildsTables) db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      for (const step of path) {
        db.exec(step.sql);
        db.pragma(`user_version = ${step.to}`);
      }
      options?.injectFailure?.();
      if (rebuildsTables && (db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("Upgrade violated a foreign key");
    })();
  } catch (error) {
    throw new UpgradeFailedError(databasePath, backupPath, error);
  } finally {
    if (rebuildsTables) db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

/** Initialize an empty database atomically, upgrade an older shipped one, or reopen the baseline. */
export function initializeDatabase(
  db: Database.Database,
  databasePath: string = db.name,
  options?: BaselineOptions,
): void {
  const upgrades = options?.upgrades ?? SCHEMA_UPGRADES;
  assertSupportedDatabase(db, databasePath, upgrades);
  if (userVersion(db) === BASELINE_VERSION) return;
  if (hasUserTables(db)) upgrade(db, databasePath, upgrades, options);
  else writeBaseline(db, options);
}
