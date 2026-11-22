# Persistent Host Stack & Unified Sectium Shell Guide

> **Audience:** Both **End Users** (who want reload-proof, always-on agent sessions across VS Code, Sectium Browser, and Hyperscaler Desktop) and **Developers** (building thin UIs, extensions, or cross-project agent integrations).  
> **Primary Packages:** [`intersections/b8g-agent-host/`](../intersections/b8g-agent-host/), [`intersections/sectium-browser/`](../intersections/sectium-browser/), [`intersections/b8g-vm-manager/`](../intersections/b8g-vm-manager/)  
> **Related Guide:** [`SOVEREIGN-LLM-STACK-GUIDE.md`](./SOVEREIGN-LLM-STACK-GUIDE.md)

---

## 1. Core Architectural Principle: Invert Ownership

When an AI agent or local tool lives inside a VS Code extension host or browser tab, running `Developer: Reload Window` or closing the window destroys the live session.

Awesome-OS **inverts ownership**: all stateful runtimes live as **persistent OS daemons**, while VS Code, Sectium Browser, Hyperscaler Desktop, and terminal CLIs act as **thin, stateless, hot-swappable UI clients**.

```text
  [ VS Code Extension ]    \
  [ Sectium Default Shell ] +── HTTP + SSE (since=lastSeq) ──► [ b8g-agent-host (:7498) ]
  [ Hyperscaler Desktop ]   /                                   Detached OS Daemon
  [ Terminal / CLI ]       /                                    Persists to .b8g-cas/agent-host/
                                                                         │
                                            ┌────────────────────────────┴─────────────────────────┐
                                            ▼                                                      ▼
                                 Official `google-antigravity`                         Local Sovereign LLM
                                 Python SDK (Agent runtime)                            Studio (:7497) fallback
```

### Why Sessions Survive Reloads & UI Switches
1. **Detached OS Process:** `.\bin\b8g-agent-host.ps1 start --daemon` spawns a detached background process outside VS Code and outside any browser window.
2. **Append-Only Disk Event Log:** Every session and stream event (`system`, `user`, `thought`, `tool_call`, `token`, `assistant_done`, `error`) is assigned a monotonic `seq` number and persisted as JSONL under `.b8g-cas/agent-host/logs/<sessionId>.jsonl`.
3. **Automatic Replay (`since=lastSeq`):** When you reload VS Code or open the same session in Sectium Shell or Hyperscaler Desktop, the UI connects to `GET /api/sessions/:id/stream?since=N`, immediately replays every missed event, and streams live tokens across **all** connected UIs simultaneously.

---

## 2. Complete Local Host Stack Port & Service Map

| Service | CLI Tool (Atomic Triplet) | Endpoint / Transport | Purpose |
| :--- | :--- | :--- | :--- |
| **Host Service Bus** | `b8g-host-bus` | `\\.\pipe\b8g-host-bus` | Singleton OS named-pipe service bus (zero TCP exposure). |
| **Persistent Agent Host** | `.\bin\b8g-agent-host` | `http://127.0.0.1:7498/` | Always-on multi-UI agent daemon + SSE replay (`/` = full UI, `/shell` = Sectium default shell). |
| **Sovereign LLM Studio** | `.\bin\b8g-llm-studio` | `http://127.0.0.1:7497/` | OpenAI `/v1/*` + Ollama `/api/*` + LoRA + Unsloth + Colab GPU Mesh. |
| **Host Disk Analyzer** | `.\bin\b8g-disk-analyzer` | `http://127.0.0.1:7496/` | Interactive Sunburst/Treemap storage & SHA-256 duplicate analyzer. |
| **Asymmetric Hunt 3D** | `.\bin\b8g-asymmetric-hunt` | `http://127.0.0.1:7495/` | 3v4 / 1v4 WebGL2 multiplayer hunting engine. |
| **Sectium Commander** | `.\bin\sectium-explorer` | `http://127.0.0.1:7490/` | Dual-pane `explorer.exe` replacement with 12 built-in viewers & `.mts` Drop-Zone apps. |
| **Sectium Browser** | `.\bin\sectium-browser` | Native full-codec window | Launches default `/shell` (`:7498/shell`) or any URL with persistent profile & zero Error `#4000`. |
| **Hyperscaler Desktop** | `.\bin\b8g-vm ui` | Native OS Desktop UI | Windows-like Desktop, Start Menu, Taskbar, Cloud Tenants/Vault/Mesh/CAS/DevOps. |

