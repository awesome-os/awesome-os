/**
 * End-to-end test suite for `sectium-jvm` (Tier-0 C11 bytecode interpreter +
 * Tier-2 `.class` -> C11 -> `zig cc -O3` AOT).
 *
 * Self-contained (`node:test`, `erasableSyntaxOnly: true`, `shell: false`,
 * zero external imports) so it runs identically inside `awesome-os` and in
 * the standalone `awesome-os/sectium-jvm` repository.
 */

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(THIS_DIR, '..', '..');
const DIST_DIR = path.join(THIS_DIR, 'dist');
const WIN_BIN = path.join(DIST_DIR, 'sectium-jvm.exe');
const LINUX_BIN = path.join(DIST_DIR, 'sectium-jvm');
const WASI_BIN = path.join(DIST_DIR, 'sectium-jvm.wasm');
const HOST_BIN = process.platform === 'win32' ? WIN_BIN : LINUX_BIN;
const MAX_BINARY_BYTES = 200 * 1024;

const utf8Encoder = new TextEncoder();

/**
 * Tiny self-contained `0xCAFEBABE` `.class` emitter for `Fib.fib(n)` +
 * `Fib.main(String[] args)` -> `System.out.println(fib(n))`.
 * Uses major version 49 (Java 5.0, no StackMapTable required).
 */
