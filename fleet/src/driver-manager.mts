import { createHash } from 'node:crypto';

export type DriverTier = 'tier0-boot' | 'tier1-v11-cas-ko' | 'tier2-b8g-userspace';

export interface DriverCatalogEntry {
  readonly id: string;
  readonly moduleName: string;
  readonly tier: DriverTier;
  readonly modaliases: readonly string[];
  readonly estimatedKb: number;
  readonly abiMagic?: '0x33564742';
  readonly description: string;
}

export interface ResolvedDriverEntry extends DriverCatalogEntry {
  readonly matchedBy: readonly string[];
  readonly v11CasTag: string;
  readonly artifactPath: string;
}

export interface ResolvedDriverPack {
  readonly kernelRelease: string;
  readonly abiMagic: '0x33564742';
  readonly casLayout: 'v11';
  readonly inputModaliases: readonly string[];
  readonly drivers: readonly ResolvedDriverEntry[];
  readonly tierCounts: {
    readonly tier0Boot: number;
    readonly tier1CasKo: number;
    readonly tier2Userspace: number;
  };
  readonly totalEstimatedKb: number;
  readonly traditionalDistroMb: number;
  readonly savedMb: number;
  readonly savingsPercent: number;
  readonly packSha512: string;
  readonly v11VerificationTag: string;
  readonly resolvedAt: string;
}

export const DEFAULT_KERNEL_RELEASE = '7.0.0-awesome-v11';
export const TRADITIONAL_DISTRO_MODULES_MB = 1500;
export const B8G_ABI_MAGIC_V3 = '0x33564742' as const;

export const DEFAULT_V11_DRIVER_CATALOG: readonly DriverCatalogEntry[] = [
  // Tier 0 / Tier 1: Minimal verified kernel modules (.ko) hydrated on-demand from v11 CAS
  {
    id: 'hyperv-keyboard',
    moduleName: 'hyperv-keyboard.ko',
    tier: 'tier0-boot',
    modaliases: ['vmbus:*', 'serio:*'],
    estimatedKb: 24,
    description: 'Hyper-V synthetic keyboard & serio early-boot input driver',
  },
  {
    id: 'hid-hyperv',
    moduleName: 'hid-hyperv.ko',
    tier: 'tier1-v11-cas-ko',
    modaliases: ['hid:*'],
    estimatedKb: 32,
    description: 'Hyper-V synthetic HID pointer/input v11 CAS kernel module',
  },
  {
    id: 'virtio-gpu',
    moduleName: 'virtio-gpu.ko',
    tier: 'tier1-v11-cas-ko',
    modaliases: ['pci:v00001AF4d00001050*'],
    estimatedKb: 184,
    description: 'VirtIO GPU paravirtualized KMS/DRM display kernel module',
  },
  {
    id: 'amdgpu',
    moduleName: 'amdgpu.ko',
    tier: 'tier1-v11-cas-ko',
    modaliases: ['pci:v00001002*'],
    estimatedKb: 1420,
    description: 'AMD Radeon/RDNA DRM/KMS GPU kernel module (v11 CAS hydrated)',
  },
  {
    id: 'i915',
    moduleName: 'i915.ko',
    tier: 'tier1-v11-cas-ko',
    modaliases: ['pci:v00008086*'],
    estimatedKb: 980,
    description: 'Intel integrated graphics DRM/KMS kernel module (v11 CAS hydrated)',
  },
  {
    id: 'r8169',
    moduleName: 'r8169.ko',
    tier: 'tier1-v11-cas-ko',
    modaliases: ['pci:v000010EC*'],
    estimatedKb: 112,
    description: 'Realtek RTL8169/8168 Gigabit/2.5GbE Ethernet kernel module',
  },
  {
    id: 'usbhid',
    moduleName: 'usbhid.ko',
    tier: 'tier0-boot',
    modaliases: ['usb:*'],
    estimatedKb: 68,
    description: 'USB Human Interface Device early-boot input driver',
  },
  {
    id: 'apple-avd-video',
    moduleName: 'apple-avd.ko',
    tier: 'tier1-v11-cas-ko',
    modaliases: ['of:N*T*Capple,avd*', 'acpi:APPL*'],
    estimatedKb: 196,
    description: 'Generic Apple Silicon M1/M2 hardware H.264/HEVC/VP9 video decode driver (v11 CAS)',
  },
  {
    id: 'apple-ane-drm',
    moduleName: 'apple-ane.ko',
    tier: 'tier1-v11-cas-ko',
    modaliases: ['of:N*T*Capple,ane*', 'acpi:APPL*'],
    estimatedKb: 148,
    description: 'Generic Apple Silicon M1/M2 Neural Engine DRM accelerator driver (v11 CAS)',
  },
  // Tier 2: User-space B8G_ABI_MAGIC_V3 micro-drivers
  {
    id: 'holo-display-webgpu',
    moduleName: 'holo-display-webgpu.b8g',
    tier: 'tier2-b8g-userspace',
    modaliases: ['display:*'],
    estimatedKb: 96,
    abiMagic: B8G_ABI_MAGIC_V3,
    description: 'B8G_ABI_MAGIC_V3 user-space WebGPU / Sectium Canvas display micro-driver',
  },
  {
    id: 'holo-device-host',
    moduleName: 'holo-device-host.b8g',
    tier: 'tier2-b8g-userspace',
    modaliases: ['hid:*', 'vmbus:*'],
    estimatedKb: 64,
    abiMagic: B8G_ABI_MAGIC_V3,
    description: 'B8G_ABI_MAGIC_V3 user-space host device boundary & NDJSON multiplex micro-driver',
  },
  {
    id: 'holo-kvm-switch',
    moduleName: 'holo-kvm-switch.b8g',
    tier: 'tier2-b8g-userspace',
    modaliases: ['kvm:*'],
    estimatedKb: 48,
    abiMagic: B8G_ABI_MAGIC_V3,
    description: 'B8G_ABI_MAGIC_V3 user-space multi-host KVM input/display switch micro-driver',
  },
];

