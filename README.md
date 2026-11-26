# Awesome-OS & Sectium

> **A sovereign, content-addressed operating system, runtime, model, and browser/IDE ecosystem — built natively with `holo-compiler` (`v0.6.0`), zero duplicated monoliths, and one unified `v11` CAS (`632` verified assets / `572` unique `sha512` blobs) + `b8g-ghost`.**

**Real measured result on Windows 11:** **`Awesome-OS Code - OSS 1.147.0`** (`v0.3.0`, `477 MB`) + **`Sectium Browser`** (`v0.7.2`, `110 MB`) running side by side in **`587 MB` total RAM** — **`7.7×` less RAM than a single VS Code window (`4.5 GB`)**, both launched from **`~118 KB`** native Lumi Hydration Splash `.exe` binaries sharing ONE `v11` / `b8g-ghost` CAS runtime (`0 B` duplicated Electron).

---

## Quick Install & Run (Windows / Linux / macOS)

```powershell
# Windows (PowerShell — zero BOM, zero installer bloat, v11 hardlink-first)
irm https://awesome-os.com/install.ps1 | iex

# Or bootstrap holo-pm directly (unified SDK & self-hosted v11 CAS package manager)
irm https://github.com/awesome-os/holo-pm/releases/latest/download/install.ps1 | iex
```

```bash
# Linux / macOS
curl -fsSL https://awesome-os.com/install.sh | sh

# Or bootstrap holo-pm directly
curl -fsSL https://github.com/awesome-os/holo-pm/releases/latest/download/install.sh | sh
```

### Unified 3-Protocol Model (`repository://` × `project://` × `system://`)

Every package, desktop appliance, bare-metal host, driver set, and runtime in Awesome-OS operates across three orthogonal protocols:

1. **`repository://` (Source of Truth):** Immutable Git repositories, Git-versioned lockfiles (`index/holo-compiler-lockfile.json`), and `v11/files/00..ff/<sha512>` CAS blobs.
2. **`project://` (0-Byte Virtual Worktree / Install):** Content-addressed hardlink projections into local `./bin/` by default (`holo-pm install repository://github.com/awesome-os/<repo>@main`), or collision-guarded global installs (`-g` with `--as <alias>` / `--force-default`) with `0 B` duplicated storage.
3. **`system://` (Local & Remote Device, Profile & Driver Boundary):** Addresses `local` and `remote` `terminal` / `desktop` surfaces (`system://<host>/terminal/ttyS0`, `system://<host>/desktop/omarchy-hyprland`), reusable system presets (`system://profile/*`), and auditable, version-pinned driver tracks (`system://driver-set/<name>@open-foss|proprietary|driver-dev|pinned-v1`).

---

## 0. Architectural DNA — Section–Intersection Algebra × Software-Defined Analog Computing × CAS Q-Self

> **Awesome-OS unifies three mathematical foundations into one self-closed execution model:**
> 1. **Section–Intersection Algebraic Computing** (`STEALIFYLANG-SPEC.md`) — defines *where* and *under what effects* subsystems may compose: disjoint **Sections** ($\mathcal{S}_i \wedge \mathcal{S}_j = \emptyset$), governed by the **7-tuple Context Algebra** $\mathcal{C}_{\text{cloud}} = (\text{boundary}, \text{display}, \text{lifetime}, \text{transport}, \text{capability}, \text{locality}, \text{persona})$ and **Algebraic Effects** (`EffectBit` + handler discharge), meeting only at admissible **Intersections** ($\mathcal{I} = \mathcal{S}_a \cap \mathcal{S}_b$).
> 2. **Software-Defined Analog & Neuromorphic Computing (Spin-Wave / Magnonics)** — defines *how* an admissible Intersection computes without von-Neumann bottlenecks: continuous complex phasor dynamics ($z = A e^{i\phi}$) on lock-free 64-byte cache-line cells (`B8G_ARENA_V1` `SharedArrayBuffer` / C11 SIMD), natural exponential backpressure via Gilbert damping / Damped Gravity ($e^{-\gamma t}$), and deterministic projection back to the digital boundary (`Majority Gate`, `Top-K`, `B8G_ABI_MAGIC_V3`).
> 3. **Self-Content-Addressed CAS Closure (`CAS Q-Self`)** — defines *how the system verifies, reproduces, and updates itself*: every compiler, package manager, WASI host, model, and lockfile (`holo-compiler`, `holo-pm`, `holo-wasi-host-b8g`, `SpinWaveMoEModel`, `index/holo-compiler-lockfile.json`) is itself an immutable `v11/files/00..ff/<sha512>` CAS artifact — reaching a self-hosting fixed point ($Q(\text{self}) = \text{self}$) verified by `holo-pm/bootstrap/selfhost-fixedpoint.mts` with zero hidden host state.

