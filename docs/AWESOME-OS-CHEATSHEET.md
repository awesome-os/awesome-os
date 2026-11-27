# Awesome-OS Mental-Model & Usability Cheatsheet

> **Purpose:** A compact translator between **legacy OS habits** and **Awesome-OS concepts** (cells, sections, boundaries, build tooling, inspection), paired with concrete **"If you want to do X -> do this"** usability recipes.  
> **Canonical Blueprint & Migration Catalog:** See [`ARCHITECTURE.md`](../ARCHITECTURE.md) (root master map), `docs/MOVE-TO-B8G-GUIDE.md` (existing software migration patterns), `docs/LEGACY-TO-AWESOME-OS-MAPPING.md` (11-layer legacy-to-sovereign comparison), [`SOVEREIGN-LLM-STACK-GUIDE.md`](./SOVEREIGN-LLM-STACK-GUIDE.md) (LLM, LoRA, Unsloth & Colab Mesh), and [`PERSISTENT-HOST-AND-SECTIUM-SHELL-GUIDE.md`](./PERSISTENT-HOST-AND-SECTIUM-SHELL-GUIDE.md) (Always-On Agent Host `:7498` & Unified Sectium Shell).

---

## 1. Compact Terminology & Boundary Sheet

### Why Context Boundary Labels Exist
In Awesome-OS, we run **isolated cells** on top of a **legacy host system** (Windows, Linux, macOS). Every tool models the **7-Tuple Execution Context** $\mathcal{C}_{\text{cloud}} = (B, D, L, T, \kappa, \Lambda, \Omega)$ — **Boundary** ($B$), **Display/WindowStation** ($D$: `headless < background-job < interactive-fg`), **Lifetime** ($L$: `oneshot | window-bound | singleton-service`), **Transport** ($T$: `arena-sab | os-pipe | cdp-pipe | external-http`), **Capability** ($\kappa$), **Locality** ($\Lambda$: `local-arena < lan-peer < sovereign-edge < cloud-region`), and **Persona / Observability Plane** ($\Omega$: `consumer < creator < devops < kernel-audit`) — see Research Dossier 10 (`docs/research/10-execution-context-algebra-and-admissibility-invariants.md`) for all **6 Total Admissibility Invariants** (Visual Reachability, Local IPC Purity `B8G016`, Capability Inclusion & Epoch Fence, Data Sovereignty, Singleton Pipe Ownership, Persona Isolation $\Omega$). Every tool prints or stamps its exact boundary (`B8G_SHIM_BOUNDARY`) so you never confuse *where* something executed:

| Term / Boundary Label | What It Means in Awesome-OS | Legacy Equivalent | Why It Exists |
| :--- | :--- | :--- | :--- |
| **Host System** (`host-win32`, `host-posix`) | The **legacy Neumann OS** underneath (e.g. Windows 11, Linux) that still owns real GPU drivers, `cargo.exe`, and OS windows. | "The machine / OS" | We treat the legacy OS as a thin hardware/driver host — not our app runtime. |
| **WSL Bridge** (`wsl-linux`) | Legacy Linux running inside Windows WSL (used for `b8g-emcc` musl/wasm builds or POSIX tools). | Linux VM / dual-boot | Explicitly flagged so you never build a Linux ELF in WSL and wonder why Windows PowerShell can't find `.exe`. |
| **In-Process** (`in-process` / `stealify-inproc`) | Direct TypeScript/ESM execution inside the Stealify runtime (`erasableSyntaxOnly: true`, zero compile step). | Spawning `node`, `tsc`, `bash` | Zero-overhead execution without spawning legacy child processes or downleveling `.ts` -> `.js`. |
| **Cell / Container** (`wasi-container`) | A capability-gated WASI / `.b8e` sandbox (`B8gEngine`, `UniversalKernel`) operating on a `SharedArrayBuffer` arena (`B8G_ARENA_V1`). | Process / Docker container | Zero ambient authority; cells talk to the host only through explicit ABI namespaces (`b8g_kernel`, `b8g_render_v1`). |
| **Section** (`defineSection`) | One typed, 64B-aligned memory slice + physical substrate (`s.*`) + programmable `ops`. | Service + DB table + config | Single source of truth for memory layout, persistence, and state transitions. |
| **Intersection** (`intersect`) | Composes multiple Sections onto deduplicated `SectionSlot`s in one shared arena. | App / microservice mesh | Overlapping Intersections share the exact same physical SAB slice with zero glue code. |
| **Cold Index vs. Hydrated Focus** | Metadata-only discovery (`0` SABs allocated) until you explicitly focus **1** target (`dev-catalog`). | Eager web style-guide / daemon boot | Keeps OS inspection strictly `O(1)` memory & GPU regardless of how many sections exist. |

### Core Build, Runtime & Inspection Tooling

