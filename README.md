# Awesome-OS & Sectium

> **A sovereign, content-addressed operating system, runtime, and browser/IDE ecosystem — built natively with `holo-compiler`, zero duplicated monoliths, and one canonical $O(1)$ Ghost CAS (`awesome-os/b8g-ghost @ cas-v1`).**

**Real measured result on Windows 11:** **`Awesome-OS Code - OSS 1.147.0`** (`477 MB`) + **`Sectium Browser`** (`110 MB`) running side by side in **`587 MB` total RAM** — **`7.7×` less RAM than a single VS Code window (`4.5 GB`)**, both launched from **`~118 KB`** native Lumi Hydration Splash `.exe` binaries sharing ONE `b8g-ghost` CAS runtime (`0 B` duplicated Electron).

---

## 1. Collapsed 4-Layer Architecture

```text
  1. Sectium & Appliances       -> ~118 KB native Lumi Hydration Splash launchers (sectium-browser, code-oss, brave, blender, theia) + pure-art Sectium Canvas
  2. Sectium Cloud Control Plane-> 5.0 KB C11 B8G_ABI_MAGIC_V3 central discovery initramfs, 1-way WoL warm-RAM resume, Keep-Last-5 RollingReleaseManifest
  3. Host Device & b8g-ghost CAS-> Dual command/display NDJSON pipe (\\.\pipe\sectium-dev), B8G_ARENA_V1 64-byte zero-copy IPC, 149+ verified cas-v1 blobs
  4. Polyglot & T2Linux         -> holo-compiler (zero-WSL 5-OS builds), Shared V8 (dup_v8=0 B), sectium-es/jvm, Wave 2 TypeScript 6.0.3, bootable T2Linux ISO/QCOW2
```

---

## 2. Live Sovereign Ecosystem (`github.com/awesome-os`)

Every repository below is live, CI-verified, and hydrated from **one canonical $O(1)$ Ghost CAS (`awesome-os/b8g-ghost @ cas-v1`, Rolling-Latest + Keep-Last-5)**:

### Desktop Appliances (`~118 KB` Lumi Splash Launchers, Zero Duplication)

