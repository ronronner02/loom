import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";

/** Refresh snapshots at a bounded rate; event rendering remains immediate. */
export function createTeamInvalidator(client: QueryClient, runId: string, signal: AbortSignal): () => void {
  const filters: QueryFilters = {
    queryKey: ["team", runId],
    // Final usage is captured before the stopped state; activity outcome may still change afterward.
    predicate: query => query.queryKey[2] !== "events"
      && !(query.queryKey[2] === "attempt" && query.queryKey[4] === "usage" && query.queryKey[5] === "stopped"),
  };
  const queued = new Set<Query>(), inFlight = new Set<Query>();
  let refreshAll = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (signal.aborted || timer !== undefined) return;
    timer = setTimeout(refresh, 250);
  };
  const refresh = () => {
    timer = undefined;
    if (signal.aborted) return;
    if (refreshAll) {
      for (const query of client.getQueryCache().findAll(filters)) queued.add(query);
      refreshAll = false;
    }
    for (const query of queued) {
      // Slow resources serialize independently, so they never stall unrelated snapshots.
      if (inFlight.has(query)) continue;
      queued.delete(query);
      const joined = query.isActive() && query.state.fetchStatus === "fetching";
      inFlight.add(query);
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false, throwOnError: false })
        .finally(() => {
          inFlight.delete(query);
          if (signal.aborted) return;
          // A joined request may have read before the event. Its own trailing read closes that gap.
          if (joined) queued.add(query);
          if (queued.size) schedule();
        });
    }
  };
  signal.addEventListener("abort", () => { clearTimeout(timer); timer = undefined; queued.clear(); }, { once: true });
  return () => { if (!signal.aborted) { refreshAll = true; schedule(); } };
}
