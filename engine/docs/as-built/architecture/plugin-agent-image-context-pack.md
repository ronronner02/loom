---
kind: as-built
title: Content Layer — Plugins, Agent Images, Context Packs, Compaction Policy
status: active
topics: [extension-and-user-workspace, continuity, skill-management]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Locate plugin discovery and vendoring, context-pack addressing/composition,
  agent-image capture/fork/protection, or Claude guided-compaction behavior.
siblings: [packaging-bootstrap-bundles.md, agent-spec-and-startup.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Content libraries and compaction

This module describes source at main commit
`e8f0ab340db773392ec8be75b072d1c0f3068a50`. Source paths below are repository-relative.
Context packs, plugins and agent images have filesystem-backed content and daemon-side
discovery. Their consumers can read database identity, mutate files, deliver messages or
launch sessions; the whole layer is not a read-only catalog.

## Context packs

The daemon serves no context-pack surface. `startup.ts` neither configures pack roots nor
mounts `contextPacksRoutes()`, the library service, the bundle assembler and the situation
profile composer are gone, and the thin CLI has no `context` command. What remains in
`packages/daemon/src/domain/context-packs/` is the manifest parser and the read-only pieces
it needs: `manifest-parser.ts` (manifest shape, atom metadata, named profiles, supported
file suffixes and their ref-safety rules), `context-pack-types.ts`, `ref-safety.ts`,
`profile-source-resolver.ts`, `profile-composer.ts` and `seat-recap-store.ts`.

Those remaining modules are reached only by the packaging script, not by the running
daemon. `engine/scripts/generate-context-packs.mjs` imports the compiled
`manifest-parser.ts` from `dist` to validate the packs it generates under
`packages/daemon/context-packs-src/`; it does not use the composer, the resolver or the
recap store, which stay only because the parser's tests and the profile tests use them.

The shipped pack data remains: `context-packs-src/` holds the authored packs and the build
script mirrors `specs/agents` skills into pack form. No daemon code reads those packs.

## Agent images and forks

`packages/daemon/src/domain/agent-images/agent-image-library-service.ts` implements
`AgentImageLibraryService`. Startup registers the OpenRig `agent-images` root and,
when present, the workspace-local `.openrig/agent-images` root. Entries are keyed by
`agent-image:<name>:<version>`, with later discovery roots replacing identical IDs.
Content is a manifest plus optional files; `stats.json` holds usage data and `.pinned`
marks protection from ordinary deletion/pruning.

Capture and consumption depend on live identity as well as library files:

- `packages/daemon/src/domain/agent-images/resume-token-discovery.ts`: removed. The
  module was imported by nothing; a seat's native resume token comes from the
  launch's own `managed.attempt.receipt`.
- `packages/daemon/src/domain/agent-images/snapshot-capturer.ts`:
  `SnapshotCapturer.capture()` refuses unsupported or missing native identity, writes
  an image manifest/files and rescans. It records the source working directory when known.
- `packages/daemon/src/routes/agent-images.ts`:
  `POST /fork` composes native identity discovery with an add-member operation. The
  default path makes no image. The keep-image path captures and pins one before launch,
  and reports that retained image even if launch fails.

Library/snapshot responses redact `sourceResumeToken`; the fork composer builds its
native-ID session source inside the daemon rather than returning that field to the caller.
This describes these response projections, not secrecy of every field in an image manifest.

`recordConsumption()` accepts a separate fork-count flag: consumption intent can update
last-use time without incrementing successful forks. Inspect the instantiation caller as
well as library statistics when assessing whether a launch succeeded.

`packages/daemon/src/domain/agent-images/evidence-guard.ts` implements
`evaluateProtection()`: pins, parsed spec references and descendants of protected images
contribute protection reasons. The route applies the guard to deletion/pruning unless
`force` is explicit. Prune defaults to dry-run. Its protection view depends on the supplied
spec roots; it is not an inventory of every reference anywhere on the host.

The guard keys its result by image name, not version: every version of one name gets the
status computed for the last-listed version, carrying that version's image ID. The delete
route looks up by image ID, so on delete only that last-listed version of a name is matched,
and its other versions are deleted without `force` even when pinned. `rig agent-image prune`
sends a dry run unless `--force` is given, and `--force` also overrides the guard, so a
guarded real prune is reachable only through the HTTP route.

The routes mount at `/api/agent-images` and expose list/sync, snapshot/fork,
entry/preview, pin/unpin, delete and prune.
`packages/cli/src/commands/agent-image.ts` owns the image library commands. The top-level
`rig fork` verb (`packages/cli/src/commands/fork.ts`) drives `POST /fork`; `--keep-image`
also captures a pinned image. Forking a Claude Code seat needs Claude Code 2.0.73 or later,
because the fork is launched with its own `--session-id`.

## Plugins

### Discovery and inspection

`packages/daemon/src/domain/plugin-discovery-service.ts` discovers plugins from:

| Source kind | Directory shape |
|---|---|
| `vendored` | OpenRig plugins root, one plugin directory per entry. |
| `claude-cache` | Claude cache, grouped by marketplace/plugin/version. |
| `codex-cache` | Codex cache, grouped by marketplace/plugin/version. |
| `rig-cwd` | `.claude/plugins` and `.codex/plugins` beneath supplied working-directory roots. |

Detection uses the Claude/Codex plugin manifests. `listPlugins()` returns runtime/source
metadata; `getPlugin()` adds manifests, skills, hooks and MCP detail.
`findUsedBy()` scans agent YAML in configured spec-library roots for plugin declarations
and profile references. These references describe authored specs, not proof of a running
harness loading a plugin.

The service constructor is not read-only: it retires obsolete refocus hook registrations
from the older bundled plugin and rejects duplicate vendored hook registrations across
providers. Cached plugin versions are excluded from that duplicate-provider check. Startup
constructs the service while building the daemon's dependencies and doesn't catch that
rejection, so a duplicate vendored hook stops daemon creation.

`packages/daemon/src/routes/plugins.ts` exposes GET-only inspection at `/api/plugins`:
list, detail, used-by and file list/read. The file routes use the discovered plugin root as
their path allowlist. `?cwd=` supplies rig-cwd discovery roots.
At this pin, the route's source filter accepts vendored, Claude-cache and Codex-cache only;
`source=rig-cwd` is not applied as a filter, even though the service supports that kind.

### Vendoring and projection

`packages/daemon/src/domain/plugin-vendor-service.ts` owns `PluginVendorService`.
`ensureVendored()` seeds absent plugins or advances an older numeric manifest version.
Equal/newer installed versions preserve installed bytes; equal versions can reconcile file
modes on byte-identical files. Missing target version authority is preserved rather than
overwritten; invalid or conflicting manifest versions are errors. Advancing a version writes
changed files but never deletes files the new version dropped.

`ensureSkillGlobally()` projects a named plugin skill using a vendor-version marker.
An existing unversioned global skill remains externally owned. Startup wires this service
and its filesystem implementation; inspect that wiring when changing projection roots. At
startup only `openrig-core` is vendored, and its `openrig-skills` and `refocusing` skills are
projected globally into `~/.claude/skills` and `~/.agents/skills`
(`packages/daemon/src/startup.ts:877–886`). The packaged `rigs` skill
(`packages/daemon/assets/skills/rigs`) is not a plugin skill: `ensureSkillDirGlobally()`
projects it into the same roots under the daemon version, so each upgrade refreshes it
(`startup.ts:891–899`). A failed global projection is logged and does not stop startup.

`ensureLatest()` performs local vendoring before `attemptAutoFetch()`. The latter
requests a release asset with a bounded timeout and logs failures; even its successful
response path does not extract/install the fetched archive at this pin. This does not
establish whether an upstream release asset currently exists.

`packages/cli/src/commands/plugin.ts` implements `rig plugin
list|show|used-by|validate`. Discovery, vendoring and a runtime's projected plugin tree
are distinct steps; see [agent-spec-and-startup.md](agent-spec-and-startup.md) for launch.

## Claude guided compaction

`packages/daemon/src/domain/claude-compaction-enforcer.ts` implements
`ClaudeCompactionEnforcer`. Startup shares one instance between `ContextMonitor`
and the manual-compaction route consumers.
`packages/daemon/src/domain/user-settings/settings-store.ts` resolves the
`policies.claude_compaction.*` settings; automatic compaction defaults to disabled.

`maybeAutoCompact()` applies the delivery guard when one exists and the runtime is Claude
Code. Its implementation requires Claude Code, observed usage and a valid integer threshold
(default 80). Above-threshold automatic work additionally checks enablement, the
post-restore cooldown (10 minutes), the deduplication window (60 seconds) and the
already-triggered latch; an active manual attempt also blocks it.

`/compact` is held behind a preparation attempt:

1. The first above-threshold tick starts an attempt with its own ID, the seat's occupant
   generation, a restore-map path and a completion marker, then sends only the prep prompt.
   An unknown occupant generation stops the attempt at once.
2. The agent writes `RESTORE-MAP.md.tmp` with its file-edit tool, completion marker last.
   Later ticks return `preparation_pending` until that exact map is complete. The map path is under the seat's working directory
   (`.openrig/compaction/preparation/<session>/<attempt>/`, with a `.gitignore` of `*`) when
   that is writable, otherwise under `compaction/preparation/` in the OpenRig home.
3. The daemon atomically renames the completed temp file to `RESTORE-MAP.md` in its existing
   final send checks, after rechecking the attempt and occupant. An already-complete final map
   remains compatible. Only then is `/compact` sent, with the final map path appended to the
   compact instruction. Publication failure cannot authorize `/compact`.
4. The continuation then runs below the threshold: turn boundary, restore prompt, then a
   read-depth audit prompt (each item marked `FULL`, `PARTIAL` or `NOT_READ`), one stage per
   poll tick. A seat refreshes its usage sample only when it takes a turn, so when the sample is
   stale, unknown or has no percentage and a stage is pending, the monitor drains that stage
   without one (`context-monitor.ts:175`, `claude-compaction-enforcer.ts:436`). Only a fresh,
   known sample can start a compaction. The sample-less drain reads readiness from the pane alone
   and counts a timer-less live status row, such as `✻ Compacting conversation…`, as work
   (`session-transport.ts:153-161`); a recent hook showing work or a waiting person still
   refuses. It records no width receipt, because the only figure would be the pre-compact one.

An automatic attempt has a 25-minute ceiling that starts once the prep is delivered. A stale
occupant generation, the policy becoming disabled, or the deadline passing stops it. A prep
that clearly wasn't sent is retried at most three times; an uncertain prep or `/compact` is
never replayed.

The restore prompt names a restore-pending marker at
`compaction/restore-pending/<session>.json` in the OpenRig home, which the `openrig-core`
PreCompact hook writes. A per-seat `compaction/post-compact-extra/<session>.md` is preferred
over the global extra file, and an extra file that declares a different seat is refused.

`rig compact <session>` (`packages/cli/src/commands/compact.ts`) runs the same sequence
manually through `/api/compaction/trigger`, `cancel` and `state`, which use the terminal
bearer-token middleware; it passes every request through when no token is configured.
`--skip-map` skips the map requirement once, `--cancel` ends the preparation, and `--state`
shows the attempt, its expected map and its deadline. A manual attempt has 120 seconds for
preparation and the idle wait.

The below-threshold continuation checks policy enablement too, except for an explicitly
operator-initiated manual sequence. A known occupant-generation mismatch invalidates the
queued stages; an unknown generation does not prove a match. Failed or retained sends
do not advance the stage. The manual trigger shares this continuation while having its
own initiation checks.

Stage, deduplication, cooldown and preparation-attempt maps are in memory; the restore maps
are files. Startup supplies live generation
resolution and a post-restore callback that records a managed-width receipt, so the wider
operation also has persistent effects. Do not infer durable lifecycle completion from
a library read or one successfully queued message.

## Related maps

- [packaging-bootstrap-bundles.md](packaging-bootstrap-bundles.md): bundle export and
  routing into content libraries.
- [agent-spec-and-startup.md](agent-spec-and-startup.md): context/resource projection
  and image consumption during launch.
- [lifecycle-snapshot-restore.md](lifecycle-snapshot-restore.md): broader continuity flows.
