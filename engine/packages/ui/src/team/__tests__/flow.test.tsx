import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n, type InterfaceLanguage } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import type { i18n as I18n } from "i18next";
import { FlowView } from "../flow/FlowView.js";
import { HIGH_DENSITY_EVENTS, HIGH_DENSITY_SEATS, LOW_DENSITY_EVENTS, FLOW_FIXTURE_SEATS } from "./flow-fixtures.js";
import { mapTeamEvents } from "../flow/flow-events.js";
import { FlowRenderer } from "../flow/flow-renderer.js";
import { getVendorAvatarUrl, resolveAvatarState, resolveVendorForNode } from "../flow/vendor-avatars.js";

function contextStub(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    canvas: document.createElement("canvas"),
    clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop,
    arc: noop, fill: noop, stroke: noop, save: noop, restore: noop, fillText: noop, setLineDash: noop,
    measureText: () => ({ width: 20 } as TextMetrics),
    setTransform: noop,
    globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: "", strokeStyle: "", fillStyle: "",
  } as unknown as CanvasRenderingContext2D;
}

const languages = new Map<InterfaceLanguage, I18n>();
const show = (language: InterfaceLanguage = "en") => render(<I18nextProvider i18n={languages.get(language)!}>
  <FlowView events={LOW_DENSITY_EVENTS} seats={FLOW_FIXTURE_SEATS} />
</I18nextProvider>);

beforeAll(async () => {
  for (const language of ["en", "zh-CN"] as const) languages.set(language, (await createInterfaceI18n({ language })).instance);
});

describe("FlowView", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => contextStub()) });
  });

  afterEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: originalGetContext });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: originalRaf });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: originalCancelRaf });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });

  it("renders accessible names and selects a node with a native click", () => {
    show();
    const worker = screen.getByRole("button", { name: /Worker 1, implementer/i });
    fireEvent.click(worker);
    expect(worker.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status", { name: /Selected Worker 1/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lead, lead/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reviewer, reviewer/i })).toBeTruthy();
  });

  it("shows a loading state instead of an empty stage while the events query seeds", () => {
    render(<I18nextProvider i18n={languages.get("en")!}><FlowView events={[]} loading /></I18nextProvider>);
    expect(screen.getByRole("status").textContent).toBe("Loading team events…");
    expect(screen.queryByRole("group", { name: "Team seats" })).toBeNull();
  });

  it("shows a read failure instead of an empty stage when the run read fails", () => {
    render(<I18nextProvider i18n={languages.get("en")!}><FlowView events={[]} error /></I18nextProvider>);
    expect(screen.getByRole("alert").textContent).toBe("Read failed");
    expect(screen.queryByRole("group", { name: "Team seats" })).toBeNull();
  });

  it("sizes the canvas to the available mobile stage instead of clipping it", () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(380);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
    const { container } = show();
    expect(container.querySelector("canvas")?.style.height).toBe("380px");
  });

  it("pauses and resumes the frame loop", () => {
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const raf = vi.fn((callback: FrameRequestCallback) => {
      const id = ++next;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => callbacks.delete(id));
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: raf });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: cancel });
    show();
    expect(raf).toHaveBeenCalled();
    const callsBeforePause = raf.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resume" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(raf.mock.calls.length).toBeGreaterThan(callsBeforePause);
  });

  it("pauses on window blur and restarts on focus", () => {
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const raf = vi.fn((callback: FrameRequestCallback) => {
      const id = ++next;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => callbacks.delete(id));
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: raf });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: cancel });
    show();
    const callsBeforeBlur = raf.mock.calls.length;
    fireEvent(window, new Event("blur"));
    expect(cancel).toHaveBeenCalled();
    fireEvent(window, new Event("focus"));
    expect(raf.mock.calls.length).toBeGreaterThan(callsBeforeBlur);
  });

  it("renders the static event list for reduced motion", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    show();
    expect(screen.getByText(/Motion is reduced/i)).toBeTruthy();
    expect(screen.getByLabelText("Flow event list")).toBeTruthy();
    expect(screen.getAllByText("task assigned", { exact: false }).length).toBeGreaterThan(0);
  });

  it.each(["reduced motion", "unavailable canvas"])("keeps idle team members selectable with %s", (mode) => {
    if (mode === "reduced motion") {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    } else {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => null) });
    }
    render(<I18nextProvider i18n={languages.get("en")!}>
      <FlowView events={[]} seats={[{ id: "lead", role: "lead" }, { id: "idle-worker", label: "Idle worker", role: "implementer" }]} />
    </I18nextProvider>);
    const worker = screen.getByRole("button", { name: /Idle worker, implementer/i });
    fireEvent.click(worker);
    expect(worker.getAttribute("aria-pressed")).toBe("true");
    expect(worker.closest(".flow-view")?.getAttribute("data-render-mode")).toBe("static");
  });

  it("renders its controls and states from the active interface language", () => {
    show("zh-CN");
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "团队席位" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /负责人，负责人/ })).toBeTruthy();
  });

  it("falls back to the static event list when Canvas2D is unavailable", () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => null) });
    show();
    expect(screen.getByText(/Canvas2D is unavailable/i)).toBeTruthy();
    expect(screen.getByLabelText("Flow event list")).toBeTruthy();
  });

  it("clears historical working labels when the current attempt stops", () => {
    const events = [{ ...LOW_DENSITY_EVENTS[3]!, timestamp: Date.now() - 86_400_000 }];
    const view = (working: boolean) => <I18nextProvider i18n={languages.get("en")!}>
      <FlowView events={events} seats={FLOW_FIXTURE_SEATS}
        nodeStates={new Map([["worker-1", working ? "working" : "idle"]])} />
    </I18nextProvider>;
    const { rerender } = render(view(true));
    expect(screen.getByRole("button", { name: /Worker 1,/ }).getAttribute("data-state")).toBe("working");
    rerender(view(false));
    const worker = screen.getByRole("button", { name: /Worker 1,/ });
    expect(worker.getAttribute("data-state")).toBe("idle");
    expect(worker.getAttribute("data-avatar-state")).toBe("master");
  });

  it("does not infer live work from replay history when there are no current attempts", () => {
    render(<I18nextProvider i18n={languages.get("en")!}>
      <FlowView events={LOW_DENSITY_EVENTS} seats={FLOW_FIXTURE_SEATS} nodeStates={new Map()} />
    </I18nextProvider>);
    for (const node of screen.getAllByRole("button").filter(node => node.hasAttribute("data-state"))) {
      expect(node.getAttribute("data-state")).toBe("idle");
    }
  });
});

