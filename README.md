# AwesomeOS (`awesome-os/awesome-os`)

> **The Sovereign, ChromeOS-Grade Operating System Monorepo** — collapsing **`5,070` OS packages** and **`22` major runtime/desktop/AI ecosystems (`13,987 MB` standalone)** into **ONE SHA-512 + Ed25519 verified `v11` Content-Addressable Store**, powered by **Holo-Linux `7.3.6`**, **A/B Atomic Rollback**, **1-Click Powerwash**, and **Sectium + Ladybird** dual sovereign browser engines.

[![Install AwesomeOS OOBE](https://img.shields.io/badge/Install-Web_OOBE_Installer-39C5CF?style=for-the-badge)](https://awesome-os.com/install/)
[![Boot Live Shell](https://img.shields.io/badge/Boot_Live-AwesomeOS_Shell-58A6FF?style=for-the-badge)](https://awesome-os.com/shell/)
[![Pure CAS v11 Release](https://img.shields.io/badge/Release-CAS_v11_(Ed25519)-3FB950?style=for-the-badge)](https://github.com/awesome-os/awesome-os/releases/tag/cas-v11-latest)
[![Host Manager MDM](https://img.shields.io/badge/Fleet-Host_Manager-BC8CFF?style=for-the-badge)](https://b8g.dev/awesome-os/apps/host-manager.html)
[![Live Oversight](https://img.shields.io/badge/Telemetry-26_Runners_Live-D29922?style=for-the-badge)](https://b8g.dev/awesome-os/apps/oversight.html)
[![Sovereign Agent Platform](https://img.shields.io/badge/Agent_Platform-Model_Research_%26_Studio-F778BA?style=for-the-badge)](https://github.com/awesome-os/agent-platform)
[![Agent Platform Hub](https://img.shields.io/badge/Live-Agent_Platform_App-2EA043?style=for-the-badge)](https://b8g.dev/awesome-os/apps/agent-platform.html)

---

## At-a-Glance Production Numbers

| Metric | Verified Measurement | How It Works |
| :--- | ---: | :--- |
| **Deduplicated `v11` Package Universe** | **`5,070` packages** | `0` duplicate vendor `.tar.*` tarballs — every package resolves through `cas://v11/` & `repository://` hardlinks |
| **22 "Big Boys" Ecosystems Collapsed** | **`13,987 MB` → `1` CAS layer** | **15 / 22 at `100%` shared-lib coverage** (`dup_v8 = 0 B` across Chromium, Electron, Node, Deno, Bun, `lo`) |
| **Physical SHA-512 Blobs Indexed** | **`409` assets (`399` unique blobs · `1.22 GB`)** | Ed25519-signed across `61` active repos in [`awesome-os/holo-v11`](https://github.com/awesome-os/holo-v11) (unified Holo `v11` CAS, verified via [`holo-ci@v1`](https://github.com/awesome-os/maintenance-workflows)) + `8,311` local hardlinks |
| **Live Upstream Libraries Tracked** | **`56` core C/C++/GPU libs** | Auto-tracked at ahead-of-Chrome max (`openssl 4.1.0`, `harfbuzz 15.2.0`, `zstd 1.6.0`, `mimalloc 3.7.1`, `vulkan 1.4.369`, `ROCm 7.14.0`) |
| **Dual Ring-0 Kernel Backends** | **`Holo-Linux 7.3.6` + `14.17 KB` Zig** | Full hardware Linux `7.3.6` (`b8g_abi.ko` + `scx_holo` BPF) **+** `14,512 B` freestanding RISC-V 64 Zig microkernel |
| **Dual Sovereign Browser Engines** | **`Sectium` + `Ladybird (18/18)`** | **Sectium** (Chromium `160` Canary BSD-3, `0` closed DLLs) **+** **Ladybird** (`18/18` Chrome parity probes, `HoloHotLoopJIT`, `Wasm SIMD128`, `uBlock MV3`) |
| **Legacy X11 / Xorg Bloat Shipped** | **`0` bytes (`-549` pkgs)** | Pure UEFI GOP 24-bit BMP splash → `SimpleDRM` → Wayland / WebGPU (with rootless `Xwayland` on demand) |

---

## Live Rolling Upstream Telemetry & Planetary Warm `v11` CAS

> **Continuous Maintenance Proof — Live Dashboard:** [**`https://b8g.dev/awesome-os/apps/oversight.html`**](https://b8g.dev/awesome-os/apps/oversight.html)  
> Automated GitHub Actions runners continuously poll **`56` upstream C/C++/Rust/GPU repositories**, Chromium Canary (`160.0.8184.0`), and **`26` core AwesomeOS CI pipelines**, bumping `max-version-lock.json` and pre-warming the planetary SHA-512 `v11` CAS index with **zero stale tarballs**.

| Upstream Subsystem | Live `v11` Pin | Upstream Source | Advantage Over Stock Distros / Browsers |
| :--- | :--- | :--- | :--- |
| **Linux Kernel + Boot** | **`7.3.6`** / **`12.11.1`** | `torvalds/linux` · `limine-bootloader/limine` | `io_uring`, `sched_ext` (`scx_holo`), `AF_VSOCK`, `BTF`, zero-flicker 24-bit GOP splash |
| **Chromium Canary & V8** | **`160.0.8184.0`** / **`16.0.88+`** | `chromiumdash` · `v8/v8` | Shared dynamic `libv8` (`dup_v8 = 0 B` across browser, IDE, and JS runtimes) |
| **TLS & Crypto** | **`OpenSSL 4.1.0`** / **`MbedTLS 4.3.0`** | `openssl/openssl` · `Mbed-TLS/mbedtls` | Ahead-of-distro TLS 1.3 + post-quantum & Ed25519 Verified Boot |
| **Text, URL & Compression** | **`HarfBuzz 15.2.0`** · **`Ada 4.1.1`** · **`Zstd 1.6.0`** · **`zlib-ng 2.3.3`** | `harfbuzz` · `ada-url` · `facebook/zstd` · `zlib-ng` | Ahead-of-Chrome text shaping, WHATWG URL SIMD parser, and fast CAS decompression |
| **Memory & Async I/O** | **`mimalloc 3.7.1`** · **`libuv 1.53.0`** · **`liburing 2.15`** | `microsoft/mimalloc` · `libuv` · `axboe/liburing` | Unified allocator & ring I/O across `holo-compiler`, Node, Bun, and `lo` |
| **GPU & AI Compute** | **`Vulkan 1.4.369`** · **`ROCm 7.14.0`** · **`SPIRV 2026.4`** · **`XDNA 2.21.75`** · **`oneDNN 3.15`** | `KhronosGroup` · `ROCm` · `amd/xdna-driver` · `uxlfoundation` | Zero-bloat shared GPU/NPU compute runtime for `Colibri`, `llama.cpp`, `vLLM`, and `Sectium` |

### Warm Any Machine From the Planetary `v11` CAS in One Command
```bash
# Stream-verify & warm ~/.b8g/cas/v11/files/00..ff/<sha512> directly from the global v11 index:
curl -fsSL https://awesome-os.com/cas/v11/manifest.json | head -n 25
```

---

## Why AwesomeOS? (The ChromeOS Architecture, Unshackled)

ChromeOS proved the cleanest operating-system design of the modern era — **Verified Boot + Immutable Read-Only Root + Browser-as-Shell + Sandboxed Crostini Linux + 1-Click Powerwash + Fleet MDM** — yet locked it to proprietary hardware and closed cloud services.

**AwesomeOS** delivers that architecture openly on **any x86_64, ARM64, or RISC-V machine, VM, Proxmox blade, or browser** using **4 clean pillars**:

1. **`AwesomeOS` (OS, Kernel, Boot & Fleet):**
   - **Verified Boot & Zero-Flicker Splash ([`os/bootloader/`](os/bootloader/)):** Limine `v11/v12`, `systemd-boot`, and stateless HTTPS `iPXE` with dual A/B slots (`Slot A` / `Slot B` $O(1)$ rollback), Ed25519 + SHA-512 root verification ([`security/verified-boot.mts`](security/verified-boot.mts)), and a freestanding C11 UEFI GOP / `SimpleDRM` framebuffer splash blitter.
   - **Holo-Linux `7.3.6` ([`os/kernel/`](os/kernel/)):** Lean `LLVM=1` kernel with `/dev/b8g-arena` (`b8g_abi.ko` 64-byte `B8G_ABI_MAGIC_V3 = 0x33564742` zero-copy rings), `scx_holo` `sched_ext` BPF scheduler (`1 ms` display frame priority), `AF_VSOCK` zero-TCP host↔VM channels ([`vsock-crostini.mts`](sections/sectium-device/vsock-crostini.mts)), and lazy `NBD`/`ublk` `v11` CAS block disks ([`cas-v11-block-and-sysroot.mts`](os/crostini/cas-v11-block-and-sysroot.mts)).
   - **Freestanding Zig Microkernel ([`os/holo-microkernel-zig/`](os/holo-microkernel-zig/kernel.zig)):** `14.17 KB` (`14,512 B`) OpenSBI S-Mode RISC-V 64 time-sharing microkernel with 64-byte `B8gTaskArena` syscalls for instant MicroVMs and browser emulation.
   - **Enterprise Host Manager ([`fleet/`](fleet/)):** 4-column Light/Dark admin console, Zero-Touch Enrollment, Hardware-Fit MoE calculator, `workspaces://` protocol, 1-Click Powerwash, and an 11-tool stdio MCP server.
2. **`Sectium` + `Ladybird` (Browser-IS-The-Shell):**
   - **Sectium ([`awesome-os/sectium-browser`](https://github.com/awesome-os/sectium-browser)):** Sovereign BSD-3 Chromium `160` Canary compositor (`~110 MB` RAM, `< 5 ms` local AtlasKV omnibox, built-in **Sectium IDE** MV3 DevTools panel).
   - **Chromium Baseline ([`awesome-os/chromium-baseline`](https://github.com/awesome-os/chromium-baseline)):** Shared dynamic V8 monolith (`components/libv8_monolith`), `just-js`/`lo` (`components/just-js/{lo,just-js}`), and `components/angrybird` substrates (`dup_v8 = 0 B`).
   - **Ladybird ([`browser/ladybird/`](browser/ladybird/) & [`awesome-os/ladybird`](https://github.com/awesome-os/ladybird)):** Clean-room BSD-2 engine upgraded to **`18 / 18` Chrome parity probes**, `LibJS` `HoloHotLoopJIT`, `LibWasm` `SIMD128`, RFC 9460 DNS `HTTPS` (`TYPE 65`), and native `uBlock` MV3 content blocking.
   - **Firefox ([`browser/firefox/README.md`](browser/firefox/README.md)):** Zero-telemetry Gecko / Stylo / WebRender / Fission / RLBox `mozconfig.holo-v11`, `24/24` shared `v11` CAS profile, and native C11 `B8G_ABI_MAGIC_V3` launcher.
3. **`Holo` (`v11` CAS, Compiler & Zero-Copy FFI):**
   - **`holo-compiler` & `holo-pm` ([`compiler/`](compiler/)):** Sub-second (`< 1 s`, zero WSL) C11/C++23/Zig/WASI/TypeScript compiler and 0-byte hardlink package projector (`holo-ffi`) backed by [`registry/`](registry/).
4. **`Sovereign AI` ([`awesome-os/agent-platform`](https://github.com/awesome-os/agent-platform)):**
   - **Unified Agent Platform & Model Research ([`agent-platform.html`](https://b8g.dev/awesome-os/apps/agent-platform.html) · [`llm-studio.html`](https://b8g.dev/awesome-os/apps/llm-studio.html) · [`agent-host.html`](https://b8g.dev/awesome-os/apps/agent-host.html)):** Canonical home for **LLM & LoRA Studio**, the **Model Garden** (**Inkling 2 Mini**, **B8G Xenon 1B**, **LittleBit**, **Micro-MoE**, **SpinWave**), **ZER0Q Substrate**, **AtlasKV**, **Brain RAG**, **Model Armor**, and **MCP / A2A / A2UI / x402** agentic protocols, bridged natively into OS runtimes via [`ai/`](ai/).

---

## The 22 Deduplicated "Big Boys" Matrix (`13,987 MB` → `1` Shared `v11` Layer)

Instead of every browser, AI server, desktop shell, and language toolchain shipping duplicate copies of `libv8`, `icu`, `skia`, `openssl`, `harfbuzz`, `zlib-ng`, `zstd`, `sqlite3`, `ffmpeg`, and `vulkan`, **AwesomeOS deduplicates all 22 ecosystems into `~/.b8g/cas/v11/files/<aa>/<sha512>`**:

| Ecosystem Group | Covered Stacks (`15 / 22` at `100%`) | `v11` Shared-Lib Coverage |
| :--- | :--- | ---: |
| **Browsers & Web Shells (`5`)** | Electron (`20/20` **100%**), NW.js (`18/18` **100%**), Ladybird (`23/23` **100%**), Sectium / Chromium `160` (`26/27` **96.3%**), Firefox (`22/24` **91.7%**) | **91.7% – 100%** |
| **JS / Systems Runtimes (`4`)** | Deno (`10/10` **100%**), Bun (`12/12` **100%**), `just-js/lo` (`19/19` **100%**), Node.js (`15/16` **93.8%**) — all sharing `libv8 16.0.88+` (`dup_v8 = 0 B`) | **93.8% – 100%** |
| **Sovereign AI & GPU Compute (`4`)** | `Colibri` MoE (`11/11` **100%**), `llama.cpp` (`12/12` **100%**), `vLLM` (`16/16` **100%**), GPU Compute — CUDA / NCCL / ROCm `7.14` / Triton / XDNA (`21/21` **100%**) | **100%** |
| **Wayland Desktops — Zero X11 (`3`)** | GNOME Wayland GTK `4.24` (`16/16` **100%**), KDE Plasma `6.8` / Qt `6.12` (`17/17` **100%**), Omarchy / Hyprland `0.57` (`15/15` **100%**) | **100%** |
| **Language & Binary Registries (`6`)** | Rust `*-sys` crates (`25/25` **100%**), `.NET 11` (`17/17` **100%**), `npm` Top Native (`31/32` **96.9%**), Linux `7.3.6` + Limine (`14/15` **93.3%**), `PyPI` Wheels (`30/33` **90.9%**), `vcpkg` Top 100 (`89/100` **89%**) | **89% – 100%** |

---

## Monorepo Directory Map (`270+` Tracked Source Files)

```text
awesome-os/
├── os/
│   ├── bootstrap/             # Reusable 6-Stage Holo v11 Distro Bootstrap Engine & .\bin\holo-upgrade CLI (os/bootstrap/holo-upgrade.mts)
│   ├── bootloader/            # Limine v11/v12, systemd-boot, iPXE + C11 UEFI GOP 24-bit BMP splash blitter
│   ├── kernel/                # Holo-Linux 7.3.6 kconfig, b8g_abi.ko (/dev/b8g-arena), scx_holo BPF, AGENTS.md
│   ├── holo-microkernel-zig/  # 14.17 KB freestanding RISC-V 64 OpenSBI time-sharing microkernel in Zig
│   ├── crostini/              # Lazy NBD/ublk v11 CAS virtual block disk + rootless unshare container hydrator
│   ├── rootfs/                # Synthesized pure Holo v11 /etc/os-release.* & /etc/awesome-os/system.json
│   └── shell/                 # ChromeOS-style AwesomeOS Desktop Shell (Shelf, Omnibox, Crostini, Powerwash)
├── browser/
│   ├── firefox/               # Zero-telemetry Gecko/RLBox mozconfig.holo-v11, 24/24 v11 profile & C11 launcher
│   └── ladybird/              # Ladybird 18/18 Chrome parity C11/C++23 bridges & live upstream issue radar
├── runtime/                   # 4-Layer C11/WASI/Kotlin substrates (sectium-cp 5.7KB, b8g-runtime, sectium-es, sectium-jvm)
├── compiler/                  # holo-compiler (Tier-A <1s), holo-pm, and holo-ffi (0-byte hardlink projector)
├── registry/                  # holo-v11 fixed-point verifier, CAS deduplicator, and Oversight dashboard
├── security/                  # Ed25519 + SHA-512 Verified Boot manifest signer & Omaha-style update verifier
├── fleet/                     # Host Manager (A/B slots, Powerwash, Hardware-Fit MoE, 11-tool stdio MCP)
├── installer/                 # Declarative .mts stamper + Browser OPFS / showDirectoryPicker OOBE
├── deployment/                # Multi-domain production deployer + C++20 Virtual Domain Manager
├── ai/                        # Sovereign AI Triad bridges (Colibri LumiBERT 2.8ms, llama.cpp, vLLM) → unified in awesome-os/agent-platform
├── sections/                  # Device boundary, AF_VSOCK zero-TCP Crostini transport & Universal Compiler Debug
└── docs/                      # Mintlify documentation, security invariants, and LLM stack guides
```

> **Sovereign AI Companion Repo — [`awesome-os/agent-platform`](https://github.com/awesome-os/agent-platform):** Unified home for **LLM & LoRA Studio**, the **Model Garden** (`Inkling 2 Mini`, `B8G Xenon 1B`, `LittleBit`, `Micro-MoE`, `SpinWave`), **ZER0Q Substrate**, **AtlasKV**, **Brain RAG**, **Model Armor**, and **MCP / A2A / A2UI / x402** ([Live App](https://b8g.dev/awesome-os/apps/agent-platform.html)).
>
> **Chromium & V8 Substrate Repo — [`awesome-os/chromium-baseline`](https://github.com/awesome-os/chromium-baseline):** Unified shared dynamic `libv8` (`components/libv8_monolith`), `just-js`/`lo` (`components/just-js/{lo,just-js}`), and `components/angrybird` substrates (`dup_v8 = 0 B`).
>
> **Unified DevTools Monorepo — [`awesome-os/devtools`](https://github.com/awesome-os/devtools):** Consolidates IDEs (`code-oss`, `theia`, `b8g-ide`), VS Code / Open VSX extensions, Game Engines, native C11 dynamic launchers, and 4DGS / Holonomic Game Engine research over **Holo v11 CAS**.
>
> **Zero-Dependency CI & Verification — [`holo-ci@v1`](https://github.com/awesome-os/maintenance-workflows):** Centralized Node 24/26 erasable-TS verification, guard enforcement, and `holo-ci.receipt.v1` telemetry via [`reusable-holo-ci.yml@v1`](https://github.com/awesome-os/maintenance-workflows/blob/v1/.github/workflows/reusable-holo-ci.yml).

---

## Install, Boot, or Verify in 10 Seconds

### 1. Zero-Download Browser OOBE or Live Shell
- **Install to Any Local Folder or OPFS:** [https://awesome-os.com/install/](https://awesome-os.com/install/) *(drops `LAUNCH-AWESOMEOS.html` — boots on any clean laptop with zero Node.js required)*
- **Boot Live AwesomeOS Desktop Shell:** [https://awesome-os.com/shell/](https://awesome-os.com/shell/)

### 2. One-Line CLI Bootstrap & One-Command Upgrade
```powershell
# Windows 11 PowerShell
irm https://awesome-os.com/install.ps1 | iex

# One-command Ecosystem Upgrader (os/bootstrap/holo-upgrade.mts)
.\bin\holo-upgrade --offline --json
```
```sh
# Linux (x64 / ARM64 / RISC-V) & macOS (Apple Silicon)
curl -fsSL https://awesome-os.com/install.sh | sh
```
See [`os/bootstrap/holo-upgrade.mts`](os/bootstrap/holo-upgrade.mts) for all 4 canonical upgrade phases (`bump-pins`, `align-monorepos`, `telemetry-and-dedup`, `rollout`).

### 3. Run All 11 Hermetic Monorepo Test Suites (`< 400 ms`)
```bash
node --test \
  os/bootstrap/holo-upgrade.test.mts \
  os/bootstrap/holo-distro-bootstrap.test.mts \
  security/verified-boot.test.mts \
  os/kernel/holo-kbuild.test.mts \
  os/bootloader/bootloader.test.mts \
  os/crostini/cas-v11-block-and-sysroot.test.mts \
  compiler/holo-ffi/holo-ffi.test.mts \
  sections/sectium-device/universal-compiler-debug.test.mts \
  sections/sectium-device/vsock-crostini.test.mts \
  installer/test/installer.test.mts \
  deployment/virtual-domain-manager.test.mts

zig test os/holo-microkernel-zig/kernel.zig
```

## License

MIT / BSD-3-Clause (Holo-Linux kernel personality modules dual `BSD-3-Clause OR GPL-2.0`; Ladybird bridges `BSD-2-Clause`).