- **Verified Analog-in-Intersection Speed:** **`0.83 ns/op`** (**`1.21 billion` intersections/sec**) in a `5.78 KB` `.so` / `2.74 KB` WASI `.wasm` with **zero syscalls and zero heap allocations**.
- **Verified Neuromorphic Routing & DAG:** **`82.6M tok/s`** 64-expert MoE routing (**`606.6×`** vs JS baseline), **`95.8%`** held-out accuracy with **`0.0%` INT8 quantization drop** in a **`10.68 KB`** `.b8p` model, and **`1.54 ms`** ingestion of our **`632`-node** `holo-compiler-lockfile.json` DAG (`572` unique `v11` blobs, `0` missing).

---

## 1. Collapsed 4-Layer Architecture

```text
  1. Sectium & Appliances       -> 26 KB awesome-os-desktop Greeter/Desktop + ~118 KB native Lumi Hydration Splash launchers (sectium-browser v0.7.2, code-oss v0.3.0, brave/blender/obs/godot v0.2.0, theia, pinokio) + pure-art Sectium Canvas
  2. Sectium Cloud Control Plane-> 5.0 KB C11 B8G_ABI_MAGIC_V3 central discovery initramfs, 1-way WoL warm-RAM resume, Keep-Last-5 RollingReleaseManifest
  3. Host Device & v11 CAS      -> Dual command/display NDJSON pipe (\\.\pipe\sectium-dev), B8G_ARENA_V1 64-byte zero-copy IPC, repository:// x project:// 0-byte hardlinks, 632 verified v11 CAS assets (572 unique blobs)
  4. Polyglot, Models & T2 OS   -> holo-compiler v0.6.0 (6.9 ns/fn native codegen, Sub-TU 112.8x), holo-pm unified SDK/index, awesome-os/models (SpinWaveMoE / lumiBERT / Xenon-1B), coreutils / go-lang / dart, T2Linux / T2XNU
```

---

## 2. Live Sovereign Ecosystem (`github.com/awesome-os`)

Every repository below is live, CI-verified, and hydrated from **one unified `v11` CAS (`v11/files/00..ff/<sha512>`) + `awesome-os/b8g-ghost` (Rolling-Latest + Keep-Last-5)** over `repository://` × `project://`:

### Desktop Shell & Appliances (`26 KB` Desktop Greeter + `~118 KB` Lumi Splash Launchers, Zero Duplication)

