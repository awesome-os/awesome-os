#!/usr/bin/env node
/**
 * scripts/v11-tree-overrides.mts — Incremental Small-File v11 Override Indexer
 *
 * Reads `dist/cas-v11-global-manifest.json` (or `index/cas-v11-global-manifest.json`)
 * and builds `v11-active-overrides.json`:
 *   - Any active repo publishing `v11-tree.json` takes strict precedence over legacy
 *     monolithic tarballs (.tar.zst / .tar.gz / .zip).
 *   - Tracks incremental adoption ratio across the awesome-os org.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface GlobalEntryLike {
  repo: string;
  tag: string;
  filename: string;
  sha512: string;
  size: number;
  downloadUrl: string;
}

export interface V11OverrideReport {
  schema: 'awesome-os.v11-active-overrides.v1';
  abiMagic: '0x33564742';
  generatedAt: string;
  adoptedRepos: Array<{
    repo: string;
    tag: string;
    treeManifestUrl: string;
    treeManifestSha512: string;
    shadowedLegacyAssets: number;
  }>;
  pendingTarRepos: string[];
  adoptionCount: number;
  legacyTarRepoCount: number;
}

const LEGACY_TAR_RE = /\.(tar\.zst|tar\.gz|tar\.xz|tgz|zip)$/i;

export function buildV11OverrideReport(entries: readonly GlobalEntryLike[]): V11OverrideReport {
  const byRepo = new Map<string, GlobalEntryLike[]>();
  for (const e of entries) {
    const list = byRepo.get(e.repo) || [];
    list.push(e);
    byRepo.set(e.repo, list);
  }

  const adoptedRepos: V11OverrideReport['adoptedRepos'] = [];
  const pendingTarRepos: string[] = [];

  for (const [repo, list] of [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const tree = list.find((e) => e.filename === 'v11-tree.json');
    const tarCount = list.filter((e) => LEGACY_TAR_RE.test(e.filename)).length;
    if (tree) {
      adoptedRepos.push({
        repo,
        tag: tree.tag,
        treeManifestUrl: tree.downloadUrl,
        treeManifestSha512: tree.sha512,
        shadowedLegacyAssets: tarCount,
      });
    } else if (tarCount > 0) {
      pendingTarRepos.push(repo);
    }
  }

  return {
    schema: 'awesome-os.v11-active-overrides.v1',
    abiMagic: '0x33564742',
    generatedAt: new Date().toISOString(),
    adoptedRepos,
    pendingTarRepos,
    adoptionCount: adoptedRepos.length,
    legacyTarRepoCount: pendingTarRepos.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const manifestPath = fs.existsSync('dist/cas-v11-global-manifest.json')
    ? 'dist/cas-v11-global-manifest.json'
    : 'index/cas-v11-global-manifest.json';
  const outPath = fs.existsSync('dist') ? 'dist/v11-active-overrides.json' : 'index/v11-active-overrides.json';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = (Array.isArray(manifest.entries) ? manifest.entries : Object.values(manifest.entries || {})) as GlobalEntryLike[];
  const report = buildV11OverrideReport(entries);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`OVERRIDES ${outPath}: adopted=${report.adoptionCount} pendingTarRepos=${report.legacyTarRepoCount}`);
}
