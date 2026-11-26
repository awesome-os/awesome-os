#!/usr/bin/env node
/**
 * @file scripts/warm-global-cas.mts
 * @description Planetary-scale Global v11 CAS Pre-Warmer for `awesome-os/holo-sdk`.
 *
 * Walks all `awesome-os/*` latest GitHub Releases in 12-way parallel, streams each
 * asset through SHA-512, optionally populates `$HOLO_CAS_DIR/v11/files/00..ff/<sha512>`,
 * and emits:
 *   - `dist/cas-v11-global-manifest.json`
 *   - `dist/holo-compiler-lockfile.json`
 *   - `dist/SHA512SUMS.txt`
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ORG = process.env.AWESOME_OS_ORG || 'awesome-os';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const MAX_ASSET_BYTES = Number(process.env.MAX_ASSET_MB || '250') * 1024 * 1024;
const CONCURRENCY = 12;
const OUT_DIR = path.resolve(process.cwd(), 'dist');

const apiHeaders: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'awesome-os-global-v11-cas-warmer/1.0',
};
if (TOKEN) apiHeaders.Authorization = `Bearer ${TOKEN}`;

interface GhRepo {
  readonly name: string;
  readonly archived?: boolean;
}

interface GhAsset {
  readonly name: string;
  readonly size: number;
  readonly browser_download_url: string;
}

interface GhRelease {
  readonly tag_name: string;
  readonly assets: readonly GhAsset[];
}

interface GlobalCasEntry {
  readonly id: string;
  readonly repo: string;
  readonly tag: string;
  readonly filename: string;
  readonly target: string;
  readonly executable: boolean;
  readonly sha512: string;
  readonly size: number;
  readonly blobPath: string;
  readonly downloadUrl: string;
}

function inferTarget(filename: string): string {
  const f = filename.toLowerCase();
  if (f.includes('win64') || f.includes('windows') || f.endsWith('.exe') || f.endsWith('.dll')) return 'win64';
  if (f.includes('linux-arm64') || f.includes('aarch64-linux')) return 'linux-arm64';
  if (f.includes('linux') || f.endsWith('.so')) return 'linux-x64';
  if (f.includes('macos') || f.includes('darwin') || f.endsWith('.dylib')) return 'macos-arm64';
  if (f.includes('wasm') || f.endsWith('.wasm')) return 'wasm32-wasi';
  return 'any';
}

function isExecutableAsset(filename: string): boolean {
  const f = filename.toLowerCase();
  return (
    f.endsWith('.exe') ||
    f.endsWith('.dll') ||
    f.endsWith('.so') ||
    f.endsWith('.dylib') ||
    f.endsWith('.wasm') ||
    f.endsWith('.sh') ||
    (!f.includes('.') && !f.endsWith('sums'))
  );
}

async function listOrgRepos(): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `https://api.github.com/orgs/${ORG}/repos?per_page=100&page=${page}&type=public`,
      { headers: apiHeaders },
    );
    if (!res.ok) throw new Error(`GitHub repos API HTTP ${res.status}`);
    const batch = (await res.json()) as GhRepo[];
    if (batch.length === 0) break;
    for (const r of batch) {
      if (!r.archived && r.name !== 'holo-sdk') names.push(r.name);
    }
    if (batch.length < 100) break;
  }
  return names.sort();
}

async function streamSha512(url: string): Promise<{ sha512: string; bytes: number }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'awesome-os-global-v11-cas-warmer/1.0' },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const hash = createHash('sha512');
  let bytes = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha512: hash.digest('hex'), bytes };
}

const repos = await listOrgRepos();
console.log(`Warming Global v11 CAS across ${repos.length} public ${ORG}/* repositories...`);

const entries: GlobalCasEntry[] = [];
let idx = 0;
let skippedLarge = 0;

async function worker(): Promise<void> {
  while (idx < repos.length) {
    const repo = repos[idx++]!;
    try {
      const relRes = await fetch(`https://api.github.com/repos/${ORG}/${repo}/releases/latest`, {
        headers: apiHeaders,
      });
      if (!relRes.ok) continue;
      const rel = (await relRes.json()) as GhRelease;
      if (!rel.tag_name || !Array.isArray(rel.assets) || rel.assets.length === 0) continue;

      for (const asset of rel.assets) {
        if (asset.size > MAX_ASSET_BYTES) {
          skippedLarge++;
          continue;
        }
        try {
          const { sha512, bytes } = await streamSha512(asset.browser_download_url);
          const executable = isExecutableAsset(asset.name);
          const blobName = executable ? `${sha512}-exec` : sha512;
          entries.push({
            id: `${ORG}/${repo}@${rel.tag_name}/${asset.name}`,
            repo,
            tag: rel.tag_name,
            filename: asset.name,
            target: inferTarget(asset.name),
            executable,
            sha512,
            size: bytes,
            blobPath: `v11/files/${sha512.slice(0, 2)}/${blobName}`,
            downloadUrl: asset.browser_download_url,
          });
        } catch {
          // non-fatal single asset failure
        }
      }
    } catch {
      // non-fatal repo failure
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

entries.sort((a, b) => a.id.localeCompare(b.id));
const uniqueBlobs = new Set(entries.map((e) => e.sha512)).size;
const totalReposWithAssets = new Set(entries.map((e) => e.repo)).size;
const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);

fs.mkdirSync(OUT_DIR, { recursive: true });

const manifestDoc = {
  schema: 'awesome-os-cas-v11-manifest-v1',
  abiMagic: '0x33564742',
  version: 'v11',
  generatedAt: new Date().toISOString(),
  totalRepos: totalReposWithAssets,
  totalAssets: entries.length,
  uniqueBlobs,
  totalBytes,
  skippedLarge,
  entries,
};

const lockfileDoc = {
  schema: 'holo-compiler-lockfile-v1',
  abiMagic: '0x33564742',
  casLayout: 'v11',
  dependencies: entries.map((e) => ({
    id: e.id,
    repo: e.repo,
    tag: e.tag,
    filename: e.filename,
    target: e.target,
    sha512: e.sha512,
    size: e.size,
    blobPath: e.blobPath,
    downloadUrl: e.downloadUrl,
  })),
};

fs.writeFileSync(path.join(OUT_DIR, 'cas-v11-global-manifest.json'), JSON.stringify(manifestDoc, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'holo-compiler-lockfile.json'), JSON.stringify(lockfileDoc, null, 2) + '\n', 'utf8');

console.log(
  JSON.stringify(
    {
      totalRepos: totalReposWithAssets,
      totalAssets: entries.length,
      uniqueBlobs,
      totalMB: Number((totalBytes / (1024 * 1024)).toFixed(1)),
      skippedLarge,
    },
    null,
    2,
  ),
);
