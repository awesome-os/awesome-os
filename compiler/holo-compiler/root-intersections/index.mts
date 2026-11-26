/**
 * @file intersections/holo-compiler/index.mts
 * @description Official `Holo` (`holo-compiler`) universal holonomic compiler intersection.
 *
 * Unites:
 *   1. StealifyLang 7-Tuple Execution Context Algebra + zero-AST lowering
 *   2. `b8g-build` hermetic `.b8p` CAS key derivation + Single-Build Prod/DevOps Split-Sidecar
 *   3. `lumiBERT` 1:1 error-to-solution resolution via `intersections/b8g-devops-harness`
 *   4. Pure Web Streams (`ReadableStream` -> `TransformStream` -> `createPersonaTee` -> `WritableStream`)
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies.
 */

import {
  checkAdmissibility,
  createContextGateTransform,
  createFrameCollector,
  createFrameSource,
  createPersonaTee,
  defineSection,
  f,
  s,
  type AdmissibilityResult,
  type ExecutionContext,
  type PersonaPlane,
  type StreamFrame,
} from '../../packages/@awesome-os/stealify-schema/src/index.mts';
import {
  TOOLCHAIN_BACKENDS,
  buildSingleSplitArtifact,
  checkAbiCompat,
  computeHermeticCasKey,
  lookupDebugSymbol,
  sha256Hex,
  type DebugSidecar,
  type DebugSymbolEntry,
  type ProductionArtifact,
  type ToolchainBackendDescriptor,
  type ToolchainKind,
} from '../../b8g-build/src/index.mts';
import {
  defaultDevOpsHarness,
  resolveError1To1,
  type ResolveErrorOptions,
  type ResolveErrorResult,
} from '../b8g-devops-harness/index.mts';

// ============================================================================
// 1. Declarative StealifyLang Section Contract
// ============================================================================

export const HOLO_COMPILER_CONTEXT: ExecutionContext = Object.freeze({
  boundary: 'in-process',
  display: 'headless',
  lifetime: 'oneshot',
  transport: 'arena-sab',
  capability: Object.freeze({
    tenantId: 'local-user',
    scopes: Object.freeze(['holo.compile', 'devops.observe']),
    epoch: 1,
    privateData: false,
  }),
  locality: 'local-arena',
  persona: 'creator',
});

export const HoloCompilerSection = defineSection({
  id: 'b8g/holo-compiler',
  version: '1.0.0',
  substrate: s.sabRing({ ringBytes: 65536 }),
  context: HOLO_COMPILER_CONTEXT,
  fields: {
    holoCompiledUnits: f.int32().default(0),
    holoCacheHits: f.int32().default(0),
    holoCacheMisses: f.int32().default(0),
    holoConsumerDebugBytes: f.int32().default(0),
    holoSidecarsEmitted: f.int32().default(0),
    holoLastCasKey: f.string({ maxBytes: 64 }).default(''),
    holoLastBuildId: f.string({ maxBytes: 32 }).default(''),
    holoLastCompileMs: f.float64().default(0),
  },
});

export const HOLO_COMPILER_VERSION = 'holo-1.0.0';

// ============================================================================
// 2. Compile Unit & Output Frame Contracts
// ============================================================================

export interface HoloCompileUnit {
  readonly unitId: string;
  readonly toolchain: ToolchainKind;
  readonly source: string;
  readonly flags: readonly string[];
  readonly schemaHash: string;
  readonly abiVersion: number;
  readonly targetTriple?: string;
  readonly depDigests?: readonly string[];
  readonly compilerVersion?: string;
}

export interface HoloProductionOutput {
  readonly kind: 'production';
  readonly unitId: string;
  readonly casKey: string;
  readonly toolchain: ToolchainKind;
  readonly targetTriple: string;
  readonly loweredByteLength: number;
  readonly consumerDebugBytes: 0;
  readonly productionArtifact: ProductionArtifact;
}

export interface HoloDebugSidecarOutput {
  readonly kind: 'debug-sidecar';
  readonly unitId: string;
  readonly casKey: string;
  readonly buildId: string;
  readonly sidecarFilename: string;
  readonly debugSidecar: DebugSidecar;
}

export type HoloCompileOutput = HoloProductionOutput | HoloDebugSidecarOutput;

