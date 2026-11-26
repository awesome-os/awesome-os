#!/usr/bin/env node
/**
 * @file scripts/pack-v11-shards.mts
 * @description Runner-side v11 CAS shard packer — replaces monolithic .tar.zst releases
 * by splitting any app build directory into deduplicated SHA-512 blobs under
 * <out>/v11/files/<aa>/<sha512> + a compact <out>/v11-tree.json manifest.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface V11TreeFileEntry {
  path: string;
  sha512: string;
  bytes: number;
  casPath: string;
}

export interface V11TreeManifest {
  schema: 'awesome-os.v11-tree.v1';
  abiMagic: '0x33564742';
  casLayout: 'v11';
  appId: string;
  generatedAt: string;
  totalFiles: number;
  uniqueBlobs: number;
  logicalBytes: number;
  uniqueBytes: number;
  savedBytes: number;
  files: V11TreeFileEntry[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export function packDirectoryToV11Shards(srcDir: string, outDir: string, appId: string): V11TreeManifest {
  const srcRoot = resolve(srcDir);
  const outRoot = resolve(outDir);
  const files = walk(srcRoot);
  const entries: V11TreeFileEntry[] = [];
  const seen = new Set<string>();
  let logicalBytes = 0;
  let uniqueBytes = 0;

  for (const full of files) {
    const buf = readFileSync(full);
    const sha512 = createHash('sha512').update(buf).digest('hex');
    const rel = relative(srcRoot, full).replace(/\\/g, '/');
    const casRel = `v11/files/${sha512.slice(0, 2)}/${sha512}`;
    const casAbs = join(outRoot, casRel);
    const bytes = statSync(full).size;

    logicalBytes += bytes;
    if (!seen.has(sha512)) {
      seen.add(sha512);
      uniqueBytes += bytes;
      mkdirSync(join(outRoot, 'v11', 'files', sha512.slice(0, 2)), { recursive: true });
      if (!existsSync(casAbs)) copyFileSync(full, casAbs);
    }

    entries.push({ path: rel, sha512, bytes, casPath: casRel });
  }

  const manifest: V11TreeManifest = {
    schema: 'awesome-os.v11-tree.v1',
    abiMagic: '0x33564742',
    casLayout: 'v11',
    appId,
    generatedAt: new Date().toISOString(),
    totalFiles: entries.length,
    uniqueBlobs: seen.size,
    logicalBytes,
    uniqueBytes,
    savedBytes: logicalBytes - uniqueBytes,
    files: entries,
  };

  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, 'v11-tree.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('pack-v11-shards.mts')) {
  const [src, out, appId = 'app'] = process.argv.slice(2);
  if (!src || !out) {
    console.log('Usage: node scripts/pack-v11-shards.mts <src-dir> <out-dir> [app-id]');
    process.exit(0);
  }
  const m = packDirectoryToV11Shards(src, out, appId);
  console.log(
    `[v11-pack] ${m.appId}: ${m.totalFiles} files -> ${m.uniqueBlobs} unique blobs (saved ${(m.savedBytes / 1048576).toFixed(2)} MB)`,
  );
}
