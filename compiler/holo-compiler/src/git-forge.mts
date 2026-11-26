/**
 * @file intersections/holo-compiler/git-forge.mts
 * @description Zero-`package.json` `repository://` resolver (with `git-forge://` legacy alias),
 * 7-Tuple EffectBit hook admissibility gate, and dual Source->Binary provenance ingestion
 * into `CasV11Store`.
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CasV11Store } from './cas-v11-store.mts';

export const B8G_ABI_MAGIC_V3 = '0x33564742' as const;
export const REPOSITORY_PROTOCOL = 'repository://' as const;
export const LEGACY_GIT_FORGE_PROTOCOL = 'git-forge://' as const;
export const GIT_FORGE_PROTOCOL = REPOSITORY_PROTOCOL;
export const GIT_FORGE_TREE_SCHEMA = 'holo-git-forge-tree-v1' as const;

/**
 * 7-Tuple capability effect bitmask for `holo-forge.json` hooks.
 * Uses `as const` object instead of `enum` to satisfy `erasableSyntaxOnly: true`.
 */
export const HookEffectBit = {
  NONE: 0,
  FS_READ: 1,
  CAS_WRITE: 2,
  WASI_EXEC: 4,
  NET_REMOTE: 8,
} as const;

export type HookEffectBitValue = (typeof HookEffectBit)[keyof typeof HookEffectBit];

/** Default hermetic capability mask: local FS read + CAS write + WASI exec, zero remote net. */
export const DEFAULT_SAFE_HOOK_MASK =
  HookEffectBit.FS_READ | HookEffectBit.CAS_WRITE | HookEffectBit.WASI_EXEC;

export interface ParsedGitForgeUri {
  readonly raw: string;
  readonly protocol: typeof GIT_FORGE_PROTOCOL;
  readonly host: string;
  readonly org: string;
  readonly repo: string;
  readonly ref: string;
  readonly subpath: string | null;
  readonly hook: string | null;
  readonly target: string | null;
}

export interface HoloForgeHookSpec {
  readonly name: string;
  readonly entry?: string;
  readonly effects: number;
}

export interface HookAdmissibilityResult {
  readonly name: string;
  readonly allowed: boolean;
  readonly requestedMask: number;
  readonly grantedMask: number;
  readonly deniedBits: number;
  readonly reason: string;
}

export interface HoloForgeManifest {
  readonly name?: string;
  readonly version?: string;
  readonly abiMagic?: string;
  readonly entry?: string;
  readonly targets?: ReadonlyArray<string>;
  readonly hooks?: Readonly<Record<string, HoloForgeHookSpec>>;
}

export interface GitForgeTreeEntry {
  readonly path: string;
  readonly sha512: string;
  readonly size: number;
  readonly executable: boolean;
}

export interface GitForgeTreeManifest {
  readonly schema: typeof GIT_FORGE_TREE_SCHEMA;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
  readonly source: {
    readonly host: string;
    readonly org: string;
    readonly repo: string;
    readonly ref: string;
    readonly subpath: string | null;
  };
  readonly entries: ReadonlyArray<GitForgeTreeEntry>;
}

export interface GitForgeArtifactProvenance {
  readonly sha512: string;
  readonly blobPath: string;
  readonly size: number;
  readonly target: string | null;
}

export interface GitForgeLockNode {
  readonly protocol: typeof GIT_FORGE_PROTOCOL;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3;
  readonly source: {
    readonly host: string;
    readonly org: string;
    readonly repo: string;
    readonly ref: string;
    readonly subpath: string | null;
    readonly treeSha512: string;
    readonly fileCount: number;
  };
  readonly artifact: GitForgeArtifactProvenance | null;
  readonly hooksEvaluated: ReadonlyArray<HookAdmissibilityResult>;
}

export interface ResolveGitForgeOptions {
  readonly grantedHookMask?: number;
  readonly artifactBytes?: Uint8Array | string;
  readonly artifactTarget?: string;
  readonly artifactExecutable?: boolean;
  readonly hooks?: ReadonlyArray<HoloForgeHookSpec>;
  readonly ignoreDirs?: ReadonlyArray<string>;
}

export interface HydrateGitForgeResult {
  readonly destDir: string;
  readonly treeSha512: string;
  readonly fileCount: number;
  readonly hardlinkedCount: number;
  readonly copiedCount: number;
  readonly files: ReadonlyArray<string>;
}

// ============================================================================
// Validation & Formatting Helpers
// ============================================================================

const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;

