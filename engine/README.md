# Loom engine

The local engine for the Loom desktop and optional browser viewer. It runs
on native Windows 10/11 x64 and Linux with Node.js 22 or 24 and Git. The desktop
owns the engine process and connects over a dynamically assigned loopback port.

```sh
npm ci --no-audit --no-fund
npm run build
npm run lint
npm run smoke
```

The workspaces are `@loom/daemon`, `@loom/cli`, `@loom/ui`, and
`@loom/i18n`. The executable is `loom`; its commands are `daemon`,
`team`, and `github`. Run `node packages/cli/dist/index.js --help` after building.

Mutable state defaults to `%LOCALAPPDATA%\Loom` on Windows; configuration
uses `%APPDATA%\Loom`. Other platforms use `~/.loom` for both.
`LOOM_HOME` overrides both roots. A fresh engine creates `loom.sqlite`.
The desktop uses its own data root's `engine` subdirectory as the engine home.
An installation from the product's former name is moved into these roots on first
start; nothing is merged, and an existing Loom root always wins.

See the [project quick start](../README.md), [operations](../docs/operations.md), and
[desktop instructions](../desktop/README.md) for first run, dependency detection,
GitHub sign-in, browser pairing, cancellation, and recovery.

Copyright and license terms remain in [LICENSE](LICENSE); the historical import
record remains in [the upstream baseline](../docs/validation/upstream-baseline.md).
