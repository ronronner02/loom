# Development

## Source Authority

Since the cutover on 2026-10-13 (KTD7), the WSL checkout at `/home/leo/src/loom` is the only development source. All engine and active-document edits, builds and tests happen there.

The earlier Windows workspace (`D:\Loom`) is preserved as-is for reference. It is not a second writable source:

- Edit through WSL, for example an editor's WSL integration or `\\wsl.localhost\Ubuntu\home\leo\src\loom`.
- Windows edits are conflicts, not sync input.
- To refresh the Windows copy, run the one-way export below.

The cutover record lives outside the repository at `~/.local/state/loom/cutover/`:

- `cutover.json` records the bootstrap commit `98d4feb`, its tree, and the 19 tracked files verified on both sides.
- `windows-manifest.json` holds byte hashes of all 1,600 Windows workspace files at cutover.

Not transferred: the untracked host runtime mirrors (`.agents/`, `.claude/`, `.codex/`, `.opencode/`, `.pi/`). To run the spec-first workflows from inside WSL, re-initialize them there.

## Review Requirements

Use `gpt-6.1-sol` and `claude-opus-5-5` for separate, report-only reviews of each logical change. Call the gateway URLs and API credentials configured locally on the owner's machine; never embed credentials in prompts, repository files, command arguments or review logs. Do not substitute models when quota or access is unavailable.

Both reviewers inspect the same frozen candidate, relevant plan sections, tests and verification evidence. Record the requested and returned model identifiers, candidate digest, findings and any coverage limitations. Allow at most two review rounds per logical change: the initial review and one follow-up after corrections. A missing review, a blocking finding or a changed candidate leaves the review gate open.

Dependency and lockfile changes remain separately scoped to T005. T003 may add the shared contract export but does not add or upgrade dependencies. UI/TUI design work at T015-T016 and T019-T022 waits for the owner's review of a design proposal.

Local implementation, review, commit, push, PR creation and merge are separate actions. Without explicit delivery authorization, keep verified changes uncommitted.

## Toolchain

| Tool | Version | Source |
| --- | --- | --- |
| Node.js / npm | v24.21.0 / 11.19.0 | on PATH |
| C/C++ build | gcc/g++ 15.2.0, GNU Make 4.4.1, python3 | `apt install build-essential` (node-gyp for `better-sqlite3`) |
| SQLite (bundled by `better-sqlite3` 13.0.3) | 3.53.4, Node ABI 137 | `engine/node_modules` |
| Git | Linux git; credentials through Git Credential Manager for Windows (repo-local `credential.helper`) | |


## Engine Commands

Run these from `engine/`. They are the retained upstream baseline (see `docs/validation/upstream-baseline.md`).

| Command | Purpose |
| --- | --- |
| `npm ci` | Clean install. Runs only the approved install scripts (`allowScripts`). |
| `npm run build` | Build every workspace (daemon, ui, cli). |
| `npm run lint` | Type-check every workspace (`tsc --noEmit`). |
| `npm test` | Repository checks (`scripts/*.test.mjs`, docs/skill mirrors, context packs), then daemon/cli Vitest. |
| `npm run test:ui` | Web UI Vitest. |
| `node packages/cli/scripts/check-abi.mjs` | Native SQLite addon/ABI check. |

### Baseline Result (2026-10-13)

The following ran on Ubuntu 26.04.1 / WSL2 6.18.33.2 with Node v24.21.0 / npm 11.19.0, at upstream `cb79b8c` plus the declared adaptations:

| Command | Result |
| --- | --- |
| `npm ci` | Exit 0; 436 packages; approved install scripts ran (better-sqlite3, esbuild ×2) |
| `node packages/cli/scripts/check-abi.mjs` | Exit 0 (SQLite 3.53.4, ABI 137) |
| `npm run build` | Exit 0 (24 s) |
| `npm run lint` | Exit 0 (20 s) |
| `npm test` | **Exit 1 (260 s).** Repository checks: 290 passed, 0 failed. daemon: 15,055 passed, **4 failed**, 5 skipped, 5 todo. cli: 4,238 passed, **2 failed**, 5 skipped. (Recorded before the terminal UI was retired; its 931 tests are no longer part of this run.) |
| `npm run test:ui` | Exit 0; 1,739 passed, 1 skipped (26 s) |

**Known pre-existing failures.** Six upstream tests fail on this host. Each fails identically with the adaptations removed (pristine `cb79b8c`), so this milestone did not introduce them. They are a recorded limitation, not passes.

| Package / test | Observed | Likely cause | Owner |
| --- | --- | --- | --- |
| daemon `auth-bearer-token.test.ts › resolveToIpOrNull … intentionally-unresolvable hostname` | Resolves to `198.18.0.36` | Host DNS answers every name (even `*.invalid` returns `2001:2::50`): a fake-IP proxy/TUN resolver | T004 (owns this middleware) |
| daemon `tmux-pane-cwd-native.test.ts › preserves pipe characters in pane cwd` | Pane fields do not match the expected object | Native tmux 3.6 behavior | U4 / T008 (tmux adapter) |
| daemon `terminal-pipe-utf8.test.ts › preserves native terminal UTF-8 output…` | `native output timed out` | Native tmux pipe timing on WSL | U4 / T008 |
| daemon `seat-activity-retirement-hooks.test.ts › adopted … successor's first permission hook` | `tmux -S /tmp/… new-session` failed | Native tmux session start in the test fixture | U4 / T008 |
| cli `start.test.ts › S20 … env-sourced LOOM_HOST through loom start creates NO bind intent` | Auto-start never reaches its mocked spawn | Not diagnosed. The real `SystemPreflight` is ready outside Vitest, so the cause is inside the hermetic fixture. | U9 (bind / loopback surfaces) |
| cli `up.test.ts › … S20: env-sourced LOOM_HOST creates NO bind intent through up auto-start` | Expected port `7472`, got `undefined` | Same S20 auto-start path | U9 |

The owning unit must diagnose its tests before changing that area, and must not count them as passing.
