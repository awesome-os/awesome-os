/**
 * Awesome-OS 1-Click GPT A/B Disk Installer & O(1) Limine Slot Switcher
 *
 * Canonical GPT partition layout:
 *   1. ESP         256 MiB  FAT32  (Limine UEFI + A/B kernels & limine.conf)
 *   2. SLOT_A      512 MiB  ext4   (Verified OS Slot A)
 *   3. SLOT_B      512 MiB  ext4   (Verified OS Slot B)
 *   4. AWESOME_V11 remain   ext4   (Persistent v11 CAS: /var/lib/b8g/cas)
 */

export type AbSlot = 'A' | 'B';

export interface GptPartitionSpec {
  readonly number: 1 | 2 | 3 | 4;
  readonly label: 'ESP' | 'SLOT_A' | 'SLOT_B' | 'AWESOME_V11';
  readonly device: string;
  readonly fsType: 'fat32' | 'ext4';
  readonly startMiB: number;
  readonly endMiB: number | null;
  readonly sizeMiB: number;
  readonly flags: readonly string[];
  readonly mountPoint: string;
}

export interface GptAbPlan {
  readonly schema: 'awesome-os.gpt-ab-plan.v1';
  readonly device: string;
  readonly diskSizeGb: number;
  readonly activeSlot: AbSlot;
  readonly defaultEntry: 1 | 2;
  readonly requiresYesConfirmation: true;
  readonly partitions: readonly GptPartitionSpec[];
  readonly partedCommands: readonly string[];
  readonly mkfsCommands: readonly string[];
  readonly commands: readonly string[];
  readonly limineConf: string;
}

export const ESP_SIZE_MIB = 256;
export const SLOT_A_SIZE_MIB = 512;
export const SLOT_B_SIZE_MIB = 512;
export const MIN_DISK_SIZE_GB = 2;

const SAFE_DEVICE_RE = /^\/dev\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

function assertValidSlot(slot: string): asserts slot is AbSlot {
  if (slot !== 'A' && slot !== 'B') {
    throw new Error(`Invalid A/B slot "${slot}": expected "A" or "B".`);
  }
}

function assertValidDevice(device: string): void {
  if (!device || !SAFE_DEVICE_RE.test(device) || device.includes('..')) {
    throw new Error(`Unsafe or invalid block device path "${device}": must match /dev/<name>.`);
  }
}

function formatPartitionDevice(device: string, partitionNumber: 1 | 2 | 3 | 4): string {
  const needsP = /[0-9]$/.test(device);
  return `${device}${needsP ? 'p' : ''}${partitionNumber}`;
}

export function renderAbLimineConfig(
  activeSlot: AbSlot,
  slotARelease = 'awesome-os/posix@v11-slot-a',
  slotBRelease = 'awesome-os/posix@v11-slot-b',
): string {
  assertValidSlot(activeSlot);
  const defaultEntry = activeSlot === 'A' ? 1 : 2;
  return [
    'timeout: 2',
    'serial: yes',
    `default_entry: ${defaultEntry}`,
    '',
    `/Awesome-OS Slot A (${slotARelease})`,
    '    protocol: linux',
    '    kernel_path: boot():/boot/slot-a/vmlinuz',
    '    cmdline: console=ttyS0,115200 console=tty0 quiet loglevel=3 awesome.slot=A awesome.persist=1 root=LABEL=SLOT_A',
    '    module_path: boot():/boot/slot-a/initramfs.cpio.zst',
    '',
    `/Awesome-OS Slot B (${slotBRelease})`,
    '    protocol: linux',
    '    kernel_path: boot():/boot/slot-b/vmlinuz',
    '    cmdline: console=ttyS0,115200 console=tty0 quiet loglevel=3 awesome.slot=B awesome.persist=1 root=LABEL=SLOT_B',
    '    module_path: boot():/boot/slot-b/initramfs.cpio.zst',
    '',
  ].join('\n');
}