| Tool | Role | Boundary |
| :--- | :--- | :--- |
| **`stealifylang`** | Zero-AST project checker (`check`), type verifier (`tsc`), test runner (`test`), direct runner (`run`), container/cloud CLI. | `in-process` |
| **`@awesome-os/b8g-cxx`** | Native C/C++ build accelerator (`.b8p` CAS `.obj` cache, shared PCH, Ninja driver) + `sections/cxx-build`. | `host-win32` / `in-process` |
| **`@awesome-os/b8g-rust`** | Global `.b8p` Rust CAS (`RUSTC_WRAPPER`, `.rmeta`→`.rlib` DAG waves, `lld-link`, Cranelift) + `sections/rust-build` + `cargo`/`rustc` shim takeover. | `host-win32` / `in-process` |
| **`@awesome-os/b8g-zig`** | Global `.b8p` Zig & `zig cc`/`zig c++` cross-compiler (native + `wasm32-wasi`, zero WSL) + `sections/zig-build` + `zig` shim takeover. | `host-win32` / `in-process` |
| **`@awesome-os/b8g-emcc`** | Compiles guest C/C++ → `.wasm` / `.b8e` cells (`zig cc` native fast-path on Windows; WSL `clang` fallback). | `host-win32` / `wasi-container` |
| **`@awesome-os/b8g-gfx-host`** | Native **`wgpu` + `winit` + `glyphon`** GFX host (`b8g_render_v1`): renders 48 B/quad slabs + text (`--window`, `--headless`, or `--kitty`). | `host-win32` (DX12/Vulkan) |
| **`@awesome-os/b8g-layout`** | Zero-CSS two-sweep $O(N)$ flat-array layout solver (`FIT`/`GROW`/`FIXED`/`PERCENT` -> 48 B/quad `SabGpuQuadSlab`) + 4 pluggable Window Managers (`infinite-canvas`, `scroll-strip`, `tile-bsp`, `floating`). | `in-process` (portable) |
| **`dev-catalog`** | Living Section & Intersection guide: cold index, lazy single-target hydration, generic field patching & op invocation (`universal-build`, etc.). | `in-process` + `b8g-gfx-host` |
| **`host-debug-facade`** | Legacy Host Debugging Facade Intersection (`intersections/host-debug-facade`): lets internal B8G run full speed while debouncing/pacing legacy host boundaries, `fsync`-journaling `BEFORE`/`AFTER` crash breadcrumbs, and arming an 8 s auto-exit watchdog. | `in-process` + `host-win32` |
| **`b8g-docs`** (`notebook`) | Dual-transport interactive Document & Markdown/`alg` Notebook Runner (`intersections/docs-reader`): internal VT100 console TUI, executable JS/TS/B8G/`alg` cells (`run`), and external remote HTTP/JSON/ANSI portal (`serve`). | `in-process` + `remote-http` |
| **`b8g-gen`** (`gen`) | Correct-by-Construction Section/Intersection/Blog generator & Mathematical Invariant Gate (`verify`) paired with Stealify Composition Algebra (`wedge ^`, `meet &`, `project \|>`, `evolve ∇`, `alg`). | `in-process` + `host-win32` |
| **`b8g-browser`** (`b8g-html`) | Zero-WebKit HTML5 + CSS Flexbox + Reactive JS Browser (`intersections/b8g-html`) with 52 px URL nav bar, international keyboard support, live `google.com` rendering, and 7-target OS/Arch + Web dist (`dist`). | `in-process` + `wgpu` |
| **`b8g-chromium`** (`chromium-build`) | First-class Chromium `.b8p` CAS Build, Upstream Auto-Update (`dry-run`/`apply`), Structured Telemetry Tracing, and Phased Migration CLI (`sections/chromium-build` / `chromium-core` intersection). | `in-process` + `host-win32` |
| **`B8G Xenon 1B`** (`sections/atlas-kv`) | 1B cognitive core (`model-kalaschnikow`) + AtlasKV `KG2KV`/`HiKVP` hierarchical KV memory (`25.1×` faster, `-98.2%` VRAM, `100%` Recall@1, tenant `CapabilityToken` isolated). | `in-process` (SAB/UVS) |
| **`b8g-infer`** (`inference-manager`) | First-class **Inference Manager (`Execution ↔ Projection`)**, OS peer to Task Manager tracking `streaming`/`awaiting-permission`/`swarm-wait`/`rate-limited` with ANSI top & `wgpu` Approve/Xenon-1B/Kill control plane. | `in-process` + `wgpu` |
| **`b8g-vm`** (`intersections/b8g-vm-manager`) | **Hyper-Screen Sovereign VM Manager** — spawns real native Host-OS-bordered, flexibly-scaled VM screens (`fit`/`fill`/`1:1`/`dynamic-dpi`), durable WAL **CAS-RAID**, **VFIO/IOMMU GPU passthrough**, and zero-copy `ivshmem` (`B8G_ARENA_V1`) bridge. | `host-win32` / `bare-metal` |
| **`b8g-distro`** (`sections/b8g-linux-distro`) | **Path B Bare-Metal Micro-Kernel & T2-SDE Gate** — stages `newc` CPIO `initramfs` + UEFI ESP (`b8g_defconfig` with `KVM`/`VFIO`/`NTSYNC`) and strips T2-SDE **6,932 → 31 Architectural-Land packages** (`99.55%` bloat removed). | `in-process` / `bare-metal` |
| **`b8g-win-supply-chain`** (`sections/b8g-win-supply-chain`) | **4-Tier Windows / DOS (GOG) / On-Demand Mono Router** — inspects `MZ`/`NE`/`PE32`/`PE32+`/`CLR` headers to route Win64 (`Wine+NTSYNC+DXVK+VKD3D`), on-demand `dos-gog.b8p`, on-demand `dotnet-mono.b8p`, or Ring-0 `KVM+VFIO`. | `in-process` / `bare-metal` |
| **`b8g-moe`** (`intersections/b8g-moe-gate`) | **Unified Model Atlas & Boundary-Verified MoE** (`docs/models/` + `sections/b8g-model-ops/`) — stamps research models and enforces ingress/egress energy, `CapabilityToken`, quarantine & symbolic safe gates. | `in-process` |
| **`b8g-loop`** (`intersections/b8g-error-loop-lsp`) | **Universal Algebraic Error-Loop LSP** — 6 target stack adapters + LSP 3.17 diagnostics + deterministic 1-click auto-fix powering `b8g.app/builder.html` (`15×–32×` error-noise compression for small local models). | `in-process` |
| **`b8g-diagnostic-shell`** (`intersections/b8g-diagnostic-shell`) | **Bottom-to-Top `L1→L5` Ecosystem Debugger** — verifies Win64 PE / Linux ELF64 / C11 ABIs → `140/140` atomic `bin/` parity → `stealify-lint` (`B8G016`/`B8G017`) → $R \subseteq M$ + V8 parse → live offscreen **Sectium** CDP in `< 7 s`. | `in-process` + `host-win32` |
| **`b8g-host-bus`** (`sections/b8g-host-bus`) | **Singleton OS Named Pipe Service Bus** (`\\.\pipe\b8g-host-bus` / `/run/b8g/host-bus.sock`) — hosts all 8 warm local services with zero-admin autostart and zero TCP ports. | `host-win32` / `host-posix` |
| **`b8g-agent-host`** (`intersections/b8g-agent-host`) | **Persistent Always-On Multi-UI Agent Host (`:7498`)** — detached OS daemon with JSONL replay logs, SSE fan-out across VS Code / Hyperscaler / Sectium `/shell`, `google-antigravity` SDK + local LLM Studio fallback. | `host-win32` / `in-process` |
| **`b8g-llm-studio`** (`intersections/b8g-llm-studio`) | **Sovereign LLM, Embeddings, Unsloth LoRA & Colab Mesh (`:7497`)** — OpenAI `/v1/*` + Ollama `/api/*` + binary GGUF v2/v3 + real InfoNCE LoRA + 7 Unsloth recipes + Colab GPU Mesh. | `in-process` / `host-win32` |
| **`sectium-browser`** (`intersections/sectium-browser`) | **Unified Sectium Shell & Full-Codec Browser** — launches default Antigravity-style `/shell` (`:7498/shell`) or full-codec web URLs (zero Error `#4000`) + native VS Code UI-in-UI extension. | `host-win32` / `in-process` |
| **`b8g-devops`** (`intersections/b8g-devops`) | **Centralized DevOps & Multi-Agent Emergency Hub** — enforces Persona Isolation ($\Omega = \text{consumer} \implies \emptyset$ zero overhead) and routes P0–P3 events to single-claim specialist workers. | `in-process` / `os-pipe` |
| **`holo`** (`intersections/holo-compiler`) | **Holonomic Zero-AST Compiler Frontend** (`backends`, `verify`, `compile-demo`, `resolve-error`) — enforces 7-tuple $\mathcal{C}_{\text{cloud}}$ admissibility gates and `.b8p` CAS emission. | `in-process` |
| **`b8g-build`** (`b8g-build/maintenance.mts`) | **Unified Single-Split Multi-Backend Build System** (Zig/C, Rust, TypeScript, WASI) — `B8G_ABI_MAGIC_V3` headers, `.b8p` CAS caching, and byte-exact determinism verification. | `host-win32` / `in-process` |
| **`lumi-bert-harness`** (`intersections/b8g-devops-harness`) | **Deterministic `lumiBERT` 1:1 Error Auto-Repair CLI** (`resolve`, `benchmark`, `list-fixes`) — sub-5 ms cosine-matched error-to-solution dispatch for DevOps & compiler loops. | `in-process` |
| **`b8g-repo-analyzer`** (`intersections/b8g-repo-analyzer`) | **Live Workspace Indexer & Repo Pattern Auditor** (`audit`, `query` BM25, `suffix` Reverse B-Tree, `trigram`, columnar `stats`) — generates Markdown cleanup reports. | `in-process` |
| **`b8g-web-doc`** (`intersections/b8g-web-doc`) | **Zero-Dependency Web & Markdown Verifier** — validates HTML documents (`verifyWebDocument`) and Markdown pipe tables (`verifyMarkdownTables`). | `in-process` |
| **`sectium-publish`** (`intersections/sectium-publish-to-registry`) | **Sectium Multi-Registry SDK Publisher** (`build-wasm`, `verify`, `publish`) — builds, verifies, and plans WASI/SDK releases across `npm`, `crates.io`, `PyPI`, and `Wasmer`. | `in-process` / `wasi` |
| **`b8g-electron`** (`intersections/b8g-electron`) | **Zero-Copy Shared-Chromium Electron Shell** — runs Electron apps (`--asar`, `--inspect-asar`, `--scan-installed`) on ONE shared sovereign Chromium binary with zero mutation of installed folders. | `in-process` + `cdp-pipe` |
| **`t2-sde-b8g`** (`t2-sde-b8g/`) | **Standalone Multi-Arch T2-SDE & LTS Maintenance Project** — `web-posix` + 7-arch CoW-VFS overlay (`freezeAndSwitchArch` / O(1) `rollbackEpoch`) + atomic LTS CVE promotion. | `in-process` / `wasi` |
| **`bin-shim doctor / which / trace`** | Execution provenance & boundary inspector (`B8G_SHIM_BOUNDARY`, `B8G_SHIM_CHAIN`, real unshimmed host path). | `in-process` |
| **`frank-host-snapshoot`** | Host visual probe capturing real desktop/IDE/window screenshots into `.tmp-snapshots/` so humans & agents see the same screen. | `host-win32` |
| **`cdp-arena-driver`** *(Experimental)* | Zero-Puppeteer CDP driver (**not planned to ship in core OS**; retained for future **B8G Cloud** Chromium fleets). | Cloud-only |

