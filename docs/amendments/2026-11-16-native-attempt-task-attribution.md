# Native attempt task attribution

## Decision

A native launch already records its assigned task in the daemon-written
`attempt.submitted` lifecycle event before spawning the child. Receipt registration
uses that fact, keyed by both run ID and attempt ID, instead of inferring a native
task solely from the seat's queue.

The named task must still be live, belong to the receipt's run, and target the
receipt's seat. Apply this identity filter before the ambiguity limit, so the
third or later queued task is as eligible as the first. A task stamp that does not
match the seat is not permission to attach the attempt to another task.

Older pane stamps keep the same exact-task rule. When no task stamp is available,
registration still requires exactly one live task on the seat.

This reuses existing durable evidence. Receipt formats, public contracts, launch
approval, cancellation, and retry policy remain unchanged.
