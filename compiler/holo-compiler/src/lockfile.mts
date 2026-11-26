/**
 * @file intersections/holo-compiler/lockfile.mts
 * @description Universal `holo-compiler-lockfile.json` generator, bottom-up topological walker,
 * `CasV11Store` verifier, and hardlink hydrator with clean nested `dependencies[]` arrays.
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CAS_V11_VERSION,
  CasV11Store,
  type CasV11BlobKind,
} from './cas-v11-store.mts';
import { B8G_ABI_MAGIC_V3_HEX } from './compile-exe.mts';

export const HOLO_LOCKFILE_SCHEMA = 'holo-compiler-lockfile-v1' as const;
export const HOLO_LOCKFILE_FILENAME = 'holo-compiler-lockfile.json' as const;

export type HoloLockfileNodeKind =
  | CasV11BlobKind
  | 'bin'
  | 'lib'
  | 'ghost-launcher'
  | 'vsix'
  | 'wasm';

export interface HoloLockfileNodeInput {
  readonly id: string;
  readonly kind: HoloLockfileNodeKind;
  readonly version: string;
  readonly target?: string;
  readonly sha512: string;
  readonly size: number;
  readonly executable?: boolean;
  readonly url?: string;
  readonly dependencies?: readonly HoloLockfileNodeInput[];
}

export interface HoloLockfileNode {
  readonly id: string;
  readonly kind: HoloLockfileNodeKind;
  readonly version: string;
  readonly target: string;
  readonly sha512: string;
  readonly size: number;
  readonly executable: boolean;
  readonly blob: string;
  readonly url?: string;
  readonly dependencies: readonly HoloLockfileNode[];
}

export interface HoloCompilerLockfile {
  readonly schema: typeof HOLO_LOCKFILE_SCHEMA;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3_HEX;
  readonly casLayout: typeof CAS_V11_VERSION;
  readonly repo: string;
  readonly targets: readonly string[];
  readonly generatedAt: string;
  readonly dependencies: readonly HoloLockfileNode[];
}

export interface GenerateHoloLockfileOptions {
  readonly repo: string;
  readonly targets?: readonly string[];
  readonly dependencies: readonly HoloLockfileNodeInput[];
  readonly generatedAt?: string;
}

export interface LockfileVerificationIssue {
  readonly nodeId: string;
  readonly sha512: string;
  readonly reason: 'invalid-sha512' | 'missing-blob' | 'cycle-detected';
  readonly message: string;
}

export interface LockfileVerificationResult {
  readonly ok: boolean;
  readonly totalNodes: number;
  readonly uniqueNodes: number;
  readonly presentInCas: number;
  readonly missingInCas: number;
  readonly issues: readonly LockfileVerificationIssue[];
}

export interface HydratedLockfileEntry {
  readonly id: string;
  readonly version: string;
  readonly sha512: string;
  readonly destPath: string;
  readonly method: 'hardlink' | 'copy';
  readonly size: number;
}

export interface LockfileHydrationResult {
  readonly ok: boolean;
  readonly hydrated: readonly HydratedLockfileEntry[];
  readonly missing: readonly HoloLockfileNode[];
  readonly totalBytes: number;
}

const SHA512_RE = /^[0-9a-f]{128}$/;

export function formatV11RelativeBlobPath(sha512: string, executable = false): string {
  const norm = sha512.trim().toLowerCase();
  if (!SHA512_RE.test(norm)) {
    throw new Error(`Invalid SHA-512 hex digest for lockfile node: "${sha512}"`);
  }
  const shard = norm.slice(0, 2);
  return `${CAS_V11_VERSION}/files/${shard}/${norm}${executable ? '-exec' : ''}`;
}

function normalizeNode(
  input: HoloLockfileNodeInput,
  ancestors: ReadonlySet<string>,
): HoloLockfileNode {
  const nodeKey = `${input.id}@${input.version}:${input.target ?? 'any'}`;
  if (ancestors.has(nodeKey)) {
    throw new Error(`Dependency cycle detected in holo-compiler-lockfile: ${nodeKey}`);
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(nodeKey);

  const sha512 = input.sha512.trim().toLowerCase();
  const executable = Boolean(input.executable);
  const blob = formatV11RelativeBlobPath(sha512, executable);
  const childDeps = (input.dependencies ?? [])
    .map((child) => normalizeNode(child, nextAncestors))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));

  const node: HoloLockfileNode = {
    id: input.id,
    kind: input.kind,
    version: input.version,
    target: input.target ?? 'any',
    sha512,
    size: input.size,
    executable,
    blob,
    ...(input.url ? { url: input.url } : {}),
    dependencies: Object.freeze(childDeps),
  };
  return Object.freeze(node);
}

/**
 * Generates a deterministic `holo-compiler-lockfile.json` object with sorted nested
 * `dependencies[]` arrays and canonical `v11/files/<XX>/<sha512>[-exec]` blob paths.
 */
