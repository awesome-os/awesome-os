#!/usr/bin/env node
/**
 * @file pins/holo-overrides.mts
 * @description Single central, statically-linked TypeScript entrypoint uniting all
 * Awesome-OS ecosystem overrides (`rust`, `go`, `npm`) and the Git-versioned `v11`
 * lockfile (`index/holo-compiler-lockfile.json`) inside `awesome-os/holo-pm`.
 *
 * Static JSON imports keep TypeScript / `stealify-lint` / IDEs aware of all relations
 * while remaining directly executable on Node 22+ (`erasableSyntaxOnly: true`, 0 deps).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import npmOverridesDoc from './holo-unified-npm-overrides.json' with { type: 'json' };
import globalLockfileDoc from '../index/holo-compiler-lockfile.json' with { type: 'json' };

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export const PIN_FILES = {
  rustToml: path.join(import.meta.dirname, 'holo-unified-rust-pins.toml'),
  goWork: path.join(import.meta.dirname, 'holo-unified-go.work'),
  goPinsMod: path.join(import.meta.dirname, 'holo-unified-go-pins.mod'),
  npmOverridesJson: path.join(import.meta.dirname, 'holo-unified-npm-overrides.json'),
  v11LockfileJson: path.join(import.meta.dirname, '..', 'index', 'holo-compiler-lockfile.json'),
} as const;

export type OverrideEcosystem = 'rust' | 'go' | 'npm';

export interface UnifiedOverridesSnapshot {
  readonly abiMagic: '0x33564742';
  readonly casLayout: 'v11';
  readonly rust: Readonly<Record<string, string>>;
  readonly go: Readonly<Record<string, string>>;
  readonly npm: Readonly<Record<string, string>>;
  readonly debloatPurgeCandidates: readonly {
    readonly name: string;
    readonly repoCount: number;
    readonly distinctVersions: number;
  }[];
  readonly v11LockfileEntries: number;
}

function parseRustPins(toml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"$/);
    if (m?.[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

function parseGoPins(mod: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inReq = false;
  for (const raw of mod.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line.startsWith('require (')) {
      inReq = true;
      continue;
    }
    if (inReq && line === ')') {
      inReq = false;
      continue;
    }
    if (inReq) {
      const m = line.match(/^([^\s]+)\s+([^\s]+)/);
      if (m?.[1] && m[2]) out[m[1]] = m[2];
    }
  }
  return out;
}

export function loadUnifiedOverrides(): UnifiedOverridesSnapshot {
  const rust = parseRustPins(fs.readFileSync(PIN_FILES.rustToml, 'utf8'));
  const go = parseGoPins(fs.readFileSync(PIN_FILES.goPinsMod, 'utf8'));
  const npm = { ...npmOverridesDoc.pnpm.overrides };
  return {
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: 'v11',
    rust,
    go,
    npm,
    debloatPurgeCandidates: npmOverridesDoc.debloatPurgeCandidates,
    v11LockfileEntries: globalLockfileDoc.dependencies.length,
  };
}

export function resolveUnifiedOverride(
  ecosystem: OverrideEcosystem,
  name: string,
): string | undefined {
  const snap = loadUnifiedOverrides();
  return snap[ecosystem][name];
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const snap = loadUnifiedOverrides();
  console.log(
    JSON.stringify(
      {
        abiMagic: snap.abiMagic,
        casLayout: snap.casLayout,
        rustPins: Object.keys(snap.rust).length,
        goPins: Object.keys(snap.go).length,
        npmOverrides: Object.keys(snap.npm).length,
        debloatPurgeCandidates: snap.debloatPurgeCandidates.length,
        v11LockfileEntries: snap.v11LockfileEntries,
      },
      null,
      2,
    ),
  );
}
