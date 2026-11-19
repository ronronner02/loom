# Decision register fixture

The planted-defect fixtures under this directory cite decision IDs. A planted defect may only
claim a decision that the team's governance actually made, so `role-charter.test.ts` requires
every cited ID to appear here, in the plan's own `- ID. ` bullet form.

This is the three decisions the fixtures exercise, restated. The full register lives in the
engineering-team plan in git history.

- KTD8. **Isolate changes and review the exact candidate.** Each task's work happens in its own worktree, and a reviewer reads the exact candidate the implementer produced, not the integration branch.
- KTD21. **Bound the Lead's operating loop.** The Lead proposes and asks; it never reviews, accepts or merges work itself. Review and acceptance stay with a separate reviewer and the owner.
- R21. Role and task context must exclude unrelated project data and raw credentials, and project changes must remain within the authorized repository and file scope.