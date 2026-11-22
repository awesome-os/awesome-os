# Awesome-OS & Sectium

> **A sovereign, content-addressed operating system, runtime, and BSD-3 browser/shell stack — built natively with zero closed vendor DLLs and zero WSL cross-compilation.**

Awesome-OS is engineered in four concrete, incrementally deployable stages so every layer runs, builds, and is tested on real hardware today:

```text
  1. Sectium          → Open-source BSD-3 Chromium-derived core engine (0 closed Google/MS DLLs, 7-subtree allowlist)
  2. B8G              → Zero-copy SharedArrayBuffer arenas (B8G_ARENA_V1), .b8p CAS packs, persistent host daemons & desktop apps
  3. StealifyLang/Holo→ Zero-AST TypeScript/WASI execution, 7-tuple context algebra, <b8g-*> Streaming Web Components
  4. Awesome-OS       → Bare-metal post-Chromium OS target (KVM/VFIO/NTSYNC, T2-SDE stripped to 31 core packages)
```

---

## 1. What Is Actually Built & Running Today

Every component below exists in this repository, runs natively on Windows 11 (and cross-compiles Linux ELF64 / WASI without WSL), and is backed by automated `node:test` suites:

| Component | Entrypoint / Port | What It Does |
| :--- | :--- | :--- |
| **Sectium Core & Shell** | `.\bin\sectium-browser` (`:7498/shell`) | Full-codec BSD-3 Chromium-derived browser & unified default interaction shell (Top/Left/Right/Bottom UI-in-UI workbench with docked always-on agent sidebar, persistent profile, auto-update disabled, zero closed Google DLLs). |
| **Persistent Agent Host** | `.\bin\b8g-agent-host` (`127.0.0.1:7498`) | Detached OS daemon storing sessions as append-only JSONL logs under `.b8g-cas/agent-host/` with SSE `since=lastSeq` replay. Survives VS Code reloads and UI switches; bridges the official `google-antigravity` Python SDK and local `b8g-llm-studio`. |
| **Sovereign LLM & LoRA Studio** | `.\bin\b8g-llm-studio` (`127.0.0.1:7497`) | Unified OpenAI (`/v1/*`) + Ollama (`/api/*`) local server, binary GGUF v2/v3 header & Modelfile parser, InfoNCE LoRA + Matryoshka embeddings, 7 Unsloth fine-tuning recipes, and Google Colab GPU/TPU Mesh `.ipynb` bridge (`40/40` tests). |
| **Hyperscaler Desktop Console** | `.\bin\b8g-vm ui` | Windows-like Desktop, Start Menu, Taskbar, and Sovereign Cloud Control Plane (Tenant Isolator, AES-256-GCM Vault & Ed25519 SSH, 1024-slot Device Shard Mesh, Edge Workers/WAF, SHA-256 CAS Registry, DevOps/lumiBERT, Build Grid). |
| **Sectium Commander** | `.\bin\sectium-explorer` (`127.0.0.1:7490`) | Dual-pane `explorer.exe` replacement with 12 built-in viewers (Code, Hex, Markdown, JSON Tree, CSV, Sandboxed HTML/SVG, Media), live `.mts` Drop-Zone apps, and Android-style `Share With...` intent routing. |
| **Host Disk Analyzer** | `.\bin\b8g-disk-analyzer` (`127.0.0.1:7496`) | Ad-free interactive Canvas 2D Sunburst & Treemap storage analyzer + SHA-256 duplicate finder with OS-path deletion guards (inspired by `adileo/squirreldisk`). |
| **VS Code / Antigravity Extension** | [`intersections/sectium-browser/vscode-extension/`](./intersections/sectium-browser/vscode-extension/) | Native zero-dependency IDE extension providing the full UI-in-UI Sectium Workbench in any sidebar, bottom panel, or editor tab. |
| **Native Build & Shim Toolchain** | `bin/` (`146/146` atomic triplets) | Hermetic `(posix, .cmd, .ps1)` shims verified by `.\bin\b8g-bin-parity verify`, native Windows-to-Linux ELF64 cross-compilation via `zig cc`/`zig c++` (zero WSL), and `.b8p` content-addressed build caching. |

---

## 2. Storage, Versioning & Rollback Architecture (No Hype)