| Repository | What It Ships | Highlight |
| :--- | :--- | :--- |
| **[`awesome-os/sectium-browser`](https://github.com/awesome-os/sectium-browser)** | Sovereign Chromium 158+ / V8 15.8 browser + 8 Win32 Lumi GUI shells | `118 KB` self-hydrating launcher, `110 MB` RAM live, 5-OS `libsectium_display` |
| **[`awesome-os/code-oss`](https://github.com/awesome-os/code-oss)** | Telemetry-free MIT **Awesome-OS Code - OSS `1.147.0`** (Open VSX) | `118 KB` `code-oss.exe` + Lumi Splash, `-73.5%` vs VSCodium, `477 MB` RAM |
| **[`awesome-os/brave`](https://github.com/awesome-os/brave)** | Debloated Shields-only **Brave `v1.102.32`** (zero crypto/Rewards/updater) | `116 KB` `brave.exe` + Lumi Splash, `-18%` to `-20%` smaller, `zstd -9` |
| **[`awesome-os/blender`](https://github.com/awesome-os/blender)** | Debloated rolling-latest **Blender `5.3.0`** (zero installer) | `116.5 KB` `blender.exe` + Lumi Splash, `-17.2%` Win64 savings |
| **[`awesome-os/theia`](https://github.com/awesome-os/theia)** | **Eclipse Theia** adapter over Sectium Browser / shared Electron CAS | Shares `~/.b8g/cas/extensions/` (`.vsix`) 100% with `awesome-os/code-oss` |
| **[`awesome-os/sectium-electron`](https://github.com/awesome-os/sectium-electron)** | Drop-in Electron API over Sectium Display + `B8G_ARENA_V1` + `_linkedBinding` | `~120 KB`, zero Chromium monolith, adapted MIT Electron docs |
| **[`awesome-os/electron`](https://github.com/awesome-os/electron)** | Drop-in rolling-latest **Electron `v47` Nightly** (Lumi `Sectium Runtime`) | 1 shared copy per machine in `~/.b8g/cas/`, hybrid `--sectium` / `--upstream` |

### OS, Containers, Compilers & Language Adapters

| Repository | What It Ships | Highlight |
| :--- | :--- | :--- |
| **[`awesome-os/b8g-ghost`](https://github.com/awesome-os/b8g-ghost)** | Canonical $O(1)$ Ghost CAS (`cas-v1`), `manifests/index.json`, Keep-Last-5 GC | `149+` verified entries, 4-OS zero-`node-gyp` `b8g-ghost-abi.node`, Dual-Tier Wasm/AOT JIT |
| **[`awesome-os/t2linux`](https://github.com/awesome-os/t2linux)** | Cross-compiled bootable hybrid UEFI/BIOS ISO & QEMU QCOW2 (`b8g-ghost` PID 1) | Boots offline to PID 1 (`B8G_ABI_MAGIC_V3`), hydrates everything from `cas-v1` |
| **[`awesome-os/dockerimages`](https://github.com/awesome-os/dockerimages)** | Ultra-slim `FROM scratch` & `b8g-ghost` OCI images on `ghcr.io/awesome-os/*` | `t2linux`, `ghost-node`, `ghost-py`, `ghost-cpp`, `ghost-jvm` sharing host CAS volume |
| **[`awesome-os/typescript`](https://github.com/awesome-os/typescript)** | Programmable **TypeScript `6.0.3`** with Wave 1 + Wave 2 V8 optimizations | `129 ms` self-bundle, `14.3×` faster Zero-AST Semantic CAS lookup (`8.7 ms`) |
| **[`awesome-os/qt`](https://github.com/awesome-os/qt)** | Zero-account, zero-installer **Qt `6.10.3`** (`qtbase`) SDK & runtime | `-78.5%` compressed (`30.7 MiB`), no Qt Account wall or 10 GB MaintenanceTool |
| **[`awesome-os/upstream-mirrors`](https://github.com/awesome-os/upstream-mirrors)** | `25` append-only sparse upstream mirrors + `35/35` 5-OS C/Wasm shards | `libbrotli`, `libexpat`, `libsqlite3`, `libwebp`, `liblz4`, `adblock-rust`, `libelectron` C-ABI |
| **[`awesome-os/ghost-py`](https://github.com/awesome-os/ghost-py)** · **[`ghost-jvm`](https://github.com/awesome-os/ghost-jvm)** · **[`ghost-cpp`](https://github.com/awesome-os/ghost-cpp)** · **[`ghost-100`](https://github.com/awesome-os/ghost-100)** | Zero-`pip` / zero-Maven / zero-CMake native CAS adapters + 100 1-line recipes | Includes 9 debloated Python LLM stack wheels (`numpy`, `pillow`, `tokenizers`, `safetensors`, `tiktoken`, etc.) |
| **[`awesome-os/libv8_monolith`](https://github.com/awesome-os/libv8_monolith)** · **[`lo`](https://github.com/awesome-os/lo)** · **[`just-js`](https://github.com/awesome-os/just-js)** | Dynamic Ghost V8 hydrator & zero-bloat V8 JS runtimes | Replaces `250 MB` static `libv8_monolith.a` with shared `cas-v1` V8 |

---

## 3. Core Monorepo Workspace Components (`e:\awesome-os`)

| Component | Entrypoint / Location | What It Does |
| :--- | :--- | :--- |
| **`holo-compiler` & `b8g-ghost`** | [`intersections/holo-compiler/README.md`](./intersections/holo-compiler/README.md) · [`sections/b8g-ghost/`](./sections/b8g-ghost/) | Zero-WSL 5-OS C11/WASI/TS cross-compilation, `.b8p` CAS packs, Dual-Tier Wasm-to-V8 JIT, and zero-`node-gyp` `b8g-ghost-abi.node`. |
| **Sectium Cloud Control Plane** | [`sections/sectium-cloud-control-plane/README.md`](./sections/sectium-cloud-control-plane/README.md) | `5.0 KB` Linux / `5.6 KB` WASI / `20.0 KB` Win64 C11 `B8G_ABI_MAGIC_V3` central discovery `initramfs` and 1-way `WoL` warm-RAM checkpointing. |
| **Dual-Channel Host Device & TUI** | [`sections/sectium-device/`](./sections/sectium-device/) (`\\.\pipe\sectium-dev`) | Orthogonal `command` (`ttyS0` NDJSON) + `display` channels, `SectiumDevToolsPlane` cross-tab Web Streams, and `kitty-ink-sink.mts` TUI. |
| **Polyglot Runtimes** | [`sections/b8g-runtime/README.md`](./sections/b8g-runtime/README.md) · [`sections/b8g-es/README.md`](./sections/b8g-es/README.md) · [`sections/b8g-jvm/README.md`](./sections/b8g-jvm/README.md) | `sectium-es` (`94 KB` Win64 / `79.7 KB` Linux) and `sectium-jvm` (`83.5 KB` Win64 / `72.1 KB` Linux / `72.6 KB` WASI, Kotlin + Tier-2 AOT). |
| **Atomic CLI Shims** | `bin/` (`.\bin\b8g-bin-parity.ps1 verify`) | Hermetic `(posix, .cmd, .ps1)` triplets enforcing zero direct host binaries, zero `npx`, and zero WSL builds. |

---

## 4. Quick Start & Verification

```powershell
# Verify documentation & link integrity (0 diagnostics required)
.\bin\b8g-web-doc.ps1 README.md AGENTS.md ARCHITECTURE.md

# Verify 100% atomic (posix, .cmd, .ps1) CLI triplet parity
.\bin\b8g-bin-parity.ps1 verify

# Run collapsed Control Plane, Dual-Channel Device, and Ghost CAS test suites
.\bin\node.ps1 --test sections/sectium-cloud-control-plane/sectium-cp.test.mts sections/sectium-device/sectium-device.test.mts sections/b8g-ghost/b8g-ghost-abi.test.mts
```

---

## 5. Documentation Map

- **Root Architecture & Agent Contract:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`AGENTS.md`](./AGENTS.md)
- **Sectium Control Plane & Device Boundary:** [`docs/architecture/SECTIUM-CLOUD-CONTROL-PLANE.md`](./docs/architecture/SECTIUM-CLOUD-CONTROL-PLANE.md) · [`docs/architecture/SECTIUM-HOST-DEVICE-BOUNDARY.md`](./docs/architecture/SECTIUM-HOST-DEVICE-BOUNDARY.md)
- **DevOps Build, Distribution & Code Signing:** [`docs/architecture/DEVOPS-BUILD-DISTRIBUTION-AND-SIGNING-GUIDE.md`](./docs/architecture/DEVOPS-BUILD-DISTRIBUTION-AND-SIGNING-GUIDE.md)
- **Upstream Tracking & `holo-compiler`:** [`docs/architecture/UPSTREAM_TRACKING.md`](./docs/architecture/UPSTREAM_TRACKING.md) · [`intersections/holo-compiler/README.md`](./intersections/holo-compiler/README.md)
- **StealifyLang Spec & Books:** [`STEALIFYLANG-SPEC.md`](./STEALIFYLANG-SPEC.md) · [`docs/white-dragon-book/README.md`](./docs/white-dragon-book/README.md) · [`docs/little-white-dragon-book/README.md`](./docs/little-white-dragon-book/README.md)

---

## 6. Credits & Upstream Foundations

Awesome-OS builds openly on **Chromium** (BSD-3), **Electron** (MIT), **Code - OSS / VS Code** (MIT), **Eclipse Theia** (EPL-2.0), **Brave / `adblock-rust`** (MPL-2.0), **Blender** (GPL-3.0), **Qt 6** (LGPL-3.0), **Zig**, **LLVM**, **T2 SDE**, and **WASI / WebAssembly**.
