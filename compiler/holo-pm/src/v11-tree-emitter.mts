#!/usr/bin/env node
/**
 * v11-tree-emitter.mts — Emit a small-file v11-tree.json CAS manifest (zero tarballs)
 *
 * Usage:
 *   node src/v11-tree-emitter.mts <dir> --repo <owner/name> --tag <vX.Y.Z> --out <v11-tree.json>
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface V11TreeFileEntry {
  path: string;
  sha512: string;
  size: number;
  executable: boolean;
  blobPath: string;
}

export interface V11TreeManifest {
  schema: 'awesome-os.v11-tree.v1';
  abiMagic: '0x33564742';
  repo: string;
  tag: string;
  tags: string[];
  generatedAt: string;
  overridesLegacyTar: true;
  totalFiles: number;
  uniqueBlobs: number;
  totalBytes: number;
  files: V11TreeFileEntry[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.awesome-oci', '.b8g-cas', 'target', 'build']);
const LEGACY_ARCHIVE_RE = /\.(tar\.zst|tar\.gz|tar\.xz|tgz|zip|7z)$/i;

function isExec(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    lower.endsWith('.exe') ||
    lower.endsWith('.dll') ||
    lower.endsWith('.so') ||
    lower.endsWith('.dylib') ||
    lower.endsWith('.wasm') ||
    lower.endsWith('.sh') ||
    lower.endsWith('.ps1') ||
    lower.endsWith('.cmd')
  );
}

export function emitV11Tree(rootDir: string, repo: string, tag: string, tags: string[] = ['folder-structure', 'local']): V11TreeManifest {
  const absRoot = path.resolve(rootDir);
  const files: V11TreeFileEntry[] = [];
  const unique = new Set<string>();
  let totalBytes = 0;

  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name));
        continue;
      }
      if (!ent.isFile() || LEGACY_ARCHIVE_RE.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(absRoot, full).replace(/\\/g, '/');
      if (rel === 'v11-tree.json') continue;
      const data = fs.readFileSync(full);
      const sha512 = createHash('sha512').update(data).digest('hex');
      const executable = isExec(rel);
      const shard = sha512.slice(0, 2);
      const fname = executable ? `${sha512}-exec` : sha512;
      unique.add(sha512);
      totalBytes += data.byteLength;
      files.push({
        path: rel,
        sha512,
        size: data.byteLength,
        executable,
        blobPath: `v11/files/${shard}/${fname}`,
      });
    }
  }

  walk(absRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    schema: 'awesome-os.v11-tree.v1',
    abiMagic: '0x33564742',
    repo,
    tag,
    tags,
    generatedAt: new Date().toISOString(),
    overridesLegacyTar: true,
    totalFiles: files.length,
    uniqueBlobs: unique.size,
    totalBytes,
    files,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  const dir = args[0] || '.';
  const getFlag = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const repo = getFlag('--repo', 'awesome-os/unknown');
  const tag = getFlag('--tag', 'main');
  const tagsRaw = getFlag('--tags', 'folder-structure,local');
  const tags = tagsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const out = getFlag('--out', path.join(dir, 'v11-tree.json'));
  const manifest = emitV11Tree(dir, repo, tag, tags);
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`EMITTED ${out}: ${manifest.totalFiles} files (${manifest.uniqueBlobs} unique SHA-512 blobs, ${(manifest.totalBytes / 1024).toFixed(1)} KB)`);
}
