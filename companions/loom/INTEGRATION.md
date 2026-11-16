# Desktop and companion integration

## What works in this release

The desktop app and the optional companion are independent:

- The desktop owns its local engine, projects, team runs, agent processes, and native approval flow.
- The companion owns its separate task queue and expiring mobile reply forms. Its configured local runner executes in explicitly registered workspaces.
- A phone can submit a task through the companion dashboard and answer that companion task's questions through a notification link.
- Installing the desktop app does not start the companion, install server services, copy credentials, or enable an outbound connection to an operator's server.

Use a dedicated companion workspace. Do not give the companion runner and a desktop-managed team concurrent ownership of the same task or worktree. The companion does not currently resume an existing desktop run or forward a desktop approval to a phone.

## Connecting an existing private deployment

An operator who already has a working companion should retain the existing server data, local runner configuration, credentials, and notification pairing. Publishing or upgrading the desktop package does not migrate that deployment or change its keys. Continue using the companion dashboard for its tasks and the desktop window for desktop teams.

Do not rerun the initial installers against an existing deployment: they intentionally stop when their named resources already exist. Do not copy another operator's configuration or QR-login receipt. Keep server credentials on that server and model-provider credentials on the machine that executes the work.

## Intended optional connection model

Direct desktop integration is a separate implementation, not a configuration option in v0.1.1. The intended division of responsibility is:

```text
Phone <-> Operator's HTTPS companion <-> Outbound desktop connector <-> Local team engine
```

The connector would be explicitly enabled by the user. The user would enter their own server address and enroll this device; the public installer would have no default personal server or shared credential. Device credentials belong in per-user protected storage, not source files, URLs, release assets, or logs.

The desktop engine would remain authoritative for execution and approvals. The companion would deliver only the selected question, necessary operation details, and task status. A phone reply would return to the exact pending local request, with request identity, expiration, and duplicate-response checks. Reconnecting must not replay completed commands or silently grant an approval. Disconnecting should leave the desktop's normal local interaction available.

Mobile-created desktop work would need a separate, explicit admission step through the desktop engine. The standalone companion runner must not also execute that work. The public server must never receive the desktop's local owner-session cookie, model-provider keys, or arbitrary filesystem access.

Before that connector is enabled, verify one real desktop question end to end: local request, phone notification, reply, and continuation of the same task exactly once. Also verify rejection, expiration, disconnection, and device revocation. Until then, the two working systems should not be described as synchronized.
