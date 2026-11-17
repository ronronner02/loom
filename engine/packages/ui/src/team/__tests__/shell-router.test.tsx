import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import type { TeamModelSettings } from "@multi-agent/daemon/team-control";
import { routeTree } from "../../routes.js";
import { queryClient } from "../../lib/query-client.js";
import { attempt, health, read, RUN_ID, task } from "./fixtures.js";
import { FRAMEWORK_CATALOG } from "../../../../daemon/dist/integrations/framework/catalog.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

const SECOND_RUN_ID = "f8859201-204f-4abc-8234-55cc82ab8b2b";
let extraRun = false;
let mobile = false;
let signedIn = true;
let accountFailure = false;
let readFailure = false;
let replayEvents: object[] = [];
let flowSettings: TeamModelSettings | undefined;
let observedFlowModel: string | null = null;
/** Attempts the read endpoint returns; a projection test sets them so a refetch keeps them. */
let readAttempts: ReturnType<typeof attempt>[] = [];
const data = read({ tasks: [task({ queueState: "pending", stage: "queued" }), task({ taskId: "task-2", displayName: "Filter chips", queueState: "pending", stage: "queued" })] });
const unexpected: string[] = [];
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  extraRun = false; mobile = false; signedIn = true; accountFailure = false; readFailure = false; replayEvents = []; flowSettings = undefined; unexpected.length = 0;
  observedFlowModel = null; readAttempts = [];
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  localStorage.clear(); sessionStorage.clear(); queryClient.clear();
  localStorage.setItem("multi-agent.interfaceLanguage", "en");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...original(query), matches: mobile && (query === "(max-width: 859px)" || query === "(max-width: 760px)") }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
    const response = (body: object) => new Response(JSON.stringify({ protocolVersion: "1.0", ...body }), { headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/owner-session/exchange")) return response({ antiForgeryToken: "a".repeat(43) });
    if (path.endsWith("/github/status")) return accountFailure
      ? new Response(JSON.stringify({ code: "github_login_failed" }), { status: 503 })
      : response({ signedIn, login: signedIn ? "fixture-owner" : null, host: "github.com" });
    if (path.endsWith("/github/login")) return response({ state: "idle" });
    if ((init?.method ?? "GET") === "GET") {
      if (path === "/api/team-control/workflows") return response({ workflows: FRAMEWORK_CATALOG });
      if (path === "/api/team-control/teams/fresh-project/files") {
        const query = new URL(String(input), window.location.origin).searchParams.get("path");
        return response(query === "README.md" ? { kind: "file", path: "README.md", content: "# Existing project", hash: "fixture-hash" }
          : { kind: "directory", path: "", entries: [{ name: "README.md", kind: "file" }] });
      }
      if (path === `/api/team-control/runs/${RUN_ID}/workflows` || path === `/api/team-control/runs/${SECOND_RUN_ID}/workflows`) return response({ workflows: [] });
      if (path === "/api/team-control/teams/fresh-project/prompt-sections") return response({ revision: 0, sections: [] });
      if (/\/api\/team-control\/teams\/[^/]+\/intake$/.test(path)) return response({ policy: { revision: 0, mode: "observe", rules: [] }, repository: null, items: [] });
      if (path === "/api/team-control/teams/fresh-project/souls") return response({
        profiles: [{ id: "coordinator", name: "Project coordinator", roles: ["lead"], version: 1,
          content: "Plan and delegate the approved work.", digest: "b".repeat(64) }],
        seats: [{ nodeId: "fresh-lead", role: "lead", soulId: "coordinator", member: "lead@fresh-project" }],
      });
    }
    if (/\/teams\/[^/]+\/settings$/.test(path)) return response({ settings: flowSettings ?? { teamId: "fresh-project", kind: "project", configured: false,
      lead: { client: "codex", model: null }, allowedSubagents: null, launches: [] } });
    if (path.endsWith("/settings")) return response({ settings: { "team.leadClient": { value: "claude-code", source: "default" } } });
    if (path.endsWith("/analytics")) return response({ analytics: null });
    if (/\/attempts\/[^/]+\/activity$/.test(path)) return response({ activity: {
      attemptId: attempt().attemptId, state: "running", source: "live", records: [], nextSeq: 0, activityStatus: "unavailable",
      startedAt: data.generatedAt, stoppedAt: null, activeMs: 0, outcome: "unknown",
      usage: { model: observedFlowModel, status: observedFlowModel ? "partial" : "unavailable", reason: null,
        inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null },
    } });
    if (path === "/api/team-control/teams") return response({ teams: [
      { id: data.run.rigId, name: "Status board", repository: "/fixture", seats: [] },
      { id: "fresh-project", name: "Fresh project", repository: "/fixture/fresh", seats: [{ role: "lead", client: "codex" }] },
    ] });
    if (path === "/api/team-control/runs") return response({ runs: [
      { id: RUN_ID, rigId: data.run.rigId, rigName: "Status board", displayName: data.run.displayName, state: data.run.state },
      ...(extraRun ? [{ id: SECOND_RUN_ID, rigId: data.run.rigId, rigName: "Status board", displayName: "Second run", state: data.run.state }] : []),
    ] });
    if (path.endsWith("/health")) return response({ health: health() });
    if (path.endsWith("/read") && readFailure) return new Response(JSON.stringify({ code: "team_read_failed" }), { status: 500 });
    if (path.endsWith("/read")) return response({ read: path.includes(SECOND_RUN_ID)
      ? { ...data, runId: SECOND_RUN_ID, run: { ...data.run, id: SECOND_RUN_ID, displayName: "Second run" }, attempts: readAttempts }
      : { ...data, attempts: readAttempts } });
    if (path.endsWith("/events/stream")) return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
    if (path.endsWith("/replay")) return response({ runId: path.includes(SECOND_RUN_ID) ? SECOND_RUN_ID : RUN_ID, events: replayEvents, window: data.replay, gap: false });
    if (path.endsWith("/chat")) return response({ phase: "delivery", pendingDecision: null, messages: [{
      id: "question-1", sender: "lead", kind: "decision", body: "Keep the existing behavior?", options: ["Keep", "Change"], answeredBy: null, createdAt: data.generatedAt,
    }] });
    if (path.endsWith("/comments")) return response({ comments: [] });
    if (path.endsWith("/integration")) return response({ integration: { branch: "team/status-filter", commits: [], tasksDone: false, merge: { possible: false, reason: null } } });
    if (path.endsWith("/result")) return response({ result: { patch: "" } });
    if (path.endsWith("/completion")) return response({ completion: { queueState: "pending", attempt: null } });
    unexpected.push(path);
    return new Response(JSON.stringify({ code: "unexpected_fixture_read" }), { status: 404 });
  }));
});
afterEach(() => {
  cleanup(); queryClient.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  expect(unexpected).toEqual([]);
});