### Universal I/O Split: `ramStream` + `keyboardStream` (UEFI → Desktop → VT100/Kitty)
Every computing environment from bare-metal firmware to a remote SSH terminal reduces cleanly to two Awesome-OS streams — **`ramStream`** (`DisplaySection` / `WindowedFrameSection`) and **`keyboardStream`** (`InputEventSection` 16 KiB `s.sabRing`):

| Hardware / Transport Layer | `ramStream` (Pixels / Quads Output) | `keyboardStream` (Structured Key + Modifier Input) |
| :--- | :--- | :--- |
| **UEFI / Bare-Metal** | **UEFI GOP** (flat linear RGBA framebuffer in RAM) or UART VT100 | `EFI_SIMPLE_TEXT_INPUT_EX_PROTOCOL` or UART VT100 |
| **Native Desktop (`host-win32` / POSIX)** | `b8g-gfx-host` (`wgpu` + `glyphon` over `b8g_render_v1` / `SabGpuQuadSlab`) | `winit` OS events → `InputEventSection` (`s.sabRing`) |
| **Legacy OS Shell / Remote SSH / Serial** | **Kitty Graphics** (`APC G` over VT100 — `--kitty` chunked RGBA over SSH, or `t=s` shared-memory RAM locally) | **Kitty Keyboard** (`CSI ... u` over VT100) → decoded into `InputEventSection` (`s.sabRing`) |

