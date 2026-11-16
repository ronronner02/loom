/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { FlowIntent, FlowMapping, FlowNode, FlowNodeState } from "./flow-events.js";

export const FLOW_BEAM_TIMINGS = {
  packMs: 360,
  travelMs: 720,
  unpackMs: 620,
  rippleMs: 1_000,
  localPulseMs: 700,
  portalMs: 750,
} as const;

export type FlowColorToken =
  | "--ui-accent"
  | "--ui-accent-press"
  | "--ui-ok"
  | "--ui-warn"
  | "--ui-error"
  | "--ui-text"
  | "--ui-muted"
  | "--ui-divider";

export interface FlowRendererColors {
  accent: string;
  accentPress: string;
  ok: string;
  warn: string;
  error: string;
  text: string;
  muted: string;
  divider: string;
}

export interface FlowRendererOptions {
  canvas?: HTMLCanvasElement | null;
  maxParticles?: number;
  colors?: Partial<FlowRendererColors>;
}

export interface FlowPoint {
  x: number;
  y: number;
}

export type NodePresencePhase = "spawning" | "active" | "despawning" | "gone";

export interface NodeVisualState {
  id: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  facing: 1 | -1;
  bounceY: number;
  tiltDeg: number;
  phase: NodePresencePhase;
  isMessaging: boolean;
  isReceiving: boolean;
  isWalking: boolean;
}

interface InternalPresence {
  id: string;
  node: FlowNode;
  home: FlowPoint;
  pos: FlowPoint;
  wanderStart: FlowPoint;
  wanderTarget: FlowPoint;
  wanderStartedAt: number;
  wanderDurationMs: number;
  nextWanderAt: number;
  facing: 1 | -1;
  phase: NodePresencePhase;
  phaseStartedAt: number;
  lastState: FlowNodeState;
  seed: number;
}

const TOKEN_NAMES: Record<keyof FlowRendererColors, FlowColorToken> = {
  accent: "--ui-accent",
  accentPress: "--ui-accent-press",
  ok: "--ui-ok",
  warn: "--ui-warn",
  error: "--ui-error",
  text: "--ui-text",
  muted: "--ui-muted",
  divider: "--ui-divider",
};

/** Pattern-only density formula inspired by openspawn PR 155; no openspawn code is copied. */
export function edgeWidthForCount(count: number): number {
  return Math.min(1.25 + Math.log(Math.max(0, count) + 1) * 0.8, 5.5);
}

/** Pattern-only particle tiers inspired by openspawn PR 155. */
export function particleTierForCount(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count < 5) return 1;
  if (count < 20) return 2;
  return 3;
}

/** Pattern-only heat thresholds inspired by openspawn PR 155. */
export function heatLevelForActivity(count: number): "idle" | "cool" | "warm" | "hot" {
  if (count >= 24) return "hot";
  if (count >= 8) return "warm";
  if (count > 0) return "cool";
  return "idle";
}

