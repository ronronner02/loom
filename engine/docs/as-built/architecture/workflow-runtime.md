---
kind: as-built
title: Workflow — Spec Types and the Successor Rule
status: active
topics: [orchestration, coordination]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need the spec, step and next-hop contracts, or how the engine decides a step's
  successor from a workflow declaration.
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Workflow Runtime — the spec types and the successor rule

Source snapshot: this page describes the surface that remains after the workflow execution
runtime was deleted; it does not establish the version or behavior of a running daemon.

A managed run is a lead and a team of seats working through tasks the daemon dispatches. The
engine no longer instantiates a workflow spec, projects step closures, or keeps a frontier:
those paths had no route, no CLI verb and no managed caller, so an instance could never be
created and the machinery around it described state nothing wrote.

What remains:

| File / symbol | Responsibility |
|---|---|
| [`domain/workflow-types.ts`](../../../packages/daemon/src/domain/workflow-types.ts) | The spec, step, exit and next-hop contracts the surviving code reads. |
| [`resolveNextStep`](../../../packages/daemon/src/domain/workflow-projector.ts) | The one successor rule: a mapped exit target, else the first suggested role's step, else the next authored step. |

`resolveNextStep` stays because the task-edit and scope paths use it to reason about a plan's
step graph; the validator that consumed it went with the runtime.

## CLI and HTTP surface

None. The `/api/workflow/*` routes and the `rig workflow` verbs were deleted with the runtime,
so nothing mounts or calls this surface.

For the live planning and dispatch path, see
[daemon-core.md](daemon-core.md) and [coordination-primitive.md](coordination-primitive.md).
