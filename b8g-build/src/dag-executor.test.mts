/**
 * @file b8g-build/src/dag-executor.test.mts
 * @description Tests for Layer 1 (Zero-Ninja DAG Executor + auto-@rspfile + auto-retry + CAS cache)
 * and Layer 2 (Zero-GN `sectium-minimal-7` 7-subtree declarative build graph).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  astFreeIncludePreScan,
  auditNinjaLongCommands,
  executeDag,
  parseNinjaFile,
  wrapLongCommandForWindows,
  type DagGraph,
} from './dag-executor.mts';
import { buildSectiumMinimalDag } from './sectium-minimal-dag.mts';

test('wrapLongCommandForWindows wraps >30KB commands into rspfiles cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-rsp-'));
  try {
    const hugeArgs = Array.from({ length: 1200 }, (_, i) => `gen/file_${i}_very_long_name.ts`).join(' ');
    const longPyCmd = `python3.exe ../../tools/typescript/ts_library.py ${hugeArgs}`;
    assert.ok(longPyCmd.length > 30_000);

    const wrapped = wrapLongCommandForWindows(longPyCmd, tmpDir, 'settings_build_ts', 30_000);
    assert.equal(wrapped.wrapped, true);
    assert.ok(wrapped.command.length < 500, 'Wrapped command must be well under Windows 32KB CreateProcess limit');
    assert.ok(wrapped.rspPath && fs.existsSync(wrapped.rspPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseNinjaFile & auditNinjaLongCommands detect >30KB rules', () => {
  const longCmd = `python3.exe script.py ${'a'.repeat(31_000)}`;
  const ninjaText = [
    'rule big_rule',
    `  command = ${longCmd}`,
    'build out.json: big_rule in.ts',
  ].join('\n');

  const g = parseNinjaFile(ninjaText);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0]?.rule, 'big_rule');

  const findings = auditNinjaLongCommands(ninjaText, 30_000);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, 'big_rule');
});

test('executeDag retries transient 0xC0000005 crashes and caches hits on second run', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-dag-'));
  const casDir = path.join(tmpDir, 'cas');
  try {
    const graph: DagGraph = {
      name: 'retry-and-cache',
      nodes: [
        { id: 'a', rule: 'cc', outputs: ['a.obj'], inputs: [], deps: [], command: 'clang-cl a.cc' },
        { id: 'b', rule: 'link', outputs: ['app.exe'], inputs: [], deps: ['a'], command: 'lld-link a.obj' },
      ],
    };

    const order: string[] = [];
    const run1 = await executeDag(graph, {
      workDir: tmpDir,
      casDir,
      maxRetries: 2,
      runner: async (node, _cmd, attempt) => {
        if (node.id === 'a' && attempt === 1) {
          return { code: 3221225477, stderr: 'Build config: +alloc:rpmalloc clang frontend command failed due to signal' };
        }
        order.push(node.id);
        return { code: 0 };
      },
    });

    assert.equal(run1.failed, 0);
    assert.equal(run1.retried, 1, 'Should auto-retry transient rpmalloc crash');
    assert.equal(run1.executed, 2);
    assert.deepEqual(order, ['a', 'b'], 'Must respect topological wave dependency a -> b');

    // Second run with unchanged inputs hits CAS cache (0 executions)
    const run2 = await executeDag(graph, {
      workDir: tmpDir,
      casDir,
      runner: async () => {
        throw new Error('Should not execute cached node');
      },
    });
    assert.equal(run2.cached, 2);
    assert.equal(run2.executed, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildSectiumMinimalDag emits zero-GN, zero-Ninja 7-subtree Sectium core DAG with late-link, cached PGO & 0 Chrome bloat', () => {
  const plan = buildSectiumMinimalDag({
    chromiumSrcDir: 'E:\\b8g-chromium-real\\src',
    outDir: 'E:\\awesome-os\\.b8g-cas\\sectium-minimal-out',
    targetTriple: 'x86_64-linux-gnu',
    linkMode: 'late-link',
    pgoMode: 'cached-profdata',
  });
  assert.equal(plan.zeroGnRequired, true);
  assert.equal(plan.zeroNinjaRequired, true);
  assert.equal(plan.astFreePreLookup, true);
  assert.equal(plan.linkMode, 'late-link');
  assert.equal(plan.pgoMode, 'cached-profdata');
  assert.equal(plan.retainedSubtrees, 7);
  assert.equal(plan.droppedBloatSubsystems, 12);
  assert.equal(plan.compiler, 'zig-cc');
  assert.equal(plan.graph.nodes.length, 8); // 7 subtrees + final link
  const v8Node = plan.graph.nodes.find((n) => n.id === 'v8');
  assert.ok(v8Node?.command.includes('-fprofile-use='), 'Cached PGO profile flag must be wired');
  assert.ok(v8Node?.command.includes('--b8g-abi-v3-reloc'), 'Late-link ABI v3 relocatable flag must be wired');
  const linkNode = plan.graph.nodes.find((n) => n.id === 'sectium-core-link');
  assert.ok(linkNode?.command.includes('--late-link'), 'Final link node must use late-link mode');
});

test('astFreeIncludePreScan extracts transitive C/C++ #include headers without spawning a compiler', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-prescan-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'leaf.h'), '#pragma once\nint x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'mid.h'), '#include "leaf.h"\n', 'utf8');
    const mainCc = path.join(tmpDir, 'main.cc');
    fs.writeFileSync(mainCc, '#include "mid.h"\nint main() { return x; }\n', 'utf8');

    const deps = astFreeIncludePreScan(mainCc, 3);
    assert.equal(deps.length, 2);
    assert.ok(deps.some((p) => p.endsWith('mid.h')));
    assert.ok(deps.some((p) => p.endsWith('leaf.h')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
