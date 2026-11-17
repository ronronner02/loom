// The one canonicalizer the transport identity passes through before any actor compare or record.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { canonicalSenderSession, requireSenderIdentity, resolveActorWithDeferral } from "../src/routes/require-sender-identity.js";

describe("canonicalSenderSession", () => {
  it("reduces a host-qualified sender to its local canonical seat", () => {
    expect(canonicalSenderSession("qa-codex-3@hc@host-remote1")).toBe("qa-codex-3@hc");
  });
  it("leaves an unqualified seat unchanged", () => {
    expect(canonicalSenderSession("qa-codex-3@hc")).toBe("qa-codex-3@hc");
    expect(canonicalSenderSession("operator")).toBe("operator");
  });
  it("never strips down to a non-seat: a bare member@host or an empty part is left alone", () => {
    expect(canonicalSenderSession("a@host-1")).toBe("a@host-1");
    expect(canonicalSenderSession("@r@host-1")).toBe("@r@host-1");
  });
});

describe("sender identity helpers canonicalize the transport header", () => {
  async function derive(helper: typeof requireSenderIdentity | typeof resolveActorWithDeferral, header: string) {
    const app = new Hono();
    app.get("/", c => {
      const r = helper(c, { bodyClaim: "ignored@r" });
      return c.json(r.ok ? { session: r.session, provenance: r.provenance } : { error: true });
    });
    return (await app.request("/", { headers: { "X-Multi-Agent-Session": header } })).json();
  }
  for (const helper of [requireSenderIdentity, resolveActorWithDeferral]) {
    it(`${helper.name}: a host-qualified seat becomes bare, a bare seat stays put`, async () => {
      expect(await derive(helper, "b@r@host-other")).toEqual({ session: "b@r", provenance: "transport:v1" });
      expect(await derive(helper, "b@r")).toEqual({ session: "b@r", provenance: "transport:v1" });
    });
  }
});