export function generateHoloLockfile(opts: GenerateHoloLockfileOptions): HoloCompilerLockfile {
  const targets = opts.targets ?? [
    'win64',
    'linux-x64',
    'linux-arm64',
    'macos-arm64',
    'wasm32-wasi',
  ];
  const deps = opts.dependencies
    .map((dep) => normalizeNode(dep, new Set()))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));

  return Object.freeze({
    schema: HOLO_LOCKFILE_SCHEMA,
    abiMagic: B8G_ABI_MAGIC_V3_HEX,
    casLayout: CAS_V11_VERSION,
    repo: opts.repo,
    targets: Object.freeze([...targets]),
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    dependencies: Object.freeze(deps),
  });
}

/**
 * Walks nested `dependencies[]` in deterministic bottom-up topological order
 * (leaves first, parents after), deduplicating shared nodes by `(sha512, executable)`.
 */
export function walkLockfileBottomUp(
  lockfile: HoloCompilerLockfile,
): readonly HoloLockfileNode[] {
  const ordered: HoloLockfileNode[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (node: HoloLockfileNode): void => {
    const key = `${node.sha512}:${node.executable ? '1' : '0'}`;
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`Cycle detected while walking lockfile at ${node.id}@${node.version}`);
    }
    visiting.add(key);
    for (const child of node.dependencies) {
      visit(child);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(node);
  };

  for (const dep of lockfile.dependencies) {
    visit(dep);
  }
  return Object.freeze(ordered);
}

/**
 * Verifies every node in `holo-compiler-lockfile.json` against a `CasV11Store`.
 */
export function verifyHoloLockfile(
  lockfile: HoloCompilerLockfile,
  store: CasV11Store,
): LockfileVerificationResult {
  const issues: LockfileVerificationIssue[] = [];
  let totalNodes = 0;
  const seenUnique = new Set<string>();
  let presentInCas = 0;
  let missingInCas = 0;

  const inspect = (node: HoloLockfileNode, stack: Set<string>): void => {
    totalNodes += 1;
    const nodeKey = `${node.id}@${node.version}:${node.target}`;
    if (stack.has(nodeKey)) {
      issues.push({
        nodeId: node.id,
        sha512: node.sha512,
        reason: 'cycle-detected',
        message: `Cycle detected at ${nodeKey}`,
      });
      return;
    }
    const nextStack = new Set(stack);
    nextStack.add(nodeKey);

    for (const child of node.dependencies) {
      inspect(child, nextStack);
    }

    const dedupKey = `${node.sha512}:${node.executable ? '1' : '0'}`;
    if (seenUnique.has(dedupKey)) return;
    seenUnique.add(dedupKey);

    if (!SHA512_RE.test(node.sha512)) {
      issues.push({
        nodeId: node.id,
        sha512: node.sha512,
        reason: 'invalid-sha512',
        message: `Node ${node.id} has invalid SHA-512 digest`,
      });
      missingInCas += 1;
      return;
    }

    if (store.hasBlob(node.sha512, node.executable)) {
      presentInCas += 1;
    } else {
      missingInCas += 1;
      issues.push({
        nodeId: node.id,
        sha512: node.sha512,
        reason: 'missing-blob',
        message: `Missing v11 CAS blob ${node.blob} for ${node.id}@${node.version}`,
      });
    }
  };

  for (const dep of lockfile.dependencies) {
    inspect(dep, new Set());
  }

  return Object.freeze({
    ok: issues.length === 0,
    totalNodes,
    uniqueNodes: seenUnique.size,
    presentInCas,
    missingInCas,
    issues: Object.freeze(issues),
  });
}

function sanitizeFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/**
 * Hydrates a repo's `holo-compiler-lockfile.json` bottom-up via O(1) `CasV11Store` hardlinks.
 */
export function hydrateFromLockfile(
  lockfile: HoloCompilerLockfile,
  store: CasV11Store,
  destDir: string,
): LockfileHydrationResult {
  const ordered = walkLockfileBottomUp(lockfile);
  const hydrated: HydratedLockfileEntry[] = [];
  const missing: HoloLockfileNode[] = [];
  let totalBytes = 0;

  fs.mkdirSync(destDir, { recursive: true });

  for (const node of ordered) {
    if (!store.hasBlob(node.sha512, node.executable)) {
      missing.push(node);
      continue;
    }
    const ext = node.executable && process.platform === 'win32' ? '.exe' : '';
    const fileName = `${sanitizeFilename(node.id)}-${node.version}${ext}`;
    const destPath = path.join(destDir, fileName);
    const linkRes = store.linkBlobTo(node.sha512, destPath, node.executable);
    hydrated.push({
      id: node.id,
      version: node.version,
      sha512: node.sha512,
      destPath: linkRes.dest,
      method: linkRes.method,
      size: node.size,
    });
    totalBytes += node.size;
  }

  return Object.freeze({
    ok: missing.length === 0,
    hydrated: Object.freeze(hydrated),
    missing: Object.freeze(missing),
    totalBytes,
  });
}

export function writeHoloLockfile(
  filePath: string,
  lockfile: HoloCompilerLockfile,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(lockfile, null, 2)}\n`, 'utf8');
}

export function readHoloLockfile(filePath: string): HoloCompilerLockfile {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HoloCompilerLockfile;
  if (parsed.schema !== HOLO_LOCKFILE_SCHEMA) {
    throw new Error(`Unsupported holo-compiler lockfile schema: "${String(parsed.schema)}"`);
  }
  return parsed;
}
