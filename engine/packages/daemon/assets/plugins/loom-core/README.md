# loom-core

Core Loom skills and hooks for native team coordination and worker activity tracking.

## What this plugin ships

**Skills (7):** the agent-operated workflow, delegation, permission, owner communication, and completion skills used by native team workers.

**Hooks:** activity tracking and Claude compaction continuity for workers that use the retained runtime hooks.

## Runtimes

This plugin ships dual manifests for Claude Code and Codex. The daemon vendors the bundled copy into the configured Loom home when a worker run needs it.

## Distribution

The npm package includes the offline baseline under the daemon's `assets/plugins/loom-core/` directory. Local projection preserves an equal or newer installed copy and advances only an older manifest version.

## License

Apache License 2.0. See `LICENSE`.

## Source

- Plugin repo: https://github.com/mvschwarz/loom-plugins
- Loom CLI: https://github.com/mvschwarz/loom