function emitFibClass(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 127) {
    throw new RangeError(`emitFibClass(n) expects an integer in [0, 127], got ${n}`);
  }

  const out: number[] = [];
  const u1 = (v: number): void => {
    out.push(v & 0xff);
  };
  const u2 = (v: number): void => {
    out.push((v >>> 8) & 0xff, v & 0xff);
  };
  const u4 = (v: number): void => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  const bytes = (arr: Uint8Array | readonly number[]): void => {
    for (let i = 0; i < arr.length; i++) {
      out.push(arr[i] & 0xff);
    }
  };

  // Constant pool entries (#1..#23)
  const cpEntries: Uint8Array[] = [];
  const cpUtf8 = (s: string): number => {
    const raw = utf8Encoder.encode(s);
    const entry = new Uint8Array(3 + raw.length);
    entry[0] = 1; // CONSTANT_Utf8
    entry[1] = (raw.length >>> 8) & 0xff;
    entry[2] = raw.length & 0xff;
    entry.set(raw, 3);
    cpEntries.push(entry);
    return cpEntries.length;
  };
  const cpClass = (nameIdx: number): number => {
    cpEntries.push(Uint8Array.from([7, (nameIdx >>> 8) & 0xff, nameIdx & 0xff]));
    return cpEntries.length;
  };
  const cpNat = (nameIdx: number, descIdx: number): number => {
    cpEntries.push(
      Uint8Array.from([
        12,
        (nameIdx >>> 8) & 0xff,
        nameIdx & 0xff,
        (descIdx >>> 8) & 0xff,
        descIdx & 0xff,
      ]),
    );
    return cpEntries.length;
  };
  const cpRef = (tag: 9 | 10, classIdx: number, natIdx: number): number => {
    cpEntries.push(
      Uint8Array.from([
        tag,
        (classIdx >>> 8) & 0xff,
        classIdx & 0xff,
        (natIdx >>> 8) & 0xff,
        natIdx & 0xff,
      ]),
    );
    return cpEntries.length;
  };

  const utf8FibCls = cpUtf8('Fib');
  const clsFib = cpClass(utf8FibCls);
  const utf8ObjCls = cpUtf8('java/lang/Object');
  const clsObj = cpClass(utf8ObjCls);
  const utf8Code = cpUtf8('Code');
  const utf8FibName = cpUtf8('fib');
  const utf8FibDesc = cpUtf8('(I)I');
  const natFib = cpNat(utf8FibName, utf8FibDesc);
  const refFib = cpRef(10, clsFib, natFib);
  const utf8MainName = cpUtf8('main');
  const utf8MainDesc = cpUtf8('([Ljava/lang/String;)V');
  const utf8SysCls = cpUtf8('java/lang/System');
  const clsSys = cpClass(utf8SysCls);
  const utf8OutName = cpUtf8('out');
  const utf8OutDesc = cpUtf8('Ljava/io/PrintStream;');
  const natOut = cpNat(utf8OutName, utf8OutDesc);
  const refSystemOut = cpRef(9, clsSys, natOut);
  const utf8PsCls = cpUtf8('java/io/PrintStream');
  const clsPs = cpClass(utf8PsCls);
  const utf8PrintlnName = cpUtf8('println');
  const utf8PrintlnDesc = cpUtf8('(I)V');
  const natPrintln = cpNat(utf8PrintlnName, utf8PrintlnDesc);
  const refPrintln = cpRef(10, clsPs, natPrintln);

  // public static int fib(int n):
  //   0: iload_0
  //   1: iconst_1
  //   2: if_icmpgt +5 -> 7
  //   5: iload_0
  //   6: ireturn
  //   7: iload_0
  //   8: iconst_1
  //   9: isub
  //  10: invokestatic #refFib
  //  13: iload_0
  //  14: iconst_2
  //  15: isub
  //  16: invokestatic #refFib
  //  19: iadd
  //  20: ireturn
  const fibCode = Uint8Array.from([
    0x1a,
    0x04,
    0xa3, 0x00, 0x05,
    0x1a,
    0xac,
    0x1a,
    0x04,
    0x64,
    0xb8, (refFib >>> 8) & 0xff, refFib & 0xff,
    0x1a,
    0x05,
    0x64,
    0xb8, (refFib >>> 8) & 0xff, refFib & 0xff,
    0x60,
    0xac,
  ]);

  // public static void main(String[] args):
  //   0: getstatic #refSystemOut
  //   3: bipush n
  //   5: invokestatic #refFib
  //   8: invokevirtual #refPrintln
  //  11: return
  const mainCode = Uint8Array.from([
    0xb2, (refSystemOut >>> 8) & 0xff, refSystemOut & 0xff,
    0x10, n & 0xff,
    0xb8, (refFib >>> 8) & 0xff, refFib & 0xff,
    0xb6, (refPrintln >>> 8) & 0xff, refPrintln & 0xff,
    0xb1,
  ]);

  // ClassFile header
  u4(0xcafebabe);
  u2(0); // minor_version
  u2(49); // major_version (Java 5.0)
  u2(cpEntries.length + 1);
  for (let i = 0; i < cpEntries.length; i++) {
    bytes(cpEntries[i]);
  }

  u2(0x0021); // ACC_PUBLIC | ACC_SUPER
  u2(clsFib);
  u2(clsObj);
  u2(0); // interfaces_count
  u2(0); // fields_count
  u2(2); // methods_count

  const writeMethod = (
    nameIdx: number,
    descIdx: number,
    maxStack: number,
    maxLocals: number,
    code: Uint8Array,
  ): void => {
    u2(0x0009); // ACC_PUBLIC | ACC_STATIC
    u2(nameIdx);
    u2(descIdx);
    u2(1); // attributes_count (Code)
    u2(utf8Code);
    u4(12 + code.length);
    u2(maxStack);
    u2(maxLocals);
    u4(code.length);
    bytes(code);
    u2(0); // exception_table_length
    u2(0); // code attributes_count
  };

  writeMethod(utf8FibName, utf8FibDesc, 4, 1, fibCode);
  writeMethod(utf8MainName, utf8MainDesc, 2, 1, mainCode);

  u2(0); // class attributes_count
  return Uint8Array.from(out);
}

/**
 * Self-contained Kotlin-style `0xCAFEBABE` `.class` emitter exercising:
 * - `kotlin/jvm/internal/Intrinsics.checkNotNullParameter` & `areEqual`
 * - `new`, `dup`, `invokespecial <init>()V` (same-class + `java/lang/Object`)
 * - `putfield` / `getfield`, `putstatic` / `getstatic`
 * - `System.out.println(int)` -> outputs `42`
 */
