import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "./config-store.js";
import { getLoomHome } from "@loom/daemon/data-paths";
import { fetchWithTimeout, FetchTimeoutError } from "./fetch-with-timeout.js";

/** The header carrying the caller's seat identity, derived ONCE at the transport chokepoint. */
export const SENDER_IDENTITY_HEADER = "X-Loom-Session";

/**
 * P18 sender-provenance — derive the caller's identity from the seat ENV (never a request-body
 * claim). Routes that record authorship into the channel of record read ONLY this header, so a
 * buggy/stale caller cannot write false history by fat-fingering or stale-copying a body field.
 * Absent env ⇒ no header ⇒ the daemon DELIVERS and labels the write `claimed:v1` (P18 deliver-and-label;
 * a write with no actor at all is 400 actor_required — parameter completeness, not a refusal). One
 * chokepoint: `DaemonClient.fetch` stamps this on every request; callers never set it by hand.
 */
export function senderIdentityHeaders(): Record<string, string> {
  const session = process.env.LOOM_SESSION_NAME?.trim();
  return session ? { [SENDER_IDENTITY_HEADER]: session } : {};
}

/** The OS code behind a failed connection (`EPERM`, `ECONNREFUSED`, …) when Node exposes one.
 *  `fetch` reports every connection failure as "fetch failed" and keeps the code on `cause`. */
export function connectionErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && code ? code : undefined;
}

export class DaemonConnectionError extends Error {
  /** A write caller cannot infer nondelivery from losing the response. */
  writeOutcome?: "unknown";
  /** The OS cause, so a connection this machine blocked is not rendered as a stopped daemon. */
  causeCode?: string;

  constructor(message: string, causeCode?: string) {
    super(message);
    this.name = "DaemonConnectionError";
    if (causeCode) this.causeCode = causeCode;
  }
}

/**
 * Slow-response: the request reached its bound without a reply. A SUBCLASS of
 * DaemonConnectionError so existing callers still catch it, but distinguishable
 * so the CLI can render "slow, not stopped" instead of daemon-down language.
 */
export class DaemonTimeoutError extends DaemonConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "DaemonTimeoutError";
  }
}

/**
 * Bad-response: the daemon replied, but the body could not be read or parsed as JSON
 * (truncated / unparseable / non-JSON — a real symptom under daemon saturation).
 * DISTINCT from a stopped or unreachable daemon: the request WAS delivered and
 * the outcome is unknown, so this must never render as daemon-not-running.
 */
export class DaemonResponseError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  constructor(status: number, body: string) {
    super(`The daemon returned an unreadable response (HTTP ${status}).`);
    this.name = "DaemonResponseError";
    this.status = status;
    this.bodySnippet = body.slice(0, 200);
  }
}

export interface DaemonResponse<T = unknown> {
  status: number;
  data: T;
}

export class DaemonHttpError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * Issue #425: wrap bare IPv6 literals in brackets for URL hosts. `::1` must
 * render as `[::1]` — `http://::1:7433` never parses in fetch. Hostnames,
 * IPv4, and already-bracketed literals pass through unchanged.
 */
export function formatDaemonHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

interface DaemonRequestOptions {
  timeoutMs?: number;
  /** Caller cancellation applies to the request and its finite response body. */
  signal?: AbortSignal;
  /** Per-call header overrides (e.g., `Authorization: Bearer ...`). */
  headers?: Record<string, string>;
}

interface DaemonClientOptions {
  /** Owner commands authenticate over HTTP and never read local seat identity. */
  senderIdentity?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Routing state published by daemon start, not a health check or sibling-home discovery. */
function localDaemonUrl(): string | undefined {
  try {
    // Resolve at construction time: embedders may change LOOM_HOME after import.
    const state = JSON.parse(fs.readFileSync(path.join(getLoomHome(), "daemon.json"), "utf-8"));
    if (!state || !Number.isSafeInteger(state.pid) || state.pid <= 0
      || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
      || (state.host !== undefined && (typeof state.host !== "string" || !state.host.trim()))) return undefined;
    // A stale PID must not redirect reads or writes to another configured daemon.
    // Keep the recorded endpoint; the request decides reachability, even after exit.
    return `http://${formatDaemonHostForUrl(state.host ?? "127.0.0.1")}:${state.port}`;
  } catch {
    return undefined;
  }
}

export class DaemonClient {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch = fetch;
  private timeoutMs = 5_000;
  private identity?: Promise<Record<string, string>>;
  private senderIdentity: boolean;

