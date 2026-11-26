import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CasV11Store } from './cas-v11-store.mts';
import { installHoloPmBin } from './holo-pm-install.mts';

describe('holo-pm install (local ./bin/ hardlink default + collision-guarded -g global)', () => {
  it('hardlinks directly into ./bin/<tool> and stamps ./holo-compiler-lockfile.json with zero global collisions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-pm-local-'));
    const casRoot = path.join(tmp, 'cas');
    const projA = path.join(tmp, 'proj-a');
    const projB = path.join(tmp, 'proj-b');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });

    try {
      const store = new CasV11Store(casRoot);
      const bin26 = store.putBlob(new TextEncoder().encode('NODE-26-BIN'), { kind: 'bin', executable: true });
      const bin27 = store.putBlob(new TextEncoder().encode('NODE-27-BIN'), { kind: 'bin', executable: true });
      store.close();

      const recA = installHoloPmBin({
        uri: 'repository://github.com/awesome-os/node@v0.3.0',
        binName: 'node.exe',
        sha512: bin26.sha512,
        casRoot,
        cwd: projA,
      });
      const recB = installHoloPmBin({
        uri: 'repository://github.com/awesome-os/node@v0.4.0',
        binName: 'node.exe',
        sha512: bin27.sha512,
        casRoot,
        cwd: projB,
      });

      assert.equal(recA.scope, 'local');
      assert.equal(recB.scope, 'local');
      assert.equal(fs.statSync(recA.binPath).ino, fs.statSync(bin26.path).ino);
      assert.equal(fs.statSync(recB.binPath).ino, fs.statSync(bin27.path).ino);
      assert.equal(fs.existsSync(recA.lockfilePath!), true);
      assert.equal(fs.existsSync(recB.lockfilePath!), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses silent overwrite on global -g collision unless --as alias or --force-default is passed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-pm-global-'));
    const casRoot = path.join(tmp, 'cas');
    const gBin = path.join(tmp, 'global-bin');

    try {
      const store = new CasV11Store(casRoot);
      const b1 = store.putBlob(new TextEncoder().encode('JQ-V1'), { kind: 'bin', executable: true });
      const b2 = store.putBlob(new TextEncoder().encode('JQ-V2'), { kind: 'bin', executable: true });
      store.close();

      installHoloPmBin({
        uri: 'repository://github.com/awesome-os/holo-compiler@main',
        binName: 'jq.exe',
        sha512: b1.sha512,
        casRoot,
        global: true,
        globalBinDir: gBin,
      });

      // Second repo trying to claim global `jq.exe` MUST fail cleanly
      assert.throws(
        () =>
          installHoloPmBin({
            uri: 'repository://github.com/awesome-os/other-jq@main',
            binName: 'jq.exe',
            sha512: b2.sha512,
            casRoot,
            global: true,
            globalBinDir: gBin,
          }),
        /holo-pm collision/,
      );

      // Using --as alias succeeds cleanly
      const aliased = installHoloPmBin({
        uri: 'repository://github.com/awesome-os/other-jq@main',
        binName: 'jq.exe',
        alias: 'other-jq.exe',
        sha512: b2.sha512,
        casRoot,
        global: true,
        globalBinDir: gBin,
      });
      assert.ok(aliased.binPath.endsWith('other-jq.exe'));

      // Explicit forceDefault (`holo-pm use`) switches ownership cleanly
      const switched = installHoloPmBin({
        uri: 'repository://github.com/awesome-os/other-jq@main',
        binName: 'jq.exe',
        sha512: b2.sha512,
        casRoot,
        global: true,
        globalBinDir: gBin,
        forceDefault: true,
      });
      assert.equal(fs.statSync(switched.binPath).ino, fs.statSync(b2.path).ino);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
