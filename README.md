# Awesome-OS & Sectium

> **A sovereign, content-addressed operating system, runtime, and browser/IDE ecosystem — built natively with `holo-compiler`, zero duplicated monoliths, and one canonical $O(1)$ Ghost CAS (`awesome-os/b8g-ghost @ cas-v1`).**

**Real measured result on Windows 11:** **`Awesome-OS Code - OSS 1.147.0`** (`477 MB`) + **`Sectium Browser`** (`110 MB`) running side by side in **`587 MB` total RAM** — **`7.7×` less RAM than a single VS Code window (`4.5 GB`)**, both launched from **`~118 KB`** native Lumi Hydration Splash `.exe` binaries sharing ONE `b8g-ghost` CAS runtime (`0 B` duplicated Electron).

---

## 1. Collapsed 4-Layer Architecture

```text
  1. Sectium & Appliances       -> ~118 KB native Lumi Hydration Splash launchers (sectium-browser, code-oss, brave, blender, obs, godot, theia, pinokio) + pure-art Sectium Canvas
  2. Sectium Cloud Control Plane-> 5.0 KB C11 B8G_ABI_MAGIC_V3 central discovery initramfs, 1-way WoL warm-RAM resume, Keep-Last-5 RollingReleaseManifest
  3. Host Device & b8g-ghost CAS-> Dual command/display NDJSON pipe (\\.\pipe\sectium-dev), B8G_ARENA_V1 64-byte zero-copy IPC, 156+ verified cas-v1 blobs
  4. Polyglot & T2 OS Family    -> holo-compiler (zero-WSL 5-OS builds), Shared V8 (dup_v8=0 B), sectium-es/jvm, Wave 2 TypeScript 6.0.3, bootable T2Linux / T2XNU / T2Desktop
```

---

## 2. Live Sovereign Ecosystem (`github.com/awesome-os`)

Every repository below is live, CI-verified, and hydrated from **one canonical $O(1)$ Ghost CAS (`awesome-os/b8g-ghost @ cas-v1`, Rolling-Latest + Keep-Last-5)**:

### Desktop Appliances (`~118 KB` Lumi Splash Launchers, Zero Duplication)

