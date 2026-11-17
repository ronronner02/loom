---
kind: as-built
title: Agent/Rig Spec, Resolution, Startup, Identity
status: active
topics: [specification-and-bundles, agent-runtime]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know the canonical AgentSpec/RigSpec/pod-aware reboot types, how
  profile resolution and additive startup layering work, the StartupOrchestrator
  pre-launch-vs-interactive delivery split, or how materialize/bind/adopt
  resolve and preserve identity.
siblings: [daemon-core.md, adapters-and-runtimes.md, lifecycle-snapshot-restore.md, packaging-bootstrap-bundles.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Agent/Rig Spec, Resolution, Startup, Identity

How the daemon turns authored YAML specs into a resolved, projected, launched,
and identity-addressable topology. The spec-and-startup contract: parse →
resolve → project → deliver pre-launch files → persist replay context → launch
→ wait → deliver post-launch files.

> Verified against source at main `e8f0ab340db773392ec8be75b072d1c0f3068a50`. `domain/…` and `routes/…` paths
> are under `packages/daemon/src/`; a bare file name such as
> `rigspec-schema.ts:119` is in `packages/daemon/src/domain/`. Each count sits
> beside the command that produces it; run the command from the repository
> root to refresh it.

## 1. Canonical spec and topology types

- **AgentSpec** (`types.ts:941`) — parsed from `agent.yaml`. Owns imports,
  defaults, startup, resources, and profiles. The daemon-side
  parse/normalize/validate chain (`agent-manifest.ts`, `agent-resolver.ts`)
  was never constructed on a live path and has been removed; the specs remain
  as data consumed by the packaging scripts.
- **RigSpec** (`types.ts:1172`) — canonical pod-aware rig topology. Uses
  `version: "0.2"` and `pods[]`; owns cross-pod `edges[]`, rig-level startup
  overlays, and `cultureFile`, plus the optional `summary`, `permissionPolicy`,
  `nonInterruptive`, `docs`, `services` and `workspace` fields.
  An authored `non_interruptive` must be a boolean (`rigspec-schema.ts:179`) and
  sets the rig's saved non-interruptive choice at instantiation unless an
  explicit launch option is given (`rigspec-instantiator.ts:1345`).

  `version` is the spec-schema version, not the package version. It is not a
  code constant: `RigSpecSchema.validate` requires only a non-empty string
  (`rigspec-schema.ts:119`) and `RigSpecSchema.normalize` carries the authored
  value through (`rigspec-schema.ts:253`). `"0.2"` is the canonical authored
  value, and the pod-aware exporter writes it (`rigspec-exporter.ts:223`).

- **RigServicesSpec** (`types.ts:1221`) — optional `services` block on a
  pod-aware RigSpec. Shipped kind is Compose-backed env management
  (`kind: "compose"`) with `composeFile`, `projectName?`, `profiles?`,
  `downPolicy?`, `waitFor?`, `surfaces?`, `checkpoints?`.
- **RigSpecPod** (`types.ts:1128`) — pod-local bounded context with
  `members[]`, pod-local `edges[]`, pod startup, optional continuity policy.
- **RigSpecPodMember** (`types.ts:1072`) — member-level runtime/startup
  surface: `agentRef`, `profile`, `runtime`, `model?`, `effort?`, `cwd`, `restorePolicy?`,
  member startup overlays (`startup?`), plus `label?`, `codexConfigProfile?`,
  `role?`, `permissionPolicy?`, `compactionStrategy?`, `mechanic?`,
  `sessionSource?` and `starterRef?`.
- **Pod** (`types.ts:10`) — persisted DB entity for a pod.
- **ContinuityState** (`types.ts:20`) — persisted live continuity row keyed by
  `podId + nodeId` (`PRIMARY KEY (pod_id, node_id)`,
  `packages/daemon/src/db/migrations/014_agentspec_reboot.ts:24`).

## 2. Execution types

Restore/snapshot types are detailed in `lifecycle-snapshot-restore.md`; the
adapter contract lives here.

The profile-resolution and projection-plan types (`ResolvedNodeConfig`,
`ProjectionPlan` and the `profile-resolver.ts` / `projection-planner.ts` /
`startup-resolver.ts` chain behind them) were reachable only from a projection
plan the product never filled, and have been removed.

- **RuntimeAdapter** (`runtime-adapter.ts:143`) — the four-method contract
  (adapter detail in `adapters-and-runtimes.md`): `listInstalled(binding)`
  (`runtime-adapter.ts:153`), `deliverStartup(files, binding,
  sendInteractiveText?)` (`:160`), `launchHarness(binding, opts)` (`:170`),
  `checkReady(binding)` (`:176`). Required methods: **4**
  (`sed -n '/^export interface RuntimeAdapter /,/^}/p' packages/daemon/src/domain/runtime-adapter.ts | grep -c -E '^  [a-zA-Z]+\('`).
- **HarnessLaunchResult** (`runtime-adapter.ts:97`) — returned by
  `launchHarness`: either `{ ok: true, resumeToken?, resumeType?,
  appliedLaunch? }` or `{ ok: false, error, recovery?, evidence? }`, where
  `recovery` is `"retry_fresh"` or `"attention_required"` (`:95`).
- **StartupOrchestrator** (`startup-orchestrator.ts:140`) — drives the full
  startup sequence (§4 below).

## 3. Parsing, validation, resolution pipeline

The spec parse/validate/resolve pipeline (`agent-manifest.ts`,
`agent-resolver.ts`, `profile-resolver.ts`, `startup-resolver.ts`,
`startup-validation.ts`, `projection-planner.ts`) was imported by nothing the
daemon evaluates and has been removed with `startup.ts`'s stale imports. The
spec YAML under `packages/daemon/specs` is still shipped and is still read by
`check-first-run-references.mjs`; nothing in the daemon parses it at run
time.

## 4. Startup orchestration (the spec-startup contract)

`StartupOrchestrator.startNode` (`startup-orchestrator.ts:53`) drives, in source
order: resolve the admitted managed attempt (`:56`) → mark the session pending
and emit `node.startup_pending` (`:58`–`:59`) → deliver the startup files
(`:62`) → write the turn prompt (`:66`–`:75`) → launch the harness and record
its receipt (`:77`–`:86`) → wait for ready (`:87`) → emit
`node.startup_ready` and mark the session ready (`:90`–`:91`). A failure at any
step marks the session failed and emits `node.startup_failed` (`:93`–`:98`).

**Pre-launch vs interactive delivery split** — the load-bearing seam:

- Pre-launch (filesystem, before harness boot): `guidance_merge`,
  `skill_install` (`startup-orchestrator.ts:126` — "Deliver pre-launch files
  (guidance_merge, skill_install → filesystem)"; delivered at `:266`). Any
  file that is not `send_text` is delivered here.
- Post-launch (TUI, after harness is ready): `send_text`
  (`startup-orchestrator.ts:130`; held for post-launch and delivered after
  readiness at `:473`). Rebuild artifacts are put in front of these files.
- **Fresh launch:** the builtin `session_identity` action
  (`rigspec-instantiator.ts:2655`) is sent as one turn together with the first
  `send_text` file (`deliverInitialSessionPrompt`, `startup-orchestrator.ts:663`).
- **Resume, fork or rebuild:** applicable `after_ready` `send_text` actions are
  sent ahead of the first `send_text` file as one turn.

The orchestrator persists replay context for future restores (consumed by
`lifecycle-snapshot-restore.md`): the projection entries, resolved startup
files, startup actions and runtime go to `node_startup_context`
(`startup-orchestrator.ts:282`), and a resume token returned by the launch is
written to the session row (`updateResumeToken`, `:313`).

**Checked startup text (Claude Code).** Interactive text for a Claude seat goes
through `sendInteractiveText` (`:777`): paste, wait 200 ms, press Enter, wait
200 ms, then read 200 lines of the pane. `inspectStartupStagedText`
(`startup-submission-evidence.ts:36`) classifies the composer as clear, staged
or unverified. While the composer shows Claude's own collapsed-paste label for
this text (`startupOwnCollapsedPaste`, `:49`), `settleOwnPaste`
(`startup-orchestrator.ts:867`) looks again, up to 25 times 200 ms apart,
without pressing anything. Text still staged gets one guarded Enter-only retry
(`:823`), and then a "press Enter in that pane" warning (`:836`). An
unverified or staged result is a warning, never a startup failure, and is
reported in a `submission` block on `node.startup_ready` and on the result.

**Startup proof.** A seat can be `ready` without being oriented. The orientation
status (`verified` / `missing` / `rejected` / `n-a`) was derived from the
`node.startup_proof_*` events, and the daemon no longer derives it: the seat
screens, the inventory projection and the `whoami` diagnostic that read it are
gone. The events themselves stay in the append-only log for replay.

**Fresh context pending and `rig seat continue`.** When a fresh launch stops at
a native prompt before its context is delivered, `fail()` (`:592`) marks the
failure `freshContextPending` and adds "run: rig seat continue <session>".
`canContinueFresh` (`:554`, using `hasPendingFreshStartup`, `:35`) allows
continuation only while that failure is the occupant's latest startup event.
`continueFreshStartup` (`seat-lifecycle-service.ts:395`) re-checks the binding,
pane and runtime, then runs startup again on the same conversation without
relaunching the harness. It is reached by `rig seat continue`,
`POST /api/seat/continue/:seatRef` and the per-seat startup route's `continue`
action (`routes/startup.ts:148`).

**Startup layering is additive and ordered** (`resolveStartup`,
`startup-resolver.ts:15`–`22`): (1) agent base, (2) profile, (3) rig culture
file, (4) rig startup, (5) pod startup, (6) member startup, (7) operator debug
append. Files and actions are concatenated in that order with no
deduplication (`startup-resolver.ts:24`). This is the spec-startup contract's
invariant; the cross-cutting architecture rules are collected in
`architecture-rules-and-event-system.md`.

The launch path takes only the actions from `resolveStartup`. It builds the
startup *file* chain itself (`buildResolvedStartupFiles`,
`rigspec-instantiator.ts:2518`), in this order: agent base, profile, the shipped
`CULTURE-default.md` floor (`:327`), the rig `culture_file`, rig, pod, member,
the shipped `openrig-start.md` (`:2572`), and, for fresh launches when enabled,
the onboarding files (`:2582`). Managed-block guidance is deduplicated, and a
`starter_ref` layer is put in front when a member names one (`:2243`).

**Startup action constraints** (`startup-validation.ts`): startup entries must
be files (`:22`); no shell startup actions (`:65`); action types are
`slash_command`, `send_text` and `startup_proof` (`:7`), and a `startup_proof`
action must be idempotent with a value of `authenticated` or `none` (`:73`);
non-idempotent actions must not apply on restore (`:100`). Retrying a failed
startup is handled as a restore, which is why the orchestrator skips
non-idempotent actions on restore (`startup-orchestrator.ts:634`,
"retry-as-restore safety"). The exception is
`PodRigInstantiator.retryFirstStart` (`rigspec-instantiator.ts:1147`), which
re-runs a first start that failed at projection, before any harness launch.

**Remote import constraints**: `agent_ref` and AgentSpec imports accept
`local:<relative path>` and `path:<absolute path>` only
(`rigspec-schema.ts:41`, `agent-manifest.ts:40`); a terminal member uses the
`builtin:terminal` sentinel (`rigspec-schema.ts:532`). Remote `agent_ref`
sources remain unsupported: RigSpec validation rejects them
(`rigspec-schema.ts:563`), `rigPreflight` runs that validation
(`rigspec-preflight.ts:252`), and the resolver refuses a remote import again
(`agent-resolver.ts:203`).

## 5. Instantiation, preflight, export

- `runtime-adapter.ts` — adapter contract + bridge types.
- `rigspec-preflight.ts` — dual-stack legacy preflight (`RigSpecPreflight`,
  `rigspec-preflight.ts:26`) plus rebooted `rigPreflight(...)` (`:246`).
- `rigspec-instantiator.ts` — dual-stack `RigInstantiator`
  (`rigspec-instantiator.ts:33`) plus `PodRigInstantiator` (`:475`).
- `rigspec-exporter.ts` — dual-format live rig export to YAML/JSON.
- `pod-repository.ts` — pod CRUD plus live continuity-state CRUD.

`routes/rigspec.ts` is the dual-format seam; a parsed spec with a `pods` array
takes the pod-aware path (`routes/rigspec.ts:83`): validate
(pod-aware → `RigSpecSchema.validate`; legacy → `LegacyRigSpecSchema.validate`),
preflight (`rigPreflight({ rigSpecYaml, rigRoot, … })` vs
`RigSpecPreflight.check(spec)`), import
(`podInstantiator.instantiate(yaml, rigRoot, …)` vs
`RigInstantiator.instantiate(spec)`), export (pod-aware exports canonical
`version: "0.2"` RigSpec; legacy exports flat-node `schemaVersion: 1`,
`rigspec-exporter.ts:105`).

The import validation route delegates to `validateRigSpecImport`
(`routes/rigspec.ts:215–223`, `spec-validation-service.ts:10–19`). The same
helper powers local `rig spec validate` without contacting the daemon
(`packages/cli/src/commands/rig.ts:204–207`); it selects the pod-aware or legacy
validator and distinguishes YAML parse failures from validator exceptions.

## 6. Identity: materialize, bind, adopt

**Whoami resolution** — the daemon no longer serves a whoami read. The
`whoami-service`, its route and the CLI verb that printed identity all went
with the inventory projection; a seat's identity is its registered session
row (`sessions.session_name`), which the mailbox and dispatch paths read
directly.

- Managed sessions prefer projected `OPENRIG_NODE_ID` /
  `OPENRIG_SESSION_NAME`, set when the tmux session is created
  (`node-launcher.ts:143`–`144`).
- Adopted sessions use tmux-owned metadata written at bind time.

  The tmux metadata keys use the `@rigged_` prefix:
  `ClaimService.setRiggedMetadata` writes `@rigged_node_id` /
  `@rigged_session_name` / `@rigged_rig_id` / `@rigged_rig_name` /
  `@rigged_logical_id` (`claim-service.ts:182`–`186`), called from `bind`,
  `reconcileSession` and `createAndBindToPod`;
  `RigLifecycleService.unclaimSession` clears the same five keys
  (`rig-lifecycle-service.ts:209`–`213`). MCP tool names use a
  different prefix, `rig_*` (`packages/cli/src/mcp-server.ts`).

**Materialize / bind / adopt**: `POST /api/rigs/import/materialize`
(`routes/rigspec.ts:176`) creates a pod-aware topology without launching
sessions and refuses a legacy spec (`routes/rigspec.ts:189`);
`POST /api/discovery/:id/bind` (`routes/discovery.ts:77`) attaches a
discovered live session to an existing logical node (`logicalId`), or creates
a member in a pod (`podNamespace` + `memberName`) and binds it;
`POST /api/discovery/:id/adopt` (`routes/discovery.ts:139`) is the composite
route (bind to existing node, or create a new member in a target pod and bind
immediately). On the CLI, `rig bind` calls the bind route
(`packages/cli/src/commands/bind.ts:56`), and `rig adopt` materializes the
topology and then calls the bind route for each session
(`packages/cli/src/commands/adopt.ts:163`, `:212`). Authored pod namespace is
preserved through adoption so logical ids stay `${podNamespace}.${memberName}`
(`claim-service.ts:663`). Adopted-session parity is tmux-metadata parity, not
fake env-var parity.

## 7. Specialist rosters

A roster is an authored list of recommended specialist seats, kept outside the
specs. `rig roster list`, `show <id>` and `find <query>`
(`packages/cli/src/commands/roster.ts`) read version-1 roster JSON files from
`<workspace.root>/rosters/` (or `--folder`); they are read-only and need no
daemon route. Each roster names a purpose and a curator, and each member names
a seat, host, capabilities, engagement, `use_when` and `why`. `show` and
`find` add current observations of each member by matching host and seat
against `rig ps --nodes`, read from the configured daemon and again across
registered hosts, and report a gap rather than guessing when no node matches. A roster is a
recommendation, not an assignment or an authority. It is unrelated to the
topology roster a snapshot records (see `lifecycle-snapshot-restore.md`).

## See also

- `daemon-core.md` — createDaemon wiring; the migration/route surface.
- `adapters-and-runtimes.md` — the RuntimeAdapter contract detail.
- `lifecycle-snapshot-restore.md` — snapshot/restore consumes persisted replay
  context.
- `architecture-rules-and-event-system.md` — the cross-cutting architecture
  rules.
- Source roots: `packages/daemon/src/domain/{rigspec-schema,
  startup-orchestrator,claim-service}.ts` and
  `packages/daemon/src/routes/rigspec.ts`.
