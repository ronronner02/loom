import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src/index.js";

/**
 * `LOOM_PORT` reached `parseInt` unchecked, so `abc` or `99999` became a NaN or an
 * unbindable port and `serve()` answered with Node's raw `ERR_SOCKET_BAD_PORT` rather than a
 * refusal naming the setting. The CLI already refuses its own `--port` by name; so does this.
 */
describe("startServer refuses a LOOM_PORT that cannot be bound", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["abc", "99999", "-1"])("%j", async value => {
    vi.stubEnv("LOOM_MODE", "managed");
    vi.stubEnv("LOOM_OWNER_TOKEN", "yvbshp-pcudv-wqsxk");
    vi.stubEnv("LOOM_PORT", value);
    await expect(startServer()).rejects.toThrow(/LOOM_PORT.*integer/);
  });
});