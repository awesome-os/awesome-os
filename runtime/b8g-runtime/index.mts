/**
 * Unified scriptable `b8g-runtime` host driving `sectium-es` (ECMAScript) and
 * `sectium-jvm` (JVM Tier-0 bytecode interpreter + Tier-2 C11 -> `zig cc -O3` AOT)
 * with SHA-256 content-addressed AOT caching and 64-byte-aligned `B8G_ARENA_V1`
 * `SharedArrayBuffer` views.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export {
  BytecodeBuilder,
  ConstantPoolBuilder,
  emitArraySumClass,
  emitFibClass,
  emitMinimalClassFile,
  JVM_ACCESS_FLAGS,
  JVM_ARRAY_TYPE,
  JVM_CLASS_MAGIC,
  JVM_DEFAULT_MAJOR_VERSION,
  JVM_DEFAULT_MINOR_VERSION,
  JVM_OPCODES,
  type ClassFileSpec,
  type MethodSpec,
} from './class-emitter.mts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = path.resolve(MODULE_DIR, '..', '..');
const DEFAULT_TIMEOUT_MS = 30_000;
const ARENA_ALIGNMENT_BYTES = 64;

export interface B8gRuntimeHostOptions {
  readonly workspaceRoot?: string;
  readonly esBinaryPath?: string;
  readonly jvmBinaryPath?: string;
  readonly sectiumJvmWasiPath?: string;
  readonly casDir?: string;
  readonly defaultTimeoutMs?: number;
}

export interface EsEvalOptions {
  readonly timeoutMs?: number;
}

export interface EsEvalResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface JvmRunOptions {
  readonly className?: string;
  readonly timeoutMs?: number;
}

export interface JvmRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface AotCompileOptions {
  readonly timeoutMs?: number;
}

export interface AotCompileResult {
  readonly exePath: string;
  readonly cPath: string;
  readonly sha256: string;
  readonly cacheHit: boolean;
  readonly durationMs: number;
}

export interface RuntimeBinaryInfo {
  readonly available: boolean;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface RuntimeCapabilities {
  readonly es: RuntimeBinaryInfo;
  readonly jvm: RuntimeBinaryInfo;
  readonly zig: RuntimeBinaryInfo;
  readonly sectiumJvmWasiPath: string;
  readonly sectiumJvmWasiBytes: number;
  readonly casDir: string;
  readonly platform: NodeJS.Platform;
  readonly sharedArrayBuffer: boolean;
}

export interface KotlinWasiSandboxSpec {
  readonly id: 'kotlin-wasi';
  readonly name: string;
  readonly engine: 'sectium-jvm.wasm';
  readonly wasmPath: string;
  readonly isolation: 'wasi-capability-sandbox';
  readonly kotlinIntrinsics: true;
  readonly hostFilesystemAccess: 'none-unless-mounted';
  readonly allowNetwork: false;
  readonly preopenedDirs: readonly string[];
}

/**
 * Return the capability-isolated Kotlin/JVM WASI container specification
 * backed by `sectium-jvm.wasm` (zero host filesystem access unless explicitly mounted).
 */
export function getKotlinWasiSandboxSpec(
  workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
): KotlinWasiSandboxSpec {
  return {
    id: 'kotlin-wasi',
    name: 'Kotlin/JVM WASI Container (sectium-jvm.wasm)',
    engine: 'sectium-jvm.wasm',
    wasmPath: path.resolve(
      workspaceRoot,
      'sections',
      'b8g-jvm',
      'dist',
      'sectium-jvm.wasm',
    ),
    isolation: 'wasi-capability-sandbox',
    kotlinIntrinsics: true,
    hostFilesystemAccess: 'none-unless-mounted',
    allowNetwork: false,
    preopenedDirs: [],
  };
}

function statBinary(binPath: string): RuntimeBinaryInfo {
  try {
    const st = fs.statSync(binPath);
    if (st.isFile()) {
      return { available: true, path: binPath, sizeBytes: st.size };
    }
  } catch {
    // Binary not built or absent
  }
  return { available: false, path: binPath, sizeBytes: 0 };
}

export class B8gRuntimeHost {
  readonly workspaceRoot: string;
  readonly esBinaryPath: string;
  readonly jvmBinaryPath: string;
  readonly sectiumJvmWasiPath: string;
  readonly zigShimPath: string;
  readonly binShimEntryPath: string;
  readonly binDir: string;
  readonly casDir: string;
  readonly defaultTimeoutMs: number;

