import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { SetupScreen } from "../setup.js";

const request = vi.fn(), onLanguage = vi.fn(), onContinue = vi.fn();
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
  ], signIn: [
    { client: "claude", state: "signed-in", signIn: null },
    { client: "codex", state: "signed-out", signIn: "codex login" },
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
    <SetupScreen language={locale} onLanguage={onLanguage} onContinue={onContinue} />
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

  it("offers the language choice and reports it to the shell", async () => {
    await show();
    const select = await screen.findByRole("combobox", { name: "Language" });
    fireEvent.change(select, { target: { value: "zh-CN" } });
    expect(onLanguage).toHaveBeenCalledWith("zh-CN");
  });

  it("localizes every setup block", async () => {
    await show("zh-CN");
    await screen.findByText("工具");
    expect(document.body.textContent).not.toMatch(/setup\./);
  });
});