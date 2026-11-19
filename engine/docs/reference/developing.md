# Developing Loom — gates and lanes

This is the contributor-facing statement of which checks block a change and which are
advisory. Every pull request runs the `smoke` workflow on a clean GitHub runner: engine
install, build, the repository guards (`npm run test:repo`), typecheck (`npm run lint`), the
desktop boundary tests, and the smoke suite (`npm run smoke`). The root `package.json`
scripts run the same checks locally.

**In a fresh clone or worktree, run `npm ci`, then `npm run build`,** before any of the
checks below (see [worktree builds](worktree-builds.md)).

## Blocking gates (must pass before a candidate moves)

| Gate | Command | Covers |
|---|---|---|
| Typecheck | `npm run lint` | daemon, ui, cli and i18n tsconfigs |
| Build | `npm run build` | all workspaces — the UI dist ships in the package |
| Repo scripts | `npm run test:repo` | daemon build, script self-tests, first-run reference check, docs guard, skill mirror check |
| Unit tests | `npm run test:workspaces` | `packages/i18n`, `packages/daemon` and `packages/cli` |
| UI unit tests | `npm run test:ui` | `packages/ui` vitest. NOT part of `npm test` |
| Smoke | `npm run smoke` | the team-control surface plus its clients |

`npm test` runs `test:repo` and `test:workspaces`; `npm run test:ui` is the separate UI
suite. Both sets are readable in the root `package.json` scripts. A change that moves a
contract the UI reads has to update the affected UI test or client as well.

## Advisory lane

No advisory lanes are configured; every gate above blocks.

## Wording rule

The desktop app is the primary surface. The browser UI is supported best-effort; do not
describe it with stronger end-of-life language than this section uses.