Awesome-OS uses **standard, verifiable systems primitives** for durability and fast rollbacks:

- **Content-Addressed Storage (`.b8p` CAS):** Build artifacts, modules, and object packs are addressed by **SHA-256** and indexed under Merkle roots (`intersections/b8g-vm-manager/cloud-cas-registry.mts`).
- **$O(1)$ Epoch-Pointer Rollbacks:** System and overlay state transitions (e.g., `t2-sde-b8g` multi-arch CoW-VFS overlays, `CAS-RAID` WAL snapshots, and `AgentSessionStore` JSONL logs) roll back by switching an immutable **Copy-on-Write (CoW) epoch root pointer** or replaying a transaction log — not by speculative single-cycle CPU tricks.
- **Where Quaternion Math Is Actually Used:** Unit-quaternion algebra ($S^3$) is used strictly where it is mathematically appropriate — **3D orientation/camera/scene transforms** (e.g., WebGL2 / `wgpu` rendering) and formal invariant proofs documented in [`docs/FORMAL-SECURITY-AND-QUATERNION-INVARIANTS.md`](./docs/FORMAL-SECURITY-AND-QUATERNION-INVARIANTS.md) (which explicitly notes that quaternions are not cryptographic primitives and do not replace SHA-256/CoW storage).

---

## 3. Quick Start

### Launch the Unified Desktop or Default Sectium Shell
```powershell
# 1. Start the Persistent Always-On Agent Host daemon (:7498)
.\bin\b8g-agent-host.ps1 start --daemon

# 2. Open Sectium's default Antigravity-style interaction shell (:7498/shell)
.\bin\sectium-browser.ps1

# 3. Or launch the full Hyperscaler Desktop (Start Menu, Taskbar, 16 integrated apps)
.\bin\b8g-vm.ps1 ui
```

### Verify Tooling Parity & Core Test Suites
```powershell
# Verify 100% atomic (posix, cmd, ps1) CLI triplet parity
.\bin\b8g-bin-parity.ps1 verify

# Run core verification suites (Agent Host, LLM Studio, Hyperscaler, Commander, Disk Analyzer)
.\bin\node.ps1 --test intersections/b8g-agent-host/agent-host.test.mts intersections/b8g-vm-manager/vm-manager.test.mts intersections/b8g-vm-manager/link-check.test.mts intersections/sectium-explorer/sectium-explorer.test.mts intersections/b8g-disk-analyzer/disk-analyzer.test.mts
```

---

## 4. Documentation Map

- **Master Architecture Blueprint:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Mental-Model & Tooling Cheatsheet:** [`docs/AWESOME-OS-CHEATSHEET.md`](./docs/AWESOME-OS-CHEATSHEET.md)
- **Persistent Host & Unified Sectium Shell Guide:** [`docs/PERSISTENT-HOST-AND-SECTIUM-SHELL-GUIDE.md`](./docs/PERSISTENT-HOST-AND-SECTIUM-SHELL-GUIDE.md)
- **Sovereign LLM, Embeddings, Unsloth LoRA & Colab Mesh Guide:** [`docs/SOVEREIGN-LLM-STACK-GUIDE.md`](./docs/SOVEREIGN-LLM-STACK-GUIDE.md)
- **Streaming Web Components (`<b8g-*>` HTML5 `data-*` Spec):** [`docs/stealifylang/B8G-STREAMING-WEB-COMPONENTS.md`](./docs/stealifylang/B8G-STREAMING-WEB-COMPONENTS.md)
- **Section Shapes & Liveness Examples (`.mts`, Rust 2024, C++23):** [`docs/stealifylang/SECTION-SHAPES-AND-LIVENESS-EXAMPLES.md`](./docs/stealifylang/SECTION-SHAPES-AND-LIVENESS-EXAMPLES.md)

---

## 5. Credits & Upstream Foundations

Awesome-OS builds openly on and credits the shoulders of great open-source engineering: **Chromium** (BSD-3), **Zig** (`zig cc`/`c++` cross-compilation), **T2-SDE**, **WASI / WebAssembly**, **Unsloth**, **Jina AI** (dual-adapter LoRA research), and **`adileo/squirreldisk`** (UX inspiration for `b8g-disk-analyzer`).
