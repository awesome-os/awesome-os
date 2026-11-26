/**
 * @file src/semantic-lane-splitter.mts
 * @description 2-Lane Semantic Package Splitter & Prebuilt-First Binary Resolver for `holo-pm`.
 *
 * Splits every polyglot package (npm, cargo, pypi, go, dart, cpp) over ONE `v11` CAS:
 *   1. Text / Interpreted Source Lane -> `repository/<ecosystem>/<pkg>/...`
 *      - Cross-language bindings auto-route to their consumer ecosystem:
 *        - `.ts`/`.mts`/`.d.ts`/`.js` inside a `cargo` crate -> `repository/npm/cargo/<pkg>/...`
 *        - `.py`/`.pyi` inside a `cargo` (PyO3) crate        -> `repository/pypi/cargo/<pkg>/...`
 *      - Gives an instant, 0-byte-hardlinked, grep/BM25/LSP-queryable semantic index.
 *   2. Binary Lane -> `assets/<target>-<abi>/<pkg>/...`
 *      - Native addons (`.node`), Python wheels (`.pyd`/`.so`/`.dll`), `.dylib`, `.wasm`, `.b8p`
 *      - Prebuilt-first lookup against `index/holo-compiler-lockfile.json` skips building whenever
 *        an ABI-compatible binary already exists in `v11/files/00..ff/<sha512>-exec`.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only, zero external dependencies.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export type PackageEcosystem = 'cargo' | 'npm' | 'pypi' | 'go' | 'dart' | 'cpp';

export interface PackageInputFile {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

export interface LockfileBinaryEntry {
  readonly repo?: string;
  readonly filename?: string;
  readonly target?: string;
  readonly abi?: string;
  readonly sha512?: string;
}

export interface ClassifiedFileRoute {
  readonly lane: 'repository' | 'assets';
  readonly executable: boolean;
  readonly abiTag?: string;
  readonly destRelPath: string;
}

export interface SplitProjectOptions {
  readonly pkgName: string;
  readonly primaryEco: PackageEcosystem;
  readonly target: string;
  readonly abi?: string;
  readonly casRoot: string;
  readonly outputRoot: string;
  readonly files: readonly PackageInputFile[];
  readonly lockfileEntries?: readonly LockfileBinaryEntry[];
}

export interface SplitProjectReceipt {
  readonly abiMagic: '0x33564742';
  readonly casLayout: 'v11';
  readonly pkgName: string;
  readonly primaryEco: PackageEcosystem;
  readonly textProjected: number;
  readonly binariesProjected: number;
  readonly prebuiltHits: number;
  readonly deduplicatedBlobs: number;
  readonly hardlinkedCount: number;
  readonly repositoryPaths: readonly string[];
  readonly assetPaths: readonly string[];
}

const BINARY_EXTS = new Set([
  '.node',
  '.pyd',
  '.dll',
  '.so',
  '.dylib',
  '.exe',
  '.wasm',
  '.b8p',
  '.a',
  '.lib',
  '.o',
]);

const JS_TS_EXTS = new Set(['.ts', '.mts', '.cts', '.d.ts', '.js', '.mjs', '.cjs']);
const PY_EXTS = new Set(['.py', '.pyi']);

function inferAbiTag(ext: string, filename: string, override?: string): string {
  if (override && override.trim()) return override.trim();
  const lower = filename.toLowerCase();
  if (ext === '.node') return 'napi';
  if (ext === '.pyd' || lower.includes('.abi3.')) return lower.includes('abi3') ? 'abi3' : 'cpython';
  if (ext === '.wasm') return 'wasi';
  return 'b8g-v3';
}

function sanitizeRelPath(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.split('/').some((seg) => seg === '..')) {
    throw new Error(`semantic-lane-splitter: invalid relative path "${rel}"`);
  }
  return norm;
}

/**
 * Classifies a file inside a package into either:
 *   - `assets/<target>-<abi>/<pkg>/<basename>` (binary lane)
 *   - `repository/<consumer-eco>[/<primary-eco>]/<pkg>/<relPath>` (semantic text lane)
 */
export function classifyPackageFile(
  relPath: string,
  pkgName: string,
  primaryEco: PackageEcosystem,
  target: string,
  abiOverride?: string,
): ClassifiedFileRoute {
  const cleanRel = sanitizeRelPath(relPath);
  const lower = cleanRel.toLowerCase();
  const base = path.posix.basename(cleanRel);
  const ext = lower.endsWith('.d.ts') ? '.d.ts' : path.posix.extname(lower);

  if (BINARY_EXTS.has(ext)) {
    const abiTag = inferAbiTag(ext, base, abiOverride);
    return {
      lane: 'assets',
      executable: true,
      abiTag,
      destRelPath: `assets/${target}-${abiTag}/${pkgName}/${base}`,
    };
  }

  // Cross-language semantic routing: TS/JS inside Cargo/PyPI/Go -> repository/npm/<primaryEco>/<pkg>/
  if (primaryEco !== 'npm' && JS_TS_EXTS.has(ext)) {
    return {
      lane: 'repository',
      executable: false,
      destRelPath: `repository/npm/${primaryEco}/${pkgName}/${cleanRel}`,
    };
  }

  // Cross-language semantic routing: Python inside Cargo (PyO3) -> repository/pypi/cargo/<pkg>/
  if (primaryEco !== 'pypi' && PY_EXTS.has(ext)) {
    return {
      lane: 'repository',
      executable: false,
      destRelPath: `repository/pypi/${primaryEco}/${pkgName}/${cleanRel}`,
    };
  }

  return {
    lane: 'repository',
    executable: false,
    destRelPath: `repository/${primaryEco}/${pkgName}/${cleanRel}`,
  };
}

