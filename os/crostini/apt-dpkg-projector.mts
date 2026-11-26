/**
 * @file os/crostini/apt-dpkg-projector.mts
 * @description
 *   Rootless Crostini `dpkg/status` + `dpkg/info/<pkg>.list` virtual-provides projector
 *   backed by Awesome-OS `v11` SHA-512 CAS (`v11/files/<aa>/<sha512>`) with strict
 *   ELF `SONAME` ABI verification (rejects missing/mismatched SONAME or missing `v11` SHA-512 hash).
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const APT_DPKG_PROJECTOR_SCHEMA = 'awesomeos.crostini-apt-dpkg.v1' as const;
export const DEFAULT_CROSTINI_CAS_ROOT = '/var/lib/b8g/cas';
export const SHA512_HEX_RE = /^[0-9a-f]{128}$/i;
export const ELF_SONAME_RE = /^[A-Za-z0-9_+.-]+\.so(?:\.[0-9]+)*$/;

export type CrostiniDebianArch = 'amd64' | 'arm64' | 'riscv64' | 'all';

export interface CrostiniAptPackageSpec {
  readonly package: string;
  readonly version: string;
  readonly architecture: CrostiniDebianArch;
  readonly soname: string;
  readonly expectedSoname?: string;
  readonly elfHeaderSoname?: string;
  readonly v11Sha512: string;
  readonly provides?: readonly string[];
  readonly depends?: readonly string[];
  readonly section?: string;
  readonly priority?: string;
  readonly installedSizeKb?: number;
  readonly maintainer?: string;
  readonly description?: string;
  readonly files?: readonly string[];
}

export interface CrostiniAptProjectionOptions {
  readonly casRoot?: string;
  readonly sysrootDir?: string;
  readonly writeFiles?: boolean;
  readonly expectedSonames?: Readonly<Record<string, string>>;
}

export interface ProjectedCrostiniAptPackage {
  readonly package: string;
  readonly version: string;
  readonly architecture: CrostiniDebianArch;
  readonly soname: string;
  readonly v11Sha512: string;
  readonly casFilePath: string;
  readonly provides: readonly string[];
  readonly listRelPath: string;
  readonly files: readonly string[];
}

export interface CrostiniAptDpkgProjection {
  readonly schema: 'awesomeos.crostini-apt-dpkg.v1';
  readonly rootless: true;
  readonly statusRelPath: 'var/lib/dpkg/status';
  readonly statusText: string;
  readonly listFiles: Readonly<Record<string, string>>;
  readonly packages: readonly ProjectedCrostiniAptPackage[];
  readonly sha256: string;
  readonly writtenPaths: readonly string[];
}

function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function multiarchTuple(arch: CrostiniDebianArch): string {
  if (arch === 'arm64') return 'aarch64-linux-gnu';
  if (arch === 'riscv64') return 'riscv64-linux-gnu';
  return 'x86_64-linux-gnu';
}

export function buildV11CasFilePath(sha512: string, casRoot = DEFAULT_CROSTINI_CAS_ROOT): string {
  const cleanRoot = casRoot.replace(/\/+$/, '');
  const normalized = sha512.toLowerCase();
  return `${cleanRoot}/v11/files/${normalized.slice(0, 2)}/${normalized}`;
}

/**
 * Strictly validates both `v11` SHA-512 CAS digest and ELF `SONAME` ABI consistency.
 */
export function verifyAptPackageSonameAbi(
  spec: CrostiniAptPackageSpec,
  policyExpectedSoname?: string,
): { soname: string; v11Sha512: string } {
  const pkg = spec.package.trim();
  if (!pkg) {
    throw new Error('Crostini APT projector: package name must be non-empty');
  }

  const sha512 = spec.v11Sha512?.trim() ?? '';
  if (!SHA512_HEX_RE.test(sha512)) {
    throw new Error(
      `Crostini APT projector: package "${pkg}" missing or invalid v11 SHA-512 hash (expected 128 hex chars)`,
    );
  }

  const soname = spec.soname?.trim() ?? '';
  if (!soname || !ELF_SONAME_RE.test(soname)) {
    throw new Error(
      `Crostini APT projector: package "${pkg}" missing or invalid mandatory ELF SONAME "${soname}"`,
    );
  }

  const expected = policyExpectedSoname?.trim() || spec.expectedSoname?.trim();
  if (expected && soname !== expected) {
    throw new Error(
      `Crostini APT projector: SONAME ABI mismatch for "${pkg}": declared "${soname}" !== expected "${expected}"`,
    );
  }

  const observedHeader = spec.elfHeaderSoname?.trim();
  if (observedHeader && observedHeader !== soname) {
    throw new Error(
      `Crostini APT projector: ELF DT_SONAME mismatch for "${pkg}": header "${observedHeader}" !== declared "${soname}"`,
    );
  }

  return { soname, v11Sha512: sha512.toLowerCase() };
}

