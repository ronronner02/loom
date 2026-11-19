# Getting started with Loom

Loom runs a team of coding agents from one local engine. The desktop app is the
full experience; the `loom` command reaches the same engine for the cases where a
terminal is the right tool, and both read the same authenticated team-control state.

This page covers the command line only. For the desktop flow, start the app and follow its
own screen.

## Check the engine

The CLI talks to a running engine over its local HTTP API. Read `loom --help` for the
three verbs that exist: `team`, `daemon` and `github`.

```sh
loom --version
loom daemon status
```

`loom daemon status` reports whether the engine is up and, when it is, where it
listens. If it is stopped, start it and check again:

```sh
loom daemon start
loom daemon status
```

Use `--port` when another local process owns the default port, and `--host` when the engine
must bind a specific address. Both are recorded in the daemon state the other verbs read, so
later commands find the engine without repeating them. While a start is in progress the CLI
holds a local reservation (`daemon-start.lock`); a second start fails instead of launching a
competing child.

Stop the engine with:

```sh
loom daemon stop
```

The stop budget is bounded and the command exits nonzero rather than claiming a clean
shutdown it could not verify. On Windows `SIGTERM` terminates the process outright, so the
engine reconciles interrupted work at its next start; the CLI says so instead of reporting a
graceful drain that did not run.

## Create a project and a team

`loom team create` registers a repository and the seats that work on it.

```sh
loom team create <path-to-repository>
```

By default this registers a local repository with three manual seats — a lead, a set of
implementers and a reviewer — each launched with `claude-code` or `codex`. Choose the
clients with `--lead`, `--implementers` and `--reviewer`; `claude` is shorthand for
`claude-code`.

With `--name`, the same verb creates a private GitHub project from the folder instead, using
only the lead's configured client. Preview that path before it touches GitHub:

```sh
loom team create <path-to-repository> --name <project-name> --dry-run
```

The preview names what would be uploaded and which paths are excluded. Nothing is created or
pushed until you repeat the command with `--yes`. If the folder already has a GitHub origin,
the same path registers it instead of creating a second repository.

GitHub itself must be signed in first:

```sh
loom github status
loom github sign-in
```

`github status` exits nonzero when no account is signed in, so it is safe to use as a check.
`github sign-in` prints a device code and URL; open the URL, enter the code, and wait for the
command to confirm the account it recorded.

## Start a run

`loom team start` turns a goal into a run and a task.

```sh
loom team start "<goal>" --repository <path-to-repository> --write <path>
```

Every flag has a default that reads from the created team, so a freshly registered project
usually needs only the goal and the repository:

| Option | Meaning |
| --- | --- |
| `--rig <id-or-name>` | the team to run the work on (default: the only active team) |
| `--seat <session>` | the seat that takes the task (default: the team's first agent node) |
| `--lead <session>` | a lead that first proposes the implementer tasks |
| `--reviewer <session>` | the seat every review round routes to |
| `--repository <path>` | the repository the plan and the work belong to |
| `--plan <path>` | the plan artifact, relative to the repository |
| `--write <path...>` | repository-relative paths the task may write |
| `--planning` | start a planning run: the lead agrees a plan before any work |
| `--workflow <entrypoint>` | run a selected workflow, directly or through the lead |
| `--read-only` | run the selected workflow without candidate or external writes |
| `--json` | print the engine's receipt as JSON |

The command prints the run and task ids and how to watch the run.

### Planning runs

With `--planning`, the run stops for review before delivery. Talk to the lead in the run's
chat, then approve the plan once:

```sh
loom team chat <run-id> "your message"
loom team chat <run-id>              # the conversation so far
loom team approve <run-id>
```

Approval reads the plan from the lead's own tree and refuses a missing one by name, so the
verb cannot approve an artifact the lead did not write. Once approved, the run starts
delivery.

## Read the result

A run's durable result is what the engine recorded, not what a worker's final message said.
Read the result and the diff before you merge:

```sh
loom team result <run-id>
loom team diff <run-id>
```

`team result` prints the finished task's result as JSON, including the patch and the file
manifest the candidate computed. `team diff` prints that patch alone. Both read the same
stored computation, and both need the task to be finished: a run that is still working
answers 409 and the CLI tells you to wait for the task, then retry.

For a run with more than one implementer task, name the one to read with `--task <id>`.

## Merge

`loom team merge` merges the run's integration branch into the repository the team
was created for.

```sh
loom team merge <run-id>
```

The command reports whether the merge fast-forwarded, made one commit, or was already up to
date, and names the branch and head it merged.

## The owner credential

Every `team` and `github` verb authenticates as the owner. The CLI reads
`LOOM_OWNER_TOKEN` from its environment, then the `owner.env` file in the
per-user configuration directory. A verb with no credential says so and exits nonzero
rather than sending an unauthenticated request.

The desktop app supplies its own credential to the engine it starts, so you only need to set
this when running the CLI against an engine you started separately.

## Where state lives

The engine keeps mutable state below one canonical home. On Windows that is
`%LOCALAPPDATA%\Loom`; on other platforms it is `~/.loom`. Configuration lives
beside it at `%APPDATA%\Loom` on Windows, and in the same home elsewhere.

`LOOM_HOME` overrides the state root for an isolated process — an integration test or
a temporary run. See [the instance layout](instance-layout.md) for what is created there.

## When something goes wrong

Start with the goal, the command that was run, the expected result, and the exact observed
error.

| Observation | Next action |
| --- | --- |
| `daemon status` reports the engine stopped | `loom daemon start`, then check again |
| A verb says it cannot connect | Confirm the engine is running on the address the state records; `daemon status` prints it |
| A verb reports the owner credential was refused | Check `LOOM_OWNER_TOKEN` or the `owner.env` file the engine was paired with |
| `github status` exits nonzero | No GitHub account is signed in; run `loom github sign-in` |
| A result read answers 409 | The task has not finished; wait and retry |
| A start is refused with the run named | The engine recorded a refusal; read the run in the desktop app for the seat's state |
| `--port` is rejected | Ports must be integers in `[0, 65535]` |

Remove credentials, private source and unrelated logs before sharing a report. The shipped
help guide at `help.md` covers the same ground with the support-request checklist.

## Permissions

Each seat launches under the permission posture its client was given. Loom does not
change a provider account's settings, and it does not sign in for you. If a seat is waiting
at a first-launch consent prompt, answer it in that seat, or choose a policy that accepts the
prompt for supported harnesses. The desktop app shows a seat's pending prompt in the run
view.