<div align="center">
  <img src="engine/packages/ui/public/loom-icon.png" alt="Loom" width="88" height="88" />
  <h1>Loom</h1>
  <p>
    <strong>A local-first desktop app that runs a team of coding agents on your repository.</strong>
  </p>
  <p>
    <a href="#install">Install</a> •
    <a href="#first-run">First run</a> •
    <a href="#using-loom">Using Loom</a> •
    <a href="#the-optional-companion">Companion</a> •
    <a href="#development">Development</a>
  </p>
</div>

---

## What Loom is

Loom coordinates the coding assistants you already use — **Claude Code**, **Codex** and
**Gemini** — on a real repository. You describe a goal in chat, agree on a plan and a team with a
**lead** agent, approve it once, and Loom turns the plan into tasks that specialist agents pick
up in their own worktrees. Every task's candidate is reviewed independently before it lands on an
integration branch, and you merge that branch when you are ready.

It runs as a native Windows desktop app, with the engine as its own child process. There is no
separate server to run, no terminal to keep open, and no account beyond the ones your assistants
already use.

## Install

1. Download **`Loom-Setup-<version>-x64.exe`** from the
   [GitHub releases page](https://github.com/ronronner02/loom/releases).
2. Run the per-user installer. It needs no administrator elevation and installs for the current
   user only.
3. Ensure **Git for Windows** and **Node.js 22 or 24** are installed, and sign in locally to the
   assistants you plan to use (`claude`, `codex`, `gemini`). Loom launches the real executables
   that are already on your machine.
4. Launch **Loom**. The optional GitHub CLI is bundled, so GitHub sign-in needs no separate
   install.

The installer is unsigned, so Windows may show a SmartScreen warning on first run. Verify the
release source and published checksum before running an installer.

**Where data lives.** Application state is in `%LOCALAPPDATA%\Loom` (SQLite database
`loom.sqlite`), configuration in `%APPDATA%\Loom`. `LOOM_HOME` overrides both, and
`LOOM_DESKTOP_DATA_DIR` overrides the desktop's root. See
[`docs/operations.md`](docs/operations.md) for the full layout.

## First run

The workspace opens directly when every tool is present. Setup appears only when one is missing,
and **Settings → Setup** reopens it; it is also where the proxy lives, because a network that
blocks GitHub blocks sign-in itself.

- **Tools** — Git, GitHub CLI, Claude Code, Codex and Gemini each show as found (with the
  resolved path) or missing (with the one install line that fixes it).
- **Agent sign-in** — whether an installed client already has a signed-in account.
- **Proxy** — one value that covers GitHub operations and every agent CLI; empty means no proxy.

Create your first project — sign in to GitHub when asked, in the dialog itself: select a folder,
review the files that would be uploaded, and confirm. A new folder becomes a
private GitHub repository with its initial commit pushed. An existing `origin` is registered
without a push or a visibility change.

## Using Loom

1. **Chat with the lead.** Describe the goal, or choose **New work** for another run in the same
   project. The lead drafts a plan, asks questions, and proposes the specialist roster.
2. **Approve once.** **Approve plan** binds the plan's exact contents and the roster. After that,
   the lead admits tasks and agents work without asking you about each one.
3. **Watch the work.** **Overview** shows progress, integration history, the Flow replay, Merge
   and token analytics. **Tasks** has a searchable list, the dependency Board, and every attempt
   with its reports and diff. **Workspace** shows live seat activity, the project Inbox (GitHub
   Issues) and Reviews & Diffs. **Documents** holds the versioned Exploration, Requirements and
   Plan.
4. **Answer escalations.** The lead asks in chat when a decision is outside the approved scope.
   A blocked run offers **Resume**; a budget block shows the increase before you confirm it.
5. **Merge.** Inspect the task diffs and the integration commits, then **Merge**. This updates
   your clean, currently checked-out local branch; it does not push.

Workers are direct child processes with one Git worktree per task. That separates tasks; it is
not an operating-system sandbox, and [`docs/operations.md`](docs/operations.md) says exactly what
is and is not enforced. An API is available for scripts and diagnostics through the `loom`
executable (`team`, `daemon`, `github`), but the desktop window is the primary surface.

## The optional companion

`Loom-Companion-<version>.zip` is a separate, self-hosted bundle: a task scheduler, a Windows
runner and phone reply pages. It is optional. Installing or starting the desktop does not connect
to a companion or configure a server, and the two do not currently share tasks.

Each user supplies their own HTTPS host, credentials and notification channel. See
[the companion README](companions/loom/README.md) and
[its integration boundary](companions/loom/INTEGRATION.md).

## Development

Prerequisites: Windows 10/11 x64 (or Linux), Node.js 22 or 24, Git, and at least one signed-in
assistant for a live run.

```powershell
cd engine
npm ci --ignore-scripts --no-audit --no-fund
npm run build

cd ../desktop
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

The desktop starts the engine on an ephemeral loopback port, pairs the window through a one-time
code over a private channel, and loads the daemon's own UI.

| Task | Command |
| --- | --- |
| Repository guards | `cd engine && npm run test:repo` |
| Typecheck | `cd engine && npm run lint` |
| Focused suite | `cd engine && npm run smoke` |
| Desktop tests | `cd desktop && npm test` |
| Windows installer | `cd desktop && npm run dist` |

[`docs/development.md`](docs/development.md) has the test matrix, the CI jobs, the Windows
specifics, the code standards and the release ceremony.

## Documentation

- [Architecture](docs/architecture.md) — processes, packages, storage, the run lifecycle and the
  security boundaries that exist
- [Development](docs/development.md) — build, test, standards, release
- [Operations](docs/operations.md) — data, first run, projects, delivery, recovery, the companion
- [Design system](docs/design.md) — tokens, type, spacing, layout
- [Agent execution rules](AGENTS.md) — how agents work in this repository

## License

See [LICENSE](engine/LICENSE) and [NOTICE](NOTICE).