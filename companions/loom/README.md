# Loom companion (optional)

This is a separate, self-hosted companion for the Loom desktop app. Installing or launching the desktop app does not enable it, deploy a server, or connect to any preconfigured host. Download the optional companion source bundle only if you want to operate your own scheduler, local runner, and mobile reply pages.

The current runner executes tasks independently of the desktop engine. Desktop-created teams and approval requests are not synchronized with this companion yet. See [Desktop integration](INTEGRATION.md) for the current boundary and the intended connection model.

No working server address, account pairing, password, API key, provider configuration, or private workspace is included. Each operator creates their own private configuration outside this source directory.

A single-owner task queue with local execution and a phone-sized control page. The server stores tasks and interactions; a Windows runner polls over HTTPS and executes only in workspaces listed in its private local configuration.

## Components

- **Control service:** task queue, runner authentication, mobile dashboard, and interaction proxy.
- **Local runner:** the installed Codex structured runtime, one task at a time, with an outbound connection only.
- **Ask4Me:** expiring forms for questions and one-request operation approvals.
- **Notification transport:** configured separately. Missing delivery configuration fails questions closed; it never grants an approval.

The server does not receive the local provider configuration or credentials. It does receive task prompts, question/approval details, responses, and final results. Notification messages contain a generic description and a bearer interaction link. Treat those links as private. This is not end-to-end encryption or hardened isolation from malicious code running under the local OS account.

## Network layout

| Endpoint | Binding |
| --- | --- |
| Public HTTPS | Existing reverse proxy, TCP 443 |
| Control service upstream | `127.0.0.1:18760` |
| Ask4Me | Docker network only, port 8080 |
| Optional AstrBot admin | `127.0.0.1:18761`; SSH tunnel only |
| Windows runner | Outbound HTTPS; no listening port |

Forward the dedicated hostname to `http://127.0.0.1:18760`. Preserve `/control/`, `/r/`, and `/static/` paths and query strings. Disable caching on this hostname. Public port 80 may be used for HTTPS redirection/certificate validation. Do not expose the application upstream or interaction backend directly.

## Build and verify

Use Node 24 and Python 3.11 or newer for local setup and packaging. Set temporary and package-cache directories to a disk with sufficient space before running these commands.

```powershell
npm.cmd ci
npm.cmd run typecheck
cmd.exe /d /c 'npm test < NUL'
cmd.exe /d /c 'python -m unittest discover -s scripts -p test_*.py -v < NUL'
```

The subprocess protocol test is a fixture, not a real model/phone acceptance test. Verify the installed runtime and the deployed notification flow separately.

## Public source bundle

The release ZIP contains source, tests, and setup scripts. It has no dependencies, compiled runtime, or private configuration; run the build steps above after extracting it. Keep the private setup directory outside both the source checkout and the extraction directory.

To reproduce that public bundle from this directory:

```text
python scripts/package_release.py --output OUTPUT.zip
```

This command reads an explicit source-file allowlist and rejects linked inputs. It never reads a private setup directory. `scripts/deploy.py` is different: it creates an authenticated SSH deployment payload containing that operator's server credentials. Never publish a deployment payload, runtime directory, backup, or exported server environment as a release asset.

## Private local setup

Create an owner-restricted directory outside this repository. On Windows, restrict its ACL to the current user and SYSTEM. Put this file at `PRIVATE_DIR/setup.json`:

```json
{
  "publicUrl": "https://HOST",
  "serverchanSendKey": ""
}
```

Leave notification credentials out of chat and source control. Keep the SendKey empty when using AstrBot; its transport is connected after WeChat pairing. Until a transport is connected, questions fail closed. Then run:

```text
python scripts/configure-local.py --private-dir PRIVATE_DIR --workspace WORKSPACE --codex-home ORIGINAL_CODEX_HOME --codex-entry CODEX_JS_ENTRY --node NODE_EXE --temp-dir TEMP_DIR --npm-cache NPM_CACHE
```

This creates separate owner, runner, and backend keys, a restricted local runtime configuration, and `runner.json`. It stops if runner configuration already exists. It copies only the selected provider settings and local authentication, not the original runtime's tools, hooks, workspace rules, or other project configuration. Provider environment credentials remain local when required by that provider.

The dedicated workspace is the initial execution boundary. Add other directories only by explicitly editing the local workspace list. The scheduler accepts workspace IDs, not arbitrary filesystem paths.

## Initial server installation

The remote account needs Docker access. The installer creates `~/loom`, two named containers, and a dedicated Docker network; it leaves host Node, existing containers, and proxy configuration unchanged. It stops if those application resources already exist.

```text
python scripts/deploy.py --host USER@HOST --identity SSH_IDENTITY_FILE --private-dir PRIVATE_DIR
```

The package is streamed through SSH stdin. Only compiled server files, web assets, and the explicit server-side configuration are included. The SSH private key, `runner.json`, and local provider credentials are not uploaded. Container images are digest-pinned. Data persists in `~/loom/data/`; server configuration lives in the restricted `~/loom/secrets/` directory.

## WeChat through AstrBot

The optional transport uses AstrBot's Personal WeChat adapter and IM Open API. The pinned release is **v4.29.4**, not an alpha/nightly image. It needs no inbound WeChat callback port. Its server-side model processing is disabled; the Windows machine still owns task execution.

After pulling the pinned image on the server, install the new instance:

```text
docker pull soulter/astrbot@sha256:72f341f0ffcf6621ef820277642c5d63955f7beeac3683433ce09cac96379c78
python scripts/deploy-astrbot.py --host USER@HOST --identity SSH_IDENTITY_FILE --private-dir PRIVATE_DIR
```