function hashStr(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededUnit(seed: number, step: number): number {
  const x = Math.sin(seed * 0.0013 + step * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Aesthetic stage layout:
 * - Lead sits at the upper-center focal anchor.
 * - Up to 6 companions arrange in a balanced semi-ellipse / arc below and around the lead.
 * - Larger teams split into inner and outer staggered arcs so avatars never overlap.
 */
export function layoutFlowNodes(nodes: readonly FlowNode[], width: number, height: number): Map<string, FlowPoint> {
  const points = new Map<string, FlowPoint>();
  if (!nodes.length) return points;

  const padX = Math.min(96, width * 0.14);
  const padTop = Math.min(92, height * 0.18);
  const padBottom = Math.min(98, height * 0.2);
  const usableW = Math.max(160, width - padX * 2);
  const usableH = Math.max(160, height - padTop - padBottom);
  const cx = width / 2;

  if (nodes.length === 1) {
    points.set(nodes[0]!.id, { x: cx, y: height * 0.46 });
    return points;
  }

  const leadIndex = Math.max(0, nodes.findIndex(node => node.role === "lead" || node.id === "lead"));
  const lead = nodes[leadIndex]!;
  const others = nodes.filter((_, index) => index !== leadIndex);

  if (others.length <= 2) {
    points.set(lead.id, { x: cx, y: padTop + usableH * 0.22 });
    others.forEach((node, i) => {
      const spread = others.length === 1 ? 0 : (i === 0 ? -0.3 : 0.3);
      points.set(node.id, {
        x: cx + spread * usableW,
        y: padTop + usableH * 0.72,
      });
    });
    return points;
  }

  // Lead at top-center command focal point
  points.set(lead.id, { x: cx, y: padTop + usableH * 0.14 });

  if (others.length <= 6) {
    // Graceful wide U-arc around the lead
    const rx = usableW * 0.48;
    const ry = usableH * 0.56;
    const arcCenterY = padTop + usableH * 0.34;
    others.forEach((node, idx) => {
      const t = others.length === 1 ? 0.5 : idx / (others.length - 1);
      // Sweep from ~165 deg (left) through 90 deg (bottom) to ~15 deg (right)
      const angle = Math.PI * 0.92 - t * Math.PI * 0.84;
      const depthBoost = Math.sin(t * Math.PI) * 0.12;
      points.set(node.id, {
        x: cx + Math.cos(angle) * rx,
        y: arcCenterY + Math.sin(angle) * ry * (0.92 + depthBoost),
      });
    });
    return points;
  }

  // Dual staggered arcs for 7+ companions
  const innerCount = Math.ceil(others.length * 0.45);
  const inner = others.slice(0, innerCount);
  const outer = others.slice(innerCount);
  const arcCenterY = padTop + usableH * 0.3;

  inner.forEach((node, idx) => {
    const t = inner.length === 1 ? 0.5 : idx / (inner.length - 1);
    const angle = Math.PI * 0.86 - t * Math.PI * 0.72;
    points.set(node.id, {
      x: cx + Math.cos(angle) * (usableW * 0.3),
      y: arcCenterY + Math.sin(angle) * (usableH * 0.34),
    });
  });

  outer.forEach((node, idx) => {
    const t = outer.length === 1 ? 0.5 : idx / (outer.length - 1);
    const angle = Math.PI * 0.95 - t * Math.PI * 0.9;
    points.set(node.id, {
      x: cx + Math.cos(angle) * (usableW * 0.5),
      y: arcCenterY + Math.sin(angle) * (usableH * 0.64),
    });
  });

  return points;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOut(value: number): number {
  return 1 - Math.pow(1 - clamp01(value), 3);
}

function easeInOut(value: number): number {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function drawRoundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function readToken(canvas: HTMLCanvasElement | null | undefined, token: FlowColorToken): string {
  const doc = canvas?.ownerDocument;
  const view = doc?.defaultView;
  if (view && canvas) {
    const own = view.getComputedStyle(canvas);
    const value = own.getPropertyValue(token).trim();
    if (value) return value;
    const root = view.getComputedStyle(doc.documentElement);
    const rootValue = root.getPropertyValue(token).trim();
    if (rootValue) return rootValue;
  }
  return `var(${token})`;
}

function resolveColor(value: string, fallback: string): string {
  if (!value || value.startsWith("var(")) return fallback;
  return value;
}

function nodeColor(node: FlowNode, colors: FlowRendererColors): string {
  switch (node.state) {
    case "error": return resolveColor(colors.error, "#b12d2a");
    case "waiting":
    case "ambiguous":
    case "no-response": return resolveColor(colors.warn, "#d97706");
    case "complete": return resolveColor(colors.ok, "#21955a");
    case "started":
    case "acknowledged":
    case "working": return resolveColor(colors.accentPress, "#0064d4");
    default: return node.role === "lead" ? resolveColor(colors.accent, "#0064d4") : resolveColor(colors.muted, "#6b7280");
  }
}

function eventAge(intent: FlowIntent, now: number): number {
  const eventIsEpoch = intent.createdAt > 100_000_000_000;
  const frameIsEpoch = now > 100_000_000_000;
  if (eventIsEpoch !== frameIsEpoch) {
    return eventIsEpoch ? Math.max(0, Date.now() - intent.createdAt) : Math.max(0, performance.now() - intent.createdAt);
  }
  return Math.max(0, now - intent.createdAt);
}

function nowClock(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function quadPoint(p0: FlowPoint, cp: FlowPoint, p1: FlowPoint, t: number): FlowPoint {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y,
  };
}

function quadTangent(p0: FlowPoint, cp: FlowPoint, p1: FlowPoint, t: number): FlowPoint {
  return {
    x: 2 * (1 - t) * (cp.x - p0.x) + 2 * t * (p1.x - cp.x),
    y: 2 * (1 - t) * (cp.y - p0.y) + 2 * t * (p1.y - cp.y),
  };
}

function controlPointForLane(source: FlowPoint, target: FlowPoint, center: FlowPoint): FlowPoint {
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const towardCenter = (center.x - midX) * nx + (center.y - midY) * ny;
  const sign = towardCenter >= 0 ? -1 : 1;
  // Arc gracefully upward/outward for a paper-airplane throw feel
  const offset = Math.min(64, Math.max(24, len * 0.22)) * sign;
  return { x: midX + nx * offset, y: midY + ny * offset - 14 };
}

function isPermanentRole(node: FlowNode): boolean {
  return node.role === "lead" || node.role === "reviewer" || node.role === "owner";
}

function isWorkingState(state: FlowNodeState): boolean {
  return state === "working" || state === "started" || state === "acknowledged";
}

function isIdleWanderingState(state: FlowNodeState): boolean {
  return state === "idle" || state === "waiting";
}

export function visibleFlowNodes(model: Pick<FlowMapping, "nodes" | "intents">): FlowNode[] {
  const participants = new Set(model.intents.flatMap(intent => [intent.sourceId, intent.targetId]));
  const active = model.nodes.filter(node => isPermanentRole(node) || node.state !== "idle" || participants.has(node.id));
  return active.length ? active : model.nodes;
}

export class FlowRenderer {
  private nodes: FlowNode[] = [];
  private intents: FlowIntent[] = [];
  private positions = new Map<string, FlowPoint>();
  private presences = new Map<string, InternalPresence>();
  private width = 640;
  private height = 500;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly maxParticles: number;
  private readonly colors: FlowRendererColors;

  constructor(options: FlowRendererOptions = {}) {
    this.canvas = options.canvas ?? null;
    this.maxParticles = options.maxParticles ?? 96;
    this.colors = {
      ...Object.fromEntries(Object.entries(TOKEN_NAMES).map(([key, token]) => [key, readToken(this.canvas, token)])),
      ...options.colors,
    } as FlowRendererColors;
  }

  setModel(model: Pick<FlowMapping, "nodes" | "intents">, now = nowClock()): void {
    this.nodes = model.nodes.slice();
    this.intents = model.intents.slice(-this.maxParticles);
    this.recomputeLayout(now);
  }

  setNodes(nodes: readonly FlowNode[], now = nowClock()): void {
    this.nodes = nodes.slice();
    this.recomputeLayout(now);
  }

  setIntents(intents: readonly FlowIntent[]): void {
    this.intents = intents.slice(-this.maxParticles);
  }

  resize(width: number, height: number, now = nowClock()): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.recomputeLayout(now);
  }

  getNodePositions(): ReadonlyMap<string, FlowPoint> {
    const out = new Map<string, FlowPoint>();
    for (const [id, p] of this.presences) {
      out.set(id, { x: p.pos.x, y: p.pos.y });
    }
    return out.size ? out : this.positions;
  }

  private recomputeLayout(now: number): void {
    const layoutInput = visibleFlowNodes({ nodes: this.nodes, intents: this.intents });
    this.positions = layoutFlowNodes(layoutInput, this.width, this.height);

    const seenIds = new Set<string>();
    for (const node of layoutInput) {
      seenIds.add(node.id);
      const home = this.positions.get(node.id) ?? { x: this.width / 2, y: this.height / 2 };
      const existing = this.presences.get(node.id);
      const seed = hashStr(node.id);

      if (!existing) {
        const shouldPortalIn = !isPermanentRole(node);
        this.presences.set(node.id, {
          id: node.id,
          node,
          home,
          pos: { ...home },
          wanderStart: { ...home },
          wanderTarget: { ...home },
          wanderStartedAt: now,
          wanderDurationMs: 1_800,
          nextWanderAt: now + 700 + seededUnit(seed, 1) * 1_800,
          facing: seededUnit(seed, 2) > 0.5 ? 1 : -1,
          phase: shouldPortalIn ? "spawning" : "active",
          phaseStartedAt: now,
          lastState: node.state,
          seed,
        });
      } else {
        const wasGone = existing.phase === "gone" || existing.phase === "despawning";
        const becomingActive = !isPermanentRole(node) && isWorkingState(node.state) && wasGone;
        const becomingComplete = !isPermanentRole(node) && node.state === "complete" && existing.lastState !== "complete";

        existing.node = node;
        existing.home = home;
        if (becomingActive || (existing.phase === "gone" && node.state !== "complete" && node.state !== "idle")) {
          existing.phase = "spawning";
          existing.phaseStartedAt = now;
          existing.pos = { ...home };
        } else if (becomingComplete) {
          existing.phase = "active";
          existing.phaseStartedAt = now;
        } else if (existing.phase === "despawning" && node.state !== "complete") {
          existing.phase = "spawning";
          existing.phaseStartedAt = now;
        }
        existing.lastState = node.state;
      }
    }

    // Dispatched agents removed from active set portal out gracefully
    for (const [id, presence] of this.presences) {
      if (!seenIds.has(id)) {
        if (presence.phase !== "despawning" && presence.phase !== "gone") {
          presence.phase = "despawning";
          presence.phaseStartedAt = now;
        }
      }
    }
  }

  private stepPresences(now: number): void {
    const portalMs = FLOW_BEAM_TIMINGS.portalMs;
    let stepIdx = Math.floor(now / 1000);

    for (const p of this.presences.values()) {
      // Transition spawn -> active
      if (p.phase === "spawning" && now - p.phaseStartedAt >= portalMs) {
        p.phase = "active";
        p.phaseStartedAt = now;
      }

      // Dispatched temporary agents portal out after completing their milestone celebration (~2.2s)
      if (!isPermanentRole(p.node) && p.node.state === "complete" && p.phase === "active" && now - p.phaseStartedAt >= 2_200) {
        p.phase = "despawning";
        p.phaseStartedAt = now;
      }

      if (p.phase === "despawning" && now - p.phaseStartedAt >= portalMs) {
        p.phase = "gone";
      }

      if (p.phase === "gone") continue;

      // Wandering logic for permanent/idle agents; working/messaging agents return smoothly to their desk anchor
      const canWander = isPermanentRole(p.node) && isIdleWanderingState(p.node.state) && p.phase === "active";
      if (canWander) {
        if (now >= p.nextWanderAt) {
          stepIdx += 1;
          const angle = seededUnit(p.seed, stepIdx * 3 + 1) * Math.PI * 2;
          const dist = 16 + seededUnit(p.seed, stepIdx * 3 + 2) * 34;
          const tx = Math.max(58, Math.min(this.width - 58, p.home.x + Math.cos(angle) * dist));
          const ty = Math.max(66, Math.min(this.height - 66, p.home.y + Math.sin(angle) * dist * 0.65));
          p.wanderStart = { ...p.pos };
          p.wanderTarget = { x: tx, y: ty };
          p.wanderStartedAt = now;
          p.wanderDurationMs = 1_400 + seededUnit(p.seed, stepIdx * 3 + 3) * 900;
          p.nextWanderAt = now + p.wanderDurationMs + 1_600 + seededUnit(p.seed, stepIdx * 5) * 2_400;
          if (Math.abs(tx - p.pos.x) > 2) {
            p.facing = tx >= p.pos.x ? 1 : -1;
          }
        }
        const wt = clamp01((now - p.wanderStartedAt) / Math.max(1, p.wanderDurationMs));
        const eased = easeInOut(wt);
        p.pos = {
          x: p.wanderStart.x + (p.wanderTarget.x - p.wanderStart.x) * eased,
          y: p.wanderStart.y + (p.wanderTarget.y - p.wanderStart.y) * eased,
        };
      } else {
        // Smoothly glide back to home workstation anchor when working/messaging
        p.pos = {
          x: p.pos.x + (p.home.x - p.pos.x) * 0.14,
          y: p.pos.y + (p.home.y - p.pos.y) * 0.14,
        };
        if (Math.abs(p.home.x - p.pos.x) > 1.5) {
          p.facing = p.home.x >= p.pos.x ? 1 : -1;
        }
      }
    }
  }

  private getActiveBeamWindows(now: number): Array<{
    intent: FlowIntent;
    elapsed: number;
    phase: "pack" | "fly" | "unpack";
    phaseT: number;
  }> {
    const { packMs, travelMs, unpackMs } = FLOW_BEAM_TIMINGS;
    const total = packMs + travelMs + unpackMs;
    const results: Array<{
      intent: FlowIntent;
      elapsed: number;
      phase: "pack" | "fly" | "unpack";
      phaseT: number;
    }> = [];

    for (const intent of this.intents) {
      if (intent.kind === "static" || intent.kind === "activity" || intent.kind === "lead-message" || !intent.targetId) {
        continue;
      }
      const src = this.presences.get(intent.sourceId);
      const dst = this.presences.get(intent.targetId);
      if (
        !src ||
        src.phase === "gone" ||
        src.phase === "despawning" ||
        !dst ||
        dst.phase === "gone" ||
        dst.phase === "despawning"
      ) {
        continue;
      }
      // Once a dispatched worker is complete, stop sending new assignment/review beams to it
      if (!isPermanentRole(dst.node) && dst.node.state === "complete" && intent.kind !== "delivery") {
        continue;
      }
      const age = eventAge(intent, now);
      if (age < total) {
        const phase = age < packMs ? "pack" : age < packMs + travelMs ? "fly" : "unpack";
        const phaseT =
          phase === "pack"
            ? age / packMs
            : phase === "fly"
              ? (age - packMs) / travelMs
              : (age - packMs - travelMs) / unpackMs;
        results.push({ intent, elapsed: age, phase, phaseT: clamp01(phaseT) });
      }
    }

    return results;
  }

  /** Returns node IDs currently launching a paper-airplane message. */
  getActiveMessagingNodes(now = Date.now()): Set<string> {
    const active = new Set<string>();
    for (const beam of this.getActiveBeamWindows(now)) {
      if (beam.phase === "pack" || (beam.phase === "fly" && beam.phaseT < 0.45)) {
        active.add(beam.intent.sourceId);
      }
    }
    return active;
  }

  /** Returns 60fps per-node transform & state for DOM avatar layering. */
  getNodeVisualStates(now = performance.now()): Map<string, NodeVisualState> {
    const out = new Map<string, NodeVisualState>();
    const beams = this.getActiveBeamWindows(now);
    const messagingSet = new Set<string>();
    const receivingSet = new Set<string>();

    for (const beam of beams) {
      if (beam.phase === "pack" || (beam.phase === "fly" && beam.phaseT < 0.45)) {
        messagingSet.add(beam.intent.sourceId);
      }
      if (beam.phase === "unpack" && beam.intent.targetId) {
        receivingSet.add(beam.intent.targetId);
      }
    }

    const portalMs = FLOW_BEAM_TIMINGS.portalMs;
    for (const p of this.presences.values()) {
      let scale = 1;
      let opacity = 1;
      if (p.phase === "spawning") {
        const elapsed = Math.max(0, now - p.phaseStartedAt);
        const t = easeOut(elapsed / portalMs);
        scale = 0.25 + 0.75 * t;
        opacity = Math.max(0.15, t);
      } else if (p.phase === "despawning") {
        const elapsed = Math.max(0, now - p.phaseStartedAt);
        const t = easeOut(elapsed / portalMs);
        scale = Math.max(0.1, 1 - 0.85 * t);
        opacity = Math.max(0, 1 - t);
      } else if (p.phase === "gone") {
        scale = 0;
        opacity = 0;
      }

      const isWalking =
        isPermanentRole(p.node) &&
        isIdleWanderingState(p.node.state) &&
        p.phase === "active" &&
        now - p.wanderStartedAt < p.wanderDurationMs;

      const isWorking = isWorkingState(p.node.state) && !messagingSet.has(p.id);
      let bounceY = 0;
      let tiltDeg = 0;

      if (isWalking) {
        // Bouncy footsteps while wandering
        bounceY = -Math.abs(Math.sin(now / 130)) * 5;
        tiltDeg = Math.sin(now / 130) * 3.2;
      } else if (receivingSet.has(p.id)) {
        bounceY = -Math.abs(Math.sin(now / 110)) * 7;
        tiltDeg = Math.sin(now / 110) * 3;
      } else if (isWorking) {
        // Subtle rhythmic typing nod
        bounceY = Math.sin(now / 75) * 1.5;
        tiltDeg = Math.sin(now / 150) * 1.4;
      } else if (p.node.state === "complete") {
        bounceY = -Math.abs(Math.sin(now / 220)) * 9;
      }

      out.set(p.id, {
        id: p.id,
        x: p.pos.x,
        y: p.pos.y,
        scale,
        opacity,
        facing: p.facing,
        bounceY,
        tiltDeg,
        phase: p.phase,
        isMessaging: messagingSet.has(p.id),
        isReceiving: receivingSet.has(p.id),
        isWalking,
      });
    }
    return out;
  }

  draw(ctx: CanvasRenderingContext2D, now = Date.now()): void {
    ctx.clearRect(0, 0, this.width, this.height);
    this.stepPresences(now);

    // 1. Portals underneath spawning / despawning nodes
    for (const p of this.presences.values()) {
      if (p.phase === "spawning" || p.phase === "despawning") {
        const t = clamp01((now - p.phaseStartedAt) / FLOW_BEAM_TIMINGS.portalMs);
        this.drawPortal(ctx, p.pos, now, p.phase === "spawning" ? t : 1 - t, nodeColor(p.node, this.colors));
      }
    }

    // 2. Soft floor shadows + walking/working procedural rig layers
    const beams = this.getActiveBeamWindows(now);
    const messagingIds = new Set(
      beams.filter(b => b.phase === "pack" || (b.phase === "fly" && b.phaseT < 0.45)).map(b => b.intent.sourceId),
    );

    for (const p of this.presences.values()) {
      if (p.phase === "gone") continue;
      const color = nodeColor(p.node, this.colors);
      this.drawFloorShadow(ctx, p, now);

      if (isWorkingState(p.node.state) && !messagingIds.has(p.id) && p.phase === "active") {
        this.drawTypingRig(ctx, p, now, color);
      }
    }

    // 3. Local pulses & lead ripples (transient only, no static black lines)
    for (const intent of this.intents) {
      const presence = this.presences.get(intent.sourceId);
      const source = presence?.pos ?? this.positions.get(intent.sourceId);
      if (!source) continue;
      if (intent.kind === "activity") {
        this.drawLocalPulse(ctx, source, eventAge(intent, now), intent.count);
      } else if (intent.kind === "lead-message") {
        this.drawRipple(ctx, source, eventAge(intent, now));
      }
    }

    // 4. Full messaging choreography: Pack Envelope -> Fading Dashed Trail + Paper Plane -> Open Envelope
    for (const beam of beams) {
      const sourceP = this.presences.get(beam.intent.sourceId);
      const targetP = beam.intent.targetId ? this.presences.get(beam.intent.targetId) : null;
      if (!sourceP || sourceP.phase === "gone" || !targetP || targetP.phase === "gone") continue;
      const source = sourceP.pos;
      const target = targetP.pos;

      const color =
        beam.intent.kind === "review"
          ? resolveColor(this.colors.warn, "#d97706")
          : beam.intent.kind === "integration"
            ? resolveColor(this.colors.ok, "#21955a")
            : resolveColor(this.colors.accent, "#0064d4");

      if (beam.phase === "pack") {
        this.drawPackEnvelope(ctx, source, target, beam.phaseT, color);
      } else if (beam.phase === "fly") {
        this.drawFlyingPaperPlane(ctx, source, target, beam.phaseT, color);
      } else {
        this.drawUnpackEnvelope(ctx, target, beam.phaseT, color);
      }
    }
  }

  private drawFloorShadow(ctx: CanvasRenderingContext2D, p: InternalPresence, now: number): void {
    const isWalking =
      isPermanentRole(p.node) &&
      isIdleWanderingState(p.node.state) &&
      p.phase === "active" &&
      now - p.wanderStartedAt < p.wanderDurationMs;

    ctx.save();
    ctx.globalAlpha = p.phase === "despawning" ? 0.08 : 0.16;
    ctx.fillStyle = "#111827";
    if (typeof ctx.ellipse === "function") {
      ctx.beginPath();
      ctx.ellipse(p.pos.x, p.pos.y + 34, isWalking ? 22 : 26, 6.5, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y + 34, isWalking ? 14 : 16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPortal(ctx: CanvasRenderingContext2D, pos: FlowPoint, now: number, intensity: number, color: string): void {
    const radius = 38 * (0.5 + 0.5 * easeOut(intensity));
    ctx.save();
    ctx.translate?.(pos.x, pos.y + 28);

    // Rising light beam
    if (typeof ctx.createLinearGradient === "function" && typeof ctx.fillRect === "function") {
      const beamGrad = ctx.createLinearGradient(0, 0, 0, -96);
      beamGrad.addColorStop(0, color);
      beamGrad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = 0.24 * intensity;
      ctx.fillStyle = beamGrad;
      ctx.fillRect(-radius * 0.72, -96, radius * 1.44, 96);
    }

    // Perspective magic rings
    ctx.scale?.(1, 0.36);
    ctx.globalAlpha = 0.85 * intensity;
    ctx.shadowBlur = 16;
    ctx.shadowColor = color;

    ctx.save();
    ctx.rotate?.(now / 320);
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.rotate?.(-now / 220);
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.68, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    // Floating portal sparkles
    ctx.save();
    for (let i = 0; i < 6; i++) {
      const a = (now / 450 + (i * Math.PI) / 3) % (Math.PI * 2);
      const lift = ((now / 12 + i * 17) % 68);
      const sx = pos.x + Math.cos(a) * radius * 0.72;
      const sy = pos.y + 24 - lift;
      ctx.globalAlpha = (1 - lift / 68) * intensity * 0.9;
      ctx.fillStyle = i % 2 === 0 ? color : "#fbbf24";
      ctx.beginPath();
      ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Procedural 60fps skeletal typing layer:
   * Renders a glowing mini laptop keyboard & two animated felt paws tapping keys alternately,
   * with keycap depression flashes and rising code sparks.
   */
  private drawTypingRig(ctx: CanvasRenderingContext2D, p: InternalPresence, now: number, color: string): void {
    const cx = p.pos.x;
    const cy = p.pos.y + 18;
    const phase = now / 62; // ~8Hz fast alternating tap
    const leftTap = Math.max(0, Math.sin(phase));
    const rightTap = Math.max(0, -Math.sin(phase));

    ctx.save();

    // Mini glowing desk/keyboard base
    ctx.translate?.(cx, cy);
    ctx.fillStyle = "#f5efe6";
    ctx.strokeStyle = "#d6cbbd";
    ctx.lineWidth = 1.4;
    drawRoundRectPath(ctx, -24, -4, 48, 15, 5);
    ctx.fill();
    ctx.stroke();

    // Keycaps row (depress on left/right hand strike)
    for (let k = -3; k <= 3; k++) {
      const isLeftSide = k < 0;
      const depress = isLeftSide ? leftTap * 1.8 : rightTap * 1.8;
      ctx.fillStyle = (isLeftSide && leftTap > 0.65) || (!isLeftSide && rightTap > 0.65) ? color : "#e4dacb";
      drawRoundRectPath(ctx, k * 5.8 - 2, -1 + depress, 4.4, 4.2, 1.2);
      ctx.fill();
    }

    // Screen glow reflection
    ctx.globalAlpha = 0.22 + 0.14 * Math.sin(now / 110);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, -8, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Two procedural plush paws typing alternately
    const drawPaw = (px: number, py: number, tap: number) => {
      const y = py + tap * 5.5;
      ctx.save();
      ctx.fillStyle = "#fae7d4";
      ctx.strokeStyle = "#d9bca0";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(px, y, 6.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };
    drawPaw(-11, -7, leftTap);
    drawPaw(11, -7, rightTap);

    // Rising code / work spark particles
    const glyphs = ["</>", "{}", "✦", "⚡"];
    for (let i = 0; i < 3; i++) {
      const cycle = ((now + i * 420) % 1_260) / 1_260;
      const gx = Math.sin(cycle * 5 + i * 2.1) * 14;
      const gy = -18 - cycle * 32;
      ctx.globalAlpha = (1 - cycle) * 0.85;
      ctx.fillStyle = color;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(glyphs[(i + Math.floor(p.seed)) % glyphs.length]!, gx, gy);
    }

    ctx.restore();
  }

  /** Phase 1: Fold & seal an envelope next to sender before throwing the paper airplane. */
  private drawPackEnvelope(ctx: CanvasRenderingContext2D, source: FlowPoint, target: FlowPoint, t: number, color: string): void {
    const dir = target.x >= source.x ? 1 : -1;
    const ex = source.x + dir * (28 + 8 * easeOut(t));
    const ey = source.y - 6 - Math.sin(t * Math.PI) * 8;
    const flapClose = easeInOut(clamp01(t * 1.4));

    ctx.save();
    ctx.translate?.(ex, ey);
    ctx.scale?.(0.85 + 0.25 * easeOut(t), 0.85 + 0.25 * easeOut(t));

    // Envelope body
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.shadowBlur = 10;
    ctx.shadowColor = color;
    drawRoundRectPath(ctx, -14, -9, 28, 18, 3);
    ctx.fill();
    ctx.stroke();

    // Closing top flap
    ctx.beginPath();
    ctx.moveTo(-13, -8);
    ctx.lineTo(0, -8 + flapClose * 10);
    ctx.lineTo(13, -8);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Blue wax seal stamp appears near end of packing
    if (t > 0.55) {
      const sealScale = easeOut((t - 0.55) / 0.45);
      ctx.beginPath();
      ctx.arc(0, 1, 3.6 * sealScale, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  }

  /** Phase 2: Paper airplane flies along arc with a fading dashed trail (never persistent). */
  private drawFlyingPaperPlane(ctx: CanvasRenderingContext2D, source: FlowPoint, target: FlowPoint, rawT: number, color: string): void {
    const t = easeOut(rawT);
    const center = { x: this.width / 2, y: this.height / 2 };
    const cp = controlPointForLane(source, target, center);
    const pos = quadPoint(source, cp, target, t);
    const tan = quadTangent(source, cp, target, t);
    const angle = Math.atan2(tan.y, tan.x);

    // Draw fading dashed trail behind the plane: [tailStart..t]
    const tailStart = Math.max(0, t - 0.58);
    const segments = 18;
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < segments; i++) {
      const s0 = tailStart + ((t - tailStart) * i) / segments;
      const s1 = tailStart + ((t - tailStart) * (i + 0.62)) / segments;
      if (s1 <= s0) continue;
      const p0 = quadPoint(source, cp, target, s0);
      const p1 = quadPoint(source, cp, target, s1);
      // Fade out smoothly toward the tail and fade the whole trail as it finishes
      const segFade = (i + 1) / segments;
      const endFade = rawT > 0.85 ? (1 - rawT) / 0.15 : 1;
      ctx.globalAlpha = segFade * endFade * 0.72;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 + segFade * 1.4;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.restore();

    this.drawPaperPlane(ctx, pos, angle, color);
  }

  /** Phase 3: Recipient opens the delivered envelope and a glowing letter pops out. */
  private drawUnpackEnvelope(ctx: CanvasRenderingContext2D, target: FlowPoint, t: number, color: string): void {
    const ex = target.x;
    const ey = target.y - 34;
    const openT = easeOut(clamp01(t * 1.5));
    const fadeOut = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;

    ctx.save();
    ctx.translate?.(ex, ey);
    ctx.globalAlpha = fadeOut;

    // Popping letter card
    const letterLift = openT * 12;
    ctx.fillStyle = "#fffdf7";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    drawRoundRectPath(ctx, -10, -8 - letterLift, 20, 14, 2);
    ctx.fill();
    ctx.stroke();

    // Letter lines
    ctx.strokeStyle = color;
    ctx.globalAlpha = fadeOut * 0.65;
    ctx.beginPath();
    ctx.moveTo(-6, -3 - letterLift);
    ctx.lineTo(6, -3 - letterLift);
    ctx.moveTo(-6, 1 - letterLift);
    ctx.lineTo(3, 1 - letterLift);
    ctx.stroke();

    // Envelope pocket
    ctx.globalAlpha = fadeOut;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    drawRoundRectPath(ctx, -14, -6, 28, 16, 3);
    ctx.fill();
    ctx.stroke();

    // Opened top flap pointing upward
    ctx.beginPath();
    ctx.moveTo(-13, -6);
    ctx.lineTo(0, -6 - openT * 11);
    ctx.lineTo(13, -6);
    ctx.strokeStyle = color;
    ctx.stroke();

    // Celebration sparkles
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI * 0.85 + (i * Math.PI * 0.55);
      const r = 16 + openT * 18;
      ctx.fillStyle = i % 2 === 0 ? color : "#fbbf24";
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, -10 + Math.sin(a) * r * 0.7, 2.2 * fadeOut, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawPaperPlane(ctx: CanvasRenderingContext2D, pos: FlowPoint, angle: number, accentColor: string): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rot = (lx: number, ly: number): FlowPoint => ({
      x: pos.x + lx * cos - ly * sin,
      y: pos.y + lx * sin + ly * cos,
    });

    const nose = rot(14, 0);
    const leftWing = rot(-11, -8.5);
    const tailFold = rot(-6.5, 0);
    const rightWing = rot(-11, 8.5);

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 12;
    ctx.shadowColor = accentColor;

    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    ctx.lineTo(leftWing.x, leftWing.y);
    ctx.lineTo(tailFold.x, tailFold.y);
    ctx.lineTo(rightWing.x, rightWing.y);
    ctx.closePath();
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    ctx.lineTo(tailFold.x, tailFold.y);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    const seal = rot(-1, 0);
    ctx.beginPath();
    ctx.arc(seal.x, seal.y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = accentColor;
    ctx.fill();
    ctx.restore();
  }

  private drawRipple(ctx: CanvasRenderingContext2D, source: FlowPoint, elapsed: number): void {
    const t = clamp01(elapsed / FLOW_BEAM_TIMINGS.rippleMs);
    if (t >= 1) return;
    const eased = easeOut(t);
    const radius = 24 + 84 * eased;
    ctx.save();
    ctx.globalAlpha = 0.65 * (1 - eased);
    ctx.beginPath();
    ctx.arc(source.x, source.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = resolveColor(this.colors.accent, "#0064d4");
    ctx.lineWidth = 2.2 * (1 - eased * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  private drawLocalPulse(ctx: CanvasRenderingContext2D, point: FlowPoint, elapsed: number, count: number): void {
    const t = clamp01(elapsed / FLOW_BEAM_TIMINGS.localPulseMs);
    if (t >= 1) return;
    const radius = 24 + 26 * easeOut(t);
    ctx.save();
    ctx.globalAlpha = (1 - t) * Math.min(1, 0.5 + count / 10);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = resolveColor(this.colors.accentPress, "#0064d4");
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

export function rendererColors(canvas: HTMLCanvasElement | null): FlowRendererColors {
  return Object.fromEntries(Object.entries(TOKEN_NAMES).map(([key, token]) => [key, readToken(canvas, token)])) as unknown as FlowRendererColors;
}
