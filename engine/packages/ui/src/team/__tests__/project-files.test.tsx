import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@loom/i18n";
import { I18nextProvider } from "react-i18next";
import { ProjectFiles } from "../project-files.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => ({ paired: true, request }) }));
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  request.mockReset().mockImplementation(async (url: string) => {
    const path = new URL(url, "http://fixture").searchParams.get("path");
    return path === "src" ? { kind: "directory", entries: [{ name: "hello #1.ts", kind: "file" }] }
      : path === "src/hello #1.ts" ? { kind: "file", content: 'export const tag = "<h1>Text only</h1>";', hash: "hash" }
        : { kind: "directory", entries: [{ name: "src", kind: "directory" }, { name: "README.md", kind: "file" }] };
  });
});
afterEach(() => { cleanup(); client.clear(); });

async function show() {
  const language = await createInterfaceI18n({ language: "en" });
  return render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <ProjectFiles projectId="project" />
  </I18nextProvider></QueryClientProvider>);
}

it("browses nested paths, renders code as text and returns to the project root", async () => {
  await show();
  fireEvent.click(await screen.findByRole("button", { name: "src" }));
  fireEvent.click(await screen.findByRole("button", { name: "hello #1.ts" }));
  expect(await screen.findByText('export const tag = "<h1>Text only</h1>";')).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Text only" })).toBeNull();
  expect(request).toHaveBeenCalledWith("/teams/project/files?path=src%2Fhello%20%231.ts", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  fireEvent.click(screen.getByRole("button", { name: "Project root" }));
  expect(await screen.findByRole("button", { name: "README.md" })).toBeTruthy();
  expect(screen.getByText("Select a file to preview.")).toBeTruthy();
});

it("distinguishes an unreadable directory from an empty one and retries explicitly", async () => {
  request.mockRejectedValueOnce(new Error("unavailable"));
  await show();
  expect((await screen.findByRole("alert")).textContent).toContain("The folder could not be read.");
  expect(screen.queryByText("This folder is empty.")).toBeNull();
  request.mockResolvedValue({ kind: "directory", entries: [] });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("This folder is empty.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the listing usable when a file has no text preview", async () => {
  await show();
  const file = await screen.findByRole("button", { name: "README.md" });
  request.mockRejectedValueOnce(new Error("binary"));
  fireEvent.click(file);
  expect((await screen.findByRole("alert")).textContent).toContain("This file is not available for text preview.");
  expect(screen.getByRole("button", { name: "src" })).toBeTruthy();
  request.mockResolvedValueOnce({ kind: "file", content: "Readable again", hash: "hash" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Readable again")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
