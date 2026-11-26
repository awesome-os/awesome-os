/**
 * @file intersections/holo-compiler/go-dart-bridge.mts
 * @description Deterministic `holo-compiler` toolchain bridge for `awesome-os/go-lang`
 * (5-target `CGO_ENABLED=0` cross-compilation) and `awesome-os/dart` (`aot-exe`,
 * `wasm-gc`, `jit-snapshot`), unified over the `CasV11Store` (`v11/files/00..ff/<sha512>`).
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import {
  CAS_V11_VERSION,
  CasV11Store,
  sha512Hex,
  type CasV11BlobKind,
} from './cas-v11-store.mts';
import {
  formatV11RelativeBlobPath,
  type HoloLockfileNodeKind,
} from './lockfile.mts';

// ============================================================================
// 1. Canonical Constants & Target Tables
// ============================================================================

export const B8G_ABI_MAGIC_V3 = 0x33564742 as const;
export const GO_TOOLCHAIN_REPO = 'awesome-os/go-lang' as const;
export const DART_TOOLCHAIN_REPO = 'awesome-os/dart' as const;

export const GO_FIVE_TARGETS = Object.freeze([
  'win64',
  'linux-x64',
  'linux-arm64',
  'macos-arm64',
  'wasm32-wasi',
] as const);

export type GoToolchainTarget = (typeof GO_FIVE_TARGETS)[number];

export const DART_TOOLCHAIN_TARGETS = Object.freeze([
  'aot-exe',
  'wasm-gc',
  'jit-snapshot',
] as const);

export type DartToolchainTarget = (typeof DART_TOOLCHAIN_TARGETS)[number];

export interface GoTargetSpec {
  readonly target: GoToolchainTarget;
  readonly goos: 'windows' | 'linux' | 'darwin' | 'wasip1';
  readonly goarch: 'amd64' | 'arm64' | 'wasm';
  readonly targetTriple: string;
  readonly ext: string;
  readonly executable: boolean;
}

export const GO_TARGET_SPECS: Readonly<Record<GoToolchainTarget, GoTargetSpec>> = Object.freeze({
  win64: Object.freeze({
    target: 'win64',
    goos: 'windows',
    goarch: 'amd64',
    targetTriple: 'x86_64-windows-gnu',
    ext: '.exe',
    executable: true,
  }),
  'linux-x64': Object.freeze({
    target: 'linux-x64',
    goos: 'linux',
    goarch: 'amd64',
    targetTriple: 'x86_64-linux-musl',
    ext: '',
    executable: true,
  }),
  'linux-arm64': Object.freeze({
    target: 'linux-arm64',
    goos: 'linux',
    goarch: 'arm64',
    targetTriple: 'aarch64-linux-musl',
    ext: '',
    executable: true,
  }),
  'macos-arm64': Object.freeze({
    target: 'macos-arm64',
    goos: 'darwin',
    goarch: 'arm64',
    targetTriple: 'aarch64-macos',
    ext: '',
    executable: true,
  }),
  'wasm32-wasi': Object.freeze({
    target: 'wasm32-wasi',
    goos: 'wasip1',
    goarch: 'wasm',
    targetTriple: 'wasm32-wasi',
    ext: '.wasm',
    executable: false,
  }),
});

export interface DartTargetSpec {
  readonly target: DartToolchainTarget;
  readonly subcommand: 'exe' | 'wasm' | 'jit-snapshot';
  readonly ext: string;
  readonly executable: boolean;
  readonly artifactKind: HoloLockfileNodeKind;
}

export const DART_TARGET_SPECS: Readonly<Record<DartToolchainTarget, DartTargetSpec>> = Object.freeze({
  'aot-exe': Object.freeze({
    target: 'aot-exe',
    subcommand: 'exe',
    ext: '.exe',
    executable: true,
    artifactKind: 'bin',
  }),
  'wasm-gc': Object.freeze({
    target: 'wasm-gc',
    subcommand: 'wasm',
    ext: '.wasm',
    executable: false,
    artifactKind: 'wasm',
  }),
  'jit-snapshot': Object.freeze({
    target: 'jit-snapshot',
    subcommand: 'jit-snapshot',
    ext: '.jit',
    executable: false,
    artifactKind: 'object',
  }),
});

// ============================================================================
// 2. Go Toolchain Plan (`awesome-os/go-lang`)
// ============================================================================

export interface BuildGoToolchainPlanOptions {
  /** Go package path to build (default: `'.'`). */
  readonly pkg?: string;
  /** Repository identifier (default: `'awesome-os/go-lang'`). */
  readonly repo?: string;
  /** Target subset (default: all 5 canonical targets). */
  readonly targets?: readonly GoToolchainTarget[];
  /** Base output filename stem (default: `'go-artifact'`). */
  readonly outputName?: string;
  /** Deterministic `-ldflags` value (default: `'-s -w'`). */
  readonly ldflags?: string;
  /** Additional flags forwarded to `go build`. */
  readonly extraArgs?: readonly string[];
  /** Optional content digest seed for deterministic CAS output path derivation. */
  readonly sourceDigest?: string;
  /** Go binary shim name (default: `'go'`). */
  readonly goBinary?: string;
}