**Key implication:** You never write separate "CLI", "GUI", and "UEFI" versions of Awesome-OS. Kitty over VT100 is the universal legacy-OS & remote-SSH transport, while `b8g_render_v1` / UEFI GOP is the zero-copy native fast path — both driving the exact same Sections and `.b8e` cells.

### The 4 Canonical Workspace Zones (Where Everything Lives)
| Zone | Strict Rule | Examples |
| :--- | :--- | :--- |
| **`sections/`** | Zero `node:*` imports, `types: []`, `erasableSyntaxOnly: true` (host adapters live in `*.host.mts`). | `display`, `input`, `cxx-build`, `rust-build`, `zig-build`, `b8g-abi-v8` (`cdp-repl`), `telemetry`, `trace` |
| **`intersections/`** | Pure `intersect(...)` compositions + living catalog. | `dev-catalog`, `host-debug-facade`, `docs-reader`, `universal-build`, `workbench-shell`, `observability` |
| **`packages/@awesome-os/`** | Host-edge engines, native binaries, compilers & shims. | `b8g-gfx-host`, `b8g-cxx`, `b8g-rust`, `b8g-zig`, `b8g-emcc`, `bin-shim`, `stealify-schema` |
| **`repository/`** | Self-contained platform products & standalone runtimes. | `b8g-cloud-platform` (`stream-runner`), `wasi-host-implementations`, `stealify-lang` |

---

## 2. Usability Playbook: "If You Want To Do X -> Do This"

### A. You are on Windows and want to build an Intersection that renders natively on your Windows desktop
1. **Define portable Section(s)** in `sections/<name>/index.mts` (`defineSection`, `f.*`, `s.*`, `ops`) — keep it `types: []` and `erasableSyntaxOnly: true` clean (zero `node:*` imports).
2. **Compose your Intersection** in `intersections/<name>/index.mts` using `intersect('my-id', [SectionA, SectionB])`.
3. **Register it cold** in `intersections/dev-catalog/cli.host.mts` (`.registerIntersection(MyIntersection)`).
4. **Launch directly on native DX12/Vulkan** (zero Chrome, zero Electron):
   ```powershell
   bin\dev-catalog.ps1 wgpu my-id          # opens native wgpu + winit + glyphon window
   bin\dev-catalog.ps1 wgpu my-id --build  # rebuilds Rust host if you changed native/src/
   ```
   Click fields/ops live in the window, or use `--headless` to render `.tmp-snapshots\dev-catalog.ppm` on the real GPU for automated checks.

### B. You are inside Awesome-OS in a browser and want to build & run an Intersection
1. **Use the exact same portable Section/Intersection definition** — because it has zero `node:*` imports, it runs unmodified inside a browser worker/tab over `SharedArrayBuffer` (served with COOP/COEP headers).
2. **Hydrate inside `IntersectionContainer`** (`const c = new IntersectionContainer(); await c.hydrate(MyIntersection, browserCaps)`).
3. **Project to GPU or HTTP/Mesh:**
   - For GPU rendering in-browser: write `SabGpuQuadSlab` (48 B/quad) via `@awesome-os/sab-react/gpu` (`SAB_UI_QUAD_WGSL` — same shader as native `b8g-gfx-host`).
   - For API/RPC exposure: call `mountIntersectionOnRouter(router, container, MyIntersection, caps)`.

