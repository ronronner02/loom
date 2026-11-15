# Command-center design

This is the shared token contract for the browser and desktop command center, aligned with the Muse-style chat-first design specification (`docs/Muse_UI_设计文档.md` and `docs/design-spec-muse-style.pdf`).

## Color tokens

Light (`#FAF8F5`) and Dark (`#171615`) share the exact same semantic token vocabulary; `system` follows the operating system. Surfaces are solid and layered with `1px` subtle borders instead of decorative glassmorphism or background skins. Raw hex colors belong only in these CSS token definitions, never in components or selector rules.

| Token | Dark | Light |
| --- | --- | --- |
| `--ui-canvas` | `#171615` | `#faf8f5` |
| `--ui-surface` | `#22211f` | `#ffffff` |
| `--ui-surface-subtle` | `#1c1b19` | `#f3f0ea` |
| `--ui-raised` | `#2a2825` | `#ffffff` |
| `--ui-divider` | `#33312e` | `#e8e2d9` |
| `--ui-divider-soft` | `#292724` | `#f0ece4` |
| `--ui-text` | `#f2f0eb` | `#1c1b1a` |
| `--ui-text-secondary` | `#cfcac2` | `#4b4843` |
| `--ui-muted` | `#a8a29a` | `#6e6a64` |
| `--ui-faint` | `#7e7972` | `#8c877f` |
| `--ui-selection` | `#2f231e` | `#f5ece6` |
| `--ui-accent` | `#d9734a` | `#bc5a32` |
| `--ui-accent-press` | `#e58963` | `#a14b28` |
| `--ui-on-accent` | `#171615` | `#ffffff` |
| `--ui-accent-soft` | `#2e201a` | `#fbf0eb` |
| `--ui-ok` | `#6ea07d` | `#5a7a64` |
| `--ui-warn` | `#e0a84c` | `#b7791f` |
| `--ui-warn-soft` | `#2e2414` | `#fdf6e9` |
| `--ui-warn-border` | `#6e5225` | `#e6c891` |
| `--ui-error` | `#f87171` | `#b42318` |
| `--ui-error-soft` | `#341b1b` | `#fef2f2` |
| `--ui-add-bg` | `#1a2e22` | `#edf5ef` |
| `--ui-add-ink` | `#86d9a0` | `#2d6a42` |
| `--ui-remove-bg` | `#341b1b` | `#fef2f2` |
| `--ui-remove-ink` | `#f8a4a4` | `#b42318` |
| `--ui-user-bubble` | `#242b20` | `#eef3e7` |
| `--ui-ai-bubble` | `#242320` | `#f2efe9` |
| `--ui-overlay` | `rgb(0 0 0 / .55)` | `rgb(28 27 26 / .28)` |
| `--ui-shadow` | `rgb(0 0 0 / .32)` | `rgb(28 27 26 / .08)` |

The `--paper`, `--surface`, `--ink`, `--line`, `--accent`, attention, error and diff variables used by the retained screens alias the corresponding semantic tokens in `team.css`.

## Type, spacing and layout

- **Typography (4 levels)**: Display `28px / 1.25 (600)`, Title `18px / 1.35 (600)`, Body `15px / 1.6 (400)`, Caption `12px / 1.5 (400)`. System font stack with self-hosted `Inter` + CJK fallbacks (`PingFang SC`, `Microsoft YaHei`, `Noto Sans CJK SC`) and `IBM Plex Mono` for code, diffs and hashes.
- **4pt spacing grid**: `4px`, `8px`, `12px`, `16px`, `24px`, `32px`.
- **4-level radius**: `8px` (buttons, inputs, tags), `12px` (cards, panels), `16px` (message bubbles, modals, sheets), `9999px` (pill headers, segmented controls, floating composer).
- **Icons**: Unified `lucide-react` outline icons (`20px` standard, `24px` rail navigation, `1.75px` stroke, rounded caps).
- **Motion**: `150ms` instant feedback, `200ms` small element, `260ms` panel/page, `ease-out`, no bounce, and `prefers-reduced-motion` disables transitions/animations.
- **Information Architecture (5 top-level entries, chat-first)**:
  1. `chat` (Chat / 对话) — Default home. Centered `max-width: 820px` conversation stream, inline decision/plan cards, floating pill composer.
  2. `overview` (Overview / 总览) — Run progress, PR delivery/merge, system health, Flow view, and usage analytics.
  3. `tasks` (Tasks / 任务) — Task list/board, nested workbench, and task drawer (with owner comments & hold).
  4. `workspace` (Workspace / 工作区) — Agent seats, live tool activity, Project Inbox (GitHub Issues), and Reviews & Diffs.
  5. `documents` (Documents / 文档) — Exploration / Requirements / Plan versions, comparison, and confirmation.
- **Global Search & Settings**: Search (`Ctrl+K` / `Cmd+K`) and Settings (`Ctrl+,` / `Cmd+,`, including Dedicated Agent GitHub Account & Issue Intake rules) live on the rail/modal rather than occupying top-level navigation tabs.
- **On-demand Right Context Panel (`320px`)**: Toggled from the agent identity pill in the top bar; displays agent status, pending owner decisions/questions, and run progress without shifting the main column.
- **Responsive breakpoints**:
  - `>= 1200px`: `64px` left icon rail + main column + dockable `320px` right context panel.
  - `860px–1199px`: `64px` left icon rail + main column, context panel as overlay drawer.
  - `< 860px`: `52px` top bar + full-width main column + `56px` fixed 5-tab bottom navigation bar.
