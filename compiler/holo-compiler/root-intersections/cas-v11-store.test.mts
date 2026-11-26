/**
 * @file intersections/holo-compiler/cas-v11-store.test.mts
 * @description Comprehensive unit tests for the Unified CAS `v11` Store.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  CAS_V11_VERSION,
  CasV11Store,
  casBlobPath,
  resolveUnifiedCasRoot,
  sha512Hex,
} from './cas-v11-store.mts';

function withTempDir(prefix: string, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Unified CAS v11 Store', () => {
  it('exposes exact pnpm v12 path parity for regular and -exec blobs', () => {
    assert.equal(CAS_V11_VERSION, 'v11');

    const payload = 'hello pnpm v12 unified cas store';
    const digest = sha512Hex(payload);
    assert.equal(digest.length, 128);
    assert.match(digest, /^[0-9a-f]{128}$/);

    const storeRoot = path.join('C:', 'cas-root', 'v11');
    const regularPath = casBlobPath(storeRoot, digest, false);
    const execPath = casBlobPath(storeRoot, digest, true);

    const shard = digest.slice(0, 2);
    assert.equal(regularPath, path.join(storeRoot, 'files', shard, digest));
    assert.equal(execPath, path.join(storeRoot, 'files', shard, `${digest}-exec`));
    assert.equal(casBlobPath(storeRoot, digest.toUpperCase()), regularPath);
  });

  it('resolves unified CAS root from B8G_GHOST_CACHE_DIR, PNPM_HOME, and fallback without doubling /v11', () => {
    const ghostBase = path.join('D:', 'ghost-cache');
    assert.equal(
      resolveUnifiedCasRoot({ B8G_GHOST_CACHE_DIR: ghostBase }),
      path.join(ghostBase, 'v11'),
    );

    // Must not double /v11 when B8G_GHOST_CACHE_DIR already ends in v11
    const ghostWithV11 = path.join('D:', 'ghost-cache', 'v11');
    assert.equal(
      resolveUnifiedCasRoot({ B8G_GHOST_CACHE_DIR: ghostWithV11 }),
      ghostWithV11,
    );
    assert.equal(
      resolveUnifiedCasRoot({ B8G_GHOST_CACHE_DIR: `${ghostWithV11}${path.sep}` }),
      ghostWithV11,
    );

    // PNPM_HOME precedence when B8G_GHOST_CACHE_DIR is unset
    const pnpmHome = path.join('D:', 'pnpm-home');
    assert.equal(
      resolveUnifiedCasRoot({ PNPM_HOME: pnpmHome }),
      path.join(pnpmHome, 'store', 'v11'),
    );
    assert.equal(
      resolveUnifiedCasRoot({ PNPM_HOME: path.join(pnpmHome, 'store') }),
      path.join(pnpmHome, 'store', 'v11'),
    );
    assert.equal(
      resolveUnifiedCasRoot({ PNPM_HOME: path.join(pnpmHome, 'store', 'v11') }),
      path.join(pnpmHome, 'store', 'v11'),
    );

    // Fallback to ~/.b8g/cas/v11
    const fakeHome = path.join('D:', 'users', 'dev');
    assert.equal(
      resolveUnifiedCasRoot({ HOME: fakeHome }),
      path.join(fakeHome, '.b8g', 'cas', 'v11'),
    );
  });

  it('prioritizes HOLO_CAS_DIR over B8G_GHOST_CACHE_DIR and PNPM_HOME without doubling /v11', () => {
    const holoBase = path.join('D:', 'holo-cas');
    const ghostBase = path.join('D:', 'ghost-cache');
    const pnpmHome = path.join('D:', 'pnpm-home');

    // HOLO_CAS_DIR takes precedence over B8G_GHOST_CACHE_DIR and PNPM_HOME
    assert.equal(
      resolveUnifiedCasRoot({
        HOLO_CAS_DIR: holoBase,
        B8G_GHOST_CACHE_DIR: ghostBase,
        PNPM_HOME: pnpmHome,
      }),
      path.join(holoBase, 'v11'),
    );

    // Must not double /v11 when HOLO_CAS_DIR already ends in v11 (with or without trailing separator)
    const holoWithV11 = path.join('D:', 'holo-cas', 'v11');
    assert.equal(
      resolveUnifiedCasRoot({
        HOLO_CAS_DIR: holoWithV11,
        B8G_GHOST_CACHE_DIR: ghostBase,
      }),
      holoWithV11,
    );
    assert.equal(
      resolveUnifiedCasRoot({
        HOLO_CAS_DIR: `${holoWithV11}${path.sep}`,
        B8G_GHOST_CACHE_DIR: ghostBase,
      }),
      holoWithV11,
    );

    // Legacy B8G_GHOST_CACHE_DIR fallback works identically when HOLO_CAS_DIR is unset or blank
    assert.equal(
      resolveUnifiedCasRoot({
        HOLO_CAS_DIR: undefined,
        B8G_GHOST_CACHE_DIR: ghostBase,
        PNPM_HOME: pnpmHome,
      }),
      path.join(ghostBase, 'v11'),
    );
    assert.equal(
      resolveUnifiedCasRoot({
        HOLO_CAS_DIR: '   ',
        B8G_GHOST_CACHE_DIR: ghostBase,
        PNPM_HOME: pnpmHome,
      }),
      path.join(ghostBase, 'v11'),
    );
  });

  it('deduplicates identical blobs and cleans up tmp staging files', () => {
    withTempDir('cas-v11-dedup-', (tmpRoot) => {
      const storeRoot = path.join(tmpRoot, 'v11');
      const store = new CasV11Store(storeRoot);
      try {
        const data = new TextEncoder().encode('deterministic-b8p-artifact-bytes');
        const first = store.putBlob(data, {
          kind: 'b8p',
          meta: { target: 'x86_64-pc-windows-msvc' },
        });
        assert.equal(first.deduplicated, false);
        assert.equal(first.size, data.byteLength);
        assert.equal(first.kind, 'b8p');
        assert.equal(first.executable, false);
        assert.equal(store.hasBlob(first.sha512), true);
        assert.equal(store.hasBlob(first.sha512, true), false);

        const second = store.putBlob(data, { kind: 'b8p' });
        assert.equal(second.deduplicated, true);
        assert.equal(second.sha512, first.sha512);
        assert.equal(second.path, first.path);

        // Verify exact content roundtrip
        const readBack = store.getBlob(first.sha512);
        assert.ok(readBack !== null);
        assert.deepEqual(Buffer.from(readBack), Buffer.from(data));

        // Verify executable variant is stored separately with -exec suffix
        const execPut = store.putBlob(data, { kind: 'cargo', executable: true });
        assert.equal(execPut.deduplicated, false);
        assert.ok(execPut.path.endsWith(`${first.sha512}-exec`));
        assert.equal(store.hasBlob(first.sha512, true), true);

        // Ensure tmp directory is clean (no leaked staging files)
        assert.deepEqual(fs.readdirSync(store.tmpDir), []);
      } finally {
        store.close();
      }
    });
  });

  it('projects blobs via hardlinks with identical inode', () => {
    withTempDir('cas-v11-hardlink-', (tmpRoot) => {
      const storeRoot = path.join(tmpRoot, 'v11');
      const store = new CasV11Store(storeRoot);
      try {
        const put = store.putBlob('compiled-native-object-payload', { kind: 'object' });
        const destPath = path.join(tmpRoot, 'workspace', 'nested', 'out', 'unit.obj');

        const linked = store.linkBlobTo(put.sha512, destPath);
        assert.equal(linked.method, 'hardlink');
        assert.equal(linked.src, put.path);
        assert.equal(linked.dest, path.resolve(destPath));

        const srcStat = fs.statSync(put.path);
        const destStat = fs.statSync(destPath);
        assert.equal(srcStat.ino, destStat.ino);
        assert.equal(fs.readFileSync(destPath, 'utf8'), 'compiled-native-object-payload');

        // Linking again to the same destination is idempotent
        const relinked = store.linkBlobTo(put.sha512, destPath);
        assert.equal(relinked.method, 'hardlink');
        assert.equal(fs.statSync(destPath).ino, srcStat.ino);
      } finally {
        store.close();
      }
    });
  });

  it('persists blobs and projects across WAL index.db close and fresh reopen', () => {
    withTempDir('cas-v11-wal-persist-', (tmpRoot) => {
      const storeRoot = path.join(tmpRoot, 'v11');
      const projectDir = path.join(tmpRoot, 'my-project');

      let digestA = '';
      let digestB = '';

      const store1 = new CasV11Store(storeRoot);
      try {
        store1.ensureLayout();
        assert.ok(fs.existsSync(path.join(storeRoot, 'files')));
        assert.ok(fs.existsSync(path.join(storeRoot, 'tmp')));
        assert.ok(fs.existsSync(path.join(storeRoot, 'links')));
        assert.ok(fs.existsSync(path.join(storeRoot, 'projects')));

        const a = store1.putBlob('npm-package-file-alpha', {
          kind: 'npm',
          meta: { pkg: '@awesome-os/holo' },
        });
        const b = store1.putBlob('ghost-exec-binary', {
          kind: 'ghost',
          executable: true,
          meta: { arch: 'x64' },
        });
        digestA = a.sha512;
        digestB = b.sha512;

        store1.registerProject(projectDir);

        const s1 = store1.stats();
        assert.equal(s1.backend, 'sqlite');
        assert.equal(s1.blobCount, 2);
        assert.equal(s1.executableCount, 1);
        assert.equal(s1.projectCount, 1);
        assert.ok(fs.existsSync(store1.indexDbPath));
      } finally {
        store1.close();
      }

      // Fresh instance against the same storeRoot
      const store2 = new CasV11Store(storeRoot);
      try {
        const s2 = store2.stats();
        assert.equal(s2.backend, 'sqlite');
        assert.equal(s2.version, 'v11');
        assert.equal(s2.blobCount, 2);
        assert.equal(s2.executableCount, 1);
        assert.equal(s2.projectCount, 1);
        assert.equal(s2.byKind.npm?.count, 1);
        assert.equal(s2.byKind.ghost?.count, 1);

        const metaA = store2.getBlobMeta(digestA);
        assert.ok(metaA !== null);
        assert.equal(metaA.kind, 'npm');
        assert.deepEqual(metaA.meta, { pkg: '@awesome-os/holo' });

        const metaB = store2.getBlobMeta(digestB);
        assert.ok(metaB !== null);
        assert.equal(metaB.executable, true);

        const projects = store2.listProjects();
        assert.equal(projects.length, 1);
        assert.equal(projects[0]?.path, path.resolve(projectDir));
      } finally {
        store2.close();
      }
    });
  });

  it('supports graceful JSON-line fallback when SQLite is unavailable', () => {
    withTempDir('cas-v11-jsonl-', (tmpRoot) => {
      const storeRoot = path.join(tmpRoot, 'v11');
      const projectDir = path.join(tmpRoot, 'fallback-project');

      let digest = '';
      const store1 = new CasV11Store(storeRoot, { forceJsonlFallback: true });
      try {
        const put = store1.putBlob('sidecar-debug-symbols', {
          kind: 'sidecar',
          meta: { buildId: 'b8g-test-1' },
        });
        digest = put.sha512;
        store1.registerProject(projectDir);
        assert.equal(store1.stats().backend, 'jsonl');
      } finally {
        store1.close();
      }

      const store2 = new CasV11Store(storeRoot, { forceJsonlFallback: true });
      try {
        const stats = store2.stats();
        assert.equal(stats.backend, 'jsonl');
        assert.equal(stats.blobCount, 1);
        assert.equal(stats.projectCount, 1);
        assert.deepEqual(store2.getBlobMeta(digest)?.meta, { buildId: 'b8g-test-1' });
        assert.equal(store2.listProjects()[0]?.path, path.resolve(projectDir));
      } finally {
        store2.close();
      }
    });
  });
});
