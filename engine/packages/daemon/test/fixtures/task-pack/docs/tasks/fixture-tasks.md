---
title: "Assignment binding - Tasks"
type: "task-pack"
status: "derived"
date: "2026-10-13"
source_plan: "docs/plans/fixture-plan.md"
source_plan_hash: sha256:70706aa1985ee6fc5ea6674542a430a454b00e61637592e3609b27e4e2a6fc43
generated_by: "spec-write-tasks"
mode: "derived"
target_repo: "loom/loom"
---

# Assignment binding - Tasks

This fixture is one bounded task pack derived from a single-unit plan. The daemon suite's
upstream-validator case reads it through the real `spec-first tasks validate` receipt, so the
pack has to keep the artifact contract the validator checks: canonical frontmatter, a source
plan hash taken over the plan body, and one executable task.

## Task Pack Contract

```json
{
  "schema_version": "task-pack/v1",
  "execution_waves": [
    {
      "wave": 1,
      "tasks": [
        "T007"
      ]
    }
  ],
  "tasks": [
    {
      "task_id": "T007",
      "source_unit": "U3",
      "requirement_refs": [
        "R4",
        "R5",
        "KTD5"
      ],
      "goal": "Bind scoped assignments to immutable effective-context manifests.",
      "dependencies": [],
      "target_repo": "loom/loom",
      "files": [
        "engine/packages/daemon/src/domain/team-assignment.ts",
        "engine/packages/daemon/test/team-assignment.test.ts"
      ],
      "context_refs": [
        "docs/plans/fixture-plan.md#framework-and-native-session-integration"
      ],
      "entry_hint": "Start with the task listed source owners.",
      "test_focus": "Direct plan assignment with minimal staffing; repository, path, role, dependency, output and permission validation; an immutable projected context with negative ancestor and global contamination cases.",
      "done_signal": "Assignments carry exact plan, repository and policy identity; stale or invalid packs reject before dispatch; generated and observed context hashes are recorded and an unexpected launch source blocks the work.",
      "wave": 1,
      "parallelizable": false,
      "stop_if": "Stop if the source plan is no longer active, its canonical body hash differs, repository identity is unresolved, or the work needs an undeclared mutation path.",
      "review_gate": "required",
      "review_focus": "Check source and runtime separation, and scope preservation through projected instructions."
    }
  ]
}
```

## Task Cards

### T007. Bind scoped assignments to immutable effective-context manifests.

- **Source / requirements:** `U3`; `R4`, `R5`, `KTD5`.
- **Target / wave / dependencies:** `loom/loom`; wave 1; none.
- **Goal:** Bind scoped assignments to immutable effective-context manifests.
- **Files:** `engine/packages/daemon/src/domain/team-assignment.ts`; `engine/packages/daemon/test/team-assignment.test.ts`.
- **Test focus:** Direct plan assignment with minimal staffing; repository, path, role, dependency, output and permission validation; an immutable projected context with negative ancestor and global contamination cases.
- **Done signal:** Assignments carry exact plan, repository and policy identity; stale or invalid packs reject before dispatch; generated and observed context hashes are recorded and an unexpected launch source blocks the work.
- **Stop if:** Stop if the source plan is no longer active, its canonical body hash differs, repository identity is unresolved, or the work needs an undeclared mutation path.