export interface GoTargetBuildStep {
  readonly target: GoToolchainTarget;
  readonly targetTriple: string;
  readonly goos: GoTargetSpec['goos'];
  readonly goarch: GoTargetSpec['goarch'];
  readonly executable: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<{
    CGO_ENABLED: '0';
    GOOS: GoTargetSpec['goos'];
    GOARCH: GoTargetSpec['goarch'];
  }>;
  readonly outputFilename: string;
  readonly planSha512: string;
  readonly casOutputPath: string;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
}

export interface GoToolchainPlan {
  readonly repo: string;
  readonly toolchain: 'go';
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
  readonly casLayout: typeof CAS_V11_VERSION;
  readonly pkg: string;
  readonly cgoEnabled: false;
  readonly deterministic: true;
  readonly targets: readonly GoToolchainTarget[];
  readonly steps: readonly GoTargetBuildStep[];
  readonly byTarget: Readonly<Partial<Record<GoToolchainTarget, GoTargetBuildStep>>>;
}

/**
 * Builds a deterministic 5-target `awesome-os/go-lang` cross-compilation plan with
 * `CGO_ENABLED=0`, `-trimpath`, `-buildvcs=false`, and canonical `v11/files/00..ff/<sha512>`
 * CAS output paths.
 */
export function buildGoToolchainPlan(
  opts: BuildGoToolchainPlanOptions = {},
): GoToolchainPlan {
  const repo = opts.repo ?? GO_TOOLCHAIN_REPO;
  const pkg = opts.pkg ?? '.';
  const outputName = opts.outputName ?? 'go-artifact';
  const ldflags = opts.ldflags ?? '-s -w';
  const goBinary = opts.goBinary ?? 'go';
  const extraArgs = opts.extraArgs ?? [];
  const targets: readonly GoToolchainTarget[] = opts.targets
    ? [...opts.targets]
    : [...GO_FIVE_TARGETS];

  const steps: GoTargetBuildStep[] = [];
  const byTarget: Partial<Record<GoToolchainTarget, GoTargetBuildStep>> = {};

  for (const target of targets) {
    const spec = GO_TARGET_SPECS[target];
    if (!spec) {
      throw new Error(`Unsupported Go toolchain target: "${String(target)}"`);
    }

    const outputFilename = `${outputName}-${spec.target}${spec.ext}`;
    const env = Object.freeze({
      CGO_ENABLED: '0' as const,
      GOOS: spec.goos,
      GOARCH: spec.goarch,
    });
    const args = Object.freeze([
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags',
      ldflags,
      ...extraArgs,
      '-o',
      outputFilename,
      pkg,
    ]);

    const planFingerprint = JSON.stringify({
      abiMagic: B8G_ABI_MAGIC_V3,
      repo,
      toolchain: 'go',
      target: spec.target,
      env,
      args,
      sourceDigest: opts.sourceDigest ?? '',
    });
    const planSha512 = sha512Hex(planFingerprint);
    const casOutputPath = formatV11RelativeBlobPath(planSha512, spec.executable);

    const step: GoTargetBuildStep = Object.freeze({
      target: spec.target,
      targetTriple: spec.targetTriple,
      goos: spec.goos,
      goarch: spec.goarch,
      executable: spec.executable,
      command: goBinary,
      args,
      env,
      outputFilename,
      planSha512,
      casOutputPath,
      abiMagic: B8G_ABI_MAGIC_V3,
    });

    steps.push(step);
    byTarget[spec.target] = step;
  }

  return Object.freeze({
    repo,
    toolchain: 'go',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    pkg,
    cgoEnabled: false,
    deterministic: true,
    targets: Object.freeze(targets),
    steps: Object.freeze(steps),
    byTarget: Object.freeze(byTarget),
  });
}