  constructor(baseUrl?: string, options?: DaemonClientOptions) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else {
      const envUrl = process.env.LOOM_URL;
      if (envUrl) {
        this.baseUrl = envUrl;
      } else {
        // --port/--host can differ from configured startup defaults. Match the
        // lifecycle-aware commands by preferring this home's recorded endpoint.
        const localUrl = localDaemonUrl();
        if (localUrl) {
          this.baseUrl = localUrl;
        } else {
          const config = new ConfigStore().resolve(); // env > file > defaults
          this.baseUrl = `http://${formatDaemonHostForUrl(config.daemon.host)}:${config.daemon.port}`;
        }
      }
    }

    this.senderIdentity = options?.senderIdentity ?? true;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? 5_000;
  }

  async waitForReady(): Promise<DaemonResponse<{ status?: string; pid?: number; code?: string; error?: string }>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.get<{ status?: string; pid?: number; code?: string; error?: string }>("/healthz");
        if (response.status === 200) return response;
        if (response.status !== 503 || attempt === 4) {
          throw new DaemonHttpError(response.data.code ?? "daemon_not_ready",
            response.data.error ?? `The daemon is not ready (HTTP ${response.status}).`);
        }
      } catch (error) {
        if (!(error instanceof DaemonConnectionError) || error.causeCode !== "ECONNREFUSED" || attempt === 4) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  async get<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, { method: "GET" }, options);
  }

  async post<T = unknown>(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  private async fetch(path: string, init: RequestInit, options?: DaemonRequestOptions, consumeResponse?: (response: Response) => Promise<void>): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    if (options?.signal) init = { ...init, signal: options.signal };
    if (options?.headers) {
      init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...options.headers } };
    }
    // P18 sender-provenance: stamp the seat-derived identity header LAST, so the transport — never a
    // caller-supplied header or a request body — decides the caller identity the channel of record records.
    this.identity ??= Promise.resolve(this.senderIdentity ? senderIdentityHeaders() : {});
    init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...await this.identity } };
    let responseStatus: number | undefined;
    try {
      const response = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        init,
        {
          timeoutMs,
          consumeResponse: consumeResponse ? async (response) => {
            responseStatus = response.status;
            await consumeResponse(response);
          } : undefined,
          timeoutMessage: `Request to ${this.baseUrl}${path} timed out after ${timeoutMs}ms`,
        },
      );
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Slow-response (a timed-out request) is a DISTINCT class from no-connect:
      // the daemon may be up but saturated. Surface it as a subclass so callers
      // still catch DaemonConnectionError, but the CLI can say "slow, not stopped".
      if (err instanceof FetchTimeoutError) {
        throw new DaemonTimeoutError(`The Loom daemon at ${this.baseUrl} did not respond in time: ${msg}`);
      }
      // Headers prove that the daemon received the request, but not that a write
      // finished. A dropped body must preserve unknown-outcome guidance.
      if (responseStatus !== undefined) throw new DaemonResponseError(responseStatus, "");
      const causeCode = connectionErrorCode(err);
      throw new DaemonConnectionError(
        `Cannot connect to the Loom daemon at ${this.baseUrl}: ${msg}${causeCode && !msg.includes(causeCode) ? ` (${causeCode})` : ""}`,
        causeCode,
      );
    }
  }

  private async requestJson<T>(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    let text = "";
    const res = await this.fetch(path, init, options, async (response) => { text = await response.text(); });
    // Read the raw body once, THEN parse — so a truncated / unparseable response
    // (a real symptom under daemon saturation) surfaces as a typed
    // DaemonResponseError carrying the status + a bounded snippet, instead of a
    // raw SyntaxError bubbling to a cryptic (json) or silent (human) CLI exit.
    // A well-formed non-2xx body still parses and returns {status,data}; 204 has none.
    if (res.status === 204) return { status: res.status, data: undefined as T };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      throw new DaemonResponseError(res.status, text);
    }
  }

}
