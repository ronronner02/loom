import { describe, it, expect } from "vitest";
import { resolveBindPlan } from "../src/domain/bind-plan.js";

// OPR.0.5.5.20 — bind intent has unambiguous provenance: only MULTI_AGENT_BIND_HOST selects a
// listener, and the routing env is observed but never obeyed. The default is loopback-only, so a
// host that also runs Tailscale does not publish the owner surfaces on the tailnet.

describe("S20 — resolveBindPlan: routing env is never bind intent, and the default is loopback-only", () => {
  it("injected routing env + no dedicated intent → default loopback-only, and the ignore is VISIBLE", () => {
    const plan = resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: "127.0.0.1" });
    expect(plan.mode).toBe("default");
    expect(plan.hosts).toEqual(["127.0.0.1"]);
    expect(plan.ignoredRoutingHost).toBe("127.0.0.1"); // never silent — the provenance line's input
  });

  it("a routing value naming another host still does not widen the default plan", () => {
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: "100.95.124.60" }))
      .toEqual({ mode: "default", hosts: ["127.0.0.1"], ignoredRoutingHost: "100.95.124.60" });
  });

  it("dedicated intent takes the explicit single-bind branch (the channel a managed env cannot inject)", () => {
    const plan = resolveBindPlan({ bindHostEnv: "100.95.124.51", routingHostEnv: "127.0.0.1" });
    expect(plan.mode).toBe("explicit");
    expect(plan.hosts).toEqual(["100.95.124.51"]);
    expect(plan.ignoredRoutingHost).toBeUndefined(); // intent declared — nothing ignored
  });

  it("no env at all: default loopback-only", () => {
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined }))
      .toEqual({ mode: "default", hosts: ["127.0.0.1"] });
  });

  it("whitespace-only dedicated env is ABSENT (never an accidental single-bind on an empty string)", () => {
    const plan = resolveBindPlan({ bindHostEnv: "   ", routingHostEnv: undefined });
    expect(plan.mode).toBe("default");
    expect(plan.hosts).toEqual(["127.0.0.1"]);
  });
});
