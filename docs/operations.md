# Operations

How to run Loom: where it keeps data, how to start and stop it, how to create a project, plan and
deliver work, and what to do when something goes wrong. Architecture and the boundaries the code
enforces are in [`docs/architecture.md`](architecture.md).

## 1. Data and configuration

One resolver (`engine/packages/daemon/src/data-paths.ts`) supplies every path:

| | Windows | Linux / macOS |
| --- | --- | --- |
| Mutable state | `%LOCALAPPDATA%\Loom` | `~/.loom` |
| Configuration | `%APPDATA%\Loom` | `~/.loom` |

`LOOM_HOME` overrides both roots and is also where a manually started daemon writes `daemon.json`,
`daemon.log` and `loom.sqlite`; `LOOM_DB` selects another database file. A caller that sets
`LOOM_HOME` owns that location, so no migration ever moves it.

The desktop keeps its own root at `%LOCALAPPDATA%\Loom`, with the engine's state in its `engine/`
subdirectory; `LOOM_DESKTOP_DATA_DIR` overrides that root for a test or a manual run. Installing
N+1 over N replaces the program files; uninstalling keeps `%LOCALAPPDATA%\Loom` and
`%APPDATA%\Loom`, including the recovery records of interrupted runs.

An installation made under the product's former name is moved into these roots on first start.
Nothing is merged: if a Loom root already exists, it wins.

Inside the state root:

```
config.json      typed settings; the Settings screen is the supported way to change them
state/           runtime-owned durable state
context/         the addressable context library (context.root)
skills/          the managed skill catalog
specs/           the instance spec library
topology/        instance, team and seat continuity
plugins/         installed plugins
run/             process coordination files
logs/            daemon and operation logs
transcripts/     durable per-attempt transcripts
backups/         operator-created recovery artifacts
secrets/         local connector and host secrets
loom.sqlite      projects, runs, tasks, attempts, events, owner sessions
```

The initializer creates only what is missing and reports a path of the wrong type by its exact
location. It never overwrites a file, and a second run against a converged instance writes
nothing.

