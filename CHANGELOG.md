# Changelog

## 0.2.0 — 2026-11-19

A large release. Most of it is cleanup the owner will not see, but several things change what the
app does on first start, which agents it can run, and how it looks.

The installer is unsigned, so Windows SmartScreen will warn on first run.

### Your data carries over automatically

An existing installation is moved from the old `%LOCALAPPDATA%\Multi-Agent` folder into
`%LOCALAPPDATA%\Loom` on the first start of this version, settings and projects with it. The move
is one rename, so it either completes or changes nothing; a start that could not finish stops with
an error naming both folders instead of opening half-moved data. Paths stored in the database that
pointed into the old folder are rewritten so worktrees and repositories keep resolving.

If both folders exist, the new one wins and the old one is left untouched. A location you chose
yourself with an explicit data-folder setting is never moved.

### First-run setup

A new user can now configure the app before signing in to GitHub. The setup screen picks a
language, sets a network proxy that then applies to both GitHub and the agent CLIs, detects the
installed agent CLIs (Claude Code, Codex, Gemini), and shows whether each is signed in. Previously
every setting sat behind a GitHub sign-in that a user behind a proxy could not reach.

### Gemini as a third agent client

A lead, implementer or reviewer can now run on the installed Gemini CLI beside Claude Code and
Codex, through the same turn, continuation, telemetry and completion paths. Nothing is launched as
a service and no client configuration is written.

### Animated vendor characters

The Flow view's 35 still character images are replaced by animated transparent clips, one set per
vendor and state.

### Other fixes worth naming

- A closed pull request no longer ends delivery for the run: later commits are pushed and a new
  pull request is opened.
- Quitting no longer warns "Agents may be running" when none are.
- A completed large companion result no longer blocks every later job (see the companion bundle
  below).
- A resumed attempt finalization, reviewer read-only enforcement, and pull request delivery gated
  on current readiness are corrected.
- The project browser can browse project files and attach them to a chat.
- Stream failures, resume, and composer readiness are now visible in the UI.
- Planning runs that stall or lose their directory are retried, and the stranded chats are closed.
- The Windows entry guards, the CI matrix, and the build identity stamp now do what they claim. The
  installed app reports its version and commit on its health endpoint.

### Repository

Nothing here changes how the app runs.

- The product is Loom everywhere: package scope, the CLI binary, environment variables and the
  data folder.
- The Linux hardened-isolation path is gone. Agents always run as direct child processes under the
  daemon's own user.
- Unreachable daemon subsystems are deleted: the launch-era code, the classifier and inbox, the
  watchdog and wake runtime, the context packs and the legacy-only mode. Their tables are dropped
  from the schema.
- The UI shell is split into smaller owners and the Flow renderer keeps its remaining behavior.
- The daemon's core has one composition root instead of two.
- The test suites are green on both Windows and Linux and run in CI on both.
- The documentation set is now `README.md`, `docs/architecture.md`, `docs/development.md`,
  `docs/operations.md`, `docs/design.md` and this changelog. Historical material stays in git
  history.

### Optional companion bundle

The companion ships as a separate source ZIP that you host yourself; the desktop stays local-only.
It is not installed or enabled automatically.

- The ZIP contains only the 41 allowlisted public source files. Private setup, provider
  credentials, account pairing, databases, logs and deployment payloads are never included, and a
  linked or missing input is rejected at package time.
- A runner whose completion output expands past the server's request limit no longer stalls the
  queue behind it: authenticated completion uploads now admit 512,000 bytes while other requests
  keep their original limit.
- Server secrets stay private while the Docker build inputs remain readable by the non-root
  service.

## v0.1.0

First published release: the native Windows desktop app, the engine daemon, the Web UI, the
`loom` CLI and the optional companion bundle.