<div align="center">
  <img src="engine/packages/ui/public/loom-icon.png" alt="Loom" width="88" height="88" />
  <h1>Loom</h1>
  <p>
    <strong>Chat-first multi-agent orchestration for coding teams — with traceable tasks, independent reviews, and verifiable execution evidence.</strong>
  </p>
  <p>
    <a href="#installation">Installation</a> •
    <a href="#features">Features</a> •
    <a href="#architecture">Architecture</a> •
    <a href="#development">Development</a> •
    <a href="#operations">Operations</a>
  </p>
</div>

---

## Overview

**Loom** is a local-first desktop and web command center for coordinating native coding assistants (**Claude Code** and **Codex**) on real repositories. Create or register a GitHub-backed project from a local folder, agree on a plan and specialist roster with the Lead agent in chat, monitor live task execution and diffs, and review or merge delivered pull requests into your branch.

The orchestration engine lives in `engine/` and runs natively as a supervised child process inside the Windows desktop app (`desktop/`), or standalone on Linux/macOS.

---

## Features

- **Chat-First Command Center**: Centered conversation stream with inline plan approval, decision prompts, and workflow outcomes, paired with a slim `64px` navigation rail (`Chat`, `Overview`, `Tasks`, `Workspace`, `Documents`) and an on-demand `320px` status & context panel.
- **Native Windows Desktop & Bundled Runtime**: Runs the Node.js engine natively on Windows 10/11 x64 with a bundled `gh.exe` CLI and per-user NSIS installer—no WSL2 or `tmux` required.
- **Owner & Dedicated Agent GitHub Accounts**: Authenticate your personal GitHub account via device flow and optionally configure a dedicated agent GitHub account for automated PR delivery, issue intake, and review routing.
- **Traceable Tasks, Flow & Reviews**: Searchable task list and dependency-stage board, live tool-call workspace, execution flow replay, unified diffs, and independent read-only review gates.
- **Configurable Agent Governance**: Customize model policies (`claude-code` / `codex`), specialist `SOUL` profiles, prompt sections (`Communication`, `Scope`, `Delivery`), and GitHub Issue auto-intake rules in **Settings → Agents**.
- **Light & Dark Themes**: Warm neutral light canvas (`#FAF8F5`) by default with full dark theme (`#171615`) and system-following support, plus English and Simplified Chinese (`zh-CN`) localization.

---

## Installation

### Windows Desktop (Recommended)

1. Download **`Loom-Setup-0.1.1-x64.exe`** from the [GitHub Releases](../../releases) page.
2. Run the per-user installer (no administrator elevation required).
3. Ensure **Git for Windows** and **Node.js 22 or 24** are installed, and sign in locally to **Claude Code** (`claude`) and/or **Codex** (`codex`) for the assistants you plan to use.
4. Launch **Loom** and complete the GitHub device sign-in when prompted.

> **Data & State Locations (Windows)**
> - Application state: `%LOCALAPPDATA%\Multi-Agent` (SQLite database: `multi-agent.sqlite`)
> - Configuration: `%APPDATA%\Multi-Agent`
> - Overrides: `MULTI_AGENT_HOME` (engine root), `MULTI_AGENT_DESKTOP_DATA_DIR` (desktop root)

### Optional self-hosted companion

The separate **`Loom-Companion-0.1.1.zip`** source bundle provides a server scheduler, a dedicated local runner, and mobile reply pages. It is optional: installing or starting the desktop does not connect to a companion or configure a server.

Each operator supplies their own HTTPS host, credentials, and notification channel. No personal server configuration or account pairing is distributed. The companion's tasks are currently independent of desktop teams; automatic desktop-to-phone synchronization is not included in this release. See the [companion setup](companions/loom/README.md) and [integration boundary](companions/loom/INTEGRATION.md).

---

## Quick Start (From Source)

### Prerequisites

- **Windows 10/11 x64** (or Linux)
- **Node.js 22 or 24** & **npm**
- **Git** on `PATH`
- **Claude Code** (`claude`) and/or **Codex** (`codex`) signed in locally

### Build & Run Desktop