function emitKotlinBoxClass(): Uint8Array {
  const out: number[] = [];
  const u2 = (v: number): void => {
    out.push((v >>> 8) & 0xff, v & 0xff);
  };
  const u4 = (v: number): void => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };
  const bytes = (arr: Uint8Array | readonly number[]): void => {
    for (let i = 0; i < arr.length; i++) {
      out.push(arr[i] & 0xff);
    }
  };

  const cpEntries: Uint8Array[] = [];
  const cpUtf8 = (s: string): number => {
    const raw = utf8Encoder.encode(s);
    const entry = new Uint8Array(3 + raw.length);
    entry[0] = 1;
    entry[1] = (raw.length >>> 8) & 0xff;
    entry[2] = raw.length & 0xff;
    entry.set(raw, 3);
    cpEntries.push(entry);
    return cpEntries.length;
  };
  const cpClass = (nameIdx: number): number => {
    cpEntries.push(Uint8Array.from([7, (nameIdx >>> 8) & 0xff, nameIdx & 0xff]));
    return cpEntries.length;
  };
  const cpString = (utf8Idx: number): number => {
    cpEntries.push(Uint8Array.from([8, (utf8Idx >>> 8) & 0xff, utf8Idx & 0xff]));
    return cpEntries.length;
  };
  const cpNat = (nameIdx: number, descIdx: number): number => {
    cpEntries.push(
      Uint8Array.from([
        12,
        (nameIdx >>> 8) & 0xff,
        nameIdx & 0xff,
        (descIdx >>> 8) & 0xff,
        descIdx & 0xff,
      ]),
    );
    return cpEntries.length;
  };
  const cpRef = (tag: 9 | 10, classIdx: number, natIdx: number): number => {
    cpEntries.push(
      Uint8Array.from([
        tag,
        (classIdx >>> 8) & 0xff,
        classIdx & 0xff,
        (natIdx >>> 8) & 0xff,
        natIdx & 0xff,
      ]),
    );
    return cpEntries.length;
  };

  const utf8BoxCls = cpUtf8('KotlinBox');
  const clsBox = cpClass(utf8BoxCls);
  const utf8ObjCls = cpUtf8('java/lang/Object');
  const clsObj = cpClass(utf8ObjCls);
  const utf8Code = cpUtf8('Code');
  const utf8InitName = cpUtf8('<init>');
  const utf8VoidDesc = cpUtf8('()V');
  const natInit = cpNat(utf8InitName, utf8VoidDesc);
  const refObjInit = cpRef(10, clsObj, natInit);
  const refBoxInit = cpRef(10, clsBox, natInit);

  const utf8ValName = cpUtf8('value');
  const utf8IntDesc = cpUtf8('I');
  const natVal = cpNat(utf8ValName, utf8IntDesc);
  const refBoxVal = cpRef(9, clsBox, natVal);

  const utf8InstName = cpUtf8('INSTANCE');
  const utf8BoxDesc = cpUtf8('LKotlinBox;');
  const natInst = cpNat(utf8InstName, utf8BoxDesc);
  const refBoxInst = cpRef(9, clsBox, natInst);

  const utf8IntrCls = cpUtf8('kotlin/jvm/internal/Intrinsics');
  const clsIntr = cpClass(utf8IntrCls);
  const utf8CnnName = cpUtf8('checkNotNullParameter');
  const utf8CnnDesc = cpUtf8('(Ljava/lang/Object;Ljava/lang/String;)V');
  const natCnn = cpNat(utf8CnnName, utf8CnnDesc);
  const refCnn = cpRef(10, clsIntr, natCnn);

  const utf8AreEqName = cpUtf8('areEqual');
  const utf8AreEqDesc = cpUtf8('(Ljava/lang/Object;Ljava/lang/Object;)Z');
  const natAreEq = cpNat(utf8AreEqName, utf8AreEqDesc);
  const refAreEq = cpRef(10, clsIntr, natAreEq);

  const strArgs = cpString(cpUtf8('args'));
  const strBox = cpString(cpUtf8('box'));

  const utf8MainName = cpUtf8('main');
  const utf8MainDesc = cpUtf8('([Ljava/lang/String;)V');

  const clsSys = cpClass(cpUtf8('java/lang/System'));
  const natOut = cpNat(cpUtf8('out'), cpUtf8('Ljava/io/PrintStream;'));
  const refSystemOut = cpRef(9, clsSys, natOut);

  const clsPs = cpClass(cpUtf8('java/io/PrintStream'));
  const natPrintln = cpNat(cpUtf8('println'), cpUtf8('(I)V'));
  const refPrintln = cpRef(10, clsPs, natPrintln);

  // public <init>()V: aload_0; invokespecial Object.<init>(); return
  const initCode = Uint8Array.from([
    0x2a,
    0xb7, (refObjInit >>> 8) & 0xff, refObjInit & 0xff,
    0xb1,
  ]);

  // public static void main(String[] args) -> prints 42
  const mainCode = Uint8Array.from([
    0x2a, // aload_0 (args)
    0x12, strArgs & 0xff, // ldc "args"
    0xb8, (refCnn >>> 8) & 0xff, refCnn & 0xff, // Intrinsics.checkNotNullParameter
    0xbb, (clsBox >>> 8) & 0xff, clsBox & 0xff, // new KotlinBox
    0x59, // dup
    0xb7, (refBoxInit >>> 8) & 0xff, refBoxInit & 0xff, // invokespecial KotlinBox.<init>
    0x4c, // astore_1 (box)
    0x2b, // aload_1
    0x12, strBox & 0xff, // ldc "box"
    0xb8, (refCnn >>> 8) & 0xff, refCnn & 0xff, // Intrinsics.checkNotNullParameter
    0x2b, // aload_1
    0x10, 40, // bipush 40
    0xb5, (refBoxVal >>> 8) & 0xff, refBoxVal & 0xff, // putfield KotlinBox.value
    0x2b, // aload_1
    0xb3, (refBoxInst >>> 8) & 0xff, refBoxInst & 0xff, // putstatic KotlinBox.INSTANCE
    0xb2, (refBoxInst >>> 8) & 0xff, refBoxInst & 0xff, // getstatic KotlinBox.INSTANCE
    0xb4, (refBoxVal >>> 8) & 0xff, refBoxVal & 0xff, // getfield KotlinBox.value -> 40
    0x2b, // aload_1
    0xb2, (refBoxInst >>> 8) & 0xff, refBoxInst & 0xff, // getstatic KotlinBox.INSTANCE
    0xb8, (refAreEq >>> 8) & 0xff, refAreEq & 0xff, // Intrinsics.areEqual -> 1
    0x60, // iadd -> 41
    0x04, // iconst_1
    0x60, // iadd -> 42
    0x3d, // istore_2
    0xb2, (refSystemOut >>> 8) & 0xff, refSystemOut & 0xff, // getstatic System.out
    0x1c, // iload_2
    0xb6, (refPrintln >>> 8) & 0xff, refPrintln & 0xff, // invokevirtual println(I)V
    0xb1, // return
  ]);

  u4(0xcafebabe);
  u2(0);
  u2(49);
  u2(cpEntries.length + 1);
  for (let i = 0; i < cpEntries.length; i++) {
    bytes(cpEntries[i]);
  }
  u2(0x0021);
  u2(clsBox);
  u2(clsObj);
  u2(0); // interfaces_count
  u2(0); // fields_count
  u2(2); // methods_count

  const writeMethod = (
    accessFlags: number,
    nameIdx: number,
    descIdx: number,
    maxStack: number,
    maxLocals: number,
    code: Uint8Array,
  ): void => {
    u2(accessFlags);
    u2(nameIdx);
    u2(descIdx);
    u2(1);
    u2(utf8Code);
    u4(12 + code.length);
    u2(maxStack);
    u2(maxLocals);
    u4(code.length);
    bytes(code);
    u2(0);
    u2(0);
  };

  writeMethod(0x0001, utf8InitName, utf8VoidDesc, 1, 1, initCode);
  writeMethod(0x0009, utf8MainName, utf8MainDesc, 4, 3, mainCode);

  u2(0); // class attributes_count
  return Uint8Array.from(out);
}

