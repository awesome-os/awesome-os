import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface ReleaseArtifact {
  id: string;
  component: string;
  filename: string;
  repoPath: string;
  target: string;
  format: string;
  repo: string;
  url: string;
  bytes: number;
  sha256: string;
}

interface ReleaseManifest {
  schemaVersion: number;
  planeVersion: string;
  releaseChannel: string;
  channels: string[];
  abiMagic: string;
  abiVersion: number;
  manifestUrl: string;
  installers: {
    powershell: string;
    posix: string;
  };
  repos: Record<string, string>;
  artifacts: ReleaseArtifact[];
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '..', '..');
const SITE_DIR = resolve(REPO_ROOT, 'site', 'awesome-os.com');
const MANIFEST_PATH = resolve(SITE_DIR, 'release-manifest.json');
const INSTALL_PS1_PATH = resolve(SITE_DIR, 'install.ps1');
const INSTALL_SH_PATH = resolve(SITE_DIR, 'install.sh');

const REQUIRED_REPO_PATHS: readonly string[] = [
  'sections/b8g-es/dist/sectium-es.exe',
  'sections/b8g-es/dist/sectium-es',
  'sections/b8g-es/dist/sectium-es-linux-arm64',
  'sections/b8g-es/dist/sectium-es-macos-arm64',
  'sections/b8g-jvm/dist/sectium-jvm.exe',
  'sections/b8g-jvm/dist/sectium-jvm',
  'sections/b8g-jvm/dist/sectium-jvm-linux-arm64',
  'sections/b8g-jvm/dist/sectium-jvm-macos-arm64',
  'sections/b8g-jvm/dist/sectium-jvm.wasm',
  'sections/sectium-cloud-control-plane/dist/sectium_cp.dll',
  'sections/sectium-cloud-control-plane/dist/libsectium_cp.so',
  'sections/sectium-cloud-control-plane/dist/libsectium_cp-linux-arm64.so',
  'sections/sectium-cloud-control-plane/dist/libsectium_cp-macos-arm64.dylib',
  'sections/sectium-cloud-control-plane/dist/sectium_cp.wasm',
];

const EXPECTED_MAGIC_BY_FORMAT: Readonly<Record<string, readonly number[]>> = {
  pe64: [0x4d, 0x5a],
  'pe64-dll': [0x4d, 0x5a],
  elf64: [0x7f, 0x45, 0x4c, 0x46],
  'elf64-so': [0x7f, 0x45, 0x4c, 0x46],
  macho64: [0xcf, 0xfa, 0xed, 0xfe],
  'macho64-dylib': [0xcf, 0xfa, 0xed, 0xfe],
  'wasm32-wasi': [0x00, 0x61, 0x73, 0x6d],
};

function computeFileSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('Gate 1: Zero-Gatekeeper Web One-Liner Installers & Release Manifest', () => {
  it('1. release-manifest.json contains required plane metadata, ABI v3 magic, repos, and all 14 live multi-arch binary digests + magic bytes', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ReleaseManifest;

    assert.equal(manifest.planeVersion, '0.2.0');
    assert.equal(manifest.releaseChannel, 'rolling');
    assert.equal(manifest.abiMagic, '0x33564742');
    assert.equal(manifest.abiVersion, 3);
    assert.equal(manifest.repos['sectium-es'], 'awesome-os/sectium-es');
    assert.equal(manifest.repos['sectium-jvm'], 'awesome-os/sectium-jvm');
    assert.equal(manifest.repos['awesome-os'], 'awesome-os/awesome-os');

    const manifestPaths = new Set(manifest.artifacts.map((art) => art.repoPath));
    for (const requiredPath of REQUIRED_REPO_PATHS) {
      assert.ok(manifestPaths.has(requiredPath), `Missing artifact entry for ${requiredPath}`);
    }

    for (const art of manifest.artifacts) {
      const absBinPath = resolve(REPO_ROOT, art.repoPath);
      const stat = statSync(absBinPath);
      const rawBytes = readFileSync(absBinPath);
      const actualSha = computeFileSha256(rawBytes);

      assert.equal(
        art.bytes,
        stat.size,
        `Byte size mismatch for ${art.repoPath}: manifest=${art.bytes}, disk=${stat.size}`,
      );
      assert.match(art.sha256, /^[0-9a-f]{64}$/, `Invalid sha256 hex for ${art.repoPath}`);
      assert.equal(
        art.sha256,
        actualSha,
        `SHA-256 mismatch for ${art.repoPath}: manifest=${art.sha256}, disk=${actualSha}`,
      );

      const expectedMagic = EXPECTED_MAGIC_BY_FORMAT[art.format];
      assert.ok(expectedMagic, `Unknown binary format "${art.format}" for ${art.repoPath}`);
      const actualMagic = [...rawBytes.subarray(0, expectedMagic.length)];
      assert.deepEqual(
        actualMagic,
        [...expectedMagic],
        `Magic bytes mismatch for ${art.repoPath} (${art.format}): expected=${expectedMagic.map((b) => b.toString(16).padStart(2, '0')).join(' ')}, actual=${actualMagic.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
      );
    }
  });

  it('2. site/awesome-os.com/install.ps1 executes cleanly in -DryRun mode via powershell.exe (shell: false)', () => {
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_PS1_PATH, '-DryRun'],
      {
        cwd: REPO_ROOT,
        shell: false,
        encoding: 'utf8',
      },
    );

    assert.match(stdout, /\[SECTIUM\]/);
    assert.match(stdout, /channel=rolling/);
    assert.match(stdout, /0x33564742/);
    assert.match(stdout, /\[DRY-RUN\]/);
    assert.match(stdout, /sectium-es\.exe/);
    assert.match(stdout, /sectium-jvm\.exe/);
    assert.match(stdout, /sectium_cp\.dll/);
    assert.match(stdout, /\[DONE\] Dry-run complete/);

    const ps1Source = readFileSync(INSTALL_PS1_PATH, 'utf8');
    assert.match(ps1Source, /Zone\.Identifier/);
    assert.match(ps1Source, /Get-FileHash\s+-Algorithm\s+SHA256/);
    assert.match(ps1Source, /zig/i);
    assert.match(ps1Source, /SetEnvironmentVariable\('Path'/);
  });

  it('3. site/awesome-os.com/install.ps1 supports -Channel stable and custom -Dir in -DryRun mode', () => {
    const customDir = 'C:\\SectiumTest\\bin';
    const stdout = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        INSTALL_PS1_PATH,
        '-DryRun',
        '-Channel',
        'stable',
        '-Dir',
        customDir,
      ],
      {
        cwd: REPO_ROOT,
        shell: false,
        encoding: 'utf8',
      },
    );

    assert.match(stdout, /channel=stable/);
    assert.ok(stdout.includes(customDir), `Expected custom dir ${customDir} in dry-run output`);
    assert.match(stdout, /https:\/\/awesome-os\.com\/releases\/stable\/sectium-es\.exe/);
  });

  it('4. site/awesome-os.com/install.sh has valid POSIX shebang, --dry-run, SHA-256 verification, zig cc, and Apple Silicon ad-hoc signing', () => {
    const shSource = readFileSync(INSTALL_SH_PATH, 'utf8');

    assert.ok(shSource.startsWith('#!/bin/sh\n'), 'install.sh must begin with #!/bin/sh');
    assert.match(shSource, /set -eu/);
    assert.match(shSource, /--dry-run/);
    assert.match(shSource, /--dir/);
    assert.match(shSource, /--channel/);
    assert.match(shSource, /sha256sum/);
    assert.match(shSource, /shasum -a 256/);
    assert.match(shSource, /zig cc -std=c11/);
    assert.match(shSource, /com\.apple\.quarantine/);
    assert.match(shSource, /codesign --force --sign -/);
    assert.match(shSource, /\$HOME\/\.sectium\/bin|\$\{HOME\}\/\.sectium\/bin/);
  });
});
