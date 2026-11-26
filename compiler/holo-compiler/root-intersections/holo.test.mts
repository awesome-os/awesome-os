/**
 * @file intersections/holo-compiler/holo.test.mts
 * @description `node:test` verification suite for `intersections/holo-compiler`.
 *
 * Proves:
 *   1. `HoloCompilerSection` 7-Tuple Execution Context contract & admissibility
 *   2. `runHoloPipeline` in `consumer` mode (`devopsTeed: false`, `consumerDebugBytes: 0`, 0 sidecars)
 *   3. `runHoloPipeline` in `devops` mode (`devopsTeed: true`, `consumerDebugBytes: 0`, bit-exact `.debug.b8p` sidecars)
 *   4. Deterministic hermetic CAS keys (order-invariant flags, sensitive to source/flag/schema mutations)
 *   5. `lumiBERT` 1:1 error-to-solution integration via `resolveHoloError`
 *
 * Strictly `erasableSyntaxOnly: true`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkAdmissibility,
  type ExecutionContext,
  type PersonaPlane,
} from '../../packages/@awesome-os/stealify-schema/src/index.mts';
import {
  DEFAULT_HOLO_BUILD_POLICY,
  HOLO_COMPILER_CONTEXT,
  HOLO_FIVE_TARGETS,
  HoloCompilerSection,
  checkAbiCompat,
  listHoloBackends,
  lookupDebugSymbol,
  resolveHoloBuildPolicy,
  resolveHoloError,
  runHoloPipeline,
  type HoloCompileUnit,
} from './index.mts';

function makeCallerContext(
  persona: PersonaPlane,
  scopes: readonly string[] = ['holo.compile', 'devops.observe'],
): ExecutionContext {
  return Object.freeze({
    boundary: 'in-process',
    display: 'headless',
    lifetime: 'oneshot',
    transport: 'arena-sab',
    capability: Object.freeze({
      tenantId: 'local-user',
      scopes: Object.freeze([...scopes]),
      epoch: 1,
      privateData: false,
    }),
    locality: 'local-arena',
    persona,
  });
}

const SAMPLE_UNITS: readonly HoloCompileUnit[] = Object.freeze([
  {
    unitId: 'fast_hash',
    toolchain: 'cxx',
    source: [
      '// C11 fast hash kernel',
      'uint32_t fnv1a_step(uint32_t h, uint32_t b) { return (h ^ b) * 16777619u; }',
    ].join('\n'),
    flags: ['-O2', '-std=c11', '-Wall'],
    schemaHash: '0x1122334455667788',
    abiVersion: 3,
  },
  {
    unitId: 'wasi_ring',
    toolchain: 'wasi',
    source: [
      '// Portable WASI ring buffer',
      'pub fn ring_avail(head: u32, tail: u32) -> u32 { head - tail }',
    ].join('\n'),
    flags: ['-O2', '-target', 'wasm32-wasi'],
    schemaHash: '0x8877665544332211',
    abiVersion: 3,
  },
]);

describe('intersections/holo-compiler', () => {
  it('defines HoloCompilerSection with exact 7-tuple context and admissibility rules', () => {
    assert.equal(HoloCompilerSection.id, 'b8g/holo-compiler');
    assert.equal(HoloCompilerSection.version, '1.0.0');
    assert.equal(HOLO_COMPILER_CONTEXT.boundary, 'in-process');
    assert.equal(HOLO_COMPILER_CONTEXT.display, 'headless');
    assert.equal(HOLO_COMPILER_CONTEXT.lifetime, 'oneshot');
    assert.equal(HOLO_COMPILER_CONTEXT.transport, 'arena-sab');
    assert.equal(HOLO_COMPILER_CONTEXT.locality, 'local-arena');
    assert.equal(HOLO_COMPILER_CONTEXT.persona, 'creator');
    assert.deepEqual(HOLO_COMPILER_CONTEXT.capability.scopes, [
      'holo.compile',
      'devops.observe',
    ]);

    const creatorCheck = checkAdmissibility(
      HoloCompilerSection.context,
      makeCallerContext('creator'),
    );
    assert.equal(creatorCheck.admissible, true);
    assert.equal(creatorCheck.violations.length, 0);

    const devopsCheck = checkAdmissibility(
      HoloCompilerSection.context,
      makeCallerContext('devops'),
    );
    assert.equal(devopsCheck.admissible, true);

    const missingScopeCheck = checkAdmissibility(
      HoloCompilerSection.context,
      makeCallerContext('creator', ['holo.compile']),
    );
    assert.equal(missingScopeCheck.admissible, false);
    assert.ok(
      missingScopeCheck.violations.some((v) => v.invariant === 'CAPABILITY_INCLUSION'),
    );

    const consumerCheck = checkAdmissibility(
      HoloCompilerSection.context,
      makeCallerContext('consumer'),
    );
    assert.equal(consumerCheck.admissible, false);
    assert.ok(
      consumerCheck.violations.some((v) => v.invariant === 'PERSONA_ISOLATION'),
    );
  });

  it('runs Web Streams pipeline in consumer mode with devopsTeed=false and 0 debug bytes', async () => {
    const result = await runHoloPipeline(SAMPLE_UNITS, makeCallerContext('consumer'));

    assert.equal(result.persona, 'consumer');
    assert.equal(result.devopsTeed, false);
    assert.equal(result.consumerDebugBytes, 0);
    assert.equal(result.productionArtifacts.length, SAMPLE_UNITS.length);
    assert.equal(result.debugSidecars.length, 0);
    assert.equal(result.devopsFrames.length, 0);

    for (const artifact of result.productionArtifacts) {
      assert.equal(artifact.persona, 'consumer');
      assert.equal(artifact.consumerDebugBytes, 0);
      assert.ok(artifact.payload.byteLength > 0);
    }
  });

  it('runs Web Streams pipeline in devops mode with devopsTeed=true and bit-exact .debug.b8p sidecars', async () => {
    const result = await runHoloPipeline(SAMPLE_UNITS, makeCallerContext('devops'));

    assert.equal(result.persona, 'devops');
    assert.equal(result.devopsTeed, true);
    assert.equal(result.admissibility.admissible, true);
    assert.equal(result.consumerDebugBytes, 0);
    assert.equal(result.productionArtifacts.length, SAMPLE_UNITS.length);
    assert.equal(result.debugSidecars.length, SAMPLE_UNITS.length);

    for (let i = 0; i < SAMPLE_UNITS.length; i += 1) {
      const artifact = result.productionArtifacts[i]!;
      const sidecar = result.debugSidecars[i]!;
      const sidecarFrame = result.devopsFrames[i]!;

      assert.equal(artifact.consumerDebugBytes, 0);
      assert.equal(sidecar.persona, 'devops');
      assert.equal(sidecar.buildId, artifact.buildId);
      assert.ok(sidecarFrame.payload.sidecarFilename.endsWith('.debug.b8p'));

      const abiCompat = checkAbiCompat(
        artifact.abiHeader,
        SAMPLE_UNITS[i]!.abiVersion,
        BigInt(SAMPLE_UNITS[i]!.schemaHash),
      );
      assert.equal(abiCompat.compatible, true);

      const devopsSym = lookupDebugSymbol(sidecar, artifact.buildId, '0x1000', 'devops');
      assert.equal(devopsSym.allowed, true);
      assert.equal(devopsSym.found, true);

      const consumerSym = lookupDebugSymbol(sidecar, artifact.buildId, '0x1000', 'consumer');
      assert.equal(consumerSym.allowed, false);
      assert.equal(consumerSym.found, false);
    }
  });

  it('produces deterministic hermetic CAS keys invariant to flag order and sensitive to mutations', async () => {
    const devopsCtx = makeCallerContext('devops');
    const unitA: HoloCompileUnit = {
      unitId: 'det_unit',
      toolchain: 'zig',
      source: 'pub fn main() void {}',
      flags: ['-O2', '-DRELEASE=1', '-Wall'],
      schemaHash: '0xdeadbeefcafebabe',
      abiVersion: 3,
    };
    const unitReorderedFlags: HoloCompileUnit = {
      ...unitA,
      flags: ['-Wall', '-O2', '-DRELEASE=1'],
    };
    const unitMutatedSource: HoloCompileUnit = {
      ...unitA,
      source: 'pub fn main() void { /* mutated */ }',
    };
    const unitMutatedSchema: HoloCompileUnit = {
      ...unitA,
      schemaHash: '0xdeadbeefcafebabf',
    };

    const run1 = await runHoloPipeline([unitA], devopsCtx);
    const run2 = await runHoloPipeline([unitReorderedFlags], devopsCtx);
    const run3 = await runHoloPipeline([unitMutatedSource], devopsCtx);
    const run4 = await runHoloPipeline([unitMutatedSchema], devopsCtx);

    assert.equal(run1.casKeys[0], run2.casKeys[0]);
    assert.equal(
      run1.productionArtifacts[0]!.buildId,
      run2.productionArtifacts[0]!.buildId,
    );
    assert.notEqual(run1.casKeys[0], run3.casKeys[0]);
    assert.notEqual(run1.casKeys[0], run4.casKeys[0]);
  });

  it('lists hermetic backends and resolves compiler/workspace errors 1:1 via lumiBERT', () => {
    const backends = listHoloBackends();
    assert.ok(backends.length >= 4);
    assert.deepEqual(
      backends.map((b) => b.kind).sort(),
      ['cxx', 'rust', 'wasi', 'zig'],
    );

    const resolved = resolveHoloError(
      'TS1294 erasableSyntaxOnly This syntax is not allowed when erasableSyntaxOnly is enabled enum',
    );
    assert.equal(resolved.status, 'AUTO_FIXED');
    assert.equal(resolved.fix.code, 'TS1294_ERASABLE_SYNTAX');
  });

  it('defaults to full 5-target CAS v11 suite and supports Chrome-style --disable-* opt-out flags', () => {
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.crossCompileAll5, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.targets.length, 5);
    assert.deepEqual(DEFAULT_HOLO_BUILD_POLICY.targets, HOLO_FIVE_TARGETS);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.subTuSplice, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.effectGate, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.emitCasV11, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.emitPnpmPackage, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.emitDebugSidecar, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.useResidentDaemon, true);

    const fastLocal = resolveHoloBuildPolicy([
      '--disable-cross',
      '--disable-pnpm-pack',
      '--disable-sidecar',
    ]);
    assert.equal(fastLocal.crossCompileAll5, false);
    assert.deepEqual(fastLocal.targets, ['x86_64-windows-gnu']);
    assert.equal(fastLocal.emitPnpmPackage, false);
    assert.equal(fastLocal.emitDebugSidecar, false);
    assert.equal(fastLocal.emitCasV11, true);
    assert.equal(fastLocal.effectGate, true);
  });
});