// ============================================================================
// 3. Dart Toolchain Plan (`awesome-os/dart`)
// ============================================================================

export interface BuildDartToolchainPlanOptions {
  /** Dart entrypoint source path (default: `'bin/main.dart'`). */
  readonly entrypoint?: string;
  /** Repository identifier (default: `'awesome-os/dart'`). */
  readonly repo?: string;
  /** Target subset (default: `['aot-exe', 'wasm-gc', 'jit-snapshot']`). */
  readonly targets?: readonly DartToolchainTarget[];
  /** Base output filename stem (default: `'dart-artifact'`). */
  readonly outputName?: string;
  /** Compile-time `-Dkey=value` definitions sorted deterministically by key. */
  readonly defines?: Readonly<Record<string, string>>;
  /** Optimization level for `wasm-gc` (e.g. `'-O2'`, `'-O4'`; default `'-O2'`). */
  readonly wasmOptLevel?: '-O0' | '-O1' | '-O2' | '-O3' | '-O4';
  /** Additional flags forwarded to `dart compile <subcommand>`. */
  readonly extraArgs?: readonly string[];
  /** Optional content digest seed for deterministic CAS output path derivation. */
  readonly sourceDigest?: string;
  /** Dart binary shim name (default: `'dart'`). */
  readonly dartBinary?: string;
}

export interface DartTargetBuildStep {
  readonly target: DartToolchainTarget;
  readonly subcommand: DartTargetSpec['subcommand'];
  readonly executable: boolean;
  readonly artifactKind: HoloLockfileNodeKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly outputFilename: string;
  readonly planSha512: string;
  readonly casOutputPath: string;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
}

export interface DartToolchainPlan {
  readonly repo: string;
  readonly toolchain: 'dart';
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
  readonly casLayout: typeof CAS_V11_VERSION;
  readonly entrypoint: string;
  readonly targets: readonly DartToolchainTarget[];
  readonly steps: readonly DartTargetBuildStep[];
  readonly byTarget: Readonly<Partial<Record<DartToolchainTarget, DartTargetBuildStep>>>;
}

/**
 * Builds a deterministic `awesome-os/dart` compilation plan supporting `aot-exe`,
 * `wasm-gc`, and `jit-snapshot` targets with canonical `v11/files/00..ff/<sha512>`
 * CAS output paths.
 */
export function buildDartToolchainPlan(
  opts: BuildDartToolchainPlanOptions = {},
): DartToolchainPlan {
  const repo = opts.repo ?? DART_TOOLCHAIN_REPO;
  const entrypoint = opts.entrypoint ?? 'bin/main.dart';
  const outputName = opts.outputName ?? 'dart-artifact';
  const dartBinary = opts.dartBinary ?? 'dart';
  const wasmOptLevel = opts.wasmOptLevel ?? '-O2';
  const extraArgs = opts.extraArgs ?? [];
  const targets: readonly DartToolchainTarget[] = opts.targets
    ? [...opts.targets]
    : [...DART_TOOLCHAIN_TARGETS];

  const sortedDefineFlags: string[] = [];
  if (opts.defines) {
    for (const key of Object.keys(opts.defines).sort()) {
      sortedDefineFlags.push(`-D${key}=${opts.defines[key]}`);
    }
  }

  const steps: DartTargetBuildStep[] = [];
  const byTarget: Partial<Record<DartToolchainTarget, DartTargetBuildStep>> = {};

  for (const target of targets) {
    const spec = DART_TARGET_SPECS[target];
    if (!spec) {
      throw new Error(`Unsupported Dart toolchain target: "${String(target)}"`);
    }

    const outputFilename = `${outputName}-${spec.target}${spec.ext}`;
    const targetSpecificFlags = spec.target === 'wasm-gc' ? [wasmOptLevel] : [];
    const args = Object.freeze([
      'compile',
      spec.subcommand,
      ...targetSpecificFlags,
      ...sortedDefineFlags,
      ...extraArgs,
      entrypoint,
      '-o',
      outputFilename,
    ]);

    const planFingerprint = JSON.stringify({
      abiMagic: B8G_ABI_MAGIC_V3,
      repo,
      toolchain: 'dart',
      target: spec.target,
      args,
      sourceDigest: opts.sourceDigest ?? '',
    });
    const planSha512 = sha512Hex(planFingerprint);
    const casOutputPath = formatV11RelativeBlobPath(planSha512, spec.executable);

    const step: DartTargetBuildStep = Object.freeze({
      target: spec.target,
      subcommand: spec.subcommand,
      executable: spec.executable,
      artifactKind: spec.artifactKind,
      command: dartBinary,
      args,
      outputFilename,
      planSha512,
      casOutputPath,
      abiMagic: B8G_ABI_MAGIC_V3,
    });

    steps.push(step);
    byTarget[spec.target] = step;
  }

  return Object.freeze({
    repo,
    toolchain: 'dart',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: CAS_V11_VERSION,
    entrypoint,
    targets: Object.freeze(targets),
    steps: Object.freeze(steps),
    byTarget: Object.freeze(byTarget),
  });
}