### C. You want persistence (saving state across restarts)
Pick the physical **substrate** (`s.*`) directly on `defineSection` — never hand-write ad-hoc JSON file read/write boilerplate:
- **Structured local state (settings, layout, indexes):** `substrate: s.sqlite({ table: 'my_table' })`
- **Content-addressed / versioned / Merkle data:** `substrate: s.uvsCas({ ... })`
- **Direct workspace files:** `substrate: s.disk({ target: '...' })`
- **High-frequency lock-free transient events (input, telemetry):** `substrate: s.sabRing({ capacityBytes: 16384 })`
- **Derived reactive state:** `substrate: s.computed({ dependsOn: [OtherSection] })`
- **Lifecycle:** `await container.hydrate(def, caps)` loads substrates in topological order; `await container.flush(def, caps)` commits dirty state back to the substrate.

### D. You want a WASI / `.b8e` cell to render natively to the GPU
1. **Attach a `B8gRenderHostV1`** to `B8gEngine` (`engine.attachRenderHost(host)`) or pass `{ renderHost }` to `B8eLoader.execute(buf, { renderHost })`.
2. **Inside the WASM cell**, import `b8g_render_v1`:
   - `create_surface(w, h, mode)` (`1 = window`, `2 = headless`)
   - `submit_quads(surfaceId, ptr, quadCount)` (pointer to 48 B/quad array in guest linear memory)
   - `present(surfaceId)` / `readback_rgba(surfaceId, outPtr, outByteLen)` / `destroy_surface(surfaceId)`
3. If no native host is attached yet, `createInMemoryRenderHost()` automatically provides a deterministic software fallback so tests never fail with `LinkError`.

### E. You want to build native C/C++ or Rust components
- **C/C++ dependencies or V8/native addons:** Route through `@awesome-os/b8g-cxx` (`b8g-fast-build.mts` / `b8g-ninja-driver.mts`) to get `.b8p` CAS `.obj` caching.
- **Guest C/C++ -> WASM cell:** Use `B8gEmccDriver` (`@awesome-os/b8g-emcc`, runs `clang -target wasm32-wasi` over `wsl-linux`).
- **Rust native GFX host (`wgpu` + `winit` + `glyphon`):** Builds on `host-win32` via `cargo` (`bin\dev-catalog.ps1 wgpu --build` or `cargo build --release --manifest-path packages/@awesome-os/b8g-gfx-host/native/Cargo.toml`).

### F. You are confused about *where* a command ran or *why* a binary wasn't found
1. **Check execution boundary & tool locations in 1 second:**
   ```powershell
   & "e:\awesome-os\packages\@awesome-os\bin-shim\bin\node.ps1" --experimental-strip-types e:\awesome-os\packages\@awesome-os\bin-shim\src\index.mts doctor
   & "e:\awesome-os\packages\@awesome-os\bin-shim\bin\node.ps1" --experimental-strip-types e:\awesome-os\packages\@awesome-os\bin-shim\src\index.mts which <tool>
   ```
2. **Trace exact shim resolution live:**
   ```powershell
   & "e:\awesome-os\packages\@awesome-os\bin-shim\bin\node.ps1" --experimental-strip-types e:\awesome-os\packages\@awesome-os\bin-shim\src\index.mts trace <tool> [args...]
   ```
3. **Check what is visually on your host desktop/IDE screen (for you or an agent):**
   ```powershell
   bin\frank-host-snapshoot.ps1 doctor
   bin\frank-host-snapshoot.ps1 windows   # captures matching GUI window -> .tmp-snapshots/
   ```

### G. You want to inspect any Section or Intersection without booting the whole OS
```powershell
bin\dev-catalog.ps1 list                          # cold list (0 arenas hydrated)
bin\dev-catalog.ps1 inspect workbench-shell       # grouped slots, byte offsets, ops, protocols (still 0 hydrated)
bin\dev-catalog.ps1 focus section.window-layout   # lazily hydrates ONLY 1 target
bin\dev-catalog.ps1 invoke section.window-layout updateLayout '{"zenMode":true}'
bin\dev-catalog.ps1 wgpu universal-build --kitty  # stream real GPU frame inline over VT100/SSH
bin\dev-catalog.ps1                               # interactive terminal REPL
```

### H. You want to benchmark toolchains (Deno, Rust, Bun, `b8g-abi-v8`) or link C components to V8
```powershell
# Run validatable Cold vs Warm .b8p CAS benchmark with byte-exact SHA-256 parity
& "e:\awesome-os\packages\@awesome-os\bin-shim\bin\node.ps1" --experimental-strip-types `
  e:\awesome-os\benchmarks\toolchain-bench\run-bench.host.mts --validate