function assertNotLoopbackOrHttpBypass(hostWithOptionalPort: string): void {
  const lower = hostWithOptionalPort.trim().toLowerCase();
  if (!lower) {
    throw new Error('Invalid git-forge URI: empty host');
  }
  if (lower.includes('http://') || lower.includes('https://')) {
    throw new Error(`B8G016: HTTP bypass pattern prohibited in git-forge host: "${hostWithOptionalPort}"`);
  }

  // Strip IPv6 brackets and optional :port
  let bareHost = lower;
  if (bareHost.startsWith('[')) {
    const closeIdx = bareHost.indexOf(']');
    bareHost = closeIdx >= 0 ? bareHost.slice(1, closeIdx) : bareHost;
  } else {
    const colonIdx = bareHost.indexOf(':');
    if (colonIdx >= 0) {
      bareHost = bareHost.slice(0, colonIdx);
    }
  }

  if (
    bareHost === 'localhost' ||
    bareHost.endsWith('.localhost') ||
    bareHost === '::1' ||
    bareHost === '0.0.0.0' ||
    LOOPBACK_IPV4_RE.test(bareHost)
  ) {
    throw new Error(
      `B8G016: Loopback host "${hostWithOptionalPort}" is prohibited in git-forge:// URIs`,
    );
  }
}

function validateAndNormalizeSubpath(rawSubpath: string): string {
  if (rawSubpath.includes('\0')) {
    throw new Error('Invalid git-forge subpath: null byte prohibited');
  }
  let decoded = rawSubpath;
  try {
    decoded = decodeURIComponent(rawSubpath);
  } catch {
    throw new Error(`Invalid git-forge subpath encoding: "${rawSubpath}"`);
  }

  if (decoded.includes('\0') || decoded.startsWith('/') || decoded.startsWith('\\') || /^[a-zA-Z]:/.test(decoded)) {
    throw new Error(`Invalid git-forge subpath: absolute path prohibited ("${rawSubpath}")`);
  }

  const normalized = decoded.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`Invalid git-forge subpath: path traversal "${seg}" prohibited ("${rawSubpath}")`);
    }
  }
  if (segments.length === 0) {
    throw new Error(`Invalid git-forge subpath: empty subpath ("${rawSubpath}")`);
  }
  return segments.join('/');
}

function assertSafeIdentifier(label: string, value: string): void {
  if (!value || /\s/.test(value) || value === '.' || value === '..' || value.includes('\0')) {
    throw new Error(`Invalid git-forge ${label}: "${value}"`);
  }
}

export function formatEffectMask(mask: number): string[] {
  const names: string[] = [];
  if ((mask & HookEffectBit.FS_READ) !== 0) names.push('FS_READ');
  if ((mask & HookEffectBit.CAS_WRITE) !== 0) names.push('CAS_WRITE');
  if ((mask & HookEffectBit.WASI_EXEC) !== 0) names.push('WASI_EXEC');
  if ((mask & HookEffectBit.NET_REMOTE) !== 0) names.push('NET_REMOTE');
  const knownMask =
    HookEffectBit.FS_READ |
    HookEffectBit.CAS_WRITE |
    HookEffectBit.WASI_EXEC |
    HookEffectBit.NET_REMOTE;
  const unknownBits = mask & ~knownMask;
  if (unknownBits !== 0) {
    names.push(`UNKNOWN(0x${unknownBits.toString(16)})`);
  }
  return names;
}

// ============================================================================
// 1. URI Parser
// ============================================================================

/**
 * Parses `repository://<host>/<org>/<repo>@<ref>[#<subpath>][?hook=<name>&target=<target>]`
 * (also accepts legacy `git-forge://` alias normalized to `repository://`, and RFC 3986
 * `?query#subpath` ordering).
 *
 * Rejects invalid schemes, missing `@ref`, path traversal (`..` in subpath),
 * and `127.0.0.1`/`localhost` HTTP bypass patterns (`B8G016`).
 */
