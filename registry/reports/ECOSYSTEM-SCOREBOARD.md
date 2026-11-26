# AwesomeOS `v11` Ecosystem Scoreboard (`v1.0-v11`)

> Auto-updated by [`os/bootstrap/holo-distro-bootstrap.mts`](https://github.com/awesome-os/awesome-os/blob/main/os/bootstrap/holo-distro-bootstrap.mts) · Last sync: `2026-11-26T17:49:58.077Z`

## 1. 22-Runtime Big Boys `v11` CAS Coverage

- **Runtimes at 100% Coverage:** **15 / 22**
- **Standalone Disk Collapsed into 1 Shared `v11` CAS Layer:** **13.987 MB**
- **V8 Shared Baseline:** `16.0.88 (rolling latest via awesome-os/libv8_monolith)`

| Runtime | Covered | Coverage |
| :--- | ---: | ---: |
| **Chromium 160 Canary / Sectium Browser** | 26/27 | **96.3%** |
| **Firefox (Gecko / SpiderMonkey)** | 22/24 | **91.7%** |
| **Electron (awesome-os/electron)** | 20/20 | **100%** |
| **NW.js (holo-display-nwjs)** | 18/18 | **100%** |
| **Node.js** | 15/16 | **93.8%** |
| **Deno** | 10/10 | **100%** |
| **Bun** | 12/12 | **100%** |
| **Ladybird (awesome-os/ladybird)** | 23/23 | **100%** |
| **just-js/lo (lo/lib/*)** | 19/19 | **100%** |
| **Colibri MoE (awesome-os/colibri)** | 11/11 | **100%** |
| **llama.cpp (awesome-os/llama.cpp)** | 12/12 | **100%** |
| **vLLM (awesome-os/vllm)** | 16/16 | **100%** |
| **GNOME Wayland (GTK 4.24 / libadwaita 1.10)** | 16/16 | **100%** |
| **KDE Plasma 6.8 (KWin 6.8.3 / Qt 6.12.1)** | 17/17 | **100%** |
| **Omarchy / Hyprland 0.57 (wlroots 0.20)** | 15/15 | **100%** |
| **Rust / Cargo Native Crates (*-sys)** | 25/25 | **100%** |
| **.NET 11 SDK & Native Runtime** | 17/17 | **100%** |
| **microsoft/vcpkg Top 100 Native Binary Ports** | 89/100 | **89%** |
| **npm Top Native Binary Addons (sharp/sqlite/canvas/v8)** | 31/32 | **96.9%** |
| **PyPI / Python Top Binary Wheels (numpy/torch/pillow/arrow)** | 30/33 | **90.9%** |
| **GPU Compute & AI Accelerators (CUDA / NCCL / ROCm / Triton / XDNA)** | 21/21 | **100%** |
| **Linux Kernel & Bare-Metal Boot (torvalds/linux + Limine + musl)** | 14/15 | **93.3%** |

## 2. Ahead-of-Chrome Upstream Pins

| Library | Pinned Max Version | Upstream Repo |
| :--- | :--- | :--- |
| `harfbuzz` | **`15.2.0`** | `harfbuzz/harfbuzz` |
| `openssl` | **`4.1.0`** | `openssl/openssl` |
| `expat` | **`2.11.0`** | `libexpat/libexpat` |
| `zstd` | **`1.6.0`** | `facebook/zstd` |
| `mimalloc` | **`3.7.1`** | `microsoft/mimalloc` |
| `zlib-ng` | **`2.3.3`** | `zlib-ng/zlib-ng` |
| `ada` | **`4.1.1`** | `ada-url/ada` |

## 3. Independent Engine & Upstream Package Radar

- **Ladybird Hard-Fork (`awesome-os/ladybird`):** **`18/18` Chrome Parity Probes Implemented** · `42` libraries · `775` WebIDL interfaces · `67.35%` dep overlap (`17` libs raised from `v11`).
- **Full Reports:** [`BIG-BOYS-OVERLAP-REPORT.md`](BIG-BOYS-OVERLAP-REPORT.md) · [`LADYBIRD-CHROME-PARITY.md`](LADYBIRD-CHROME-PARITY.md) · [`T2SDE-MODERNIZATION-WISHLIST.md`](T2SDE-MODERNIZATION-WISHLIST.md) · [`max-version-lock.json`](max-version-lock.json) · [`ahead-of-chrome-pins.json`](ahead-of-chrome-pins.json).
