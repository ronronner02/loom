---
name: session-diagnostics
description: Read-only, evidence-grounded diagnostics for Multi-Agent runs and sessions. Use when a run stalled, repeated work, drifted from its plan/KTDs, or spiked in cost/time, and you need a forensic report citing exact artifact/transcript path:line evidence.
---

# Session & Run Diagnostics

Investigate what actually happened in a Multi-Agent run or coding-agent session by reading run artifacts, transcripts, and activity logs read-only, and produce an evidence-grounded forensic report.

**Core principle:** Every finding cites `path:line` (or `artifact:line`). No citation, no finding. Never modify run state, transcripts, or source files during diagnosis.

## Workflow

1. **Scope the problem:** Confirm the target run id / session, expected outcome, observed symptom (stall, repeated rework, plan/KTD drift, or token/time spike), and turn window.
2. **Locate artifacts (read-only):** Resolve run records, `lead-proposal.json`, `lead-escalation.json`, `task-report.json`, review reports, and attempt transcripts. Redact or omit any secrets, tokens, auth headers, or PII before excerpts enter model context or the report.
3. **Context safety:** Inspect line counts/sizes before reading; use bounded slices or targeted searches rather than loading multi-megabyte transcripts whole.
4. **Seven-dimension forensic triage:** Analyze across `skill-timeline`, `plan-adherence`, `repeated-work`, `stumbles`, `quality-evidence`, `request-conflicts`, and `cost-and-time`, discarding any claim lacking `path:line` evidence.
5. **Report:** Present findings with citations, explicit coverage gaps (e.g., missing attempt logs), and a concrete next-step recommendation without mutating project state.
