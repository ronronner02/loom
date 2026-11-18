---
kind: as-built
title: Coordination Primitive — Stream/Queue/Inbox/Outbox
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator]
applies-when: |
  Need to know how the daemon-backed coordination primitive works — the
  stream/queue/inbox/outbox tables, the hot-potato closure contract, the
  transactional handoff guarantee, or where queue closure is enforced.
siblings: [workflow-runtime.md, mission-control.md, daemon-core.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Coordination Primitive — Stream/Queue/Inbox/Outbox

The coordination primitive is the SQLite-canonical durable-work layer the
daemon exposes through `/api/stream` and `/api/queue`. It replaces the POC
filesystem `rigx queue` / `rigx stream` path for daemon-backed work; the POC
filesystem path remains untouched, and the daemon-backed `rig queue` /
`rig stream` commands operate only through the daemon HTTP API, so they write
only to SQLite (`packages/cli/src/commands/queue.ts:19`,
`packages/cli/src/commands/stream.ts:11`).

> Verified against source at main `e8f0ab340db773392ec8be75b072d1c0f3068a50`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The five host-scoped tables

Five host-scoped tables back the primitive, one per migration `023`–`027` in
`packages/daemon/src/db/migrations/` (**5** tables:
`cat packages/daemon/src/db/migrations/02[3-7]_*.ts | grep -c 'CREATE TABLE'`):

- **`stream_items`** (`023_stream_items.ts`) — L1 append-only intake/audit
  root. Columns: `stream_item_id` (TEXT PK; a ULID unless the caller supplies
  one, `packages/daemon/src/domain/stream-store.ts:88`), `ts_emitted`,
  `stream_sort_key`, `source_session`, `body`, `format` (default `text`),
  `hint_type`, `hint_urgency`, `hint_destination`, `hint_tags` (JSON),
  `interrupt`, `archived_at`, and `identity_provenance` (added by
  `067_i3_identity_provenance.ts`). Items immutable after emit (only
  `archived_at` may be set, `stream-store.ts:217`).
- **`queue_items`** (`024_queue_items.ts`) — L3 owned-work queue.
  Unless `--id` is supplied, the CLI generates the create request's `qitem_id` (TEXT PK) before sending as `qitem-<UTC YYYYMMDDHHMMSS>-<16 hex>` (64 random bits) and prints it to stderr as a request identity, not proof of persistence; reuse that ID with `--id` and the unchanged payload after an unknown outcome, while daemon callers without an ID still use `newQitemId()` and its `qitem-<UTC YYYYMMDDHHMMSS>-<8 hex>` form.
  State enum (**8** values, `QUEUE_STATES` at `queue-repository.ts:33`;
  `sed -n '/^export const QUEUE_STATES/,/] as const/p' packages/daemon/src/domain/queue-repository.ts | grep -c '^  "'`):
  `pending | in-progress | done | blocked | failed | denied | canceled |
  handed-off`. Carries `closure_reason`, `closure_target`,
  `closure_required_at`, `chain_of_record` (JSON), `blocked_on`,
  `handed_off_to`/`handed_off_from`, nudge/heartbeat columns.
- **`queue_transitions`** (`025_queue_transitions.ts`) — L3 append-only
  transition log; authoritative audit trail for state evolution. Domain code
  never updates its rows. The retention runner that archived aged transitions
  was deleted with the watchdog runtime, so nothing deletes from this table.
`inbox_entries` and `outbox_entries` were dropped at schema 12: the `InboxHandler`
was constructed and never called, and the `OutboxHandler` was the durable wake-intent
store that went with the wake runtime, so nothing wrote either table.

The three that remain (`stream_items`, `queue_items`, `queue_transitions`) are
created by the one-shot schema in `packages/daemon/src/db/baseline.ts`; there is no
per-migration directory any more.
Later migrations add columns to these tables; `daemon-core.md` covers the
migration set.

## 2. The six host-scoped services

Host-scoped domain services in `packages/daemon/src/domain/` implement the
layer. Routes import these; services are Hono-free:

- **`stream-store.ts`** — L1 stream: idempotent emit (on `stream_item_id`),
  chronological list with cursor pagination plus source, destination, exact-tag,
  and inclusive time-window filters, soft archive. `direction=latest` applies
  every filter before taking the newest bounded page, then returns that page
  chronologically.
- **`queue-repository.ts`** — L3 queue: create (and `createWithinTransaction`,
  which a close-plus-successor writer composes inside its own transaction),
  update (general state mutator with hot-potato strict-rejection on `done`),
  read (`getById`, `list`), the append-only transition log, and the
  generation-scoped claim release the seat-handover path uses. Cross-rig
  validation hook exposed as the `validateRig` constructor option.
- **`queue-transition-log.ts`** — append-only state-transition log; used by
  `queue-repository.ts`, exposed as the read-only property
  `QueueRepository.transitionLog` (`queue-repository.ts:666`).
- **`hot-potato-enforcer.ts`** — pure validator for the load-bearing API
  contract (see §3).

Create returns the committed row. The wake ladder, the outbox that staged its intents and the
standing stuck sweep that detected strands were all deleted with the watchdog runtime, so a
row's `last_nudge_*` columns keep whatever an earlier daemon recorded and nothing new writes
them.

## 3. The hot-potato closure contract (where queue closure is enforced)

`hot-potato-enforcer.ts` is the pure validator for the load-bearing API
contract. `validateClosure` (`hot-potato-enforcer.ts:59`) checks a transition
against `CLOSURE_REASONS` (`:18`; **7** values:
`sed -n '/^export const CLOSURE_REASONS/,/] as const/p' packages/daemon/src/domain/hot-potato-enforcer.ts | grep -c '^  "'`):

`state=done` requires `closure_reason ∈ {handed_off_to, blocked_on, denied,
canceled, no-follow-on, escalation, superseded}`. The reasons
`handed_off_to | blocked_on | escalation` additionally require
`closure_target` (`:86`):

- `handed_off_to` — work continues with a different seat (`closure_target` =
  new owner).
- `blocked_on` — work is parked pending another qitem (`closure_target` =
  blocker `qitem_id`).
- `denied` — receiver rejected the work (`closure_target` = reason text).
- `canceled` — sender or receiver withdrew (`closure_target` = note).
- `no-follow-on` — terminal completion, nothing else needed.
- `escalation` — kicked up to a higher tier (`closure_target` = escalation
  target).
- `superseded` — the row was replaced by cancel-and-replace
  (`closure_target` = the successor qitem). The update path records it on
  `state=canceled` and refuses it there without a `closure_target`
  (`queue-repository.ts:2629`).

Tier→SLA mapping for `closure_required_at` also lives in
`hot-potato-enforcer.ts` (`TIER_SLA_SECONDS`, `:115`). This validator is
invoked by `QueueRepository.update()` (and `updateWithinTransaction()`), both
through the call at `queue-repository.ts:2531`, so closure is enforced at the
daemon transaction boundary — the workflow runtime *projects* on closure but
does not otherwise gate it (see `workflow-runtime.md`). The one
workflow-aware check is in the queue: `update()` refuses a terminal close of a
live workflow frontier packet from a non-workflow verb
(`workflow_frontier_packet`, `queue-repository.ts:2557`), through a predicate
startup injects. "Terminal" there is the queue's terminal set, `done` and
`handed-off` (`queue-repository.ts:52`).

Closure fields are stored only on `state=done`, the park record (`blocked`
with `blocked_on`), the handoff close (`handed-off` with `handed_off_to`) and
the superseded cancel; any other transition carrying them is refused with
`closure_fields_not_admitted`, and `blocked_on` outside `blocked` with
`blocked_on_not_admitted`. A `done`, `canceled` or `handed-off` row accepts a
note without a state change as an append-only transition; moving it to
another state requires an explicit reopen with a note. A `qitem-` blocker must
exist and be live on this daemon; when a blocker leaves the active states,
each row parked on it follows the blocker's handoff successor or returns to
`pending` with a durable wake (`queue-repository.ts:2407`–`2529`,
`:2612`–`2656`, `:2931`–`3008`). Claiming a parked row clears its
`blocked_on`; the claim transition keeps the former gate as a `closure_target`
audit pointer with no closure reason, which a re-park without `--blocked-on`
reuses (`queue-repository.ts:2233`–`2254`, `:2571`–`2577`).
`human-route-enforcer.ts` is a second pure validator at the same boundary: a
`human-gate` row, a row addressed to a human seat, or a park on one must carry
`summary` and `evidence_ref`.

## 3b. Cross-host queue routing

Three queue write routes are host-aware — `POST /create`,
`POST /:qitemId/handoff` and `POST /:qitemId/handoff-and-complete` (**3**:
`grep -c '!resolvesToLocalHost(body.hostId, getSelfHostId())' packages/daemon/src/routes/queue.ts`):
a write body may carry an out-of-band `hostId` envelope. The destination
session stays `member@rig`; the 3-part `agent@rig@host` form is CLI input
sugar that `resolveQueueHostDestination`
(`packages/cli/src/commands/queue.ts:394`) splits into the destination and
`hostId` before the request leaves the CLI. The same split applies to
`--host <id>`; queue verbs never follow `rig host select`, and naming two
different hosts is refused with `host_qualifier_conflict`. The mechanism
follows the forward-then-strip shape of mission-control's remote action
(`routes/mission-control.ts:352`): one shared route-layer helper
(`forwardQueueWrite`, `routes/queue.ts:214`) resolves the host registry
daemon-side (bearers never reach the caller), rejects ssh-declared hosts
(`unsupported-transport` — the daemon→daemon path is http-only), and forwards
the whole body, with `hostId` stripped, via `remoteJsonRequest` (`:248`) under
a named write-class deadline (`QUEUE_FORWARD_TIMEOUT_MS`, `:41`). The origin's
response returns verbatim; failures map to a structured host-named error
(`remote_queue_write_failed`, HTTP 502, `:234`) whose `failureClass` is one of
registry / unknown-host / unsupported-transport / unreachable / auth-failed /
remote-error. No local row is ever written on the cross-host path.

**The model: origin-owns-the-record, at-least-once + idempotent,
message-passing closure (never 2PC).**

- **Origin-owns-the-record.** The qitem lives in the TARGET host's DB; that
  row is THE record. The target daemon wakes the destination on ITS local
  tmux: its own `create` stages a durable wake intent and delivers it after
  commit (§2; the forwarded body carries the `nudge` flag) — the sending
  daemon never reaches across a host boundary. Before forwarding, the
  forwarding daemon stamps its own host id, when it has one, onto the source
  session (`stampSelfHostSuffix`, `queue-repository.ts:548`; called at
  `routes/queue.ts:378` and `:509`), so the target row records the sender as
  `member@rig@<forwarding host>`.
- **Idempotency.** On create, the forwarding daemon mints the `qitemId` before
  the forward unless the caller supplied one (`routes/queue.ts:501`). The
  forward is a single request, so a retry dedups only when it carries the same
  id (a caller re-sending `--id`, or a handoff re-drive, whose successor id is
  derived). Dedup rides the existing `qitem_id TEXT PRIMARY KEY`. On PK
  conflict the origin returns the stored row when destination and source
  match (idempotent absorb) and a structured `qitem_id_reuse` error (409) when
  they differ (`QueueRepository.create()` catch path,
  `queue-repository.ts:1431`–`1472`, with `isQitemPrimaryKeyConflict`,
  `:461`). When destination and source match but the body differs, the stored
  row is returned unchanged with `createWarning: qitem_body_not_saved`; the
  supplied body is not saved (`:1450`–`1454`).
- **Cross-host handoff choreography.** The local atomic close+create cannot
  span two DBs, so the route-layer choreography (`crossHostHandoff`,
  `routes/queue.ts:316`) runs: successor-create on the target host FIRST (via
  the one forward helper, `:397`), local source-close SECOND
  (`QueueRepository.closeCrossHostHandoffSource`, `queue-repository.ts:2031`)
  — never the reverse. A crash between the two leaves a live duplicate that
  the idempotent re-drive converges; the reverse order would leave a closed
  source pointing at a successor that does not exist (a dropped potato — the
  one forbidden outcome). The successor id is DERIVED, not minted:
  `deriveCrossHostSuccessorId(source, destination, host)`
  (`queue-repository.ts:489`) → `qitem-xh-<sha256[:16]>` — a pure stateless
  function, so a re-drive re-derives the same id across daemon restarts and
  absorbs on the target PK. *(Residual, inherent to at-least-once delivery
  without 2PC: a re-drive naming a DIFFERENT destination derives a different
  id and cannot absorb the earlier successor — that orphan stays visible via
  the chain + provenance tags; the source-close conflict check surfaces the
  disagreement.)*
- **Closure across the boundary.** The source closes with
  `closure_reason=handed_off_to` and
  `closure_target=<successor qitem id>@<host>` (`routes/queue.ts:351`); a
  source already closed with the older `member@rig@<host>` target keeps it,
  and a re-drive matches against it (`:352`–`356`). `closure_target` is OPAQUE
  audit metadata, never parsed for routing. The
  host-qualified key appears only in the `closure_target` column on
  `queue_items` and its verbatim mirror on `queue_transitions`: the minted
  cross-host close note names the 2-part `toSession` only
  (`queue-repository.ts:2087`), and `handed_off_to` and the
  `queue.handed_off` event stay 2-part.
  Re-drive semantics: already-terminal + MATCHING `closure_target` = absorb;
  MISMATCH = structured `cross_host_close_conflict` (409), checked in the route
  before any forward (`routes/queue.ts:359`) and again in the repository. The
  successor carries `chain_of_record = [...source.chain, source.qitemId]`
  (`routes/queue.ts:384`) — A-side ids are opaque lineage identifiers on B
  (they do not dereference in B's DB) — plus provenance tags `cross-host` +
  `from-host:<self-declared name>` (the forwarding daemon's OS hostname,
  `routes/queue.ts:54`; honest best-effort, not authenticated identity).
- **Boundary discipline.** Claim and update routes take no `hostId` and
  stay local (after a cross-host handoff the successor lives where its worker
  lives). Without a `hostId`, with `local`, or with this daemon's own resolved
  host id (an exact, case-sensitive match), create and handoff take the
  local path; a self-addressed handoff whose deterministic cross-host
  successor an earlier self-forward already created runs that cross-host
  create and close in process. The
  hot-potato validation contract (§3) is unweakened across the boundary: the
  cross-host close always records `handed_off_to` with a target.

## 4. Coordination events

The `RigEvent` union (`packages/daemon/src/domain/types.ts:108`) has **98**
members
(`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -c 'type: "'`);
this module covers only the coordination families below.

Coordination events emitted by these services: `stream.emitted`
(`StreamStore.emit`, declared at `types.ts:245`); `queue.created` /
`queue.handed_off` / `queue.claimed` / `queue.unclaimed` / `queue.updated` /
`qitem.fallback_routed` / `qitem.closure_overdue` (QueueRepository).
The `stream|queue|qitem` families declare the coordination event types
(`stream` 1 + `queue` 5 + `qitem` 2;
`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -oE '"(stream|queue|qitem)\.[a-z_]+"' | sort -u | wc -l`).

Two SSE surfaces stream coordination events (**2**:
`cat packages/daemon/src/routes/stream.ts packages/daemon/src/routes/queue.ts | grep -c 'return streamSSE('`):
`/api/stream/watch` (aliased `/api/stream/sse`, `routes/stream.ts:194`–`195`),
which first replays up to 50 unarchived items in chronological order (the
oldest, `:174`–`181`) and then streams new items, and `/api/queue/watch`
(aliased `/api/queue/sse`, `routes/queue.ts:1054`–`1055`) for queue/inbox
events — every coordination type except `stream.emitted` and `queue.updated`
(filter at `routes/queue.ts:1031`–`1038`). The event log remains append-only and
SQLite-backed. `rig stream watch` is a thin, single-connection consumer of
`/api/stream/sse` (`packages/cli/src/commands/stream.ts:191`); it does not add
a daemon route or reconnect policy.

## 5. Route surface

- `/api/stream` (`server.ts:783`) — `POST /emit` (`routes/stream.ts:56`),
  `GET /list` (`:91`, including `sourceSession`, `hintDestination`, `hintTag`,
  `since`, `until` and `direction` filters), `GET /watch` + `/sse` SSE
  (`:194`), `GET /:streamItemId` (`:198`), `POST /:streamItemId/archive`
  (`:207`).
- `/api/queue` (`server.ts:784`) — `POST /create` (`routes/queue.ts:450`),
  `POST /:qitemId/claim` (`:545`), `POST /:qitemId/unclaim` (`:561`),
  `POST /:qitemId/update` (`:600`), plus handoff (`:650`, `:732`),
  `POST /:qitemId/fallback` (`:808`), list (`:902`) and watch (`:1054`)
  surfaces; reads `GET /whoami`, `/attention-aggregate`, `/human-updates`,
  `/overdue`, `/undelivered`, `/recent-transitions`, `/:qitemId/transitions`
  and `/:qitemId` (`:822`–`1067`). The inbox routes and their handler were
  removed with the unreachable launch-era surface; `POST /outbox/record` and
  `GET /outbox/list` remain.

Every write route derives its actor through `requireSenderIdentity`
(`routes/require-sender-identity.ts:76`): the `X-OpenRig-Session` header wins
over a body actor. On a direct request from a known origin it is recorded as
`transport:v1`; `resolveRecordedProvenance` (`:199`) instead records
`origin-unknown:v1` when the origin-unknown marker is set or a relayed request
carried `origin-unknown:v1` (`:207`), `relay:v1` for a relayed request that
carried `transport:v1`, and `claimed:v1` for other relayed requests. Without the
header, the
body actor is recorded as `claimed:v1`; with neither the route answers 400
`actor_required`. The stamp lands in `identity_provenance` on transitions,
outbox and stream rows (migrations `067`, `082`).

## See also

- `daemon-core.md` — daemon wiring, the migration set, route surface.
- `workflow-runtime.md` — the spec types and the successor rule.
- `mission-control.md` — queue observability over `queue_items`.
- Source roots: `packages/daemon/src/domain/{stream-store,queue-repository,
  queue-transition-log,hot-potato-enforcer}.ts`.
