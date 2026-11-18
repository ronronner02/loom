import { execFile } from "node:child_process";

/**
 * Whether an installed agent CLI can run as a seat, asked of the client itself.
 *
 * Each client's own status subcommand answers, non-interactively and without writing anything:
 * `claude auth status` prints one JSON object and `codex login status` prints a line and sets its
 * exit code. Nothing here opens a login, reads a credential store, or sends a model request — the
 * question is only whether the CLI is signed in, which is the fact the owner needs before a seat
 * can start. A client with no status subcommand answers "unknown" rather than a guess.
 */

export type SignInState = "signed-in" | "signed-out" | "unknown";

export interface SignInProbe {
  client: "claude" | "codex" | "gemini";
  state: SignInState;
  /** The command the owner runs to sign in, or null when the client is already signed in. */
  signIn: string | null;
}

/** A status command's answer, bounded so a client that never answers cannot hold a request. */
export const SIGN_IN_TIMEOUT_MS = 4_000;
const OUTPUT_LIMIT = 64 * 1024;

interface ClientProbe {
  /** What the owner types to sign in; the one command the setup screen may tell them to run. */
  signIn: string;
  /**
   * The status subcommand, or null for a client that has none. A client with none answers
   * "unknown" without being started: its only way to find out would be a turn that costs quota.
   */
  args: string[] | null;
  parse: (result: { code: number | null; stdout: string; stderr: string }) => SignInState;
}

const PROBES: Record<SignInProbe["client"], ClientProbe> = {
  claude: { signIn: "claude auth login", args: ["auth", "status", "--json"],
    // The status JSON states the one fact; anything unreadable or absent is unknown, never
    // "signed out", because telling a signed-in owner to sign in again is the worse mistake.
    parse: ({ code, stdout }) => {
      if (code !== 0) return "unknown";
      try {
        const value = JSON.parse(stdout) as { loggedIn?: unknown };
        return typeof value.loggedIn === "boolean" ? (value.loggedIn ? "signed-in" : "signed-out") : "unknown";
      } catch { return "unknown"; }
    } },
  codex: { signIn: "codex login", args: ["login", "status"],
    // Codex exits 0 when signed in and 1 when not, and says which on stderr; both streams are read
    // because a release that changes which one it prints must not flip the answer.
    parse: ({ code, stdout, stderr }) => {
      const said = stdout + stderr;
      if (/not logged in/i.test(said)) return "signed-out";
      if (code === 0 && /logged in/i.test(said)) return "signed-in";
      return "unknown";
    } },
  // Gemini's headless mode is the only non-interactive entry it has, and it answers a turn rather
  // than a status question: a signed-out client fails only when asked to run one. Its sign-in is
  // the `/auth` choice inside the interactive client, so the command is the client itself.
  gemini: { signIn: "gemini", args: null, parse: () => "unknown" },
};

/** Ask one installed client whether it is signed in. Never throws: an unanswered probe is unknown. */
export function probeAgentSignIn(client: SignInProbe["client"], executable: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<SignInProbe> {
  const probe = PROBES[client];
  return new Promise(resolve => {
    const done = (state: SignInState) => resolve({ client, state, signIn: state === "signed-in" ? null : probe.signIn });
    if (probe.args === null) { done("unknown"); return; }
    try {
      execFile(executable, probe.args, { windowsHide: true, timeout: options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
        killSignal: "SIGKILL", encoding: "utf8", maxBuffer: OUTPUT_LIMIT,
        ...(options.env ? { env: options.env } : {}) }, (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code === "string") { done("unknown"); return; }
        done(probe.parse({ code: error ? Number((error as { code?: unknown }).code ?? 1) : 0,
          stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
      });
    } catch { done("unknown"); }
  });
}