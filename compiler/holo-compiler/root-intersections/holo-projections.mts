/**
 * @file intersections/holo-compiler/holo-projections.mts
 * @description Canonical registry of all 12 Awesome-OS holographic runtime & toolchain
 * projections, legacy `ghost-*` / `b8g-*` alias resolution, and 0-byte hardlink
 * projection from the unified `CasV11Store` (`v11/files/XX/<sha512>[-exec]`).
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAS_V11_VERSION, CasV11Store } from './cas-v11-store.mts';

export const B8G_ABI_MAGIC_V3 = '0x33564742' as const;

export type HoloProjectionId =
  | 'holo-compiler'
  | 'holo-pm'
  | 'holo-ffi'
  | 'holo-wasi-host'
  | 'holo-node'
  | 'holo-deno'
  | 'holo-py'
  | 'holo-go'
  | 'holo-dart'
  | 'holo-rust'
  | 'holo-cpp'
  | 'holo-jvm';

export type HoloProjectionRuntimeKind =
  | 'compiler'
  | 'package-manager'
  | 'ffi'
  | 'wasi'
  | 'node'
  | 'deno'
  | 'python'
  | 'go'
  | 'dart'
  | 'rust'
  | 'cpp'
  | 'jvm';

export interface HoloProjectionDef {
  readonly id: HoloProjectionId;
  readonly displayName: string;
  readonly repositoryUri: `repository://${string}`;
  readonly legacyAliases: readonly string[];
  readonly runtimeKind: HoloProjectionRuntimeKind;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
  readonly casLayout: typeof CAS_V11_VERSION;
  readonly description: string;
}

export interface HoloArtifactBlobSpec {
  readonly relPath: string;
  readonly sha512: string;
  readonly executable?: boolean;
}

export interface HoloProjectionResult {
  readonly projectionId: HoloProjectionId;
  readonly destDir: string;
  readonly projectedCount: number;
  readonly hardlinkedCount: number;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
}

function freezeProjection(def: HoloProjectionDef): HoloProjectionDef {
  return Object.freeze({
    ...def,
    legacyAliases: Object.freeze([...def.legacyAliases]),
  });
}

/**
 * Canonical registry of all 12 Awesome-OS holographic projections backed by the
 * unified `v11` CAS layout and `B8G_ABI_MAGIC_V3` (`0x33564742`).
 */
export const HOLO_PROJECTIONS: readonly HoloProjectionDef[] = Object.freeze([
  freezeProjection({
    id: 'holo-compiler',
    displayName: 'Holo Compiler',
    repositoryUri: 'repository://awesome-os/holo-compiler',
    legacyAliases: ['b8g-build'],
    runtimeKind: 'compiler',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Universal holonomic compiler intersection with zero-AST lowering, sub-TU splicing, and .b8p CAS packs.',
  }),
  freezeProjection({
    id: 'holo-pm',
    displayName: 'Holo Package Manager',
    repositoryUri: 'repository://awesome-os/holo-pm',
    legacyAliases: ['b8g-pm'],
    runtimeKind: 'package-manager',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Zero-copy pnpm-v12-compatible v11 CAS package manager and hardlink projector.',
  }),
  freezeProjection({
    id: 'holo-ffi',
    displayName: 'Holo FFI Bridge',
    repositoryUri: 'repository://awesome-os/holo-ffi',
    legacyAliases: ['holoFFI', 'holo-ffi'],
    runtimeKind: 'ffi',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Zero-header C-ABI and B8G_ARENA_V1 foreign function interface projection.',
  }),
  freezeProjection({
    id: 'holo-wasi-host',
    displayName: 'Holo WASI Host',
    repositoryUri: 'repository://awesome-os/holo-wasi-host',
    legacyAliases: ['wasi-host'],
    runtimeKind: 'wasi',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Hermetic WASI microkernel host projection with capability-gated arenas.',
  }),
  freezeProjection({
    id: 'holo-node',
    displayName: 'Holo Node Runtime',
    repositoryUri: 'repository://awesome-os/holo-node',
    legacyAliases: ['ghost-node'],
    runtimeKind: 'node',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Zero-copy Node 22+ erasable TypeScript and ESM holographic runtime projection.',
  }),
  freezeProjection({
    id: 'holo-deno',
    displayName: 'Holo Deno Runtime',
    repositoryUri: 'repository://awesome-os/holo-deno',
    legacyAliases: [],
    runtimeKind: 'deno',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Web-standard Deno runtime projection sharing the unified v11 CAS blob store.',
  }),
  freezeProjection({
    id: 'holo-py',
    displayName: 'Holo Python Runtime',
    repositoryUri: 'repository://awesome-os/holo-py',
    legacyAliases: ['holo-py'],
    runtimeKind: 'python',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Hermetic Python runtime and wheel projection backed by v11 hardlinked blobs.',
  }),
  freezeProjection({
    id: 'holo-go',
    displayName: 'Holo Go Toolchain',
    repositoryUri: 'repository://awesome-os/holo-go',
    legacyAliases: [],
    runtimeKind: 'go',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Hermetic Go compiler and module cache projection over the v11 CAS store.',
  }),
  freezeProjection({
    id: 'holo-dart',
    displayName: 'Holo Dart Runtime',
    repositoryUri: 'repository://awesome-os/holo-dart',
    legacyAliases: [],
    runtimeKind: 'dart',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Hermetic Dart SDK and snapshot projection over the unified v11 CAS layout.',
  }),
  freezeProjection({
    id: 'holo-rust',
    displayName: 'Holo Rust Toolchain',
    repositoryUri: 'repository://awesome-os/holo-rust',
    legacyAliases: ['ghost-rust'],
    runtimeKind: 'rust',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Hermetic Rust/Cargo crate and artifact projection backed by v11 CAS hardlinks.',
  }),
  freezeProjection({
    id: 'holo-cpp',
    displayName: 'Holo C/C++ Toolchain',
    repositoryUri: 'repository://awesome-os/holo-cpp',
    legacyAliases: ['ghost-cpp'],
    runtimeKind: 'cpp',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Native C/C++ zig-cc/clang cross-compilation and PCH object projection.',
  }),
  freezeProjection({
    id: 'holo-jvm',
    displayName: 'Holo JVM Runtime',
    repositoryUri: 'repository://awesome-os/holo-jvm',
    legacyAliases: ['ghost-jvm'],
    runtimeKind: 'jvm',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    description:
      'Sectium-JVM / Kotlin AOT and bytecode holographic runtime projection.',
  }),
]);

