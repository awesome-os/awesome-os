/**
 * @file sections/sectium-maintenance/gh-cas-bridge.mts
 * @description GitHub Releases .b8p CAS Bridge — uses public GitHub Releases
 * (`awesome-os/sectium-distributions`) as a zero-cost, global CDN-backed CAS
 * registry for .b8p packs and cross-compiled multi-OS artifacts.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = resolve(__dirname, '..', '..');
export const DEFAULT_DIST_REPO = 'awesome-os/sectium-distributions';

export interface CasArtifactEntry {
  readonly name: string;
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly downloadUrl: string;
}

export interface ReleaseCasManifest {
  readonly schema: 'b8g-gh-cas-v1';
  readonly repo: string;
  readonly tag: string;
  readonly generatedAt: string;
  readonly artifacts: CasArtifactEntry[];
}

export interface PullSummary {
  readonly hits: number;
  readonly downloaded: number;
  readonly totalBytes: number;
}

export const DEFAULT_RELEASE_ARTIFACTS: readonly string[] = [
  'sections/sectium-display/dist/libsectium_display.wasm',
  'sections/sectium-display/dist/libsectium_display-linux-x64.so',
  'sections/sectium-display/dist/libsectium_display-linux-arm64.so',
  'sections/sectium-display/dist/libsectium_display.dll',
  'sections/sectium-display/dist/libsectium_display-macos-arm64.dylib',
  'sections/b8g-native-shim/dist/b8g-shim-linux-x64',
  'sections/b8g-native-shim/dist/b8g-shim-linux-arm64',
  'sections/b8g-native-shim/dist/b8g-shim-macos-arm64',
  'sections/b8g-algebra-router/dist/algebra-router.b8p',
  'www-public-websites/b8g.app/releases/b8g-production-rack-linux-x64.tar.gz',
  'www-public-websites/b8g.app/releases/b8g-production-rack-linux-arm64.tar.gz',
  'www-public-websites/b8g.app/releases/manifest.json',
];

export function sha256Bytes(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function buildReleaseCasManifest(opts: {
  readonly tag: string;
  readonly repo?: string;
  readonly root?: string;
  readonly relPaths?: readonly string[];
}): ReleaseCasManifest {
  const repo = opts.repo ?? DEFAULT_DIST_REPO;
  const root = opts.root ?? WORKSPACE_ROOT;
  const relPaths = opts.relPaths ?? DEFAULT_RELEASE_ARTIFACTS;
  const artifacts: CasArtifactEntry[] = [];

  for (const relPath of relPaths) {
    const absPath = resolve(root, relPath);
    if (!existsSync(absPath)) continue;
    const data = readFileSync(absPath);
    const name = basename(absPath);
    artifacts.push({
      name,
      relPath,
      sizeBytes: statSync(absPath).size,
      sha256: sha256Bytes(data),
      downloadUrl: `https://github.com/${repo}/releases/download/${opts.tag}/${name}`,
    });
  }

  return {
    schema: 'b8g-gh-cas-v1',
    repo,
    tag: opts.tag,
    generatedAt: new Date().toISOString(),
    artifacts,
  };
}

export async function pullFromReleaseCas(
  manifest: ReleaseCasManifest,
  cacheDir: string,
  fetcher: (url: string) => Promise<Uint8Array>,
): Promise<PullSummary> {
  mkdirSync(cacheDir, { recursive: true });
  let hits = 0;
  let downloaded = 0;
  let totalBytes = 0;

  for (const art of manifest.artifacts) {
    const targetPath = join(cacheDir, art.name);
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath);
      if (sha256Bytes(existing) === art.sha256) {
        hits++;
        totalBytes += existing.byteLength;
        continue;
      }
    }

    const bytes = await fetcher(art.downloadUrl);
    const actualHash = sha256Bytes(bytes);
    if (actualHash !== art.sha256) {
      throw new Error(
        `[gh-cas-bridge] SHA-256 mismatch for ${art.name}: expected ${art.sha256}, got ${actualHash}`,
      );
    }
    writeFileSync(targetPath, bytes);
    downloaded++;
    totalBytes += bytes.byteLength;
  }

  return { hits, downloaded, totalBytes };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2] ?? 'manifest';
  const tag = process.argv[3] ?? 'v0.2.0-cas';
  if (cmd === 'manifest') {
    const manifest = buildReleaseCasManifest({ tag });
    const outPath = join(__dirname, 'dist', 'cas-manifest.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const totalKb = (manifest.artifacts.reduce((s, a) => s + a.sizeBytes, 0) / 1024).toFixed(1);
    console.log(
      `[gh-cas-bridge] Emitted ${outPath} (${manifest.artifacts.length} artifacts, ${totalKb} KB total, tag=${tag})`,
    );
  } else {
    console.log('Usage: gh-cas-bridge.mts manifest [tag]');
  }
}
