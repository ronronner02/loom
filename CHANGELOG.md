# Changelog

## Unreleased

This entry summarizes a repository cleanup. Nothing here changes how the app runs.

### Documentation

- The documentation set is now `README.md`, `docs/architecture.md`, `docs/development.md`,
  `docs/operations.md`, `docs/design.md` and this changelog. `docs/development.md` absorbs the old
  development standards, including the UI copy rule that other documents cite.
- `AGENTS.md` describes the current product and workspace instead of a retired plan, and `CLAUDE.md`
  is a pointer to it.
- The shipped reference set under `engine/docs/reference/` keeps the pages the CLI, agents and
  studies actually read, and drops the ones that described removed subsystems.
- Package READMEs (`engine/`, `desktop/`, `companions/loom/`) match the current product.

### Repository

- Historical material left the working tree and stays in git history: plans, task packs,
  acceptance evidence, design mockups and redesign folders, release notes, the as-built pages, and
  the retired community files under `engine/`.
- The contract tests that read tracked plan and task documents now read their own fixtures, so the
  checks still run but no longer depend on a historical file.
- `.gitignore` covers the host runtime folders and the local probe artifacts a checkout tends to
  accumulate.

## v0.1.0

First published release: the native Windows desktop app, the engine daemon, the Web UI, the
`loom` CLI and the optional companion bundle.