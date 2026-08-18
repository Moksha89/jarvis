# Jarvis

A local-first AI assistant for **Windows 11 x64**. Everything runs on your machine: a Tauri
desktop shell, a local TypeScript "Core" service, and local models served by Ollama. No
cloud calls, no telemetry.

This repository contains **Phase 0 + the MVP core scope only**, plus a front-loaded
computer-use feasibility spike. See [Out of scope](#out-of-scope-for-this-milestone).

## Architecture

```
apps/desktop         Tauri 2 + React + Vite shell (the only UI)
  src-tauri          Rust: window, CSP, native helpers
services/core        Jarvis Core: HTTP boundary, SQLite, tasks, permissions, audit, chat
services/adapters    ModelRuntimeAdapter (Ollama), AgentAdapter (Qwen Code) + stub
packages/ui          Fluent UI v9 design system (AppShell, Sidebar, PromptComposer, …)
packages/types       Shared contracts (risk, permissions, tools, chat, audit, tasks)
packages/events      Typed event bus
packages/permissions Permission engine: risk levels, profiles, path scopes
packages/tools       Tool registry + filesystem.* and shell.* tools
scripts/spike-computeruse  Throwaway Windows UI Automation feasibility spike
```

Two rules shape everything:

1. **The UI never talks to Ollama or Qwen.** It talks to Core over a typed HTTP boundary
   (`JarvisClient`, default `http://127.0.0.1:47821`), and Core owns the adapters.
2. **Permissions are enforced in code, not by prompting.** Every tool call goes through
   `PermissionEngine` + `ToolExecutor`; there is no path from a model to the filesystem or
   shell that bypasses them.

```
React UI ──HTTP/SSE──▶ Jarvis Core ──▶ PermissionEngine ──▶ ToolExecutor ──▶ tools
                            │                                     │
                            ├──▶ ModelRuntimeAdapter (Ollama)     └──▶ audit_events (SQLite)
                            └──▶ AgentAdapter (qwen serve | stub)
```

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 22.12 | |
| pnpm | 9.15.1 | `corepack enable && corepack prepare pnpm@9.15.1 --activate` |
| Rust | ≥ 1.77 (stable MSVC) | `rustup default stable-x86_64-pc-windows-msvc` |
| Microsoft C++ Build Tools | 2022 | "Desktop development with C++" workload |
| WebView2 Runtime | current | Preinstalled on Windows 11 |
| Ollama | ≥ 0.4 | Optional at launch; required for chat |
| Qwen Code | optional | Only if you want the agent path (`qwen serve`) |

## Setup

```powershell
pnpm install

# Optional: a local model for chat
ollama pull qwen2.5-coder:7b

# Terminal 1 - Jarvis Core (owns SQLite, adapters, tools)
pnpm dev:core

# Terminal 2 - desktop shell
pnpm tauri dev
```

`pnpm dev:desktop` runs the frontend in a plain browser instead, which is handy for UI work.

Environment variables understood by Core:

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_CORE_PORT` | `47821` | HTTP port |
| `JARVIS_DB_FILE` | `%APPDATA%\Jarvis\jarvis.sqlite` | SQLite location |
| `JARVIS_ENABLE_AGENT` | unset | Set to `1` to try the Qwen Code agent adapter |

The UI reads `VITE_JARVIS_CORE_URL` if you moved Core off the default port.

## What works in this milestone

- **Seven pages** — Home, Chat, Tasks, Models, Permissions, Activity, Settings, with a
  collapsible left nav. The app renders fully with no model installed; the Home system
  strip states plainly whether Ollama is missing, stopped or ready.
- **Streamed chat** — Markdown with syntax-highlighted code, copy, retry and regenerate.
  Modes are **Ask**, **Plan** and **Agent**.
- **Agent mode** — a bounded multi-step loop using Ollama's native function calling. Every
  tool call goes through `ToolExecutor`, so the permission engine, approvals and audit
  apply exactly as in chat. Steps, tool calls and pending approvals stream to the UI; the
  step budget is capped and runs can be cancelled.
- **Saved tasks and scheduler** — save a prompt and run it manually, every N minutes
  (minimum 5) or daily at a wall-clock time. Core runs at most two concurrent runs and one
  run per task, keeps run history with the run's conversation, recovers overdue schedules
  after a restart, and fails unanswered approvals closed after two minutes so an unattended
  run cannot hang.
- **Model management** — list, load, unload, pull (with streamed progress) and delete
  models, plus VRAM footprint and unload time for loaded ones.
- **Permission engine** — risk levels 0–4, `locked` and `balanced` profiles, opt-in folder
  scopes, remembered decisions, and a typed confirmation phrase (`I understand`) for
  level 3+. Level 4 is never granted automatically.
- **Tools** — `filesystem.list/read/write/delete` (delete goes to the Recycle Bin) and
  `shell.run/classify` with command classification (`READ_ONLY`, `NORMAL_WRITE`,
  `DESTRUCTIVE`, `SYSTEM`, `DANGEROUS`, `UNKNOWN`). Chained or piped commands are treated
  as `UNKNOWN` and require approval; dangerous commands are refused in code.
- **Audit** — every attempted tool action *and every permission change* (profile switch,
  rule and scope edits) writes an immutable row (time, tool, action, target, risk,
  permission decision + reason, result, reversibility) to SQLite, filterable on the
  Activity page.
- **Durable approvals** — a pending approval is reconstructed from SQLite, so restarting
  Core no longer orphans it.

### Permission model at a glance

| Level | Meaning | `locked` | `balanced` |
| --- | --- | --- | --- |
| 0 Safe | Reads only | allow | allow |
| 1 Low | Reversible write in an allowed folder | ask | allow |
| 2 Medium | Recoverable destructive change (Recycle Bin delete, move) | ask | ask |
| 3 High | Irreversible or system-affecting | deny | ask + phrase |
| 4 Critical | Security/integrity boundary | deny | deny |

Path scopes are **opt-in**: with no matching allow scope, filesystem tools are denied. A
deny scope always beats a less specific allow scope, and scopes are re-checked at execution
time (`PathGuard`), so revoking a scope kills an already-approved call.

### Which agent path was taken

`qwen serve` has no stable, documented protocol, so Core treats it defensively:

- `QwenCodeAgentAdapter` implements the full `AgentAdapter` interface (`createSession`,
  `send`, `cancel`, `approve`, `deny`, `getStatus`, `listTools`) against `qwen serve`,
  including optional daemon launch and health checks. It is **opt-in** via
  `JARVIS_ENABLE_AGENT=1` / the Qwen settings.
- By default Core uses `StubAgentAdapter` and routes chat **straight through the Ollama
  adapter**, so end-to-end streamed chat works with no agent installed. The Home strip
  shows which path is live ("Qwen Code" vs "Direct model").

## Computer-use spike

`scripts/spike-computeruse/` is a standalone Rust binary (not wired into Core) that probes
File Explorer, Windows Settings, Notepad, VS Code and Edge/Chrome through UI Automation
(`windows-rs`) with a GDI screenshot fallback, and writes a per-app reliability report.
See its [README](scripts/spike-computeruse/README.md). It has been run on Windows: all five
apps were found, every subtree walk finished under 320 ms, and `ValuePattern.SetValue` wrote
into Notepad — measured numbers and verdicts are in
[REPORT.md](scripts/spike-computeruse/REPORT.md).

## Verification status

Verified on Linux CI-style checks: `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`
(permission engine, shell classifier and Core tool-gating/audit integration tests),
`pnpm lint`, the frontend production build, and `cargo check --target x86_64-pc-windows-gnu`
for the spike.

Verified on Windows (Windows Server 2022 x64, Node 22.14, Rust MSVC, VS 2022 Build Tools,
WebView2, Ollama 0.32.14 + `qwen2.5:0.5b`): `pnpm tauri dev` launches the shell, all seven
pages render, Ask and Plan mode stream, `filesystem.delete` lands the file in the Windows
Recycle Bin (denied without a scope, approval-gated with one), and `shell.run`/`shell.classify`
classify and gate PowerShell correctly (`Get-Date` → READ_ONLY/allow, `Remove-Item` →
DESTRUCTIVE/ask, `format c:` → DANGEROUS/denied by profile). The spike numbers above are
from that machine.

Both gaps found during that run — unaudited permission mutations and pending approvals kept
only in memory — are now closed and covered by tests.

## Out of scope for this milestone

Deliberately not built: voice, browser automation, developer studio, memory/knowledge,
automations, skills/MCP, workflow builder, multi-agent orchestration, LAN companion, the 3D
orb and Lottie animations. Also explicitly excluded: any custom vector database, LLM
runtime, terminal emulator or browser engine — Jarvis integrates existing ones.

Secrets are never written to SQLite.

## Assumptions

The master spec attachment was unavailable when this milestone was built, so the risk model
(§33–36), the `JarvisTool` schema (§54) and the design tokens (§71) were implemented from
the descriptions in the task brief: risk levels as tabled above, a tool contract of
`{ id, name, version, category, description, baseRiskLevel, reversible, inputSchema,
describe(), execute() }`, and tokens covering a 4px spacing grid, 4/8/12px radii and
100/200/300ms motion durations. Reconcile against the spec when it is available.
