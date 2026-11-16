import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "../../globals.css";

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createInterfaceI18n, type InterfaceLanguage } from "@multi-agent/i18n";
import type { i18n as I18n } from "i18next";
import { useThemePreference } from "../theme.js";
import "../team.css";
import { FlowView } from "./FlowView.js";
import type { FlowEvent, FlowSeat } from "./flow-events.js";

const PERMANENT_SEATS: readonly FlowSeat[] = [
  { id: "lead", label: "Lead · Claude", role: "lead" },
  { id: "gemini", label: "Reviewer · Gemini", role: "reviewer" },
  { id: "owner", label: "Owner · Kimi", role: "owner" },
];

const DISPATCHABLE_POOL: readonly FlowSeat[] = [
  { id: "chatgpt", label: "Implementer · ChatGPT", role: "implementer" },
  { id: "deepseek", label: "Architect · DeepSeek", role: "implementer" },
  { id: "qwen", label: "Builder · Qwen", role: "implementer" },
  { id: "grok", label: "Tester · Grok", role: "integration" },
];

function makeEvent(
  seq: number,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
  timestamp = Date.now(),
): FlowEvent {
  return {
    type: "team.control",
    protocolVersion: "1.0",
    eventId: `demo-${seq}-${Date.now()}`,
    runId: "run-demo",
    taskId: `task-${(seq % 5) + 1}`,
    attemptId: `attempt-${(seq % 5) + 1}`,
    entityId,
    entityVersion: seq,
    action,
    payload,
    timestamp,
    seq,
  };
}

function buildIdleTeamEvents(): FlowEvent[] {
  const now = Date.now();
  return [
    makeEvent(1, "chat.message", "lead", { source: "owner", target: "lead", body: "Standby" }, now - 3000),
  ];
}

function buildActiveSquadEvents(): FlowEvent[] {
  const now = Date.now();
  return [
    makeEvent(1, "task.created", "chatgpt", { leadSeat: "lead", workerSeat: "chatgpt" }, now - 1600),
    makeEvent(2, "worker.tool.started", "chatgpt", { workerSeat: "chatgpt", tool: "edit" }, now - 1400),
    makeEvent(3, "task.created", "deepseek", { leadSeat: "lead", workerSeat: "deepseek" }, now - 1200),
    makeEvent(4, "worker.tool.started", "deepseek", { workerSeat: "deepseek", tool: "read" }, now - 1000),
    makeEvent(5, "task.created", "qwen", { leadSeat: "lead", workerSeat: "qwen" }, now - 800),
    makeEvent(6, "worker.tool.started", "qwen", { workerSeat: "qwen", tool: "write" }, now - 600),
    makeEvent(7, "review.verdict", "gemini", { workerSeat: "chatgpt", reviewerSeat: "gemini", verdict: "accepted" }, now - 400),
  ];
}

export function FlowDemoApp() {
  const appearance = useThemePreference();
  const [language, setLanguage] = useState<InterfaceLanguage>("en");
  const [i18n, setI18n] = useState<I18n | null>(null);
  const [seats, setSeats] = useState<FlowSeat[]>(() => [...PERMANENT_SEATS, ...DISPATCHABLE_POOL.slice(0, 3)]);
  const [events, setEvents] = useState<FlowEvent[]>(() => buildActiveSquadEvents());
  const [seq, setSeq] = useState(100);
  const [dispatchedCount, setDispatchedCount] = useState(3);

  useEffect(() => {
    let active = true;
    createInterfaceI18n({ language }).then(res => {
      if (active) setI18n(res.instance);
    });
    return () => {
      active = false;
    };
  }, [language]);

  const dispatchAgentViaPortal = () => {
    const nextSeat =
      DISPATCHABLE_POOL.find(d => !seats.some(s => s.id === d.id)) ??
      DISPATCHABLE_POOL[dispatchedCount % DISPATCHABLE_POOL.length]!;
    const now = Date.now();
    setSeats(prev => (prev.some(s => s.id === nextSeat.id) ? prev : [...prev, nextSeat]));
    setEvents(prev => [
      ...prev,
      makeEvent(seq, "task.created", nextSeat.id, { leadSeat: "lead", workerSeat: nextSeat.id }, now),
      makeEvent(seq + 1, "worker.tool.started", nextSeat.id, { workerSeat: nextSeat.id, tool: "edit" }, now + 50),
    ]);
    setSeq(s => s + 2);
    setDispatchedCount(c => c + 1);
  };

  const completeOneAgent = () => {
    const completedIds = new Set(
      events
        .filter(e => e.action === "task.outcome")
        .map(e => String(e.payload.workerSeat ?? e.entityId)),
    );
    const activeWorker =
      seats.find(s => DISPATCHABLE_POOL.some(d => d.id === s.id) && !completedIds.has(s.id)) ??
      seats.find(s => DISPATCHABLE_POOL.some(d => d.id === s.id));
    if (!activeWorker) return;
    const now = Date.now();
    setEvents(prev => [
      ...prev,
      makeEvent(seq, "task.outcome", activeWorker.id, { workerSeat: activeWorker.id, leadSeat: "lead", status: "done" }, now),
    ]);
    setSeq(s => s + 1);
  };

  const sendLiveMessage = () => {
    const activeIds = seats.map(s => s.id);
    const from = activeIds[seq % activeIds.length] ?? "lead";
    const to = activeIds[(seq + 1) % activeIds.length] ?? "gemini";
    const now = Date.now();
    setSeq(s => s + 1);
    setEvents(prev => [...prev, makeEvent(seq, "task.created", to, { leadSeat: from, workerSeat: to }, now)]);
  };

  const enterIdleRoam = () => {
    setSeats([...PERMANENT_SEATS]);
    setEvents(buildIdleTeamEvents());
  };

  const resetActiveSquad = () => {
    setSeats([...PERMANENT_SEATS, ...DISPATCHABLE_POOL.slice(0, 3)]);
    setEvents(buildActiveSquadEvents());
    setDispatchedCount(3);
  };

  if (!i18n) return null;

  return (
    <I18nextProvider i18n={i18n}>
      <div className="team-shell" data-ui-theme={appearance.theme} style={{ display: "block", overflow: "auto" }}>
      <main style={{ maxWidth: 1080, margin: "24px auto", padding: "0 20px", display: "grid", gap: 16 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
            border: "1px solid var(--ui-divider)",
            borderRadius: "var(--ui-radius)",
            background: "var(--ui-surface)",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button className="btn btn-primary" type="button" onClick={dispatchAgentViaPortal}>
              Dispatch a team member
            </button>
            <button className="btn btn-outline" type="button" onClick={sendLiveMessage}>
              Send a message
            </button>
            <button className="btn btn-outline" type="button" onClick={completeOneAgent}>
              Complete a task
            </button>
            <button className="btn btn-outline" type="button" onClick={enterIdleRoam}>
              Show idle team
            </button>
            <button className="btn btn-outline" type="button" onClick={resetActiveSquad}>
              Reset active team
            </button>
          </div>
          <button className="btn btn-outline" type="button" onClick={() => appearance.setPreference(appearance.theme === "dark" ? "light" : "dark")}>
            {appearance.theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => setLanguage(lang => (lang === "zh-CN" ? "en" : "zh-CN"))}
          >
            {language === "zh-CN" ? "Switch to English" : "Switch to Chinese"}
          </button>
        </div>
        <FlowView events={events} seats={seats} title="Loom Flow character demo" />
      </main>
      </div>
    </I18nextProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <FlowDemoApp />
    </StrictMode>,
  );
}
