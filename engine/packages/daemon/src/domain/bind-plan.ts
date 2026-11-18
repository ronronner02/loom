// DAEMON BIND PROVENANCE: the pure bind-plan resolver. Bind intent
// reaches the daemon ONLY through the dedicated MULTI_AGENT_BIND_HOST surface; the
// overloaded routing env (MULTI_AGENT_HOST — a client endpoint any managed
// environment may inject) can NEVER select the single-bind branch.
//
// The default plan is loopback-only. The owner surfaces are reachable from the owner's own
// machine and nowhere else: the desktop already forks the engine with
// `MULTI_AGENT_BIND_HOST=127.0.0.1`, and reaching the daemon from another device goes through
// the companion, not a wider listener. Adding the host's tailnet address to the default plan
// would publish those surfaces on a network the product does not administer, so a host that
// happens to run Tailscale binds loopback like any other. An owner who really wants another
// listener names it through MULTI_AGENT_BIND_HOST (or `--host`), which is an explicit opt-in.

export interface BindPlanInput {
  /** The DEDICATED bind-intent env (MULTI_AGENT_BIND_HOST). Whitespace-only = absent. */
  bindHostEnv: string | undefined;
  /** The overloaded ROUTING env (MULTI_AGENT_HOST) — observed for provenance
   *  honesty, never consulted for bind policy. */
  routingHostEnv: string | undefined;
}

export interface BindPlan {
  mode: "explicit" | "default";
  hosts: string[];
  /** Set when a routing env value was present and IGNORED for bind policy — the
   *  provenance line the daemon logs so the ignore is never silent. */
  ignoredRoutingHost?: string;
}

export function resolveBindPlan(input: BindPlanInput): BindPlan {
  const bindHost = input.bindHostEnv?.trim() || undefined;
  const routingHost = input.routingHostEnv?.trim() || undefined;
  if (bindHost) {
    return { mode: "explicit", hosts: [bindHost] };
  }
  return {
    mode: "default",
    hosts: ["127.0.0.1"],
    ...(routingHost ? { ignoredRoutingHost: routingHost } : {}),
  };
}