export interface HoloPipelineResult {
  readonly persona: PersonaPlane;
  readonly devopsTeed: boolean;
  readonly admissibility: AdmissibilityResult;
  readonly consumerFrames: readonly StreamFrame<HoloProductionOutput>[];
  readonly devopsFrames: readonly StreamFrame<HoloDebugSidecarOutput>[];
  readonly productionArtifacts: readonly ProductionArtifact[];
  readonly debugSidecars: readonly DebugSidecar[];
  readonly consumerDebugBytes: number;
  readonly casKeys: readonly string[];
}

// ============================================================================
// 3. Zero-AST Single-Pass Lowering Helpers
// ============================================================================

const TEXT_ENCODER = new TextEncoder();

const SYMBOL_DECL_PATTERNS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  /^\s*(?:static\s+|inline\s+|extern\s+)*(?:void|int|uint32_t|int32_t|size_t|float|double|char\s*\*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/,
];

function parseSchemaHashToU64(schemaHash: string): bigint {
  const trimmed = schemaHash.trim();
  if (/^0x[0-9a-fA-F]{1,16}$/.test(trimmed)) {
    return BigInt.asUintN(64, BigInt(trimmed));
  }
  if (/^[0-9a-fA-F]{1,16}$/.test(trimmed)) {
    return BigInt.asUintN(64, BigInt(`0x${trimmed}`));
  }
  const digest = sha256Hex(trimmed).slice(0, 16);
  return BigInt.asUintN(64, BigInt(`0x${digest}`));
}

interface ZeroAstLoweringResult {
  readonly loweredBytes: Uint8Array;
  readonly symbols: Readonly<Record<string, DebugSymbolEntry>>;
}

/**
 * Deterministic StealifyLang zero-AST single-pass lowering:
 * strips comments and empty lines while extracting symbol table entries for
 * the `.debug.b8p` sidecar without allocating an AST.
 */
function lowerSourceZeroAst(unit: HoloCompileUnit): ZeroAstLoweringResult {
  const lines = unit.source.split(/\r?\n/);
  const loweredLines: string[] = [];
  const symbols: Record<string, DebugSymbolEntry> = {};
  let symbolIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) {
      continue;
    }

    for (const pattern of SYMBOL_DECL_PATTERNS) {
      const match = pattern.exec(rawLine);
      if (match && match[1]) {
        const addr = `0x${(0x1000 + symbolIndex * 0x40).toString(16)}`;
        symbols[addr] = {
          symbol: match[1],
          file: `${unit.unitId}${TOOLCHAIN_BACKENDS[unit.toolchain].sourceExtensions[0] ?? '.src'}`,
          line: i + 1,
        };
        symbolIndex += 1;
        break;
      }
    }

    loweredLines.push(trimmed);
  }

  if (symbolIndex === 0) {
    symbols['0x1000'] = {
      symbol: `${unit.unitId}__entry`,
      file: `${unit.unitId}${TOOLCHAIN_BACKENDS[unit.toolchain].sourceExtensions[0] ?? '.src'}`,
      line: 1,
    };
  }

  const canonicalLowered = [
    `HOLO_IR_V1:${unit.toolchain}:${unit.unitId}`,
    ...loweredLines,
  ].join('\n');

  return {
    loweredBytes: TEXT_ENCODER.encode(canonicalLowered),
    symbols,
  };
}

// ============================================================================
// 4. Pure Web Streams Transform & Pipeline
// ============================================================================

/**
 * Pure Web `TransformStream` that lowers each `HoloCompileUnit` frame,
 * computes its deterministic hermetic `.b8p` CAS key (`computeHermeticCasKey`),
 * and emits a Single-Build Split-Sidecar pair (`buildSingleSplitArtifact`):
 *   - Production frame (`minPersona: 'consumer'`, `consumerDebugBytes: 0`)
 *   - Debug sidecar frame (`minPersona: 'devops'`, `.debug.b8p` symbol map)
 */
export function createHoloCompileTransform(): TransformStream<
  StreamFrame<HoloCompileUnit>,
  StreamFrame<HoloCompileOutput>