const PROJECTION_INDEX: ReadonlyMap<string, HoloProjectionDef> = (() => {
  const index = new Map<string, HoloProjectionDef>();
  for (const def of HOLO_PROJECTIONS) {
    index.set(def.id.toLowerCase(), def);
    for (const alias of def.legacyAliases) {
      index.set(alias.toLowerCase(), def);
    }
  }
  return index;
})();

/**
 * Resolves a canonical `holo-*` projection ID or legacy `ghost-*` / `b8g-*` / `wasi-host`
 * alias to its unified `HoloProjectionDef`, or returns `undefined` if unknown.
 */
export function resolveHoloProjection(nameOrAlias: string): HoloProjectionDef | undefined {
  const normalized = nameOrAlias.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  return PROJECTION_INDEX.get(normalized);
}

function resolveContainedPath(rootDir: string, relPath: string): string {
  const trimmed = relPath.trim();
  if (trimmed.length === 0 || path.isAbsolute(trimmed)) {
    throw new Error(`Invalid relative artifact path: "${relPath}"`);
  }
  const target = path.resolve(rootDir, trimmed);
  const relative = path.relative(rootDir, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Artifact path escapes destination directory: "${relPath}"`);
  }
  return target;
}

/**
 * Projects a list of content-addressed blobs from `CasV11Store` into `destDir`
 * via 0-byte hardlinks (`store.linkBlobTo`), returning projection counters and ABI magic.
 */
export function projectHoloArtifacts(
  projectionId: string,
  store: CasV11Store,
  destDir: string,
  blobs: readonly HoloArtifactBlobSpec[],
): HoloProjectionResult {
  const def = resolveHoloProjection(projectionId);
  if (def === undefined) {
    throw new Error(`Unknown Holo projection: "${projectionId}"`);
  }

  const resolvedDestDir = path.resolve(destDir);
  fs.mkdirSync(resolvedDestDir, { recursive: true });
  store.registerProject(resolvedDestDir);

  let projectedCount = 0;
  let hardlinkedCount = 0;

  for (const blob of blobs) {
    const targetPath = resolveContainedPath(resolvedDestDir, blob.relPath);
    const linkResult = store.linkBlobTo(blob.sha512, targetPath, blob.executable === true);
    projectedCount += 1;
    if (linkResult.method === 'hardlink') {
      hardlinkedCount += 1;
    }
  }

  return Object.freeze({
    projectionId: def.id,
    destDir: resolvedDestDir,
    projectedCount,
    hardlinkedCount,
    abiMagic: def.abiMagic,
  });
}
