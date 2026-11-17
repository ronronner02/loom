import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { canonicalSenderSession, requireSenderIdentity, resolveActorWithDeferral } from "../src/routes/require-sender-identity.js";

describe("canonicalSenderSession shape edges", () => {
  it("keeps the member@rig prefix of a host-qualified sender", () => {
    expect(canonicalSenderSession("orch@rig-a@host-7fe0ae96")).toBe("orch@rig-a");
  });
  it("passes a four-segment name through", () => {
    expect(canonicalSenderSession("a@rig@sub@host-7fe0ae96")).toBe("a@rig@sub@host-7fe0ae96");
  });
  it("leaves a two-part name, a virtual ref and a flat legacy name untouched", () => {
    expect(canonicalSenderSession("qa@hc")).toBe("qa@hc");
    expect(canonicalSenderSession("mike@external")).toBe("mike@external");
    expect(canonicalSenderSession("r01-legacy-flat")).toBe("r01-legacy-flat");
  });
  it("leaves a malformed three-part name untouched", () => {
    expect(canonicalSenderSession("qa@hc@")).toBe("qa@hc@");
    expect(canonicalSenderSession("@hc@host-1")).toBe("@hc@host-1");
  });
});

describe("sender identity helpers keep provenance rules after canonicalization", () => {
  async function derive(
    helper: typeof requireSenderIdentity | typeof resolveActorWithDeferral,
    headers: Record<string, string>,
    bodyClaim?: string,
  ) {
    const app = new Hono();
    app.get("/", c => {
      const r = helper(c, { bodyClaim });
      return c.json(r.ok ? { session: r.session, provenance: r.provenance } : { error: true });
    });
    return (await app.request("/", { headers })).json();
  }

  for (const helper of [requireSenderIdentity, resolveActorWithDeferral]) {
    it(`${helper.name}: the origin-unknown marker survives the strip`, async () => {
      expect(await derive(helper, { "X-Multi-Agent-Session": "qa@hc@host-7fe0ae96", "X-Multi-Agent-Origin-Unknown": "true" }))
        .toEqual({ session: "qa@hc", provenance: "origin-unknown:v1" });
    });

    it(`${helper.name}: the wire identity still supersedes a disagreeing body claim (P18)`, async () => {
      expect(await derive(helper, { "X-Multi-Agent-Session": "qa@hc@host-7fe0ae96" }, "somebody-else@rig"))
        .toEqual({ session: "qa@hc", provenance: "transport:v1" });
    });
  }
});
