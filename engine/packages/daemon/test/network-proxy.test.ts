import { describe, expect, it } from "vitest";
import { isNetworkProxy, networkProxyEnv, proxyEnvironment } from "../src/domain/network-proxy.js";

/** The one `network.proxy`, as every child the daemon starts sees it. */
describe("network proxy", () => {
  const store = (value: unknown) => ({ resolveOne: () => ({ value }) });

  it("accepts an http(s) URL with a port, and an empty value, and nothing else", () => {
    for (const ok of ["http://127.0.0.1:7897", "https://proxy.test:8443", "http://user:pw@proxy.test:8080/path", ""]) {
      expect(isNetworkProxy(ok), ok).toBe(true);
    }
    for (const bad of ["socks5://proxy.test:1080", "http://proxy.test", "proxy.test:8080", "http://proxy.test:0",
      "http://proxy.test:65536", "http://:8080", "http://proxy.test:8080 extra"]) {
      expect(isNetworkProxy(bad), bad).toBe(false);
    }
  });

  it("leaves a child's environment untouched when no proxy is configured", () => {
    expect(proxyEnvironment("")).toEqual({});
    expect(networkProxyEnv(store(""), {})).toEqual({});
    expect(networkProxyEnv(undefined, {})).toEqual({});
  });

  it("puts the proxy on both schemes and keeps loopback out of it", () => {
    const env = networkProxyEnv(store("  http://proxy.test:8080  "), {});
    expect(env.HTTP_PROXY).toBe("http://proxy.test:8080");
    expect(env.HTTPS_PROXY).toBe("http://proxy.test:8080");
    // The agents reach the local engine over loopback, so it must stay direct.
    expect(env.NO_PROXY.split(",")).toEqual(expect.arrayContaining(["localhost", "127.0.0.1", "::1"]));
  });

  it("keeps the exclusions the daemon inherited, without repeating one", () => {
    const env = networkProxyEnv(store("http://proxy.test:8080"), { NO_PROXY: "corp.test,127.0.0.1, ,corp.test" });
    const parts = env.NO_PROXY.split(",");
    expect(parts).toEqual(expect.arrayContaining(["corp.test", "127.0.0.1", "localhost", "::1"]));
    expect(new Set(parts).size).toBe(parts.length);
    expect(parts).not.toContain("");
  });
});