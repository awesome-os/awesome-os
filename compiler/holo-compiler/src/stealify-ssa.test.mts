/**
 * @file intersections/holo-compiler/stealify-ssa.test.mts
 * @description Hermetic `node:test` verification suite for the Go-inspired zero-LLVM
 * StealifyLang SSA -> WebAssembly 1.0 -> CAS v11 compiler pipeline.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { CasV11Store } from './cas-v11-store.mts';
import {
  B8G_ABI_MAGIC_V3_HEX,
  compileStealifyToCasV11,
  emitWasmModule,
  parseTypedFunction,
  runEscapeAndSsaPasses,
} from './stealify-ssa.mts';

async function instantiateKernel(
  wasmBytes: Uint8Array,
  exportName: string,
): Promise<(...args: number[]) => number> {
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const fn = instance.exports[exportName];
  assert.equal(typeof fn, 'function', `Expected exported WASM function "${exportName}"`);
  return fn as (...args: number[]) => number;
}

describe('stealify-ssa zero-LLVM compiler pipeline', () => {
  it('compiles and executes add(a: number, b: number): number via WebAssembly.instantiate', async () => {
    const source = `
      export function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const ast = parseTypedFunction(source);
    const ssa = runEscapeAndSsaPasses(ast);
    const wasmBytes = emitWasmModule(ssa);

    // Verify WASM binary magic & version header
    assert.deepEqual(
      Array.from(wasmBytes.slice(0, 8)),
      [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    );
    assert.equal(ssa.escapeClass, 'stack');
    assert.equal(ssa.heapEscapes, 0);

    const add = await instantiateKernel(wasmBytes, 'add');
    assert.equal(add(17, 25), 42);
    assert.equal(add(-10.5, 4.25), -6.25);
    assert.equal(add(0, 0), 0);
  });

  it('compiles and executes fma(a, b, c) => a * b + c with correct operator precedence', async () => {
    const source = `
      export function fma(a: number, b: number, c: number): number {
        return a * b + c;
      }
    `;
    const ast = parseTypedFunction(source);
    const ssa = runEscapeAndSsaPasses(ast);
    const wasmBytes = emitWasmModule(ssa);

    const fma = await instantiateKernel(wasmBytes, 'fma');
    assert.equal(fma(6, 7, 10), 52);
    assert.equal(fma(2.5, 4, -3), 7);
    assert.equal(fma(-3, 5, 15), 0);
  });

  it('folds constant expressions in local bindings (const k = 10 + 5; return a * k + b;)', async () => {
    const source = `
      export function scaleAndBias(a: number, b: number): number {
        const k = 10 + 5;
        return a * k + b;
      }
    `;
    const ast = parseTypedFunction(source);
    const ssa = runEscapeAndSsaPasses(ast);

    assert.equal(ssa.escapeClass, 'stack');
    assert.equal(ssa.heapEscapes, 0);
    assert.equal(ssa.foldedConstants, 1);

    // Verify `10 + 5` was folded into a single `const 15` op and dead 10/5 ops were pruned
    const constOps = ssa.ops.filter((op) => op.op === 'const');
    assert.equal(constOps.length, 1);
    assert.equal(constOps[0]!.value, 15);

    const wasmBytes = emitWasmModule(ssa);
    const scaleAndBias = await instantiateKernel(wasmBytes, 'scaleAndBias');
    assert.equal(scaleAndBias(3, 4), 49);
    assert.equal(scaleAndBias(-2, 10), -20);
  });

  it('supports parenthesized expressions, division, unary negation, and shared DAG locals', async () => {
    const source = `
      export function quadNorm(a: number, b: number): number {
        const diff = (a - b) / 2;
        return -(diff * diff) + diff;
      }
    `;
    const ast = parseTypedFunction(source);
    const ssa = runEscapeAndSsaPasses(ast);
    const wasmBytes = emitWasmModule(ssa);

    const quadNorm = await instantiateKernel(wasmBytes, 'quadNorm');
    // diff = (10 - 4) / 2 = 3 => -(9) + 3 = -6
    assert.equal(quadNorm(10, 4), -6);
    // diff = (2 - 6) / 2 = -2 => -(4) + (-2) = -6
    assert.equal(quadNorm(2, 6), -6);
  });

  it('supports explicit i32 typed kernels with i32 WASM opcodes', async () => {
    const source = `
      export function intKernel(a: i32, b: i32): i32 {
        const factor: i32 = (3 + 4) * 2;
        return (a * factor - b) / 2;
      }
    `;
    const ast = parseTypedFunction(source);
    const ssa = runEscapeAndSsaPasses(ast);

    assert.equal(ssa.returnType, 'i32');
    assert.equal(ssa.foldedConstants, 2);
    assert.equal(ssa.escapeClass, 'stack');

    const wasmBytes = emitWasmModule(ssa);
    const intKernel = await instantiateKernel(wasmBytes, 'intKernel');
    // factor = 14; (5 * 14 - 4) / 2 = 66 / 2 = 33
    assert.equal(intKernel(5, 4), 33);
    // (1 * 14 - 3) / 2 = 11 / 2 = 5 (signed integer division)
    assert.equal(intKernel(1, 3), 5);
  });

  it('persists compiled WASM to CasV11Store under v11/files/00..ff/<sha512> with deduplication', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stealify-ssa-cas-'));
    const storeRoot = path.join(tmpRoot, 'v11');
    const store = new CasV11Store(storeRoot);

    try {
      const source = `
        export function affine(a: number, b: number): number {
          const k = 10 + 5;
          return a * k + b;
        }
      `;

      const first = compileStealifyToCasV11(source, store);
      assert.equal(first.name, 'affine');
      assert.equal(first.escapeClass, 'stack');
      assert.equal(first.heapEscapes, 0);
      assert.equal(first.abiMagic, B8G_ABI_MAGIC_V3_HEX);
      assert.equal(first.deduplicated, false);
      assert.match(first.sha512, /^[0-9a-f]{128}$/);

      // Verify exact v11/files/<shard>/<sha512> layout on disk
      const shard = first.sha512.slice(0, 2);
      const expectedPath = path.join(storeRoot, 'files', shard, first.sha512);
      assert.equal(first.blobPath, expectedPath);
      assert.equal(fs.existsSync(expectedPath), true);

      // Re-instantiate directly from the persisted CAS v11 blob
      const storedBytes = store.getBlob(first.sha512);
      assert.ok(storedBytes !== null);
      assert.deepEqual(Array.from(storedBytes), Array.from(first.wasmBytes));

      const affine = await instantiateKernel(storedBytes, 'affine');
      assert.equal(affine(4, 2), 62);

      // Second compile of identical source deduplicates cleanly in CAS v11
      const second = compileStealifyToCasV11(source, store);
      assert.equal(second.sha512, first.sha512);
      assert.equal(second.blobPath, first.blobPath);
      assert.equal(second.deduplicated, true);

      const meta = store.getBlobMeta(first.sha512);
      assert.ok(meta !== null);
      assert.equal(meta.meta?.abiMagic, '0x33564742');
      assert.equal(meta.meta?.escapeClass, 'stack');
    } finally {
      store.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