| Repository | What It Ships | Highlight |
| :--- | :--- | :--- |
| **[`awesome-os/sectium-browser`](https://github.com/awesome-os/sectium-browser)** | Sovereign Chromium 158+ / V8 15.8 browser + 8 Win32 Lumi GUI shells | `118 KB` self-hydrating launcher, `110 MB` RAM live, 5-OS `libsectium_display` |
| **[`awesome-os/code-oss`](https://github.com/awesome-os/code-oss)** | Telemetry-free MIT **Awesome-OS Code - OSS `1.147.0`** (Open VSX) | `118 KB` `code-oss.exe` + Lumi Splash, `-73.5%` vs VSCodium, `477 MB` RAM, bundled Wave 2 TS `6.0.3` + 5 Awesome-OS extensions |
| **[`awesome-os/theia`](https://github.com/awesome-os/theia)** | **Eclipse Theia** adapter over Sectium Browser / shared Electron CAS | Shares `~/.b8g/cas/extensions/` (`.vsix`), Wave 2 TS `6.0.3`, and all 5 Awesome-OS extensions with `code-oss` |
| **[`awesome-os/brave`](https://github.com/awesome-os/brave)** | Debloated Shields-only **Brave `v1.102.32`** (zero crypto/Rewards/updater) | `116 KB` `brave.exe` + Lumi Splash, `-18%` to `-20%` smaller, `zstd -9` |
| **[`awesome-os/blender`](https://github.com/awesome-os/blender)** | Debloated rolling-latest **Blender `5.3.0`** (zero installer) | `116.5 KB` `blender.exe` + Lumi Splash, `-17.2%` Win64 savings |
| **[`awesome-os/obs`](https://github.com/awesome-os/obs)** | Debloated rolling-latest portable **OBS Studio `33.0.3`** (zero installer) | `~118 KB` 4-OS Lumi Hydration Splash launcher, Keep-Last-5 `cas-v1` |
| **[`awesome-os/godot`](https://github.com/awesome-os/godot)** | Rolling-latest MIT **Godot `4.7.2`** (5-target launcher + `cas-v1`) | `116.5 KB` `godot.exe`, `36.9 KB` Linux x64, `43.0 KB` Linux ARM64, `50.6 KB` macOS ARM64, `27.2 KB` `wasm32-wasi` |
| **[`awesome-os/pinokio`](https://github.com/awesome-os/pinokio)** | **Pinokio Virtual PC** recipe runner on `b8g-ghost` CAS + Sectium Display | Runs original Pinokio recipes on shared debloated Python LLM stack (zero 10 GB conda/Electron bloat) |
| **[`awesome-os/sectium-electron`](https://github.com/awesome-os/sectium-electron)** · **[`electron`](https://github.com/awesome-os/electron)** | Drop-in Electron API over Sectium Display + rolling **Electron `v47` Nightly** | 1 shared copy per machine in `~/.b8g/cas/`, hybrid `--sectium` / `--upstream` |

### Unified IDE Extensions (Code - OSS & Eclipse Theia)

| Repository | Target | What It Bundles |
| :--- | :--- | :--- |
| **[`awesome-os/stealifylang-vscode`](https://github.com/awesome-os/stealifylang-vscode)** | **StealifyLang & TypeScript `6.0.3`** | `stealify-lint` LSP (`B8G001`–`B8G016`), `.stealify-rules` hot-reload, governance project rules, and Wave 2 TypeScript `6.0.3` (`14.3×` faster Zero-AST CAS) |
| **[`awesome-os/unreal-vscode`](https://github.com/awesome-os/unreal-vscode)** | **Unreal Engine 5** | Zero-Visual-Studio UBT builds via `b8g-ghost` (`.NET 11` + `ghost-llvm` + `ghost-winsdk`) + `B8G_ARENA_V1` `libunreal` viewport bridge |
| **[`awesome-os/godot-vscode`](https://github.com/awesome-os/godot-vscode)** | **Godot `4.7.2`** | Instant `cas-v1` Godot + `.NET 11` hydration, GDScript/C# tasks, and live scene runner |
| **[`awesome-os/blender-vscode`](https://github.com/awesome-os/blender-vscode)** | **Blender `5.3.0`** | Instant `cas-v1` Blender hydration, `bpy` script/addon live reload, and `libsectium_display` viewport bridge |
| **[`awesome-os/obs-vscode`](https://github.com/awesome-os/obs-vscode)** | **OBS Studio `33.0.3`** | Instant `cas-v1` portable OBS hydration, HTML5 browser-source overlay hot-reload, and scene control |

### Operating Systems, Containers, Runtimes & Graphics Shards

| Repository | What It Ships | Highlight |
| :--- | :--- | :--- |
| **[`awesome-os/b8g-ghost`](https://github.com/awesome-os/b8g-ghost)** | Canonical $O(1)$ Ghost CAS (`cas-v1`), `manifests/index.json`, Keep-Last-5 GC | `156+` verified entries, 4-OS zero-`node-gyp` `b8g-ghost-abi.node`, Dual-Tier Wasm/AOT JIT |
| **[`awesome-os/t2linux`](https://github.com/awesome-os/t2linux)** | Bootable hybrid UEFI/BIOS ISO & QEMU QCOW2 (`b8g-ghost` PID 1) | `x86_64` `21.5 MiB` ISO / `18.2 MiB` QCOW2, `aarch64` `26.6 MiB` ISO, `riscv64` `/init`, daily rolling updates |
| **[`awesome-os/t2xnu`](https://github.com/awesome-os/t2xnu)** | **T2macOS** — ARM64 Linux `7.0+` + `xnulinux` (`fki.ko`/`xnu.ko`) + `B8G_ARENA_V1` | Native zero-hypervisor Darwin/macOS personality, QEMU booted in `1.63s` |
| **[`awesome-os/t2desktop`](https://github.com/awesome-os/t2desktop)** | **T2Desktop** — Sovereign Omarchy (MIT Hyprland/Wayland) on T2Linux + `b8g-ghost` | Zero `pacman`/`yay` bloat, `Lumi Chromatic` prismatic theme, wallpaper & Limine bootscreen |
| **[`awesome-os/dockerimages`](https://github.com/awesome-os/dockerimages)** | Multi-arch (`linux/amd64` + `linux/arm64`) `FROM scratch` OCI images on `ghcr.io/awesome-os/*` | **5/5** images (`t2linux`, `ghost-node`, `ghost-py`, `ghost-cpp`, `ghost-jvm`), starting at `2.1 MB` |
| **[`awesome-os/typescript`](https://github.com/awesome-os/typescript)** | Programmable **TypeScript `6.0.3`** with Wave 1 + Wave 2 V8 optimizations | `129 ms` self-bundle, `14.3×` faster Zero-AST Semantic CAS lookup (`8.7 ms`) |
| **[`awesome-os/node`](https://github.com/awesome-os/node)** · **[`dotnet`](https://github.com/awesome-os/dotnet)** · **[`powershell`](https://github.com/awesome-os/powershell)** | 5-target zero-installer **Node `v27.0.0-alpha`**, **.NET `11.0.100`**, **PowerShell `v7.7.0`** | Native C11 `GetCommandLineW()` launchers (`35–51 KB`, zero telemetry, zero `cmd.exe` mangling) |
| **[`awesome-os/skia`](https://github.com/awesome-os/skia)** · **[`dawn`](https://github.com/awesome-os/dawn)** · **[`blink`](https://github.com/awesome-os/blink)** · **[`qt`](https://github.com/awesome-os/qt)** | Modular **Skia** (+ TTY ANSI/Kitty), **Dawn WebGPU**, **Blink**, and **Qt `6.10.3`** (`30.7 MiB`) | Zero-account, zero-duplication shared `cas-v1` graphics & UI shards |
| **[`awesome-os/upstream-mirrors`](https://github.com/awesome-os/upstream-mirrors)** | `26` append-only sparse upstream mirrors + `35/35` 5-OS C/Wasm shards | `libbrotli`, `libexpat`, `libsqlite3`, `libwebp`, `liblz4`, `adblock-rust`, `libelectron` C-ABI |
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
| **Atomic CLI Shims & Native `pwsh.exe`** | `bin/` (`.\bin\b8g-bin-parity.ps1 verify`) | Hermetic `(posix, .cmd, .ps1)` triplets + native C11 `bin/pwsh.exe` enforcing zero direct host binaries, zero `npx`, and zero WSL builds. |

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

Awesome-OS builds openly on **Chromium / Blink / Skia / Dawn** (BSD-3), **Electron** (MIT), **Code - OSS / VS Code** (MIT), **Eclipse Theia** (EPL-2.0), **Godot** (MIT), **Brave / `adblock-rust`** (MPL-2.0), **Blender** (GPL-3.0), **OBS Studio** (GPL-2.0), **Qt 6** (LGPL-3.0), **TypeScript** (Apache-2.0), **.NET & PowerShell** (MIT), **Node.js** (MIT), **Zig**, **LLVM**, **T2 SDE**, **Omarchy** (MIT), and **WASI / WebAssembly**.

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install globally via awesome-os/pnpm (all platforms)
pnpm add -g github:awesome-os/awesome-os

# Run directly (all platforms)
awesome-os --help
```
