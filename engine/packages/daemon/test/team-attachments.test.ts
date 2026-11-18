import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { initializeDatabase } from "../src/db/baseline.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PlanGovernance } from "../src/domain/plan-governance.js";
import { addTeamSeats } from "../src/domain/team-setup.js";
import { leadChatTurnNote, listChatMessages } from "../src/domain/lead-chat.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

type Attachment = { id: string; name: string; size: number; mediaType: string };
const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("project chat attachments", () => {
  let directory: string, repository: string, teamId: string;
  let fixture: ReturnType<typeof createTestApp>, governance: PlanGovernance;
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "chat-files-")));
    repository = join(directory, "project");
    mkdirSync(repository);
    vi.stubEnv("MULTI_AGENT_HOME", join(directory, "state"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repository, "README.md"), "# Original project\n");
    git("add", "README.md"); git("commit", "-qm", "Initial project");
    const db = createFullTestDb(), bus = new EventBus(db), queue = new QueueRepository(db, bus);
    const policy = unisolatedPolicyCapability(1);
    governance = new PlanGovernance(db, bus, queue, undefined, () => policy);
    fixture = createTestApp(db, { appDeps: { eventBus: bus, queueRepo: queue, teamGovernance: governance,
      teamControl: { credentials: { ownerToken: "owner-attachment-fixture",
        workers: [{ token: "worker-attachment-fixture", sessionId: "worker@fixture", runId: "other" }] },
        readPolicyCapability: () => policy, planWorktreeRoot: () => join(directory, "worktrees") } } });
    teamId = fixture.rigRepo.createRig("existing-project", repository).id;
    addTeamSeats(db, teamId, [{ role: "lead", client: "codex" }]);
  });
  afterEach(() => { fixture.db.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path: string, body: FormData | object, token: string | null = "owner-attachment-fixture") =>
    fixture.app.request("/api/team-control" + path, { method: "POST",
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      body: body instanceof FormData ? body : JSON.stringify(body) }, peer);
  const upload = (bytes: string | Uint8Array = "Attached notes\n", name = "notes.md", token: string | null = "owner-attachment-fixture", project = teamId) => {
    const body = new FormData();
    body.append("file", new Blob([bytes], { type: "application/octet-stream" }), name);
    return call("/teams/" + project + "/attachments", body, token);
  };
  const attach = async (bytes?: string | Uint8Array, name?: string) => {
    const response = await upload(bytes, name);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json() as { attachment: Attachment }).attachment;
  };
  const start = (attachments: string[]) => call("/runs", {
    rig: teamId, goal: "Use these project references", planning: true, documentWorkflow: true, attachments,
  });

  it("browses files and sends attachments over loopback with paired browser credentials", async () => {
    // Each request uses its own connection. undici reuses one pooled socket across the large
    // uploads and the small JSON posts that follow them, and a pooled socket can be reset
    // between them (measured 4 of 20 runs here; the same server driven by a plain keep-alive
    // `http.Agent` never reset, 0 of 40). This test reads responses, not the client's pooling.
    const fetchOne = (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) =>
      fetch(input, { ...init, headers: { ...(init.headers ?? {}), Connection: "close" } });
    const server = serve({ fetch: fixture.app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
      const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
      const base = origin + "/api/team-control";
      const minted = await fetchOne(base + "/owner-session/pairing", {
        method: "POST", headers: { Authorization: "Bearer owner-attachment-fixture" },
      });
      expect(minted.status).toBe(200);
      const { code } = await minted.json() as { code: string };
      const exchange = await fetchOne(base + "/owner-session/exchange", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      expect(exchange.status).toBe(200);
      const cookie = exchange.headers.get("Set-Cookie")!.split(";")[0]!;
      const { antiForgeryToken } = await exchange.json() as { antiForgeryToken: string };
      const headers = { Origin: origin, Cookie: cookie, "X-Multi-Agent-CSRF": antiForgeryToken };
      const files = await fetchOne(base + "/teams/" + teamId + "/files", { headers });
      expect(files.status).toBe(200);
      expect(await files.json()).toMatchObject({ kind: "directory", entries: [{ name: "README.md", kind: "file" }] });
      expect(fixture.db.prepare("SELECT count(*) AS count FROM team_runs").get()).toEqual({ count: 0 });
      // The refusal is the missing anti-forgery header, so its body is small: a refusal that
      // lands while a large upload is still arriving is a race the socket decides, and that is
      // not what this case is about. The large body is the accepted upload below, which the
      // server reads in full.
      const deniedBody = new FormData();
      deniedBody.append("file", new Blob(["notes\n"]), "notes.md");
      const denied = await fetchOne(base + "/teams/" + teamId + "/attachments", {
        method: "POST", headers: { Origin: origin, Cookie: cookie }, body: deniedBody,
      });
      expect(denied.status).toBe(403);
      await denied.text();
      expect(fixture.db.prepare("SELECT count(*) AS count FROM team_attachments").get()).toEqual({ count: 0 });
      const body = new FormData();
      body.append("file", new Blob(["Project references\n".repeat(70_000)]), "references.txt");
      const uploaded = await fetchOne(base + "/teams/" + teamId + "/attachments", { method: "POST", headers, body });
      expect(uploaded.status).toBe(201);
      const { attachment } = await uploaded.json() as { attachment: Attachment };
      expect(attachment.size).toBeGreaterThan(1_048_576);
      const started = await fetchOne(base + "/runs", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ rig: teamId, goal: "Use the references", planning: true, documentWorkflow: true, attachments: [attachment.id] }) });
      expect(started.status).toBe(201);
      const { runId } = await started.json() as { runId: string };
      const chat = await fetchOne(base + "/runs/" + runId + "/chat", { headers });
      expect(chat.status).toBe(200);
      expect(await chat.json()).toMatchObject({ messages: [{ body: "Use the references", attachments: [attachment] }] });
      expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("# Original project\n");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("upgrades an existing conversation without losing its messages", async () => {
    const started = await start([]);
    expect(started.status).toBe(201);
    const { runId } = await started.json() as { runId: string };
    const before = listChatMessages(fixture.db, runId);
    fixture.db.exec("DROP TABLE team_attachments; ALTER TABLE team_chat_messages DROP COLUMN attachments_json; PRAGMA user_version = 10");
    initializeDatabase(fixture.db);
    expect(listChatMessages(fixture.db, runId)).toEqual(before);
    expect(fixture.db.prepare("SELECT attachments_json AS attachments FROM team_chat_messages").get()).toEqual({ attachments: "[]" });
    expect((await upload()).status).toBe(201);
  });

  it("uploads binary bytes larger than the control JSON limit outside the repository", async () => {
    const bytes = new Uint8Array(1_048_577).fill(42);
    bytes[0] = 0;
    const file = await attach(bytes, "reference.pdf");
    expect(file).toMatchObject({ name: "reference.pdf", size: bytes.length, mediaType: "application/octet-stream" });
    const started = await start([file.id]);
    expect(started.status, await started.clone().text()).toBe(201);
    const { runId } = await started.json() as { runId: string };
    const messages = listChatMessages(fixture.db, runId);
    expect(messages[0]).toMatchObject({ body: "Use these project references", attachments: [file] });
    const note = leadChatTurnNote(messages)!;
    const line = note.split("\n").find(value => value.startsWith("Attached file (data): "))!;
    const reference = JSON.parse(line.slice("Attached file (data): ".length)) as { name: string; path: string };
    expect(reference.name).toBe("reference.pdf");
    expect(relative(repository, reference.path)).toMatch(/^\.\./);
    expect(readFileSync(reference.path)).toEqual(Buffer.from(bytes));
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("# Original project\n");
    expect(note).toContain("not execution approval");
  });

  it("retains attachments in follow-up chat and replays a send without duplicate messages", async () => {
    const first = await attach();
    const started = await start([first.id]);
    expect(started.status, await started.clone().text()).toBe(201);
    const { runId } = await started.json() as { runId: string };
    const second = await attach("Updated notes\n", "notes.md");
    expect(second.id).not.toBe(first.id);
    const request = { protocolVersion: "1.0", runId, actionId: randomUUID(), idempotencyKey: randomUUID(),
      expectedEntityVersion: governance.getRun(runId).entityVersion, payload: { body: "Use the update", attachments: [second.id] } };
    const response = await call("/runs/" + runId + "/chat", request);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await call("/runs/" + runId + "/chat", request)).status).toBe(200);
    const messages = listChatMessages(fixture.db, runId);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ body: "Use the update", attachments: [second] });
    expect(leadChatTurnNote([messages[1]!])).toContain(second.id);
  });

  it("rejects another project's references before a run or message is created", async () => {
    const foreignId = fixture.rigRepo.createRig("other-project", repository).id;
    addTeamSeats(fixture.db, foreignId, [{ role: "lead", client: "codex" }]);
    const response = await upload("other project", "other.txt", "owner-attachment-fixture", foreignId);
    expect(response.status).toBe(201);
    const { attachment } = await response.json() as { attachment: Attachment };
    expect((await start([attachment.id])).status).toBe(400);
    expect(fixture.db.prepare("SELECT count(*) AS count FROM team_runs").get()).toEqual({ count: 0 });
    const own = await attach();
    const started = await start([own.id]);
    const { runId } = await started.json() as { runId: string };
    const rejected = await call("/runs/" + runId + "/chat", { protocolVersion: "1.0", runId, actionId: randomUUID(),
      idempotencyKey: randomUUID(), expectedEntityVersion: governance.getRun(runId).entityVersion,
      payload: { body: "Wrong attachment", attachments: [attachment.id] } });
    expect(rejected.status).toBe(400);
    expect(listChatMessages(fixture.db, runId)).toHaveLength(1);
  });

  it("requires the owner and validates file count, type, size and reference shape", async () => {
    expect((await upload("data", "file.txt", null)).status).toBe(401);
    expect((await upload("data", "file.txt", "worker-attachment-fixture")).status).toBe(403);
    expect((await upload("data", "file.txt", "owner-attachment-fixture", "missing-project")).status).toBe(404);
    expect((await upload(new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
    const form = new FormData(); form.append("file", "not a file");
    expect((await call("/teams/" + teamId + "/attachments", form)).status).toBe(400);
    const file = await attach();
    for (const refs of [[file.id, file.id], ["../path"], Array.from({ length: 9 }, () => randomUUID())]) {
      expect((await start(refs)).status).toBe(400);
    }
  });
});
