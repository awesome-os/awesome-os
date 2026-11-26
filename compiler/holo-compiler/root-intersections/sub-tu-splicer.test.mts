/**
 * @file intersections/holo-compiler/sub-tu-splicer.test.mts
 * @description Comprehensive tests for the polyglot Sub-TU Code-Block Incremental Splicer
 * across all 5 `holo-compiler` toolchains (`cxx`, `rust`, `zig`, `wasi`, `ts`).
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  B8G_SPLICE_MAGIC,
  SubTuCasIndex,
  computeSplicePlan,
  computeSubTuCasKey,
  decodeSplicedModule,
  sha256Hex,
  spliceModule,
  splitModuleItems,
  type SubTuItem,
  type SubTuToolchain,
} from './sub-tu-splicer.mts';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function mockCompileItem(item: SubTuItem): Uint8Array {
  return ENCODER.encode(`OBJ[${item.toolchain}:${item.name}:${item.itemHash.slice(0, 12)}]\n${item.source}`);
}

function assertExactSpans(source: string, items: readonly SubTuItem[]): void {
  const utf8 = Buffer.from(source, 'utf8');
  const lines = source.split('\n');
  for (const item of items) {
    assert.equal(
      source.slice(item.startOffset, item.endOffset),
      item.source,
      `char span mismatch for ${item.name}`,
    );
    assert.equal(
      utf8.subarray(item.startByte, item.endByte).toString('utf8'),
      item.source,
      `UTF-8 byte span mismatch for ${item.name}`,
    );
    assert.ok(item.startLine >= 1 && item.startLine <= lines.length, `startLine out of bounds for ${item.name}`);
    assert.ok(item.endLine >= item.startLine && item.endLine <= lines.length, `endLine out of bounds for ${item.name}`);
    assert.equal(item.itemHash, sha256Hex(item.source), `itemHash mismatch for ${item.name}`);
    assert.equal(item.sigHash.length, 64, `sigHash must be 64-char SHA-256 hex for ${item.name}`);
  }
}

describe('holo-compiler sub-tu-splicer: splitModuleItems across all 5 toolchains', () => {
  it('splits cxx (C/C++) preamble, struct, class, and functions with exact UTF-8 byte & line spans', () => {
    const source = [
      '// Header comment with UTF-8: λ résumé',
      '#include <stdint.h>',
      '#include <stddef.h>',
      '',
      'struct Vec2 {',
      '  float x;',
      '  float y;',
      '};',
      '',
      'class Engine {',
      'public:',
      '  int tick(int dt) { return dt * 2; }',
      '};',
      '',
      'static inline uint32_t add_u32(uint32_t a, uint32_t b) {',
      '  const char* msg = "brace } inside string {";',
      '  return a + b;',
      '}',
      '',
      'uint32_t mul_u32(uint32_t a, uint32_t b) {',
      '  return a * b;',
      '}',
    ].join('\n');

    const items = splitModuleItems('cxx', source);
    assertExactSpans(source, items);

    assert.deepEqual(
      items.map((it) => ({ name: it.name, kind: it.kind })),
      [
        { name: '__preamble__', kind: 'preamble' },
        { name: 'Vec2', kind: 'struct' },
        { name: 'Engine', kind: 'class' },
        { name: 'add_u32', kind: 'function' },
        { name: 'mul_u32', kind: 'function' },
      ],
    );
    assert.equal(items[0]!.startLine, 2);
    assert.equal(items[0]!.endLine, 3);
    assert.equal(items[3]!.startLine, 15);
    assert.equal(items[3]!.endLine, 18);
  });

  it('splits rust preamble, structs, lifetimes, raw strings, and functions accurately', () => {
    const source = [
      'use std::collections::HashMap;',
      'use std::fmt;',
      '',
      '#[derive(Debug, Clone)]',
      'pub struct ArenaHeader {',
      '    pub magic: u32,',
      '    pub size: usize,',
      '}',
      '',
      "pub fn borrow_slice<'a>(input: &'a str) -> &'a str {",
      '    let _raw = r#"contains } and { braces"#;',
      '    /* nested /* block */ comment */',
      '    input.trim()',
      '}',
      '',
      'pub fn compute(a: u64, b: u64) -> u64 {',
      '    a.wrapping_add(b)',
      '}',
    ].join('\n');

    const items = splitModuleItems('rust', source);
    assertExactSpans(source, items);

    assert.deepEqual(
      items.map((it) => ({ name: it.name, kind: it.kind })),
      [
        { name: '__preamble__', kind: 'preamble' },
        { name: 'ArenaHeader', kind: 'struct' },
        { name: 'borrow_slice', kind: 'function' },
        { name: 'compute', kind: 'function' },
      ],
    );
  });

  it('splits zig imports, packed structs, functions, and test blocks', () => {
    const source = [
      'const std = @import("std");',
      'const builtin = @import("builtin");',
      '',
      'pub const Packet = packed struct {',
      '    tag: u8,',
      '    len: u24,',
      '};',
      '',
      'pub export fn hash32(x: u32) u32 {',
      '    return (x ^ (x >> 16)) *% 0x45d9f3b;',
      '}',
      '',
      'test "hash32 nonzero" {',
      '    try std.testing.expect(hash32(1) != 0);',
      '}',
    ].join('\n');

    const items = splitModuleItems('zig', source);
    assertExactSpans(source, items);

    assert.deepEqual(
      items.map((it) => ({ name: it.name, kind: it.kind })),
      [
        { name: '__preamble__', kind: 'preamble' },
        { name: 'Packet', kind: 'struct' },
        { name: 'hash32', kind: 'function' },
        { name: 'test:hash32 nonzero', kind: 'function' },
      ],
    );
  });

  it('splits wasi WAT S-expression modules and C-style WASI modules', () => {
    const watSource = [
      '(module',
      '  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))',
      '  (memory (export "memory") 1)',
      '  (type $binop (func (param i32 i32) (result i32)))',
      '  (func $add (export "add") (param $a i32) (param $b i32) (result i32)',
      '    local.get $a',
      '    local.get $b',
      '    i32.add)',
      '  (func $sub (export "sub") (param $a i32) (param $b i32) (result i32)',
      '    local.get $a',
      '    local.get $b',
      '    i32.sub)',
      ')',
    ].join('\n');

    const watItems = splitModuleItems('wasi', watSource);
    assertExactSpans(watSource, watItems);

    assert.deepEqual(
      watItems.map((it) => ({ name: it.name, kind: it.kind })),
      [
        { name: '__preamble__', kind: 'preamble' },
        { name: 'binop', kind: 'struct' },
        { name: 'add', kind: 'function' },
        { name: 'sub', kind: 'function' },
      ],
    );

    const cWasiSource = [
      '#include <stdint.h>',
      '',
      '__attribute__((export_name("wasi_add")))',
      'int32_t wasi_add(int32_t a, int32_t b) {',
      '  return a + b;',
      '}',
    ].join('\n');

    const cWasiItems = splitModuleItems('wasi', cWasiSource);
    assertExactSpans(cWasiSource, cWasiItems);
    assert.deepEqual(
      cWasiItems.map((it) => ({ name: it.name, kind: it.kind })),
      [
        { name: '__preamble__', kind: 'preamble' },
        { name: 'wasi_add', kind: 'function' },
      ],
    );
  });

  it('splits ts (erasable TypeScript) imports, interfaces, classes, functions, and arrow functions', () => {
    const source = [
      "import { createHash } from 'node:crypto';",
      "import type { Buffer } from 'node:buffer';",
      '',
      'export interface Frame {',
      '  readonly id: number;',
      '  readonly payload: Uint8Array;',
      '}',
      '',
      'export class Dispatcher {',
      '  run(): number { return 1; }',
      '}',
      '',
      'export function digest(input: string): string {',
      '  const template = `ignored { braces }`;',
      "  return createHash('sha256').update(input + template).digest('hex');",
      '}',
      '',
      'export const doubleNum = (x: number): number => {',
      '  return x * 2;',
      '};',
    ].join('\n');

    const items = splitModuleItems('ts', source);
    assertExactSpans(source, items);

    assert.deepEqual(
      items.map((it) => ({ name: it.name, kind: it.kind })),
      [
        { name: '__preamble__', kind: 'preamble' },
        { name: 'Frame', kind: 'struct' },
        { name: 'Dispatcher', kind: 'class' },
        { name: 'digest', kind: 'function' },
        { name: 'doubleNum', kind: 'function' },
      ],
    );
  });
});

