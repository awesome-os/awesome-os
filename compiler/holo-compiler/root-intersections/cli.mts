#!/usr/bin/env node
/**
 * @file intersections/holo-compiler/cli.mts
 * @description Zero-dependency CLI for `intersections/holo-compiler`.
 *
 * Usage:
 *   .\bin\node.ps1 intersections/holo-compiler/cli.mts backends [--json]
 *   .\bin\node.ps1 intersections/holo-compiler/cli.mts verify [--json]
 *   .\bin\node.ps1 intersections/holo-compiler/cli.mts compile [--persona consumer|devops] [--cas-v11] [--cas-root <dir>] [--json]
 *   .\bin\node.ps1 intersections/holo-compiler/cli.mts compile-demo [--persona consumer|devops] [--cas-v11] [--cas-root <dir>] [--json]
 *   .\bin\node.ps1 intersections/holo-compiler/cli.mts emit-v11 [--persona consumer|devops] [--cas-root <dir>] [--json]
 *   .\bin\node.ps1 intersections/holo-compiler/cli.mts resolve-error "<err>" [--json]
 *
 * Strictly `erasableSyntaxOnly: true`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  checkAdmissibility,
  type ExecutionContext,
  type PersonaPlane,
} from '../../packages/@awesome-os/stealify-schema/src/index.mts';
import {
  HOLO_COMPILER_CONTEXT,
  HoloCompilerSection,
  checkModuleEffects,
  listHoloBackends,
  lookupDebugSymbol,
  resolveHoloError,
  runHoloPipeline,
  splitModuleItems,
  type EffectModuleUnit,
  type HoloCompileUnit,
  type HoloDebugSidecarOutput,
  type ProductionArtifact,
} from './index.mts';

const DEMO_UNITS: readonly HoloCompileUnit[] = Object.freeze([
  {
    unitId: 'kernel_math',
    toolchain: 'cxx',
    source: [
      '// Hermetic C11 microkernel math unit',
      'int add_u32(int a, int b) { return a + b; }',
      'int mul_u32(int a, int b) { return a * b; }',
    ].join('\n'),
    flags: ['-std=c11', '-O2', '-Wall'],
    schemaHash: '0x00000000b8g00001',
    abiVersion: 3,
  },
  {
    unitId: 'arena_codec',
    toolchain: 'wasi',
    source: [
      '// WASI portable arena codec',
      'pub fn encode_frame(len: u32) -> u32 { len + 32 }',
    ].join('\n'),
    flags: ['-O2', '-target', 'wasm32-wasi'],
    schemaHash: '0x00000000b8g00002',
    abiVersion: 3,
  },
]);

function makeCallerContext(persona: PersonaPlane): ExecutionContext {
  return Object.freeze({
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
    persona,
  });
}

const TEXT_ENCODER = new TextEncoder();

export interface V11CasLayout {
  readonly casRoot: string;
  readonly v11Root: string;
  readonly filesDir: string;
  readonly tmpDir: string;
}

export interface V11BlobRecord {
  readonly unitId: string;
  readonly kind: 'production' | 'debug-sidecar';
  readonly sha512: string;
  readonly blobPath: string;
  readonly bytes: number;
  readonly deduplicated: boolean;
}

export interface V11EmitReport {
  readonly mode: 'v11';
  readonly persona: PersonaPlane;
  readonly devopsTeed: boolean;
  readonly admissible: boolean;
  readonly casRoot: string;
  readonly v11Root: string;
  readonly consumerDebugBytes: number;
  readonly casKeys: readonly string[];
  readonly v11Blobs: readonly V11BlobRecord[];
  readonly effects: {
    readonly ok: boolean;
    readonly allowedEffects: readonly string[];
    readonly diagnosticCount: number;
  };
  readonly subTu: ReadonlyArray<{
    readonly unitId: string;
    readonly toolchain: string;
    readonly itemCount: number;
    readonly items: ReadonlyArray<{
      readonly name: string;
      readonly kind: string;
      readonly itemHash: string;
      readonly sigHash: string;
    }>;
  }>;
}

export function resolveV11CasLayout(explicitCasRoot?: string): V11CasLayout {
  const rawBase =
    explicitCasRoot && explicitCasRoot.trim().length > 0
      ? explicitCasRoot.trim()
      : process.env.B8G_CAS_DIR && process.env.B8G_CAS_DIR.trim().length > 0
        ? process.env.B8G_CAS_DIR.trim()
        : join(homedir(), '.b8g/cas');

  const resolved = resolve(rawBase);
  const endsWithV11 = basename(resolved).toLowerCase() === 'v11';
  const casRoot = endsWithV11 ? dirname(resolved) : resolved;
  const v11Root = endsWithV11 ? resolved : join(resolved, 'v11');

  return Object.freeze({
    casRoot,
    v11Root,
    filesDir: join(v11Root, 'files'),
    tmpDir: join(v11Root, 'tmp'),
  });
}

function serializeProductionArtifact(artifact: ProductionArtifact): Uint8Array {
  const out = new Uint8Array(
    artifact.abiHeaderBytes.byteLength + artifact.payload.byteLength,
  );
  out.set(artifact.abiHeaderBytes, 0);
  out.set(artifact.payload, artifact.abiHeaderBytes.byteLength);
  return out;
}

function serializeDebugSidecar(sidecarOutput: HoloDebugSidecarOutput): Uint8Array {
  const canonical = JSON.stringify({
    format: 'b8g.debug.sidecar.v1',
    unitId: sidecarOutput.unitId,
    casKey: sidecarOutput.casKey,
    sidecarFilename: sidecarOutput.sidecarFilename,
    persona: sidecarOutput.debugSidecar.persona,
    buildId: sidecarOutput.debugSidecar.buildId,
    toolchain: sidecarOutput.debugSidecar.toolchain,
    targetTriple: sidecarOutput.debugSidecar.targetTriple,
    sidecarSha256: sidecarOutput.debugSidecar.sidecarSha256,
    symbols: sidecarOutput.debugSidecar.symbols,
  });
  return TEXT_ENCODER.encode(canonical);
}

function writeV11BlobAtomic(
  layout: V11CasLayout,
  unitId: string,
  kind: 'production' | 'debug-sidecar',
  data: Uint8Array,
): V11BlobRecord {
  const sha512 = createHash('sha512').update(data).digest('hex');
  const prefix = sha512.slice(0, 2);
  const bucketDir = join(layout.filesDir, prefix);
  const blobPath = join(bucketDir, sha512);

  mkdirSync(layout.tmpDir, { recursive: true });
  mkdirSync(bucketDir, { recursive: true });

  if (existsSync(blobPath)) {
    return Object.freeze({
      unitId,
      kind,
      sha512,
      blobPath,
      bytes: data.byteLength,
      deduplicated: true,
    });
  }

  const tmpPath = join(
    layout.tmpDir,
    `${sha512.slice(0, 16)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let deduplicated = false;
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, blobPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
    }
    if (existsSync(blobPath)) {
      deduplicated = true;
    } else {
      throw err;
    }
  }

  return Object.freeze({
    unitId,
    kind,
    sha512,
    blobPath,
    bytes: data.byteLength,
    deduplicated,
  });
}

export async function runEmitV11(
  units: readonly HoloCompileUnit[],
  persona: PersonaPlane,
  explicitCasRoot?: string,
): Promise<{ readonly exitCode: number; readonly report: V11EmitReport }> {
  const callerCtx = makeCallerContext(persona);
  const layout = resolveV11CasLayout(explicitCasRoot);

  const effectUnits: EffectModuleUnit[] = units.map((u) => ({
    unitId: u.unitId,
    toolchain: u.toolchain,
    source: u.source,
  }));
  const effectCheck = checkModuleEffects(effectUnits, callerCtx);

  const subTu = units.map((u) => {
    const items = splitModuleItems(u.toolchain, u.source);
    return {
      unitId: u.unitId,
      toolchain: u.toolchain,
      itemCount: items.length,
      items: items.map((item) => ({
        name: item.name,
        kind: item.kind,
        itemHash: item.itemHash,
        sigHash: item.sigHash,
      })),
    };
  });

  const result = await runHoloPipeline(units, callerCtx);
  const v11Blobs: V11BlobRecord[] = [];

  if (effectCheck.ok) {
    for (const frame of result.consumerFrames) {
      const prodBytes = serializeProductionArtifact(frame.payload.productionArtifact);
      v11Blobs.push(
        writeV11BlobAtomic(layout, frame.payload.unitId, 'production', prodBytes),
      );
    }

    for (const frame of result.devopsFrames) {
      const sidecarBytes = serializeDebugSidecar(frame.payload);
      v11Blobs.push(
        writeV11BlobAtomic(layout, frame.payload.unitId, 'debug-sidecar', sidecarBytes),
      );
    }
  }

  const report: V11EmitReport = {
    mode: 'v11',
    persona: result.persona,
    devopsTeed: result.devopsTeed,
    admissible: result.admissibility.admissible,
    casRoot: layout.casRoot,
    v11Root: layout.v11Root,
    consumerDebugBytes: result.consumerDebugBytes,
    casKeys: result.casKeys,
    v11Blobs,
    effects: {
      ok: effectCheck.ok,
      allowedEffects: effectCheck.allowedEffects,
      diagnosticCount: effectCheck.diagnostics.length,
    },
    subTu,
  };

  return {
    exitCode: effectCheck.ok ? 0 : 1,
    report,
  };
}

function printHelp(): void {
  console.log(
    [
      'Usage: holo-compiler <command> [options]',
      '',
      'Commands:',
      '  backends                      List supported hermetic Holo compiler backends',
      '  verify                        Verify admissibility, split-sidecar parity, and CAS determinism',
      '  compile                       Run the Web Streams Holo pipeline (add --cas-v11 for direct v11 CAS emit)',
      '  compile-demo                  Run the Web Streams Holo pipeline on demo units',
      '  emit-v11                      Compile and emit production artifacts & .debug.b8p sidecars directly to v11/files/XX/<sha512>',
      '  resolve-error "<err>"         Resolve a compiler/build error 1:1 via lumiBERT',
      '',
      'Options:',
      '  --persona <consumer|devops>   Persona plane for compile/emit-v11 (default: devops)',
      '  --cas-v11                     Emit compiled artifacts directly into the v11 CAS layout',
      '  --cas-root <dir>              Override CAS root (default: $B8G_CAS_DIR -> <root>/v11)',
      '  --json                        Emit machine-readable JSON output',
      '  --help, -h                    Show this help message',
    ].join('\n'),
  );
}

async function runVerify(jsonMode: boolean): Promise<number> {
  const consumerCtx = makeCallerContext('consumer');
  const devopsCtx = makeCallerContext('devops');

  const creatorAdmissibility = checkAdmissibility(
    HoloCompilerSection.context,
    HOLO_COMPILER_CONTEXT,
  );
  const devopsAdmissibility = checkAdmissibility(
    HoloCompilerSection.context,
    devopsCtx,
  );

  const consumerRun = await runHoloPipeline(DEMO_UNITS, consumerCtx);
  const devopsRun = await runHoloPipeline(DEMO_UNITS, devopsCtx);
  const devopsRunRepeat = await runHoloPipeline(DEMO_UNITS, devopsCtx);

  const casDeterministic =
    devopsRun.casKeys.length === devopsRunRepeat.casKeys.length &&
    devopsRun.casKeys.every((key, idx) => key === devopsRunRepeat.casKeys[idx]);

  const buildIdsBitExact =
    devopsRun.productionArtifacts.length === devopsRun.debugSidecars.length &&
    devopsRun.productionArtifacts.every(
      (artifact, idx) => artifact.buildId === devopsRun.debugSidecars[idx]?.buildId,
    );

  const firstSidecar = devopsRun.debugSidecars[0];
  const devopsSymbolHit =
    firstSidecar !== undefined
      ? lookupDebugSymbol(firstSidecar, firstSidecar.buildId, '0x1000', 'devops')
      : { allowed: false, found: false };
  const consumerSymbolDenied =
    firstSidecar !== undefined
      ? lookupDebugSymbol(firstSidecar, firstSidecar.buildId, '0x1000', 'consumer')
      : { allowed: true, found: false };

  const checks = {
    sectionAdmissibleForCreator: creatorAdmissibility.admissible,
    sectionAdmissibleForDevOps: devopsAdmissibility.admissible,
    consumerDevopsTeedFalse: consumerRun.devopsTeed === false,
    consumerZeroDebugBytes: consumerRun.consumerDebugBytes === 0,
    consumerZeroSidecars: consumerRun.debugSidecars.length === 0,
    devopsTeedTrue: devopsRun.devopsTeed === true,
    devopsZeroConsumerDebugBytes: devopsRun.consumerDebugBytes === 0,
    devopsSidecarCountMatchesUnits: devopsRun.debugSidecars.length === DEMO_UNITS.length,
    buildIdsBitExact,
    casDeterministic,
    devopsSymbolLookupAllowed: devopsSymbolHit.allowed && devopsSymbolHit.found,
    consumerSymbolLookupDenied: !consumerSymbolDenied.allowed,
  };

  const passed = Object.values(checks).every(Boolean);
  const summary = {
    status: passed ? 'PASS' : 'FAIL',
    sectionId: HoloCompilerSection.id,
    version: HoloCompilerSection.version,
    backends: listHoloBackends().map((b) => b.kind),
    checks,
    casKeys: devopsRun.casKeys,
    buildIds: devopsRun.productionArtifacts.map((a) => a.buildId),
  };

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[HOLO VERIFY] ${summary.status} (${summary.sectionId}@${summary.version})`,
    );
    for (const [name, ok] of Object.entries(checks)) {
      console.log(`  - ${name}: ${ok ? 'PASS' : 'FAIL'}`);
    }
  }

  return passed ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let jsonMode = false;
  let casV11Mode = false;
  let casRootArg: string | undefined;
  let persona: PersonaPlane = 'devops';
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json') {
      jsonMode = true;
    } else if (arg === '--cas-v11') {
      casV11Mode = true;
    } else if (arg === '--cas-root') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        console.error('Error: --cas-root requires a directory path.');
        process.exit(1);
      }
      casRootArg = next;
      i += 1;
    } else if (arg.startsWith('--cas-root=')) {
      casRootArg = arg.slice('--cas-root='.length);
      if (!casRootArg) {
        console.error('Error: --cas-root requires a non-empty directory path.');
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--persona' || arg.startsWith('--persona=')) {
      const next = arg === '--persona' ? args[i + 1] : arg.slice('--persona='.length);
      if (
        next !== 'consumer' &&
        next !== 'creator' &&
        next !== 'devops' &&
        next !== 'kernel-audit'
      ) {
        console.error(
          'Error: --persona must be one of consumer | creator | devops | kernel-audit.',
        );
        process.exit(1);
      }
      persona = next;
      if (arg === '--persona') {
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0];
  if (!command) {
    printHelp();
    process.exit(1);
  }

  if (command === 'backends') {
    const backends = listHoloBackends();
    if (jsonMode) {
      console.log(JSON.stringify({ count: backends.length, backends }, null, 2));
    } else {
      console.log(`Holo Compiler Backends (${backends.length}):`);
      for (const b of backends) {
        console.log(
          `  - ${b.kind}: ${b.displayName} [${b.defaultTarget}] (splitSidecar=${b.supportsSplitSidecar}, wasi=${b.supportsWasi})`,
        );
      }
    }
    process.exit(0);
  }

  if (command === 'verify') {
    const code = await runVerify(jsonMode);
    process.exit(code);
  }

  if (command === 'emit-v11' || ((command === 'compile' || command === 'compile-demo') && casV11Mode)) {
    const { exitCode, report } = await runEmitV11(DEMO_UNITS, persona, casRootArg);
    console.log(JSON.stringify(report, null, 2));
    process.exit(exitCode);
  }

  if (command === 'compile' || command === 'compile-demo') {
    const result = await runHoloPipeline(DEMO_UNITS, makeCallerContext(persona));
    const report = {
      persona: result.persona,
      devopsTeed: result.devopsTeed,
      admissible: result.admissibility.admissible,
      consumerDebugBytes: result.consumerDebugBytes,
      unitsCompiled: result.productionArtifacts.length,
      sidecarsEmitted: result.debugSidecars.length,
      artifacts: result.consumerFrames.map((frame) => ({
        unitId: frame.payload.unitId,
        toolchain: frame.payload.toolchain,
        targetTriple: frame.payload.targetTriple,
        casKey: frame.payload.casKey,
        buildId: frame.payload.productionArtifact.buildId,
        consumerDebugBytes: frame.payload.consumerDebugBytes,
        payloadSha256: frame.payload.productionArtifact.payloadSha256,
      })),
      sidecars: result.devopsFrames.map((frame) => ({
        unitId: frame.payload.unitId,
        buildId: frame.payload.buildId,
        sidecarFilename: frame.payload.sidecarFilename,
        symbolCount: Object.keys(frame.payload.debugSidecar.symbols).length,
        sidecarSha256: frame.payload.debugSidecar.sidecarSha256,
      })),
    };

    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `[HOLO COMPILE-DEMO] persona=${report.persona} devopsTeed=${report.devopsTeed} units=${report.unitsCompiled} sidecars=${report.sidecarsEmitted} consumerDebugBytes=${report.consumerDebugBytes}`,
      );
      for (const art of report.artifacts) {
        console.log(
          `  - ${art.unitId} [${art.toolchain}] buildId=${art.buildId} casKey=${art.casKey.slice(0, 16)}... debugBytes=${art.consumerDebugBytes}`,
        );
      }
      for (const sc of report.sidecars) {
        console.log(
          `  + sidecar ${sc.sidecarFilename} symbols=${sc.symbolCount}`,
        );
      }
    }
    process.exit(0);
  }

  if (command === 'resolve-error') {
    const rawError = positional.slice(1).join(' ').trim();
    if (!rawError) {
      console.error('Error: resolve-error requires an "<err>" argument.');
      process.exit(1);
    }
    const resolution = resolveHoloError(rawError);
    if (jsonMode) {
      console.log(JSON.stringify(resolution, null, 2));
    } else if (resolution.status === 'AUTO_FIXED') {
      console.log(
        `[AUTO_FIXED] ${resolution.fix.id} (${resolution.fix.code}) cosine=${resolution.cosine.toFixed(4)} latency=${resolution.latencyMs.toFixed(2)}ms`,
      );
      console.log(`  Summary: ${resolution.fix.summary}`);
      for (const step of resolution.fix.resolutionSteps) {
        console.log(`  - ${step}`);
      }
    } else {
      console.log(
        `[ESCALATE_TO_LLM] cosine=${resolution.cosine.toFixed(4)} latency=${resolution.latencyMs.toFixed(2)}ms`,
      );
      console.log(`  Reason: ${resolution.reason}`);
    }
    process.exit(resolution.status === 'AUTO_FIXED' ? 0 : 2);
  }

  console.error(`Error: unknown command "${command}".`);
  printHelp();
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  await main();
}
