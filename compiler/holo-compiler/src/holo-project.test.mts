import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CasV11Store } from './cas-v11-store.mts';
import { parseProjectUri, runHoloProject } from './holo-project.mts';

describe('project:// protocol & universal holo-project runner', () => {
  it('parses project:// URIs for shorthand runtimes, holo-* names, legacy aliases, and repository:// origins', () => {
    const goProj = parseProjectUri(
      'project://go/gitaly?from=repository://github.com/awesome-os/gitaly@main#internal/casv11&target=win64',
    );
    assert.equal(goProj.projection.id, 'holo-go');
    assert.equal(goProj.entry, 'gitaly');
    assert.equal(goProj.fromRepository?.repo, 'gitaly');
    assert.equal(goProj.fromRepository?.subpath, 'internal/casv11');
    assert.equal(goProj.target, 'win64');
    assert.equal(goProj.mode, 'ephemeral');

    const nodeProj = parseProjectUri('project://holo-node/app.mts?mode=persistent');
    assert.equal(nodeProj.projection.id, 'holo-node');
    assert.equal(nodeProj.mode, 'persistent');

    const legacyPy = parseProjectUri('project://ghost-py/train.py');
    assert.equal(legacyPy.projection.id, 'holo-py');
  });

  it('rejects path traversal, unknown runtimes, and B8G016 loopback from= repositories', () => {
    assert.throws(() => parseProjectUri('http://node/app.mts'));
    assert.throws(() => parseProjectUri('project://node/../../etc/passwd'));
    assert.throws(() => parseProjectUri('project://unknown-lang/main'));
    assert.throws(() =>
      parseProjectUri('project://node/app.mts?from=repository://127.0.0.1/awesome-os/models@main'),
    );
  });

  it('projects v11 CAS blobs via 0-byte hardlinks, executes, and purges ephemeral projection dir cleanly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-project-test-'));
    try {
      const store = new CasV11Store(tmp);
      const put = store.putBlob(new TextEncoder().encode('export const answer = 42;\n'), {
        kind: 'object',
      });
      store.close();

      let observedIno = 0;
      const receipt = await runHoloProject('project://node/app.mts?mode=ephemeral', {
        casRoot: tmp,
        blobs: [{ relPath: 'app.mts', sha512: put.sha512 }],
        executor: ({ projectionDir, hardlinkedCount }) => {
          const projected = path.join(projectionDir, 'app.mts');
          assert.equal(fs.existsSync(projected), true);
          assert.equal(hardlinkedCount, 1);
          observedIno = fs.statSync(projected).ino;
          return fs.readFileSync(projected, 'utf8').trim();
        },
      });

      assert.equal(receipt.projectionId, 'holo-node');
      assert.equal(receipt.abiMagic, '0x33564742');
      assert.equal(receipt.projectedCount, 1);
      assert.equal(receipt.hardlinkedCount, 1);
      assert.equal(observedIno, fs.statSync(put.path).ino);
      assert.equal(receipt.output, 'export const answer = 42;');
      assert.equal(receipt.purged, true);
      assert.equal(fs.existsSync(receipt.projectionDir), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
