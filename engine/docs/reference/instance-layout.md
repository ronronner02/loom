# Multi-Agent instance layout

A Multi-Agent instance keeps its managed state under one configured
`$MULTI_AGENT_HOME`. `multi-agent daemon start` and a direct daemon first start reconcile the
same additive layout before the database is opened or the listener binds.

```text
$MULTI_AGENT_HOME/
  config.json             # typed instance settings; created as an empty object
  state/                  # runtime-owned durable state
  context/                # addressable context library (`context.root`)
    system/
      system-world.yaml   # selected baseline context
  skills/                 # managed skill catalog (`skills.root`)
  workspace/              # project work tree (`workspace.root`)
  specs/                  # instance spec library
  topology/               # instance, team and seat continuity tree
  plugins/                # installed plugins
  run/                    # process coordination files
  logs/                   # daemon and operation logs
  transcripts/            # durable per-seat terminal transcripts
  backups/                # operator-created recovery artifacts
  secrets/                # local connector and host secrets
```

The initializer creates only missing managed entries. It never overwrites an existing file,
and it checks every managed path before the first write. A path with the wrong type is
reported by its exact location; unrelated user-owned content is preserved. A second run
against an already-converged instance writes nothing. `skills/` and `topology/` are created
as empty roots; their respective catalog and topology workflows own their contents.

## Settings

Every typed setting resolves from its environment variable first, then the configuration
file, then its default. The engine serves the resolved values to the desktop app's Settings
screen, and that screen is the supported way to change one; a hand-edited `config.json` is
read the same way but is not the intended path.

| Surface | Value |
| --- | --- |
| Config key | `context.root` |
| Environment | `MULTI_AGENT_CONTEXT_ROOT` |
| Default | `$MULTI_AGENT_HOME/context` |

The removed `context.packs_root`, `context.packsRoot` and `MULTI_AGENT_CONTEXT_PACKS_ROOT`
spellings are refused with guidance to use `context.root`; they are not compatibility
aliases.

## Atomic config updates

Config updates publish a complete replacement file atomically where directory permissions
and the filesystem allow it. On POSIX systems, replacement preserves the existing owner,
group, and read/write/execute permission bits. If creating or preparing the replacement, or
renaming it, fails with `EACCES`, `EPERM`, or `EBUSY`, the stores write the writable target in
place, preserving compatibility with unwritable directories and single-file bind mounts. This
fallback is not atomic and retains the previous partial-write risk. Read-only config files
are refused. Other errors, including `ENOSPC`, leave the original file intact on the atomic
path. Atomic replacement does not carry extended ACLs or other inode metadata; a hard-linked
second name continues to refer to the previous file.

## Data directories

On Windows, mutable state is under `%LOCALAPPDATA%\Multi-Agent` and configuration under
`%APPDATA%\Multi-Agent`. Other platforms use `~/.multi-agent` for both. `MULTI_AGENT_HOME`
overrides the state root for an isolated process. Legacy product directories and environment
names are not read.