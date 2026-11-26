import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  APT_DPKG_PROJECTOR_SCHEMA,
  projectCrostiniAptDpkg,
  verifyAptPackageSonameAbi,
} from './apt-dpkg-projector.mts';

function sha512Of(label: string): string {
  return createHash('sha512').update(label, 'utf8').digest('hex');
}

describe('Rootless Crostini apt/dpkg virtual-provides projector', () => {
  it('projects deterministic dpkg/status + .list files into a rootless sysroot with v11 CAS paths', () => {
    const sysroot = mkdtempSync(join(tmpdir(), 'crostini-dpkg-'));
    try {
      const sslHash = sha512Of('libssl.so.3@4.1.0');
      const zstdHash = sha512Of('libzstd.so.1@1.5.7');

      const proj = projectCrostiniAptDpkg(
        [
          {
            package: 'libzstd1',
            version: '1.5.7-holov11',
            architecture: 'amd64',
            soname: 'libzstd.so.1',
            elfHeaderSoname: 'libzstd.so.1',
            v11Sha512: zstdHash,
            provides: ['libzstd-v11'],
          },
          {
            package: 'libssl3t64',
            version: '4.1.0-holov11',
            architecture: 'amd64',
            soname: 'libssl.so.3',
            expectedSoname: 'libssl.so.3',
            elfHeaderSoname: 'libssl.so.3',
            v11Sha512: sslHash,
            provides: ['libssl3'],
            depends: ['libc6 (>= 2.38)'],
          },
        ],
        {
          sysrootDir: sysroot,
          expectedSonames: {
            libssl3t64: 'libssl.so.3',
            libzstd1: 'libzstd.so.1',
          },
        },
      );

      assert.equal(proj.schema, APT_DPKG_PROJECTOR_SCHEMA);
      assert.equal(proj.rootless, true);
      assert.equal(proj.packages.length, 2);
      // Byte-sorted order: libssl3t64 before libzstd1
      assert.equal(proj.packages[0].package, 'libssl3t64');
      assert.equal(proj.packages[1].package, 'libzstd1');
      assert.equal(proj.writtenPaths.length, 3);

      const statusDisk = readFileSync(join(sysroot, 'var', 'lib', 'dpkg', 'status'), 'utf8');
      assert.equal(statusDisk, proj.statusText);
      assert.match(statusDisk, /Status: install ok installed/);
      assert.match(statusDisk, /Provides: holo-v11-libssl3t64, libssl3/);
      assert.match(statusDisk, /X-Holo-CAS-Store: v11/);
      assert.match(statusDisk, new RegExp(`X-Holo-CAS-Path: /var/lib/b8g/cas/v11/files/${sslHash.slice(0, 2)}/${sslHash}`));
      assert.match(statusDisk, /X-Holo-ELF-SONAME: libssl\.so\.3/);

      const sslList = readFileSync(join(sysroot, 'var', 'lib', 'dpkg', 'info', 'libssl3t64.list'), 'utf8');
      assert.match(sslList, /^\/\.$/m);
      assert.match(sslList, /^\/usr\/lib\/x86_64-linux-gnu$/m);
      assert.match(sslList, /^\/usr\/lib\/x86_64-linux-gnu\/libssl\.so\.3$/m);
    } finally {
      rmSync(sysroot, { recursive: true, force: true });
    }
  });

  it('rejects mismatched SONAME ABI (expectedSoname or ELF DT_SONAME)', () => {
    const validHash = sha512Of('libcairo.so.2@1.18.4');
    assert.throws(
      () =>
        projectCrostiniAptDpkg(
          [
            {
              package: 'libcairo2',
              version: '1.18.4-holov11',
              architecture: 'amd64',
              soname: 'libcairo.so.1',
              v11Sha512: validHash,
            },
          ],
          { expectedSonames: { libcairo2: 'libcairo.so.2' } },
        ),
      /SONAME ABI mismatch/,
    );

    assert.throws(
      () =>
        verifyAptPackageSonameAbi({
          package: 'libpixman-1-0',
          version: '0.46.0-holov11',
          architecture: 'amd64',
          soname: 'libpixman-1.so.0',
          elfHeaderSoname: 'libpixman-1.so.99',
          v11Sha512: validHash,
        }),
      /ELF DT_SONAME mismatch/,
    );
  });

  it('rejects missing or invalid v11 SHA-512 hash and invalid ELF SONAME format', () => {
    assert.throws(
      () =>
        projectCrostiniAptDpkg([
          {
            package: 'libxml2',
            version: '2.13.8-holov11',
            architecture: 'amd64',
            soname: 'libxml2.so.2',
            v11Sha512: '',
          },
        ]),
      /missing or invalid v11 SHA-512 hash/i,
    );

    assert.throws(
      () =>
        projectCrostiniAptDpkg([
          {
            package: 'libxml2',
            version: '2.13.8-holov11',
            architecture: 'amd64',
            soname: 'not-a-valid-soname',
            v11Sha512: sha512Of('libxml2'),
          },
        ]),
      /missing or invalid mandatory ELF SONAME/i,
    );
  });
});