/**
 * Linux `depmod` / `fnmatch`-compatible modalias glob matcher supporting `*` and `?`.
 * Iterative O(N*M) worst-case, O(N+M) typical, zero RegExp backtracking risk.
 */
export function matchModalias(pattern: string, modalias: string): boolean {
  let pIdx = 0;
  let mIdx = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (mIdx < modalias.length) {
    if (pIdx < pattern.length && (pattern[pIdx] === '?' || pattern[pIdx] === modalias[mIdx])) {
      pIdx++;
      mIdx++;
    } else if (pIdx < pattern.length && pattern[pIdx] === '*') {
      starIdx = pIdx;
      matchIdx = mIdx;
      pIdx++;
    } else if (starIdx !== -1) {
      pIdx = starIdx + 1;
      matchIdx++;
      mIdx = matchIdx;
    } else {
      return false;
    }
  }

  while (pIdx < pattern.length && pattern[pIdx] === '*') {
    pIdx++;
  }

  return pIdx === pattern.length;
}

function sha512Hex(payload: string): string {
  return createHash('sha512').update(payload, 'utf8').digest('hex');
}

function buildArtifactPath(kernelRelease: string, entry: DriverCatalogEntry, digestPrefix: string): string {
  if (entry.tier === 'tier2-b8g-userspace') {
    return `/var/lib/b8g/cas/v11/userspace/${entry.id}/${digestPrefix}/${entry.moduleName}`;
  }
  return `/var/lib/b8g/cas/v11/modules/${kernelRelease}/${entry.tier}/${digestPrefix}/${entry.moduleName}`;
}

export function resolveDriverPack(
  kernelRelease: string,
  modaliases: readonly string[],
  catalog: readonly DriverCatalogEntry[] = DEFAULT_V11_DRIVER_CATALOG,
  now: string = new Date().toISOString(),
): ResolvedDriverPack {
  const normalizedRelease = kernelRelease.trim() || DEFAULT_KERNEL_RELEASE;
  const normalizedInputs = Array.from(
    new Set(modaliases.map((m) => m.trim()).filter((m) => m.length > 0)),
  );

  const resolvedDrivers: ResolvedDriverEntry[] = [];

  for (const entry of catalog) {
    const matchedBy: string[] = [];
    for (const inputAlias of normalizedInputs) {
      if (entry.modaliases.some((pattern) => matchModalias(pattern, inputAlias))) {
        matchedBy.push(inputAlias);
      }
    }
    if (matchedBy.length > 0) {
      const digest = sha512Hex(
        `v11|${B8G_ABI_MAGIC_V3}|${normalizedRelease}|${entry.id}|${entry.tier}|${entry.moduleName}`,
      );
      const v11CasTag = `v11:sha512:${digest.slice(0, 24)}`;
      resolvedDrivers.push({
        ...entry,
        matchedBy,
        v11CasTag,
        artifactPath: buildArtifactPath(normalizedRelease, entry, digest.slice(0, 16)),
      });
    }
  }

  let tier0Boot = 0;
  let tier1CasKo = 0;
  let tier2Userspace = 0;
  let totalEstimatedKb = 0;

  for (const drv of resolvedDrivers) {
    totalEstimatedKb += drv.estimatedKb;
    if (drv.tier === 'tier0-boot') tier0Boot++;
    else if (drv.tier === 'tier1-v11-cas-ko') tier1CasKo++;
    else tier2Userspace++;
  }

  const totalMb = totalEstimatedKb / 1024;
  const savedMb = Number(Math.max(0, TRADITIONAL_DISTRO_MODULES_MB - totalMb).toFixed(2));
  const savingsPercent = Number(((savedMb / TRADITIONAL_DISTRO_MODULES_MB) * 100).toFixed(2));

  const manifestSignature = [
    'v11',
    B8G_ABI_MAGIC_V3,
    normalizedRelease,
    ...resolvedDrivers.map((d) => `${d.id}=${d.v11CasTag}`),
  ].join('\n');
  const packSha512 = sha512Hex(manifestSignature);

  return {
    kernelRelease: normalizedRelease,
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: 'v11',
    inputModaliases: normalizedInputs,
    drivers: resolvedDrivers,
    tierCounts: {
      tier0Boot,
      tier1CasKo,
      tier2Userspace,
    },
    totalEstimatedKb,
    traditionalDistroMb: TRADITIONAL_DISTRO_MODULES_MB,
    savedMb,
    savingsPercent,
    packSha512,
    v11VerificationTag: `v11:sha512:${packSha512.slice(0, 32)}`,
    resolvedAt: now,
  };
}