export function parseGitForgeUri(uri: string): ParsedGitForgeUri {
  const trimmed = uri.trim();
  let rest: string;
  let normalizedRaw: string;

  if (trimmed.startsWith(REPOSITORY_PROTOCOL)) {
    rest = trimmed.slice(REPOSITORY_PROTOCOL.length);
    normalizedRaw = trimmed;
  } else if (trimmed.startsWith(LEGACY_GIT_FORGE_PROTOCOL)) {
    rest = trimmed.slice(LEGACY_GIT_FORGE_PROTOCOL.length);
    normalizedRaw = `${REPOSITORY_PROTOCOL}${rest}`;
  } else {
    throw new Error(
      `Invalid repository URI scheme (expected "${REPOSITORY_PROTOCOL}" or legacy "${LEGACY_GIT_FORGE_PROTOCOL}"): "${uri}"`,
    );
  }

  const qIdx = rest.indexOf('?');
  const hIdx = rest.indexOf('#');

  let authorityAndPath: string;
  let rawSubpath = '';
  let rawQuery = '';

  if (qIdx === -1 && hIdx === -1) {
    authorityAndPath = rest;
  } else if (qIdx !== -1 && hIdx !== -1) {
    if (hIdx < qIdx) {
      authorityAndPath = rest.slice(0, hIdx);
      rawSubpath = rest.slice(hIdx + 1, qIdx);
      rawQuery = rest.slice(qIdx + 1);
    } else {
      authorityAndPath = rest.slice(0, qIdx);
      rawQuery = rest.slice(qIdx + 1, hIdx);
      rawSubpath = rest.slice(hIdx + 1);
    }
  } else if (hIdx !== -1) {
    authorityAndPath = rest.slice(0, hIdx);
    rawSubpath = rest.slice(hIdx + 1);
  } else {
    authorityAndPath = rest.slice(0, qIdx);
    rawQuery = rest.slice(qIdx + 1);
  }

  const parts = authorityAndPath.split('/');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid repository URI path (expected <host>/<org>/<repo>@<ref>): "${uri}"`,
    );
  }

  const [host, org, repoAndRef] = parts;
  assertNotLoopbackOrHttpBypass(host);
  assertSafeIdentifier('org', org);

  const atIdx = repoAndRef.indexOf('@');
  if (atIdx <= 0 || atIdx === repoAndRef.length - 1) {
    throw new Error(`Invalid repository URI: missing required "@<ref>" in "${uri}"`);
  }

  const repo = repoAndRef.slice(0, atIdx);
  const ref = repoAndRef.slice(atIdx + 1);
  assertSafeIdentifier('repo', repo);
  assertSafeIdentifier('ref', ref);

  const subpath = rawSubpath.length > 0 ? validateAndNormalizeSubpath(rawSubpath) : null;

  let hook: string | null = null;
  let target: string | null = null;
  if (rawQuery.length > 0) {
    const params = new URLSearchParams(rawQuery);
    const hookVal = params.get('hook')?.trim();
    const targetVal = params.get('target')?.trim();
    hook = hookVal && hookVal.length > 0 ? hookVal : null;
    target = targetVal && targetVal.length > 0 ? targetVal : null;
  }

  return {
    raw: normalizedRaw,
    protocol: REPOSITORY_PROTOCOL,
    host,
    org,
    repo,
    ref,
    subpath,
    hook,
    target,
  };
}

// ============================================================================
// 2. 7-Tuple Capability Hook Admissibility Gate
// ============================================================================

/**
 * Evaluates a `holo-forge.json` hook against the 7-Tuple capability gate.
 * Unconditionally denies any hook requesting `HookEffectBit.NET_REMOTE` or any
 * effect bit outside `grantedMask`.
 */
export function evaluateHookAdmissibility(
  hook: HoloForgeHookSpec,
  grantedMask: number = DEFAULT_SAFE_HOOK_MASK,
): HookAdmissibilityResult {
  const requestedMask = hook.effects | 0;
  const safeGranted = grantedMask | 0;

  const requestsNetRemote = (requestedMask & HookEffectBit.NET_REMOTE) !== 0;
  const outsideGranted = requestedMask & ~safeGranted;
  const deniedBits = (requestsNetRemote ? HookEffectBit.NET_REMOTE : 0) | outsideGranted;

  if (requestsNetRemote) {
    return {
      name: hook.name,
      allowed: false,
      requestedMask,
      grantedMask: safeGranted,
      deniedBits,
      reason: `Denied hook "${hook.name}": NET_REMOTE capability is unconditionally prohibited by 7-Tuple hermetic gate`,
    };
  }

  if (outsideGranted !== 0) {
    const deniedNames = formatEffectMask(outsideGranted).join(' | ');
    return {
      name: hook.name,
      allowed: false,
      requestedMask,
      grantedMask: safeGranted,
      deniedBits,
      reason: `Denied hook "${hook.name}": requested capability bits outside grantedMask (${deniedNames})`,
    };
  }

  return {
    name: hook.name,
    allowed: true,
    requestedMask,
    grantedMask: safeGranted,
    deniedBits: 0,
    reason: 'Admitted within 7-Tuple granted capability mask',
  };
}

// ============================================================================
// 3. Optional `holo-forge.json` Manifest Loader (Zero `package.json` Required)
// ============================================================================

/**
 * Reads an optional `holo-forge.json` manifest from `repoDir`.
 * Returns `null` if absent — zero `package.json` is required.
 */
export function loadHoloForgeManifest(repoDir: string): HoloForgeManifest | null {
  const manifestPath = path.join(path.resolve(repoDir), 'holo-forge.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const normalizedHooks: Record<string, HoloForgeHookSpec> = {};

  if (raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks)) {
    for (const [hookName, value] of Object.entries(raw.hooks as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        const effects = typeof rec.effects === 'number' && Number.isInteger(rec.effects) && rec.effects >= 0
          ? rec.effects
          : 0;
        normalizedHooks[hookName] = {
          name: typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : hookName,
          entry: typeof rec.entry === 'string' ? rec.entry : undefined,
          effects,
        };
      }
    }
  }

  return {
    name: typeof raw.name === 'string' ? raw.name : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    abiMagic: typeof raw.abiMagic === 'string' ? raw.abiMagic : undefined,
    entry: typeof raw.entry === 'string' ? raw.entry : undefined,
    targets: Array.isArray(raw.targets)
      ? raw.targets.filter((t): t is string => typeof t === 'string')
      : undefined,
    hooks: Object.keys(normalizedHooks).length > 0 ? normalizedHooks : undefined,
  };
}

// ============================================================================
// 4. Deterministic Repo Tree Ingestion & Dual-Provenance Lockfile Node
// ============================================================================

function collectFilesDeterministic(
  rootDir: string,
  ignoreDirs: ReadonlySet<string>,
): Array<{ readonly relPath: string; readonly fullPath: string; readonly executable: boolean }> {
  const results: Array<{ readonly relPath: string; readonly fullPath: string; readonly executable: boolean }> = [];

  function walk(currentDir: string, relPrefix: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) {
          continue;
        }
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        let executable = false;
        if (process.platform !== 'win32') {
          const stat = fs.statSync(fullPath);
          executable = (stat.mode & 0o111) !== 0;
        }
        results.push({ relPath, fullPath, executable });
      }
    }
  }

  walk(rootDir, '');
  results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return results;
}

/**
 * Ingests a local repository checkout (optionally scoped to `uri#subpath`) into
 * `CasV11Store`, builds a deterministic sorted tree manifest (`treeSha512`),
 * optionally stores compiled artifact bytes, evaluates `holo-forge.json` hooks
 * under the 7-Tuple capability gate, and returns a dual-provenance lockfile node.
 */
export function resolveGitForgeToCasV11(
  uri: string,
  localRepoDir: string,
  casStore: CasV11Store,
  opts?: ResolveGitForgeOptions,
): GitForgeLockNode {
  const parsed = parseGitForgeUri(uri);
  const resolvedRepoRoot = path.resolve(localRepoDir);
  const walkRoot = parsed.subpath
    ? path.resolve(resolvedRepoRoot, parsed.subpath)
    : resolvedRepoRoot;

  // Defense-in-depth containment check
  const relCheck = path.relative(resolvedRepoRoot, walkRoot);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`Resolved subpath escapes repository root: "${parsed.subpath}"`);
  }
  if (!fs.existsSync(walkRoot) || !fs.statSync(walkRoot).isDirectory()) {
    throw new Error(`git-forge source directory not found: "${walkRoot}"`);
  }

  // Load optional holo-forge.json (prefer walkRoot, fallback to repo root)
  const manifest =
    loadHoloForgeManifest(walkRoot) ??
    (walkRoot !== resolvedRepoRoot ? loadHoloForgeManifest(resolvedRepoRoot) : null);

  // Evaluate hooks via 7-Tuple capability gate
  const grantedMask = opts?.grantedHookMask ?? DEFAULT_SAFE_HOOK_MASK;
  const hooksToEvaluate: HoloForgeHookSpec[] = [];

  if (manifest?.hooks) {
    if (parsed.hook) {
      const selected = manifest.hooks[parsed.hook];
      if (selected) {
        hooksToEvaluate.push(selected);
      }
    } else {
      for (const hookSpec of Object.values(manifest.hooks)) {
        hooksToEvaluate.push(hookSpec);
      }
    }
  }
  if (opts?.hooks) {
    for (const extraHook of opts.hooks) {
      hooksToEvaluate.push(extraHook);
    }
  }

  const hooksEvaluated = hooksToEvaluate.map((h) => evaluateHookAdmissibility(h, grantedMask));

  // Walk & hash every file into CasV11Store
  const ignoreSet = new Set<string>(opts?.ignoreDirs ?? ['.git', 'node_modules']);
  const files = collectFilesDeterministic(walkRoot, ignoreSet);

  const treeEntries: GitForgeTreeEntry[] = [];
  for (const file of files) {
    const bytes = fs.readFileSync(file.fullPath);
    const put = casStore.putBlob(bytes, {
      kind: 'object',
      executable: file.executable,
      meta: {
        relPath: file.relPath,
        gitForgeUri: parsed.raw,
      },
    });
    treeEntries.push({
      path: file.relPath,
      sha512: put.sha512,
      size: put.size,
      executable: file.executable,
    });
  }

  // Store deterministic sorted tree manifest in CasV11Store
  const treeManifest: GitForgeTreeManifest = {
    schema: GIT_FORGE_TREE_SCHEMA,
    abiMagic: B8G_ABI_MAGIC_V3,
    source: {
      host: parsed.host,
      org: parsed.org,
      repo: parsed.repo,
      ref: parsed.ref,
      subpath: parsed.subpath,
    },
    entries: treeEntries,
  };

  const treeJson = JSON.stringify(treeManifest);
  const treePut = casStore.putBlob(treeJson, {
    kind: 'sidecar',
    meta: {
      schema: GIT_FORGE_TREE_SCHEMA,
      abiMagic: B8G_ABI_MAGIC_V3,
      gitForgeUri: parsed.raw,
      fileCount: treeEntries.length,
    },
  });

  // Optional compiled artifact storage (dual Source -> Binary provenance)
  let artifact: GitForgeArtifactProvenance | null = null;
  if (opts?.artifactBytes !== undefined) {
    const artifactTarget = opts.artifactTarget ?? parsed.target ?? null;
    const artifactPut = casStore.putBlob(opts.artifactBytes, {
      kind: 'b8p',
      executable: opts.artifactExecutable === true,
      meta: {
        abiMagic: B8G_ABI_MAGIC_V3,
        gitForgeUri: parsed.raw,
        treeSha512: treePut.sha512,
        target: artifactTarget,
      },
    });
    artifact = {
      sha512: artifactPut.sha512,
      blobPath: artifactPut.path,
      size: artifactPut.size,
      target: artifactTarget,
    };
  }

  return {
    protocol: GIT_FORGE_PROTOCOL,
    abiMagic: B8G_ABI_MAGIC_V3,
    source: {
      host: parsed.host,
      org: parsed.org,
      repo: parsed.repo,
      ref: parsed.ref,
      subpath: parsed.subpath,
      treeSha512: treePut.sha512,
      fileCount: treeEntries.length,
    },
    artifact,
    hooksEvaluated,
  };
}

