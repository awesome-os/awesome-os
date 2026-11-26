import { createHash } from 'node:crypto';
import type { DesktopAdapterId, HostLocality, HostSurface, SessionMode } from './host-manager.mts';

export type DriverTrack = 'open-foss' | 'proprietary' | 'driver-dev' | 'pinned-v1';

export interface AuditableDriverSet {
  readonly uri: string;
  readonly id: string;
  readonly version: string;
  readonly track: DriverTrack;
  readonly license: string;
  readonly kernelRange: string;
  readonly modaliasPatterns: readonly string[];
  readonly modules: readonly string[];
  readonly auditedBy: string;
  readonly rollbackSafe: true;
  readonly sha512: string;
  readonly notes: string;
}

export interface SystemProfile {
  readonly uri: string;
  readonly id: string;
  readonly name: string;
  readonly osRepo: 'awesome-os/desktop' | 'awesome-os/posix';
  readonly locality: HostLocality;
  readonly surface: HostSurface;
  readonly desktopAdapter: DesktopAdapterId;
  readonly mode: SessionMode;
  readonly defaultDriverSetUri: string;
  readonly defaultModaliases: readonly string[];
  readonly exclude?: readonly string[];
  readonly remap?: Readonly<Record<string, string>>;
}

function auditHash(uri: string, modules: readonly string[], kernelRange: string): string {
  return createHash('sha512')
    .update(`v11|0x33564742|${uri}|${kernelRange}|${modules.join(',')}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export const AUDITABLE_DRIVER_SETS: readonly AuditableDriverSet[] = [
  {
    uri: 'system://driver-set/hyperv-uefi@pinned-v1',
    id: 'hyperv-uefi',
    version: 'v1',
    track: 'pinned-v1',
    license: 'GPL-2.0 / BSD-3-Clause',
    kernelRange: '>=6.8 <7.5',
    modaliasPatterns: ['vmbus:*', 'hid:*', 'serio:*'],
    modules: ['hyperv-keyboard.ko', 'hid-hyperv.ko', 'holo-device-host.b8g'],
    auditedBy: 'awesome-os-release-audit',
    rollbackSafe: true,
    sha512: auditHash('system://driver-set/hyperv-uefi@pinned-v1', ['hyperv-keyboard.ko', 'hid-hyperv.ko', 'holo-device-host.b8g'], '>=6.8 <7.5'),
    notes: 'Pinned known-good Hyper-V Gen-2 UEFI keyboard, HID, and B8G device boundary stack.',
  },
  {
    uri: 'system://driver-set/gpu-nvidia@open-foss',
    id: 'gpu-nvidia',
    version: 'nvk-mesa-25',
    track: 'open-foss',
    license: 'MIT / GPL-2.0',
    kernelRange: '>=6.12',
    modaliasPatterns: ['pci:v000010DE*', 'display:*'],
    modules: ['nouveau.ko', 'holo-display-webgpu.b8g'],
    auditedBy: 'awesome-os-release-audit',
    rollbackSafe: true,
    sha512: auditHash('system://driver-set/gpu-nvidia@open-foss', ['nouveau.ko', 'holo-display-webgpu.b8g'], '>=6.12'),
    notes: 'Pure open-source Nouveau/NVK Vulkan + B8G WebGPU user-space display ring.',
  },
  {
    uri: 'system://driver-set/gpu-nvidia@proprietary',
    id: 'gpu-nvidia',
    version: '570-lts',
    track: 'proprietary',
    license: 'NVIDIA-Proprietary / Dual MIT-GPL',
    kernelRange: '>=6.8 <7.2',
    modaliasPatterns: ['pci:v000010DE*', 'display:*'],
    modules: ['nvidia-open.ko', 'nvidia-drm.ko', 'holo-display-webgpu.b8g'],
    auditedBy: 'awesome-os-release-audit',
    rollbackSafe: true,
    sha512: auditHash('system://driver-set/gpu-nvidia@proprietary', ['nvidia-open.ko', 'nvidia-drm.ko', 'holo-display-webgpu.b8g'], '>=6.8 <7.2'),
    notes: 'Audited proprietary NVIDIA 570 LTS stack staged via A/B Slot B with automatic rollback.',
  },
  {
    uri: 'system://driver-set/gpu-nvidia@driver-dev',
    id: 'gpu-nvidia',
    version: 'nightly-dev',
    track: 'driver-dev',
    license: 'MIT / GPL-2.0',
    kernelRange: '>=7.0',
    modaliasPatterns: ['pci:v000010DE*', 'display:*'],
    modules: ['nova-core.ko', 'holo-display-webgpu.b8g'],
    auditedBy: 'awesome-os-dev-channel',
    rollbackSafe: true,
    sha512: auditHash('system://driver-set/gpu-nvidia@driver-dev', ['nova-core.ko', 'holo-display-webgpu.b8g'], '>=7.0'),
    notes: 'Bleeding-edge Rust Nova GPU driver dev track (safe A/B slot rollback on probe failure).',
  },
  {
    uri: 'system://driver-set/gpu-amd@open-foss',
    id: 'gpu-amd',
    version: 'radv-v1',
    track: 'open-foss',
    license: 'MIT / GPL-2.0',
    kernelRange: '>=6.8',
    modaliasPatterns: ['pci:v00001002*', 'display:*'],
    modules: ['amdgpu.ko', 'holo-display-webgpu.b8g'],
    auditedBy: 'awesome-os-release-audit',
    rollbackSafe: true,
    sha512: auditHash('system://driver-set/gpu-amd@open-foss', ['amdgpu.ko', 'holo-display-webgpu.b8g'], '>=6.8'),
    notes: 'Audited mainline AMDGPU + RADV + B8G WebGPU compositor stack.',
  },
  {
    uri: 'system://driver-set/apple-silicon@pinned-v1',
    id: 'apple-silicon',
    version: 'm1-m2-v1',
    track: 'pinned-v1',
    license: 'MIT / BSD-3-Clause / GPL-2.0',
    kernelRange: '>=6.12',
    modaliasPatterns: ['of:N*T*Capple,avd*', 'of:N*T*Capple,ane*', 'acpi:APPL*', 'display:*'],
    modules: ['apple-avd.ko', 'apple-ane.ko', 'holo-display-webgpu.b8g'],
    auditedBy: 'awesome-os-release-audit',
    rollbackSafe: true,
    sha512: auditHash('system://driver-set/apple-silicon@pinned-v1', ['apple-avd.ko', 'apple-ane.ko', 'holo-display-webgpu.b8g'], '>=6.12'),
    notes: 'Generic Apple Silicon M1/M2 hardware video decode (AVD) + Neural Engine (ANE) DRM + B8G WebGPU stack (supersedes legacy omarchy-m1-video & omarchy-ane).',
  },
];

export const SYSTEM_PROFILES: readonly SystemProfile[] = [
  {
    uri: 'system://profile/workstation-omarchy',
    id: 'workstation-omarchy',
    name: 'Workstation — Omarchy Hyprland',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'omarchy-hyprland',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/gpu-amd@open-foss',
    defaultModaliases: ['pci:v00001002d0000744C', 'usb:v046DpC52B', 'display:webgpu'],
  },
  {
    uri: 'system://profile/workstation-omarchy-m1',
    id: 'workstation-omarchy-m1',
    name: 'Workstation — Omarchy Hyprland (Apple Silicon M1/M2)',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'omarchy-hyprland',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/apple-silicon@pinned-v1',
    defaultModaliases: ['of:N*T*Capple,avd', 'of:N*T*Capple,ane', 'display:webgpu'],
  },
  {
    uri: 'system://profile/workstation-noctalia',
    id: 'workstation-noctalia',
    name: 'Workstation — Noctalia Wayland',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'noctalia-shell',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/gpu-amd@open-foss',
    defaultModaliases: ['pci:v00008086d0000A7A0', 'usb:v046DpC52B', 'display:webgpu'],
  },
  {
    uri: 'system://profile/workstation-sectium',
    id: 'workstation-sectium',
    name: 'Workstation — Sectium Pure-Art Canvas',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'sectium-desktop',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/gpu-nvidia@open-foss',
    defaultModaliases: ['pci:v000010DEd00002684', 'display:webgpu', 'hid:b0003'],
  },
  {
    uri: 'system://profile/workstation-chonkstep',
    id: 'workstation-chonkstep',
    name: 'Workstation — ChonkStep Wayland (BeOS / Smithay)',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'chonkstep-wayland',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/gpu-amd@open-foss',
    defaultModaliases: ['pci:v00001002d0000744C', 'usb:v046DpC52B', 'display:webgpu'],
  },
  {
    uri: 'system://profile/workstation-hyperv',
    id: 'workstation-hyperv',
    name: 'Workstation — Hyper-V Gen-2 UEFI',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'omarchy-hyprland',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/hyperv-uefi@pinned-v1',
    defaultModaliases: ['vmbus:hyperv', 'hid:b0003', 'serio:ty01', 'display:webgpu'],
  },
  {
    uri: 'system://profile/baseline-t2sde',
    id: 'baseline-t2sde',
    name: 'Baseline — T2 SDE Real-Compiler + Base Holo Stack',
    osRepo: 'awesome-os/posix',
    locality: 'local',
    surface: 'terminal',
    desktopAdapter: 'kitty-ink-tui',
    mode: 'terminal-appliance',
    defaultDriverSetUri: 'system://driver-set/hyperv-uefi@pinned-v1',
    defaultModaliases: ['vmbus:hyperv', 'pci:v000010ECd00008168'],
    exclude: ['sysvinit', 'systemd', 'xorg-server', 'texinfo', 'groff', 'gettext', 'man-db', 'linux-firmware'],
    remap: {
      'gnu-coreutils': 'awesome-os/coreutils',
      sysvinit: 'awesome-os/posix',
      'xorg-server': 'awesome-os/desktop',
    },
  },
  {
    uri: 'system://profile/server-rack-blade',
    id: 'server-rack-blade',
    name: '19" Server Rack Blade (Awesome-OS POSIX)',
    osRepo: 'awesome-os/posix',
    locality: 'remote',
    surface: 'terminal',
    desktopAdapter: 'kitty-ink-tui',
    mode: 'terminal-appliance',
    defaultDriverSetUri: 'system://driver-set/hyperv-uefi@pinned-v1',
    defaultModaliases: ['pci:v000010ECd00008168', 'kvm:switch'],
  },
  {
    uri: 'system://profile/hyperv-uefi-dev',
    id: 'hyperv-uefi-dev',
    name: 'Hyper-V Gen-2 UEFI Developer Appliance',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'omarchy-hyprland',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/hyperv-uefi@pinned-v1',
    defaultModaliases: ['vmbus:hyperv', 'hid:b0003', 'serio:ty01', 'display:webgpu'],
  },
  {
    uri: 'system://profile/workstation-gnome',
    id: 'workstation-gnome',
    name: 'Workstation — GNOME Wayland (Debloated)',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'gnome-wayland',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/gpu-amd@open-foss',
    defaultModaliases: ['pci:v00001002d0000744C', 'usb:v046DpC52B', 'display:webgpu'],
    exclude: ['xorg-server', 'gnome-software', 'tracker-miner-fs', 'evolution-data-server', 'epiphany'],
    remap: {
      gdm: 'awesome-os/desktop#greeter',
      'gnome-software': 'awesome-os/holo-pm',
      epiphany: 'awesome-os/sectium-browser',
    },
  },
  {
    uri: 'system://profile/workstation-kde',
    id: 'workstation-kde',
    name: 'Workstation — KDE Plasma Wayland (Debloated)',
    osRepo: 'awesome-os/desktop',
    locality: 'local',
    surface: 'desktop',
    desktopAdapter: 'kde-plasma',
    mode: 'managed-desktop',
    defaultDriverSetUri: 'system://driver-set/gpu-amd@open-foss',
    defaultModaliases: ['pci:v00008086d0000A7A0', 'usb:v046DpC52B', 'display:webgpu'],
    exclude: ['xorg-server', 'baloo', 'discover', 'akonadi', 'drkonqi'],
    remap: {
      sddm: 'awesome-os/desktop#greeter',
      discover: 'awesome-os/holo-pm',
      display: 'holo-display-qt',
    },
  },
  {
    uri: 'system://profile/kiosk-appliance',
    id: 'kiosk-appliance',
    name: 'Locked Kiosk Appliance (ChromeOS Kiosk Policy)',
    osRepo: 'awesome-os/desktop',
    locality: 'remote',
    surface: 'desktop',
    desktopAdapter: 'sectium-desktop',
    mode: 'kiosk-app',
    defaultDriverSetUri: 'system://driver-set/gpu-amd@open-foss',
    defaultModaliases: ['pci:v00001AF4d00001050', 'hid:b0003', 'display:webgpu'],
  },
];

export function resolveSystemProfile(uriOrId: string): SystemProfile {
  const key = uriOrId.trim();
  const alias = key === 'hyperv-uefi-dev' || key === 'system://profile/hyperv-uefi-dev' ? 'workstation-hyperv' : key;
  const match = SYSTEM_PROFILES.find((p) => p.uri === alias || p.id === alias);
  if (!match) {
    const valid = SYSTEM_PROFILES.map((p) => p.uri).join(', ');
    throw new Error(`Unknown system profile "${uriOrId}". Available: ${valid}`);
  }
  return match;
}

export function resolveDriverSet(uriOrId: string): AuditableDriverSet {
  const key = uriOrId.trim();
  const match = AUDITABLE_DRIVER_SETS.find(
    (d) => d.uri === key || `${d.id}@${d.track}` === key || `${d.id}@${d.version}` === key,
  );
  if (!match) {
    const valid = AUDITABLE_DRIVER_SETS.map((d) => d.uri).join(', ');
    throw new Error(`Unknown auditable driver set "${uriOrId}". Available: ${valid}`);
  }
  return match;
}
