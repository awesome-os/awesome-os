# `os/bootstrap` — Reusable 6-Stage Holo `v11` Distro Bootstrap Engine

`holo-distro-bootstrap` codifies the 6 canonical stages required to build, verify, cryptographically sign, pre-warm, and roll out **any** OS distribution or appliance built on the **Holo `v11` CAS + `B8G_ABI_MAGIC_V3` (`0x33564742`)** stack.

## Declarative Manifest (`holo.distro-bootstrap.v1`)

Downstream spins (workstation distros, kiosk appliances, robotics firmware, AI cluster blades) define a single declarative JSON manifest (see [`awesomeos-v1.0.manifest.json`](awesomeos-v1.0.manifest.json)) and invoke:

```powershell
# Full 6-stage live bump, build, planetary CAS warm, and 4-channel rollout
.\bin\holo-distro-bootstrap.ps1 --manifest github-mirror/awesome-os/awesome-os/os/bootstrap/awesomeos-v1.0.manifest.json --write-local-cas

# Hermetic CI / single-stage synthesis
node os/bootstrap/holo-distro-bootstrap.mts --offline --stage 2,3,6
```

## Canonical 6 Stages

| Stage | ID | Responsibility |
| :---: | :--- | :--- |
| **1** | `bump-upstreams` | Queries 56 live upstream C/C++/Rust/GPU repos + Chromium Canary, bumps `v11-package-universe.json` & `max-version-lock.json`, and updates `ECOSYSTEM-SCOREBOARD.md` + `oversight-telemetry.json`. |
| **2** | `stamp-boot-substrate` | Stamps uncompressed 24-bit `BI_RGB` UEFI GOP splash BMPs (`640x480`, `1024x768`, `1920x1080`) and zero-drift dual-slot `limine.conf` (`slot-a` / `slot-b`) + `boot.ipxe` across repos. |
| **3** | `assemble-v11-rootfs` | Generates pure Holo `v11` `/etc/os-release.<arch>` and `/etc/awesome-os/system.json` (`B8G_CAS_DIR=/var/lib/b8g/cas`, `0` legacy `cas-v1` / `b8g-ghost` remnants). |
| **4** | `build-and-gate-images` | Builds freestanding `holo-microkernel-riscv64.elf` (`14.17 KB`) and gates multi-arch `x86_64` + `aarch64` ISO/QCOW2 images on headless QEMU self-tests. |
| **5** | `warm-planetary-cas` | Streams active GitHub Releases through 12-way SHA-512 hashing, warms local `v11/files/<aa>/<sha512>`, signs `cas-v11-global-manifest.json` (`ed25519-sha512-v1`), and stages hot-path CDN shards. |
| **6** | `rollout-channels` | Publishes Ed25519-signed Web OOBE `v11-bundle.json`, unified HTTPS iPXE netboot, and Omaha `fleet/channels/stable.json` (`stage-standby-flip-atomic`), emitting an Ed25519-signed `last-bootstrap-receipt.json`. |
