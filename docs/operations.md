# Operations

Runbook for a team working on your repository. The desktop runs natively on
Windows 10/11 x64 with Node.js 22 or 24 and Git for Windows. Install and sign in to
the Claude Code or Codex clients you want to use. The engine also supports Linux.
The desktop starts its engine child, pairs its window, and displays missing
dependencies on the first-run screen. Use **Reconnect** after resolving one.

## Data and configuration

One resolver supplies the CLI and engine paths. Windows mutable state is
`%LOCALAPPDATA%\Multi-Agent`; configuration is `%APPDATA%\Multi-Agent`. Both are
`~/.multi-agent` on other platforms. `MULTI_AGENT_HOME` overrides both roots and is
also where a manually started daemon writes `daemon.json`, `daemon.log`, and
`multi-agent.sqlite`. `MULTI_AGENT_DB` explicitly selects another database file.
No previous product home or environment alias is read or migrated.

The desktop retains `%LOCALAPPDATA%\Multi-Agent\engine` for its engine state and
sets `MULTI_AGENT_HOME` to that directory when it forks. A desktop profile override,
`MULTI_AGENT_DESKTOP_DATA_DIR`, retains the same `engine` child layout. Its engine
configuration shares this explicit home. Provider configuration and sign-in remain
in the owner's normal client environment.

Use `multi-agent daemon start --port <port>` for a manual engine and
`multi-agent daemon status` or `multi-agent daemon stop` for its lifecycle. All
other retained commands use HTTP and wait for readiness. `MULTI_AGENT_URL` selects
an explicit engine origin. The desktop uses an OS-assigned port and exposes its
browser handoff through **Open browser**; do not assume a fixed desktop port.

## Create a team for your repository

