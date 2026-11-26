# AwesomeOS (`awesome-os/awesome-os`)

> **The Sovereign, ChromeOS-Grade Operating System Monorepo** — pairing **Holo-Linux `7.3.6`**, **Ed25519 Verified Boot**, **A/B Atomic Rollback**, **1-Click Powerwash**, and **Sectium** (the BSD-3 browser that *is* the desktop shell), powered under the hood by **`Holo` (`v11` SHA-512 CAS)**.

[![Live Web Installer](https://img.shields.io/badge/Install-AwesomeOS_OOBE-39C5CF?style=for-the-badge)](https://awesome-os.com/install/)
[![Live Desktop Shell](https://img.shields.io/badge/Try_Live-AwesomeOS_Shell-58A6FF?style=for-the-badge)](https://awesome-os.com/shell/)
[![Host Manager](https://img.shields.io/badge/Fleet-Host_Manager-3FB950?style=for-the-badge)](https://b8g.dev/awesome-os/apps/host-manager.html)
[![Live Oversight](https://img.shields.io/badge/Telemetry-Oversight-D29922?style=for-the-badge)](https://b8g.dev/awesome-os/apps/oversight.html)

---

## Why AwesomeOS? (The ChromeOS Architecture, Unshackled)

ChromeOS proved the cleanest OS design of the last 20 years: **Verified Boot + Immutable A/B Root + Browser-as-Shell + Sandboxed Linux Containers + 1-Click Powerwash + Fleet MDM** — but locked it to proprietary hardware and closed cloud services.

**AwesomeOS** brings that exact architecture to **every x86_64 & ARM64 PC, VM, Proxmox blade, and browser** using **3 clean building blocks** (zero brand soup, zero X11, zero closed Google/Microsoft DLLs):

| Pillar | ChromeOS Equivalent | AwesomeOS Implementation in This Monorepo |
| :--- | :--- | :--- |
| **`AwesomeOS`** | ChromeOS / Verified Boot / Crostini / Admin Console | [`os/bootloader/`](os/bootloader/) (UEFI GOP zero-flicker splash + Limine/systemd-boot/iPXE A/B slots), [`os/kernel/`](os/kernel/) (**Holo-Linux `7.3.6`** + `/dev/b8g-arena` + `scx_holo` `sched_ext`), [`security/`](security/) (**Ed25519 + SHA-512 Verified Boot**), [`os/shell/`](os/shell/) (Desktop Shell + 1-Click Powerwash), and [`fleet/`](fleet/) (**Host Manager** + MCP). |
| **`Sectium`** | Chromium / Ash Compositor | Sovereign BSD-3 browser & WebGPU display appliance (`0` closed telemetry/DRM DLLs, `< 5 ms` local AtlasKV omnibox, built-in **Sectium IDE** DevTools panel). |
| **`Holo`** | Portage + Omaha + `dm-verity` | Sub-second native C11/WASI/TS compiler (`holo-compiler`) + Git-auditable SHA-512 `v11` Content-Addressable Store (`427` physical verified blobs across `69` repos, zero-byte hardlink projection via [`compiler/holo-ffi/`](compiler/holo-ffi/)). |

---

## Monorepo Directory Map

```text
awesome-os/
├── os/
│   ├── bootloader/       # Limine v11/v12, systemd-boot, iPXE + C11 UEFI GOP 24-bit BMP splash blitter
│   ├── kernel/           # Holo-Linux 7.3.6 kconfig, b8g_abi.ko (/dev/b8g-arena), scx_holo BPF, AGENTS.md
│   └── shell/            # ChromeOS-style AwesomeOS Desktop Shell (Shelf, Omnibox, Crostini, Powerwash)
├── runtime/              # 4-Layer C11/WASI/Kotlin substrates (sectium-cp, b8g-runtime, sectium-es, sectium-jvm)
├── compiler/             # holo-compiler (Tier-A <1s), holo-pm, and holo-ffi (0-byte hardlink projector)
├── registry/             # holo-v11 fixed-point verifier, CAS deduplicator, and Oversight dashboard
├── security/             # Ed25519 + SHA-512 root manifest signer & Omaha-style update verifier
├── fleet/                # Host Manager (A/B slots, Powerwash, Hardware-Fit MoE, 11-tool stdio MCP)
├── installer/            # Declarative .mts stamper + Browser OPFS / showDirectoryPicker OOBE
├── deployment/           # Production multi-domain deployer + C++20 Virtual Domain Manager
├── ai/                   # Sovereign AI Triad bridges (Colibri LumiBERT 2.8ms, llama.cpp, vLLM)
├── sections/             # Core zero-copy runtime & device boundary units (sectium-device, web-components)
├── intersections/        # Multi-section control-plane & agent host compositions
├── packages/             # Shared @awesome-os/* TypeScript & StealifyLang libraries
└── docs/                 # Mintlify documentation, security invariants, and LLM stack guides
```

---

## Quick Verification (Zero Build Step, Node 22+ & C11)

```bash
# 1. Verify Ed25519 + SHA-512 Verified Boot, Kernel ABI, Bootloader Splash & Holo-FFI
node --test security/verified-boot.test.mts os/kernel/holo-kbuild.test.mts os/bootloader/bootloader.test.mts compiler/holo-ffi/holo-ffi.test.mts

# 2. Compile & run native C11 Kernel UAPI & UEFI GOP Splash self-tests (-Wall -Wextra -Werror)
node os/bootloader/assets/generate-splash.mts
cc -std=c11 -Wall -Wextra -Werror os/kernel/b8g_abi/b8g_abi_selftest.c -o /tmp/b8g_abi_selftest && /tmp/b8g_abi_selftest
cc -std=c11 -Wall -Wextra -Werror os/bootloader/uefi-gop-splash/holo_splash.c os/bootloader/uefi-gop-splash/holo_splash_test.c -o /tmp/holo_splash_test && /tmp/holo_splash_test
```

## Install or Try Live in 10 Seconds

- **Browser Direct-Drop OOBE Installer:** [https://awesome-os.com/install/](https://awesome-os.com/install/)
- **Live AwesomeOS ChromeOS-Style Shell:** [https://awesome-os.com/shell/](https://awesome-os.com/shell/)
- **Windows 11 PowerShell:** `irm https://awesome-os.com/install.ps1 | iex`
- **Linux / macOS:** `curl -fsSL https://awesome-os.com/install.sh | sh`

## License

MIT / BSD-3-Clause (Kernel personality modules dual `BSD-3-Clause OR GPL-2.0`).