// ============================================================================
// 4. Live CasV11Store Artifact Ingestion & Verified Lockfile Node Emission
// ============================================================================

export interface IngestToolchainArtifactMeta {
  readonly id: string;
  readonly repo: string;
  readonly kind: HoloLockfileNodeKind;
  readonly target: string;
  readonly version?: string;
  readonly executable?: boolean;
  readonly url?: string;
}

export interface HoloToolchainLockfileNode {
  readonly id: string;
  readonly repo: string;
  readonly kind: HoloLockfileNodeKind;
  readonly version: string;
  readonly target: string;
  readonly sha512: string;
  readonly size: number;
  readonly executable: boolean;
  readonly blob: string;
  readonly blobPath: string;
  readonly storePath: string;
  readonly deduplicated: boolean;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
  readonly url?: string;
  readonly dependencies: readonly [];
}

const CAS_V11_NATIVE_KINDS = new Set<string>([
  'b8p',
  'npm',
  'cargo',
  'ghost',
  'object',
  'sidecar',
]);

function toCasV11BlobKind(kind: HoloLockfileNodeKind): CasV11BlobKind {
  if (CAS_V11_NATIVE_KINDS.has(kind)) {
    return kind as CasV11BlobKind;
  }
  return 'object';
}

/**
 * Ingests a compiled Go or Dart toolchain artifact into `CasV11Store`, verifies
 * its on-disk SHA-512 round-trip integrity, and returns a `holo-compiler-lockfile.json`-
 * compatible node `{ id, repo, kind, target, sha512, size, blobPath, abiMagic }`.
 */
export function ingestToolchainArtifactToCasV11(
  store: CasV11Store,
  data: Uint8Array | string,
  meta: IngestToolchainArtifactMeta,
): HoloToolchainLockfileNode {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const expectedSha512 = sha512Hex(bytes);
  const executable = meta.executable ?? meta.kind === 'bin';
  const version = meta.version ?? '0.0.0';

  const putResult = store.putBlob(bytes, {
    kind: toCasV11BlobKind(meta.kind),
    executable,
    meta: {
      id: meta.id,
      repo: meta.repo,
      kind: meta.kind,
      target: meta.target,
      version,
      abiMagic: B8G_ABI_MAGIC_V3,
    },
  });

  if (putResult.sha512 !== expectedSha512) {
    throw new Error(
      `CAS v11 digest mismatch on ingest for "${meta.id}": expected ${expectedSha512}, got ${putResult.sha512}`,
    );
  }

  const persisted = store.getBlob(putResult.sha512, executable);
  if (persisted === null) {
    throw new Error(
      `CAS v11 verification failed: blob missing immediately after ingest at ${putResult.path}`,
    );
  }

  const verifiedSha512 = sha512Hex(persisted);
  if (verifiedSha512 !== expectedSha512 || persisted.byteLength !== bytes.byteLength) {
    throw new Error(
      `CAS v11 round-trip verification failed for "${meta.id}": digest or byte length mismatch`,
    );
  }

  const blobPath = formatV11RelativeBlobPath(putResult.sha512, executable);

  return Object.freeze({
    id: meta.id,
    repo: meta.repo,
    kind: meta.kind,
    version,
    target: meta.target,
    sha512: putResult.sha512,
    size: putResult.size,
    executable,
    blob: blobPath,
    blobPath,
    storePath: putResult.path,
    deduplicated: putResult.deduplicated,
    abiMagic: B8G_ABI_MAGIC_V3,
    ...(meta.url ? { url: meta.url } : {}),
    dependencies: Object.freeze([]),
  });
}
