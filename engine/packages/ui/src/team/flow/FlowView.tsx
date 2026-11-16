import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { MessageKey } from "@multi-agent/i18n";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { mapTeamEvents, type FlowEvent, type FlowIntent, type FlowNode, type FlowNodeState, type FlowSeat } from "./flow-events.js";
import { FlowRenderer, layoutFlowNodes, visibleFlowNodes, type NodeVisualState } from "./flow-renderer.js";
import { getVendorAvatarUrl, resolveAvatarState, resolveVendorForNode } from "./vendor-avatars.js";
import "./flow.css";

export interface FlowViewProps {
  events: readonly FlowEvent[];
  seats?: readonly FlowSeat[];
  nodeStates?: ReadonlyMap<string, FlowNodeState>;
  title?: string;
  className?: string;
  maxParticles?: number;
}

/** The intent kinds whose provider label is data (a tool name, a verdict), shown after the kind. */
const DETAILED_KINDS = new Set(["activity", "review"]);

function fallbackNodeStyle(pos: { x: number; y: number } | undefined, width: number, height: number): CSSProperties {
  if (!pos || width <= 0 || height <= 0) {
    return { left: "50%", top: "50%" };
  }
  return {
    left: `${(pos.x / width) * 100}%`,
    top: `${(pos.y / height) * 100}%`,
  };
}

function setSelectedFromKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>, select: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    select();
  }
}