describe('holo-compiler sub-tu-splicer: body-only vs signature edit invalidation', () => {
  const cases: ReadonlyArray<{
    readonly toolchain: SubTuToolchain;
    readonly v1: string;
    readonly v2BodyEdit: string;
    readonly v3SigEdit: string;
    readonly editedFn: string;
  }> = [
    {
      toolchain: 'cxx',
      editedFn: 'calc',
      v1: 'int calc(int a, int b) {\n  return a + b;\n}\nint keep(int x) { return x; }',
      v2BodyEdit: 'int calc(int a, int b) {\n  return (a + b) * 2;\n}\nint keep(int x) { return x; }',
      v3SigEdit: 'int64_t calc(int64_t a, int64_t b) {\n  return (a + b) * 2;\n}\nint keep(int x) { return x; }',
    },
    {
      toolchain: 'rust',
      editedFn: 'calc',
      v1: 'pub fn calc(a: i32, b: i32) -> i32 {\n  a + b\n}\npub fn keep(x: i32) -> i32 { x }',
      v2BodyEdit: 'pub fn calc(a: i32, b: i32) -> i32 {\n  a.wrapping_mul(b)\n}\npub fn keep(x: i32) -> i32 { x }',
      v3SigEdit: 'pub fn calc(a: i64, b: i64) -> i64 {\n  a.wrapping_mul(b)\n}\npub fn keep(x: i32) -> i32 { x }',
    },
    {
      toolchain: 'zig',
      editedFn: 'calc',
      v1: 'pub fn calc(a: i32, b: i32) i32 {\n  return a + b;\n}\npub fn keep(x: i32) i32 { return x; }',
      v2BodyEdit: 'pub fn calc(a: i32, b: i32) i32 {\n  return a * b + 1;\n}\npub fn keep(x: i32) i32 { return x; }',
      v3SigEdit: 'pub fn calc(a: i64, b: i64) i64 {\n  return a * b + 1;\n}\npub fn keep(x: i32) i32 { return x; }',
    },
    {
      toolchain: 'wasi',
      editedFn: 'calc',
      v1: '(module\n  (func $calc (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)\n  (func $keep (param i32) (result i32) local.get 0)\n)',
      v2BodyEdit: '(module\n  (func $calc (param i32 i32) (result i32) local.get 0 local.get 1 i32.mul)\n  (func $keep (param i32) (result i32) local.get 0)\n)',
      v3SigEdit: '(module\n  (func $calc (param i64 i64) (result i64) local.get 0 local.get 1 i64.mul)\n  (func $keep (param i32) (result i32) local.get 0)\n)',
    },
    {
      toolchain: 'ts',
      editedFn: 'calc',
      v1: 'export function calc(a: number, b: number): number {\n  return a + b;\n}\nexport function keep(x: number): number { return x; }',
      v2BodyEdit: 'export function calc(a: number, b: number): number {\n  return a * b + 42;\n}\nexport function keep(x: number): number { return x; }',
      v3SigEdit: 'export function calc(a: bigint, b: bigint): bigint {\n  return a * b + 42n;\n}\nexport function keep(x: number): number { return x; }',
    },
  ];

  for (const tc of cases) {
    it(`[${tc.toolchain}] distinguishes body-only hot-splice from signature-dirty invalidation`, async () => {
      const cas = new SubTuCasIndex();
      const itemsV1 = splitModuleItems(tc.toolchain, tc.v1);
      const itemsV2 = splitModuleItems(tc.toolchain, tc.v2BodyEdit);
      const itemsV3 = splitModuleItems(tc.toolchain, tc.v3SigEdit);

      // Cold build of V1
      const coldPlan = computeSplicePlan([], itemsV1, cas);
      const coldRes = await spliceModule(coldPlan, mockCompileItem);
      assert.equal(coldRes.compiledCount, 2);
      assert.equal(coldRes.cacheHits, 0);

      // Body-only edit: V1 -> V2
      const bodyPlan = computeSplicePlan(itemsV1, itemsV2, cas);
      assert.deepEqual(bodyPlan.unchanged.map((i) => i.name), ['keep']);
      assert.deepEqual(bodyPlan.bodyOnlyDirty.map((i) => i.name), [tc.editedFn]);
      assert.equal(bodyPlan.signatureDirty.length, 0);
      assert.equal(bodyPlan.invalidatesDependents, false);
      assert.equal(bodyPlan.canHotSplice, true);

      const bodyRes = await spliceModule(bodyPlan, mockCompileItem);
      assert.deepEqual(bodyRes.compiledItems, [tc.editedFn]);
      assert.deepEqual(bodyRes.reusedItems, ['keep']);
      assert.equal(bodyRes.hotSpliced, true);
      assert.equal(bodyRes.invalidatesDependents, false);
      assert.equal(bodyRes.cacheHitRate, 0.5);

      // Signature edit: V2 -> V3
      const sigPlan = computeSplicePlan(itemsV2, itemsV3, cas);
      assert.deepEqual(sigPlan.unchanged.map((i) => i.name), ['keep']);
      assert.equal(sigPlan.bodyOnlyDirty.length, 0);
      assert.deepEqual(sigPlan.signatureDirty.map((i) => i.name), [tc.editedFn]);
      assert.equal(sigPlan.invalidatesDependents, true);
      assert.equal(sigPlan.canHotSplice, false);

      const sigRes = await spliceModule(sigPlan, mockCompileItem);
      assert.deepEqual(sigRes.compiledItems, [tc.editedFn]);
      assert.deepEqual(sigRes.reusedItems, ['keep']);
      assert.equal(sigRes.hotSpliced, false);
      assert.equal(sigRes.invalidatesDependents, true);
    });
  }

  it('tracks added and removed items and invalidates dependents on removal or struct layout change', () => {
    const cas = new SubTuCasIndex();
    const v1 = [
      'struct Header { uint32_t magic; };',
      'int alpha(int x) { return x + 1; }',
      'int beta(int x) { return x + 2; }',
    ].join('\n');
    const v2 = [
      'struct Header { uint32_t magic; uint32_t flags; };',
      'int alpha(int x) { return x + 1; }',
      'int gamma(int x) { return x + 3; }',
    ].join('\n');

    const plan = computeSplicePlan(
      splitModuleItems('cxx', v1),
      splitModuleItems('cxx', v2),
      cas,
    );

    assert.deepEqual(plan.unchanged.map((i) => i.name), ['alpha']);
    assert.deepEqual(plan.signatureDirty.map((i) => i.name), ['Header']);
    assert.deepEqual(plan.added.map((i) => i.name), ['gamma']);
    assert.deepEqual(plan.removed.map((i) => i.name), ['beta']);
    assert.equal(plan.invalidatesDependents, true);
    assert.equal(plan.canHotSplice, false);
  });
});

