#!/usr/bin/env node
/**
 * @file intersections/holo-compiler/holo-project.mts
 * @description Universal Holographic Projection Protocol (`project://`) & Runner (`holo-project`).
 *
 * Symmetry:
 *   - `repository://<host>/<org>/<repo>@<ref>[#<subpath>]` = immutable v11 CAS source/object graph
 *   - `project://<runtime>/<entry>[?from=repository://...&mode=ephemeral|persistent&target=<5os>]`
 *     = 0-byte hardlink projection + runtime execution intersection
 *
 * `holo-node`, `holo-deno`, `holo-py`, `holo-go`, `holo-dart`, `holo-rust`, `holo-cpp`,
 * `holo-jvm`, and `holo-ffi` are all thin aliases over `holo-project project://<runtime>/...`.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CasV11Store, resolveUnifiedCasRoot } from './cas-v11-store.mts';
import { parseGitForgeUri, type ParsedGitForgeUri } from './git-forge.mts';
import {
  B8G_ABI_MAGIC_V3,
  projectHoloArtifacts,
  resolveHoloProjection,
  type HoloArtifactBlobSpec,
  type HoloProjectionDef,
} from './holo-projections.mts';

export type ProjectMode = 'ephemeral' | 'persistent';

export interface ParsedProjectUri {
  readonly raw: string;
  readonly scheme: 'project://';
  readonly runtimeToken: string;
  readonly projection: HoloProjectionDef;
  readonly entry: string;
  readonly fromRepository?: ParsedGitForgeUri;
  readonly mode: ProjectMode;
  readonly target?: string;
}

export interface HoloProjectRunOptions<T = unknown> {
  readonly casRoot?: string;
  readonly destDir?: string;
  readonly blobs?: readonly HoloArtifactBlobSpec[];
  readonly executor?: (ctx: {
    readonly parsed: ParsedProjectUri;
    readonly projectionDir: string;
    readonly projectedCount: number;
    readonly hardlinkedCount: number;
  }) => Promise<T> | T;
}

export interface HoloProjectReceipt<T = unknown> {
  readonly uri: string;
  readonly abiMagic: string;
  readonly casLayout: 'v11';
  readonly projectionId: string;
  readonly entry: string;
  readonly mode: ProjectMode;
  readonly projectionDir: string;
  readonly projectedCount: number;
  readonly hardlinkedCount: number;
  readonly purged: boolean;
  readonly output?: T;
}

/**
 * Parses `project://<runtime>/<entry>[?from=repository://...&mode=ephemeral|persistent&target=<5os>]`.
 */
export function parseProjectUri(raw: string): ParsedProjectUri {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('project://')) {
    throw new Error(`Invalid project URI "${raw}": expected scheme "project://"`);
  }

  const withoutScheme = trimmed.slice('project://'.length);
  const qIdx = withoutScheme.indexOf('?');
  const pathPart = qIdx === -1 ? withoutScheme : withoutScheme.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : withoutScheme.slice(qIdx + 1);

  const slashIdx = pathPart.indexOf('/');
  const runtimeToken = (slashIdx === -1 ? pathPart : pathPart.slice(0, slashIdx)).trim();
  const entry = (slashIdx === -1 ? '' : pathPart.slice(slashIdx + 1)).trim();

  if (!runtimeToken) {
    throw new Error(`Invalid project URI "${raw}": missing runtime segment`);
  }
  if (entry.split('/').some((seg) => seg === '..')) {
    throw new Error(`Invalid project URI "${raw}": path traversal ".." is forbidden`);
  }

  const projection =
    resolveHoloProjection(runtimeToken) ||
    resolveHoloProjection(`holo-${runtimeToken}`);

  if (!projection) {
    throw new Error(`Unknown holo projection runtime "${runtimeToken}" in "${raw}"`);
  }

  const params = new URLSearchParams(queryPart);
  const fromRaw = params.get('from')?.trim();
  const fromRepository = fromRaw ? parseGitForgeUri(fromRaw) : undefined;
  const modeRaw = params.get('mode')?.trim();
  const mode: ProjectMode = modeRaw === 'persistent' ? 'persistent' : 'ephemeral';
  const target = params.get('target')?.trim() || undefined;

  return {
    raw: trimmed,
    scheme: 'project://',
    runtimeToken,
    projection,
    entry,
    fromRepository,
    mode,
    target,
  };
}

/**
 * Universal holographic projection runner (`holo-project`):
 *   1. Parses `project://` URI and resolves canonical `holo-*` runtime projection
 *   2. Projects requested `v11` CAS blobs via 0-byte hardlinks into projection dir
 *   3. Runs the runtime executor callback
 *   4. Purges ephemeral hardlink projection cleanly in `finally` (0 bytes left at rest)
 */
export async function runHoloProject<T = unknown>(
  uri: string,
  opts: HoloProjectRunOptions<T> = {},
): Promise<HoloProjectReceipt<T>> {
  const parsed = parseProjectUri(uri);
  const isEphemeral = parsed.mode === 'ephemeral' && !opts.destDir;
  const projectionDir =
    opts.destDir || fs.mkdtempSync(path.join(os.tmpdir(), `holo-proj-${parsed.projection.id}-`));

  let projectedCount = 0;
  let hardlinkedCount = 0;
  let output: T | undefined;
  let purged = false;

  const store = new CasV11Store(opts.casRoot || resolveUnifiedCasRoot());
  try {
    if (opts.blobs && opts.blobs.length > 0) {
      const proj = projectHoloArtifacts(parsed.projection.id, store, projectionDir, opts.blobs);
      projectedCount = proj.projectedCount;
      hardlinkedCount = proj.hardlinkedCount;
    }
    store.close();

    if (opts.executor) {
      output = await opts.executor({
        parsed,
        projectionDir,
        projectedCount,
        hardlinkedCount,
      });
    }
  } finally {
    try {
      store.close();
    } catch {
      // already closed
    }
    if (isEphemeral) {
      try {
        fs.rmSync(projectionDir, { recursive: true, force: true });
        purged = !fs.existsSync(projectionDir);
      } catch {
        purged = false;
      }
    }
  }

  return {
    uri: parsed.raw,
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: 'v11',
    projectionId: parsed.projection.id,
    entry: parsed.entry,
    mode: parsed.mode,
    projectionDir,
    projectedCount,
    hardlinkedCount,
    purged,
    output,
  };
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const uri = process.argv[2];
  if (!uri || uri === '--help' || uri === '-h') {
    process.stdout.write(
      'usage: holo-project project://<runtime>/<entry>[?from=repository://...&mode=ephemeral|persistent]\n',
    );
    process.exit(0);
  }
  const receipt = await runHoloProject(uri);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
