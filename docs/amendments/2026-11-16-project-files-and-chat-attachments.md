# Project files and chat attachments

## Decision

The owner approved project-level file browsing and chat attachments on 2026-11-16.
Both work before the first conversation and preserve the original project files.

- Workspace gains a Files view. It is the default there when the project has no run.
  The existing five top-level destinations stay unchanged.
- The owner-only project file read uses the registered repository root and the
  existing bounded workspace reader. It never accepts an arbitrary root, edits a
  file, starts a run, or follows a linked path outside that reader's rules.
- Chat accepts up to eight attachments per message, each up to 10 MiB. Selection
  stays in the draft until Send. Accepted uploads live in per-user application
  state, separately from the repository.
- The existing durable conversation records attachment references. Initial and
  follow-up lead prompts identify the uploaded files and their readable paths.
  Attachments are task data, not execution approval.
- Text preview reuses the current 256 KiB limit. Binary files remain attachable;
  the selected client's own file-reading capabilities determine interpretation.

## Boundaries

No file editing, folder synchronization, document conversion, new dependency,
provider request, release, deployment, or Windows export is included.