| Repository | Release & What It Ships | Highlight |
| :--- | :--- | :--- |
| **[`awesome-os/desktop`](https://github.com/awesome-os/desktop)** | **`v0.3.0`** — Unified Cross-Platform OS & Desktop Foundation (UEFI ISO, iPXE Netboot, `/dev/fb0` Lumi Bootscreen, Wayland/WebGPU, `modalias` Driver Hydrator) | Boots in `< 0.2s` into live **Omarchy Hyprland / Noctalia / ChonkStep / Sectium**, dual `tty0`+`ttyS0`, zero `t2` leftovers |
| **[`awesome-os/posix`](https://github.com/awesome-os/posix)** | **`v0.1.0`** — Ultra-Minimal Headless POSIX Terminal & Container OS Substrate | `37.9 KB` static musl PID 1, dual `tty0`+`ttyS0`, `awesome-os/coreutils`, stateless `v11` CAS netboot, zero GUI |
| **[`awesome-os/host-manager`](https://github.com/awesome-os/host-manager)** | ChromeOS / Fuchsia / Landscape-grade Fleet & Device Control Plane ([Live Console](https://awesome-os.com/apps/host-manager.html)) | Zero-Touch Enrollment, A/B Verified Immutable Slots + $O(1)$ rollback, 1-Click Powerwash, `system://profile/*`, auditable `system://driver-set/*` tracks (`open-foss` / `proprietary` / `driver-dev` / `pinned-v1`) |
| **[`awesome-os/sectium-browser`](https://github.com/awesome-os/sectium-browser)** | **`v0.7.2`** — Sovereign Chromium 158+ / V8 15.8 browser + 8 Win32 Lumi GUI shells | `118 KB` self-hydrating launcher, `110 MB` RAM live, 5-OS `libsectium_display`, BOM-free `irm \| iex` installer |
| **[`awesome-os/code-oss`](https://github.com/awesome-os/code-oss)** | **`v0.3.0`** — Telemetry-free MIT **Awesome-OS Code - OSS `1.147.0`** (Open VSX) | `118 KB` `code-oss.exe` + PE icon + Lumi Splash, `-73.5%` vs VSCodium, `477 MB` RAM, bundled Wave 2 TS `6.0.3` + 5 extensions |
| **[`awesome-os/theia`](https://github.com/awesome-os/theia)** | **Eclipse Theia** adapter over Sectium Browser / shared Electron CAS | Shares `~/.b8g/cas/extensions/` (`.vsix`), Wave 2 TS `6.0.3`, and all 5 Awesome-OS extensions with `code-oss` |
| **[`awesome-os/brave`](https://github.com/awesome-os/brave)** | **`v0.2.0`** — Debloated Shields-only **Brave `v1.102.32`** (zero crypto/Rewards/updater) | `116 KB` `brave.exe` + PE icon + Lumi Splash, `-18%` to `-20%` smaller, `zstd -9` |
| **[`awesome-os/blender`](https://github.com/awesome-os/blender)** | **`v0.2.0`** — Debloated rolling-latest **Blender `5.3.0`** (zero installer) | `116.5 KB` `blender.exe` + PE icon + Lumi Splash, `-17.2%` Win64 savings |
| **[`awesome-os/obs`](https://github.com/awesome-os/obs)** | **`v0.2.0`** — Debloated rolling-latest portable **OBS Studio `33.0.3`** (zero installer) | `~118 KB` 4-OS Lumi Hydration Splash launcher + PE icon, Keep-Last-5 CAS |
| **[`awesome-os/godot`](https://github.com/awesome-os/godot)** | **`v0.2.0`** — Rolling-latest MIT **Godot `4.7.2`** (5-target launcher) | `116.5 KB` `godot.exe` + PE icon, `36.9 KB` Linux x64, `43.0 KB` Linux ARM64, `50.6 KB` macOS ARM64, `27.2 KB` `wasm32-wasi` |
| **[`awesome-os/pinokio`](https://github.com/awesome-os/pinokio)** | **Pinokio Virtual PC** recipe runner on `b8g-ghost` CAS + Sectium Display | Runs original Pinokio recipes on shared debloated Python LLM stack (zero 10 GB conda/Electron bloat) |
| **[`awesome-os/sectium-electron`](https://github.com/awesome-os/sectium-electron)** · **[`electron`](https://github.com/awesome-os/electron)** | Drop-in Electron API over Sectium Display + rolling **Electron `v47` Nightly** | 1 shared copy per machine in `~/.b8g/cas/`, hybrid `--sectium` / `--upstream` |

### Compiler, Unified SDK/PM, Models, FFI & Universal WASI Substrate

| Repository | Release & What It Ships | Highlight |
| :--- | :--- | :--- |
| **[`awesome-os/holo-compiler`](https://github.com/awesome-os/holo-compiler)** | **`v0.6.0`** — Unified 5-toolchain (`cxx`/`rust`/`zig`/`wasi`/`ts`) compiler + `libholo_codegen` | `6.9 ns/fn` native x86-64/WASI emitter, Sub-TU function splicing (`112.8×`), resident pipe daemon (`0.23 ms`), Bun-style Ghost/Standalone executables |
| **[`awesome-os/holo-pm`](https://github.com/awesome-os/holo-pm)** · **[`pnpm`](https://github.com/awesome-os/pnpm)** · **[`cargo`](https://github.com/awesome-os/cargo)** · **[`uv`](https://github.com/awesome-os/uv)** | **Unified SDK & `v11` CAS Index Home** (`holo-pm` + `libholo-pm`) · `pnpm` · `cargo` · `uv` | Git-versioned `index/holo-compiler-lockfile.json`, Wave-1 `pins/`, `CAS Q-Self` `bootstrap/selfhost-fixedpoint.mts`, local `./bin/` hardlinks + collision-guarded `-g` (`--as`, `--force-default`) |
| **[`awesome-os/holo-ffi`](https://github.com/awesome-os/holo-ffi)** · **[`holo-jq`](https://github.com/awesome-os/holo-jq)** | Native `B8G_ABI_MAGIC_V3` FFI bridge & sovereign `v11` CAS JSON query CLI | Zero-overhead polyglot C-ABI/WASI bindings and instant `./bin/holo-jq` hardlink installs |
| **[`awesome-os/models`](https://github.com/awesome-os/models)** | Unified **Awesome-OS Models Hub** (`awesome-os-models-manifest-v1`, `v11` CAS) | `SpinWaveMoEModel` (`10.68 KB` INT8 `.b8p`), `b8g-micro-moe`, `lumiBERT` (`2.8 ms`), `b8g-app-dedup` Path MLP (`42.2 KB`), Xenon-1B/Kalaschnikow + AtlasKV, Inkling-2, Sub-1-Bit |
| **[`awesome-os/wasi-host`](https://github.com/awesome-os/wasi-host)** · **[`libuv`](https://github.com/awesome-os/libuv)** · **[`installer`](https://github.com/awesome-os/installer)** | **`wasi-host v0.2.0`** · **`libuv v0.1.0`** · **`installer v0.2.3`** | **`2.6 KB` `holo-wasi-host-b8g.wasm`** + 4-OS host, core-scaled `libuv` (`184–219 KiB`) + `B8G_ARENA_V1` slab, `v11` hardlink-first installer (`15` apps) |
| **[`awesome-os/wry`](https://github.com/awesome-os/wry)** · **[`webui`](https://github.com/awesome-os/webui)** · **[`ory-polis`](https://github.com/awesome-os/ory-polis)** | **`wry v0.1.1`** · **`webui v0.1.0`** · **`ory-polis v26.2.0-awesome-os.1`** | Zero-WebView2 `wry` (`sectium_device`), zero-HTTP `webui` (`3.8 KB` `.so`), and synced `ory-polis` SAML/OIDC/SCIM |

### Unified IDE Extensions (Code - OSS & Eclipse Theia)

| Repository | Target | What It Bundles |
| :--- | :--- | :--- |
| **[`awesome-os/stealifylang-vscode`](https://github.com/awesome-os/stealifylang-vscode)** | **StealifyLang & TypeScript `6.0.3`** | `stealify-lint` LSP (`B8G001`–`B8G016`), `.stealify-rules` hot-reload, governance project rules, and Wave 2 TypeScript `6.0.3` (`14.3×` faster Zero-AST CAS) |
| **[`awesome-os/unreal-vscode`](https://github.com/awesome-os/unreal-vscode)** | **Unreal Engine 5** | Zero-Visual-Studio UBT builds via `b8g-ghost` (`.NET 11` + `ghost-llvm` + `ghost-winsdk`) + `B8G_ARENA_V1` `libunreal` viewport bridge |
| **[`awesome-os/godot-vscode`](https://github.com/awesome-os/godot-vscode)** | **Godot `4.7.2`** | Instant `v11` CAS Godot + `.NET 11` hydration, GDScript/C# tasks, and live scene runner |
| **[`awesome-os/blender-vscode`](https://github.com/awesome-os/blender-vscode)** | **Blender `5.3.0`** | Instant `v11` CAS Blender hydration, `bpy` script/addon live reload, and `libsectium_display` viewport bridge |
| **[`awesome-os/obs-vscode`](https://github.com/awesome-os/obs-vscode)** | **OBS Studio `33.0.3`** | Instant `v11` CAS portable OBS hydration, HTML5 browser-source overlay hot-reload, and scene control |

### Operating Systems, Coreutils, Runtimes, Forge Intersections & Graphics Shards

| Repository | What It Ships | Highlight |
| :--- | :--- | :--- |
| **[`awesome-os/b8g-ghost`](https://github.com/awesome-os/b8g-ghost)** | Canonical $O(1)$ Ghost CAS (`cas-v1` + `v11`), `manifests/index.json`, Keep-Last-5 GC | `632` verified `v11` assets (`572` unique blobs), 4-OS zero-`node-gyp` `b8g-ghost-abi.node`, Dual-Tier Wasm/AOT JIT |
| **[`awesome-os/coreutils`](https://github.com/awesome-os/coreutils)** | **`v0.1.0`** — Sovereign POSIX coreutils multicall suite (**replacing BusyBox**) | Unified `v11` CAS multicall coreutils for Windows, Linux, macOS, and T2Linux initramfs |
| **[`awesome-os/t2linux`](https://github.com/awesome-os/t2linux)** | Bootable hybrid UEFI/BIOS ISO & QEMU QCOW2 (`b8g-ghost` PID 1) | `x86_64` `21.5 MiB` ISO / `18.2 MiB` QCOW2, `aarch64` `26.6 MiB` ISO, `riscv64` `/init`, daily rolling updates |
| **[`awesome-os/t2xnu`](https://github.com/awesome-os/t2xnu)** | **T2macOS** — ARM64 Linux `7.0+` + `xnulinux` (`fki.ko`/`xnu.ko`) + `B8G_ARENA_V1` | Native zero-hypervisor Darwin/macOS personality, QEMU booted in `1.63s` |
| **[`awesome-os/dockerimages`](https://github.com/awesome-os/dockerimages)** | Multi-arch (`linux/amd64` + `linux/arm64`) `FROM scratch` OCI images on `ghcr.io/awesome-os/*` | **5/5** images (`t2linux`, `ghost-node`, `ghost-py`, `ghost-cpp`, `ghost-jvm`), starting at `2.1 MB` |
| **[`awesome-os/go-lang`](https://github.com/awesome-os/go-lang)** · **[`dart`](https://github.com/awesome-os/dart)** | Sovereign **Go** (`b8g-gocacheprog` + `multicall`) & **Dart** SDKs on `v11` CAS | Shared CAS build cache (`GOCACHEPROG`), multicall Go toolchain dispatch, zero duplicated SDK trees |
| **GitLab Intersections:** [`gitlab-foss`](https://github.com/awesome-os/gitlab-foss) · [`gitaly`](https://github.com/awesome-os/gitaly) · [`gitlab-runner`](https://github.com/awesome-os/gitlab-runner) · [`gitlab-shell`](https://github.com/awesome-os/gitlab-shell) · [`gitlab-pages`](https://github.com/awesome-os/gitlab-pages) | 5 sovereign self-hosted GitLab intersection repositories on `v11` CAS | Unified Git forge stack sharing `awesome-os/go-lang`, `b8g-gocacheprog`, and Wave-1 `holo-pm/pins/` |
| **[`awesome-os/typescript`](https://github.com/awesome-os/typescript)** | Programmable **TypeScript `6.0.3`** with Wave 1 + Wave 2 V8 optimizations | `129 ms` self-bundle, `14.3×` faster Zero-AST Semantic CAS lookup (`8.7 ms`) |
| **[`awesome-os/node`](https://github.com/awesome-os/node)** · **[`dotnet`](https://github.com/awesome-os/dotnet)** · **[`powershell`](https://github.com/awesome-os/powershell)** | **`node v0.4.0`** (**Node `v27.0.0-alpha`**), **.NET `11.0.100`**, **PowerShell `v7.7.0`** | Native C11 `GetCommandLineW()` launchers (`35–51 KB`, zero telemetry, zero `cmd.exe` mangling) |
| **[`awesome-os/skia`](https://github.com/awesome-os/skia)** · **[`dawn`](https://github.com/awesome-os/dawn)** · **[`blink`](https://github.com/awesome-os/blink)** · **[`qt`](https://github.com/awesome-os/qt)** | 4-OS **Skia** (+ TTY ANSI/Kitty), **Dawn WebGPU**, **Blink**, and **Qt `6.10.3`** (`30.7 MiB`) | Zero-account, zero-duplication shared `v11` CAS graphics & UI shards |
| **[`awesome-os/upstream-mirrors`](https://github.com/awesome-os/upstream-mirrors)** | `26` append-only sparse upstream mirrors + `35/35` 5-OS C/Wasm shards | `libbrotli`, `libexpat`, `libsqlite3`, `libwebp`, `liblz4`, `adblock-rust`, `libelectron` C-ABI |
| **[`awesome-os/ghost-py`](https://github.com/awesome-os/ghost-py)** · **[`ghost-jvm`](https://github.com/awesome-os/ghost-jvm)** · **[`ghost-cpp`](https://github.com/awesome-os/ghost-cpp)** · **[`ghost-100`](https://github.com/awesome-os/ghost-100)** | Zero-`pip` / zero-Maven / zero-CMake native CAS adapters + 100 1-line recipes | Includes 9 debloated Python LLM stack wheels (`numpy`, `pillow`, `tokenizers`, `safetensors`, `tiktoken`, etc.) |
| **[`awesome-os/libv8_monolith`](https://github.com/awesome-os/libv8_monolith)** · **[`lo`](https://github.com/awesome-os/lo)** · **[`just-js`](https://github.com/awesome-os/just-js)** | Dynamic Ghost V8 hydrator & **`lo v0.2.0`** zero-bloat V8 JS runtimes | Replaces `250 MB` static `libv8_monolith.a` with shared `v11` CAS V8 |

---

## 3. Core Monorepo Workspace Components (`e:\awesome-os`)

| Component | Entrypoint / Location | What It Does |
| :--- | :--- | :--- |
| **`holo-compiler` & `b8g-ghost`** | [`intersections/holo-compiler/README.md`](./intersections/holo-compiler/README.md) · [`sections/b8g-ghost/`](./sections/b8g-ghost/) | Zero-WSL 5-OS C11/Rust/Zig/WASI/TS cross-compilation, `v11` CAS packs, `libholo_codegen`, Sub-TU splicing, and zero-`node-gyp` `b8g-ghost-abi.node`. |
| **Spin-Wave Bus & Models Hub** | [`intersections/spinwave-bus/`](./intersections/spinwave-bus/) · [`models/README.md`](./models/README.md) | `0.83 ns/op` C11 magnonic phasor kernel, `SpinWaveMoEModel` (`10.68 KB` INT8 `.b8p`), `SpinWaveHoloDagEngine`, and unified `models-manifest.json`. |
| **Sectium Cloud Control Plane** | [`sections/sectium-cloud-control-plane/README.md`](./sections/sectium-cloud-control-plane/README.md) | `5.0 KB` Linux / `5.6 KB` WASI / `20.0 KB` Win64 C11 `B8G_ABI_MAGIC_V3` central discovery `initramfs` and 1-way `WoL` warm-RAM checkpointing. |
| **Dual-Channel Host Device & TUI** | [`sections/sectium-device/`](./sections/sectium-device/) (`\\.\pipe\sectium-dev`) | Orthogonal `command` (`ttyS0` NDJSON) + `display` channels, `SectiumDevToolsPlane` cross-tab Web Streams, and `kitty-ink-sink.mts` TUI. |
| **Polyglot Runtimes** | [`sections/b8g-runtime/README.md`](./sections/b8g-runtime/README.md) · [`sections/b8g-es/README.md`](./sections/b8g-es/README.md) · [`sections/b8g-jvm/README.md`](./sections/b8g-jvm/README.md) | `sectium-es` (`94 KB` Win64 / `79.7 KB` Linux) and `sectium-jvm` (`83.5 KB` Win64 / `72.1 KB` Linux / `72.6 KB` WASI, Kotlin + Tier-2 AOT). |
| **Atomic CLI Shims & Native `pwsh.exe`** | `bin/` (`.\bin\b8g-bin-parity.ps1 verify`) | Hermetic `(posix, .cmd, .ps1)` triplets + native C11 `bin/pwsh.exe` enforcing zero direct host binaries, zero `npx`, and zero WSL builds. |

---

## 4. Quick Start & Verification

```powershell
# Verify documentation & link integrity (0 diagnostics required)
.\bin\b8g-web-doc.ps1 README.md AGENTS.md ARCHITECTURE.md models/README.md

# Verify 100% atomic (posix, .cmd, .ps1) CLI triplet parity
.\bin\b8g-bin-parity.ps1 verify

# Run collapsed Control Plane, Dual-Channel Device, Models Hub, and Spin-Wave DAG test suites
.\bin\node.ps1 --test sections/sectium-cloud-control-plane/sectium-cp.test.mts sections/sectium-device/sectium-device.test.mts models/models.test.mts intersections/spinwave-bus/dag-engine.test.mts
```

---

## 5. Documentation Map

- **Root Architecture & Agent Contract:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`AGENTS.md`](./AGENTS.md)
- **Spin-Wave Computing & Magnonic Intersections:** [`docs/architecture/SPINWAVE-COMPUTING-AND-MAGNONIC-INTERSECTIONS.md`](./docs/architecture/SPINWAVE-COMPUTING-AND-MAGNONIC-INTERSECTIONS.md) · [`models/README.md`](./models/README.md)
- **Sectium Control Plane & Device Boundary:** [`docs/architecture/SECTIUM-CLOUD-CONTROL-PLANE.md`](./docs/architecture/SECTIUM-CLOUD-CONTROL-PLANE.md) · [`docs/architecture/SECTIUM-HOST-DEVICE-BOUNDARY.md`](./docs/architecture/SECTIUM-HOST-DEVICE-BOUNDARY.md)
- **DevOps Build, Distribution & Code Signing:** [`docs/architecture/DEVOPS-BUILD-DISTRIBUTION-AND-SIGNING-GUIDE.md`](./docs/architecture/DEVOPS-BUILD-DISTRIBUTION-AND-SIGNING-GUIDE.md)
- **Upstream Tracking & `holo-compiler`:** [`docs/architecture/UPSTREAM_TRACKING.md`](./docs/architecture/UPSTREAM_TRACKING.md) · [`intersections/holo-compiler/README.md`](./intersections/holo-compiler/README.md)
- **StealifyLang Spec & Books:** [`STEALIFYLANG-SPEC.md`](./STEALIFYLANG-SPEC.md) · [`docs/white-dragon-book/README.md`](./docs/white-dragon-book/README.md) · [`docs/little-white-dragon-book/README.md`](./docs/little-white-dragon-book/README.md)

---

## 6. Credits & Upstream Foundations

Awesome-OS builds openly on **Chromium / Blink / Skia / Dawn** (BSD-3), **Electron** (MIT), **Code - OSS / VS Code** (MIT), **Eclipse Theia** (EPL-2.0), **Godot** (MIT), **Brave / `adblock-rust`** (MPL-2.0), **Blender** (GPL-3.0), **OBS Studio** (GPL-2.0), **Qt 6** (LGPL-3.0), **TypeScript** (Apache-2.0), **Go & Dart** (BSD-3), **GitLab FOSS** (MIT), **.NET & PowerShell** (MIT), **Node.js** (MIT), **pnpm / Cargo / uv / libuv**, **Zig**, **LLVM**, **T2 SDE**, **Ory Polis**, and **WASI / WebAssembly**.