// ============================================================================
// 5. Tree Hydration via CasV11Store Hardlinks
// ============================================================================

/**
 * Reconstructs a full repository tree from `CasV11Store` into `destDir` using
 * zero-copy hardlinks (`casStore.linkBlobTo`).
 */
export function hydrateGitForgeTree(
  treeSha512: string,
  casStore: CasV11Store,
  destDir: string,
): HydrateGitForgeResult {
  const rawBlob = casStore.getBlob(treeSha512);
  if (!rawBlob) {
    throw new Error(`git-forge tree manifest not found in CAS: "${treeSha512}"`);
  }

  const manifest = JSON.parse(Buffer.from(rawBlob).toString('utf8')) as Partial<GitForgeTreeManifest>;
  if (manifest.schema !== GIT_FORGE_TREE_SCHEMA || manifest.abiMagic !== B8G_ABI_MAGIC_V3) {
    throw new Error(
      `Invalid git-forge tree manifest (schema="${String(manifest.schema)}", abiMagic="${String(manifest.abiMagic)}")`,
    );
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error('Invalid git-forge tree manifest: missing entries array');
  }

  const resolvedDestDir = path.resolve(destDir);
  fs.mkdirSync(resolvedDestDir, { recursive: true });

  let hardlinkedCount = 0;
  let copiedCount = 0;
  const hydratedFiles: string[] = [];

  for (const entry of manifest.entries) {
    const safeRel = validateAndNormalizeSubpath(entry.path);
    const targetPath = path.resolve(resolvedDestDir, safeRel);
    const relCheck = path.relative(resolvedDestDir, targetPath);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`Tree entry escapes destination directory: "${entry.path}"`);
    }

    const linkResult = casStore.linkBlobTo(entry.sha512, targetPath, entry.executable === true);
    if (linkResult.method === 'hardlink') {
      hardlinkedCount += 1;
    } else {
      copiedCount += 1;
    }
    hydratedFiles.push(safeRel);
  }

  return {
    destDir: resolvedDestDir,
    treeSha512,
    fileCount: hydratedFiles.length,
    hardlinkedCount,
    copiedCount,
    files: hydratedFiles,
  };
}
