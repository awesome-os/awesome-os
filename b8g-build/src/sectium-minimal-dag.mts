/**
 * @file b8g-build/src/sectium-minimal-dag.mts
 * @description Layer 2 — Zero-GN, Zero-Ninja Declarative Build DAG for `sectium-minimal-7`.
 * Compiles ONLY the 7 canonical Sectium core subtrees defined in
 * `sections/chromium-build/sectium-minimal-allowlist.mts`, dropping all 12 bloated
 * Chrome/Google subsystems (`chrome/browser/resources/settings`, `components/autofill`,
 * `components/optimization_guide`, `chrome/updater`, etc.).
 */

import path from 'node:path';
import {
  DROPPED_CHROME_BLOAT_SUBSYSTEMS,
  SECTIUM_AUTARKIC_PROFILE,
  SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST,
} from '../../sections/chromium-build/sectium-minimal-allowlist.mts';
import type { DagGraph, DagNode } from './dag-executor.mts';

export type SectiumTargetTriple = 'x86_64-windows-msvc' | 'x86_64-linux-gnu' | 'wasm32-wasi';
export type SectiumLinkMode = 'late-link' | 'monolithic-lto';
export type SectiumPgoMode = 'cached-profdata' | 'two-pass' | 'off';

export interface SectiumMinimalDagOptions {
  readonly chromiumSrcDir: string;
  readonly outDir: string;
  readonly targetTriple?: SectiumTargetTriple;
  readonly compiler?: 'zig-cc' | 'clang-cl';
  readonly linkMode?: SectiumLinkMode;
  readonly pgoMode?: SectiumPgoMode;
  readonly pgoProfileDir?: string;
}

export interface SectiumMinimalBuildPlan {
  readonly profile: typeof SECTIUM_AUTARKIC_PROFILE;
  readonly targetTriple: SectiumTargetTriple;
  readonly compiler: 'zig-cc' | 'clang-cl';
  readonly linkMode: SectiumLinkMode;
  readonly pgoMode: SectiumPgoMode;
  readonly astFreePreLookup: true;
  readonly zeroGnRequired: true;
  readonly zeroNinjaRequired: true;
  readonly retainedSubtrees: number;
  readonly droppedBloatSubsystems: number;
  readonly graph: DagGraph;
}

const SUBTREE_DEPS: Readonly<Record<string, readonly string[]>> = {
  'clang-toolchain': [],
  'base-ipc': ['clang-toolchain'],
  'net-crypto': ['base-ipc'],
  'graphics-stack': ['base-ipc'],
  v8: ['base-ipc'],
  'compositor-ui': ['base-ipc', 'graphics-stack'],
  'blink-renderer': ['base-ipc', 'net-crypto', 'graphics-stack', 'v8', 'compositor-ui'],
};

export function buildSectiumMinimalDag(opts: SectiumMinimalDagOptions): SectiumMinimalBuildPlan {
  const targetTriple: SectiumTargetTriple = opts.targetTriple ?? 'x86_64-windows-msvc';
  const compiler = opts.compiler ?? (targetTriple === 'x86_64-windows-msvc' ? 'clang-cl' : 'zig-cc');
  const linkMode: SectiumLinkMode = opts.linkMode ?? 'late-link';
  const pgoMode: SectiumPgoMode = opts.pgoMode ?? 'cached-profdata';
  const srcRoot = path.resolve(opts.chromiumSrcDir);
  const outRoot = path.resolve(opts.outDir);
  const pgoDir = path.resolve(opts.pgoProfileDir ?? path.join(outRoot, 'pgo-cas'));

  const nodes: DagNode[] = [];

  for (const subtree of SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST) {
    const outPack = path.join(outRoot, `${subtree.id}.b8p`);
    const inputs = subtree.paths.map((p) => path.join(srcRoot, p));
    const deps = SUBTREE_DEPS[subtree.id] ?? ['clang-toolchain'];
    const pgoFlag =
      pgoMode === 'cached-profdata'
        ? ` -fprofile-use="${path.join(pgoDir, `${subtree.id}.profdata`)}"`
        : pgoMode === 'two-pass'
          ? ' -fprofile-generate'
          : '';
    const abiFlag = linkMode === 'late-link' ? ' --b8g-abi-v3-reloc' : ' -flto=thin';
    const ccCmd =
      compiler === 'zig-cc'
        ? `zig c++ -target ${targetTriple} -O2 -std=c++23${pgoFlag}${abiFlag}`
        : `clang-cl /O2 /std:c++23${pgoFlag}${abiFlag}`;

    nodes.push({
      id: subtree.id,
      rule: `sectium_${compiler.replace('-', '_')}`,
      outputs: [outPack],
      inputs,
      deps,
      command: `${ccCmd} --b8g-pack-subtree=${subtree.id} --out="${outPack}"`,
    });
  }

  // Final sovereign Sectium core link node (late-link ABI-V3 relocatable assembly vs release ThinLTO)
  const finalBin =
    targetTriple === 'x86_64-windows-msvc'
      ? path.join(outRoot, 'sectium-core.exe')
      : targetTriple === 'wasm32-wasi'
        ? path.join(outRoot, 'sectium-core.wasm')
        : path.join(outRoot, 'sectium-core');

  const linkFlags =
    linkMode === 'late-link'
      ? '--late-link --abi=B8G_ABI_MAGIC_V3'
      : '--lto=thin --release-final';

  nodes.push({
    id: 'sectium-core-link',
    rule: 'sectium_link',
    outputs: [finalBin],
    inputs: SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST.map((s) => path.join(outRoot, `${s.id}.b8p`)),
    deps: ['blink-renderer'],
    command: `lld-link --sectium-profile=${SECTIUM_AUTARKIC_PROFILE} --target=${targetTriple} ${linkFlags} --out="${finalBin}"`,
  });

  return {
    profile: SECTIUM_AUTARKIC_PROFILE,
    targetTriple,
    compiler,
    linkMode,
    pgoMode,
    astFreePreLookup: true,
    zeroGnRequired: true,
    zeroNinjaRequired: true,
    retainedSubtrees: SECTIUM_MINIMAL_UPSTREAM_ALLOWLIST.length,
    droppedBloatSubsystems: Object.keys(DROPPED_CHROME_BLOAT_SUBSYSTEMS).length,
    graph: {
      name: `${SECTIUM_AUTARKIC_PROFILE}:${targetTriple}:${linkMode}:${pgoMode}`,
      nodes,
    },
  };
}
