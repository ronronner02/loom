# Development

How to build Loom, what blocks a change, and the standards the code follows. Architecture and the
run lifecycle are in [`docs/architecture.md`](architecture.md).

## 1. Prerequisites

- **Node.js 22 or 24** and npm. `engine/package.json` records the range; a 20 or 26 will not build.
- **Git** on `PATH`, with `git worktree` available.
- At least one of **Claude Code** (`claude`), **Codex** (`codex`) or **Gemini** (`gemini`), signed
  in locally, to exercise a team. The unit tests do not need any of them.
- **GitHub CLI** (`gh`) for GitHub sign-in; the Windows installer ships its own copy.

## 2. Install and build

```sh
cd engine
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

`better-sqlite3` ships a prebuilt binary for every supported platform, so the native rebuild its
install script would run is unnecessary. `--ignore-scripts` also skips the CLI's ABI probe; it has
its own test.

`npm run build` compiles the workspaces in dependency order (i18n before the daemon that imports
it) and builds the UI bundle. A change that only touches one package still needs the full build
once, because the CLI and the desktop both resolve `@loom/daemon` through package exports that
point at `dist`.

## 3. Test commands and the CI that runs them

| Command (in `engine/`) | Runs | CI job |
| --- | --- | --- |
| `npm run test:repo` | The repository guards and script self-tests, the shipped-doc reference check, the docs guard and the skill mirror check | `smoke.yml` on Linux and Windows, `tests.yml` `suites` |
| `npm run lint` | `tsc --noEmit` for daemon, ui, cli and i18n | `smoke.yml` `smoke` |
| `npm run smoke` | The focused suite: the team-control surface and its clients | `smoke.yml` `smoke` |
| `npm run test:workspaces` | The daemon, CLI and i18n Vitest suites | `tests.yml` |
| `npm run test:ui` | The UI Vitest suite (not part of `npm test`) | `tests.yml` `suites` |
| `npm test` | `test:repo` then `test:workspaces` | — |
| `cd desktop && npm test` | The desktop boundary, lifecycle, pairing and staged-tree tests | `smoke.yml` `desktop` |

`.github/workflows/smoke.yml` runs on every pull request: the companion suite, the guards, the
typecheck, the desktop tests, the smoke set, and a Windows job that stages the installer tree.
`.github/workflows/tests.yml` is the full suite, sharded — three daemon shards on Linux and eight
on Windows, plus the CLI, UI, i18n and guard suites on both hosts. Windows runs the git-heavy
daemon files slowly enough that a smaller shard count puts two in one job and trips Vitest's
worker reporting deadline; that is why the two hosts use different shard counts.

For a focused run inside a package:

```sh
cd engine/packages/daemon
npx vitest run test/team-assignment.test.ts --maxWorkers=2
```

Run one Vitest process at a time. Several suites spawn real child processes and bind sockets, so
two concurrent runs contend for the same ports and fixture directories.

## 4. Windows specifics

- **Install with `--ignore-scripts`.** Without it, `better-sqlite3`'s install script tries to
  rebuild a native addon and needs a compiler the machine may not have.
- **Line endings.** `.gitattributes` sets `* text=auto eol=lf`, so every text file is stored and
  checked out with LF on every host. Several files are compared byte-for-byte — the skill tree
  against a digest, the policy files against an authority hash, the shipped README against the
  packaged copy — and a CRLF checkout would silently change those measurements.
- **Symlinks.** A non-elevated Windows process cannot create a symbolic link without Developer
  Mode or the create-symlink privilege. Tests that need one check for that and skip with a reason
  (`engine/packages/daemon/test/helpers/symlink.ts`) instead of failing.
- **Long paths in worktrees.** Git for Windows refuses a worktree path longer than 215
  characters, and `core.longpaths=true` does not lift the ceiling. `domain/worktree-policy.ts`
  enforces it; a test that creates a worktree under a very long temp directory will hit it.
- **No console windows.** A child process started without `windowsHide` flashes a console. Every
  daemon `spawn`/`execFile` sets it, and the desktop forks the engine through Electron's own
  `utilityProcess`, which has no console window.

## 5. Standards

These come from what slowed the project down, not from an external style guide. Other documents
cite them by number.

### 1. Walking skeleton first
Before any hardening, build the thinnest path that lets a user do the core job end to end. A slice
that is secure but unreachable is not progress.

### 2. The default path needs no privileges
The product runs on a clean machine without sudo, extra users or host provisioning. A component
that needs one is out of scope, not a setting to add.

### 3. Portable by default
No user- or machine-specific paths, hosts, proxies or credentials in code, scripts or CI. Use
per-user config and state directories and environment variables. One setup script and a short
quick start must be enough for a new developer. Declare supported platforms explicitly.

### 4. Cheap checks, often
Every change runs the focused tests for the code it touched plus the package's typecheck. Every
pull request runs the smoke set in CI. The full suite runs before a release, or when the owner
asks; a suite nobody can run per task gets skipped.

### 5. Stop rules beat persistence
Stop and re-plan when a slice grows past twice its estimate, when the same fix fails twice, or
when an investigation runs 30 minutes with no measured lead.

### 6. Review in proportion to risk
One reviewer reads the diff and runs the demo. A second, independent reviewer is reserved for code
that guards credentials or reads worker-written data. A finding that only asks for more hardening,
with no reachable scenario, is recorded as a residual and not implemented.

### 7. Workspace hygiene
One worktree and one scratch folder per task, both removed when the task lands. No probe scripts or
logs in the repository.

### 8. Decide and record
Decide a question the rules or the slice settle, and record the reason in the pull request. Ask the
owner only about scope, public contracts, architecture or a missing grant, in one batch.

### 9. UI: let the structure explain
- Leave out unnecessary secondary labels, captions, helper copy, descriptive text and redundant
  microcopy. Layout, visual hierarchy, spacing and a clear primary action do the explaining.
- Prefer strong visual hierarchy and self-explanatory structure over text. By default add no
  slogan-style text, no tutorial paragraphs, and no help text under every section. When extra
  information is truly needed, use an info icon with a tooltip, not always-visible secondary text.
- Keep the form labels and accessible names the interface needs. A cleaner screen must not cost
  accessibility.
- Dangerous or irreversible actions (delete, submit a permanent change) keep a clear statement of
  the consequence.
- With the copy removed, a first-time user must still see where to click next and what it will do.
- When rewriting an existing screen, remove redundant labels and descriptions first. If clarity
  drops, improve the layout and the button wording instead of putting the text back.

**Comments** explain non-obvious intent only. No task or decision IDs in new code.

## 6. Working in a worktree

A worktree created from `origin/main` gets its own `node_modules` only after `npm ci` inside it.
Do not symlink another checkout's `node_modules`: a per-worktree install links `@loom/*` to the
packages beside it, and a borrowed link makes a build or a typecheck silently read another tree's
source. The failure it produces is a green build that typechecks the wrong files, which is worse
than the install it saves.

Scratch files, logs and review packets go in one folder per task outside the checkout, and are
removed when the task lands.

## 7. Releases

The desktop version lives in `desktop/package.json`; the engine workspace versions are `0.1.0` and
do not move independently. A release is a manual ceremony:

1. Bump `desktop/package.json` and record the change in `CHANGELOG.md` in user-facing language:
   group related fixes, name anything that changes setup, permissions, startup, restore or
   recovery, and say so when verification was limited.
2. `cd engine && npm ci --ignore-scripts && npm run build`, then `cd ../desktop && npm ci
   --ignore-scripts && npm run dist`. `npm run dist` stages the daemon tree and the pinned
   `gh.exe` into `desktop/resources/`, then writes `desktop/dist/Loom-Setup-<version>-x64.exe`.
3. Run the full suites (`tests.yml` locally, or let CI run them on the release commit), the
   installer smoke (an installed artifact, run once), and the **substance gate** at the exact cut:

   ```bash
   bash scripts/build-package.sh
   npm run gate:substance -- \
     --review /path/to/substance-review.json \
     --receipt /path/to/substance-receipt.json \
     --judge <seat-or-person> \
     --cut-sha "$(git rev-parse HEAD)"
   ```

   The gate derives every file under the shipped pack sources, requires a hash-bound human
   judgment and an individual disposition for each mechanical candidate, scans the complete npm
   artifact set the packager derived, and writes the durable receipt. The receipt records both the
   artifact and the scanned file lists, and their difference must be empty. The review JSON
   carries one entry per file:

   ```json
   {
     "surfaces": [{
       "path": "packages/daemon/assets/guidance/example.md",
       "sha256": "<sha256 of the reviewed bytes>",
       "verdict": "ship",
       "reason": "Generic product guidance.",
       "candidateDispositions": []
     }]
   }
   ```

   A non-shipping verdict is one of `instance-fact`, `internal-path`, `position-knowledge` or
   `lore-class`, and carries its reason in the same entry. A missing or stale judgment, an
   undispositioned candidate, internal substance, a lore-classed pack, a failed full artifact
   scan, or any artifact absent from the scanned set refuses the cut. Run the gate from the same
   clean worktree the cut SHA names — it refuses a dirty tree, because a dirty receipt cannot bind
   the artifact bytes to the commit.
4. Tag the commit and create the GitHub release with the same notes:
   `gh release create vX.Y.Z --title "Loom vX.Y.Z" --notes-file <notes>`.
5. Attach the installer and, when the release includes it, the companion bundle
   (`companions/loom/scripts/package_release.py`) to that release.

Tag, installer build and publication each need their own authorization; `npm run dist` on its own
only writes a local artifact.

## 8. Documentation

- **Durable developer docs** live in `docs/` (this file, `architecture.md`, `operations.md`) and at
  the repository root (`README.md`, `AGENTS.md`, `CHANGELOG.md`, `NOTICE`).
- **Shipped product docs** live in `engine/docs/reference/`; the package build stages them and
  agents read them. `engine/scripts/check-docs-guard.mjs` refuses any other tracked file under
  `engine/docs/`.
- **History** — plans, task packs, acceptance evidence, design mockups — stays in git history and
  in the pull request that produced it. The working tree does not carry it.
- Any Markdown link you add must resolve. The docs guard checks shipped-doc references; a link to
  a deleted path is a broken page.