From a fresh clone, run `./setup.sh`, add `engine/node_modules/.bin` to `PATH`, run
`MULTI_AGENT_UI_ENABLED=true ./scripts/start.sh`. The
[README quick start](../README.md#quick-start) gives the complete sequence. Setup creates
the owner credential and installs GitHub CLI; the start script loads the credential
and starts a managed daemon on loopback. Workers run as the engine's own user, so no
host provisioning is involved.

Install and sign in to the clients the team will use before starting work. The daemon
uses your local Claude Code and Codex configurations. A new project folder does not
need an initial commit, a plan file or a seed script.

Pair the browser, sign in to GitHub, then choose **Create project**. Select a folder,
enter a project name, choose **Review files**, and inspect the canonical path, included
file count, excluded paths and upload consequence. **Create** confirms that action.
The desktop picker accepts Windows drive folders; the browser picker lists folders
on the engine's machine, not the browser's machine.

A named project starts with only its configured lead. The lead proposes the remaining
seats during planning; plan approval approves that roster too. The older CLI path
without `--name` still registers a local repository with manual seats, as described
below; it is not the UI's project-creation flow.

## Pair a browser

Open `http://127.0.0.1:7433/team`. A new browser needs a one-time pairing code; the
Windows desktop app obtains and exchanges it automatically. Use the owner CLI to mint a one-time code:

```bash
multi-agent team pair-browser
```

The command prints only the code so it can be pasted directly into the browser. For
scripts or diagnostics, use `multi-agent team pair-browser --json` to receive the code and
its expiry timestamp. The code expires after 60 seconds and is single-use.

Enter the printed code in the browser's pairing field.

The desktop reuses its saved engine repository and any configured non-secret runtime
profile for both startup and pairing. It renews an expired owner session without
reloading the current project or form. A connection failure offers **Retry**; it does
not change the selected profile or require copying a token into the app.

## GitHub sign-in

After pairing, choose **Sign in to GitHub**, then **Open GitHub**. Enter the displayed
one-time code on GitHub and approve the device flow. The app checks the account
before mounting the project and run views. If the code expires or sign-in fails,
choose **Try again** for a new flow. A missing GitHub CLI requires `./setup.sh`.

```bash
multi-agent github status
multi-agent github status --json
```

These commands inspect the daemon's account; they do not start sign-in or print a token.
The daemon uses GitHub CLI's Linux credential store, honoring `GH_CONFIG_DIR` when
configured. It deliberately ignores inherited `GH_TOKEN` and `GITHUB_TOKEN` values
so those variables do not override the account or defeat sign-out. It does not
install a global git credential helper.

**Settings → GitHub → Sign out** signs the active account out of that store and returns
to the sign-in gate. Other processes using the same store see that change too.
**Settings → Sessions → Revoke this browser** instead revokes only the current owner
session. A standalone browser must pair again; the desktop stays disconnected until
you choose **Retry**. It does not sign GitHub out or stop the team.

## Create and retry behavior

After sign-in, preview and create a named project from the terminal:

```bash
multi-agent team create /absolute/path/to/project --name project-name --dry-run
multi-agent team create /absolute/path/to/project --name project-name
```

The second command asks for confirmation. For non-interactive use, review the dry run
first and add `--yes` only when the displayed upload is intended. `--name` uses the
configured lead; it does not combine with manual `--lead`, `--implementers` or
`--reviewer` flags.

- **New folder or no commit:** Create initializes git, adds a default `.gitignore` if
  absent, snapshots the included files into an initial commit, creates a private
  GitHub repository, sets `origin`, and pushes. The preview changes no project files.
- **Commit with no origin:** Create uploads the selected existing commit and its
  reachable history. Uncommitted changes stay local. Credential-policy paths in the
  outgoing history cause rejection; the engine does not rewrite that history.
- **Existing origin:** The project is registered without creating a remote or pushing.
  Its remote and visibility are unchanged; registration does not make it private.
- **Folder safety:** Home and drive roots, credential-policy locations and folders
  nested inside another repository are rejected. Excluded credential paths are listed.
  Inspect content before confirming: path exclusions do not detect every possible secret.
- **Name collision:** Choose a different name and review again. The existing remote
  is not reused just because its name matches.
- **Interrupted push:** Check connectivity, account access and private visibility, then
  choose **Retry** with the same folder and name. The daemon retains the bootstrap and
  retries the pinned initial commit rather than creating a second remote or commit.
  An origin or bootstrap change requires review again; do not delete its state to retry.

A desktop drive path such as `D:\code\project` maps to `/mnt/d/code/project`. The browser
accepts engine-visible absolute paths and provides a directory browser. Create's
upload is the engine's only push; delivery and Merge remain local.

### Existing local repositories with manual seats

For CLI compatibility, an unnamed Create registers a repository that already has a commit:

```bash
multi-agent team create /absolute/path/to/existing-repository
```

This path does not create or push a GitHub repository. Its defaults remain a Claude Code
lead, Claude Code and Codex implementers, and a Claude Code reviewer. `--lead <client>`,
`--implementers <comma-separated-clients>` and `--reviewer <client>` select those seats;
values are `claude-code` and `codex` (`claude` is also accepted).

## Plan and deliver

Enter a goal in the new project's start form, or choose **New work** for another run.
The lead drafts `plan.md`, asks questions in chat, and proposes the roster. Review the
plan and team together before **Approve plan**. Sending a chat answer does not approve
either artifact.

The CLI requires `--planning` for this flow:

```bash
multi-agent team start "Describe the change you want" --planning --rig <team-name>
multi-agent team chat <run-id>
multi-agent team chat <run-id> "Your answers and requested changes"
multi-agent team approve-plan <run-id>
```

Use the team name printed by Create and the run id printed by Start. `--rig` may be
omitted when there is exactly one team. Start uses `plan.md`. Planning grants ordinary
project-wide implementation only after approval; protected paths, work outside the
project, external actions, budget increases and final merge remain separate decisions.
Use `--write <path...>` to narrow that grant (for example `--write src test`). A direct
non-planning CLI Start still defaults to `src`. `--plan <path>` selects another
repository-relative plan artifact. Planning writes its agreement and proposal
artifacts, not delivery code. Approval binds the current plan and roster.

Once approved, the lead assigns implementer tasks. The daemon records outcomes,
creates reviews, routes rework and commits approved candidates to `team/…`. Workers
report blockers to the lead first. Task admission, worker completion and reviewer
verdicts require no owner action. Answer an escalation when the lead needs a decision
about scope, budget or an unresolved conflict. Owner chat has reserved lead capacity
even when worker slots are full; a provider-wide limit may still delay the reply.

For a run with a reviewer, an implementation dependency is ready only after validated
completion and its integration commit. Worker completion or review approval alone
does not start a dependent candidate before the accepted files reach the run branch.
An explicitly read-only workflow requires validated completion but no implementation
review or empty integration commit; its read paths are not exclusive write claims.
Validated task drops and settled, integrated tasks release their write-path claims
for later admitted work without deleting their records. Pending review, unintegrated
work and active attempts keep their claims.

The project selector changes the project; the run selector changes its run. The six
sections keep their own view of that context:

| Section | What to inspect |
| --- | --- |
| Overview | Progress, selected-task evidence, agent activity, owner attention and folded integration history. |
| Workspace | Seats, live pane output, native token counters and recorded tool calls. |
| Tasks | Searchable List and persistent inspector with attempts, reports and diffs; Board retains dependency stages. |
| Reviews | Candidate findings and the action to ask the lead for follow-up. |
| Analytics | Project-scoped captured stopped attempts over 7 or 30 days, grouped in UTC. |
| Settings | General, GitHub, Appearance, Sessions, model policy and specialist profiles. |

Analytics uses native input, cache and output counters without monetary estimates.
Missing counters remain unavailable, not zero. Outcome rates show their denominators;
agent utilization is the share of captured active time, not wall-clock capacity.
Workspace can show a running turn before that attempt is eligible for Analytics.

General selects the default lead client for future projects. `team.maxSeats` and
`team.maxConcurrentAgents` bound roster size and dispatch; configure them in the configuration root's
`config.json`. Environment overrides take precedence over saved values. Appearance
controls theme and the Shuimo Danqing backdrop's motion. The entrance plays once per
app/browser session, then only the complete portrait segment repeats. Navigation,
reload and reconnect do not restart the entrance. Reduced motion uses the portrait
still; animation pauses when the window loses focus or the page is hidden.
Agents edits model policy and specialist identities, not the team's size or permission
roles. The lead proposes those choices through the existing roster approval path.

## Workflows and specialist profiles

### Dispatch and outcomes

New work and the initial project chat accept an optional **Workflow** selection.
In a Lead-led run, an initial selection becomes a recorded owner request, not a
permanent workflow on the Lead's chat task. It remains in subsequent Lead prompts
until assigned once to a worker; planning requests still wait for execution approval.
A run without a Lead dispatches the selection directly to its worker.
Delivery-phase chat uses the same owner-request path, with commands such as:

```text
/spec-handoff --read-only
Summarize the current task.
```

The lead receives that request's recorded message ID. It can put
`workflow: {"entrypoint":"spec-handoff","ownerMessageId":"<message-id>","readOnly":true}`
on an ordinary proposed task. Admission checks the owner, run, entrypoint and original
input, preserves read-only scope, and permits only one assigned task per owner request.
An ordinary lead-selected workflow has caller provenance; putting an owner-only
entrypoint in a task body does not supply an owner grant. Caller-only helpers remain
internal to their governed caller contracts. No second scheduler is started.

CLI Start supports `--workflow <entrypoint>` and optional `--read-only`; the latter
requires the former. Workflow selection does not approve the plan, commit, push,
merge, external actions or a larger budget. Existing protected-path rules still apply.

The owner API provides `GET /api/team-control/workflows` and
`GET /api/team-control/runs/:runId/workflows`. Each native turn reports an outcome
envelope, retained with its attempt and generation. Missing or malformed output is
`incomplete`; the workflow reports missing capabilities as `blocked`; native process failure overrides
a claimed success. A complete answer-only, read-only workflow may have no files, but
needs a substantive summary and an unchanged candidate. Reported file artifacts must
exist before task evidence validates. The history displays native outcomes separately
from task validation, review verdicts and owner acceptance.

The owner completion read uses the outcome for the latest attempt's exact native
generation, so it applies the same workflow evidence rules as automatic completion.
A failed exact-resume preflight preserves the earlier candidate and context. Its
launch-block record is separate from the native generation that a later retry starts.

All 38 entries use the same admission, attempt-context and completion path. This is
dispatch coverage, not a claim that every external capability is installed or that
all 38 upstream workflows have passed live acceptance. Browser workflows need their
browser capability and exact target origin. The pinned browser workflow owns its
wrapper probe, exact-origin validation and checks before browser effects. Starting a
native client lets it evaluate those prerequisites; it neither authorizes browser
effects nor attests that the browser checks passed. The daemon does not produce a
browser conformance receipt. Xcode workflows record a capability block on Linux/WSL;
macOS execution remains outside the supported host matrix.

Read-only turns use the native client's read-only settings: the shell sandbox is
read-only with no approval escalation, or the alternate client is limited to
Read/Glob/Grep in planning mode without inherited external tools. These settings do not
turn same-user direct mode into an operating-system boundary; configured external tools
remain subject to the existing approval protocol. Read-only assignments may use the
binding's approved read paths as inputs without acquiring write permission or declaring
written outputs.

### Pinned source installation

`./setup.sh` installs the exact catalog revision under
`$MULTI_AGENT_HOME/framework/<revision>` (using the application's normal per-user state
home when `MULTI_AGENT_HOME` is unset). Git must be able to fetch the pinned repository.
To use an already installed, verified source package, set
`MULTI_AGENT_FRAMEWORK_ROOT` to its absolute path before setup and daemon launch.

Installation checks the fetched revision and records the complete file set and
SHA-256 hashes. Repository link blobs are checked out as inert files, not followed
as runtime mirrors. Launch verifies the source package, including supporting
references, and reads canonical source entrypoints. It never downloads at launch,
silently replaces an unverified nonempty directory, or substitutes generated skill
mirrors. Legacy launches with no installed source remain available; explicit workflow
requests record a block until source is installed.

### Versioned SOUL profiles

**Settings → Agents → Specialist profiles** contains seven built-in profiles and
owner-created profiles. A profile has an ID, display name, compatible permission
roles, instructions, version and content digest. Saving appends a project-scoped
revision with an optimistic version check; it does not overwrite an earlier saved
revision. Owner routes are:

- `GET /api/team-control/teams/:teamId/souls`
- `PUT /api/team-control/teams/:teamId/souls/:soulId`
- `PUT /api/team-control/teams/:teamId/seats/:nodeId/soul`

The lead sees the available profile IDs, names, roles and versions and can select
`soulId` in a proposed roster seat or seat addition. Permission role and client/model
are independent of that identity. A profile cannot grant permissions, change a
binding or replace the approved task. The existing runtime `profile` field retains
its meaning; specialist identity is stored separately.

Each attempt records the selected profile's exact version, content and digest in its
context. A profile edit affects new attempts; an exact resume keeps its old snapshot.
Changing a seat's identity waits until its assigned work has finished and clears that
seat's continuation tokens. No cross-run personal memory is added.

## Resume a blocked run

Read the block reason and resolve any external problem, then choose **Resume** in
the run's primary action or use:

```bash
multi-agent team resume <run-id>
```

Resume clears a resumable block and offers pending work to dispatch, including a
failed lead. It does not restart the daemon or rerun finished tasks. Time and retry
budget blocks require a positive increase in that budget in the same action:

```bash
multi-agent team resume <run-id> --add-minutes 30
multi-agent team resume <run-id> --add-retries 1
multi-agent team resume <run-id> --add-review-rounds 1
```

Use the option that matches the displayed budget block. Review exhaustion can also
be resumed without an increase so the lead can decide on follow-up work. The UI
shows the increase it will request before the click. Resume is for a blocked run;
plan approval and escalation answers remain separate actions.

## Merge the integration branch

Review the task diffs and the integration commits, then choose **Merge** in the UI
or run:

```bash
multi-agent team merge <run-id>
```

This updates the currently checked-out branch in the repository the team was created
for. The checkout must be clean and on a branch. The daemon fast-forwards when it can,
otherwise makes a merge commit. A conflict is reported and the attempted merge is
aborted, restoring the checkout. Resolve the conflict before trying the merge again.
Merge does not push; publishing the resulting branch is a separate owner action.

Readiness requires landed work, completed implementation/review tasks and no failed
task. Merge is also refused while the lead task is pending, in progress or blocked.
[PR #138](https://github.com/ronronner02/multi-agent/pull/138) (`abb344f`) fixed the
lead-evidence and premature-merge defect recorded in the
[U11 acceptance record](validation/2026-11-06-autonomous-team/README.md).

## Worker Isolation

Workers run as direct child processes under the engine's own user, with one Git
worktree per task and no host provisioning or extra accounts. Claude implementers use
`bypassPermissions` and can access files outside the assigned tree. Codex implementers
use `workspace-write`. Reviewers use Claude plan mode and read tools, or Codex
read-only mode.

The worktree and client permission settings help separate tasks; they do not provide
host containment. The engine records process and attempt identities, terminates the
child process tree on cancellation, and reconciles interrupted attempts after restart.
Use **Cancel** in the run view and inspect the resulting attempt outcome before
starting replacement work.

There is no per-worker sandbox, no separate worker account and no network filter. An
operating-system boundary, extra identities and a filtered egress path are out of scope
for the product; a host that needs one enforces it around the engine itself.

## Daemon lifecycle

The desktop starts and stops its own native engine child and recovers interrupted
work from durable attempt and process facts on restart. The team API remains owner
scoped. A manual engine can receive its owner credential in
`MULTI_AGENT_OWNER_TOKEN`; the engine consumes and clears that value before it
launches workers. `multi-agent daemon stop` reports the observed shutdown outcome.
Inspect the engine home's `daemon.log` and `daemon-shutdown.json` when recovery
requires attention.

## Managed Attempt Credentials

The producer supplies everything an attempt needs, from owners the daemon already holds. Nothing here is provisioned by hand: the daemon creates all of it itself.

- **Worker control credential.** One token per `(run, session)`, minted when the attempt is admitted. Only its digest is durable (`team_worker_credentials`); the plaintext lives in the daemon process, reaches the attempt only as `bootstrap.json` `authorization` (mode 0600 beside the mailbox socket), and is never written to a log, command line or projection. It is revoked when the attempt retires and at daemon startup, where every inherited digest names a token this process cannot honour. It authenticates that attempt's mailbox and its own control run scope, never an owner action.
- **Seat mailbox capability.** One `mailbox:{43}` per `(run, session)`, minted with the task assignment and stored in `team_seat_mailbox_capabilities`. The producer's endpoint and any later send for that seat must use this value; `poll` matches on it, so a second independently minted value would make the seat's mailbox unreadable. Deleting a row mints a fresh value on the next assignment, and messages still addressed to the old value become invisible.
- **Roots.** `context_root`, `mailbox_root` and `assignment_root` all come from the daemon's own state tree, so an attempt is created exactly where its launch will look for it.
- **Worker identity.** The worker is this daemon's own user, so uid, gid, home, scratch and the assignment directory are resolved from the process and the state tree. No `/etc/passwd` read and no account provisioning is involved.

## Source Authority and Windows Export

The repository in WSL is the development source. Build and test in the task's own worktree or verification clone; leave the owner's working checkout alone. The preserved Windows copy changes only through the separately authorized one-way export described in `docs/development.md`.

Outside the repository:

- `~/.local/state/multi-agent/cutover/` holds the cutover record and the byte manifest of the Windows workspace.
- `~/.local/state/multi-agent/exports/` holds export records.
- `~/.cache/multi-agent/` holds the checksum-verified upstream archive.

Keep these directories when rolling back: they are the record of what the Windows copy held.

## Rollback

The engine keeps all of its state under `$MULTI_AGENT_HOME`, so a rollback removes that
directory, after preserving any evidence you still need:

```bash
rm -rf "$MULTI_AGENT_HOME"
```

The Windows workspace and the owner account are never modified by the installation.

## System health lights (KTD26)

The owner-only GET /api/team-control/health query is read-only. It reports ok, degraded, failed, or unknown for the database, queue/mailbox, control tmux, worker boundary, sandbox network, and locked clients. A probe is bounded by five seconds; a timeout is unknown and never ok. The response carries the check time and an evidence reference for each light. Workers run unisolated, so the boundary, network and locked-client lights permanently report unknown with `workers_run_unisolated`; only the first three can fail.

- database: failed: preserve the database and WAL, stop managed dispatch, and check that the writer lock can be acquired and rolled back before restarting the daemon.
- queueMailbox: failed: preserve pending rows and receipts, stop new dispatch, and inspect the queue and mailbox repositories for a blocked or corrupt record.
- controlTmux: failed: leave recorded worker processes untouched, verify the control tmux socket and owned sessions, then reconcile each attempt before retrying.
- workerBoundary, sandboxNetwork, clients: these subsystems do not exist for a worker that runs as the daemon's own user, so the lights stay unknown rather than reporting a state nothing enforces.
- unknown: treat the component as unverified. Do not render it as healthy or start a managed attempt until the bounded check completes with an observed result.

## Reaching reviewers
Moved from `AGENTS.md` on 2026-10-26; the roster and review sizing stay there.
- `gpt-6.1-sol` runs through `codex exec -s read-only`. `ds/gpt-6-astra` supports the Responses API, so it runs through `codex exec -s read-only -m ds/gpt-6-astra`. The gateway requires the `ds/` prefix.
- `ds/claude-*` models run only through the Claude CLI (`claude -p --model ds/claude-...`), never through `/chat/completions`.
- If a stream drops, call the gateway's `/chat/completions` endpoint directly. Send system and user roles only, a client `User-Agent` header and a streamed response, with `reasoning_effort` set to `low`; the gateway ends any request at 300 seconds.
- A read-only `codex exec` cannot read the WSL checkout. Give each reviewer frozen, read-only copies of the diff, the touched files and the contract excerpt.
- Reach every model through the locally configured gateway. Never print or persist keys.

## Full daemon suite

This runs at project wrap-up or when the owner asks; tasks do not run it.

- Run it in a standalone clone with its own `npm ci` and a fresh `npm run build` of [`engine/packages/daemon`](../engine/packages/daemon) and [`engine/packages/cli`](../engine/packages/cli). Never use a linked worktree with symlinked `node_modules`, where daemon-spawn tests fail.
- Start it with no controlling terminal (`setsid -w … < /dev/null`, inside `tmux` when the session may be reaped). Unset `TMUX` and `TMUX_PANE` (`env -u TMUX -u TMUX_PANE`), or the hermetic scenario tests refuse to run. A test that opens an interactive shell can otherwise take the terminal, and the run then stops with SIGTTIN/SIGTTOU while looking hung.
- Put the Linux Node installation first on a clean `PATH` that excludes Windows binaries. From `engine/packages/daemon`, run `npx vitest run --maxWorkers=2 --testTimeout=60000`, one Vitest process at a time, and write a `.done` marker with the exit code on completion. Preserve the counts and failure details before cleaning up only the fixtures that run created.

## Automatic completion and review

The daemon observes each managed client's process end, validates its candidate and
records the task outcome. An implementer finishing is not enough to accept its work:
its patch must stay inside the assignment and its reviewer must approve it. Agents
cannot call an owner completion endpoint or merge into the owner's branch.

- Each native generation has one recorded attempt. Repeated receipt reads and stop
  observations update that attempt rather than creating another task or turn.
- A validated implementer outcome creates a reviewer task for that candidate. The
  daemon parses the reviewer's final findings and records its verdict. A reproduced
  P0/P1 sends the task back for rework; P2/P3 findings do not prevent approval.
- Each implementer task has its own review-round allowance. Exhaustion goes to the
  lead for a follow-up decision or escalation. A refused lead task list is returned
  to the lead with its reason, so the lead can revise it without an owner resubmission.
- Approval lands the candidate as a commit on the integration branch. Completed
  candidates can be read again after a daemon restart. Integration does not update
  the owner's checkout; the owner's Merge action does that.

The task drawer shows the attempts, worker reports, review findings and diff. Lead chat carries
questions and escalation answers. Owners do not mark each task done, transcribe
reviewer reports or approve each task list as part of this flow.

## Classifying a failed attempt (T033)

Failed attempts carry a KTD20 reason code, a `resume_safe` flag and retry eligibility.
The classifier in `engine/packages/daemon/src/domain/attempt-failure.ts` owns that
mapping; the completion path, task detail, health projection and continuation all
read it. A client can exit cleanly and still fail candidate validation; completion
then records `evidence_invalid` or `review_report_missing`.

- **Where the evidence comes from.** A direct launch sets the seat pane's `remain-on-exit` before the client starts, so a client that exits leaves the pane dead instead of destroying it (measured on tmux 3.6: without that option the pane, and a seat's only pane its session, is gone, with no exit status and no output). The completion sweep reads tmux's own `pane_dead` and `pane_dead_status` once, at the moment it records the stop, plus the pane's last lines.
- **How it decides.** A canceled run is `canceled` whatever the exit said. Otherwise a non-zero exit or a signal sends the last lines through a small set of fingerprints, each taken from output this repository already has evidence for. An exit status of 0 is a finished turn, so nothing it printed is the failure. A non-zero exit with nothing recognisable is `agent_error.unknown`. No exit record at all is no evidence, so no code is recorded — and an attempt with no code is never retried.
- **What it never does.** It adds no attempt and no unit of budget. It never retries an unknown code. A stored classification that disagrees with its own code's eligibility is refused when it is read, so a row cannot grant a retry KTD20 does not allow.
- **Automatic retry and Resume.** The completion path retries an eligible failure while the run has retry budget. Each retry spends that budget once. A failure that cannot be retried is routed to the lead; an unrecoverable lead failure blocks the run. After resolving the reason, the owner uses the Resume action described above.
- **`resume_safe: false`.** The dispatch that starts a reopened task clears the seat's saved native token first, so the next launch is a fresh native session in the same candidate tree, with every file the failed attempt wrote still there.
- `engine/demo/team/scripts/failure-demo.ts` proves both halves with a client that really fails: a refused connection is classified, retried once, fails again, and the second retry is refused on budget; a rejected key is classified and refused at once with the owner action.

| Reason code | Retry eligible | Response if work remains blocked |
| --- | --- | --- |
| `runtime_offline` | yes | Restore the runtime, then Resume the blocked run. |
| `daemon_recovery` | yes | Use Resume if daemon recovery left the run blocked. |
| `run_timeout` | yes | A wall-clock budget block needs Resume with `--add-minutes`. |
| `no_progress` | yes (`resume_safe: false`) | Discuss a narrower task with the lead; continuation starts a fresh session on the same tree. |
| `agent_error.provider_network` | yes | Restore provider connectivity; automatic retry applies while budget remains. |
| `evidence_invalid` | yes | Inspect the rejected candidate evidence if the automatic retry does not resolve it. |
| `review_report_missing` | yes | The reviewer did not return a readable findings report; automatic retry applies while budget remains. |
| `integration_conflict` | no | The lead needs to resolve the conflict against the integration head; replaying the same patch does not repair it. |
| `start_timeout` | no | Repair the client or seat before resuming a blocked run. |
| `environment_prepare_failed` | no | Repair the reported environment problem before Resume. |
| `resume_rejected` | no (`resume_safe: false`) | The saved continuation was rejected; the next attempt starts a fresh native session. |
| `agent_blocked` | no | Answer the lead's decision request; Resume if the run remains blocked. |
| `canceled` | no | Start New work if the canceled goal is still needed. |
| `agent_error.provider_auth_or_access` | no | Sign in or repair provider access before Resume. |
| `agent_error.provider_quota` | no | Add quota or wait for its reset before Resume. |
| `agent_error.provider_rate_limit` | no | Wait for the rate-limit window before Resume. |
| `agent_error.provider_server_error` | no | Wait for the provider to recover before Resume. |
| `agent_error.provider_invalid_request` | no (`resume_safe: false`) | Correct the task or client settings; the next attempt uses a fresh native session. |
| `agent_error.model_unavailable` | no | Select an available model in the client settings before Resume. |
| `agent_error.context_overflow` | no (`resume_safe: false`) | Ask the lead to narrow the work; continuation starts a fresh native session. |
| `agent_error.missing_config` | no | Supply the client configuration named by the failure before Resume. |
| `agent_error.missing_executable` | no | Install the client on the daemon's path before Resume. |
| `agent_error.unsupported_version` | no | Install the supported client build before Resume. |
| `agent_error.process_failure` | no | Inspect the attempt's failure before Resume. |
| `agent_error.unparseable_output` | no | Inspect the unreadable client output before Resume. |
| `agent_error.unknown` | no | Inspect the attempt evidence; an unknown failure is not retried automatically. |

`start_timeout` is reserved in the vocabulary: the completion path records no
attempt readiness phase to time out against yet.
