import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const WIN_BIN = path.join(DIST_DIR, 'sectium-es.exe');
const LINUX_BIN = path.join(DIST_DIR, 'sectium-es');

function runSectiumEs(args: string[]) {
  const res = spawnSync(WIN_BIN, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  return res;
}

describe('sectium-es (C11 zero-V8 ECMAScript engine)', () => {
  it('1. --version prints sectium-es v0.1.0 and dup_v8=0 B', () => {
    const res = runSectiumEs(['--version']);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /sectium-es v0\.1\.0/);
    assert.match(res.stdout, /dup_v8=0 B/);
  });

  it('2. -e evaluates arithmetic, strings, if/else, while, and for loops', () => {
    const code = [
      'let sum = 0;',
      'for (let i = 1; i <= 10; i += 1) {',
      '  if (i % 2 === 0) {',
      '    sum += i;',
      '  } else {',
      '    sum += 1;',
      '  }',
      '}',
      'let count = 0;',
      'while (count < 4) {',
      '  count += 1;',
      '}',
      'let label = "ok-" + "es";',
      'console.log(label, sum, count, label.length);',
    ].join('\n');

    const res = runSectiumEs(['-e', code]);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.equal(res.stdout.trim(), 'ok-es 35 4 5');
  });

  it('3. recursive function fib(n) computes fib(20) === 6765', () => {
    const code = [
      'function fib(n) {',
      '  if (n <= 1) return n;',
      '  return fib(n - 1) + fib(n - 2);',
      '}',
      'console.log(fib(20));',
    ].join('\n');

    const res = runSectiumEs(['-e', code]);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '6765');
  });

  it('4. supports Arrays (push, length, indexing) and Objects (property access & mutation)', () => {
    const code = [
      'let arr = [10, 20];',
      'arr.push(30);',
      'arr[1] = 25;',
      'let obj = { a: 1, b: "hello" };',
      'obj.a = 42;',
      'obj["c"] = 99;',
      'console.log(arr.length, arr[0], arr[1], arr[2], obj.a, obj["b"], obj.c);',
    ].join('\n');

    const res = runSectiumEs(['-e', code]);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '3 10 25 30 42 hello 99');
  });

  it('5. supports Uint8Array(64), sys.writeFile/sys.readFile roundtrip, sys.platform(), and sys.clockNs()', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sectium-es-test-'));
    const tmpFile = path.join(tmpDir, 'roundtrip.txt').replace(/\\/g, '/');

    try {
      const code = [
        'let buf = new Uint8Array(64);',
        'buf[0] = 65;',
        'buf[31] = 128;',
        'buf[63] = 255;',
        `sys.writeFile("${tmpFile}", "sectium-zero-v8");`,
        `let content = sys.readFile("${tmpFile}");`,
        'let plat = sys.platform();',
        'let t0 = sys.clockNs();',
        'let t1 = sys.clockNs();',
        'let mono = (t0 > 0 && t1 >= t0);',
        'console.log(buf.length, buf[0], buf[31], buf[63], content, plat, mono);',
      ].join('\n');

      const res = runSectiumEs(['-e', code]);
      assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
      assert.equal(res.stdout.trim(), '64 65 128 255 sectium-zero-v8 win32 true');
      assert.equal(fs.readFileSync(tmpFile, 'utf8'), 'sectium-zero-v8');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. verifies Win64 PE size < 300 KB and Linux ELF64 magic bytes', () => {
    const winStat = fs.statSync(WIN_BIN);
    assert.ok(winStat.size > 0, 'sectium-es.exe should be non-empty');
    assert.ok(
      winStat.size < 300 * 1024,
      `expected sectium-es.exe < 300 KB, got ${winStat.size} bytes`,
    );

    const linuxBuf = fs.readFileSync(LINUX_BIN);
    assert.ok(linuxBuf.length > 4, 'sectium-es Linux binary should be non-empty');
    assert.deepEqual(
      [linuxBuf[0], linuxBuf[1], linuxBuf[2], linuxBuf[3]],
      [0x7f, 0x45, 0x4c, 0x46],
      'expected Linux ELF64 magic bytes (0x7f 0x45 0x4c 0x46)',
    );
  });
});