# Inspect or launch the clean V8 Section ABI (zero-v8.h C linking + multithreading + CoW fork)
bin\dev-catalog.ps1 wgpu b8g-abi-v8
```

### I. You want to debug a native host UI safely without starving legacy OS crash logs (`bin\host-debug.ps1`)
Internal B8G runs at microsecond full speed, while legacy Windows/Linux GPU drivers & disks need breathing room to flush crash logs (especially on marginal CPU/RAM timings). Use the unified **`bin\host-debug.ps1`** (`b8g-host-debug`) shim (`intersections/host-debug-facade/README.md`):
```powershell
bin\host-debug.ps1 profiles                                        # show off|gentle|diagnostic|paranoid profiles
bin\host-debug.ps1 inspect                                         # check for unfinished BEFORE crash suspects
bin\host-debug.ps1 run --profile diagnostic -- canvas-branch       # 75ms debounce, 150ms pacing, fsync, 8s auto-exit
bin\host-debug.ps1 run --profile paranoid -- canvas-branch         # 250ms debounce, 500ms pacing, fsync, 8s auto-exit
bin\canvas-branch.ps1 --host-debug=diagnostic --auto-exit 0        # disable 8s auto-exit watchdog later
```
After any hard reset, run `bin\host-debug.ps1 inspect` (reads `.b8g-logs/host-flight-recorder.ndjson`) — any unfinished `BEFORE` breadcrumb pinpoints the exact legacy host boundary call that was in flight.

### J. You want to read, search, or run Markdown docs as living notebooks (Internal Console + External Remote)
```powershell
bin\b8g-docs.ps1                                    # interactive internal console TUI reader
bin\b8g-docs.ps1 list                               # list all indexed OS docs & blog entries
bin\b8g-docs.ps1 open 10                            # read Blog Entry #10 in ANSI/VT100
bin\b8g-docs.ps1 run 10                             # execute live JS/TS notebook cells inside Blog #10!
bin\b8g-docs.ps1 search fsync                       # full-text search with highlighted ANSI snippets
bin\b8g-docs.ps1 serve --host 0.0.0.0 --port 8787   # external remote portal (/, /api/docs, /ansi/:id, /raw/:id)
```

---

## 2.5 Empirical Browser Distribution Audit: Chromium vs. Google Chrome vs. Microsoft Edge vs. Sectium

> **Licensing Truth:** **Chromium** is open source (BSD-3-Clause). **Google Chrome** and **Microsoft Edge** are **proprietary, closed-source distributions** built on top of Chromium; neither `chrome.dll` nor `msedge.dll` may be redistributed or patched by third parties. Awesome-OS builds and ships **open-source `Sectium`** — our BSD-3 Chromium-derived core engine & fundamental substrate (`0` closed Google/Microsoft DLLs) — with **`B8G`** providing our additions, OS/ABI runtime, strangler-fig shims (`b8g-cef-shim`, `b8g-wl-shim`, `b8g-electron`), and `.b8p` CAS toolchains on top (plus pure-native `b8g-html`), and only ever invokes a user's pre-installed Chrome/Edge *out-of-process over CDP* as a temporary host fallback.
>
> **Honest Visibility Boundary:** Google's `src-internal` and Microsoft's Edge fork source trees are private. The table below combines **Chromium's public `is_chrome_branded` / `GOOGLE_CHROME_BRANDING` hooks** (`12` GN hooks in `chrome/BUILD.gn` + `chrome/browser/BUILD.gn`; `33` C++ `#if` hooks in `chrome/browser/*.cc` verified in `E:\b8g-chromium-real\src`) with an **exact binary audit** of the installed Windows 11 distributions (2026-11-22).

### Feature & Proprietary Addition Matrix

| Category | Stock **Chromium** (Open Source) | **Google Chrome** Additions (`is_chrome_branded`) | **Microsoft Edge** Additions (Closed Fork) | **Sectium + B8G** Stance |
| :--- | :--- | :--- | :--- | :--- |
| **1. Media Codecs** | Open codecs only (VP8/VP9, AV1, Opus, Vorbis, FLAC) | `proprietary_codecs=true` (licensed H.264, AAC, HEVC) | H.264, AAC, HEVC via Windows Media Foundation HW decode | **Optional** (OS HW decode / OpenH264 — zero licensing lock-in) |
| **2. DRM / EME** | EME API shell only (no CDM) | **Widevine CDM** (`WidevineCdm/` closed binary) | **PlayReady CDM** (SL3000 4K) + **Widevine CDM** | **Opt-in user plugin only** (never baked into core OS) |
| **3. Auto-Updater** | None | **Omaha / `GoogleUpdate`** (`os_update_handler.exe`, `elevation_service.exe`) | **`MicrosoftEdgeUpdate`** (`elevation_service.exe`) | **Excluded** — replaced by `.b8p` CAS + `t2-sde-b8g` CoW epochs |
| **4. Identity & Sync** | Sync protocol plumbing (no keys) | Google OAuth API keys, Chrome Sync, Password Manager | MSA / Entra ID (`oneauth.dll`, `identity_proxy/`), Wallet | **Excluded** — replaced by sovereign `CapabilityToken` + local CAS |
| **5. Telemetry & Crash** | Crashpad client (disabled) | **UMA / UKM**, **RLZ**, `elevated_tracing_service.exe` | **OneDS / Telemetry** (`telclient.dll`, `oneds.dll`, `edge_feedback/`) | **Excluded** — replaced by opt-in `intersections/b8g-devops` ($\Omega = \text{consumer} \implies \emptyset$) |
| **6. Security Services** | Safe Browsing client (no keys) | **Google Safe Browsing** (real-time URL/download API) | **Defender SmartScreen**, `mip_core_gn.dll`, `Trust Protection Lists/` | **Optional** (local capability sandbox + 7-Tuple $\mathcal{C}_{\text{cloud}}$ gates) |
| **7. AI & On-Device Models** | `optimization_guide` plumbing only | **`optimization_guide_internal.dll` (24.29 MB)**, **`libLiteRtWebGpuAccelerator.dll` (9.57 MB)**, Gemini Nano, Lens | **`onnxruntime.dll` (11.13 MB)**, Copilot Sidebar, Bing Shopping, `edge_game_assist/` | **Excluded** — replaced by sovereign `intersections/b8g-moe-gate` (local MoE / AtlasKV) |
| **8. OS & Embedder Bloat** | Standard Chromium shell | `chrome_pwa_launcher.exe`, `chromecompaneros.dll`, Cast SDK | **WebView2** (`EBWebView/`), **IE Mode** (`dual_engine_adapter_x64.dll`), `mspdf.dll` (18.27 MB), `BHO/` | **Excluded** — replaced by `b8g-electron`, `b8g-cef-shim`, `b8g-wl-shim` |
| **9. Enterprise / Policy** | Base Policy engine | Chrome Enterprise Core / Cloud Management (CBCM) | Microsoft Intune / Entra ID Conditional Access | **Excluded** — replaced by 7-Tuple $\mathcal{C}_{\text{cloud}}$ CISO Sovereignty Gate |

