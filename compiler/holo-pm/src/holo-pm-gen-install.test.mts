/**
 * @file src/holo-pm-gen-install.test.mts
 * @description Unit tests for `holo-pm-gen-install.mts`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  B8G_ABI_MAGIC_V3,
  generateInstallerBundle,
  renderHoloInstallPs1,
  renderHoloInstallSh,
  renderSplashHeader,
  type GenInstallSpec,
} from './holo-pm-gen-install.mts';

const SAMPLE_SPEC: GenInstallSpec = {
  id: 'holo-pm',
  displayName: 'Holo Package Manager',
  repo: 'awesome-os/holo-pm',
  version: '0.4.0',
  binaryName: 'holo-pm',
  isGui: false,
  splashTitle: 'Holo PM',
  splashSubtitle: 'Sovereign v11 CAS',
};

test('B8G_ABI_MAGIC_V3 matches canonical 0x33564742', () => {
  assert.equal(B8G_ABI_MAGIC_V3, '0x33564742');
});

test('renderHoloInstallPs1 is BOM-free, zero top-level param(, and uses v11 CAS + SHA512 + HardLink', () => {
  const ps1 = renderHoloInstallPs1(SAMPLE_SPEC);
  const buf = Buffer.from(ps1, 'utf8');

  assert.notEqual(buf[0], 0xef, 'install.ps1 must not start with a UTF-8 BOM');
  assert.doesNotMatch(ps1, /^\s*param\s*\(/im, 'install.ps1 must not contain top-level param(');
  assert.doesNotMatch(ps1, /param\s*\(/i, 'install.ps1 must avoid param( for irm|iex safety');

  assert.match(ps1, /\$env:HOLO_CAS_DIR/);
  assert.match(ps1, /\$env:B8G_GHOST_CACHE_DIR/);
  assert.match(ps1, /v11\/files/);
  assert.match(ps1, /Get-FileHash\b.*-Algorithm\s+SHA512/);
  assert.match(ps1, /New-Item\s+-ItemType\s+HardLink/);
  assert.match(ps1, /Copy-Item/);
});

test('renderHoloInstallSh uses HOLO_CAS_DIR, v11/files, sha512sum / shasum -a 512, and ln -f', () => {
  const sh = renderHoloInstallSh(SAMPLE_SPEC);

  assert.ok(sh.startsWith('#!/bin/sh\n'), 'install.sh must start with POSIX #!/bin/sh');
  assert.match(sh, /HOLO_CAS_DIR/);
  assert.match(sh, /B8G_GHOST_CACHE_DIR/);
  assert.match(sh, /v11\/files/);
  assert.match(sh, /sha512sum/);
  assert.match(sh, /shasum -a 512/);
  assert.match(sh, /ln -f/);
  assert.match(sh, /cp -f/);
});

test('renderSplashHeader stamps 0x33564742, app metadata, and centered 460x220 DPI-aware coordinates', () => {
  const header = renderSplashHeader(SAMPLE_SPEC);

  assert.match(header, /0x33564742/);
  assert.match(header, /#define\s+B8G_ABI_MAGIC_V3\s+0x33564742U/);
  assert.match(header, /#define\s+AWESOME_APP_ID\s+"holo-pm"/);
  assert.match(header, /#define\s+AWESOME_APP_VERSION\s+"0\.4\.0"/);
  assert.match(header, /#define\s+AWESOME_SPLASH_BASE_WIDTH\s+460/);
  assert.match(header, /#define\s+AWESOME_SPLASH_BASE_HEIGHT\s+220/);
  assert.match(header, /awesome_splash_compute_rect/);
});

test('generateInstallerBundle writes install.ps1 (no BOM), install.sh, and splash_layout.h cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-pm-gen-install-'));
  try {
    const receipt = generateInstallerBundle(SAMPLE_SPEC, tmpDir);

    assert.equal(receipt.outDir, path.resolve(tmpDir));
    assert.equal(receipt.files.length, 3);

    const ps1Path = path.join(tmpDir, 'install.ps1');
    const shPath = path.join(tmpDir, 'install.sh');
    const headerPath = path.join(tmpDir, 'splash_layout.h');

    assert.deepEqual(receipt.files, [ps1Path, shPath, headerPath]);
    assert.ok(fs.existsSync(ps1Path));
    assert.ok(fs.existsSync(shPath));
    assert.ok(fs.existsSync(headerPath));

    const ps1Bytes = fs.readFileSync(ps1Path);
    assert.notEqual(ps1Bytes[0], 0xef, 'on-disk install.ps1 must have no UTF-8 BOM');

    const shText = fs.readFileSync(shPath, 'utf8');
    assert.ok(!shText.includes('\r\n'), 'install.sh must use LF line endings');

    const headerText = fs.readFileSync(headerPath, 'utf8');
    assert.match(headerText, /0x33564742/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI entrypoint holo-pm-gen-install <id> <repo> <version> <outDir> generates all 3 files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-pm-gen-install-cli-'));
  try {
    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'holo-pm-gen-install.mts',
    );
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, 'sectium-cli', 'awesome-os/sectium', '1.2.3', tmpDir],
      { encoding: 'utf8' },
    );

    const parsed = JSON.parse(stdout) as { outDir: string; files: string[] };
    assert.equal(parsed.outDir, path.resolve(tmpDir));
    assert.equal(parsed.files.length, 3);
    for (const f of parsed.files) {
      assert.ok(fs.existsSync(f), `Expected generated file to exist: ${f}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
