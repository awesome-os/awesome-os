/**
 * @file os/bootstrap/distro-spec.mts
 * @description Canonical, generic, reusable 6-Stage Holo v11 Distro Bootstrap Specification
 * & zero-drift artifact synthesizers (`erasableSyntaxOnly: true`, Node 22+ built-ins only).
 *
 * Any OS distribution or appliance built on the Holo v11 + B8G_ABI_MAGIC_V3 stack
 * declares a `DistroBootstrapManifest` (`schema: "holo.distro-bootstrap.v1"`) and
 * runs through the same 6 deterministic stages:
 *   1. bump-upstreams        — Track live upstream libs & lock max-version-lock.json
 *   2. stamp-boot-substrate  — Kernel + 24-bit BI_RGB GOP splash + dual-slot Limine/iPXE
 *   3. assemble-v11-rootfs   — Pure Holo v11 /etc/os-release, system.json & A/B slot layout
 *   4. build-and-gate-images — Multi-arch ISO/QCOW2/Microkernel build & headless QEMU gates
 *   5. warm-planetary-cas    — 12-way SHA-512 stream index + Ed25519 manifest + CDN shards
 *   6. rollout-channels      — Web OOBE, HTTPS iPXE Netboot, Omaha A/B Fleet & Edge deploy
 */

import { signManifestEd25519, type SignedManifest } from '../../security/verified-boot.mts';

export type DistroArch = 'x86_64' | 'aarch64' | 'riscv64' | 'wasm32-wasi';

export type BootstrapStageId =
  | 'bump-upstreams'
  | 'stamp-boot-substrate'
  | 'assemble-v11-rootfs'
  | 'build-and-gate-images'
  | 'warm-planetary-cas'
  | 'rollout-channels';

export interface StageDefinition {
  readonly number: 1 | 2 | 3 | 4 | 5 | 6;
  readonly id: BootstrapStageId;
  readonly title: string;
  readonly summary: string;
  readonly outputs: readonly string[];
}

export interface DistroBootloaderSpec {
  readonly engine: 'limine' | 'systemd-boot';
  readonly version: string;
  readonly dualSlot: boolean;
  readonly splashResolutions: readonly ('640x480' | '1024x768' | '1920x1080')[];
  readonly defaultSplash: '640x480' | '1024x768' | '1920x1080';
}

export interface DistroChannelsSpec {
  readonly webOobeUrl: string;
  readonly netbootIpxeUrl: string;
  readonly netbootPrimaryBaseUrl: string;
  readonly netbootFallbackBaseUrl: string;
  readonly casGlobalManifestUrl: string;
  readonly casCdnFilesBaseUrl: string;
  readonly omahaStableChannelUrl: string;
}

export interface DistroBootstrapManifest {
  readonly schema: 'holo.distro-bootstrap.v1';
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly codename: string;
  readonly abiMagic: '0x33564742';
  readonly casLayout: 'v11';
  readonly casMountLabel: string;
  readonly casMountPath: string;
  readonly kernelRelease: string;
  readonly browserEngines: readonly string[];
  readonly desktopAdapters: readonly string[];
  readonly architectures: readonly DistroArch[];
  readonly bootloader: DistroBootloaderSpec;
  readonly githubOrg: string;
  readonly canonicalRepo: string;
  readonly desktopImageRepo: string;
  readonly kernelRepo: string;
  readonly channels: DistroChannelsSpec;
}

export interface OmahaArtifactEntry {
  readonly arch: DistroArch;
  readonly format: 'iso' | 'qcow2' | 'kernel' | 'initramfs' | 'elf' | 'wasm' | 'html';
  readonly filename: string;
  readonly downloadUrl: string;
  readonly sha512?: string;
  readonly bytes?: number;
}

export interface OmahaChannelPayload {
  readonly schema: 'awesome-os.omaha-channel.v1';
  readonly channel: 'stable' | 'beta' | 'canary';
  readonly distroId: string;
  readonly distroName: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly abiMagic: '0x33564742';
  readonly casLayout: 'v11';
  readonly kernelRelease: string;
  readonly targetSlotPolicy: 'stage-standby-flip-atomic';
  readonly casManifestUrl: string;
  readonly publishedAt: string;
  readonly artifacts: readonly OmahaArtifactEntry[];
}

