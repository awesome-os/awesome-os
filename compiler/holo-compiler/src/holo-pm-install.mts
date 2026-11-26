/**
 * @file intersections/holo-compiler/holo-pm-install.mts
 * @description Local-by-default `./bin/` hardlink installer & collision-guarded `-g` global
 * ownership table for `holo-pm install` / `holo-pm add`.
 *
 * Contract:
 *   - Default (`global: false`): hardlinks `v11/files/<xx>/<sha512>-exec` directly into
 *     `<cwd>/bin/<binName>` (zero global namespace collisions, 0 B duplicated disk) and
 *     records the pinned entry in `<cwd>/holo-compiler-lockfile.json`.
 *   - Global (`global: true`): hardlinks into `<globalBinDir>/<alias || binName>` and
 *     enforces strict ownership in `<casRoot>/v11/bin-owners.json` — refuses silent overwrite
 *     unless `forceDefault: true` (`holo-pm use`) or `--as <alias>` is specified.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CasV11Store, resolveUnifiedCasRoot } from './cas-v11-store.mts';
import { parseGitForgeUri } from './git-forge.mts';

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export interface HoloPmInstallOptions {
  readonly uri: string;
  readonly binName: string;
  readonly sha512: string;
  readonly casRoot?: string;
  readonly cwd?: string;
  readonly global?: boolean;
  readonly globalBinDir?: string;
  readonly alias?: string;
  readonly forceDefault?: boolean;
}

export interface HoloPmInstallReceipt {
  readonly scope: 'local' | 'global';
  readonly uri: string;
  readonly binPath: string;
  readonly lockfilePath: string | null;
  readonly sha512: string;
  readonly hardlinked: boolean;
  readonly abiMagic: string;
}

interface BinOwnersDoc {
  readonly schema: 'awesome-os-bin-owners-v1';
  readonly owners: Record<string, { readonly uri: string; readonly sha512: string; readonly updatedAt: string }>;
}

function defaultGlobalBinDir(): string {
  return path.join(os.homedir(), '.b8g', 'bin');
}

function loadOwners(ownersPath: string): BinOwnersDoc {
  if (!fs.existsSync(ownersPath)) {
    return { schema: 'awesome-os-bin-owners-v1', owners: {} };
  }
  return JSON.parse(fs.readFileSync(ownersPath, 'utf8')) as BinOwnersDoc;
}

function upsertProjectLockfile(
  cwd: string,
  entry: { readonly id: string; readonly uri: string; readonly binName: string; readonly sha512: string },
): string {
  const lockPath = path.join(cwd, 'holo-compiler-lockfile.json');
  let doc: {
    schema: string;
    abiMagic: string;
    casLayout: string;
    dependencies: Array<{ id: string; uri: string; binName: string; sha512: string }>;
  } = {
    schema: 'holo-compiler-lockfile-v1',
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: 'v11',
    dependencies: [],
  };

  if (fs.existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as typeof doc;
      if (Array.isArray(parsed.dependencies)) doc = parsed;
    } catch {
      // start fresh if corrupt
    }
  }

  const idx = doc.dependencies.findIndex((d) => d.binName === entry.binName || d.id === entry.id);
  if (idx >= 0) doc.dependencies[idx] = entry;
  else doc.dependencies.push(entry);

  fs.writeFileSync(lockPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return lockPath;
}

export function installHoloPmBin(opts: HoloPmInstallOptions): HoloPmInstallReceipt {
  const parsed = parseGitForgeUri(opts.uri);
  const effectiveName = (opts.alias || opts.binName).trim();
  if (!effectiveName || effectiveName.includes('/') || effectiveName.includes('\\') || effectiveName.includes('..')) {
    throw new Error(`holo-pm: invalid binary name "${effectiveName}"`);
  }

  const casRoot = opts.casRoot || resolveUnifiedCasRoot();
  const store = new CasV11Store(casRoot);
  try {
    const isExec = store.hasBlob(opts.sha512, true);
    if (!isExec && !store.hasBlob(opts.sha512, false)) {
      throw new Error(`holo-pm: blob ${opts.sha512.slice(0, 16)}... not found in v11 CAS`);
    }

    if (opts.global) {
      const ownersPath = path.join(store.storeRoot, 'bin-owners.json');
      const ownersDoc = loadOwners(ownersPath);
      const existing = ownersDoc.owners[effectiveName];
      if (existing && existing.uri !== opts.uri && !opts.forceDefault) {
        throw new Error(
          `holo-pm collision: global bin "${effectiveName}" is already owned by "${existing.uri}". ` +
            `Use --as <alias>, --force-default (holo-pm use), or local ./bin/ install.`,
        );
      }

      const gBinDir = opts.globalBinDir || defaultGlobalBinDir();
      fs.mkdirSync(gBinDir, { recursive: true });
      const destPath = path.join(gBinDir, effectiveName);
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
      const linkRes = store.linkBlobTo(opts.sha512, destPath, isExec) as unknown as {
        linked?: boolean;
        strategy?: string;
        method?: string;
      };

      ownersDoc.owners[effectiveName] = {
        uri: opts.uri,
        sha512: opts.sha512,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(ownersPath, JSON.stringify(ownersDoc, null, 2) + '\n', 'utf8');

      return {
        scope: 'global',
        uri: opts.uri,
        binPath: destPath,
        lockfilePath: null,
        sha512: opts.sha512,
        hardlinked: linkRes.linked === true || linkRes.strategy === 'hardlink' || linkRes.method === 'hardlink',
        abiMagic: B8G_ABI_MAGIC_V3,
      };
    }

    // Default: local-by-default `./bin/<binName>` hardlink + project lockfile
    const cwd = opts.cwd || process.cwd();
    const localBinDir = path.join(cwd, 'bin');
    fs.mkdirSync(localBinDir, { recursive: true });
    const destPath = path.join(localBinDir, effectiveName);
    if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
    const linkRes = store.linkBlobTo(opts.sha512, destPath, isExec) as unknown as {
      linked?: boolean;
      strategy?: string;
      method?: string;
    };

    const lockfilePath = upsertProjectLockfile(cwd, {
      id: `${parsed.org}/${parsed.repo}@${parsed.ref}`,
      uri: opts.uri,
      binName: effectiveName,
      sha512: opts.sha512,
    });

    return {
      scope: 'local',
      uri: opts.uri,
      binPath: destPath,
      lockfilePath,
      sha512: opts.sha512,
      hardlinked: linkRes.linked === true || linkRes.strategy === 'hardlink' || linkRes.method === 'hardlink',
      abiMagic: B8G_ABI_MAGIC_V3,
    };
  } finally {
    store.close();
  }
}
