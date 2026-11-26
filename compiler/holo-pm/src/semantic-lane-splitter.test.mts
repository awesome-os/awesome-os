import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyPackageFile,
  splitAndProjectPackage,
} from './semantic-lane-splitter.mts';

describe('holo-pm 2-lane semantic splitter (repository/<eco>/ + assets/<target>-<abi>/)', () => {
  it('routes cross-language Rust+TS+PyO3+binary files into clean semantic lanes', () => {
    assert.equal(
      classifyPackageFile('src/lib.rs', 'my-crate', 'cargo', 'win64').destRelPath,
      'repository/cargo/my-crate/src/lib.rs',
    );
    assert.equal(
      classifyPackageFile('bindings/index.ts', 'my-crate', 'cargo', 'win64').destRelPath,
      'repository/npm/cargo/my-crate/bindings/index.ts',
    );
    assert.equal(
      classifyPackageFile('python/mod.py', 'my-crate', 'cargo', 'win64').destRelPath,
      'repository/pypi/cargo/my-crate/python/mod.py',
    );
    assert.equal(
      classifyPackageFile('build/addon.node', 'my-crate', 'cargo', 'win64').destRelPath,
      'assets/win64-napi/my-crate/addon.node',
    );
    assert.equal(
      classifyPackageFile('wheel/fast.abi3.pyd', 'numpy', 'pypi', 'win64').destRelPath,
      'assets/win64-abi3/numpy/fast.abi3.pyd',
    );
  });

  it('hardlinks text into repository/ and hits prebuilt v11 binaries in assets/ without rebuilding', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-pm-lanes-'));
    const casRoot = path.join(tmp, 'cas');
    const outRoot = path.join(tmp, 'proj');
    const enc = new TextEncoder();

    try {
      // Pre-seed a prebuilt native `.node` addon in v11 CAS
      const prebuiltBytes = enc.encode('PREBUILT-NAPI-ADDON-BYTES');
      const prebuiltSha = createHash('sha512').update(prebuiltBytes).digest('hex');
      const prebuiltBlob = path.join(casRoot, 'v11', 'files', prebuiltSha.slice(0, 2), `${prebuiltSha}-exec`);
      fs.mkdirSync(path.dirname(prebuiltBlob), { recursive: true });
      fs.writeFileSync(prebuiltBlob, prebuiltBytes);

      const receipt = splitAndProjectPackage({
        pkgName: 'b8g-fast',
        primaryEco: 'cargo',
        target: 'win64',
        casRoot,
        outputRoot: outRoot,
        lockfileEntries: [
          { repo: 'b8g-fast', filename: 'b8g-fast.node', target: 'win64', abi: 'napi', sha512: prebuiltSha },
        ],
        files: [
          { relPath: 'src/lib.rs', bytes: enc.encode('pub fn magic() -> u32 { 0x33564742 }\n') },
          { relPath: 'README.md', bytes: enc.encode('# b8g-fast\n') },
          { relPath: 'index.ts', bytes: enc.encode('export declare function magic(): number;\n') },
          { relPath: 'native/b8g-fast.node', bytes: enc.encode('SHOULD-BE-SKIPPED-BY-PREBUILT') },
        ],
      });

      assert.equal(receipt.textProjected, 3);
      assert.equal(receipt.binariesProjected, 1);
      assert.equal(receipt.prebuiltHits, 1);
      assert.equal(receipt.hardlinkedCount, 4);
      assert.ok(receipt.repositoryPaths.includes('repository/cargo/b8g-fast/src/lib.rs'));
      assert.ok(receipt.repositoryPaths.includes('repository/npm/cargo/b8g-fast/index.ts'));
      assert.ok(receipt.assetPaths.includes('assets/win64-napi/b8g-fast/b8g-fast.node'));

      // Verify projected binary is a 0-byte hardlink to the prebuilt v11 blob
      const projectedAddon = path.join(outRoot, 'assets', 'win64-napi', 'b8g-fast', 'b8g-fast.node');
      assert.equal(fs.statSync(projectedAddon).ino, fs.statSync(prebuiltBlob).ino);
      assert.equal(fs.readFileSync(projectedAddon, 'utf8'), 'PREBUILT-NAPI-ADDON-BYTES');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
