import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@loom/i18n";
import { I18nextProvider } from "react-i18next";
import { Entry } from "../entry.js";

const request = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useOwnerSession.js")>(),
  useOwnerSession: () => ({ paired: true, request }),
}));
// The workspace has its own tests through the real route; here the composition is what is read.
vi.mock("../team-workspace.js", () => ({ TeamWorkspaceScreen: () => <p>Workspace</p> }));

let cache: QueryClient;
const tools = (codexOk: boolean) => [
  { client: "git", ok: true, path: "/bin/git" }, { client: "gh", ok: true, path: "/bin/gh" },
  { client: "claude", ok: true, path: "/bin/claude" }, { client: "codex", ok: codexOk, reason: codexOk ? undefined : "not-found" },
  { client: "gemini", ok: true, path: "/bin/gemini" },
];
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); cache.clear(); });

async function show(locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <Entry language={language} onLanguage={() => {}} appearance={{ preference: "dark", theme: "dark", setPreference: () => {} }} paired />
  </I18nextProvider></QueryClientProvider>);
}

describe("first run", () => {
  it("opens the workspace without the setup screen when every tool is present", async () => {
    request.mockResolvedValue({ tools: tools(true), signIn: [], proxy: "", complete: false });
    await show();
    expect(await screen.findByText("Workspace")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Setup" })).toBeNull();
    // The all-OK read is recorded, so a later launch is decided without the read.
    await waitFor(() => expect(localStorage.getItem("loom.setupComplete")).toBe("done"));
  });

  it("shows setup when a tool is missing, and the workspace once the owner continues", async () => {
    request.mockResolvedValue({ tools: tools(false), signIn: [], proxy: "", complete: false });
    await show();
    expect(await screen.findByRole("heading", { name: "Setup" })).toBeTruthy();
    expect(screen.queryByText("Workspace")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Workspace")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Setup" })).toBeNull();
  });

  it("does not block on agent sign-in or the proxy, only on the tools", async () => {
    request.mockResolvedValue({ tools: tools(true), signIn: [{ client: "claude", state: "signed-out", signIn: "claude" }],
      proxy: "http://proxy.test:8080", complete: false });
    await show();
    expect(await screen.findByText("Workspace")).toBeTruthy();
  });

  it("shows neither screen while the setup read is in flight", async () => {
    request.mockImplementation(() => new Promise(() => {}));
    await show();
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Loading");
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Setup" })).toBeNull();
  });

  it("shows setup rather than the workspace when the read fails", async () => {
    request.mockRejectedValue(new Error("read failed"));
    await show();
    expect(await screen.findByRole("heading", { name: "Setup" })).toBeTruthy();
    expect(screen.queryByText("Workspace")).toBeNull();
  });

  it("skips the read when this browser already recorded setup", async () => {
    localStorage.setItem("loom.setupComplete", "done");
    await show();
    expect(await screen.findByText("Workspace")).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
});
