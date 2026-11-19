// Keeps a heavy test file's reporting deadlines alive between tests.
//
// Vitest's worker reports task results through `sendTasksUpdateThrottled`, a 100 ms trailing
// timer that is not `unref`'d. When the runner takes more than 100 ms to drain a report, the next
// report goes out on that timer instead of immediately, and the worker's reply to the main
// thread's `onTaskUpdate` is only read once the worker's loop reaches its timer phase. A worker
// that leaves one test and enters the next without ever reaching that phase therefore leaves the
// reply unread across the whole chain of heavy tests. Birpc times out after 60 s and vitest exits 1
// with every test passing — the windows-latest shards' intermittent red gate.
//
// The yield below is deliberately a timer, not a promise or `setImmediate`: a promise callback
// runs in the microtask checkpoint of the same macrotask, and a `setImmediate` only runs after
// the poll phase, both of which leave the timer phase unvisited. `node:timers`' own `setTimeout`
// is used because `vitest.useFakeTimers()` replaces the globals and its `willRun` expression
// reads `raf`, which does not exist outside a browser — a leaked fake-timer test would otherwise
// fail inside this hook instead of at its own boundary.
//
// One timer per test costs about 15 ms per thousand tests (measured), against a suite of 3,000.
import { setTimeout as afterTimerPhase } from "node:timers";
import { afterEach } from "vitest";

afterEach(async () => {
  await new Promise<void>((resolve) => { afterTimerPhase(resolve, 0); });
});