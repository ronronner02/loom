# Model-aware Flow members

## Decision

The lead is the only permanent character. Other characters appear for dispatched attempts that are running or have an unknown state, and leave when those attempts stop. Configured seats, allowed model choices, launch receipts without registered attempts, and historical task IDs are not additional members.

A character represents the model, independently of the execution client. DeepSeek through Claude Code uses the DeepSeek character; Grok and Qwen retain their characters through either supported client. The model and client identifiers remain available on the character's tooltip.

Model identity comes from the active attempt's observed telemetry first, then its matching launch record's observed or requested model. The persistent lead also uses its current model settings. A stopped lead's older model does not override a later settings change. Missing or unrecognized identities use the existing neutral mascot, never a role-based or randomly assigned vendor.

The current attempt snapshot owns membership and working state. Replay identities are correlated to those members and do not create extra characters. History stays in the event list without replaying expired message animations.

## Scope

Reuse the existing project settings, launch audit, and per-attempt telemetry endpoints. This changes presentation only: it does not launch tasks, change model permissions, alter client routing, or introduce a new public protocol.