### Machine-Verified Binary Footprint Audit (Windows 11 Host, 2026-11-22)

| Distribution | Verified Path & Version | Core Engine DLL(s) | `resources.pak` | Notable Proprietary Binaries Present |
| :--- | :--- | :--- | :---: | :--- |
| **Google Chrome** | `C:\Program Files\Google\Chrome\Application\157.0.8103.79` | `chrome.dll` (**296.10 MB**) | **25.06 MB** | `optimization_guide_internal.dll` (24.29 MB), `libLiteRtWebGpuAccelerator.dll` (9.57 MB), `elevated_tracing_service.exe` (4.32 MB), `elevation_service.exe` (3.83 MB), `os_update_handler.exe` (2.92 MB), `WidevineCdm/` |
| **Microsoft Edge** | `C:\Program Files (x86)\Microsoft\Edge\Application\158.0.4370.33` | `msedge.dll` (**367.81 MB**) + `msedge_renderer.dll` (**232.07 MB**) = **599.88 MB** | **35.62 MB** | `mspdf.dll` (18.27 MB), `onnxruntime.dll` (11.13 MB), `mip_core_gn.dll` (8.24 MB), `oneauth.dll` (6.38 MB), `dual_engine_adapter_x64.dll` (5.59 MB), `telclient.dll` (4.17 MB), `oneds.dll` (3.48 MB), `EBWebView/`, `edge_game_assist/`, `WidevineCdm/` |
| **Sectium** *(Open Source BSD-3 Core)* | `E:\b8g-chromium-real\src\out\B8gRelease` *(component build)* | `chrome.dll` (**166.41 MB**, split modular components) | **21.19 MB** | **Zero** (`0` `optimization_guide_internal`, `0` `LiteRt`, `0` `WidevineCdm`, `0` `os_update_handler`, `0` `oneauth`/`telclient`/`oneds`/`dual_engine_adapter`) |

---

## 3. Source Anchors (For Future Manuals, Training & Edge Blog)