  constructor(options: B8gRuntimeHostOptions = {}) {
    const isWin = process.platform === 'win32';
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
    this.esBinaryPath = path.resolve(
      options.esBinaryPath ??
        path.join(
          this.workspaceRoot,
          'sections',
          'b8g-es',
          'dist',
          isWin ? 'sectium-es.exe' : 'sectium-es',
        ),
    );
    this.jvmBinaryPath = path.resolve(
      options.jvmBinaryPath ??
        path.join(
          this.workspaceRoot,
          'sections',
          'b8g-jvm',
          'dist',
          isWin ? 'sectium-jvm.exe' : 'sectium-jvm',
        ),
    );
    this.sectiumJvmWasiPath = path.resolve(
      options.sectiumJvmWasiPath ??
        path.join(
          this.workspaceRoot,
          'sections',
          'b8g-jvm',
          'dist',
          'sectium-jvm.wasm',
        ),
    );
    this.binDir = path.join(this.workspaceRoot, 'bin');
    this.zigShimPath = path.join(this.binDir, isWin ? 'zig.cmd' : 'zig');
    this.binShimEntryPath = path.join(
      this.workspaceRoot,
      'packages',
      '@awesome-os',
      'bin-shim',
      'src',
      'index.mts',
    );
    this.casDir = path.resolve(
      options.casDir ?? path.join(this.workspaceRoot, '.b8g-cas', 'runtime-aot'),
    );
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Evaluate inline ECMAScript via `sectium-es.exe` (`shell: false`).
   */
  evalEs(code: string, options: EsEvalOptions = {}): EsEvalResult {
    if (!fs.existsSync(this.esBinaryPath)) {
      throw new Error(`sectium-es binary not found at ${this.esBinaryPath}`);
    }
    const t0 = performance.now();
    const res = spawnSync(this.esBinaryPath, ['-e', code], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? this.defaultTimeoutMs,
    });
    const durationMs = performance.now() - t0;
    if (res.error) {
      throw res.error;
    }
    return {
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      exitCode: res.status ?? 1,
      durationMs,
    };
  }

