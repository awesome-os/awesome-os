import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CasV11Store,
  HOLO_COMPILER_CONTEXT,
  HoloDaemonClient,
  SubTuCasIndex,
  checkModuleEffects,
  computeSplicePlan,
  defaultHoloPipePath,
  spliceModule,
  splitModuleItems,
  startHoloDaemon,
} from './index.mts';

function makeRustModule(fnCount: number, mutatedIdx = -1, mutatedVal = 0): string {
  const lines = ['use std::collections::HashMap;'];
  for (let i = 0; i < fnCount; i += 1) {
    const body =
      i === mutatedIdx ? `x.wrapping_add(${mutatedVal})` : `x.wrapping_add(${i})`;
    lines.push(`pub fn compute_${i}(x: u64) -> u64 { ${body} }`);
  }
  return lines.join('\n');
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-bench-'));
try {
  // 1. Sub-TU 500-function cold vs 1-function body-only incremental splice (Rust)
  const src500 = makeRustModule(500);
  const src500Edit = makeRustModule(500, 250, 999999);
  const cas = new SubTuCasIndex({ casDir: path.join(tmpDir, 'subtu-cas') });
  const enc = new TextEncoder();

  const t0 = performance.now();
  const prevItems = splitModuleItems('rust', src500);
  const coldPlan = computeSplicePlan([], prevItems, cas, {
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  const coldRes = await spliceModule(coldPlan, (item) =>
    enc.encode(`OBJ:${item.name}:${item.itemHash}`),
  );
  const coldMs = performance.now() - t0;

  const t1 = performance.now();
  const nextItems = splitModuleItems('rust', src500Edit);
  const incPlan = computeSplicePlan(prevItems, nextItems, cas, {
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  const incRes = await spliceModule(incPlan, (item) =>
    enc.encode(`OBJ:${item.name}:${item.itemHash}`),
  );
  const incMs = performance.now() - t1;

  // 2. Effect system check on 500-function module
  const tEff = performance.now();
  const effRes = checkModuleEffects(
    [{ unitId: 'mod500', toolchain: 'rust', source: src500Edit }],
    HOLO_COMPILER_CONTEXT,
  );
  const effMs = performance.now() - tEff;

  // 3. Resident named-pipe daemon cold vs warm RPC (50 iterations)
  const pipePath = defaultHoloPipePath(`bench-${process.pid}`);
  await startHoloDaemon({ pipePath });
  const client = new HoloDaemonClient({ pipePath });

  const tPipeCold0 = performance.now();
  await client.compile({
    unitId: 'u1',
    toolchain: 'rust',
    source: src500Edit,
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  const pipeColdMs = performance.now() - tPipeCold0;

  const tPipeWarm0 = performance.now();
  for (let i = 0; i < 50; i += 1) {
    await client.compile({
      unitId: 'u1',
      toolchain: 'rust',
      source: src500Edit,
      targetTriple: 'x86_64-pc-windows-msvc',
    });
  }
  const pipeWarmAvgMs = (performance.now() - tPipeWarm0) / 50;
  await client.shutdown();

  // 4. CasV11Store write + dedup + hardlink
  const v11 = new CasV11Store(path.join(tmpDir, 'v11'));
  const blob = coldRes.artifactBytes;
  const tV11Put0 = performance.now();
  const put1 = v11.putBlob(blob, { kind: 'b8p' });
  const v11PutMs = performance.now() - tV11Put0;

  const tV11Dedup0 = performance.now();
  const put2 = v11.putBlob(blob, { kind: 'b8p' });
  const v11DedupMs = performance.now() - tV11Dedup0;

  const tV11Link0 = performance.now();
  v11.linkBlobTo(put1.sha512, path.join(tmpDir, 'out', 'artifact.b8p'));
  const v11LinkMs = performance.now() - tV11Link0;
  v11.close();

  // 5. Real native C11 compile via zig cc (1-function C module -> Win64 object)
  const cSrc = path.join(tmpDir, 'unit.c');
  const cObj = path.join(tmpDir, 'unit.o');
  fs.writeFileSync(cSrc, 'unsigned long long compute_250(unsigned long long x) { return x + 999999ULL; }\n');
  const tZig0 = performance.now();
  execFileSync('cmd.exe', ['/c', 'e:\\awesome-os\\bin\\zig.cmd', 'cc', '-O2', '-c', cSrc, '-o', cObj], {
    stdio: 'pipe',
  });
  const zigNativeObjMs = performance.now() - tZig0;

  console.log(
    JSON.stringify(
      {
        subTu500: {
          items: prevItems.length,
          coldMs: Number(coldMs.toFixed(2)),
          incremental1FnMs: Number(incMs.toFixed(2)),
          speedupVsCold: Number((coldMs / Math.max(0.01, incMs)).toFixed(1)),
          compiledCount: incRes.compiledCount,
          cacheHitRatePct: Number((incRes.cacheHitRate * 100).toFixed(2)),
          bodyOnlyDirty: incPlan.bodyOnlyDirty.length,
        },
        effectCheck500Ms: Number(effMs.toFixed(2)),
        effectPassed: effRes.ok,
        residentPipeDaemon: {
          coldRpcMs: Number(pipeColdMs.toFixed(2)),
          warmHitAvgMs: Number(pipeWarmAvgMs.toFixed(3)),
        },
        casV11: {
          blobBytes: blob.byteLength,
          coldPutMs: Number(v11PutMs.toFixed(2)),
          dedupPutMs: Number(v11DedupMs.toFixed(2)),
          hardlinkMs: Number(v11LinkMs.toFixed(2)),
          deduplicated: put2.deduplicated,
        },
        realZigCcSingleFnObjMs: Number(zigNativeObjMs.toFixed(1)),
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