> {
  return new TransformStream<
    StreamFrame<HoloCompileUnit>,
    StreamFrame<HoloCompileOutput>
  >({
    transform(frame, controller) {
      const unit = frame.payload;
      const backend = TOOLCHAIN_BACKENDS[unit.toolchain];
      const targetTriple = unit.targetTriple ?? backend.defaultTarget;
      const compilerVersion = unit.compilerVersion ?? HOLO_COMPILER_VERSION;
      const sourceDigest = sha256Hex(unit.source);

      const casKey = computeHermeticCasKey({
        toolchain: unit.toolchain,
        compilerVersion,
        targetTriple,
        flags: unit.flags,
        sourceDigest,
        depDigests: unit.depDigests ?? [],
        schemaHash: unit.schemaHash,
      });

      const { loweredBytes, symbols } = lowerSourceZeroAst(unit);
      const schemaHashU64 = parseSchemaHashToU64(unit.schemaHash);

      const { productionArtifact, debugSidecar } = buildSingleSplitArtifact({
        toolchain: unit.toolchain,
        targetTriple,
        abiVersion: unit.abiVersion,
        schemaHash: schemaHashU64,
        payload: loweredBytes,
        symbols,
      });

      const ts = Date.now();

      controller.enqueue({
        kind: 'data',
        source: HoloCompilerSection.id,
        minPersona: 'consumer',
        ts,
        payload: {
          kind: 'production',
          unitId: unit.unitId,
          casKey,
          toolchain: unit.toolchain,
          targetTriple,
          loweredByteLength: loweredBytes.byteLength,
          consumerDebugBytes: productionArtifact.consumerDebugBytes,
          productionArtifact,
        },
      });

      controller.enqueue({
        kind: 'metric',
        source: HoloCompilerSection.id,
        minPersona: 'devops',
        ts,
        payload: {
          kind: 'debug-sidecar',
          unitId: unit.unitId,
          casKey,
          buildId: debugSidecar.buildId,
          sidecarFilename: `${unit.unitId}.${debugSidecar.buildId}.debug.b8p`,
          debugSidecar,
        },
      });
    },
  });
}

/**
 * Executes the full Web Streams Holo compilation pipeline:
 *   `createFrameSource`
 *     -> `createContextGateTransform`
 *     -> `createHoloCompileTransform`
 *     -> `createPersonaTee`
 *     -> `createFrameCollector`
 *
 * Consumer callers receive stripped production artifacts (`consumerDebugBytes: 0`,
 * `devopsTeed: false`). DevOps / kernel-audit callers additionally receive
 * bit-exact `.debug.b8p` sidecars on the teed DevOps branch (`devopsTeed: true`).
 */
export async function runHoloPipeline(
  units: readonly HoloCompileUnit[],
  callerCtx: ExecutionContext,
): Promise<HoloPipelineResult> {
  const persona: PersonaPlane = callerCtx.persona ?? 'consumer';
  const admissibility = checkAdmissibility(HoloCompilerSection.context, callerCtx);

  const inputFrames: StreamFrame<HoloCompileUnit>[] = units.map((unit) => ({
    kind: 'data',
    source: 'holo-compiler/input',
    minPersona: 'consumer',
    payload: unit,
    ts: Date.now(),
  }));

  const compiledStream = createFrameSource(inputFrames)
    .pipeThrough(createContextGateTransform(HoloCompilerSection.context, callerCtx))
    .pipeThrough(createHoloCompileTransform());

  const tee = createPersonaTee(compiledStream, callerCtx);
  const devopsTeed = tee.devops !== null;

  const consumerCollector = createFrameCollector<HoloCompileOutput>();
  const pipePromises: Promise<void>[] = [
    tee.consumer.pipeTo(consumerCollector.writable),
  ];

  let devopsCollector: ReturnType<typeof createFrameCollector<HoloCompileOutput>> | null = null;
  if (tee.devops !== null) {
    devopsCollector = createFrameCollector<HoloCompileOutput>();
    pipePromises.push(tee.devops.pipeTo(devopsCollector.writable));
  }

  await Promise.all(pipePromises);

  const rawConsumerFrames = await consumerCollector.done;
  const rawDevopsFrames = devopsCollector ? await devopsCollector.done : [];

  const consumerFrames = rawConsumerFrames.filter(
    (frame): frame is StreamFrame<HoloProductionOutput> =>
      frame.payload.kind === 'production',
  );

  const devopsFrames = rawDevopsFrames.filter(
    (frame): frame is StreamFrame<HoloDebugSidecarOutput> =>
      frame.payload.kind === 'debug-sidecar',
  );

  const productionArtifacts = consumerFrames.map((f) => f.payload.productionArtifact);
  const debugSidecars = devopsFrames.map((f) => f.payload.debugSidecar);
  const casKeys = consumerFrames.map((f) => f.payload.casKey);
  const consumerDebugBytes = productionArtifacts.reduce(
    (sum, artifact) => sum + artifact.consumerDebugBytes,
    0,
  );

  return Object.freeze({
    persona,
    devopsTeed,
    admissibility,
    consumerFrames: Object.freeze(consumerFrames),
    devopsFrames: Object.freeze(devopsFrames),
    productionArtifacts: Object.freeze(productionArtifacts),
    debugSidecars: Object.freeze(debugSidecars),
    consumerDebugBytes,
    casKeys: Object.freeze(casKeys),
  });
}