---

## 3. For End Users — Three Ways to Use the Same Live Session

### A. Sectium Default Interaction Shell (Standalone OS Shell)
Run `.\bin\sectium-browser` (with no URL, or `--shell`). It ensures `b8g-agent-host` is online and opens **`http://127.0.0.1:7498/shell`** in app mode:
- **Top Bar:** `◧` Left Sidebar toggle, `◨ Agent` Right Sidebar toggle, `⬓` Bottom Bar toggle, URL bar, reload, and live `ONLINE · PID` badge.
- **Left Sidebar:** Switch between Awesome-OS apps (`Commander`, `LLM Studio`, `Disk`, `Hunt 3D`) and persistent sessions.
- **Center Viewport:** Embedded workspace for apps or web pages.
- **Right Sidebar (Docked Agent):** Live Antigravity Host chat synced in real time with VS Code and Hyperscaler.
- **Bottom Bar + Quick Dock:** Status bar and expandable app launcher.

### B. VS Code / Antigravity Full UI-in-UI Extension
Installed from [`intersections/sectium-browser/vscode-extension/`](../intersections/sectium-browser/vscode-extension/):
- Drag the **Sectium Browser** view into the Left Sidebar, Right Secondary Sidebar, or Bottom Panel — or open a full tab via `Ctrl+Shift+P` → **`Sectium: Open UI-in-UI Workbench Tab`**.
- Click **`⚡ Persistent Agent Host`** to connect live to `:7498`, or click **`↗ Sectium`** to pop out protected/video sites (Twitch, YouTube) into native full-codec Sectium.

### C. Hyperscaler Desktop
Launch `.\bin\b8g-vm.ps1 ui` and click **`⚡ Persistent Agent Host`** from the Desktop, Start Menu, Taskbar, or Left Sidebar.

---

## 4. For Developers — Persistent Agent Host API Reference

Base URL: `http://127.0.0.1:7498` (CORS enabled for local UIs and webviews).

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Standalone Always-On Agent Host UI ([`ui-html.mts`](../intersections/b8g-agent-host/ui-html.mts)). |
| `GET` | `/shell` | Unified Sectium Default Interaction Shell ([`sectium-shell-html.mts`](../intersections/b8g-agent-host/sectium-shell-html.mts)). |
| `GET` | `/api/health` | Returns `{ ok, service, pid, port, uptimeSec, sessions, activeClients, dataDir, backends }`. |
| `GET` | `/api/sessions` | Lists all persistent sessions across all project roots. |
| `POST` | `/api/sessions` | Creates a session: `{ title?, projectRoot?, backend?: "antigravity-sdk" \| "b8g-llm-studio" \| "echo-local", model? }`. |
| `GET` | `/api/sessions/:id/events?since=0` | JSON array of events with `seq > since`. |
| `GET` | `/api/sessions/:id/stream?since=0` | Live **Server-Sent Events (SSE)** stream with `15s` keepalive heartbeats and automatic replay of `seq > since`. |
| `POST` | `/api/sessions/:id/message` | Submits `{ text, backend? }` (`202 Accepted`) and streams the turn asynchronously to all subscribed UIs. |
| `DELETE` | `/api/sessions/:id` | Deletes a session and its JSONL log. |

### Enabling the Official `google-antigravity` Python SDK Backend
Install the official public SDK into your Python environment:
```powershell
pip install google-antigravity
```
When installed, `b8g-agent-host` ([`backend-bridge.mts`](../intersections/b8g-agent-host/backend-bridge.mts)) automatically streams `response.thoughts`, `response.tool_calls`, and `response` tokens from `Agent(LocalAgentConfig(capabilities=CapabilitiesConfig()))`. If the SDK is not installed yet, it gracefully falls back to your local **Sovereign LLM Studio** (`http://127.0.0.1:7497`).

### CLI Operations
```powershell
.\bin\b8g-agent-host.ps1 start --daemon   # Idempotent: starts detached daemon if offline, prints PID if already online
.\bin\b8g-agent-host.ps1 status           # Prints live health JSON (PID, uptime, sessions, backends)
.\bin\node.ps1 --test intersections/b8g-agent-host/agent-host.test.mts
```