describe("FlowRenderer", () => {
  it("draws the high-density fixture within a generous frame budget", () => {
    const canvas = document.createElement("canvas");
    const renderer = new FlowRenderer({ canvas, maxParticles: 96 });
    const mapping = mapTeamEvents(HIGH_DENSITY_EVENTS, { seats: HIGH_DENSITY_SEATS, maxParticles: 96 });
    renderer.resize(960, 640);
    renderer.setModel(mapping);
    const start = performance.now();
    renderer.draw(contextStub(), Date.now());
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
  });

  it("reports active messaging nodes during message launch", () => {
    const canvas = document.createElement("canvas");
    const renderer = new FlowRenderer({ canvas });
    const mapping = mapTeamEvents([{ ...LOW_DENSITY_EVENTS[0]!, timestamp: 900 }], { seats: FLOW_FIXTURE_SEATS });
    renderer.setModel(mapping, 0);
    renderer.draw(contextStub(), 900);
    const active = renderer.getActiveMessagingNodes(900);
    expect(active).toEqual(new Set(["lead"]));
    renderer.draw(contextStub(), 2_100);
    expect(renderer.getNodeVisualStates(2_100).get("worker-1")?.isReceiving).toBe(true);
    renderer.draw(contextStub(), 2_700);
    expect([...renderer.getNodeVisualStates(2_700).values()].every(state => !state.isMessaging && !state.isReceiving)).toBe(true);
    renderer.setModel(mapping, 3_400);
    expect(renderer.getActiveMessagingNodes(3_400).size).toBe(0);
  });

  it("never repeats expired message flights from replay history", () => {
    const renderer = new FlowRenderer({ canvas: document.createElement("canvas") });
    const mapping = mapTeamEvents([{ ...LOW_DENSITY_EVENTS[0]!, timestamp: 1_000 }], { seats: FLOW_FIXTURE_SEATS });
    renderer.setModel(mapping, 10_000);
    renderer.draw(contextStub(), 11_000);
    for (const now of [13_600, 13_700, 17_000, 20_400]) {
      renderer.draw(contextStub(), now);
      expect(renderer.getActiveMessagingNodes(now).size, `frame ${now}`).toBe(0);
      expect([...renderer.getNodeVisualStates(now).values()].some(state => state.isMessaging || state.isReceiving)).toBe(false);
    }
  });

  it("keeps completed workers departed without replaying old messages", () => {
    const canvas = document.createElement("canvas");
    const renderer = new FlowRenderer({ canvas });
    const now = 10_000;
    const mapping = mapTeamEvents(
      [
        {
          type: "team.control",
          protocolVersion: "1.0",
          eventId: "e1",
          runId: "r1",
          taskId: "t1",
          attemptId: "a1",
          entityId: "chatgpt",
          action: "task.created",
          payload: { leadSeat: "lead", workerSeat: "chatgpt" },
          timestamp: now - 5_000,
          seq: 1,
        },
        {
          type: "team.control",
          protocolVersion: "1.0",
          eventId: "e2",
          runId: "r1",
          taskId: "t1",
          attemptId: "a1",
          entityId: "chatgpt",
          action: "task.outcome",
          payload: { workerSeat: "chatgpt", leadSeat: "lead", status: "done" },
          timestamp: now - 4_000,
          seq: 2,
        },
      ],
      {
        seats: [
          { id: "lead", label: "Lead", role: "lead" },
          { id: "chatgpt", label: "ChatGPT", role: "implementer" },
        ],
      },
    );
    renderer.setModel(mapping, now);
    renderer.draw(contextStub(), now + 800);
    renderer.draw(contextStub(), now + 3_100);
    renderer.draw(contextStub(), now + 3_900);
    const states = renderer.getNodeVisualStates(now + 3_900);
    expect(states.get("chatgpt")?.phase).toBe("gone");
    expect(renderer.getActiveMessagingNodes(now + 3_900).size).toBe(0);
  });
});

