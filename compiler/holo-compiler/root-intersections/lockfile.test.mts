import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CasV11Store } from './cas-v11-store.mts';
import {
  HOLO_LOCKFILE_FILENAME,
  HOLO_LOCKFILE_SCHEMA,
  generateHoloLockfile,
  hydrateFromLockfile,
  readHoloLockfile,
  verifyHoloLockfile,
  walkLockfileBottomUp,
  writeHoloLockfile,
} from './lockfile.mts';

describe('holo-compiler-lockfile.json (nested v11 CAS dependency graph)', () => {
  it('generates nested dependencies[], walks bottom-up, verifies against CasV11Store, and hardlink-hydrates', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-lockfile-test-'));
    try {
      const store = new CasV11Store(path.join(tmp, 'v11'));

      const libuvBlob = store.putBlob(new TextEncoder().encode('LIBUV_SHARD_V0_1_0'), {
        kind: 'b8p',
      });
      const v8Blob = store.putBlob(new TextEncoder().encode('LIBV8_MONOLITH_V0_2_0'), {
        kind: 'b8p',
      });
      const nodeBlob = store.putBlob(new TextEncoder().encode('NODE_LAUNCHER_V0_3_0'), {
        kind: 'ghost',
        executable: true,
      });

      const lockfile = generateHoloLockfile({
        repo: 'awesome-os/sectium-desktop',
        generatedAt: '2026-11-24T22:42:00.000Z',
        dependencies: [
          {
            id: 'awesome-os/node',
            kind: 'bin',
            version: '0.3.0',
            target: 'win64',
            sha512: nodeBlob.sha512,
            size: nodeBlob.size,
            executable: true,
            dependencies: [
              {
                id: 'awesome-os/libv8_monolith',
                kind: 'lib',
                version: '0.2.0',
                target: 'win64',
                sha512: v8Blob.sha512,
                size: v8Blob.size,
              },
              {
                id: 'awesome-os/libuv',
                kind: 'lib',
                version: '0.1.0',
                target: 'win64',
                sha512: libuvBlob.sha512,
                size: libuvBlob.size,
              },
            ],
          },
        ],
      });

      assert.equal(lockfile.schema, HOLO_LOCKFILE_SCHEMA);
      assert.equal(lockfile.abiMagic, '0x33564742');
      assert.equal(lockfile.casLayout, 'v11');
      assert.equal(lockfile.dependencies.length, 1);
      assert.equal(lockfile.dependencies[0]!.dependencies.length, 2);

      // Round-trip write/read
      const lockPath = path.join(tmp, HOLO_LOCKFILE_FILENAME);
      writeHoloLockfile(lockPath, lockfile);
      const reloaded = readHoloLockfile(lockPath);
      assert.deepEqual(reloaded, lockfile);

      // Bottom-up topological order: leaves (libuv, libv8_monolith) BEFORE parent (node)
      const order = walkLockfileBottomUp(reloaded).map((n) => n.id);
      assert.equal(order.length, 3);
      assert.equal(order[2], 'awesome-os/node');
      assert.ok(order.indexOf('awesome-os/libuv') < order.indexOf('awesome-os/node'));
      assert.ok(order.indexOf('awesome-os/libv8_monolith') < order.indexOf('awesome-os/node'));

      // Verify all 3 blobs exist in CasV11Store
      const verification = verifyHoloLockfile(reloaded, store);
      assert.equal(verification.ok, true);
      assert.equal(verification.presentInCas, 3);
      assert.equal(verification.missingInCas, 0);

      // Hydrate via hardlinks
      const outDir = path.join(tmp, 'hydrated');
      const hydrated = hydrateFromLockfile(reloaded, store, outDir);
      assert.equal(hydrated.ok, true);
      assert.equal(hydrated.hydrated.length, 3);
      assert.equal(hydrated.missing.length, 0);
      for (const entry of hydrated.hydrated) {
        assert.equal(fs.existsSync(entry.destPath), true);
        assert.equal(entry.method, 'hardlink');
      }

      store.close();
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup on Windows WAL file lock
      }
    }
  });

  it('detects missing v11 blobs and rejects dependency cycles', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-lockfile-err-'));
    try {
      const store = new CasV11Store(path.join(tmp, 'v11'));
      const missingSha = 'a'.repeat(128);

      const lockfile = generateHoloLockfile({
        repo: 'awesome-os/missing-test',
        dependencies: [
          {
            id: 'awesome-os/ghost-missing',
            kind: 'wasm',
            version: '0.1.0',
            sha512: missingSha,
            size: 1024,
          },
        ],
      });

      const ver = verifyHoloLockfile(lockfile, store);
      assert.equal(ver.ok, false);
      assert.equal(ver.missingInCas, 1);
      assert.equal(ver.issues[0]!.reason, 'missing-blob');

      assert.throws(
        () =>
          generateHoloLockfile({
            repo: 'awesome-os/cycle-test',
            dependencies: [
              {
                id: 'pkg-a',
                kind: 'lib',
                version: '1.0.0',
                sha512: missingSha,
                size: 10,
                dependencies: [
                  {
                    id: 'pkg-a',
                    kind: 'lib',
                    version: '1.0.0',
                    sha512: missingSha,
                    size: 10,
                  },
                ],
              },
            ],
          }),
        /Dependency cycle detected/,
      );

      store.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
