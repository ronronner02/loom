import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import type { WorkerLaunchInput } from "../src/adapters/worker-launch.js";
import type { PlanBinding } from "../src/contracts/team-control.js";
import { createDaemon } from "../src/startup.js";
import { DaemonLifecycleStore } from "../src/domain/daemon-lifecycle-store.js";

// review50-r1 follow-on: the store data-layer is unit-tested, but the boot WIRING
// (startup calls recordBoot) was proven only by the live kill-9 e2e — a future
// wiring drop would pass CI silently. This cheap boot-level pin closes that gap.
describe("P7 wiring pin — startup recordBoot ran at boot", () => {
  it("the lifecycle boot row exists after createDaemon boot (removing the recordBoot call fails HERE)", async () => {
    const { db } = await createDaemon({ dbPath: ":memory:" });
    const rec = new DaemonLifecycleStore(db).get();
    expect(rec).not.toBeNull();
    expect(rec!.bootEpoch).toBeTruthy();
    expect(rec!.startedAt).toBeTruthy();
    expect(rec!.stoppedAt).toBeNull(); // a fresh boot has no clean-shutdown mark yet
  });
});


describe("startup finalization admission wiring", () => {
  it("rechecks the real finalization table before resolving a launch tree", async () => {
    const daemon = await createDaemon({
      dbPath: ":memory:", managedMode: true, workersIsolation: "none", webUiEnabled: false,
      teamControl: { credentials: { ownerToken: "fixture-owner" } },
    });
    try {
      const { db, deps } = daemon;
      const digest = "sha256:" + "a".repeat(64);
      const now = new Date().toISOString();
      const binding: PlanBinding = {
        artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready",
        execution: "code", status: "active", planRef: "plan.md", planDigest: digest,
        repository: { root: tmpdir(), identity: "git:" + "b".repeat(40) },
        readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
        policyRevision: 1, policyFingerprint: digest,
        limits: { maxSessions: 2, maxActiveMs: 60_000, maxRetries: 1, maxReviewRounds: 1 },
      };
      db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'fixture')").run();
      deps.teamGovernance!.createRun({ id: "run", rigId: "rig", binding });
      db.prepare("UPDATE team_runs SET state = 'approved' WHERE id = 'run'").run();
      const unavailable = { value: null, reason: "not reported" };
      const usage = { activeMs: 0, inputTokens: unavailable, outputTokens: unavailable, costUsd: unavailable };
      const identity = { nativeSessionId: "previous-session", tmuxServer: null, paneId: null,
        processId: 4242, processStart: now, generation: 1, policyFingerprint: digest };
      db.prepare(`INSERT INTO team_attempts (
        id, run_id, role, provider, identity_json, state, usage_json, active_ms, created_at, updated_at
      ) VALUES ('previous-attempt', 'run', 'implementer', 'codex', ?, 'stopped', ?, 0, ?, ?)`)
        .run(JSON.stringify(identity), JSON.stringify(usage), now, now);
      const input = { client: "codex", attempt: {
        attemptId: "next-attempt", deadline: Date.now() + 60_000,
        context: { runId: "run", client: "codex", binding, assignment: {
          taskId: "next-task", role: "implementer", paths: ["src"], dependencies: [],
        } },
      } } as WorkerLaunchInput;
      // Stop after admission so this wiring test needs no candidate or child.
      const tree = vi.spyOn(deps.workflowRuntime!, "assignedTreeFor").mockImplementation(() => {
        throw new Error("direct_launch_fixture_reached");
      });
      try {
        const launcher = deps.managedLaunch!.launcher;
        await expect(launcher.launch(input)).resolves.toMatchObject({
          ok: false, error: "Direct launch blocked: direct_launch_fixture_reached",
        });
        expect(tree).toHaveBeenCalledTimes(1);
        db.prepare(`INSERT INTO team_attempt_finalizations (attempt_id, progress_json)
          VALUES ('previous-attempt', '{"completed":[]}')`).run();
        await expect(launcher.launch(input)).resolves.toMatchObject({
          ok: false, error: "Direct launch blocked: managed_finalization_pending",
        });
        expect(tree).toHaveBeenCalledTimes(1);
        db.prepare("DELETE FROM team_attempt_finalizations WHERE attempt_id = 'previous-attempt'").run();
        await expect(launcher.launch(input)).resolves.toMatchObject({
          ok: false, error: "Direct launch blocked: direct_launch_fixture_reached",
        });
        expect(tree).toHaveBeenCalledTimes(2);
      } finally { tree.mockRestore(); }
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });
});