function buildDpkgListContent(files: readonly string[]): string {
  const dirs = new Set<string>(['/.']);
  const normalizedFiles: string[] = [];

  for (const rawFile of files) {
    const clean = rawFile.startsWith('/') ? rawFile : `/${rawFile}`;
    normalizedFiles.push(clean);
    const parts = clean.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc += `/${parts[i]}`;
      dirs.add(acc);
    }
  }

  const allEntries = Array.from(new Set([...dirs, ...normalizedFiles])).sort(byteCompare);
  return `${allEntries.join('\n')}\n`;
}

function renderDpkgStatusStanza(
  spec: CrostiniAptPackageSpec,
  soname: string,
  v11Sha512: string,
  casFilePath: string,
  provides: readonly string[],
): string {
  const lines = [
    `Package: ${spec.package.trim()}`,
    'Status: install ok installed',
    `Priority: ${spec.priority?.trim() || 'optional'}`,
    `Section: ${spec.section?.trim() || 'libs'}`,
    `Installed-Size: ${spec.installedSizeKb ?? 512}`,
    `Maintainer: ${spec.maintainer?.trim() || 'Awesome-OS Crostini CAS <cas@awesome-os.com>'}`,
    `Architecture: ${spec.architecture}`,
    `Version: ${spec.version.trim()}`,
  ];

  if (provides.length > 0) {
    lines.push(`Provides: ${provides.join(', ')}`);
  }
  if (spec.depends && spec.depends.length > 0) {
    lines.push(`Depends: ${[...spec.depends].sort(byteCompare).join(', ')}`);
  }

  lines.push(
    'X-Holo-CAS-Store: v11',
    `X-Holo-CAS-Path: ${casFilePath}`,
    `X-Holo-V11-SHA512: ${v11Sha512}`,
    `X-Holo-ELF-SONAME: ${soname}`,
    `Description: ${spec.description?.trim() || `${spec.package.trim()} (${soname}) virtual-provides CAS v11 projection`}`,
  );
  return lines.join('\n');
}

export function projectCrostiniAptDpkg(
  specs: readonly CrostiniAptPackageSpec[],
  options: CrostiniAptProjectionOptions = {},
): CrostiniAptDpkgProjection {
  const casRoot = options.casRoot ?? DEFAULT_CROSTINI_CAS_ROOT;
  const sortedSpecs = [...specs].sort((a, b) => byteCompare(a.package, b.package));

  const seenPackages = new Set<string>();
  const stanzas: string[] = [];
  const listFiles: Record<string, string> = {};
  const projected: ProjectedCrostiniAptPackage[] = [];

  for (const spec of sortedSpecs) {
    const pkgName = spec.package.trim();
    if (seenPackages.has(pkgName)) {
      throw new Error(`Crostini APT projector: duplicate package "${pkgName}"`);
    }
    seenPackages.add(pkgName);

    const policyExpected = options.expectedSonames?.[pkgName];
    const { soname, v11Sha512 } = verifyAptPackageSonameAbi(spec, policyExpected);
    const casFilePath = buildV11CasFilePath(v11Sha512, casRoot);
    const provides = Array.from(new Set([...(spec.provides ?? []), `holo-v11-${pkgName}`])).sort(byteCompare);

    const defaultLibPath = `/usr/lib/${multiarchTuple(spec.architecture)}/${soname}`;
    const files = spec.files && spec.files.length > 0 ? [...spec.files].sort(byteCompare) : [defaultLibPath];
    const listRelPath = `var/lib/dpkg/info/${pkgName}.list`;

    stanzas.push(renderDpkgStatusStanza(spec, soname, v11Sha512, casFilePath, provides));
    listFiles[listRelPath] = buildDpkgListContent(files);
    projected.push({
      package: pkgName,
      version: spec.version.trim(),
      architecture: spec.architecture,
      soname,
      v11Sha512,
      casFilePath,
      provides,
      listRelPath,
      files,
    });
  }

  const statusRelPath = 'var/lib/dpkg/status' as const;
  const statusText = stanzas.length > 0 ? `${stanzas.join('\n\n')}\n` : '';
  const sha256 = createHash('sha256').update(statusText, 'utf8').digest('hex');

  const writtenPaths: string[] = [];
  const shouldWrite = Boolean(options.sysrootDir && options.writeFiles !== false);
  if (shouldWrite && options.sysrootDir) {
    const sysroot = resolve(options.sysrootDir);
    const statusTarget = join(sysroot, statusRelPath);
    mkdirSync(dirname(statusTarget), { recursive: true });
    writeFileSync(statusTarget, statusText, 'utf8');
    writtenPaths.push(statusTarget);

    for (const [relPath, content] of Object.entries(listFiles)) {
      const listTarget = join(sysroot, relPath);
      mkdirSync(dirname(listTarget), { recursive: true });
      writeFileSync(listTarget, content, 'utf8');
      writtenPaths.push(listTarget);
    }
  }

  return {
    schema: APT_DPKG_PROJECTOR_SCHEMA,
    rootless: true,
    statusRelPath,
    statusText,
    listFiles,
    packages: projected,
    sha256,
    writtenPaths,
  };
}