async function openShell() {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/team/overview?run=${RUN_ID}`] }), defaultPendingMinMs: 0 });
  await act(async () => { render(<RouterProvider router={router} />); await router.load(); });
  const pairing = await screen.findByLabelText("One-time pairing code");
  fireEvent.change(pairing, { target: { value: "fixture-pairing" } });
  fireEvent.submit(pairing.closest("form")!);
  await screen.findByRole("button", { name: "Notifications: 1" });
  return router;
}

describe("command-center router integration", () => {
  it("opens existing files in Workspace before a project's first conversation", async () => {
    const router = await openShell();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "fresh-project" } });
    await screen.findByRole("heading", { name: "What should we work on?" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Loom" })).getByRole("link", { name: "Workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    expect(await screen.findByText("# Existing project")).toBeTruthy();
    expect(router.state.location.search.team).toBe("fresh-project");
    expect(router.state.location.search.run).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/runs") && init?.method === "POST")).toBe(false);
  });


  it("clears the main chat draft when switching runs in the same project", async () => {
    extraRun = true;
    const router = await openShell();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Loom" })).getByRole("link", { name: "Chat" }));
    const field = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "Keep this instruction inside the first run" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Run" }), { target: { value: SECOND_RUN_ID } });
    await waitFor(() => expect(router.state.location.search.run).toBe(SECOND_RUN_ID));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", ""));
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveProperty("value", data.run.rigId);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")).toBe(false);
  });

  it("clears the main chat draft when switching projects", async () => {
    await openShell();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Loom" })).getByRole("link", { name: "Chat" }));
    const field = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "Only change the original project's credentials" } });
    fireEvent.change(screen.getByLabelText("Choose attachments"), { target: { files: [new File(["Project notes"], "first-project.md")] } });
    expect(screen.getByText("first-project.md")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "fresh-project" } });
    await screen.findByRole("heading", { name: "What should we work on?" });
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("first-project.md")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/attachments") && init?.method === "POST")).toBe(false);
  });

  it("gates the paired app before any project read when GitHub is signed out", async () => {
    signedIn = false;
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/team/overview"] }), defaultPendingMinMs: 0 });
    await act(async () => { render(<RouterProvider router={router} />); await router.load(); });
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes("/github/"))).toBe(false);
    const pairing = await screen.findByLabelText("One-time pairing code");
    fireEvent.change(pairing, { target: { value: "fixture-pairing" } });
    fireEvent.submit(pairing.closest("form")!);
    expect(await screen.findByRole("heading", { name: "Sign in to GitHub" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Loom" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([path]) => /\/(teams|runs)(?:\?|$)/.test(String(path)))).toBe(false);
  });

  it("renders replay events in the Overview Flow sub-tab", async () => {
    replayEvents = [{
      seq: 2, createdAt: "2026-11-14 10:00:00", type: "team.control", action: "task.created",
      runId: RUN_ID, taskId: "task-1", attemptId: "attempt-1",
      body: '{"workerSeat":"impl@rig"}', truncated: false,
    }];
    await openShell();
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    expect(await screen.findByRole("heading", { name: "Flow" })).toBeTruthy();
    expect(await screen.findByText(/Task assigned/)).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Team seats" })).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Implementer/ })).toBeNull();
  });

  it("states a read failure in the Flow sub-tab instead of showing an empty stage", async () => {
    readFailure = true;
    await openShell();
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    await screen.findByRole("heading", { name: "Flow" });
    const flow = screen.getByRole("heading", { name: "Flow" }).closest(".flow-view")!;
    expect(within(flow as HTMLElement).getByRole("alert").textContent).toBe("Read failed");
    expect(within(flow as HTMLElement).queryByRole("group", { name: "Team seats" })).toBeNull();
  });

  it("publishes the restored Overview summary through the real route", async () => {
    await openShell();
    expect(screen.getByRole("region", { name: "Run summary" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "System status" })).getAllByText("Unknown")).toHaveLength(6);
  });

  it("shows workers only while dispatched and preserves history after they stop", async () => {
    replayEvents = [{
      seq: 2, createdAt: "2026-11-14 10:00:00", type: "team.control", action: "worker.tool.started",
      runId: RUN_ID, taskId: "task-1", attemptId: "attempt-1",
      body: '{"workerSeat":"impl@rig","tool":"read"}', truncated: false,
    }];
    await openShell();
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    expect(screen.queryByRole("button", { name: /^Implementer/ })).toBeNull();
    readAttempts = [attempt({ state: "running" })];
    act(() => { queryClient.setQueryData(["team", RUN_ID, "read"], { ...data, attempts: readAttempts }); });
    const worker = await screen.findByRole("button", { name: /^Implementer/ });
    expect(worker.getAttribute("data-state")).toBe("working");
    expect(worker.getAttribute("data-vendor")).toBe("unknown");
    readAttempts = [attempt({ state: "stopped" })];
    act(() => { queryClient.setQueryData(["team", RUN_ID, "read"], { ...data, attempts: readAttempts }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Implementer/ })).toBeNull());
    expect(within(screen.getByRole("group", { name: "Team seats" })).getAllByRole("button")).toHaveLength(1);
    expect(within(screen.getByLabelText("Flow event list")).getByText(/Tool activity/)).toBeTruthy();
  });

  it("renders actual models from the settings endpoint without making the allowlist a permanent cast", async () => {
    flowSettings = {
      teamId: data.run.rigId, kind: "project", configured: true,
      lead: { client: "claude-code", model: "ds/claude" },
      allowedSubagents: [{ client: "codex", model: "grok-4" }, { client: "claude-code", model: "qwen3-coder" }],
      launches: [{ attemptId: attempt().attemptId, runId: RUN_ID, client: "codex", role: "implementer",
        requestedModel: "grok-4", observedModel: null, state: "running", createdAt: data.generatedAt }],
    };
    observedFlowModel = "qwen3-coder";
    replayEvents = [{ seq: 2, createdAt: data.generatedAt, type: "team.control", action: "worker.tool.started",
      runId: RUN_ID, taskId: "task-1", attemptId: attempt().attemptId, body: '{}', truncated: false }];
    await openShell();
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    const members = within(screen.getByRole("group", { name: "Team seats" }));
    const lead = members.getByRole("button", { name: /^Lead/ });
    await waitFor(() => expect(lead.getAttribute("data-vendor")).toBe("deepseek"));
    expect(lead.getAttribute("title")).toBe("ds/claude / claude-code");
    expect(members.getAllByRole("button")).toHaveLength(1);
    readAttempts = [attempt({ state: "running", provider: "codex" })];
    act(() => { queryClient.setQueryData(["team", RUN_ID, "read"], { ...data, attempts: readAttempts }); });
    const worker = await members.findByRole("button", { name: /^Implementer/ });
    await waitFor(() => expect(worker.getAttribute("data-vendor")).toBe("qwen"));
    expect(worker.querySelector("img")?.getAttribute("src")).toBe("/avatars/vendors/qwen_working.png");
    expect(worker.getAttribute("title")).toBe("qwen3-coder / codex");
    expect(members.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByLabelText("Flow event list").textContent).not.toContain(attempt().attemptId);
  });

  it("keeps a project selected across destinations before its first run", async () => {
    const router = await openShell();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "fresh-project" } });
    expect(await screen.findByRole("heading", { name: "What should we work on?" })).toBeTruthy();
    expect(router.state.location.search.team).toBe("fresh-project");
    expect(router.state.location.search.run).toBeUndefined();
    expect(screen.getByRole("button", { name: "Open lead chat" })).toHaveProperty("disabled", false);
    const nav = screen.getByRole("navigation", { name: "Loom" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsDialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settingsDialog).getAllByRole("heading", { name: "Settings" }).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(within(settingsDialog).getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    fireEvent.click(within(nav).getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { name: "Fresh project" })).toBeTruthy();
    expect(router.state.location.search.team).toBe("fresh-project");
    expect(screen.queryByRole("textbox", { name: "What should the team do?" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Planning records" })).toBeTruthy();
    fireEvent.click(within(nav).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("No execution tasks yet. Approve a plan before implementation starts.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open lead chat" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Plan without execution" } });
    fireEvent.click(within(nav).getByRole("link", { name: "Workspace" }));
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Plan without execution");
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/runs") && init?.method === "POST")).toBe(false);
  });

  it("opens the retained board from the default list and restores its card focus", async () => {
    await openShell();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Loom" })).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByRole("region", { name: "Task list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByRole("region", { name: "Queued" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Waiting on lead" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Waiting on you" })).toBeTruthy();
    const card = within(screen.getByRole("region", { name: "Queued" })).getByRole("button", { name: /Filter chips/ });
    card.focus(); fireEvent.click(card);
    const drawer = await screen.findByRole("dialog", { name: "Filter chips" });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("opens Workspace layouts and the read-only Reviews gates through the Workspace sub-tabs", async () => {
    const renderErrors = vi.spyOn(console, "error").mockImplementation(() => {});
    await openShell();
    fireEvent.click(screen.getByRole("button", { name: "Open lead chat" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Keep my original question" } });
    fireEvent.click(screen.getByRole("button", { name: "Close lead chat" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const nav = screen.getByRole("navigation", { name: "Loom" });
    fireEvent.click(within(nav).getByRole("link", { name: "Workspace" }));
    expect(await screen.findByRole("button", { name: "Grid" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Split" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reviews & Diffs" }));
    expect(await screen.findByRole("region", { name: "Gates" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask the lead" }));
    const panel = screen.getByRole("dialog", { name: "Lead chat" });
    expect((within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep my original question\n\nAbout the review for Status filter:");
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url).endsWith("/chat") && options?.method === "POST")).toBe(false);
    expect(renderErrors).not.toHaveBeenCalled();
  });

  it("keeps the real chat draft mounted while every destination changes the URL", async () => {
    const renderErrors = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = await openShell();
    const opener = screen.getByRole("button", { name: "Open lead chat" });
    fireEvent.click(opener);
    const panel = screen.getByRole("dialog", { name: "Lead chat" });
    const field = within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Retain this question across sections" } });
    const nav = screen.getByRole("navigation", { name: "Loom" });
    for (const section of ["Documents", "Tasks", "Documents", "Workspace", "Documents", "Overview"]) {
      const link = within(nav).getByRole("link", { name: section });
      fireEvent.pointerDown(link); fireEvent.click(link);
      await waitFor(() => expect(router.state.location.pathname).toBe(`/team/${section.toLowerCase()}`));
      expect(router.state.location.search.run).toBe(RUN_ID);
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(within(panel).getByRole("textbox", { name: "Message" })).toBe(field);
      expect(field.value).toBe("Retain this question across sections");
      expect(screen.queryAllByRole("heading", { name: "Documents" })).toHaveLength(section === "Documents" ? 1 : 0);
    }
    expect(renderErrors).not.toHaveBeenCalled();
    const rows = within(panel).getByRole("region", { name: "Needs your attention" });
    expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it.each([false, true])("retains the open conversation and route through a failed background account check without exposing gated controls (mobile: %s)", async mobileMode => {
    mobile = mobileMode;
    const router = await openShell();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Loom" })).getByRole("link", { name: "Documents" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/team/documents"));
    fireEvent.click(screen.getByRole("button", { name: "Open lead chat" }));
    const panel = screen.getByRole("dialog", { name: "Lead chat" });
    const field = within(panel).getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "Retain the current requirements discussion" } });
    accountFailure = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["team", "github", "status"] }); });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Lead chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(field.isConnected).toBe(true);
    accountFailure = false;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["team", "github", "status"] }); });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Lead chat" })).toBe(panel));
    expect(within(panel).getByRole("textbox", { name: "Message" })).toBe(field);
    expect(field).toHaveProperty("value", "Retain the current requirements discussion");
    expect(router.state.location.pathname).toBe("/team/documents");
    expect(router.state.location.search.run).toBe(RUN_ID);
  });

  it("uses Ctrl K and Enter to navigate to the selected task", async () => {
    const router = await openShell();
    const opener = screen.getByRole("button", { name: "Search" });
    opener.focus(); fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const field = screen.getByRole("combobox", { name: "Search or jump to…" });
    fireEvent.keyDown(field, { key: "ArrowDown" }); fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(router.state.location.search.task).toBe("task-2"));
    expect(router.state.location.pathname).toBe("/team/tasks");
    expect(router.state.location.search.run).toBe(RUN_ID);
    expect(screen.getByRole("heading", { name: "Filter chips" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Task detail" })).getByRole("heading", { name: "Filter chips" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Task list" })).getByRole("button", { name: /Filter chips/ }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("opens chat from top bar on mobile and returns focus to the trigger", async () => {
    mobile = true;
    await openShell();
    const opener = screen.getByRole("button", { name: "Open lead chat" });
    fireEvent.click(opener);
    const panel = screen.getByRole("dialog", { name: "Lead chat" });
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("returns focus to the mobile menu after closing Create", async () => {
    mobile = true;
    await openShell();
    const menu = screen.getByLabelText("Open navigation");
    menu.style.display = "grid";
    fireEvent.click(menu);
    const navigation = screen.getByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(navigation.isConnected).toBe(false));
    const create = await screen.findByRole("dialog", { name: "Create project" });
    fireEvent.keyDown(create, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });
});