export function switchLimineDefaultSlot(limineConf: string, targetSlot: AbSlot): string {
  assertValidSlot(targetSlot);
  const targetEntry = targetSlot === 'A' ? 1 : 2;
  const normalized = limineConf.replace(/\r\n/g, '\n');
  const defaultEntryLineRe = /^[ \t]*default_entry[ \t]*:[ \t]*\d+[ \t]*$/m;

  if (defaultEntryLineRe.test(normalized)) {
    return normalized.replace(defaultEntryLineRe, `default_entry: ${targetEntry}`);
  }

  const lines = normalized.split('\n');
  const firstEntryIdx = lines.findIndex((line) => /^[ \t]*\//.test(line));
  if (firstEntryIdx === -1) {
    const trimmed = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
    return `${trimmed}default_entry: ${targetEntry}\n`;
  }

  lines.splice(firstEntryIdx, 0, `default_entry: ${targetEntry}`, '');
  return lines.join('\n');
}

export function buildGptAbPlan(
  device: string,
  diskSizeGb = 16,
  activeSlot: AbSlot = 'A',
): GptAbPlan {
  assertValidDevice(device);
  assertValidSlot(activeSlot);
  if (!Number.isFinite(diskSizeGb) || diskSizeGb < MIN_DISK_SIZE_GB) {
    throw new Error(
      `Disk size ${diskSizeGb} GB is too small for Awesome-OS GPT A/B layout (minimum ${MIN_DISK_SIZE_GB} GB).`,
    );
  }

  const espStart = 1;
  const espEnd = espStart + ESP_SIZE_MIB; // 257
  const slotAEnd = espEnd + SLOT_A_SIZE_MIB; // 769
  const slotBEnd = slotAEnd + SLOT_B_SIZE_MIB; // 1281
  const totalMiB = Math.floor(diskSizeGb * 1024);
  const casSizeMiB = totalMiB - slotBEnd;

  const p1 = formatPartitionDevice(device, 1);
  const p2 = formatPartitionDevice(device, 2);
  const p3 = formatPartitionDevice(device, 3);
  const p4 = formatPartitionDevice(device, 4);

  const partitions: readonly GptPartitionSpec[] = [
    {
      number: 1,
      label: 'ESP',
      device: p1,
      fsType: 'fat32',
      startMiB: espStart,
      endMiB: espEnd,
      sizeMiB: ESP_SIZE_MIB,
      flags: ['esp'],
      mountPoint: '/boot/efi',
    },
    {
      number: 2,
      label: 'SLOT_A',
      device: p2,
      fsType: 'ext4',
      startMiB: espEnd,
      endMiB: slotAEnd,
      sizeMiB: SLOT_A_SIZE_MIB,
      flags: [],
      mountPoint: '/mnt/slot-a',
    },
    {
      number: 3,
      label: 'SLOT_B',
      device: p3,
      fsType: 'ext4',
      startMiB: slotAEnd,
      endMiB: slotBEnd,
      sizeMiB: SLOT_B_SIZE_MIB,
      flags: [],
      mountPoint: '/mnt/slot-b',
    },
    {
      number: 4,
      label: 'AWESOME_V11',
      device: p4,
      fsType: 'ext4',
      startMiB: slotBEnd,
      endMiB: null,
      sizeMiB: casSizeMiB,
      flags: [],
      mountPoint: '/var/lib/b8g/cas',
    },
  ];

  const partedCommands: readonly string[] = [
    `parted -s ${device} mklabel gpt`,
    `parted -s ${device} mkpart ESP fat32 ${espStart}MiB ${espEnd}MiB`,
    `parted -s ${device} set 1 esp on`,
    `parted -s ${device} mkpart SLOT_A ext4 ${espEnd}MiB ${slotAEnd}MiB`,
    `parted -s ${device} mkpart SLOT_B ext4 ${slotAEnd}MiB ${slotBEnd}MiB`,
    `parted -s ${device} mkpart AWESOME_V11 ext4 ${slotBEnd}MiB 100%`,
  ];

  const mkfsCommands: readonly string[] = [
    `mkfs.fat -F 32 -n ESP ${p1}`,
    `mkfs.ext4 -F -L SLOT_A ${p2}`,
    `mkfs.ext4 -F -L SLOT_B ${p3}`,
    `mkfs.ext4 -F -L AWESOME_V11 ${p4}`,
  ];

  return {
    schema: 'awesome-os.gpt-ab-plan.v1',
    device,
    diskSizeGb,
    activeSlot,
    defaultEntry: activeSlot === 'A' ? 1 : 2,
    requiresYesConfirmation: true,
    partitions,
    partedCommands,
    mkfsCommands,
    commands: [...partedCommands, ...mkfsCommands],
    limineConf: renderAbLimineConfig(activeSlot),
  };
}