  /**
   * Execute a `.class` file on `sectium-jvm` Tier-0 bytecode interpreter.
   */
  runClassFile(classPath: string, options: JvmRunOptions = {}): JvmRunResult {
    if (!fs.existsSync(this.jvmBinaryPath)) {
      throw new Error(`sectium-jvm binary not found at ${this.jvmBinaryPath}`);
    }
    const resolvedClassPath = path.resolve(classPath);
    const t0 = performance.now();
    const res = spawnSync(this.jvmBinaryPath, ['--run', resolvedClassPath], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? this.defaultTimeoutMs,
    });
    const durationMs = performance.now() - t0;
    if (res.error) {
      throw res.error;
    }
    return {
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      exitCode: res.status ?? 1,
      durationMs,
    };
  }

  /**
   * Execute raw `.class` bytes on `sectium-jvm` Tier-0 bytecode interpreter.
   */
  runClassBytes(classBytes: Uint8Array, options: JvmRunOptions = {}): JvmRunResult {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-runtime-jvm-'));
    const rawName = (options.className ?? 'Main').replace(/[^A-Za-z0-9_$-]/g, '_');
    const classPath = path.join(tmpDir, `${rawName}.class`);
    try {
      fs.writeFileSync(classPath, classBytes);
      return this.runClassFile(classPath, options);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Tier-2 AOT compile a `.class` file via `sectium-jvm --emit-c` +
   * `zig cc -O3 -s` with SHA-256 content-addressed caching under
   * `.b8g-cas/runtime-aot/` so repeat runs hit CAS in `< 1 ms`.
   */
  aotCompileClass(
    classPath: string,
    outExePath?: string,
    options: AotCompileOptions = {},
  ): AotCompileResult {
    const t0 = performance.now();
    const resolvedClassPath = path.resolve(classPath);
    const classBytes = fs.readFileSync(resolvedClassPath);
    const sha256 = createHash('sha256').update(classBytes).digest('hex');

    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    const cachedCPath = path.join(this.casDir, `${sha256}.c`);
    const cachedExePath = path.join(this.casDir, `${sha256}${exeSuffix}`);
    const targetExePath = outExePath ? path.resolve(outExePath) : cachedExePath;

    if (fs.existsSync(cachedExePath)) {
      if (targetExePath !== cachedExePath) {
        fs.mkdirSync(path.dirname(targetExePath), { recursive: true });
        fs.copyFileSync(cachedExePath, targetExePath);
      }
      return {
        exePath: targetExePath,
        cPath: cachedCPath,
        sha256,
        cacheHit: true,
        durationMs: performance.now() - t0,
      };
    }

    if (!fs.existsSync(this.jvmBinaryPath)) {
      throw new Error(`sectium-jvm binary not found at ${this.jvmBinaryPath}`);
    }

    fs.mkdirSync(this.casDir, { recursive: true });
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const emitRes = spawnSync(
      this.jvmBinaryPath,
      ['--emit-c', resolvedClassPath, cachedCPath],
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
      },
    );
    if (emitRes.error) {
      throw emitRes.error;
    }
    if (emitRes.status !== 0) {
      throw new Error(
        `sectium-jvm --emit-c failed (exit ${emitRes.status}): ${emitRes.stderr || emitRes.stdout}`,
      );
    }

    const tmpExePath = path.join(
      this.casDir,
      `${sha256}.${process.pid}.tmp${exeSuffix}`,
    );
    const zigArgs = ['cc', '-std=c11', '-O3', '-s', cachedCPath, '-o', tmpExePath];
    const compileRes = this.invokeZig(zigArgs, timeoutMs);
    if (compileRes.error) {
      fs.rmSync(tmpExePath, { force: true });
      throw compileRes.error;
    }
    if (compileRes.status !== 0) {
      fs.rmSync(tmpExePath, { force: true });
      throw new Error(
        `zig cc AOT compile failed (exit ${compileRes.status}): ${compileRes.stderr || compileRes.stdout}`,
      );
    }

    fs.renameSync(tmpExePath, cachedExePath);
    if (targetExePath !== cachedExePath) {
      fs.mkdirSync(path.dirname(targetExePath), { recursive: true });
      fs.copyFileSync(cachedExePath, targetExePath);
    }

    return {
      exePath: targetExePath,
      cPath: cachedCPath,
      sha256,
      cacheHit: false,
      durationMs: performance.now() - t0,
    };
  }

  /**
   * Allocate a `SharedArrayBuffer`-backed `Uint8Array` aligned to 64 bytes
   * (`B8G_ARENA_V1` cache-line compatible).
   */
  createArenaView(byteLength: number): Uint8Array {
    if (!Number.isInteger(byteLength) || byteLength < 0) {
      throw new RangeError(
        `createArenaView(byteLength) requires a non-negative integer, got ${byteLength}`,
      );
    }
    const alignedLength =
      Math.ceil(Math.max(ARENA_ALIGNMENT_BYTES, byteLength) / ARENA_ALIGNMENT_BYTES) *
      ARENA_ALIGNMENT_BYTES;
    const sab = new SharedArrayBuffer(alignedLength);
    return new Uint8Array(sab, 0, alignedLength);
  }

  /**
   * Report runtime binary availability, byte sizes, and CAS cache location.
   */
  getCapabilities(): RuntimeCapabilities {
    const jvmWasi = statBinary(this.sectiumJvmWasiPath);
    return {
      es: statBinary(this.esBinaryPath),
      jvm: statBinary(this.jvmBinaryPath),
      zig: statBinary(this.zigShimPath),
      sectiumJvmWasiPath: jvmWasi.path,
      sectiumJvmWasiBytes: jvmWasi.sizeBytes,
      casDir: this.casDir,
      platform: process.platform,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    };
  }

  /**
   * Return the capability-isolated Kotlin/JVM WASI container spec for this host.
   */
  getKotlinWasiSandboxSpec(): KotlinWasiSandboxSpec {
    return {
      ...getKotlinWasiSandboxSpec(this.workspaceRoot),
      wasmPath: this.sectiumJvmWasiPath,
    };
  }

  private invokeZig(args: readonly string[], timeoutMs: number) {
    if (fs.existsSync(this.binShimEntryPath)) {
      return spawnSync(
        process.execPath,
        ['--experimental-strip-types', this.binShimEntryPath, ...args],
        {
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
          env: {
            ...process.env,
            SHIM_TARGET: 'zig',
            B8G_SHIM_ORIGIN_BIN: `${this.binDir}${path.sep}`,
          },
        },
      );
    }
    return spawnSync(this.zigShimPath, [...args], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
    });
  }
}