```powershell
cd engine
npm ci --no-audit --no-fund
npm run build

cd ../desktop
npm ci --no-audit --no-fund
npm start
```

The desktop host spawns the local engine on an ephemeral loopback port, pairs the window automatically via an `HttpOnly` session cookie + CSRF token, and verifies local dependencies on startup. See [desktop/README.md](desktop/README.md) for packaging details.

### Build & Run Engine on Linux

```bash
./setup.sh
./scripts/start.sh
```

After `./setup.sh` completes, use `engine/node_modules/.bin/multi-agent --help` for CLI commands.

---

## Usage Workflow

### 1. Sign In & Create a Project
1. Open **Loom** and choose **Sign in to GitHub → Open GitHub** to authorize via device code.
2. Click **Create project** (or **Open existing**), pick a local folder, and review the resolved files and exclusions.
3. For a new folder, Loom initializes Git, adds a default `.gitignore` if missing, creates the initial commit, provisions a **private** GitHub repository, and pushes `origin`.

### 2. Plan & Deliver
1. Describe your goal in **Chat** (or click **New work**).
2. Collaborate with the Lead agent as it drafts the plan and proposes specialist seats.
3. Click **Approve plan** to grant scoped execution and dispatch worker turns.

### 3. Monitor, Review & Merge
- **Overview**: Run summary, system health, live **Flow** replay, PR merge controls, and 7/30-day native token **Usage & Analytics**.
- **Tasks**: Searchable task workbench with attempt history, worker reports, owner comments, hold/resume controls, and dependency **Board**.
- **Workspace**: Live agent seats and tool activity, Project **Inbox** (GitHub Issues), and **Reviews & Diffs**.
- **Documents**: Versioned Exploration, Requirements, and Plan documents with side-by-side comparison.

### CLI Equivalent

```bash
multi-agent github status
multi-agent team create /absolute/path/to/project --name project-name --dry-run
multi-agent team create /absolute/path/to/project --name project-name
multi-agent team start "Describe the change you want" --planning --rig <team-name>
multi-agent team chat <run-id>
multi-agent team chat <run-id> "Your answers and requested changes"
multi-agent team approve-plan <run-id>
multi-agent team resume <run-id>
multi-agent team merge <run-id>
```

---

## Architecture

| Directory | Description |
| --- | --- |
| `engine/packages/daemon` | Hono HTTP/SSE control plane, SQLite state store, worker supervisor, Git/GitHub CLI integration |
| `engine/packages/ui` | React + TanStack Router + TanStack Query + Lucide command-center web UI |
| `engine/packages/cli` | `multi-agent` CLI entrypoint and browser pairing command |
| `engine/packages/i18n` | English (`en`) and Simplified Chinese (`zh-CN`) translation catalogs |
| `desktop/` | Electron desktop wrapper, native folder picker, dependency probe, and Windows NSIS packager |
| `companions/loom/` | Optional self-hosted scheduler, separate local runner, and mobile reply forms; not part of desktop startup |
| `docs/` | Architecture, [design system](docs/design/command-center/DESIGN.md), [operations guide](docs/operations.md), and validation records |

---

## Development & Testing

```bash
# Build all engine packages
cd engine && npm run build

# Run UI unit & router integration tests
cd engine/packages/ui && npx vitest run src/team/__tests__

# Run desktop unit & packaging tests
cd desktop && npm test

# Build Windows NSIS installer (outputs to desktop/dist/)
cd desktop && npm run dist
```

---

## Operations & Documentation

- [Operations Guide](docs/operations.md) — GitHub sign-in, project creation, recovery, workflows, and budget controls
- [Design System](docs/design/command-center/DESIGN.md) — Color tokens, typography, spacing, layout, and accessibility rules
- [Desktop Packaging](desktop/README.md) — Engine staging, bundled `gh.exe` verification, and NSIS build configuration
- [Validation Records](docs/validation/2026-11-07-command-center/acceptance.json) — Acceptance evidence and runtime verification

## License

See [LICENSE](engine/LICENSE) and [NOTICE](NOTICE) for license and third-party attribution details.
