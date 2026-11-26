/**
 * @file intersections/holo-compiler/holo-projections.test.mts
 * @description Unit tests for `HOLO_PROJECTIONS`, legacy alias resolution, and
 * 0-byte hardlink artifact projection via `CasV11Store`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { CasV11Store } from './cas-v11-store.mts';
import {
  B8G_ABI_MAGIC_V3,
  HOLO_PROJECTIONS,
  projectHoloArtifacts,
  resolveHoloProjection,
} from './holo-projections.mts';

describe('Holo Projections Registry', () => {
  it('defines all 12 canonical holo-* projections with valid repository:// URIs, v11 layout, and ABI magic', () => {
    const expectedIds = [
      'holo-compiler',
      'holo-pm',
      'holo-ffi',
      'holo-wasi-host',
      'holo-node',
      'holo-deno',
      'holo-py',
      'holo-go',
      'holo-dart',
      'holo-rust',
      'holo-cpp',
      'holo-jvm',
    ];

    assert.equal(HOLO_PROJECTIONS.length, 12);
    assert.deepEqual(
      HOLO_PROJECTIONS.map((p) => p.id),
      expectedIds,
    );

    const seenIds = new Set<string>();
    for (const def of HOLO_PROJECTIONS) {
      assert.equal(seenIds.has(def.id), false, `Duplicate projection ID: ${def.id}`);
      seenIds.add(def.id);

      assert.match(def.id, /^holo-[a-z-]+$/);
      assert.ok(def.displayName.length > 0);
      assert.match(
        def.repositoryUri,
        /^repository:\/\/awesome-os\/holo-[a-z-]+$/,
        `Invalid repository URI for ${def.id}: ${def.repositoryUri}`,
      );
      assert.equal(def.casLayout, 'v11');
      assert.equal(def.abiMagic, B8G_ABI_MAGIC_V3);
      assert.equal(def.abiMagic, '0x33564742');
      assert.ok(def.description.length > 0);
      assert.equal(resolveHoloProjection(def.id), def);
    }
  });

  it('resolves legacy ghost-* / b8g-* / wasi-host aliases to canonical HoloProjectionDefs', () => {
    const aliasExpectations: ReadonlyArray<readonly [string, string]> = [
      ['holo-py', 'holo-py'],
      ['holoFFI', 'holo-ffi'],
      ['holo-ffi', 'holo-ffi'],
      ['ghost-node', 'holo-node'],
      ['b8g-build', 'holo-compiler'],
      ['b8g-pm', 'holo-pm'],
      ['wasi-host', 'holo-wasi-host'],
      ['ghost-rust', 'holo-rust'],
      ['ghost-cpp', 'holo-cpp'],
      ['ghost-jvm', 'holo-jvm'],
    ];

    for (const [alias, expectedId] of aliasExpectations) {
      const resolved = resolveHoloProjection(alias);
      assert.ok(resolved, `Expected alias "${alias}" to resolve`);
      assert.equal(resolved.id, expectedId);
      assert.equal(resolved.abiMagic, B8G_ABI_MAGIC_V3);
      assert.equal(resolved.casLayout, 'v11');
    }

    assert.equal(resolveHoloProjection('unknown-runtime'), undefined);
    assert.equal(resolveHoloProjection('   '), undefined);
  });

  it('projects blobs via 0-byte hardlinks with matching inode identity and clean store teardown', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-projections-test-'));
    const casRoot = path.join(tmpRoot, 'cas-v11');
    const destDir = path.join(tmpRoot, 'projected');
    const store = new CasV11Store(casRoot);

    try {
      const libBlob = store.putBlob('export const magic = "0x33564742";\n', {
        kind: 'b8p',
        executable: false,
      });
      const binBlob = store.putBlob('#!/usr/bin/env sh\necho holo\n', {
        kind: 'ghost',
        executable: true,
      });

      const result = projectHoloArtifacts('b8g-build', store, destDir, [
        { relPath: 'lib/runtime.mjs', sha512: libBlob.sha512, executable: false },
        { relPath: 'bin/holo-tool', sha512: binBlob.sha512, executable: true },
      ]);

      assert.equal(result.projectionId, 'holo-compiler');
      assert.equal(result.destDir, path.resolve(destDir));
      assert.equal(result.projectedCount, 2);
      assert.equal(result.hardlinkedCount, 2);
      assert.equal(result.abiMagic, B8G_ABI_MAGIC_V3);

      const projectedLibPath = path.join(destDir, 'lib', 'runtime.mjs');
      const projectedBinPath = path.join(destDir, 'bin', 'holo-tool');

      const srcLibStat = fs.statSync(libBlob.path);
      const dstLibStat = fs.statSync(projectedLibPath);
      assert.notEqual(srcLibStat.ino, 0);
      assert.equal(dstLibStat.ino, srcLibStat.ino);
      assert.equal(
        fs.readFileSync(projectedLibPath, 'utf8'),
        'export const magic = "0x33564742";\n',
      );

      const srcBinStat = fs.statSync(binBlob.path);
      const dstBinStat = fs.statSync(projectedBinPath);
      assert.notEqual(srcBinStat.ino, 0);
      assert.equal(dstBinStat.ino, srcBinStat.ino);
      assert.equal(
        fs.readFileSync(projectedBinPath, 'utf8'),
        '#!/usr/bin/env sh\necho holo\n',
      );

      assert.throws(
        () => projectHoloArtifacts('nonexistent-holo', store, destDir, []),
        /Unknown Holo projection/,
      );

      assert.throws(
        () =>
          projectHoloArtifacts('holo-py', store, destDir, [
            { relPath: '../escape.txt', sha512: libBlob.sha512 },
          ]),
        /escapes destination directory/,
      );
    } finally {
      store.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
