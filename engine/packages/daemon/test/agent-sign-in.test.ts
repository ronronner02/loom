import { describe, expect, it } from "vitest";
import { probeAgentSignIn } from "../src/domain/agent-sign-in.js";

/**
 * The setup screen's sign-in question, asked of the client itself.
 *
 * Each client's answer comes from a status subcommand it already has, run non-interactively and
 * without writing anything. Gemini has no such subcommand — its only non-interactive entry runs a
 * turn, which spends quota — so it is never started and answers unknown. Every probe is bounded,
 * and an executable that cannot be started is a value rather than a throw.
 */
describe("agent sign-in probes", () => {
  // A path that cannot start is what proves nothing was spawned: a probe that tried would still
  // resolve (the error is caught), but a probe that reads a credential file would not be bounded.
  const unstartable = (name: string) => (process.platform === "win32" ? "C:\\fixture\\" : "/fixture/") + name;

  it("answers unknown for Gemini without running it", async () => {
    const probe = await probeAgentSignIn("gemini", unstartable("not-a-real-gemini"));
    expect(probe).toEqual({ client: "gemini", state: "unknown", signIn: "gemini" });
    // The same answer when a timeout is what would stop a slower client.
    expect((await probeAgentSignIn("gemini", process.execPath, { timeoutMs: 1 })).state).toBe("unknown");
  });

  it("keeps each client's own sign-in command when its status cannot be read", async () => {
    for (const [client, signIn] of [["claude", "claude auth login"], ["codex", "codex login"]] as const) {
      const probe = await probeAgentSignIn(client, unstartable("not-a-real-" + client), { timeoutMs: 5_000 });
      expect(probe).toMatchObject({ client, state: "unknown", signIn });
    }
  });

  it("never reports signed out for a client that could not answer", async () => {
    // Telling a signed-in owner to sign in again is the worse mistake, so an unanswered probe is
    // unknown in every case: a missing executable, a timeout, or output neither client's shape.
    for (const client of ["claude", "codex", "gemini"] as const) {
      const probe = await probeAgentSignIn(client, unstartable("absent-" + client), { timeoutMs: 5_000 });
      expect(probe.state, client).not.toBe("signed-out");
    }
  });
});