export const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  {
    number: 1,
    id: 'bump-upstreams',
    title: 'Automated Upstream Max-Bump & Catalog Lock',
    summary:
      'Queries 56 live upstream C/C++/Rust/GPU repositories + Chromium Canary, bumps v11-package-universe.json & max-version-lock.json, and regenerates ECOSYSTEM-SCOREBOARD.md + oversight-telemetry.json.',
    outputs: [
      'catalog/live-upstream-tracker.json',
      'catalog/v11-package-universe.json',
      'catalog/max-version-lock.json',
      'reports/ECOSYSTEM-SCOREBOARD.md',
      'reports/oversight-telemetry.json',
    ],
  },
  {
    number: 2,
    id: 'stamp-boot-substrate',
    title: 'Kernel, Zero-Flicker GOP Splash & Dual-Slot Bootloader Stamp',
    summary:
      'Generates uncompressed 24-bit BI_RGB splash BMPs (640x480, 1024x768, 1920x1080) and stamps unified dual-slot Limine (slot-a / slot-b) and HTTPS iPXE netboot configs.',
    outputs: [
      'os/bootloader/assets/splash/awesome-os-1920x1080.bmp',
      'os/bootloader/limine/limine.conf',
      'os/bootloader/ipxe/boot.ipxe',
    ],
  },
  {
    number: 3,
    id: 'assemble-v11-rootfs',
    title: 'Pure Holo v11 Rootfs, /etc/os-release & System Definition Synthesis',
    summary:
      'Synthesizes /etc/os-release, /etc/awesome-os/system.json, and B8G_CAS_DIR (/var/lib/b8g/cas) rootfs templates with zero legacy cas-v1 or b8g-ghost references.',
    outputs: [
      'os/rootfs/etc/os-release',
      'os/rootfs/etc/awesome-os/system.json',
    ],
  },
  {
    number: 4,
    id: 'build-and-gate-images',
    title: 'Multi-Arch Image Build & Headless QEMU Verification Gates',
    summary:
      'Compiles native C11/C++20/Zig boot substrates (holo-microkernel-riscv64.elf, b8g_abi_selftest, holo_splash) and gates x86_64 + aarch64 ISO/QCOW2 builds on live QEMU PID 1 selftests.',
    outputs: [
      'os/holo-microkernel-zig/zig-out/bin/holo-microkernel-riscv64.elf',
      '.github/workflows/bootstrap-distro.yml',
    ],
  },
  {
    number: 5,
    id: 'warm-planetary-cas',
    title: 'Planetary v11 CAS Pre-Warm, Ed25519 Signing & CDN Shard Sync',
    summary:
      'Streams active GitHub Releases through 12-way SHA-512 hashing, warms local v11/files/<aa>/<sha512>, signs cas-v11-global-manifest.json with Ed25519, and stages hot-path CDN shards.',
    outputs: [
      'registry/index/cas-v11-global-manifest.json',
      'registry/index/holo-compiler-lockfile.json',
      'registry/cdn-shards/',
    ],
  },
  {
    number: 6,
    id: 'rollout-channels',
    title: 'Unified 4-Channel User Rollout (Web OOBE, Netboot, Omaha Fleet, Edge)',
    summary:
      'Refreshes Ed25519-signed web/v11-bundle.json, aligns netboot/boot.ipxe, publishes fleet/channels/stable.json for atomic Slot A/B updates, and verifies live HTTPS endpoints.',
    outputs: [
      'installer/web/v11-bundle.json',
      'fleet/channels/stable.json',
      'os/bootstrap/last-bootstrap-receipt.json',
    ],
  },
] as const;

export function validateDistroManifest(manifest: DistroBootstrapManifest): void {
  if (manifest.schema !== 'holo.distro-bootstrap.v1') {
    throw new Error(`Invalid distro manifest schema "${String(manifest.schema)}": expected "holo.distro-bootstrap.v1".`);
  }
  if (manifest.abiMagic !== '0x33564742') {
    throw new Error(`Invalid ABI magic "${String(manifest.abiMagic)}": expected "0x33564742" (B8G_ABI_MAGIC_V3).`);
  }
  if (manifest.casLayout !== 'v11') {
    throw new Error(`Invalid CAS layout "${String(manifest.casLayout)}": expected "v11".`);
  }
  if (!manifest.id || !manifest.name || !manifest.version || !manifest.releaseTag) {
    throw new Error('Distro manifest requires non-empty id, name, version, and releaseTag.');
  }
  if (manifest.architectures.length === 0) {
    throw new Error('Distro manifest must target at least one architecture.');
  }
  const serialized = JSON.stringify(manifest);
  if (/b8g-ghost|cas-v1\b/i.test(serialized)) {
    throw new Error('Distro manifest contains prohibited legacy b8g-ghost or cas-v1 references.');
  }
}

