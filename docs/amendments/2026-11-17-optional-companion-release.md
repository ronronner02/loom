# Optional companion in the second desktop release

The owner requested the next Windows desktop package and publication of the existing companion system without personal credentials. The desktop shortcut identifies the installed Loom v0.1.0 application. The next package is v0.1.1.

- Release the current merged desktop source plus this scoped packaging change. Unrelated open pull requests remain outside the release branch.
- Keep the companion source in `companions/loom`, outside the engine workspaces and desktop runtime staging.
- Distribute it as a separate, optional source ZIP. Normal desktop startup remains local-only; no server address, account pairing, device key, or provider credential is shipped.
- The public ZIP uses an explicit source allowlist. Private deployment payloads, databases, backups, logs, QR images, and local runtime configuration are not release assets.
- Desktop-to-companion synchronization is not implemented in this release. The desktop retains execution authority; a later opt-in connector should relay request-bound phone interactions without replacing the local engine or sharing provider credentials.
- Preserve the operator's existing installed app, running companion, private configuration, and workspaces while building and verifying the release.
- Completion uploads accommodate JSON encoding of the existing 64,000-character result and 2,000-character error limits. Other control requests retain their existing body limit; a completed non-ASCII result must not stall all later runner work.
- Remove the user-specific path example from a packaged engine comment without changing runtime behavior.