export function FlowView({ events, seats, nodeStates, title, className, maxParticles }: FlowViewProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<FlowRenderer | null>(null);
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const avatarRefs = useRef<Map<string, HTMLSpanElement>>(new Map());

  const [canvasAvailable, setCanvasAvailable] = useState<boolean | null>(null);
  const [manualPaused, setManualPaused] = useState(false);
  const [windowPaused, setWindowPaused] = useState(() => typeof document !== "undefined" && document.hidden);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState({ width: 640, height: 500 });
  const [visualMeta, setVisualMeta] = useState<Map<string, Pick<NodeVisualState, "isMessaging" | "isReceiving" | "isWalking" | "phase">>>(() => new Map());

  const mapping = useMemo(() => mapTeamEvents(events, { seats, nodeStates, maxParticles }), [events, maxParticles, seats, nodeStates]);
  const paused = manualPaused || windowPaused || reducedMotion;

  const showStaticList = reducedMotion || canvasAvailable === false;
  const visibleNodes = useMemo(
    () => showStaticList ? mapping.nodes : visibleFlowNodes(mapping),
    [mapping, showStaticList],
  );

  const fallbackPositions = useMemo(
    () => layoutFlowNodes(visibleNodes, stageSize.width, stageSize.height),
    [visibleNodes, stageSize.width, stageSize.height],
  );

  useEffect(() => {
    if (selectedNode && !mapping.nodes.some(node => node.id === selectedNode)) setSelectedNode(null);
  }, [mapping.nodes, selectedNode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    setCanvasAvailable(Boolean(context));
    if (!context) return;
    const renderer = rendererRef.current ?? new FlowRenderer({ canvas, maxParticles });
    rendererRef.current = renderer;
    renderer.setModel(mapping);

    const resize = () => {
      const stage = stageRef.current;
      const width = stage?.clientWidth || 640;
      const height = stage?.clientHeight || 500;
      setStageSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
      const ratio = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (typeof context.setTransform === "function") context.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderer.resize(width, height);
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (observer && stageRef.current) observer.observe(stageRef.current);
    return () => observer?.disconnect();
  }, [mapping, maxParticles]);

  useEffect(() => {
    const onBlur = () => setWindowPaused(true);
    const onFocus = () => setWindowPaused(false);
    const onVisibility = () => setWindowPaused(document.hidden);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !canvasAvailable || paused) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let active = true;
    let lastReactSync = 0;

    const applyDomTransforms = (states: Map<string, NodeVisualState>) => {
      for (const [id, vs] of states) {
        const btn = nodeRefs.current.get(id);
        if (btn) {
          btn.style.left = `${vs.x}px`;
          btn.style.top = `${vs.y}px`;
          btn.style.opacity = String(vs.opacity);
          btn.style.visibility = vs.phase === "gone" ? "hidden" : "visible";
          btn.style.pointerEvents = vs.phase === "gone" ? "none" : "auto";
        }
        const avatarWrap = avatarRefs.current.get(id);
        if (avatarWrap) {
          avatarWrap.style.transform = `translate3d(0, ${vs.bounceY.toFixed(2)}px, 0) scale(${(vs.scale * vs.facing).toFixed(3)}, ${vs.scale.toFixed(3)}) rotate(${(vs.tiltDeg * vs.facing).toFixed(2)}deg)`;
        }
      }
    };

    const syncMeta = (states: Map<string, NodeVisualState>) => {
      setVisualMeta(prev => {
        let changed = prev.size !== states.size;
        if (!changed) {
          for (const [id, vs] of states) {
            const old = prev.get(id);
            if (
              !old ||
              old.isMessaging !== vs.isMessaging ||
              old.isReceiving !== vs.isReceiving ||
              old.isWalking !== vs.isWalking ||
              old.phase !== vs.phase
            ) {
              changed = true;
              break;
            }
          }
        }
        if (!changed) return prev;
        const next = new Map<string, Pick<NodeVisualState, "isMessaging" | "isReceiving" | "isWalking" | "phase">>();
        for (const [id, vs] of states) {
          next.set(id, {
            isMessaging: vs.isMessaging,
            isReceiving: vs.isReceiving,
            isWalking: vs.isWalking,
            phase: vs.phase,
          });
        }
        return next;
      });
    };

    const initialStates = renderer.getNodeVisualStates(performance.now());
    applyDomTransforms(initialStates);
    syncMeta(initialStates);

    const draw = (timestamp: number) => {
      if (!active) return;
      renderer.draw(context, timestamp);
      const states = renderer.getNodeVisualStates(timestamp);
      applyDomTransforms(states);

      if (timestamp - lastReactSync >= 140) {
        lastReactSync = timestamp;
        syncMeta(states);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [canvasAvailable, paused, mapping]);

  const selected = selectedNode ? mapping.nodes.find(node => node.id === selectedNode) : null;
  const stateText = (state: FlowNode["state"]) => t(`flow.state.${state}` as MessageKey);
  const roleText = (role: FlowNode["role"]) => t(`flow.role.${role}` as MessageKey);
  const nameOf = (node: FlowNode) => (node.role === "lead" && node.label === "Lead" ? roleText("lead") : node.label);
  const nodeName = (id: string) => {
    const node = mapping.nodes.find(value => value.id === id);
    return node ? nameOf(node) : id;
  };
  const intentText = (intent: FlowIntent) => {
    const kind = intent.kind === "delivery" && intent.action.endsWith("denied") ? "delivery-denied" : intent.kind;
    const base = t(`flow.intent.${kind}` as MessageKey);
    const detail = DETAILED_KINDS.has(intent.kind) && intent.count <= 1 ? intent.label : null;
    const route = intent.targetId ? `${nodeName(intent.sourceId)} → ${nodeName(intent.targetId)}` : nodeName(intent.sourceId);
    return [base, detail, route].filter(Boolean).join(" · ");
  };

  return (
    <section
      className={["flow-view", className].filter(Boolean).join(" ")}
      data-render-mode={showStaticList ? "static" : "canvas"}
      data-paused={paused ? "true" : "false"}
    >
      <div className="flow-heading">
        <h2>{title ?? t("flow.title")}</h2>
        <button
          className="flow-pause btn btn-outline"
          type="button"
          onClick={() => setManualPaused(value => !value)}
          aria-pressed={manualPaused}
        >
          {manualPaused ? t("flow.resume") : t("flow.pause")}
        </button>
      </div>
      <div className="flow-stage" ref={stageRef} data-testid="flow-stage">
        <canvas ref={canvasRef} className="flow-canvas" aria-hidden="true" />
        <div className="flow-node-layer" role="list" aria-label={t("flow.seats")}>
          {visibleNodes.map(node => {
            const isSelected = selectedNode === node.id;
            const meta = visualMeta.get(node.id);
            const vendor = resolveVendorForNode(node);
            const isMessaging = Boolean(meta?.isMessaging);
            const isReceiving = Boolean(meta?.isReceiving);
            const isWalking = Boolean(meta?.isWalking);
            const avatarState = resolveAvatarState(node.state, isMessaging);
            const avatarUrl = getVendorAvatarUrl(vendor, avatarState);
            const nodeLabel = t("flow.nodeLabel", { name: nameOf(node), role: roleText(node.role), state: stateText(node.state) });
            return (
              <button
                key={node.id}
                ref={el => {
                  if (el) nodeRefs.current.set(node.id, el);
                  else nodeRefs.current.delete(node.id);
                }}
                className="flow-node-label"
                style={fallbackNodeStyle(fallbackPositions.get(node.id), stageSize.width, stageSize.height)}
                type="button"
                aria-label={nodeLabel}
                aria-pressed={isSelected}
                data-selected={isSelected ? "true" : "false"}
                data-state={node.state}
                data-avatar-state={avatarState}
                data-vendor={vendor}
                data-walking={isWalking ? "true" : "false"}
                data-receiving={isReceiving ? "true" : "false"}
                data-phase={meta?.phase ?? "active"}
                onClick={() => setSelectedNode(node.id)}
                onKeyDown={event => setSelectedFromKeyboard(event, () => setSelectedNode(node.id))}
              >
                <span
                  className="flow-node-avatar-wrap"
                  aria-hidden="true"
                  ref={el => {
                    if (el) avatarRefs.current.set(node.id, el);
                    else avatarRefs.current.delete(node.id);
                  }}
                >
                  <img
                    className="flow-node-avatar"
                    src={avatarUrl}
                    alt=""
                    draggable={false}
                    loading="eager"
                  />
                </span>
                <span className="flow-node-pill">
                  <span className="flow-node-dot" aria-hidden="true" />
                  <span className="flow-node-meta">
                    <span className="flow-node-name">{nameOf(node)}</span>
                    <span className="flow-node-state">{stateText(node.state)}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {showStaticList && (
          <div className="flow-static-note" role="status">
            {reducedMotion ? t("flow.reducedMotion") : t("flow.canvasUnavailable")}
          </div>
        )}
      </div>
      {selected && (
        <p className="flow-selection" role="status" aria-label={t("flow.selectedName", { name: nameOf(selected) })}>
          {t("flow.selected", { name: nameOf(selected), state: stateText(selected.state) })}
        </p>
      )}
      <div className="flow-events" aria-label={t("flow.eventList")}>
        <h3>{t("flow.events")}</h3>
        {mapping.intents.length ? (
          <ol>
            {mapping.intents.map(intent => (
              <li key={intent.id} data-kind={intent.kind}>
                <span>{intentText(intent)}</span>
                {intent.count > 1 && <span className="flow-event-count">×{intent.count}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="flow-empty">{t("flow.empty")}</p>
        )}
      </div>
    </section>
  );
}

export default FlowView;