- **Development History Blog (Edge Markdown — 17 Entries):** `docs/awesome-os-development-history-blog/index.md` · `01` (`docs/awesome-os-development-history-blog/01-ending-the-browser-era-e2c-milestone.md`) · `02` (`docs/awesome-os-development-history-blog/02-evolving-beyond-lo-v8-snapshots-and-self-maintaining-ci.md`) · `03` (`docs/awesome-os-development-history-blog/03-adversarial-memory-model-review-capability-epochs.md`) · `04` (`docs/awesome-os-development-history-blog/04-beyond-css-flat-array-layout-and-pluggable-window-managers.md`) · `05 (Host Debug)` (`docs/awesome-os-development-history-blog/05-full-speed-internal-paced-legacy-host-debug-facade.md`) · `06` (`docs/awesome-os-development-history-blog/06-dismantling-legacy-interfaces-hardforks-electron-cloud-collapse.md`) · `07` (`docs/awesome-os-development-history-blog/07-from-early-kernel-plans-to-b8g-sect-1-and-scalar-uvs.md`) · `08` (`docs/awesome-os-development-history-blog/08-empirical-proof-archive-constant-time-t2-boot-driver-fabric.md`) · `09` (`docs/awesome-os-development-history-blog/09-deep-research-and-legacy-docs-index.md`) · `10 (Notebooks)` (`docs/awesome-os-development-history-blog/10-executable-markdown-notebooks-and-dual-transport-docs.md`) · `11 (Algebra)` (`docs/awesome-os-development-history-blog/11-stealify-composition-algebra-and-geometric-surface-language.md`) · `12 (b8g-browser)` (`docs/awesome-os-development-history-blog/12-b8g-html-native-html-css-js-without-webkit.md`) · `13 (V8/Chromium)` (`docs/awesome-os-development-history-blog/13-google-v8-chromium-side-challenge-and-verification-pipeline.md`) · `14 (Playbook)` (`docs/awesome-os-development-history-blog/14-crash-recovery-to-zero-webkit-browser-command-playbook.md`) · `15 (B8G Xenon 1B)` (`docs/awesome-os-development-history-blog/15-b8g-xenon-1b-cognitive-core-and-atlaskv-memory.md`) · `16 (Flex Sheet)` (`docs/awesome-os-development-history-blog/16-verified-benchmark-flex-sheet-and-chromium-sparse-attack.md`) · `17 (Chromium Core)` (`docs/awesome-os-development-history-blog/17-chromium-first-class-section-autoupdate-telemetry-migration.md`)
- **Interactive Docs & Notebook Runner (`bin\b8g-docs.ps1`):** `intersections/docs-reader/README.md` · `intersections/docs-reader/index.mts` · `intersections/docs-reader/cli.host.mts`
- **Standalone Section & Intersection Host Run/Test Matrix:** `docs/STANDALONE-SECTIONS-MATRIX.md` *(or `bin\b8g-docs.ps1 open standalone-matrix`)*
- **Master Roadmap & Living TODO Register:** `docs/AWESOME-OS-ROADMAP-TODOS.md` *(or `bin\notebook.ps1 open roadmap-todos`)*
- **Chromium `third_party/ipcz` Zero-Copy C++20 SPSC Ring Fast-Path:** `sections/chromium-build/ipcz-fastpath/b8g_ipcz_spsc_ring.h` · `sections/chromium-build/ipcz-fastpath/README.md`
- **Google V8 & Chromium Side-Challenge + Unified Cross-OS Flex Report:** `benchmarks/v8-chromium-side-challenge/CHROME-STACK-FLEX-REPORT.md` · `benchmarks/v8-chromium-side-challenge/chromium-stack-flex.host.mts` · `benchmarks/v8-chromium-side-challenge/verify-pipeline.host.mts`
- **Flat-Array Layout & 4 Pluggable WMs:** `packages/@awesome-os/b8g-layout/src/index.mts` · `sections/window-layout/index.mts` · `sections/canvas-branch/branch-runtime.host.mts`
- **Repo Refactoring & Autonomous V8 CI Plan:** `docs/REPO-REFACTORING-AND-V8-CI-PLAN.md`
- **Living Catalog:** `intersections/dev-catalog/index.mts` · `intersections/dev-catalog/cli.host.mts`
- **Legacy Host Debugging Facade (Back-Off, `fsync` Flight Recorder & 8 s Auto-Exit):** `intersections/host-debug-facade/README.md` · `intersections/host-debug-facade/index.mts` · `intersections/host-debug-facade/flight-recorder.host.mts`
- **Native WebGPU GFX Host (`--window` / `--headless` / `--kitty`):** `packages/@awesome-os/b8g-gfx-host/src/render-abi.mts` · `packages/@awesome-os/b8g-gfx-host/native/src/lib.rs`
- **Universal `.b8p` CAS Toolchains:** `sections/cxx-build/index.mts` · `sections/rust-build/index.mts` · `sections/zig-build/index.mts` · `benchmarks/toolchain-bench/run-bench.host.mts`
- **Clean V8 Section ABI + Snapshot/CDP REPL:** `sections/b8g-abi-v8/index.mts` · `sections/b8g-abi-v8/cdp-repl.mts` · `sections/b8g-abi-v8/repl-projection.host.mts` · `sections/b8g-abi-v8/b8g_abi_v8_section.h`
- **Zero-Compiler GitHub Stream Runner & PO Handoff:** `repository/b8g-cloud-platform/docs/B8G-STREAM-RUNNER-HANDOFF.md` · `repository/b8g-cloud-platform/src/stream-runner/tenant-shapes.mts` · `repository/b8g-cloud-platform/src/stream-runner/authority-mapper.mts`
- **WASI / `.b8e` Cell Runners:** `repository/wasi-host-implementations/src/engine/b8g-engine.mts` · `packages/@awesome-os/b8g-emcc/src/b8e-format.mts`
- **VT100 / Kitty `CSI u` Input Decoder:** `sections/input/index.mts`
- **Shim Provenance & Doctor:** `packages/@awesome-os/bin-shim/src/provenance.mts`
- **Host Visual Probe:** `sections/display/frank-host-snapshoot.mts`
- **Experimental Cloud-Only CDP Driver:** `sections/display/cdp-arena-driver.mts`
- **StealifyLang Spec Index:** `docs/stealifylang/README.md`
- **Section Shapes, Stream Liveness & Zero-Latency Execution (`.mts`, Rust 2024, C++23):** `docs/stealifylang/SECTION-SHAPES-AND-LIVENESS-EXAMPLES.md` · [`ARCHITECTURE.md §9`](../ARCHITECTURE.md#9-the-fundamental-stream-unit-axiom-hardware-to-ui-unification)
- **Autarkic Sovereign Desktop & Cloud Console (`15` 1-Click Apps):** `intersections/b8g-vm-manager/vm-screen-renderer.mts` (`Sectium Commander`, `LLM & LoRA Studio` [OpenAI/Ollama/Unsloth/Colab], `Host Disk Analyzer`, `Vault & Multi-Host SSH`, `Devices & Shard Mesh`, `CAS Module Registry`, `Build Grid & Code Review`, `Asymmetric Hunt 3D`)
- **7-Subtree Minimal `Sectium` Upstream Allowlist:** [`sections/chromium-build/sectium-minimal-allowlist.mts`](../sections/chromium-build/sectium-minimal-allowlist.mts) · `intersections/b8g-upstream-maintainer/registry.json`
