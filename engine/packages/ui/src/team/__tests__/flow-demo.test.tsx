import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FlowDemoApp } from "../flow/flow-demo.js";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

it("runs the standalone character demo with current theme controls and synthetic team events", async () => {
  const { container } = render(<FlowDemoApp />);
  expect(await screen.findByRole("heading", { name: "Loom Flow character demo" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dispatch a team member" }));
  expect(screen.getByRole("button", { name: /Tester · Grok, integration/i })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Complete a task" }));
  expect(screen.getByRole("button", { name: /Implementer · ChatGPT, implementer, complete/i })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show idle team" }));
  expect(screen.queryByRole("button", { name: /Implementer · ChatGPT, implementer/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
  expect(container.querySelector(".team-shell")?.getAttribute("data-ui-theme")).toBe("dark");
});
