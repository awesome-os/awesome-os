#!/usr/bin/env node
/**
 * scripts/v11-scope-tags.mts — Canonical v11 Scope Taxonomy & Catalog Builder
 *
 * Tags every repo/resource in the global v11 CAS by scope and locality:
 *   appliance | device | monitor | keyboard | oci-container |
 *   browser-app | terminal-app | folder-structure | local | remote
 */

import fs from 'node:fs';
import path from 'node:path';

export const V11_SCOPE_TAGS = [
  'appliance',
  'device',
  'monitor',
  'keyboard',
  'oci-container',
  'browser-app',
  'terminal-app',
  'folder-structure',
  'local',
  'remote',
] as const;

export type V11ScopeTag = (typeof V11_SCOPE_TAGS)[number];

const REPO_TAG_RULES: Array<[RegExp, V11ScopeTag[]]> = [
  [/^(awesome-os-desktop|b8g-production-rack|sectium-cloud-control-plane|gitlab-foss)$/, ['appliance', 'local', 'remote']],
  [/^(sectium|holo-device-host|holo-kvm-switch|sectium-display)$/, ['device', 'monitor', 'keyboard', 'local']],
  [/^(desktop-omarchy|noctalia|t2desktop-noctalia|chonkstep|wayland)$/, ['monitor', 'keyboard', 'browser-app', 'local']],
  [/^(dockerimages|t2linux|t2xnu|gitlab-runner|b8g-container)$/, ['oci-container', 'local', 'remote']],
  [/^(sectium-browser|sectium-electron|electron|code-oss|theia|blink|qt|wry)$/, ['browser-app', 'monitor', 'local']],
  [/^(coreutils|holo-pm|holo-compiler|just|cargo|pnpm|uv|go-lang|dart|nodeman|gitaly|gitlab-shell|gitlab-pages|obs)$/, ['terminal-app', 'local', 'remote']],
  [/^(holo-v11|models|documentation|awesome-os|upstream-mirrors|explorer)$/, ['folder-structure', 'local', 'remote']],
];

export function classifyV11ScopeTags(repo: string, filenames: readonly string[] = []): V11ScopeTag[] {
  const tags = new Set<V11ScopeTag>();
  for (const [re, matched] of REPO_TAG_RULES) {
    if (re.test(repo)) {
      for (const t of matched) tags.add(t);
    }
  }
  const lower = filenames.map((f) => f.toLowerCase());
  if (lower.some((f) => f.endsWith('.html') || f.endsWith('.wasm'))) tags.add('browser-app');
  if (lower.some((f) => f.endsWith('.exe') || f.includes('linux') || f.includes('cli'))) tags.add('terminal-app');
  if (lower.some((f) => f === 'v11-tree.json')) tags.add('folder-structure');
  if (tags.size === 0) {
    tags.add('folder-structure');
    tags.add('local');
  }
  return V11_SCOPE_TAGS.filter((t) => tags.has(t));
}

export interface V11ScopeCatalog {
  schema: 'awesome-os.v11-scope-catalog.v1';
  abiMagic: '0x33564742';
  generatedAt: string;
  taxonomy: readonly V11ScopeTag[];
  byTag: Record<V11ScopeTag, string[]>;
  byRepo: Record<string, V11ScopeTag[]>;
}

export function buildV11ScopeCatalog(entries: ReadonlyArray<{ repo: string; filename: string }>): V11ScopeCatalog {
  const filesByRepo = new Map<string, string[]>();
  for (const e of entries) {
    const arr = filesByRepo.get(e.repo) || [];
    arr.push(e.filename);
    filesByRepo.set(e.repo, arr);
  }

  const byTag = Object.fromEntries(V11_SCOPE_TAGS.map((t) => [t, [] as string[]])) as Record<V11ScopeTag, string[]>;
  const byRepo: Record<string, V11ScopeTag[]> = {};

  for (const [repo, files] of [...filesByRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const tags = classifyV11ScopeTags(repo, files);
    byRepo[repo] = tags;
    for (const t of tags) byTag[t].push(repo);
  }

  return {
    schema: 'awesome-os.v11-scope-catalog.v1',
    abiMagic: '0x33564742',
    generatedAt: new Date().toISOString(),
    taxonomy: V11_SCOPE_TAGS,
    byTag,
    byRepo,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).toLowerCase()
) {
  const manifestPath = fs.existsSync('dist/cas-v11-global-manifest.json')
    ? 'dist/cas-v11-global-manifest.json'
    : 'index/cas-v11-global-manifest.json';
  const outPath = fs.existsSync('dist') ? 'dist/v11-scope-catalog.json' : 'index/v11-scope-catalog.json';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = (Array.isArray(manifest.entries) ? manifest.entries : Object.values(manifest.entries || {})) as Array<{
    repo: string;
    filename: string;
  }>;
  const catalog = buildV11ScopeCatalog(entries);
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(
    `SCOPE CATALOG ${outPath}: ${Object.keys(catalog.byRepo).length} repos across ${V11_SCOPE_TAGS.length} tags`,
  );
}