The pull command runs on the server; the Python command runs locally. Installation creates `loom-astrbot`, `~/loom/astrbot/data/`, and separate private admin/notification configuration. The generated admin password is in local `PRIVATE_DIR/astrbot-admin.json`; it is not printed. The notification API key has only the `im` scope, not dashboard/configuration permissions.

For administration, open a foreground SSH tunnel and leave it running:

```text
ssh -N -L 127.0.0.1:18761:127.0.0.1:18761 -i SSH_IDENTITY_FILE USER@HOST
```

Then open `http://127.0.0.1:18761` on that computer. In **Platforms → Add Adapter → Personal WeChat**, scan and confirm the QR code with your phone, then save. Send one message to the newly linked bot so WeChat provides a reply context. Pair only that owner's private session as the notification recipient. No group or first-unidentified-sender auto-pairing is used.

`notify_astrbot.py` implements Ask4Me's Apprise command interface using the private AstrBot API. Its private configuration is mounted at `/run/secrets/astrbot-notify.json`; an empty `umo` fails closed. Enable the transport only after the owner's recipient and reply context are confirmed. The IM API accepting a message is not proof that the phone received it; verify delivery on the actual phone. WeChat may require a fresh message from the owner when its reply context expires.

The API-based pairing procedure used during deployment saves the successful QR-login result privately at `~/loom/secrets/wechat-confirmed.json`. The connector checks that receipt against the enabled adapter and requires a reply context for that exact owner; another sender or a group is not selected automatically. Manual dashboard pairing alone does not create this receipt.

The bundled AstrBot connector is an advanced setup path, not an automatic QR-login wizard. The operator must supply their own successful API pairing receipt on the server before running it. No receipt or personal pairing from an existing deployment is distributed. The ServerChan setup above does not require this receipt.

After that pairing and the owner's first private message:

```text
python scripts/connect-astrbot.py --host USER@HOST --identity SSH_IDENTITY_FILE
```

The upstream Ask4Me image has no Python executable. `Dockerfile.ask4me` adds Python and the notification adapter to the digest-pinned base, without copying any secrets into the image. The connector builds and checks this image, checks that no task or interaction is active, and recreates only `loom-control` and `loom-ask4me`. Their data, loopback binding, non-root user, read-only roots, and resource limits are preserved. Only the private notification configuration is mounted into Ask4Me; the scheduler environment is not mounted there.

The connector sends a generic test message. Confirm receipt on the actual phone, then run a real local task that calls `ask_owner` and verify that its form response returns to that same call. A successful direct test message does not establish the full task/form path.

The stopped originals are retained as `loom-control-before-astrbot` and `loom-ask4me-before-astrbot`; original private configuration is retained in `~/loom/secrets/before-astrbot/`. These preserve the earlier container configuration, not a point-in-time database backup. Do not start the originals alongside their replacements: they use the same data directories. A repeated connector invocation stops for inspection rather than overwriting those recovery resources.

WeChat carries the notification link. Questions and approvals are answered on the expiring form; task submission and results are available in the mobile dashboard.

## Start and stop the Windows runner

```powershell
.\scripts\start-runner.ps1 -ConfigPath PRIVATE_DIR\runner.json
.\scripts\stop-runner.ps1 -ConfigPath PRIVATE_DIR\runner.json
```

Start launches a hidden process, not a Windows startup task. Stop checks process identity and terminates only that runner's process tree. Cancel a task in the dashboard first when possible; forced stop may interrupt a file operation. Neither command changes power settings. Keep the computer awake and connected for execution.

For an interactive foreground session with normal Ctrl+C shutdown:

```text
node dist/runner.js PRIVATE_DIR/runner.json
```

Private runner state contains its lock, logs, and an unsent final result if an upload failed. Do not publish that directory: a pending result contains a job capability. On reconnect it retransmits the result, not the execution. On runner replacement, active work is marked interrupted rather than replayed. Unacknowledged claims expire after 60 seconds. Running tasks are not automatically retried.

## Use from your phone

1. Open `https://HOST/control/` and sign in using `ownerKey` from the local private `access.json`. Keep the key out of URLs and messages.
2. Wait for the workstation to show **Connected**, enter a bounded task, and select **Run locally**.
3. Open a notification's interaction link to answer a question or approve/reject the described operation. Approval defaults to rejection and applies only to that request.
4. Read the result in the task list. **Cancel task** stops execution when the runner receives cancellation; it does not undo completed file operations.

Phone login uses an HttpOnly, Secure, SameSite cookie lasting up to seven days. Restarting the control service invalidates sessions. The runner key and backend key do not grant dashboard access, and a job token does not disclose the owner's interaction link.

## Operations and acceptance

Check service status without dumping container environment variables:

```text
docker ps --filter label=io.loom.stack=loom
curl http://127.0.0.1:18760/healthz
docker logs --tail 30 loom-control
```

To stop only this server deployment, use `docker stop loom-control loom-ask4me`. Keep its data and secrets directories for recovery. Back up the persistent SQLite data while the two application containers are stopped; do not copy an actively written database without a consistent SQLite backup procedure. Restarts, updates, and deletions of other services are outside these commands.

Before declaring end-to-end acceptance, verify all of the following independently: source tests/typecheck, deployed HTTPS health, a real local task, a delivered notification, the owner's actual phone reply, approve/reject behavior, cancellation, and result display. An HTTP health check or simulated callback alone is not that acceptance.
