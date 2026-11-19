# Architecture

Loom is a local-first desktop app that runs a team of coding agents on a repository. This page
describes the processes, the packages, the data it keeps and the boundaries that actually hold.
It is written from the code; the file names below are the places to start reading.

## 1. What runs

```
Loom (Electron, Windows)            browser (optional viewer)
  └─ utility process: engine daemon   └─ the daemon's own Web UI
        ├─ 127.0.0.1:<OS-assigned>
        ├─ SQLite  loom.sqlite
        └─ child processes: claude.exe, codex.exe, gemini
```

The desktop is not a separate backend. It forks the engine daemon as an Electron **utility
process** (`desktop/src/engine-bridge.js`), the daemon binds `127.0.0.1` on an OS-assigned port,
and it reports that origin back over Electron's private parent channel. Nothing in the desktop
assumes a fixed port, and nothing else can reach that channel.

The agent CLIs are **direct child processes** of the daemon. There is no terminal multiplexer,
no persistent shell, no SSH and no second account: a worker is the engine's own user, launched
with `spawn`, supervised by `engine/packages/daemon/src/adapters/child-process-supervisor.ts`.

## 2. Processes and surfaces

| Process | Starts it | Talks to |
| --- | --- | --- |
| Desktop window (Electron main + renderer) | the user | the engine origin it started, over HTTP and the pairing flow |
| Engine daemon (`engine/packages/daemon`) | the desktop, or `loom daemon start` | SQLite, the filesystem, the agent CLIs, GitHub CLI |
| Agent CLI (`claude`, `codex`, `gemini`) | the daemon, one per attempt | its provider, and the daemon's mailbox endpoint |
| Companion server (optional) | the owner, on their own host | a separate Windows runner; not the desktop |

The daemon's HTTP surface is Hono (`engine/packages/daemon/src/server.ts`), mounted under
`/api/team-control`. Every route group is its own module in `src/routes/`. Today:

- `team-start`, `team-control`, `team-completion`, `team-lead`, `team-result`, `team-merge`,
  `team-telemetry`, `events` — the run lifecycle and its read models;
- `team-setup`, `team-settings`, `team-github`, `setup` — projects, teams, settings, the GitHub
  account, and first-run detection;
- `owner-session` — pairing, exchange, session list and revocation;
- `project-files`, `workspace` — the project file browser and workspace reads;
- `daemon-lifecycle` — bounded shutdown.

The browser UI at `/team` and the desktop window read the same state through the same API; there
is no desktop-only route.

## 3. Packages

| Path | What it is |
| --- | --- |
| `engine/packages/daemon` | The engine: HTTP/SSE control plane, SQLite state, worker supervisor, Git and GitHub integration |
| `engine/packages/cli` | The `loom` executable. Verbs: `team`, `daemon`, `github` |
| `engine/packages/ui` | React + TanStack Router/Query Web UI, shared by the desktop window and a browser |
| `engine/packages/i18n` | English and Simplified Chinese catalogs, with a parameter check |
| `desktop/` | Electron host, native folder dialog, engine lifecycle, Windows NSIS installer |
| `companions/loom/` | Optional self-hosted task scheduler and phone reply pages, shipped separately |

Within the daemon, `src/domain/` owns behavior, `src/routes/` owns the HTTP mapping,
`src/adapters/` owns the agent CLIs, `src/middleware/` owns the request boundary, and
`src/db/` owns the schema (`baseline.ts` is the whole schema in one file; a change ships as a
new baseline, not as a migration chain).

## 4. The run lifecycle

```
goal ──▶ lead plans in chat ──▶ owner approves ──▶ tasks ──▶ workers ──▶ review ──▶ integration branch ──▶ owner merges
```

1. **Plan.** `loom team start "<goal>" --planning` (or **New work** in the UI) creates a run. The
   daemon creates a worktree of the owner's repository on `team/<run-slug>`
   (`domain/plan-branch.ts`) and launches the lead seat in it. The lead talks to the owner in
   chat, writes the plan, and proposes a roster. Planning writes artifacts, not delivery code.
2. **Approve.** `loom team approve <run-id>` (or **Approve plan**) binds the plan's exact bytes and
   the roster. A changed plan invalidates the binding.
3. **Tasks.** The lead proposes implementer tasks. Each admitted task gets its own candidate
   worktree, created by `domain/team-workspace.ts` under the daemon's own root, never inside the
   owner's checkout.
4. **Work.** The daemon launches the assigned client with the role charter, the task brief and the
   projected context (`domain/team-assignment.ts`, `adapters/direct-worker-launch.ts`). Completion
   is observed from the process and from the candidate, not from what the worker said
   (`domain/task-completion.ts`, `domain/attempt-failure.ts`).
5. **Review.** A validated implementer outcome creates a reviewer task against that exact
   candidate. Only a reproduced P0/P1 sends work back (`domain/review-evidence.ts`,
   `domain/review-loop.ts`).
6. **Integrate.** An approved candidate lands as one commit on the run's integration branch
   (`domain/integration-branch.ts`). A patch that no longer applies is applied with
   `git apply --3way`; a conflict leaves the branch untouched and goes back to the lead.
