/**
 * @file scripts/build-web-bundle.mts
 * @description Generates Ed25519 + SHA-512 signed web/v11-bundle.json and stages
 * verified AwesomeOS artifacts (sectium_cp.wasm, awesomeos-shell.html, max-version-lock.json,
 * ECOSYSTEM-SCOREBOARD.md) into web/blobs/ for https://awesome-os.com/install/.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { signManifestEd25519 } from '../../awesome-os/security/verified-boot.mts';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKSPACE_ROOT = resolve(REPO_ROOT, '..', '..', '..');
const BLOBS_DIR = join(REPO_ROOT, 'web', 'blobs');

interface BundleSource {
  readonly id: string;
  readonly fileName: string;
  readonly installPath: string;
  readonly description: string;
  readonly srcPath: string;
}

const SOURCES: readonly BundleSource[] = [
  {
    id: 'sectium-control-plane-wasi',
    fileName: 'sectium_cp.wasm',
    installPath: 'runtime/sectium_cp.wasm',
    description: 'Collapsed 5.7 KB B8G_ABI_MAGIC_V3 WASI control plane binary',
    srcPath: join(WORKSPACE_ROOT, 'sections', 'sectium-cloud-control-plane', 'dist', 'sectium_cp.wasm'),
  },
  {
    id: 'awesomeos-chromeos-shell',
    fileName: 'awesomeos-shell.html',
    installPath: 'shell/awesomeos-shell.html',
    description: 'Zero-server ChromeOS-grade AwesomeOS Desktop Shell (Sectium + Crostini + Powerwash)',
    srcPath: join(WORKSPACE_ROOT, 'github-mirror', 'awesome-os', 'awesome-os', 'os', 'shell', 'awesomeos-shell.html'),
  },
  {
    id: 'max-version-lock',
    fileName: 'max-version-lock.json',
    installPath: 'manifest/max-version-lock.json',
    description: 'Unified V8 16+ & ahead-of-Chrome dependency version lockfile',
    srcPath: join(WORKSPACE_ROOT, 'github-mirror', 'awesome-os', 't2linux-baseline', 'catalog', 'max-version-lock.json'),
  },
  {
    id: 'ecosystem-scoreboard',
    fileName: 'ECOSYSTEM-SCOREBOARD.md',
    installPath: 'docs/ECOSYSTEM-SCOREBOARD.md',
    description: 'Live Big Boys v11 CAS overlap & version scoreboard',
    srcPath: join(WORKSPACE_ROOT, 'github-mirror', 'awesome-os', 'holo-v11', 'reports', 'ECOSYSTEM-SCOREBOARD.md'),
  },
];

mkdirSync(BLOBS_DIR, { recursive: true });

const artifacts = SOURCES.map((s) => {
  const dst = join(BLOBS_DIR, s.fileName);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(s.srcPath, dst);
  const buf = readFileSync(dst);
  const sha512 = createHash('sha512').update(buf).digest('hex');
  return {
    id: s.id,
    path: s.installPath,
    size: buf.byteLength,
    url: `./blobs/${s.fileName}`,
    installPath: s.installPath,
    description: s.description,
    bytes: buf.byteLength,
    sha512,
  };
});

const signedBundle = signManifestEd25519({
  schema: 'awesome-os.web-v11-bundle.v1',
  abiMagic: '0x33564742',
  casLayout: 'v11',
  generatedAt: new Date().toISOString(),
  artifacts,
});

writeFileSync(join(REPO_ROOT, 'web', 'v11-bundle.json'), JSON.stringify(signedBundle, null, 2) + '\n', 'utf8');
console.log(
  `Stamped Ed25519-signed web/v11-bundle.json (key=${signedBundle.signature.keyId}, artifacts=${artifacts.length}).`,
);
