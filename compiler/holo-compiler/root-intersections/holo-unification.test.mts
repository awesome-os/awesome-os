/**
 * @file intersections/holo-compiler/holo-unification.test.mts
 * @description End-to-end integration test verifying the COMPLETE unified `holo` stack:
 *   Policy -> Effect Gate -> Sub-TU Incremental Splice -> CasV11Store (`v11/files/XX/<sha512>`)
 *   -> Ghost Executable (~20 KB) -> `holo-compiler-lockfile.json` -> Hardlink Hydration.
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import {
  CasV11Store,
  DEFAULT_HOLO_BUILD_POLICY,
  HOLO_COMPILER_CONTEXT,
  SubTuCasIndex,
  checkModuleEffects,
  compileToExecutable,
  computeSplicePlan,
  generateHoloLockfile,
  hydrateFromLockfile,
  resolveHoloBuildPolicy,
  spliceModule,
  splitModuleItems,
  verifyHoloLockfile,
} from './index.mts';

describe('holo-compiler unified stack end-to-end', () => {
  it('enforces opinionated 5-target defaults and Chrome-style --disable-* opt-outs', () => {
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.crossCompileAll5, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.targets.length, 5);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.subTuSplice, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.effectGate, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.emitCasV11, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.emitPnpmPackage, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.emitDebugSidecar, true);
    assert.equal(DEFAULT_HOLO_BUILD_POLICY.useResidentDaemon, true);

    const hostOnly = resolveHoloBuildPolicy(
      ['--disable-cross', '--disable-daemon', '--disable-sidecar'],
      'x86_64-windows-gnu',
    );
    assert.equal(hostOnly.crossCompileAll5, false);
    assert.deepEqual(hostOnly.targets, ['x86_64-windows-gnu']);
    assert.equal(hostOnly.useResidentDaemon, false);
    assert.equal(hostOnly.emitDebugSidecar, false);
    assert.equal(hostOnly.subTuSplice, true);
    assert.equal(hostOnly.effectGate, true);
    assert.equal(hostOnly.emitCasV11, true);
  });

  it('runs full pipeline: effect check -> sub-TU splice -> CasV11Store -> ghost exe -> lockfile -> hardlink hydrate', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'holo-unification-'));
    const casRoot = join(workDir, 'cas', 'v11');
    const subTuCasDir = join(workDir, 'subtu-cas');
    const appDir = join(workDir, 'app');
    const hydrateDir = join(workDir, 'hydrated');
    const store = new CasV11Store(casRoot);

    try {
      // ------------------------------------------------------------------
      // 1. Algebraic Effect Gate on a polyglot (cxx + ts) module
      // ------------------------------------------------------------------
      const cxxUnitSource = [
        '// @holo-effect: alloc, arena_sab',
        '#include <stdint.h>',
        'int32_t holo_kernel_step(int32_t x) {',
        '  void* p = malloc(64);',
        '  (void)B8G_ARENA_V1;',
        '  return x + (p != 0 ? 1 : 0);',
        '}',
      ].join('\n');

      const tsUnitV1 = [
        '// @holo-effect: pure',
        'export function computeAlpha(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export function computeBeta(x: number): number {',
        '  return x * 2;',
        '}',
        '',
        'export function formatSummary(label: string, value: number): string {',
        '  return `${label}=${value}`;',
        '}',
      ].join('\n');

      const effectCheck = checkModuleEffects(
        [
          {
            unitId: 'kernel.cxx',
            toolchain: 'cxx',
            source: cxxUnitSource,
          },
          {
            unitId: 'app.ts',
            toolchain: 'ts',
            source: tsUnitV1,
            calls: ['kernel.cxx'],
          },
        ],
        HOLO_COMPILER_CONTEXT,
        [
          // Discharge alloc + arena_sab at the TS -> CXX boundary
          {
            callerUnitId: 'app.ts',
            calleeUnitId: 'kernel.cxx',
            handles: (1 << 0) | (1 << 3),
          },
        ],
      );

      assert.equal(
        effectCheck.ok,
        true,
        `Expected effect check to pass, got diagnostics: ${JSON.stringify(effectCheck.diagnostics)}`,
      );
      assert.equal(effectCheck.diagnostics.length, 0);
      assert.equal(effectCheck.unitSummaries['app.ts']?.isPure, true);

      // ------------------------------------------------------------------
      // 2. Sub-TU Incremental Splicing (cold compile -> body-only hot splice)
      // ------------------------------------------------------------------
      const encoder = new TextEncoder();
      const subTuIndex = new SubTuCasIndex({ casDir: subTuCasDir });
      const v1Items = splitModuleItems('ts', tsUnitV1);
      assert.equal(v1Items.length, 3);

      const coldPlan = computeSplicePlan([], v1Items, subTuIndex);
      const coldResult = await spliceModule(coldPlan, (item) =>
        encoder.encode(`COMPILED:${item.name}:${item.itemHash.slice(0, 12)}`),
      );
      assert.equal(coldResult.compiledCount, 3);
      assert.equal(coldResult.cacheHits, 0);

      // Edit ONLY the body of computeBeta (signature unchanged)
      const tsUnitV2 = tsUnitV1.replace('return x * 2;', 'return x * 3 + 1;');
      const v2Items = splitModuleItems('ts', tsUnitV2);

      const incPlan = computeSplicePlan(v1Items, v2Items, subTuIndex);
      assert.equal(incPlan.bodyOnlyDirty.length, 1);
      assert.equal(incPlan.bodyOnlyDirty[0]?.name, 'computeBeta');
      assert.equal(incPlan.signatureDirty.length, 0);
      assert.equal(incPlan.unchanged.length, 2);
      assert.equal(incPlan.canHotSplice, true);
      assert.equal(incPlan.invalidatesDependents, false);

      const incResult = await spliceModule(incPlan, (item) =>
        encoder.encode(`COMPILED:${item.name}:${item.itemHash.slice(0, 12)}`),
      );
      assert.equal(incResult.compiledCount, 1);
      assert.deepEqual(incResult.compiledItems, ['computeBeta']);
      assert.equal(incResult.cacheHits, 2);
      assert.equal(incResult.hotSpliced, true);
      assert.ok(incResult.artifactBytes.byteLength > 12);

      // ------------------------------------------------------------------
      // 3. Store spliced module artifact in CasV11Store (v11/files/XX/<sha512>)
      // ------------------------------------------------------------------
      const splicedPut = store.putBlob(incResult.artifactBytes, {
        kind: 'b8p',
        executable: false,
        meta: {
          unit: 'app.ts',
          artifactSha256: incResult.artifactSha256,
        },
      });
      assert.equal(splicedPut.sha512.length, 128);
      const shardPrefix = splicedPut.sha512.slice(0, 2);
      assert.ok(
        normalize(splicedPut.path).includes(normalize(join('v11', 'files', shardPrefix, splicedPut.sha512))),
        `Expected v11/files/${shardPrefix}/<sha512> path, got ${splicedPut.path}`,
      );
      assert.equal(store.hasBlob(splicedPut.sha512, false), true);
      const readBack = store.getBlob(splicedPut.sha512, false);
      assert.ok(readBack !== null);
      assert.deepEqual(Buffer.from(readBack), Buffer.from(incResult.artifactBytes));

      // ------------------------------------------------------------------
      // 4. Compile a tiny `ghost` native executable (~20 KB) backed by CasV11Store
      // ------------------------------------------------------------------
      const entryPath = join(appDir, 'holo-unified-entry.mjs');
      const exeExt = process.platform === 'win32' ? '.exe' : '';
      const outExePath = join(appDir, `holo-unified-demo${exeExt}`);
      const targetTriple =
        process.platform === 'win32' ? 'x86_64-windows-gnu' : 'x86_64-linux-musl';

      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        entryPath,
        `console.log(JSON.stringify({ ok: true, app: 'holo-unified-demo', args: process.argv.slice(2) }));\n`,
        'utf8',
      );

      const compiled = compileToExecutable({
        entryPath,
        outPath: outExePath,
        appName: 'holo-unified-demo',
        mode: 'ghost',
        targetTriple,
        casStoreRoot: casRoot,
      });

      assert.equal(compiled.mode, 'ghost');
      assert.equal(existsSync(compiled.outPath), true);
      assert.ok(
        compiled.binaryBytes > 4_096 && compiled.binaryBytes < 65_536,
        `Expected ghost executable around ~20 KB (< 64 KB), got ${compiled.binaryBytes} bytes`,
      );
      assert.equal(store.hasBlob(compiled.payloadSha512, false), true);

      // Verify compiled ghost stub reports B8G_ABI_MAGIC_V3 metadata
      const infoRun = spawnSync(compiled.outPath, ['--holo-exe-info'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(infoRun.status, 0, `ghost --holo-exe-info failed: ${infoRun.stderr}`);
      const exeInfo = JSON.parse(infoRun.stdout.trim()) as {
        mode: string;
        abiMagic: string;
        appName: string;
        sha512: string;
      };
      assert.equal(exeInfo.mode, 'ghost');
      assert.equal(exeInfo.abiMagic, '0x33564742');
      assert.equal(exeInfo.appName, 'holo-unified-demo');
      assert.equal(exeInfo.sha512, compiled.payloadSha512);

      // Store the compiled ghost binary itself in CasV11Store as executable
      const exeBytes = readFileSync(compiled.outPath);
      const exePut = store.putBlob(exeBytes, {
        kind: 'ghost',
        executable: true,
        meta: { appName: 'holo-unified-demo', targetTriple },
      });
      assert.equal(store.hasBlob(exePut.sha512, true), true);

      // ------------------------------------------------------------------
      // 5. Generate & Verify `holo-compiler-lockfile.json`, then Hardlink-Hydrate
      // ------------------------------------------------------------------
      const payloadSize = statSync(entryPath).size;
      const lockfile = generateHoloLockfile({
        repo: 'awesome-os/holo-unified-demo',
        targets: [targetTriple],
        dependencies: [
          {
            id: 'holo-unified-demo',
            kind: 'ghost-launcher',
            version: '0.1.0',
            target: targetTriple,
            sha512: exePut.sha512,
            size: exePut.size,
            executable: true,
            dependencies: [
              {
                id: 'holo-unified-entry',
                kind: 'ghost',
                version: '0.1.0',
                target: 'any',
                sha512: compiled.payloadSha512,
                size: payloadSize,
                executable: false,
                dependencies: [
                  {
                    id: 'app-spliced-module',
                    kind: 'b8p',
                    version: '0.1.0',
                    target: 'es2024-node22',
                    sha512: splicedPut.sha512,
                    size: splicedPut.size,
                    executable: false,
                  },
                ],
              },
            ],
          },
        ],
      });

      assert.equal(lockfile.schema, 'holo-compiler-lockfile-v1');
      assert.equal(lockfile.abiMagic, '0x33564742');
      assert.equal(lockfile.casLayout, 'v11');

      const verification = verifyHoloLockfile(lockfile, store);
      assert.equal(
        verification.ok,
        true,
        `Lockfile verification failed: ${JSON.stringify(verification.issues)}`,
      );
      assert.equal(verification.totalNodes, 3);
      assert.equal(verification.uniqueNodes, 3);
      assert.equal(verification.presentInCas, 3);
      assert.equal(verification.missingInCas, 0);
      assert.equal(verification.issues.length, 0);

      // Hydrate into a brand-new directory via O(1) hardlinks
      const hydration = hydrateFromLockfile(lockfile, store, hydrateDir);
      assert.equal(hydration.ok, true);
      assert.equal(hydration.missing.length, 0);
      assert.equal(hydration.hydrated.length, 3);

      // Bottom-up topological order: leaf spliced module -> entry payload -> ghost launcher
      assert.deepEqual(
        hydration.hydrated.map((h) => h.id),
        ['app-spliced-module', 'holo-unified-entry', 'holo-unified-demo'],
      );

      for (const entry of hydration.hydrated) {
        assert.equal(existsSync(entry.destPath), true);
        assert.equal(statSync(entry.destPath).size, entry.size);
        assert.ok(entry.method === 'hardlink' || entry.method === 'copy');
      }
    } finally {
      store.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
