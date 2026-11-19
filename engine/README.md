# Loom engine

The orchestration engine inside the Loom desktop app, and the same engine when it runs on its
own under Linux. It serves the Web UI, keeps the run state in SQLite, and launches the agent CLIs
as its child processes.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run lint
npm run test:repo
npm run smoke
```

The workspaces are `@loom/daemon`, `@loom/cli`, `@loom/ui` and `@loom/i18n`. The executable is
`loom`; its commands are `team`, `daemon` and `github`. Run `node packages/cli/dist/index.js
--help` after building.

Mutable state defaults to `%LOCALAPPDATA%\Loom` on Windows; configuration uses `%APPDATA%\Loom`.
Other platforms use `~/.loom` for both, and `LOOM_HOME` overrides the state root. A fresh engine
creates `loom.sqlite`. The desktop gives the engine its own data root's `engine` subdirectory as
the engine home, so the window and a manual daemon never share a database by accident.

See the project README for the quick start, `docs/architecture.md` for the system map,
`docs/development.md` for the build and test commands, and `docs/operations.md` for running it.
Those live in the repository, not in this package; this file is copied verbatim into the
`@loom/cli` tarball, so it carries no relative link that would break there.

Copyright and license terms are in [LICENSE](LICENSE).