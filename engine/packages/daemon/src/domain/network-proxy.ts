/**
 * The one `network.proxy` setting, as a child process sees it.
 *
 * GitHub operations and every agent CLI the daemon launches read the same value, so a person
 * behind a proxy configures it once. One site must never be proxied: the local engine. The
 * agents reach it over loopback, and a proxy that swallowed that traffic would break the engine
 * while GitHub still worked. `NO_PROXY` therefore always names loopback, on top of whatever the
 * daemon's own environment already excludes.
 */

/** The names a child process may use to reach this machine; none of them goes through a proxy. */
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

/** An `http(s)://host:port` proxy, with optional credentials and path, and nothing else. */
const PROXY_URL = /^https?:\/\/(?:[^\s/?#@]+@)?[^\s/?#:]+:(\d{1,5})(?:[/?#][^\s]*)?$/i;

/** Whether a stored value is a proxy URL this daemon can hand to a child, or "no proxy" (empty). */
export function isNetworkProxy(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  const match = trimmed.match(PROXY_URL);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535;
}

/** The configured proxy URL, trimmed, or an empty string when the owner set none. */
export function configuredProxy(store: { resolveOne(key: "network.proxy"): { value: unknown } } | undefined): string {
  const value = store?.resolveOne("network.proxy").value;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The environment that makes a child process use `proxy`.
 *
 * An empty proxy contributes nothing, which leaves a child inheriting the daemon's own
 * environment exactly as it did before this setting existed.
 */
export function proxyEnvironment(proxy: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!proxy) return {};
  const excluded = [...LOOPBACK, ...(env.NO_PROXY ?? env.no_proxy ?? "").split(",").map(part => part.trim())];
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: [...new Set(excluded)].filter(Boolean).join(",") };
}

/** The proxy environment for the owner's current setting. */
export function networkProxyEnv(store: { resolveOne(key: "network.proxy"): { value: unknown } } | undefined,
  env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return proxyEnvironment(configuredProxy(store), env);
}