/**
 * Invoke `zig cc` via the workspace `@awesome-os/bin-shim` dispatcher (when
 * inside `awesome-os`) or fall back to `zig` / `.\bin\zig.cmd` when running
 * standalone — always with `shell: false`.
 */
function runZigCc(args: readonly string[]): SpawnSyncReturns<string> {
  const binDir = path.join(WORKSPACE_ROOT, 'bin');
  const binShimEntry = path.join(
    WORKSPACE_ROOT,
    'packages',
    '@awesome-os',
    'bin-shim',
    'src',
    'index.mts',
  );

  if (fs.existsSync(binShimEntry)) {
    return spawnSync(
      process.execPath,
      ['--experimental-strip-types', binShimEntry, 'cc', ...args],
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 60_000,
        env: {
          ...process.env,
          SHIM_TARGET: 'zig',
          B8G_SHIM_ORIGIN_BIN: `${binDir}${path.sep}`,
        },
      },
    );
  }

  const zigCmd = path.join(binDir, 'zig.cmd');
  if (process.platform === 'win32' && fs.existsSync(zigCmd)) {
    const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    return spawnSync(comspec, ['/d', '/s', '/c', zigCmd, 'cc', ...args], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 60_000,
    });
  }

  return spawnSync('zig', ['cc', ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  });
}