export function renderOsRelease(manifest: DistroBootstrapManifest, arch: DistroArch = 'x86_64'): string {
  validateDistroManifest(manifest);
  return [
    `NAME="${manifest.name}"`,
    `VERSION="${manifest.version} (${manifest.codename})"`,
    `ID=${manifest.id}`,
    `VERSION_ID="${manifest.version}"`,
    `PRETTY_NAME="${manifest.name} ${manifest.version} (${arch} · Holo-Linux ${manifest.kernelRelease} · Pure Holo v11 CAS)"`,
    `ARCH=${arch}`,
    `HOLO_KERNEL="${manifest.kernelRelease}"`,
    `HOLO_CAS_LAYOUT="${manifest.casLayout}"`,
    `HOLO_CAS_DIR="${manifest.casMountPath}"`,
    `B8G_CAS_DIR="${manifest.casMountPath}"`,
    `HOLO_CAS_MANIFEST="${manifest.channels.casGlobalManifestUrl}"`,
    `B8G_ABI_MAGIC_V3=${manifest.abiMagic}`,
    `HOME_URL="${manifest.channels.webOobeUrl}"`,
    '',
  ].join('\n');
}

export function renderDualSlotLimineConf(manifest: DistroBootstrapManifest): string {
  validateDistroManifest(manifest);
  const splashFile = `${manifest.id}-${manifest.bootloader.defaultSplash}.bmp`;
  const title = `${manifest.name} Holo-Linux ${manifest.kernelRelease}`;
  return [
    `# ${title} — Limine v11/v12 Dual-Slot Bootloader Config (${manifest.releaseTag})`,
    '# Guarantees zero-flicker UEFI GOP -> SimpleDRM -> Sectium Canvas handoff.',
    '# Generated by os/bootstrap/holo-distro-bootstrap.mts (do not drift across repos).',
    '',
    'timeout: 3',
    'default_entry: 1',
    'serial: yes',
    'graphics: yes',
    `interface_branding: ${title} (${manifest.casLayout} CAS · ${manifest.releaseTag})`,
    'interface_branding_colour: 6',
    '',
    '# Uncompressed 24-bit BI_RGB BMP generated by assets/generate-splash.mts',
    `wallpaper: boot():/boot/splash/${splashFile}`,
    'wallpaper_style: stretched',
    'backdrop: 0E1116',
    '',
    '# Neutral Graphite + Lumi Cyan palette (matches Host Manager & Sectium)',
    'term_background: 0E1116',
    'term_foreground: E6EDF3',
    'term_palette: 0E1116;F85149;3FB950;D29922;58A6FF;BC8CFF;39C5CF;E6EDF3',
    'term_palette_bright: 484F58;FF7B72;56D364;E3B341;79C0FF;D2A8FF;56D4DD;FFFFFF',
    '',
    `/${title} — Slot A (Zero-Flicker Verified Desktop · ${manifest.releaseTag})`,
    '    protocol: linux',
    '    kernel_path: boot():/boot/slot-a/vmlinuz',
    '    cmdline: console=ttyS0,115200 console=tty0 quiet splash loglevel=3 vt.global_cursor_default=0 fbcon=nodefer b8g.abi=v3 scx_holo=1 b8g.slot=a awesome.slot=A',
    '    module_path: boot():/boot/slot-a/initramfs.cpio.zst',
    '',
    `/${title} — Slot B (Atomic O(1) Rollback · ${manifest.releaseTag})`,
    '    protocol: linux',
    '    kernel_path: boot():/boot/slot-b/vmlinuz',
    '    cmdline: console=ttyS0,115200 console=tty0 quiet splash loglevel=3 vt.global_cursor_default=0 fbcon=nodefer b8g.abi=v3 scx_holo=1 b8g.slot=b awesome.slot=B',
    '    module_path: boot():/boot/slot-b/initramfs.cpio.zst',
    '',
    `/${title} — Diagnostic Dual Console (QEMU / Proxmox / Hyper-V)`,
    '    protocol: linux',
    '    kernel_path: boot():/boot/slot-a/vmlinuz',
    '    cmdline: console=ttyS0,115200 console=tty0 b8g.abi=v3 scx_holo=1 awesome.nogui=1',
    '    module_path: boot():/boot/slot-a/initramfs.cpio.zst',
    '',
    `/${title} — CI Self-Test`,
    '    protocol: linux',
    '    kernel_path: boot():/boot/slot-a/vmlinuz',
    '    cmdline: console=ttyS0,115200 quiet b8g.abi=v3 scx_holo=1 awesome.selftest=1 t2.selftest=1',
    '    module_path: boot():/boot/slot-a/initramfs.cpio.zst',
    '',
  ].join('\n');
}

