#!/usr/bin/env node
/**
 * @file kernel/holo-kbuild.mts
 * @description Awesome-OS Fast Kernel Dev Kit ("Free Linus From His Pains"):
 *  - Deterministic SHA-512 kconfig + VERMAGIC fingerprinting for v11 CAS caching
 *  - Module.symvers ABI stability gate (catches out-of-tree driver breaks before ship)
 *  - Sub-second QEMU dual-console (tty0 + ttyS0) + GDB stub launcher
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type KernelArch = 'x86_64' | 'arm64';
export type KernelProfile = 'desktop' | 'posix' | 'vm-fast';

export interface KernelBuildPlan {
  schema: 'awesome-os.holo-kbuild-plan.v1';
  kernelVersion: string;
  arch: KernelArch;
  profile: KernelProfile;
  kconfigSha512: string;
  vermagicTag: string;
  casCachePrefix: string;
  reproducibleEnv: Record<string, string>;
  makeArgs: string[];
  requiredSymbols: string[];
}

export interface SymversEntry {
  crc: string;
  symbol: string;
  module: string;
  exportType: string;
}

export interface AbiDiffResult {
  compatible: boolean;
  unchangedCount: number;
  changedSymbols: Array<{ symbol: string; oldCrc: string; newCrc: string }>;
  removedSymbols: string[];
  addedSymbols: string[];
}

export function parseSymvers(text: string): Map<string, SymversEntry> {
  const map = new Map<string, SymversEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    map.set(parts[1], {
      crc: parts[0],
      symbol: parts[1],
      module: parts[2],
      exportType: parts[3],
    });
  }
  return map;
}

export function diffKernelAbi(oldSymversText: string, newSymversText: string): AbiDiffResult {
  const oldMap = parseSymvers(oldSymversText);
  const newMap = parseSymvers(newSymversText);

  let unchangedCount = 0;
  const changedSymbols: Array<{ symbol: string; oldCrc: string; newCrc: string }> = [];
  const removedSymbols: string[] = [];
  const addedSymbols: string[] = [];

  for (const [sym, oldEntry] of oldMap.entries()) {
    const cur = newMap.get(sym);
    if (!cur) {
      removedSymbols.push(sym);
    } else if (cur.crc !== oldEntry.crc) {
      changedSymbols.push({ symbol: sym, oldCrc: oldEntry.crc, newCrc: cur.crc });
    } else {
      unchangedCount++;
    }
  }
  for (const sym of newMap.keys()) {
    if (!oldMap.has(sym)) addedSymbols.push(sym);
  }

  return {
    compatible: changedSymbols.length === 0 && removedSymbols.length === 0,
    unchangedCount,
    changedSymbols,
    removedSymbols,
    addedSymbols,
  };
}

export function buildKernelPlan(opts: {
  kernelVersion?: string;
  arch?: KernelArch;
  profile?: KernelProfile;
  configPath?: string;
} = {}): KernelBuildPlan {
  const kernelVersion = opts.kernelVersion ?? '7.3.6';
  const arch: KernelArch = opts.arch ?? 'x86_64';
  const profile: KernelProfile = opts.profile ?? 'desktop';
  const cfgPath =
    opts.configPath ??
    join(dirname(fileURLToPath(import.meta.url)), 'awesome-os-7.3.config');

  const cfgText = readFileSync(cfgPath, 'utf8');
  const kconfigSha512 = createHash('sha512')
    .update(`${kernelVersion}:${arch}:${profile}\n${cfgText}`)
    .digest('hex');
  const shortHash = kconfigSha512.slice(0, 12);
  const vermagicTag = `${kernelVersion}-awesome-v11-${profile}-${shortHash}`;

  return {
    schema: 'awesome-os.holo-kbuild-plan.v1',
    kernelVersion,
    arch,
    profile,
    kconfigSha512,
    vermagicTag,
    casCachePrefix: `cas/v11/kernel/${vermagicTag}`,
    reproducibleEnv: {
      LLVM: '1',
      LLVM_IAS: '1',
      KBUILD_BUILD_TIMESTAMP: '1970-01-01 00:00:00 UTC',
      KBUILD_BUILD_USER: 'holo-compiler',
      KBUILD_BUILD_HOST: 'awesome-os',
      LOCALVERSION: `-awesome-v11-${profile}`,
    },
    makeArgs: [
      `ARCH=${arch === 'arm64' ? 'arm64' : 'x86_64'}`,
      'LLVM=1',
      'LLVM_IAS=1',
      arch === 'arm64' ? 'Image' : 'bzImage',
      'modules',
    ],
    requiredSymbols: [
      'CONFIG_IO_URING=y',
      'CONFIG_DRM_SIMPLEDRM=y',
      'CONFIG_HYPERV_KEYBOARD=y',
      'CONFIG_DEBUG_INFO_BTF=y',
      'CONFIG_KERNEL_ZSTD=y',
    ],
  };
}

export function buildQemuDebugCommand(opts: {
  kernelImage: string;
  initramfs: string;
  arch?: KernelArch;
  memoryMb?: number;
  gdbStub?: boolean;
}): string[] {
  const arch = opts.arch ?? 'x86_64';
  const mem = String(opts.memoryMb ?? 1024);
  const bin = arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64';
  const args = [
    bin,
    '-m', mem,
    '-kernel', opts.kernelImage,
    '-initrd', opts.initramfs,
    '-append', 'console=ttyS0,115200 console=tty0 panic=5 nokaslr',
    '-nographic',
  ];
  if (opts.gdbStub !== false) args.push('-s');
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? 'plan';
  if (cmd === 'plan') {
    const plan = buildKernelPlan();
    console.log(JSON.stringify(plan, null, 2));
  } else if (cmd === 'qemu') {
    console.log(
      buildQemuDebugCommand({
        kernelImage: process.argv[3] ?? 'arch/x86/boot/bzImage',
        initramfs: process.argv[4] ?? 'initramfs.cpio.zst',
      }).join(' '),
    );
  } else {
    console.log('Usage: node kernel/holo-kbuild.mts [plan | qemu <bzImage> <initramfs>]');
  }
}