7. **Merge.** `loom team merge <run-id>` (or **Merge**) is the only step that writes the owner's
   checkout. It fast-forwards when it can, otherwise makes one merge commit; it never pushes.

The `runs/:runId/replay` read and the Flow canvas in the UI reconstruct this history from durable
events, so a restart shows the same run.

## 5. Storage

`resolveDataRoots()` in `engine/packages/daemon/src/data-paths.ts` is the one resolver:

| Host | State | Configuration |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Loom` | `%APPDATA%\Loom` |
| Linux / macOS | `~/.loom` | `~/.loom` |

`LOOM_HOME` overrides both roots and tells the daemon that no migration may move them. The
desktop sets `LOOM_HOME` to `<desktop data root>\engine`, so the window and a manual daemon never
share a database by accident (`LOOM_DESKTOP_DATA_DIR` overrides the desktop's own root).

Inside the state root the daemon opens `loom.sqlite` (unless `LOOM_DB` names another file) and
reconciles the instance layout before it binds: `config.json`, `state/`, `context/`, `skills/`,
`specs/`, `topology/`, `plugins/`, `run/`, `logs/`, `transcripts/`, `backups/`, `secrets/`
(`domain/instance-initialization.ts`). The initializer creates only what is missing and reports a
path of the wrong type by its exact location.

Worktrees are the other half of the storage model:

- the plan/integration worktree, `team/<run-slug>`;
- one candidate per task, named `<runId>-<taskId>`;
- every path is created through `domain/worktree-policy.ts`, which refuses a Windows path Git
  cannot take before Git is asked.

An installation of the product's former name is moved into these roots once, on first start
(`migrate-data-root.ts`). Nothing is merged: an existing Loom root always wins.

## 6. Security boundaries that exist

These are the boundaries the code enforces. Anything else — an operating-system sandbox, a second
worker account, a filtered egress path — is deliberately absent, and `docs/operations.md` says so.

- **Loopback only.** The managed daemon refuses a non-loopback bind. The desktop sets
  `LOOM_BIND_HOST=127.0.0.1` and the CLI asks for loopback too (`middleware/browser-boundary.ts`,
  `domain/bind-plan.ts`).
- **Owner surface.** `teamControlAuthentication` (`middleware/auth-bearer-token.ts`) requires a
  valid owner credential or a paired owner session; paired sessions also need the anti-forgery
  header (`X-Loom-CSRF`). Pairing codes are 60-second, single-use and stored only as a digest.
- **Browser origin.** A request carrying an `Origin` header must come from the daemon's own UI
  origin or an explicitly allowed one (`LOOM_ALLOWED_ORIGINS`); a request addressed to an unknown
  host name is refused unless allowed (`LOOM_ALLOWED_HOSTS`).
- **Desktop shell.** Context isolation on, Node integration off, sandbox on; the window may only
  navigate to the engine's current origin; every permission request is denied
  (`desktop/src/main.js`, `desktop/src/window.js`).
- **Worker files.** A worker writes inside the candidate tree the daemon made for it. Everything
  the daemon later reads from that tree goes through `domain/team-workspace.ts`, which resolves
  paths against the candidate root and refuses escapes and symlinks leaving it.
- **Credentials.** The daemon holds no provider key of its own: it launches the CLI the owner
  already signed in, and GitHub access is GitHub CLI's own credential store. A per-attempt worker
  token lives only in the daemon process and in the attempt's 0600 `bootstrap.json`.

## 7. Where to add things

| Change | Start at |
| --- | --- |
| A CLI verb | `engine/packages/cli/src/commands/` and `index.ts`'s `createProgram()` |
| A route | a module in `engine/packages/daemon/src/routes/`, mounted in `server.ts` |
| A behavior | `engine/packages/daemon/src/domain/` |
| A client | `engine/packages/daemon/src/adapters/` (adapter, argv and worker-event normalizer) |
| A worker event | `adapters/worker-event-normalizer.ts` and the client's own event module |
| A screen | `engine/packages/ui/src/team/`, with the section list in `sections.ts` |
| A shipped reference page | `engine/docs/reference/` (it is staged into the package; see below) |
| A text string | `engine/packages/i18n` |

`engine/docs/reference/` is product content, not developer documentation: `build-package.sh`
stages it into the CLI package and the daemon serves it to agents. Durable developer docs belong
at the repository root or in `docs/`, never under `engine/docs/` — `engine/.gitignore` keeps that
directory to the shipped set.

## 8. Guards

The repository guards run in `npm run test:repo` and in CI:

| Guard | Script | What it refuses |
| --- | --- | --- |
| Docs placement | `engine/scripts/check-docs-guard.mjs` | A tracked file under `engine/docs/` outside the shipped roots |
| Shipped-doc references | `engine/scripts/check-first-run-references.mjs` | A shipped page naming a CLI verb, skill, team or path that does not exist |
| Brand | `engine/scripts/check-brand.mjs` | A former product name in shipped source |
| Skill mirrors | `engine/scripts/mirror-skills.mjs --check` | A skill copy that drifted from its recorded hash |
| Packaging | `engine/scripts/check-packing.test.mjs` | A package that would ship private paths or miss a staged tree |
| Internal leaks | `engine/scripts/check-internal-leak-guard.mjs` | Private host or account detail in a shipped surface |