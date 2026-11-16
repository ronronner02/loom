---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions or replying - requires verifying each finding against actual code, callers, KTDs, and tests with technical rigor instead of performative agreement
---

# Receiving Code Review

Code review requires technical evaluation, not emotional performance.

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

## The Response Pattern

```text
WHEN receiving review feedback:
1. READ: Complete feedback without reacting
2. UNDERSTAND: Restate requirement in own words (or ask)
3. VERIFY: Check against codebase reality, callers, KTDs, and tests
4. EVALUATE: Technically sound for THIS codebase and task scope?
5. RESPOND: Technical acknowledgment or reasoned pushback
6. IMPLEMENT: One item at a time, test each
```

## Forbidden Responses

NEVER use performative agreement ("You're absolutely right!", "Great catch!", "Thanks for catching that!") or blind acceptance. State the fix with evidence or push back with technical reasoning.

## When to Push Back

Push back when:
- The suggestion breaks existing functionality or callers
- The reviewer lacks full context or misread a file/line
- The suggestion violates an approved KTD, architectural boundary, or YAGNI
- The change expands beyond the task's assigned write scope

If a finding is factually wrong or conflicts with an approved KTD inside a managed run, pause and report technical evidence (`task-report.json` or lead chat) rather than applying a harmful edit.
