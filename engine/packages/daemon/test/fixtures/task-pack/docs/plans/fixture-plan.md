---
title: Loom Engineering Team - Assignment Binding - Plan
type: feat
date: 2026-10-13
topic: assignment-binding
artifact_contract: spec-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: spec-brainstorm
execution: code
status: active
---

# Assignment Binding - Plan

This single-unit fixture plan is the source a bounded task pack is derived from. A test that
drives the real `spec-first tasks validate` receipt needs a plan whose lifecycle is `active`
and whose body is stable, so the task pack's `source_plan_hash` can be recomputed without
carrying the whole engineering-team plan in the repository.

## Goal Capsule

- **Objective:** Bind every dispatched assignment to an immutable effective-context manifest.
- **Approach:** Extend the existing assignment owner with a projected manifest, a recorded
  digest and a refused launch when an unaccounted instruction source appears.
- **Verification focus:** Direct plan assignment with minimal staffing, repository, path, role,
  dependency, output and permission validation, and the negative ancestor and global
  contamination cases.

---

## Product Contract

### Summary

A dispatched assignment must carry the exact plan, repository and policy identity it was
approved under, and the instruction sources it will read. A launch whose observed sources
disagree with the recorded manifest must block rather than run.

### Requirements

- R4. Every assignment identifies its source plan, bounded scope, dependencies and required
  evidence.
- R5. Assignments are checked against the current plan before dispatch and continuation, and
  stale work is returned for reconciliation.

## Planning Contract

### Framework and Native-Session Integration

The manifest is projected from the plan's authority; it is never assembled by the worker. The
assignment owner composes it, records the generated digest, and passes it to the launch path,
which verifies the effective sources before the client starts.

### Key Technical Decisions

- KTD5. **Bind approval to exact work, not to a chat phrase.** The approval names the plan and
  the roster it was given for, and a changed plan invalidates the binding.

## Implementation Units

### U3. Connect the framework catalog to bounded team assignments.

The unit owns the assignment projection, the recorded digest and the refusal path.

## Verification Contract

Focused tests cover direct assignment, the validation rejections, and the negative context
cases. No provider session starts.

## Definition of Done

The assignment carries exact identity, an invalid pack rejects before dispatch, and an observed
manifest that differs from the generated one blocks the launch.