// ============================================================================
// 5. Backends, ABI Helpers & lumiBERT 1:1 Error Resolution
// ============================================================================

export function listHoloBackends(): readonly ToolchainBackendDescriptor[] {
  return Object.freeze(Object.values(TOOLCHAIN_BACKENDS));
}

export function resolveHoloError(
  rawError: string,
  opts?: ResolveErrorOptions,
): ResolveErrorResult {
  return resolveError1To1(rawError, opts);
}

export {
  TOOLCHAIN_BACKENDS,
  checkAbiCompat,
  computeHermeticCasKey,
  defaultDevOpsHarness,
  lookupDebugSymbol,
  type DebugSidecar,
  type DebugSymbolEntry,
  type ProductionArtifact,
  type ResolveErrorOptions,
  type ResolveErrorResult,
  type ToolchainBackendDescriptor,
  type ToolchainKind,
};

// ============================================================================
// 6. Unified Multi-Language Sub-TU Splicer, Effect System & Resident Pipe Daemon
// ============================================================================

export {
  B8G_SPLICE_MAGIC,
  DEFAULT_SUB_TU_TARGETS,
  SubTuCasIndex,
  computeSplicePlan,
  computeSubTuCasKey,
  decodeSplicedModule,
  spliceModule,
  splitModuleItems,
  type CompileItemFn,
  type DecodedSplicedModule,
  type SplicePlan,
  type SplicePlanOptions,
  type SpliceResult,
  type SplicedChunkEntry,
  type SubTuCachedChunk,
  type SubTuCasIndexOptions,
  type SubTuCasKey,
  type SubTuCasStats,
  type SubTuChunkMetadata,
  type SubTuCompileContext,
  type SubTuDirtyReason,
  type SubTuItem,
  type SubTuItemKind,
  type SubTuToolchain,
} from './sub-tu-splicer.mts';

export {
  ALL_EFFECTS_MASK,
  EffectBit,
  checkModuleEffects,
  effectMaskToNames,
  effectMaskToU64,
  executionContextToAllowedEffects,
  extractDeclaredEffects,
  namesToEffectMask,
  u64ToEffectMask,
  type EffectAnnotation,
  type EffectBitKey,
  type EffectDiagnostic,
  type EffectDiagnosticCode,
  type EffectHandlerBinding,
  type EffectMask,
  type EffectModuleUnit,
  type EffectName,
  type EffectToolchainKind,
  type ExtractedEffects,
  type InferredEffectHit,
  type ModuleEffectCheckResult,
  type UnitEffectSummary,
} from './effect-system.mts';

export {
  B8G_ABI_MAGIC_V3,
  B8G_ARENA_V1_VERSION,
  B8G_HOLO_ARENA_ALIGNMENT,
  B8G_HOLO_ARENA_HEADER,
  B8G_HOLO_ARENA_HEADER_BYTES,
  HOLO_ARENA_FLAGS,
  HOLO_DAEMON_COMPILER_VERSION,
  HOLO_DAEMON_TOOLCHAINS,
  HOLO_TOOLCHAIN_IDS,
  HoloDaemonClient,
  alignTo64,
  decodeHoloArenaFrame,
  defaultHoloPipePath,
  encodeHoloArenaFrame,
  startHoloDaemon,
  type HoloArenaFrame,
  type HoloArenaFrameInput,
  type HoloDaemonClientOptions,
  type HoloDaemonCompileHookOutput,
  type HoloDaemonCompileParams,
  type HoloDaemonCompileResult,
  type HoloDaemonFlushResult,
  type HoloDaemonHandle,
  type HoloDaemonMethod,
  type HoloDaemonOptions,
  type HoloDaemonPingResult,
  type HoloDaemonRequestEnvelope,
  type HoloDaemonResponseEnvelope,
  type HoloDaemonShutdownResult,
  type HoloDaemonStats,
  type HoloDaemonToolchain,
  type HoloToolchainSessionStats,
} from './daemon.mts';