describe('holo-compiler sub-tu-splicer: 1-of-100 function splice hit rate & round-trip determinism', () => {
  it('achieves >= 99% CAS reuse when editing 1 of 100 functions and matches cold compile bit-for-bit', async () => {
    const build100FnModule = (editedIndex: number, editedMultiplier: number): string => {
      const fns: string[] = [];
      for (let i = 0; i < 100; i += 1) {
        const mult = i === editedIndex ? editedMultiplier : i + 1;
        fns.push(`int fn_${i}(int x) {\n  return x * ${mult} + ${i};\n}`);
      }
      return fns.join('\n\n');
    };

    const srcV1 = build100FnModule(-1, 0);
    const srcV2 = build100FnModule(42, 9999);

    const cas = new SubTuCasIndex();
    const itemsV1 = splitModuleItems('cxx', srcV1);
    const itemsV2 = splitModuleItems('cxx', srcV2);
    assert.equal(itemsV1.length, 100);
    assert.equal(itemsV2.length, 100);

    // 1. Cold compile V1
    let compileCalls = 0;
    const countingCompiler = (item: SubTuItem): Uint8Array => {
      compileCalls += 1;
      return mockCompileItem(item);
    };

    const coldV1 = await spliceModule(computeSplicePlan([], itemsV1, cas), countingCompiler);
    assert.equal(coldV1.compiledCount, 100);
    assert.equal(coldV1.cacheHits, 0);
    assert.equal(compileCalls, 100);

    // 2. Incremental splice V1 -> V2 (only fn_42 body changed)
    compileCalls = 0;
    const planV2 = computeSplicePlan(itemsV1, itemsV2, cas);
    assert.equal(planV2.unchanged.length, 99);
    assert.equal(planV2.bodyOnlyDirty.length, 1);
    assert.equal(planV2.bodyOnlyDirty[0]!.name, 'fn_42');
    assert.equal(planV2.signatureDirty.length, 0);
    assert.equal(planV2.canHotSplice, true);
    assert.equal(planV2.invalidatesDependents, false);

    const splicedV2 = await spliceModule(planV2, countingCompiler);
    assert.equal(compileCalls, 1);
    assert.equal(splicedV2.compiledCount, 1);
    assert.deepEqual(splicedV2.compiledItems, ['fn_42']);
    assert.equal(splicedV2.cacheHits, 99);
    assert.ok(splicedV2.cacheHitRate >= 0.99, `expected >= 0.99 hit rate, got ${splicedV2.cacheHitRate}`);

    // 3. Bit-exact determinism: cold compile V2 into a fresh CAS must equal splicedV2 byte-for-byte
    const freshCas = new SubTuCasIndex();
    const coldV2 = await spliceModule(computeSplicePlan([], itemsV2, freshCas), mockCompileItem);
    assert.equal(splicedV2.artifactSha256, coldV2.artifactSha256);
    assert.deepEqual(splicedV2.artifactBytes, coldV2.artifactBytes);

    // 4. Round-trip decode verification
    assert.equal(DECODER.decode(splicedV2.artifactBytes.subarray(0, 8)), B8G_SPLICE_MAGIC);
    const decoded = decodeSplicedModule(splicedV2.artifactBytes);
    assert.equal(decoded.version, 1);
    assert.equal(decoded.toolchain, 'cxx');
    assert.equal(decoded.chunks.length, 100);
    assert.equal(decoded.chunks[42]!.name, 'fn_42');
    assert.ok(DECODER.decode(decoded.chunks[42]!.payload).includes('return x * 9999 + 42;'));
    assert.ok(DECODER.decode(decoded.chunks[0]!.payload).includes('return x * 1 + 0;'));
  });
});