function runBin(binPath: string, args: readonly string[]): {
  readonly res: SpawnSyncReturns<string>;
  readonly wallMs: number;
} {
  const t0 = performance.now();
  const res = spawnSync(binPath, [...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  const wallMs = performance.now() - t0;
  return { res, wallMs };
}

describe('sectium-jvm end-to-end Tier-0 & Tier-2 AOT', () => {
  test('Test 1: --version prints sectium-jvm v0.1.0 and dup_jvm=0 B', () => {
    const { res } = runBin(HOST_BIN, ['--version']);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /sectium-jvm v0\.1\.0/);
    assert.match(res.stdout, /dup_jvm=0 B/);
  });

  test('Test 2: --bench exits 0 and prints 75025 (fib(25))', () => {
    const { res } = runBin(HOST_BIN, ['--bench']);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /75025/);
  });

  test('Test 3: Tier-0 executes generated 0xCAFEBABE Fib.class and outputs 75025', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sectium-jvm-t0-'));
    try {
      const fibBytes = emitFibClass(25);
      assert.equal(fibBytes[0], 0xca);
      assert.equal(fibBytes[1], 0xfe);
      assert.equal(fibBytes[2], 0xba);
      assert.equal(fibBytes[3], 0xbe);

      const classPath = path.join(tmpDir, 'Fib.class');
      fs.writeFileSync(classPath, fibBytes);

      const { res, wallMs } = runBin(HOST_BIN, ['--run', classPath]);
      assert.equal(res.error, undefined);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.equal(res.stdout.trim(), '75025');
      console.log(`  [Tier-0] Fib.class fib(25) = 75025 (${wallMs.toFixed(2)} ms wall)`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 4: Tier-2 AOT (--emit-c -> zig cc -O3 -s -> native Fib.exe) outputs 75025 and measures Tier-0 vs Tier-2', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sectium-jvm-t2-'));
    try {
      const classPath = path.join(tmpDir, 'Fib.class');
      const cPath = path.join(tmpDir, 'Fib.c');
      const exePath = path.join(
        tmpDir,
        process.platform === 'win32' ? 'Fib.exe' : 'Fib',
      );
      fs.writeFileSync(classPath, emitFibClass(25));

      // Measure Tier-0 interpreter wall-clock time
      const tier0 = runBin(HOST_BIN, ['--run', classPath]);
      assert.equal(tier0.res.error, undefined);
      assert.equal(tier0.res.status, 0, `Tier-0 stderr: ${tier0.res.stderr}`);
      assert.equal(tier0.res.stdout.trim(), '75025');

      // Emit C11 source from Fib.class
      const emit = runBin(HOST_BIN, ['--emit-c', classPath, cPath]);
      assert.equal(emit.res.error, undefined);
      assert.equal(emit.res.status, 0, `--emit-c stderr: ${emit.res.stderr}`);
      assert.ok(fs.existsSync(cPath), 'Fib.c must be emitted');

      // Compile Fib.c with zig cc -O3 -s
      const tCompile0 = performance.now();
      const cc = runZigCc(['-std=c11', '-O3', '-s', cPath, '-o', exePath]);
      const compileMs = performance.now() - tCompile0;
      assert.equal(cc.error, undefined);
      assert.equal(cc.status, 0, `zig cc failed: ${cc.stderr || cc.stdout}`);
      assert.ok(fs.existsSync(exePath), 'Fib.exe must be compiled');

      // Measure Tier-2 AOT native wall-clock time
      const tier2 = runBin(exePath, []);
      assert.equal(tier2.res.error, undefined);
      assert.equal(tier2.res.status, 0, `Tier-2 stderr: ${tier2.res.stderr}`);
      assert.equal(tier2.res.stdout.trim(), '75025');

      const speedup = tier2.wallMs > 0 ? tier0.wallMs / tier2.wallMs : 0;
      console.log(
        `  [Tier-0 vs Tier-2 AOT] fib(25) = 75025 | Tier-0: ${tier0.wallMs.toFixed(2)} ms | Tier-2 AOT: ${tier2.wallMs.toFixed(2)} ms (${speedup.toFixed(2)}x wall-clock) | emit-c: ${emit.wallMs.toFixed(2)} ms | zig cc -O3 -s: ${compileMs.toFixed(1)} ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 5: Win64 PE sectium-jvm.exe (< 200 KB) and Linux ELF64 sectium-jvm (7f 45 4c 46, < 200 KB)', () => {
    const winStat = fs.statSync(WIN_BIN);
    assert.ok(winStat.isFile(), 'sectium-jvm.exe must exist');
    assert.ok(
      winStat.size > 0 && winStat.size < MAX_BINARY_BYTES,
      `sectium-jvm.exe size ${winStat.size} B must be < ${MAX_BINARY_BYTES} B`,
    );
    const winHeader = fs.readFileSync(WIN_BIN).subarray(0, 2);
    assert.equal(winHeader[0], 0x4d, 'sectium-jvm.exe must start with MZ (0x4D)');
    assert.equal(winHeader[1], 0x5a, 'sectium-jvm.exe must start with MZ (0x5A)');

    const linuxStat = fs.statSync(LINUX_BIN);
    assert.ok(linuxStat.isFile(), 'Linux ELF64 sectium-jvm must exist');
    assert.ok(
      linuxStat.size > 0 && linuxStat.size < MAX_BINARY_BYTES,
      `sectium-jvm size ${linuxStat.size} B must be < ${MAX_BINARY_BYTES} B`,
    );
    const elfHeader = fs.readFileSync(LINUX_BIN).subarray(0, 5);
    assert.equal(elfHeader[0], 0x7f, 'ELF magic byte 0 must be 0x7F');
    assert.equal(elfHeader[1], 0x45, 'ELF magic byte 1 must be 0x45 (E)');
    assert.equal(elfHeader[2], 0x4c, 'ELF magic byte 2 must be 0x4C (L)');
    assert.equal(elfHeader[3], 0x46, 'ELF magic byte 3 must be 0x46 (F)');
    assert.equal(elfHeader[4], 0x02, 'ELF class byte must be 0x02 (ELF64)');

    console.log(
      `  [Binaries] sectium-jvm.exe = ${winStat.size} B (${(winStat.size / 1024).toFixed(1)} KB) | sectium-jvm = ${linuxStat.size} B (${(linuxStat.size / 1024).toFixed(1)} KB)`,
    );
  });

  test('Test 6: Kotlin/JVM .class (Intrinsics, new, dup, invokespecial, putfield/getfield, putstatic/getstatic) matches on Tier-0 and Tier-2 AOT', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sectium-jvm-kt-'));
    try {
      const classPath = path.join(tmpDir, 'KotlinBox.class');
      const cPath = path.join(tmpDir, 'KotlinBox.c');
      const exePath = path.join(
        tmpDir,
        process.platform === 'win32' ? 'KotlinBox.exe' : 'KotlinBox',
      );
      fs.writeFileSync(classPath, emitKotlinBoxClass());

      const tier0 = runBin(HOST_BIN, ['--run', classPath]);
      assert.equal(tier0.res.error, undefined);
      assert.equal(tier0.res.status, 0, `Tier-0 stderr: ${tier0.res.stderr}`);
      assert.equal(tier0.res.stdout.trim(), '42');

      const emit = runBin(HOST_BIN, ['--emit-c', classPath, cPath]);
      assert.equal(emit.res.error, undefined);
      assert.equal(emit.res.status, 0, `--emit-c stderr: ${emit.res.stderr}`);
      assert.ok(fs.existsSync(cPath), 'KotlinBox.c must be emitted');

      const cc = runZigCc(['-std=c11', '-O3', '-s', cPath, '-o', exePath]);
      assert.equal(cc.error, undefined);
      assert.equal(cc.status, 0, `zig cc failed: ${cc.stderr || cc.stdout}`);
      assert.ok(fs.existsSync(exePath), 'KotlinBox.exe must be compiled');

      const tier2 = runBin(exePath, []);
      assert.equal(tier2.res.error, undefined);
      assert.equal(tier2.res.status, 0, `Tier-2 stderr: ${tier2.res.stderr}`);
      assert.equal(tier2.res.stdout.trim(), '42');
      assert.equal(tier2.res.stdout.trim(), tier0.res.stdout.trim());

      console.log(
        `  [Kotlin/JVM] KotlinBox.class = 42 | Tier-0: ${tier0.wallMs.toFixed(2)} ms | Tier-2 AOT: ${tier2.wallMs.toFixed(2)} ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 7: WASI sectium-jvm.wasm exists, < 200 KB, and starts with WASM magic (00 61 73 6d)', () => {
    const wasiStat = fs.statSync(WASI_BIN);
    assert.ok(wasiStat.isFile(), 'sectium-jvm.wasm must exist');
    assert.ok(
      wasiStat.size > 0 && wasiStat.size < MAX_BINARY_BYTES,
      `sectium-jvm.wasm size ${wasiStat.size} B must be < ${MAX_BINARY_BYTES} B`,
    );
    const wasmHeader = fs.readFileSync(WASI_BIN).subarray(0, 4);
    assert.equal(wasmHeader[0], 0x00, 'WASM magic byte 0 must be 0x00');
    assert.equal(wasmHeader[1], 0x61, 'WASM magic byte 1 must be 0x61 (a)');
    assert.equal(wasmHeader[2], 0x73, 'WASM magic byte 2 must be 0x73 (s)');
    assert.equal(wasmHeader[3], 0x6d, 'WASM magic byte 3 must be 0x6d (m)');

    console.log(
      `  [WASI Binary] sectium-jvm.wasm = ${wasiStat.size} B (${(wasiStat.size / 1024).toFixed(1)} KB)`,
    );
  });
});