export function renderUnifiedNetbootIpxe(manifest: DistroBootstrapManifest): string {
  validateDistroManifest(manifest);
  return [
    '#!ipxe',
    `# ${manifest.name} ${manifest.version} (${manifest.releaseTag}) — Unified Stateless HTTPS Netboot`,
    `# Chainload from any bare-metal UEFI/PXE/Proxmox/Hyper-V host:`,
    `#   chain ${manifest.channels.netbootIpxeUrl}`,
    '',
    'echo ====================================================================',
    `echo   ${manifest.name} ${manifest.version} — Stateless Netboot (B8G_ABI_MAGIC_V3)`,
    `echo   Kernel : Holo-Linux ${manifest.kernelRelease} | CAS: Pure Holo ${manifest.casLayout} tmpfs`,
    'echo   Devices: local & remote => terminal | desktop (Sectium + Ladybird)',
    'echo ====================================================================',
    '',
    `set primary ${manifest.channels.netbootPrimaryBaseUrl}`,
    `set fallback ${manifest.channels.netbootFallbackBaseUrl}`,
    '',
    'kernel ${primary}/vmlinuz-x86_64 initrd=initramfs-x86_64.cpio.zst quiet splash vt.global_cursor_default=0 console=tty0 console=ttyS0,115200 b8g.abi=v3 scx_holo=1 awesome.netboot=1 || goto try_fallback',
    'initrd ${primary}/initramfs-x86_64.cpio.zst || goto try_fallback',
    'boot || goto try_fallback',
    '',
    ':try_fallback',
    'echo [AWESOME-OS] Primary release mirror busy — trying Holo-Linux 7.3.6 substrate...',
    `kernel \${fallback}/vmlinuz-${manifest.kernelRelease}-x86_64 initrd=initramfs-x86_64.cpio.zst quiet splash vt.global_cursor_default=0 console=tty0 console=ttyS0,115200 b8g.abi=v3 scx_holo=1 awesome.netboot=1 || goto failed`,
    'initrd ${primary}/initramfs-x86_64.cpio.zst || goto failed',
    'boot || goto failed',
    '',
    ':failed',
    'echo [AWESOME-OS] Netboot failed — dropping to iPXE shell',
    'shell',
    '',
  ].join('\n');
}

export function renderSystemDefinitionJson(manifest: DistroBootstrapManifest): string {
  validateDistroManifest(manifest);
  const doc = {
    schema: 'awesome-os.system-definition.v1',
    distroVersion: manifest.version,
    releaseTag: manifest.releaseTag,
    abiMagic: manifest.abiMagic,
    casLayout: manifest.casLayout,
    systemUri: `system://local/appliance/${manifest.id}`,
    casRoot: manifest.casMountPath,
    casManifestUrl: manifest.channels.casGlobalManifestUrl,
    v11Registry: `repository://github.com/${manifest.githubOrg}/holo-v11@main`,
    kernelRelease: manifest.kernelRelease,
    browserEngines: manifest.browserEngines,
    devices: {
      local: ['terminal', 'desktop'],
      remote: ['terminal', 'desktop'],
    },
    resources: [
      {
        uri: 'system://local/terminal/coreutils',
        from: `repository://github.com/${manifest.githubOrg}/coreutils@main`,
        tags: ['terminal-app', 'local'],
      },
      {
        uri: 'system://local/desktop/sectium',
        from: `repository://github.com/${manifest.githubOrg}/sectium-browser@main`,
        tags: ['device', 'browser-shell', 'monitor', 'keyboard', 'local'],
      },
      {
        uri: 'system://local/desktop/ladybird',
        from: `repository://github.com/${manifest.githubOrg}/ladybird@main`,
        tags: ['device', 'browser-engine', 'webgpu', 'local'],
      },
      {
        uri: 'system://local/desktop/wayland',
        from: `repository://github.com/${manifest.githubOrg}/${manifest.desktopImageRepo}@${manifest.releaseTag}`,
        tags: ['device', 'monitor', 'keyboard', 'local'],
      },
      {
        uri: 'system://local/desktop/omarchy?kvm=2',
        from: `repository://github.com/${manifest.githubOrg}/desktop-omarchy@main`,
        tags: ['monitor', 'keyboard', 'local'],
      },
      {
        uri: 'system://local/desktop/noctalia?kvm=3',
        from: `repository://github.com/${manifest.githubOrg}/noctalia@main`,
        tags: ['monitor', 'keyboard', 'local'],
      },
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function renderOmahaChannelManifest(
  manifest: DistroBootstrapManifest,
  artifacts: readonly OmahaArtifactEntry[],
  channel: 'stable' | 'beta' | 'canary' = 'stable',
  publishedAt: string = new Date().toISOString(),
): SignedManifest<OmahaChannelPayload> {
  validateDistroManifest(manifest);
  return signManifestEd25519({
    schema: 'awesome-os.omaha-channel.v1',
    channel,
    distroId: manifest.id,
    distroName: manifest.name,
    version: manifest.version,
    releaseTag: manifest.releaseTag,
    abiMagic: manifest.abiMagic,
    casLayout: manifest.casLayout,
    kernelRelease: manifest.kernelRelease,
    targetSlotPolicy: 'stage-standby-flip-atomic',
    casManifestUrl: manifest.channels.casGlobalManifestUrl,
    publishedAt,
    artifacts,
  });
}
