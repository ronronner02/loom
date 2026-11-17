import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { useTeamNavigation } from "../workspace-navigation.js";

afterEach(cleanup);

function harness(path: string, project = "team-1") {
  const captured: { current?: ReturnType<typeof useTeamNavigation> } = {};
  function Probe() {
    captured.current = useTeamNavigation(project);
    return <button onClick={() => captured.current!.go("workspace", { task: "task-9" })}>Go</button>;
  }
  const root = createRootRoute({ component: () => <Outlet /> });
  const team = createRoute({
    getParentRoute: () => root, path: "/team",
    validateSearch: (search: Record<string, unknown>) => ({
      run: typeof search.run === "string" ? search.run : undefined,
      task: typeof search.task === "string" ? search.task : undefined,
      team: typeof search.team === "string" ? search.team : undefined,
    }),
    component: () => <Outlet />,
  });
  const page = createRoute({ getParentRoute: () => team, path: "$section", component: Probe });
  const router = createRouter({ routeTree: root.addChildren([team.addChildren([page])]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: [path] }) });
  return { router, captured };
}

async function open(path: string) {
  const harnessed = harness(path);
  await act(async () => { render(<RouterProvider router={harnessed.router} />); await harnessed.router.load(); });
  return harnessed;
}

describe("team navigation", () => {
  it("seeds the sub-tab from the legacy route that named it", async () => {
    const workspaceTabs = [["/team/reviews", "reviews"], ["/team/inbox", "inbox"]] as const;
    for (const [path, tab] of workspaceTabs) {
      const { captured } = await open(path);
      expect(captured.current!.section).toBe("workspace");
      expect(captured.current!.workspaceTab).toBe(tab);
      cleanup();
    }
    const overviewTabs = [["/team/flow", "flow"], ["/team/analytics", "analytics"]] as const;
    for (const [path, tab] of overviewTabs) {
      const { captured } = await open(path);
      expect(captured.current!.section).toBe("overview");
      expect(captured.current!.overviewTab).toBe(tab);
      cleanup();
    }
  });

  it("keeps the run and project in every href and drops the task on destinations without one", async () => {
    const { captured } = await open("/team/tasks?run=run-1&team=team-1&task=task-2");
    const navigation = captured.current!;
    expect(navigation.hrefFor("workspace")).toContain("task=task-2");
    expect(navigation.hrefFor("overview")).not.toContain("task=");
    expect(navigation.hrefFor("overview")).toContain("run=run-1");
    expect(navigation.hrefFor("overview")).toContain("team=team-1");
  });

  it("carries the open run and project into a destination that adds a task", async () => {
    const { router, captured } = await open("/team/overview?run=run-1&team=team-1");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Go" })); });
    expect(router.state.location.pathname).toBe("/team/workspace");
    expect(router.state.location.search).toMatchObject({ run: "run-1", team: "team-1", task: "task-9" });
    expect(captured.current!.section).toBe("workspace");
  });

  it("falls back to the chat section for an unknown path", async () => {
    const { captured } = await open("/team/unknown");
    expect(captured.current!.section).toBe("chat");
  });
});