export {
  CAS_V11_VERSION,
  CasV11Store,
  casBlobPath,
  resolveUnifiedCasRoot,
  sha512Hex,
  type CasV11BlobKind,
  type CasV11BlobMeta,
  type CasV11LinkResult,
  type CasV11PutOptions,
  type CasV11PutResult,
  type CasV11Stats,
  type CasV11StoreOptions,
} from './cas-v11-store.mts';

export {
  B8G_ABI_MAGIC_V3_HEX,
  B8G_EXE_FOOTER_BYTES,
  B8G_EXE_FOOTER_MAGIC,
  buildStandaloneFooter,
  compileToExecutable,
  parseStandaloneFooter,
  type CompileToExecutableOptions,
  type CompileToExecutableResult,
  type HoloExeMode,
  type ParsedStandaloneFooter,
} from './compile-exe.mts';

export {
  HOLO_LOCKFILE_FILENAME,
  HOLO_LOCKFILE_SCHEMA,
  formatV11RelativeBlobPath,
  generateHoloLockfile,
  hydrateFromLockfile,
  readHoloLockfile,
  verifyHoloLockfile,
  walkLockfileBottomUp,
  writeHoloLockfile,
  type GenerateHoloLockfileOptions,
  type HoloCompilerLockfile,
  type HoloLockfileNode,
  type HoloLockfileNodeInput,
  type HoloLockfileNodeKind,
  type HydratedLockfileEntry,
  type LockfileHydrationResult,
  type LockfileVerificationIssue,
  type LockfileVerificationResult,
} from './lockfile.mts';

// ============================================================================
// 7. Opinionated Full-Suite Build Policy (Chrome-style `--disable-*` Opt-Outs)
// ============================================================================

export const HOLO_FIVE_TARGETS = Object.freeze([
  'x86_64-windows-gnu',
  'x86_64-linux-musl',
  'aarch64-linux-musl',
  'aarch64-macos',
  'wasm32-wasi',
] as const);

export type HoloCrossTarget = (typeof HOLO_FIVE_TARGETS)[number];

export interface HoloBuildPolicy {
  readonly crossCompileAll5: boolean;
  readonly targets: readonly string[];
  readonly subTuSplice: boolean;
  readonly effectGate: boolean;
  readonly emitCasV11: boolean;
  readonly emitPnpmPackage: boolean;
  readonly emitDebugSidecar: boolean;
  readonly useResidentDaemon: boolean;
}

export const DEFAULT_HOLO_BUILD_POLICY: HoloBuildPolicy = Object.freeze({
  crossCompileAll5: true,
  targets: HOLO_FIVE_TARGETS,
  subTuSplice: true,
  effectGate: true,
  emitCasV11: true,
  emitPnpmPackage: true,
  emitDebugSidecar: true,
  useResidentDaemon: true,
});

/**
 * Resolves the opinionated `holo-compiler` build policy.
 * By default, ALL 5 targets + sub-TU splicing + effect gating + `v11/files/XX/` CAS +
 * pnpm-packageable manifest + `.debug.b8p` sidecar + resident pipe daemon are ON.
 * Pass Chrome-style `--disable-*` flags to opt out of individual stages.
 */
export function resolveHoloBuildPolicy(
  argv: readonly string[] = [],
  hostTarget: string = 'x86_64-windows-gnu',
): HoloBuildPolicy {
  const flags = new Set(argv);
  const crossCompileAll5 = !flags.has('--disable-cross');
  return Object.freeze({
    crossCompileAll5,
    targets: crossCompileAll5 ? HOLO_FIVE_TARGETS : Object.freeze([hostTarget]),
    subTuSplice: !flags.has('--disable-splice'),
    effectGate: !flags.has('--disable-effects'),
    emitCasV11: !flags.has('--disable-cas-v11'),
    emitPnpmPackage: !flags.has('--disable-pnpm-pack'),
    emitDebugSidecar: !flags.has('--disable-sidecar'),
    useResidentDaemon: !flags.has('--disable-daemon'),
  });
}
