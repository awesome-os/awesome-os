import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildNestedShardTree,
  diffNestedShardTrees,
  extractReferencedMacros,
  planLateLink,
  treeShakeFromMainEntries,
  type BuildUnitNode,
} from './nested-shard-treeshaker.mts';

const SAMPLE_UNITS: readonly BuildUnitNode[] = [
  {
    id: 'sectium/main.c',
    shardPath: ['sectium', 'core'],
    sourceText: 'int main(void) { return cp_init() + decode_frame(); }',
    deps: ['sectium/cp.c'],
    imports: ['decode_frame'],
  },
  {
    id: 'sectium/cp.c',
    shardPath: ['sectium', 'control-plane'],
    sourceText: '#ifdef B8G_ABI_V3\nint cp_init(void) { return 0; }\n#endif',
    deps: [],
    exports: ['cp_init'],
  },
  {
    id: 'sectium/media/ffmpeg.c',
    shardPath: ['sectium', 'media', 'ffmpeg'],
    sourceText: '#if defined(USE_PROPRIETARY_CODECS)\nint decode_frame(void) { return 264; }\n#else\nint decode_frame(void) { return 9; }\n#endif',
    deps: [],
    exports: ['decode_frame'],
  },
  {
    id: 'sectium/legacy/nacl_dead.c',
    shardPath: ['sectium', 'legacy', 'nacl'],
    sourceText: 'int dead_nacl_entry(void) { return -1; }',
    deps: [],
    exports: ['dead_nacl_entry'],
  },
  {
    id: 'sectium/legacy/google_sync_dead.c',
    shardPath: ['sectium', 'legacy', 'sync'],
    sourceText: 'int dead_sync(void) { return -2; }',
    deps: ['sectium/legacy/nacl_dead.c'],
  },
];

describe('holo-compiler 4-level nested shard tree-shaker (GN/Ninja-free)', () => {
  it('1. Level 0 prunes unreachable dead units before compilation via deps + symbol edges', () => {
    const res = treeShakeFromMainEntries(SAMPLE_UNITS, ['sectium/main.c']);
    assert.deepEqual(
      res.reachable.map((u) => u.id).sort(),
      ['sectium/cp.c', 'sectium/main.c', 'sectium/media/ffmpeg.c'],
    );
    assert.deepEqual(
      res.prunedIds.slice().sort(),
      ['sectium/legacy/google_sync_dead.c', 'sectium/legacy/nacl_dead.c'],
    );
    assert.equal(res.prunedRatio, 0.4);
  });

  it('2. Level 1 & 2 macro-sensitive nested Merkle diff invalidates ONLY media/ffmpeg when USE_PROPRIETARY_CODECS flips', () => {
    const shaken = treeShakeFromMainEntries(SAMPLE_UNITS, ['sectium/main.c']).reachable;
    assert.deepEqual(extractReferencedMacros(SAMPLE_UNITS[2].sourceText), ['USE_PROPRIETARY_CODECS']);

    const treeA = buildNestedShardTree(shaken, { B8G_ABI_V3: 1, USE_PROPRIETARY_CODECS: 0 });
    const treeB = buildNestedShardTree(shaken, { B8G_ABI_V3: 1, USE_PROPRIETARY_CODECS: 1 });

    const diff = diffNestedShardTrees(treeA, treeB);
    // ONLY sectium/media/ffmpeg.c is dirty; core & control-plane are 100% CAS hits!
    assert.deepEqual(diff.dirtyLeafIds, ['sectium/media/ffmpeg.c']);
    assert.equal(diff.casHitLeafCount, 2);
    assert.equal(diff.totalLeafCount, 3);
    assert.ok(diff.casHitRatio > 0.66);
  });

  it('3. Level 3 plans minimal dev-late-link vs full reachable release-thinlto', () => {
    const shaken = treeShakeFromMainEntries(SAMPLE_UNITS, ['sectium/main.c']).reachable;
    const treeA = buildNestedShardTree(shaken, { B8G_ABI_V3: 1, USE_PROPRIETARY_CODECS: 0 });
    const treeB = buildNestedShardTree(shaken, { B8G_ABI_V3: 1, USE_PROPRIETARY_CODECS: 1 });
    const diff = diffNestedShardTrees(treeA, treeB);

    const devPlan = planLateLink(treeB, diff, 'dev-late-link');
    assert.equal(devPlan.abiMagic, '0x33564742');
    assert.deepEqual(devPlan.linkTargets, ['sectium/media/ffmpeg.c']);
    assert.equal(devPlan.skippedShards, 2);

    const relPlan = planLateLink(treeB, diff, 'release-thinlto');
    assert.deepEqual(relPlan.linkTargets, ['sectium/cp.c', 'sectium/main.c', 'sectium/media/ffmpeg.c']);
    assert.ok(relPlan.linkerFlags.includes('-flto=thin'));
    assert.ok(relPlan.linkerFlags.includes('-Wl,--gc-sections'));
  });
});