`%LOCALAPPDATA%\Loom\engine` (the desktop's engine home) is where `daemon.log`,
`daemon-shutdown.json` and the database live for the packaged app.

## 2. Start and stop

**The desktop app** starts and stops the engine itself. Closing the window runs the daemon's
bounded shutdown; **Engine → Stop engine** stops it without closing the window, and **Engine →
Reconnect** starts it again. A second launch focuses the window that is already open rather than
starting a second engine.

**A manual engine** uses the CLI:

```sh
loom daemon start [--port <port>] [--host <host>] [--db <path>]
loom daemon status [--json]
loom daemon stop
```

A managed daemon refuses any listener that is not loopback, so a manual start also asks for
`127.0.0.1`. `loom daemon stop` has a ten-second shutdown budget and a twelve-second process wait;
it exits nonzero rather than claiming a clean shutdown it could not verify. On Windows `SIGTERM`
terminates the process outright, so the engine reconciles interrupted work at its next start
instead of draining.

A manual engine receives its owner credential in `LOOM_OWNER_TOKEN`; it consumes and clears that
value before launching any worker. From a source checkout, `./setup.sh` creates the credential at
`<config root>/owner.env` (mode 0600) and `./scripts/start.sh` loads it.

## 3. First run

The packaged app opens on a setup screen before the GitHub gate. It shows:

- **Tools** — Git, GitHub CLI, Claude Code, Codex and Gemini, found (with the resolved path) or
  missing (with the one install line that fixes it).
- **Agent sign-in** — whether each installed client already has a signed-in account. A client that
  did not answer gets a neutral mark; it is a gap in the evidence, not a failure.
- **Proxy** — one value that covers GitHub operations and every agent CLI. The daemon validates it
  and applies it to the next call; saving is the whole action, and emptying the field removes the
  proxy.

Completion is stored in settings and remembered by the browser, so a later launch skips it.
Settings and the GitHub gate's own link reopen it.

The setup screen precedes the GitHub check because a network that blocks GitHub blocks sign-in
itself, and the proxy that fixes it lives on that screen.

## 4. Sign in to GitHub

Choose **Sign in to GitHub → Open GitHub**. Enter the displayed device code on GitHub and approve
the flow; the app checks the account before mounting the project and run views. If the code
expires, choose **Try again**.

```sh
loom github status [--json]
loom github sign-in [--json]
```

The daemon uses GitHub CLI's own credential store and deliberately ignores inherited `GH_TOKEN`
and `GITHUB_TOKEN` values, so an environment variable cannot override the account or defeat
sign-out. It does not install a global git credential helper.

**Settings → GitHub → Sign out** signs the active account out of that store and returns to the
sign-in gate; other processes using the same store see the change. **Settings → Sessions → Revoke
this browser** revokes only the current owner session: a standalone browser must pair again, and
the desktop stays disconnected until **Reconnect**. It does not sign GitHub out or stop the team.

## 5. Create or open a project

Choose **Create project**, use **Browse…**, enter a project name, choose **Review files**, then
**Create**. From the terminal:

```sh
loom team create /absolute/path/to/project --name project-name --dry-run
loom team create /absolute/path/to/project --name project-name --yes
```

- **New folder or no commit** — Create initializes git, adds a default `.gitignore` if absent,
  snapshots the included files into an initial commit, creates a private GitHub repository, sets
  `origin` and pushes. The preview changes no project files.
- **Commit with no origin** — Create uploads the selected commit and its reachable history.
  Uncommitted changes stay local. A credential-policy path in the outgoing history causes a
  rejection; the engine does not rewrite that history.
- **Existing origin** — the project is registered without creating a remote or pushing. Its remote
  and visibility are unchanged; registration does not make it private.
- **Folder safety** — home and drive roots, credential-policy locations and folders nested inside
  another repository are rejected, and excluded credential paths are listed. Directory exclusions
  do not detect every possible secret; inspect content before confirming.
- **Interrupted push** — check connectivity and access, then choose **Retry** with the same folder
  and name. The daemon retries the pinned initial commit rather than creating a second remote.

An unnamed Create registers a repository that already has a commit, with manual seats:

```sh
loom team create /absolute/path/to/existing-repository
```

Manual seats default to a Claude Code lead, Claude Code and Codex implementers and a Claude Code
reviewer; `--lead`, `--implementers` and `--reviewer` select clients (`claude-code`, `codex`,
`gemini`; `claude` is shorthand).

## 6. Plan and deliver

Enter a goal in the project's start form, or choose **New work**. The lead drafts the plan, asks
questions in chat, and proposes the roster. Review both before **Approve plan**; sending a chat
answer approves neither.

```sh
loom team start "<goal>" --planning --repository <path>
loom team chat <run-id>                      # the conversation so far
loom team chat <run-id> "<your answer>"
loom team approve <run-id>
```

Approval binds the plan's exact bytes and the roster. Once approved, the lead assigns implementer
tasks; the daemon records outcomes, creates reviews, routes rework and commits approved candidates
to the run's `team/<run-slug>` branch. Workers report blockers to the lead first. Answer an
escalation when the lead needs a decision about scope, budget or an unresolved conflict.

An implementation dependency becomes ready only after validated completion and its integration
commit. Validated task drops and settled, integrated tasks release their write-path claims;
pending review, unintegrated work and active attempts keep theirs.

### Where to look

| Screen | What it shows |
| --- | --- |
| Chat | The owner↔lead conversation, with inline plan approval and decision prompts |
| Overview | Run progress, selected-task evidence, integration history, Flow replay, Merge, and 7/30-day token analytics |
| Tasks | Searchable task list, dependency Board, and a persistent inspector with attempts, reports and diffs |
| Workspace | Seats, live tool activity, the project Inbox (GitHub Issues), and Reviews & Diffs |
| Documents | Versioned Exploration, Requirements and Plan documents, with side-by-side comparison |

Analytics uses native input, cache and output counters without monetary estimates, and is grouped
in UTC. A missing counter is *unavailable*, not zero. Workspace can show a running turn before it
is eligible for analytics.

### Specialist profiles and workflow selection

**Settings → Agents** edits model policy and specialist profiles, not the team's size or permission
roles; the lead proposes those through the roster approval. New work and the initial project chat
accept an optional **Workflow**; a selection is a recorded owner request, dispatched once. A CLI
start takes `--workflow <entrypoint>` and optional `--read-only`, which requires the former.
Workflow selection does not approve the plan, commit, push, merge or raise a budget.

A run records each attempt's outcome envelope: missing or malformed output is `incomplete`, a
missing capability is `blocked`, and a native process failure overrides a claimed success.
Reported file artifacts must exist before the task evidence validates.

### Worker isolation

Workers are direct child processes under the engine's own user, with one Git worktree per task and
no host provisioning or extra accounts. Claude implementers use `bypassPermissions`; Codex
implementers use `workspace-write`. Reviewers use Claude plan mode with read tools, or Codex
read-only mode.

The worktree and the client permission settings separate tasks; they are **not** host containment.
There is no per-worker sandbox, no separate worker account and no network filter. A host that needs
one enforces it around the engine itself.

The daemon creates everything an attempt needs from state it already holds: a per-attempt worker
token (only its digest is durable), a per-seat mailbox capability, and the context, mailbox and
assignment roots. None of it is provisioned by hand.

## 7. Resume, cancel, deliver

- **Cancel** stops further dispatch for the run and reports the observed termination outcome
  rather than inferring success from the click.
- **Resume** clears a resumable block and offers pending work to dispatch, including a failed lead.
  It does not restart the daemon or rerun finished tasks. In the UI, a time or retry budget block
  shows the increase the action will request and you confirm it in the same click
  (`addMinutes`, `addRetries` or `addReviewRounds` on the resume request). The CLI has no resume
  verb; use the run's primary action in the UI.
- **Result** and **diff** read the durable result and the patch: `loom team result <run-id>`,
  `loom team diff <run-id>`. Both need the task to be finished; a run still working answers 409.
  For a run with more than one implementer task, name it with `--task <id>`.
- **Merge** writes the owner's checkout: `loom team merge <run-id>` or **Merge**. The checkout must
  be clean and on a branch; the daemon fast-forwards when it can, otherwise makes one merge commit,
  and aborts a conflicting merge while restoring the checkout. Merge does not push.

Readiness for Merge requires landed work, completed implementation and review tasks, no failed
task, and no pending or blocked lead task.

## 8. Recovery and health

The daemon observes each managed client's process end, validates its candidate and records the
outcome. An implementer finishing is not enough to accept its work: its patch must stay inside the
assignment and a reviewer must approve it. Agents cannot call an owner completion endpoint or merge
into the owner's branch.

Failed attempts carry a reason code, a `resume_safe` flag and retry eligibility. A client that
exits cleanly can still fail candidate validation (`evidence_invalid` or `review_report_missing`).
The completion path retries an eligible failure while the run has retry budget; a failure that
cannot be retried is routed to the lead, and an unrecoverable lead failure blocks the run.

| Reason code | Retried automatically | What the owner does |
| --- | --- | --- |
| `runtime_offline`, `daemon_recovery` | yes | Restore the runtime, then Resume if still blocked |
| `run_timeout` | yes | Resume with `--add-minutes` if the budget block remains |
| `no_progress` | yes (`resume_safe: false`) | Discuss a narrower task with the lead |
| `agent_error.provider_network` | yes | Restore connectivity |
| `evidence_invalid`, `review_report_missing` | yes | Inspect the rejected evidence if the retry does not resolve it |
| `integration_conflict` | no | The lead resolves the conflict against the integration head |
| `start_timeout`, `environment_prepare_failed` | no | Repair the client or environment before Resume |
| `resume_rejected` | no (`resume_safe: false`) | The next attempt starts a fresh native session |
| `agent_blocked` | no | Answer the lead's decision request |
| `canceled` | no | Start **New work** if the goal is still needed |
| `agent_error.provider_auth_or_access`, `provider_quota`, `provider_rate_limit`, `provider_server_error` | no | Repair or wait for provider access |
| `agent_error.model_unavailable`, `missing_config`, `missing_executable`, `unsupported_version` | no | Fix the client configuration named by the failure |
| `agent_error.provider_invalid_request`, `context_overflow` | no (`resume_safe: false`) | Correct the task or narrow the work |
| `agent_error.process_failure`, `unparseable_output`, `unknown` | no | Inspect the attempt evidence |

**Health.** **Overview** shows a status strip from one bounded health query,
`GET /api/team-control/health`. It reports `ok`, `degraded`, `failed` or `unknown` for six named
lights — `database`, `queueMailbox`, `controlTmux`, `workerBoundary`, `sandboxNetwork` and
`clients` — with a five-second bound per probe and thirty seconds overall. A timeout is `unknown`
and never `ok`.

Workers run unisolated, so `workerBoundary`, `sandboxNetwork` and `clients` stay `unknown` with
reason `workers_run_unisolated`, and `controlTmux` stays `unknown` with `terminal_control_removed`;
only `database` and `queueMailbox` can fail. When either reports `failed`, stop dispatch, preserve
the database, WAL and pending rows, and inspect them before restarting.

**Logs.** `daemon.log` in the engine home has the daemon's own output; `daemon-shutdown.json`
records the last shutdown. Attempt transcripts and evidence stay under the state root's
`transcripts/` and the run's own records.

**Rollback.** Every durable state is under `$LOOM_HOME` (or `%LOCALAPPDATA%\Loom` on Windows), so a
rollback is: stop the engine, preserve any evidence you still need, then remove that directory.
The owner's repositories and GitHub account are never modified.

**Investigate the CLI the CLI cannot reach.** `loom --help`, `loom team --help`,
`loom daemon --help` and `loom github --help` are authoritative for the verbs that exist. If the
daemon is unreachable, `loom daemon status` says so directly.

## 9. Optional companion

The companion in `companions/loom/` is a separate, self-hosted task scheduler with a Windows
runner and phone reply pages. It is distributed separately and does not connect to the desktop:
desktop teams and companion tasks are not synchronized. Installing or launching the desktop does
not deploy a companion, configure a host, or hold any credential for one.

See [`companions/loom/README.md`](../companions/loom/README.md) for its setup and
[`INTEGRATION.md`](../companions/loom/INTEGRATION.md) for the current boundary. Do not give the
companion runner and a desktop-managed team concurrent ownership of the same task or worktree.

## 10. Reaching an independent reviewer

The orchestrating session reviews every pull request. Code that guards credentials or reads
worker-written files (`engine/packages/daemon/src/domain/team-workspace.ts`) also gets one
independent, report-only reviewer for one round, plus one confirmation of any P0/P1 fix. Give it
`engine/config/team/roles/reviewer.md` and `engine/config/team/core.md`. A read-only `codex exec`
cannot see the worktree, so give it frozen copies of the diff, the touched files and the contract
excerpt. Reach every model through the owner's own configured gateway and never print or persist a
key.