describe('holo-compiler sub-tu-splicer: persistent .b8p disk CAS & target isolation', () => {
  it('persists compiled chunks as .b8p blobs on disk and achieves 100% cache reuse in a fresh index', async () => {
    const casDir = join(tmpdir(), `holo-subtu-cas-${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
      const source = [
        'export function alpha(a: number): number { return a + 1; }',
        'export function beta(b: number): number { return b * 2; }',
      ].join('\n');
      const items = splitModuleItems('ts', source);

      // Populate disk-backed CAS
      const casWriter = new SubTuCasIndex({ casDir });
      const res1 = await spliceModule(computeSplicePlan([], items, casWriter), mockCompileItem);
      assert.equal(res1.compiledCount, 2);
      assert.equal(res1.cacheHits, 0);
      assert.equal(casWriter.stats().diskEnabled, true);

      // Verify .b8p blob files exist on disk
      for (const item of items) {
        const key = computeSubTuCasKey({
          toolchain: 'ts',
          targetTriple: res1.targetTriple,
          itemName: item.name,
          itemHash: item.itemHash,
        });
        const blobFile = join(casDir, 'blobs', key.slice(0, 2), `${key}.b8p`);
        assert.ok(existsSync(blobFile), `expected .b8p blob at ${blobFile}`);
      }

      // Brand-new SubTuCasIndex pointing at the same casDir (cold memory, warm disk)
      const casReader = new SubTuCasIndex({ casDir });
      let readerCompiles = 0;
      const res2 = await spliceModule(computeSplicePlan(items, items, casReader), (item) => {
        readerCompiles += 1;
        return mockCompileItem(item);
      });

      assert.equal(readerCompiles, 0);
      assert.equal(res2.cacheHits, 2);
      assert.equal(res2.cacheHitRate, 1);
      assert.equal(res2.artifactSha256, res1.artifactSha256);
    } finally {
      rmSync(casDir, { recursive: true, force: true });
    }
  });

  it('isolates cached chunks across distinct target triples', async () => {
    const cas = new SubTuCasIndex();
    const items = splitModuleItems('zig', 'pub fn id(x: u32) u32 { return x; }');

    const winPlan = computeSplicePlan([], items, cas, { targetTriple: 'x86_64-windows-gnu' });
    const winRes = await spliceModule(winPlan, (item, ctx) =>
      ENCODER.encode(`${ctx.targetTriple}:${item.name}`),
    );
    assert.equal(winRes.compiledCount, 1);

    // Same item, different target triple -> must miss cache and compile for linux
    const linuxPlan = computeSplicePlan(items, items, cas, { targetTriple: 'x86_64-linux-musl' });
    const linuxRes = await spliceModule(linuxPlan, (item, ctx) =>
      ENCODER.encode(`${ctx.targetTriple}:${item.name}`),
    );
    assert.equal(linuxRes.compiledCount, 1);
    assert.equal(linuxRes.cacheHits, 0);
    assert.notEqual(winRes.artifactSha256, linuxRes.artifactSha256);

    const decodedLinux = decodeSplicedModule(linuxRes.artifactBytes);
    assert.equal(DECODER.decode(decodedLinux.chunks[0]!.payload), 'x86_64-linux-musl:id');
  });
});
