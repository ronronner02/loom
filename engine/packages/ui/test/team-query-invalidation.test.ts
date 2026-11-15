import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTeamInvalidator } from "../src/hooks/team-query-invalidation.js";

let client: QueryClient;
const stops: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); });
afterEach(() => { for (const stop of stops.splice(0)) stop(); client.clear(); vi.useRealTimers(); });

function observe(queryKey: readonly string[], queryFn: ({ signal }: { signal: AbortSignal }) => Promise<number>) {
  client.setQueryData(queryKey, 0);
  const observer = new QueryObserver(client, { queryKey, staleTime: Infinity, queryFn });
  stops.push(observer.subscribe(() => {}));
}

describe("event-triggered snapshot refresh", () => {
  it("coalesces bursts, never cancels its fetch, and drains events arriving during it", async () => {
    const controller = new AbortController();
    let requests = 0, aborts = 0;
    const replies: Array<(value: number) => void> = [];
    const key = ["team", "run", "read"];
    observe(key, ({ signal }) => { requests += 1; signal.addEventListener("abort", () => { aborts += 1; });
      return new Promise(resolve => replies.push(resolve)); });
    const invalidate = createTeamInvalidator(client, "run", controller.signal);
    for (let event = 0; event < 20; event += 1) invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(requests).toBe(1);
    for (let event = 0; event < 20; event += 1) invalidate();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toBe(1); expect(aborts).toBe(0);
    replies.shift()!(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(requests).toBe(2);
    replies.shift()!(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getQueryData(key)).toBe(2); expect(requests).toBe(2); expect(aborts).toBe(0);
    controller.abort();
  });

  it("does not reload immutable stopped-attempt usage", async () => {
    const controller = new AbortController(), request = vi.fn(async () => 1);
    for (let index = 0; index < 20; index += 1) {
      observe(["team", "run", "attempt", String(index), "usage", "stopped"], request);
    }
    const invalidate = createTeamInvalidator(client, "run", controller.signal);
    for (let event = 0; event < 20; event += 1) invalidate();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).not.toHaveBeenCalled();
    controller.abort();
  });

  it("refreshes stopped activity because its final outcome may still change", async () => {
    const controller = new AbortController(), request = vi.fn(async () => 1);
    const key = ["team", "run", "attempt", "attempt", "activity", "stopped"];
    observe(key, request);
    const invalidate = createTeamInvalidator(client, "run", controller.signal);
    invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBe(1);
    controller.abort();
  });

  it("rechecks once when joining a fetch that started before the event", async () => {
    const controller = new AbortController();
    const replies: Array<(value: number) => void> = [];
    const request = vi.fn(() => new Promise<number>(resolve => replies.push(resolve)));
    const key = ["team", "run", "read"];
    observe(key, request);
    void client.refetchQueries({ queryKey: key });
    const invalidate = createTeamInvalidator(client, "run", controller.signal);
    invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(1);
    replies.shift()!(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(2);
    replies.shift()!(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getQueryData(key)).toBe(2);
    controller.abort();
  });

  it("does not let one unresolved query block unrelated snapshot refreshes", async () => {
    const controller = new AbortController();
    const stalled = vi.fn(() => new Promise<number>(() => {}));
    let version = 1;
    const snapshot = vi.fn(async () => version);
    const key = ["team", "run", "read"];
    observe(["team", "run", "attempt", "attempt", "activity", "running"], stalled);
    observe(key, snapshot);
    const invalidate = createTeamInvalidator(client, "run", controller.signal);
    invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(stalled).toHaveBeenCalledTimes(1); expect(snapshot).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBe(1);
    version = 2; invalidate();
    await vi.advanceTimersByTimeAsync(250);
    expect(stalled).toHaveBeenCalledTimes(1); expect(snapshot).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe(2);
    controller.abort();
  });

  it("does not refresh an abandoned run", async () => {
    const controller = new AbortController(), request = vi.fn(async () => 1);
    observe(["team", "run", "read"], request);
    const invalidate = createTeamInvalidator(client, "run", controller.signal);
    invalidate(); controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    invalidate();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).not.toHaveBeenCalled();
  });
});
