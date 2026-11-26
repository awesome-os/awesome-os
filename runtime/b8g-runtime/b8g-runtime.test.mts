import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  B8gRuntimeHost,
  emitArraySumClass,
  emitFibClass,
  emitMinimalClassFile,
  JVM_CLASS_MAGIC,
  JVM_OPCODES,
} from './index.mts';

function readClassHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: view.getUint32(0, false),
    minorVersion: view.getUint16(4, false),
    majorVersion: view.getUint16(6, false),
    constantPoolCount: view.getUint16(8, false),
  };
}

describe('b8g-runtime unified host', () => {
  const host = new B8gRuntimeHost();

  it('1. getCapabilities() reports sectium-es binary availability, sizes, and CAS dir', () => {
    const caps = host.getCapabilities();
    assert.equal(caps.es.available, true, `expected sectium-es at ${caps.es.path}`);
    assert.ok(caps.es.sizeBytes > 0, 'sectium-es sizeBytes should be > 0');
    assert.equal(caps.zig.available, true, `expected zig shim at ${caps.zig.path}`);
    assert.equal(caps.sharedArrayBuffer, true);
    assert.ok(
      caps.casDir.endsWith(path.join('.b8g-cas', 'runtime-aot')),
      `unexpected casDir: ${caps.casDir}`,
    );
  });

  it('2. evalEs() executes inline ECMAScript via sectium-es.exe (shell: false)', () => {
    const code = [
      'function fib(n) { if (n <= 1) return n; return fib(n - 1) + fib(n - 2); }',
      'let total = 0;',
      'for (let i = 1; i <= 5; i++) total += i;',
      'console.log("es-ok", total, fib(10));',
    ].join('\n');

    const res = host.evalEs(code);
    assert.equal(res.exitCode, 0, `evalEs failed: ${res.stderr}`);
    assert.equal(res.stdout.trim(), 'es-ok 15 55');
    assert.ok(res.durationMs >= 0);
  });

  it('3. emitFibClass(25) emits a valid 0xCAFEBABE .class binary with fib & main', () => {
    const bytes = emitFibClass(25);
    assert.ok(bytes.byteLength > 100, 'Fib.class should contain constant pool and Code attributes');
    const hdr = readClassHeader(bytes);
    assert.equal(hdr.magic, JVM_CLASS_MAGIC, 'magic must be 0xCAFEBABE');
    assert.equal(hdr.minorVersion, 0);
    assert.ok(hdr.majorVersion >= 49 && hdr.majorVersion <= 52);
    assert.ok(hdr.constantPoolCount > 10);

    const ascii = new TextDecoder('latin1').decode(bytes);
    assert.ok(ascii.includes('Fib'), 'missing class name Fib');
    assert.ok(ascii.includes('fib'), 'missing method name fib');
    assert.ok(ascii.includes('(I)I'), 'missing fib descriptor (I)I');
    assert.ok(ascii.includes('main'), 'missing main method');
    assert.ok(ascii.includes('java/io/PrintStream'), 'missing PrintStream ref');
    assert.ok(ascii.includes('Code'), 'missing Code attribute');
  });

  it('4. emitArraySumClass() emits a valid 0xCAFEBABE .class binary with array opcodes', () => {
    const bytes = emitArraySumClass();
    assert.ok(bytes.byteLength > 100);
    const hdr = readClassHeader(bytes);
    assert.equal(hdr.magic, JVM_CLASS_MAGIC);
    assert.ok(hdr.constantPoolCount > 5);

    const ascii = new TextDecoder('latin1').decode(bytes);
    assert.ok(ascii.includes('ArraySum'), 'missing class name ArraySum');
    assert.ok(ascii.includes('println'), 'missing println ref');
    // Verify key opcodes appear in the assembled bytecode stream
    assert.ok(bytes.includes(JVM_OPCODES.newarray), 'missing newarray opcode');
    assert.ok(bytes.includes(JVM_OPCODES.arraylength), 'missing arraylength opcode');
    assert.ok(bytes.includes(JVM_OPCODES.iastore), 'missing iastore opcode');
    assert.ok(bytes.includes(JVM_OPCODES.iaload), 'missing iaload opcode');
  });

  it('5. emitMinimalClassFile() supports custom minimal classes', () => {
    const bytes = emitMinimalClassFile({
      className: 'Noop',
      methods: [
        {
          name: 'main',
          descriptor: '([Ljava/lang/String;)V',
          maxStack: 1,
          maxLocals: 1,
          code: [JVM_OPCODES.return],
        },
      ],
    });
    const hdr = readClassHeader(bytes);
    assert.equal(hdr.magic, JVM_CLASS_MAGIC);
    const ascii = new TextDecoder('latin1').decode(bytes);
    assert.ok(ascii.includes('Noop'));
  });

  it('6. createArenaView() allocates a 64-byte-aligned SharedArrayBuffer Uint8Array (B8G_ARENA_V1)', () => {
    const view1 = host.createArenaView(100);
    assert.ok(view1 instanceof Uint8Array);
    assert.ok(view1.buffer instanceof SharedArrayBuffer);
    assert.equal(view1.byteOffset, 0);
    assert.equal(view1.byteLength, 128);
    assert.equal(view1.byteLength % 64, 0);

    const view2 = host.createArenaView(64);
    assert.equal(view2.byteLength, 64);

    // Verify shared memory visibility via a second view on the same SharedArrayBuffer
    view1[0] = 0x42;
    view1[63] = 0x88;
    const alias = new Uint8Array(view1.buffer);
    assert.equal(alias[0], 0x42);
    assert.equal(alias[63], 0x88);
  });

  it('7. runClassBytes() and aotCompileClass() execute when sectium-jvm.exe is present', (t) => {
    const caps = host.getCapabilities();
    if (!caps.jvm.available) {
      t.skip(`sectium-jvm not built yet at ${caps.jvm.path}`);
      return;
    }

    const fibBytes = emitFibClass(20);
    const fibRun = host.runClassBytes(fibBytes, { className: 'Fib' });
    assert.equal(fibRun.exitCode, 0, `runClassBytes(Fib) failed: ${fibRun.stderr}`);
    assert.equal(fibRun.stdout.trim(), '6765');

    const arrBytes = emitArraySumClass();
    const arrRun = host.runClassBytes(arrBytes, { className: 'ArraySum' });
    assert.equal(arrRun.exitCode, 0, `runClassBytes(ArraySum) failed: ${arrRun.stderr}`);
    assert.equal(arrRun.stdout.trim(), '360');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-runtime-aot-test-'));
    try {
      const fibClassPath = path.join(tmpDir, 'Fib.class');
      fs.writeFileSync(fibClassPath, fibBytes);

      const first = host.aotCompileClass(fibClassPath);
      assert.equal(fs.existsSync(first.exePath), true);
      assert.equal(first.sha256.length, 64);

      const aotRun = spawnSync(first.exePath, [], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 10_000,
      });
      assert.equal(aotRun.status, 0, `AOT exe failed: ${aotRun.stderr}`);
      assert.equal(aotRun.stdout.trim(), '6765');

      const second = host.aotCompileClass(fibClassPath);
      assert.equal(second.cacheHit, true, 'second aotCompileClass call must hit CAS');
      assert.equal(second.sha256, first.sha256);
      assert.equal(second.exePath, first.exePath);
      assert.ok(
        second.durationMs < 25,
        `expected fast CAS hit, got ${second.durationMs.toFixed(3)} ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
