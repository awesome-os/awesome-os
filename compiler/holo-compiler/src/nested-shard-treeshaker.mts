/**
 * @file b8g-build/src/nested-shard-treeshaker.mts
 * @description GN/Ninja-free 4-Level Nested Chunking, Macro-Sensitivity Fingerprinting,
 * Pre-Compile Reachability Tree-Shaking, and Dual-Mode Late-Link Planner for `holo-compiler`.
 *
 * Eliminates Chromium-style global `args.gn` rebuild storms:
 *   - Level 0: Pre-compile reachability tree-shaking from `mainEntry` roots
 *   - Level 1: Macro-sensitivity fingerprinting (only hashes `#ifdef`/`defined()` macros actually read!)
 *   - Level 2: Arbitrarily nested hierarchical `.b8p` Merkle shard trees with O(changed) diffing
 *   - Level 3: Dual-mode late-link (`dev-late-link` via `B8G_ABI_MAGIC_V3` vs `release-thinlto`)
 *
 * Strictly `erasableSyntaxOnly: true` & zero external dependencies.
 */
import crypto from 'node:crypto';

export interface BuildUnitNode {
  readonly id: string;
  /** Hierarchical shard path, e.g. ['sectium', 'media', 'ffmpeg'] */
  readonly shardPath: readonly string[];
  readonly sourceText: string;
  readonly deps: readonly string[];
  readonly exports?: readonly string[];
  readonly imports?: readonly string[];
}

export interface TreeShakeResult {
  readonly mainEntries: readonly string[];
  readonly reachable: readonly BuildUnitNode[];
  readonly prunedIds: readonly string[];
  readonly prunedRatio: number;
}

export interface NestedShardNode {
  readonly shardId: string;
  readonly name: string;
  readonly merkleSha256: string;
  readonly leafHashes: Readonly<Record<string, string>>;
  readonly children: readonly NestedShardNode[];
  readonly totalLeafCount: number;
}

export interface ShardDiffResult {
  readonly dirtyShardIds: readonly string[];
  readonly dirtyLeafIds: readonly string[];
  readonly casHitLeafCount: number;
  readonly totalLeafCount: number;
  readonly casHitRatio: number;
}

export interface LateLinkPlan {
  readonly mode: 'dev-late-link' | 'release-thinlto';
  readonly abiMagic: '0x33564742';
  readonly linkTargets: readonly string[];
  readonly linkerFlags: readonly string[];
  readonly skippedShards: number;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Level 0: Pre-compile reachability tree-shaking from `mainEntry` roots.
 * Prunes every translation unit unreachable by direct deps OR symbol import/export edges
 * BEFORE a single compiler process is spawned.
 */
export function treeShakeFromMainEntries(
  units: readonly BuildUnitNode[],
  mainEntryIds: readonly string[],
): TreeShakeResult {
  const byId = new Map<string, BuildUnitNode>();
  const exportToUnitIds = new Map<string, string[]>();

  for (const u of units) {
    byId.set(u.id, u);
    for (const sym of u.exports ?? []) {
      const list = exportToUnitIds.get(sym) ?? [];
      list.push(u.id);
      exportToUnitIds.set(sym, list);
    }
  }

  const visited = new Set<string>();
  const queue: string[] = [];

  for (const entryId of mainEntryIds) {
    if (byId.has(entryId) && !visited.has(entryId)) {
      visited.add(entryId);
      queue.push(entryId);
    }
  }

  while (queue.length > 0) {
    const curId = queue.shift()!;
    const cur = byId.get(curId);
    if (!cur) continue;

    for (const depId of cur.deps) {
      if (byId.has(depId) && !visited.has(depId)) {
        visited.add(depId);
        queue.push(depId);
      }
    }
    for (const impSym of cur.imports ?? []) {
      const providers = exportToUnitIds.get(impSym) ?? [];
      for (const provId of providers) {
        if (!visited.has(provId)) {
          visited.add(provId);
          queue.push(provId);
        }
      }
    }
  }

  const reachable: BuildUnitNode[] = [];
  const prunedIds: string[] = [];
  for (const u of units) {
    if (visited.has(u.id)) {
      reachable.push(u);
    } else {
      prunedIds.push(u.id);
    }
  }

  const prunedRatio = units.length === 0 ? 0 : Number((prunedIds.length / units.length).toFixed(4));
  return {
    mainEntries: [...mainEntryIds],
    reachable,
    prunedIds,
    prunedRatio,
  };
}

/**
 * Level 1: AST-free macro-sensitivity extractor.
 * Scans C/C++/TS preprocessor directives (`#ifdef`, `#ifndef`, `defined(...)`) to find ONLY
 * the global build flags that a unit actually depends on.
 */
export function extractReferencedMacros(sourceText: string): readonly string[] {
  const macros = new Set<string>();
  const ifdefRe = /^\s*#\s*ifn?def\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = ifdefRe.exec(sourceText)) !== null) {
    macros.add(m[1]);
  }
  const definedRe = /\bdefined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
  while ((m = definedRe.exec(sourceText)) !== null) {
    macros.add(m[1]);
  }
  return Array.from(macros).sort();
}

/**
 * Computes a macro-sensitive content hash for a single build unit.
 * Changing an unrelated global flag in `globalDefines` produces the EXACT same hash.
 */