describe("vendor avatars", () => {
  it.each([
    ["ds", "deepseek"], ["ds/claude", "deepseek"], ["deepseek/deepseek-v3.2", "deepseek"],
    ["grok-4", "grok"], ["xai/grok-code-fast-1", "grok"], ["grok/claude", "grok"],
    ["qwen3-coder", "qwen"], ["qwen/qwen3-coder", "qwen"], ["qwen/codex", "qwen"],
    ["claude-sonnet-4-5", "claude"], ["opus", "claude"], ["gpt-5-codex", "chatgpt"],
    ["gemini-2.5-pro", "gemini"], ["kimi-k2", "kimi"],
  ])("uses the model %s for the %s character independently of the client", (model, expected) => {
    for (const client of ["claude-code", "codex"]) {
      const node = { id: `${client}@rig`, label: `Implementer · ${client}`, role: "implementer" as const, client, model };
      expect(resolveVendorForNode(node)).toBe(expected);
    }
  });

  it.each(["lead", "reviewer", "integration", "owner", "worker"] as const)("does not invent a vendor for a %s with no known model", role => {
    for (const model of [undefined, null, "", "custom-private-model"]) {
      const node = { id: "claude@rig", label: "Codex", role, model };
      expect(resolveVendorForNode(node)).toBeNull();
    }
  });

  it("uses existing neutral assets when model identity is unknown", () => {
    for (const state of ["master", "working", "waiting", "messaging", "milestone"] as const) {
      expect(getVendorAvatarUrl(null, state)).toBe(`/avatars/pomo/${state}.png`);
    }
  });

  it("maps activity states to transparent avatar state assets", () => {
    expect(resolveAvatarState("working", false)).toBe("working");
    expect(resolveAvatarState("waiting", false)).toBe("waiting");
    expect(resolveAvatarState("complete", false)).toBe("milestone");
    expect(resolveAvatarState("working", true)).toBe("messaging");
    expect(getVendorAvatarUrl("claude", "working")).toBe("/avatars/vendors/claude_working.webm");
  });

  it("does not draw a failed worker with the calm waiting avatar", () => {
    expect(resolveAvatarState("error", false)).not.toBe("waiting");
    expect(resolveAvatarState("error", false)).toBe("master");
  });

  it("keeps the neutral still for a seat whose model is unknown", () => {
    render(<I18nextProvider i18n={languages.get("en")!}>
      <FlowView events={[]} seats={[{ id: "lead", role: "lead", model: "custom-private-model" }]} />
    </I18nextProvider>);
    expect(document.querySelector("video.flow-node-avatar")).toBeNull();
    expect(document.querySelector("img.flow-node-avatar")?.getAttribute("src")).toBe("/avatars/pomo/master.png");
  });

  it("renders vendor avatar clips on FlowView nodes", () => {
    show();
    const leadBtn = screen.getByRole("button", { name: /Lead, lead/i });
    const clip = leadBtn.querySelector("video.flow-node-avatar") as HTMLVideoElement | null;
    expect(clip).toBeTruthy();
    expect(clip?.getAttribute("src")).toMatch(/^\/avatars\/vendors\/claude_(master|working|waiting|messaging|milestone)\.webm$/);
    expect(clip?.muted).toBe(true);
    expect(clip?.hasAttribute("loop")).toBe(true);
    expect(clip?.getAttribute("playsinline")).not.toBeNull();
    expect(clip?.autoplay).toBe(true);
  });

  it("holds vendor avatar clips on a still frame for reduced motion", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    render(<I18nextProvider i18n={languages.get("en")!}>
      <FlowView events={[]} seats={[{ id: "lead", role: "lead", model: "claude-sonnet-4" }]} />
    </I18nextProvider>);
    // The static list paints each seat while the pause flag is set, so the first frame renders.
    const clip = document.querySelector("video.flow-node-avatar") as HTMLVideoElement | null;
    expect(clip).toBeTruthy();
    expect(clip?.autoplay).toBe(false);
    expect(clip?.getAttribute("src")).toBe("/avatars/vendors/claude_master.webm");
  });
});
