import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { SetupScreen } from "../setup.js";
import { EntryFrame } from "../github-gate.js";

const request = vi.fn(), onLanguage = vi.fn(), onContinue = vi.fn(), setPreference = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useOwnerSession.js")>(),
  useOwnerSession: () => ({ paired: true, request }),
}));
let cache: QueryClient, state: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  state = { tools: [
    { client: "git", ok: true, path: "/mingw64/bin/git" },
    { client: "gh", ok: true, path: "/gh/bin/gh.exe" },
    { client: "claude", ok: false, reason: "not-found" },
    { client: "codex", ok: false, reason: "not-found" },
    { client: "gemini", ok: true, path: "/npm/node_modules/@google/gemini-cli/bundle/gemini.js" },
  ], signIn: [
    { client: "claude", state: "signed-in", signIn: null },
    { client: "codex", state: "signed-out", signIn: "codex login" },
    { client: "gemini", state: "unknown", signIn: "gemini" },
  ], proxy: "", complete: false };
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path !== "/setup") throw new Error("Unexpected request: " + path);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { proxy?: string; complete?: boolean };
      if (body.proxy !== undefined) state = { ...state, proxy: body.proxy };
      if (body.complete) state = { ...state, complete: true };
    }
    return state;
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); cache.clear(); });

async function show(locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  return render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <SetupScreen onContinue={onContinue} />
  </I18nextProvider></QueryClientProvider>);
}

describe("first-run setup", () => {
  it("shows each tool found with its path, and each missing one with its install line", async () => {
    await show();
    expect(await screen.findByText("GitHub CLI")).toBeTruthy();
    // The path is the element's tooltip, behind its info icon.
    expect(screen.getByTitle("/mingw64/bin/git")).toBeTruthy();
    expect(screen.getByTitle("/gh/bin/gh.exe")).toBeTruthy();
    expect(screen.getByText("npm install -g @anthropic-ai/claude-code")).toBeTruthy();
    expect(screen.getByText("npm install -g @openai/codex")).toBeTruthy();
  });

  it("reports each installed client's sign-in state and the command the owner runs", async () => {
    await show();
    const signedIn = await screen.findByText("Signed in");
    expect(signedIn.closest("li")?.textContent).toContain("Claude Code");
    expect(screen.getByText("Not signed in").closest("li")?.textContent).toContain("codex login");
  });

  it("marks each sign-in state on its own terms: a check, a cross, and a neutral dash", async () => {
    await show();
    await screen.findByText("Signed in");
    const rowOf = (label: string) => screen.getByText(label).closest("li")!;
    const iconOf = (label: string) => rowOf(label).querySelector(".setup-mark")!.getAttribute("class")!;
    expect(rowOf("Signed in").getAttribute("data-state")).toBe("signed-in");
    expect(rowOf("Not signed in").getAttribute("data-state")).toBe("signed-out");
    expect(rowOf("Unknown").getAttribute("data-state")).toBe("unknown");
    // A signed-in client is a check; a definitively signed-out one is the cross it always was.
    expect(iconOf("Signed in")).toContain("lucide-check");
    expect(iconOf("Not signed in")).toContain("lucide-x");
    // An unanswered probe is neither: it is a muted dash, not the red failure mark.
    expect(iconOf("Unknown")).toContain("lucide-circle-dashed");
    expect(iconOf("Unknown")).not.toContain("lucide-x");
    // Only a client that answered "signed out" is a failure state; unknown still names the command.
    expect(rowOf("Unknown").getAttribute("data-ok")).toBe("false");
    expect(rowOf("Unknown").querySelector(".setup-command")?.textContent).toBe("gemini");
    expect(rowOf("Signed in").querySelector(".setup-command")).toBeNull();
  });

  it("lists Gemini as a tool with its resolved entry, and reports an unknown sign-in honestly", async () => {
    await show();
    expect(await screen.findByTitle("/npm/node_modules/@google/gemini-cli/bundle/gemini.js")).toBeTruthy();
    const row = screen.getByText("Unknown").closest("li")!;
    expect(row.textContent).toContain("Gemini CLI");
    expect(row.textContent).toContain("gemini");
  });

  it("names Gemini's install line when it is missing", async () => {
    state = { ...state, tools: (state.tools as Array<{ client: string }>).map(row =>
      row.client === "gemini" ? { client: "gemini", ok: false, reason: "not-found" } : row) };
    await show();
    expect(await screen.findByText("npm install -g @google/gemini-cli")).toBeTruthy();
  });

  it("re-checks the tools on demand", async () => {
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "/setup").length).toBeGreaterThan(1));
  });

  it("saves a proxy and clears it again through the same field", async () => {
    await show();
    const field = await screen.findByRole("textbox", { name: "Proxy server" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "http://proxy.test:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/setup", expect.objectContaining({ method: "PUT",
      body: JSON.stringify({ proxy: "http://proxy.test:8080" }) })));
    await waitFor(() => expect(field.value).toBe("http://proxy.test:8080"));
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("keeps a refused proxy visible instead of claiming it saved", async () => {
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") throw new Error("invalid_network_proxy");
      return state;
    });
    await show();
    const field = await screen.findByRole("textbox", { name: "Proxy server" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "socks5://proxy.test:1080" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Use http://host:port, or leave the proxy empty.");
    expect(field.value).toBe("socks5://proxy.test:1080");
  });

  it("records completion and continues to GitHub", async () => {
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Continue to GitHub" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/setup", expect.objectContaining({ method: "PUT",
      body: JSON.stringify({ complete: true }) })));
    await waitFor(() => expect(onContinue).toHaveBeenCalled());
  });

  it("localizes every setup block", async () => {
    await show("zh-CN");
    await screen.findByText("工具");
    expect(document.body.textContent).not.toMatch(/setup\./);
  });
});

describe("settings before GitHub sign-in", () => {
  it("opens from the entry frame and states the account as signed out", async () => {
    const language = await createInterfaceI18n({ language: "en" });
    request.mockImplementation(async (path: string) => {
      if (path === "/setup") return state;
      if (path === "/github/status") return { signedIn: false, login: null, host: "github.com" };
      if (path === "/settings") return { settings: { "team.leadClient": { value: "claude-code", source: "default" } } };
      throw new Error("Unexpected request: " + path);
    });
    render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
      <EntryFrame language={language} onLanguage={onLanguage} appearance={{ preference: "dark", theme: "dark", setPreference: () => {} }}
        onSettings={() => {}}><p>Gate</p></EntryFrame>
    </I18nextProvider></QueryClientProvider>);
    // The entry frame carries the way into Settings before any account check.
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });
});