export function computeMacroSensitiveHash(
  unit: BuildUnitNode,
  globalDefines: Readonly<Record<string, string | number | boolean>>,
): string {
  const referenced = extractReferencedMacros(unit.sourceText);
  const relevantDefines: Record<string, string | number | boolean | null> = {};
  for (const key of referenced) {
    relevantDefines[key] = Object.prototype.hasOwnProperty.call(globalDefines, key)
      ? globalDefines[key]
      : null;
  }
  return sha256Hex(
    JSON.stringify({
      id: unit.id,
      shardPath: unit.shardPath,
      sourceSha: sha256Hex(unit.sourceText),
      defines: relevantDefines,
    }),
  );
}

interface MutableShardBucket {
  readonly name: string;
  readonly shardId: string;
  readonly leaves: Map<string, string>;
  readonly children: Map<string, MutableShardBucket>;
}

function finalizeBucket(bucket: MutableShardBucket): NestedShardNode {
  const sortedChildren = Array.from(bucket.children.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(finalizeBucket);

  const sortedLeafEntries = Array.from(bucket.leaves.entries()).sort(([a], [b]) => a.localeCompare(b));
  const leafHashes: Record<string, string> = {};
  let totalLeafCount = 0;

  for (const [k, v] of sortedLeafEntries) {
    leafHashes[k] = v;
    totalLeafCount += 1;
  }
  for (const c of sortedChildren) {
    totalLeafCount += c.totalLeafCount;
  }

  const merkleSha256 = sha256Hex(
    JSON.stringify({
      shardId: bucket.shardId,
      leaves: sortedLeafEntries,
      children: sortedChildren.map((c) => [c.shardId, c.merkleSha256]),
    }),
  );

  return {
    shardId: bucket.shardId,
    name: bucket.name,
    merkleSha256,
    leafHashes,
    children: sortedChildren,
    totalLeafCount,
  };
}

/**
 * Level 2: Builds an arbitrarily nested hierarchical `.b8p` Merkle shard tree.
 */
export function buildNestedShardTree(
  units: readonly BuildUnitNode[],
  globalDefines: Readonly<Record<string, string | number | boolean>> = {},
  rootName = 'root',
): NestedShardNode {
  const root: MutableShardBucket = {
    name: rootName,
    shardId: rootName,
    leaves: new Map(),
    children: new Map(),
  };

  for (const unit of units) {
    let cur = root;
    const segments = unit.shardPath.length > 0 ? unit.shardPath : ['default'];
    for (const seg of segments) {
      let child = cur.children.get(seg);
      if (!child) {
        child = {
          name: seg,
          shardId: `${cur.shardId}/${seg}`,
          leaves: new Map(),
          children: new Map(),
        };
        cur.children.set(seg, child);
      }
      cur = child;
    }
    cur.leaves.set(unit.id, computeMacroSensitiveHash(unit, globalDefines));
  }

  return finalizeBucket(root);
}

/**
 * Diffs two nested Merkle shard trees in O(changed): any subtree with matching `merkleSha256`
 * is skipped immediately in O(1) as a 100% `.b8p` CAS hit!
 */
export function diffNestedShardTrees(
  prev: NestedShardNode | null,
  next: NestedShardNode,
): ShardDiffResult {
  const dirtyShardIds: string[] = [];
  const dirtyLeafIds: string[] = [];
  let casHitLeafCount = 0;

  function walk(prevNode: NestedShardNode | undefined, nextNode: NestedShardNode): void {
    if (prevNode && prevNode.merkleSha256 === nextNode.merkleSha256) {
      casHitLeafCount += nextNode.totalLeafCount;
      return;
    }

    dirtyShardIds.push(nextNode.shardId);
    const prevLeaves = prevNode?.leafHashes ?? {};
    for (const [leafId, nextHash] of Object.entries(nextNode.leafHashes)) {
      if (prevLeaves[leafId] === nextHash) {
        casHitLeafCount += 1;
      } else {
        dirtyLeafIds.push(leafId);
      }
    }

    const prevChildMap = new Map<string, NestedShardNode>();
    for (const c of prevNode?.children ?? []) {
      prevChildMap.set(c.name, c);
    }
    for (const c of nextNode.children) {
      walk(prevChildMap.get(c.name), c);
    }
  }

  walk(prev ?? undefined, next);

  const totalLeafCount = next.totalLeafCount;
  const casHitRatio = totalLeafCount === 0 ? 1 : Number((casHitLeafCount / totalLeafCount).toFixed(4));
  return {
    dirtyShardIds,
    dirtyLeafIds,
    casHitLeafCount,
    totalLeafCount,
    casHitRatio,
  };
}

/**
 * Level 3: Generates a dual-mode late-link plan (`dev-late-link` via `B8G_ABI_MAGIC_V3`
 * shard boundaries vs `release-thinlto` over surviving reachable shards only).
 */
export function planLateLink(
  rootShard: NestedShardNode,
  diff: ShardDiffResult,
  mode: 'dev-late-link' | 'release-thinlto',
): LateLinkPlan {
  if (mode === 'dev-late-link') {
    return {
      mode,
      abiMagic: '0x33564742',
      linkTargets: [...diff.dirtyLeafIds],
      linkerFlags: ['-shared', '-Wl,--export-dynamic', '-DB8G_ABI_MAGIC_V3=0x33564742'],
      skippedShards: Math.max(0, rootShard.totalLeafCount - diff.dirtyLeafIds.length),
    };
  }

  const allReachableLeaves: string[] = [];
  function collect(node: NestedShardNode): void {
    allReachableLeaves.push(...Object.keys(node.leafHashes));
    for (const c of node.children) collect(c);
  }
  collect(rootShard);

  return {
    mode,
    abiMagic: '0x33564742',
    linkTargets: allReachableLeaves.sort(),
    linkerFlags: ['-flto=thin', '-Wl,--gc-sections', '-O3', '-s'],
    skippedShards: 0,
  };
}