/**
 * Prebuilt-first lookup: checks if an ABI-compatible binary already exists in `v11` CAS
 * so `holo-pm` can hardlink it in <1 ms and skip `node-gyp` / `pip` / Rust native rebuilds.
 */
export function findPrebuiltBinaryInV11(
  pkgName: string,
  filename: string,
  target: string,
  abiTag: string,
  casRoot: string,
  lockfileEntries: readonly LockfileBinaryEntry[] = [],
): { readonly hit: boolean; readonly sha512?: string; readonly blobPath?: string } {
  const base = path.posix.basename(filename).toLowerCase();
  for (const e of lockfileEntries) {
    if (!e.sha512) continue;
    const repoOk = e.repo === pkgName || (e.filename && e.filename.toLowerCase() === base);
    const targetOk = !e.target || e.target === target || e.target === 'any';
    const abiOk = !e.abi || e.abi === abiTag || e.abi === 'abi3' || e.abi === 'napi';
    if (!repoOk || !targetOk || !abiOk) continue;

    const blobPath = path.join(casRoot, 'v11', 'files', e.sha512.slice(0, 2), `${e.sha512}-exec`);
    if (fs.existsSync(blobPath)) {
      return { hit: true, sha512: e.sha512, blobPath };
    }
  }
  return { hit: false };
}

function putV11(
  casRoot: string,
  bytes: Uint8Array,
  executable: boolean,
): { readonly sha512: string; readonly blobPath: string; readonly deduplicated: boolean } {
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  const dir = path.join(casRoot, 'v11', 'files', sha512.slice(0, 2));
  const blobPath = path.join(dir, executable ? `${sha512}-exec` : sha512);
  if (fs.existsSync(blobPath)) {
    return { sha512, blobPath, deduplicated: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(blobPath, bytes);
  return { sha512, blobPath, deduplicated: false };
}

function hardlinkOrCopy(src: string, dst: string): boolean {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
  try {
    fs.linkSync(src, dst);
    return true;
  } catch {
    fs.copyFileSync(src, dst);
    return false;
  }
}

/**
 * Splits a package's files into `repository/<eco>/` (semantic text) and `assets/<target>-<abi>/`
 * (prebuilt-first binaries), backed by 0-byte hardlinks into one unified `v11` CAS.
 */
export function splitAndProjectPackage(opts: SplitProjectOptions): SplitProjectReceipt {
  let textProjected = 0;
  let binariesProjected = 0;
  let prebuiltHits = 0;
  let deduplicatedBlobs = 0;
  let hardlinkedCount = 0;
  const repositoryPaths: string[] = [];
  const assetPaths: string[] = [];

  for (const file of opts.files) {
    const route = classifyPackageFile(
      file.relPath,
      opts.pkgName,
      opts.primaryEco,
      opts.target,
      opts.abi,
    );
    const destFull = path.join(opts.outputRoot, ...route.destRelPath.split('/'));

    if (route.lane === 'assets') {
      const prebuilt = findPrebuiltBinaryInV11(
        opts.pkgName,
        file.relPath,
        opts.target,
        route.abiTag || 'b8g-v3',
        opts.casRoot,
        opts.lockfileEntries,
      );
      if (prebuilt.hit && prebuilt.blobPath) {
        prebuiltHits++;
        if (hardlinkOrCopy(prebuilt.blobPath, destFull)) hardlinkedCount++;
      } else {
        const put = putV11(opts.casRoot, file.bytes, true);
        if (put.deduplicated) deduplicatedBlobs++;
        if (hardlinkOrCopy(put.blobPath, destFull)) hardlinkedCount++;
      }
      binariesProjected++;
      assetPaths.push(route.destRelPath);
    } else {
      const put = putV11(opts.casRoot, file.bytes, false);
      if (put.deduplicated) deduplicatedBlobs++;
      if (hardlinkOrCopy(put.blobPath, destFull)) hardlinkedCount++;
      textProjected++;
      repositoryPaths.push(route.destRelPath);
    }
  }

  return {
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: 'v11',
    pkgName: opts.pkgName,
    primaryEco: opts.primaryEco,
    textProjected,
    binariesProjected,
    prebuiltHits,
    deduplicatedBlobs,
    hardlinkedCount,
    repositoryPaths,
    assetPaths,
  };
}
