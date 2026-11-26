/**
 * @file intersections/holo-compiler/daemon.mts
 * @description Resident `holo-compiler` Named-Pipe Daemon & In-Process `B8G_ARENA_V1` Bridge.
 *
 * Strictly complies with `.agents/rules/host-pipe-ipc-mandate.md`:
 *   - ZERO `127.0.0.1` HTTP servers.
 *   - Strictly OS Named Pipe (`\\.\pipe\b8g-holo-compiler-<id>`) on Windows
 *     and Unix Domain Socket (`/tmp/b8g-holo-compiler-<id>.sock`) on POSIX via `node:net`.
 *   - 64-byte-aligned `B8G_ARENA_V1` / `B8G_ABI_MAGIC_V3` (`0x33564742`) binary frame
 *     encoder/decoder for zero-copy in-process C-ABI codegen handoff (`libholo_codegen`).
 *   - Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

// ============================================================================
// 1. Constants & 64-Byte Aligned B8G_ARENA_V1 / B8G_ABI_MAGIC_V3 Descriptor
// ============================================================================

/** Little-endian 'BGV3' (`0x33564742`) ABI magic shared with `sectium-cloud-control-plane`. */
export const B8G_ABI_MAGIC_V3 = 0x33564742;

/** `B8G_ARENA_V1` binary descriptor version. */
export const B8G_ARENA_V1_VERSION = 1;

/** Cache-line alignment required for zero-copy `B8G_ARENA_V1` / `SharedArrayBuffer` handoff. */
export const B8G_HOLO_ARENA_ALIGNMENT = 64;

/** Fixed 64-byte header size for `B8G_HOLO_ARENA_HEADER`. */
export const B8G_HOLO_ARENA_HEADER_BYTES = 64;

/** Default compiler version stamped into hermetic CAS keys. */
export const HOLO_DAEMON_COMPILER_VERSION = 'holo-1.0.0';

/** All supported toolchains tracked in the resident daemon session registry. */
export const HOLO_DAEMON_TOOLCHAINS = Object.freeze([
  'cxx',
  'rust',
  'zig',
  'wasi',
  'ts',
] as const);

export type HoloDaemonToolchain = (typeof HOLO_DAEMON_TOOLCHAINS)[number];

/** Numeric toolchain IDs encoded inside `B8G_HOLO_ARENA_HEADER` at byte offset 12. */
export const HOLO_TOOLCHAIN_IDS: Readonly<Record<HoloDaemonToolchain, number>> = Object.freeze({
  cxx: 0,
  rust: 1,
  zig: 2,
  wasi: 3,
  ts: 4,
});

const TOOLCHAIN_BY_ID: readonly HoloDaemonToolchain[] = HOLO_DAEMON_TOOLCHAINS;

const DEFAULT_TARGETS: Readonly<Record<HoloDaemonToolchain, string>> = Object.freeze({
  cxx: 'x86_64-windows-gnu',
  rust: 'x86_64-pc-windows-msvc',
  zig: 'x86_64-windows-gnu',
  wasi: 'wasm32-wasi',
  ts: 'es2024-erasable',
});

/** Bitflags for `B8G_HOLO_ARENA_HEADER.fields.flags` (offset 16). */
export const HOLO_ARENA_FLAGS = Object.freeze({
  NONE: 0,
  CACHE_HIT: 1 << 0,
  HAS_SIDECAR: 1 << 1,
  ZERO_COPY_SAB: 1 << 2,
} as const);

/**
 * Canonical 64-byte-aligned `B8G_ARENA_V1` / `B8G_ABI_MAGIC_V3` binary header descriptor
 * for zero-copy in-process C-ABI handoff to `libholo_codegen`.
 */
export const B8G_HOLO_ARENA_HEADER = Object.freeze({
  arenaFormat: 'B8G_ARENA_V1' as const,
  magic: B8G_ABI_MAGIC_V3,
  version: B8G_ARENA_V1_VERSION,
  alignment: B8G_HOLO_ARENA_ALIGNMENT,
  headerBytes: B8G_HOLO_ARENA_HEADER_BYTES,
  fields: Object.freeze({
    magic: Object.freeze({ offset: 0, bytes: 4, type: 'u32le' as const }),
    arenaVersion: Object.freeze({ offset: 4, bytes: 2, type: 'u16le' as const }),
    headerBytes: Object.freeze({ offset: 6, bytes: 2, type: 'u16le' as const }),
    abiVersion: Object.freeze({ offset: 8, bytes: 4, type: 'u32le' as const }),
    toolchainId: Object.freeze({ offset: 12, bytes: 4, type: 'u32le' as const }),
    flags: Object.freeze({ offset: 16, bytes: 4, type: 'u32le' as const }),
    payloadBytes: Object.freeze({ offset: 20, bytes: 4, type: 'u32le' as const }),
    schemaHash: Object.freeze({ offset: 24, bytes: 8, type: 'u64le' as const }),
    casKeyBytes: Object.freeze({ offset: 32, bytes: 32, type: 'bytes32' as const }),
  }),
});

export interface HoloArenaFrameInput {
  readonly toolchain: HoloDaemonToolchain;
  readonly abiVersion?: number;
  readonly flags?: number;
  readonly schemaHash?: bigint | string;
  readonly casKey: string;
  readonly payload: Uint8Array;
}

export interface HoloArenaFrame {
  readonly magic: number;
  readonly arenaVersion: number;
  readonly headerBytes: number;
  readonly abiVersion: number;
  readonly toolchainId: number;
  readonly toolchain: HoloDaemonToolchain;
  readonly flags: number;
  readonly payloadBytes: number;
  readonly alignedFrameBytes: number;
  readonly schemaHash: bigint;
  readonly casKey: string;
  readonly payload: Uint8Array;
}

// ============================================================================
// 2. Pipe Path & Binary Arena Helpers
// ============================================================================

const TEXT_ENCODER = new TextEncoder();

/**
 * Returns the canonical OS-native IPC pipe path for a `holo-compiler` resident daemon.
 * - Windows (`win32`): `\\.\pipe\b8g-holo-compiler-<instanceId>`
 * - POSIX (`linux`/`darwin`/etc.): `/tmp/b8g-holo-compiler-<instanceId>.sock`
 */
export function defaultHoloPipePath(
  instanceId = 'default',
  platform: NodeJS.Platform = process.platform,
): string {
  const sanitized = instanceId.trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'default';
  if (platform === 'win32') {
    return `\\\\.\\pipe\\b8g-holo-compiler-${sanitized}`;
  }
  return `/tmp/b8g-holo-compiler-${sanitized}.sock`;
}

/** Rounds a byte length up to the nearest 64-byte cache-line boundary. */
export function alignTo64(byteLength: number): number {
  if (byteLength <= 0) {
    return B8G_HOLO_ARENA_ALIGNMENT;
  }
  const rem = byteLength % B8G_HOLO_ARENA_ALIGNMENT;
  return rem === 0 ? byteLength : byteLength + (B8G_HOLO_ARENA_ALIGNMENT - rem);
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isValidToolchain(value: unknown): value is HoloDaemonToolchain {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HOLO_TOOLCHAIN_IDS, value);
}

function normalizeSchemaHashU64(schemaHash?: bigint | string): bigint {
  if (typeof schemaHash === 'bigint') {
    return BigInt.asUintN(64, schemaHash);
  }
  if (typeof schemaHash !== 'string' || schemaHash.trim().length === 0) {
    return 0n;
  }
  const trimmed = schemaHash.trim();
  if (/^0x[0-9a-fA-F]{1,16}$/.test(trimmed)) {
    return BigInt.asUintN(64, BigInt(trimmed));
  }
  if (/^[0-9a-fA-F]{1,16}$/.test(trimmed)) {
    return BigInt.asUintN(64, BigInt(`0x${trimmed}`));
  }
  const digest = sha256Hex(trimmed).slice(0, 16);
  return BigInt.asUintN(64, BigInt(`0x${digest}`));
}

function hexToBytes32(casKey: string): Uint8Array {
  const normalizedHex = /^[0-9a-fA-F]{64}$/.test(casKey) ? casKey.toLowerCase() : sha256Hex(casKey);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(normalizedHex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytes32ToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 32; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Encodes a `B8G_ARENA_V1` / `B8G_ABI_MAGIC_V3` 64-byte-aligned frame for zero-copy
 * in-process C-ABI handoff (`libholo_codegen`).
 *
 * When `targetBuffer` (`ArrayBuffer` or `SharedArrayBuffer`) is provided, the frame is
 * written directly in place at `byteOffset` (which must be 64-byte aligned).
 */
export function encodeHoloArenaFrame(
  input: HoloArenaFrameInput,
  targetBuffer?: ArrayBuffer | SharedArrayBuffer,
  byteOffset = 0,
): Uint8Array {
  if (!isValidToolchain(input.toolchain)) {
    throw new RangeError(`Unsupported holo toolchain: ${String(input.toolchain)}`);
  }
  if (byteOffset < 0 || byteOffset % B8G_HOLO_ARENA_ALIGNMENT !== 0) {
    throw new RangeError(
      `byteOffset (${byteOffset}) must be non-negative and ${B8G_HOLO_ARENA_ALIGNMENT}-byte aligned`,
    );
  }

  const payloadBytes = input.payload.byteLength;
  const alignedFrameBytes = alignTo64(B8G_HOLO_ARENA_HEADER_BYTES + payloadBytes);
  const buffer = targetBuffer ?? new ArrayBuffer(alignedFrameBytes);

  if (byteOffset + alignedFrameBytes > buffer.byteLength) {
    throw new RangeError(
      `Target arena buffer too small: need ${byteOffset + alignedFrameBytes} bytes, have ${buffer.byteLength}`,
    );
  }

  const frameBytes = new Uint8Array(buffer, byteOffset, alignedFrameBytes);
  frameBytes.fill(0);

  const view = new DataView(buffer, byteOffset, alignedFrameBytes);
  const casKeyBytes = hexToBytes32(input.casKey);
  const schemaHash = normalizeSchemaHashU64(input.schemaHash);
  const isSab = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
  const flags = (input.flags ?? HOLO_ARENA_FLAGS.NONE) | (isSab ? HOLO_ARENA_FLAGS.ZERO_COPY_SAB : 0);

  view.setUint32(B8G_HOLO_ARENA_HEADER.fields.magic.offset, B8G_ABI_MAGIC_V3, true);
  view.setUint16(B8G_HOLO_ARENA_HEADER.fields.arenaVersion.offset, B8G_ARENA_V1_VERSION, true);
  view.setUint16(B8G_HOLO_ARENA_HEADER.fields.headerBytes.offset, B8G_HOLO_ARENA_HEADER_BYTES, true);
  view.setUint32(B8G_HOLO_ARENA_HEADER.fields.abiVersion.offset, input.abiVersion ?? 3, true);
  view.setUint32(
    B8G_HOLO_ARENA_HEADER.fields.toolchainId.offset,
    HOLO_TOOLCHAIN_IDS[input.toolchain],
    true,
  );
  view.setUint32(B8G_HOLO_ARENA_HEADER.fields.flags.offset, flags >>> 0, true);
  view.setUint32(B8G_HOLO_ARENA_HEADER.fields.payloadBytes.offset, payloadBytes >>> 0, true);
  view.setBigUint64(B8G_HOLO_ARENA_HEADER.fields.schemaHash.offset, schemaHash, true);

  frameBytes.set(casKeyBytes, B8G_HOLO_ARENA_HEADER.fields.casKeyBytes.offset);
  frameBytes.set(input.payload, B8G_HOLO_ARENA_HEADER_BYTES);

  return frameBytes;
}

/**
 * Decodes a 64-byte-aligned `B8G_ARENA_V1` / `B8G_ABI_MAGIC_V3` frame and returns a
 * zero-copy `Uint8Array` view over its payload.
 */
export function decodeHoloArenaFrame(
  source: Uint8Array | ArrayBuffer | SharedArrayBuffer,
  byteOffset = 0,
): HoloArenaFrame {
  const bytes =
    source instanceof Uint8Array
      ? new Uint8Array(source.buffer, source.byteOffset + byteOffset, source.byteLength - byteOffset)
      : new Uint8Array(source, byteOffset);

  if (bytes.byteLength < B8G_HOLO_ARENA_HEADER_BYTES) {
    throw new RangeError(
      `Holo arena frame truncated: need at least ${B8G_HOLO_ARENA_HEADER_BYTES} bytes, got ${bytes.byteLength}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(B8G_HOLO_ARENA_HEADER.fields.magic.offset, true);
  if (magic !== B8G_ABI_MAGIC_V3) {
    throw new Error(
      `Invalid B8G_ABI_MAGIC_V3: expected 0x${B8G_ABI_MAGIC_V3.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }

  const arenaVersion = view.getUint16(B8G_HOLO_ARENA_HEADER.fields.arenaVersion.offset, true);
  if (arenaVersion !== B8G_ARENA_V1_VERSION) {
    throw new Error(`Unsupported B8G_ARENA version: expected ${B8G_ARENA_V1_VERSION}, got ${arenaVersion}`);
  }

  const headerBytes = view.getUint16(B8G_HOLO_ARENA_HEADER.fields.headerBytes.offset, true);
  if (headerBytes !== B8G_HOLO_ARENA_HEADER_BYTES) {
    throw new Error(
      `Unexpected B8G_HOLO_ARENA_HEADER size: expected ${B8G_HOLO_ARENA_HEADER_BYTES}, got ${headerBytes}`,
    );
  }

  const abiVersion = view.getUint32(B8G_HOLO_ARENA_HEADER.fields.abiVersion.offset, true);
  const toolchainId = view.getUint32(B8G_HOLO_ARENA_HEADER.fields.toolchainId.offset, true);
  const toolchain = TOOLCHAIN_BY_ID[toolchainId];
  if (!toolchain) {
    throw new RangeError(`Unknown holo toolchainId in arena header: ${toolchainId}`);
  }

  const flags = view.getUint32(B8G_HOLO_ARENA_HEADER.fields.flags.offset, true);
  const payloadBytes = view.getUint32(B8G_HOLO_ARENA_HEADER.fields.payloadBytes.offset, true);
  const schemaHash = view.getBigUint64(B8G_HOLO_ARENA_HEADER.fields.schemaHash.offset, true);

  const alignedFrameBytes = alignTo64(headerBytes + payloadBytes);
  if (headerBytes + payloadBytes > bytes.byteLength) {
    throw new RangeError(
      `Holo arena payload exceeds buffer bounds: header(${headerBytes}) + payload(${payloadBytes}) > ${bytes.byteLength}`,
    );
  }

  const casKeySlice = bytes.subarray(
    B8G_HOLO_ARENA_HEADER.fields.casKeyBytes.offset,
    B8G_HOLO_ARENA_HEADER.fields.casKeyBytes.offset + 32,
  );
  const casKey = bytes32ToHex(casKeySlice);
  const payload = bytes.subarray(headerBytes, headerBytes + payloadBytes);

  return {
    magic,
    arenaVersion,
    headerBytes,
    abiVersion,
    toolchainId,
    toolchain,
    flags,
    payloadBytes,
    alignedFrameBytes,
    schemaHash,
    casKey,
    payload,
  };
}

// ============================================================================
// 3. Resident Daemon RPC & CAS Contracts
// ============================================================================

export type HoloDaemonMethod = 'ping' | 'compile' | 'stats' | 'flush-cas' | 'shutdown';

export interface HoloDaemonRequestEnvelope {
  readonly id: string;
  readonly method: HoloDaemonMethod;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface HoloDaemonResponseEnvelope {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface HoloDaemonCompileParams {
  readonly unitId: string;
  readonly toolchain: HoloDaemonToolchain;
  readonly source: string;
  readonly flags?: readonly string[];
  readonly targetTriple?: string;
  readonly schemaHash?: string;
  readonly abiVersion?: number;
  readonly depDigests?: readonly string[];
  readonly compilerVersion?: string;
  readonly includeArenaFrame?: boolean;
}

export interface HoloDaemonCompileHookOutput {
  readonly artifactBytes: Uint8Array;
}

export interface HoloDaemonCompileResult {
  readonly unitId: string;
  readonly toolchain: HoloDaemonToolchain;
  readonly targetTriple: string;
  readonly casKey: string;
  readonly cacheHit: boolean;
  readonly elapsedMs: number;
  readonly artifactByteLength: number;
  readonly contentSha256: string;
  readonly consumerDebugBytes: 0;
  readonly sessionWarm: boolean;
  readonly arenaFrameBytes: number;
  readonly arenaFrameBase64?: string;
}

export interface HoloDaemonPingResult {
  readonly pong: true;
  readonly pid: number;
  readonly pipePath: string;
  readonly uptimeMs: number;
  readonly protocol: 'ndjson-pipe-v1';
  readonly abiMagic: number;
  readonly toolchains: readonly HoloDaemonToolchain[];
}

export interface HoloToolchainSessionStats {
  readonly toolchain: HoloDaemonToolchain;
  readonly warm: boolean;
  readonly compiles: number;
  readonly hits: number;
  readonly misses: number;
  readonly lastUsedAt: string | null;
  readonly lastCasKey: string | null;
}

export interface HoloDaemonStats {
  readonly pipePath: string;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly casEntries: number;
  readonly totalRequests: number;
  readonly totalCompiles: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly hitRate: number;
  readonly flushes: number;
  readonly sessions: Readonly<Record<HoloDaemonToolchain, HoloToolchainSessionStats>>;
}

export interface HoloDaemonFlushResult {
  readonly clearedEntries: number;
  readonly remainingEntries: number;
}

export interface HoloDaemonShutdownResult {
  readonly shuttingDown: true;
  readonly pipePath: string;
}

export interface HoloDaemonOptions {
  readonly pipePath?: string;
  readonly instanceId?: string;
  readonly compilerVersion?: string;
  readonly maxCasEntries?: number;
  readonly compileHook?: (
    params: HoloDaemonCompileParams,
    casKey: string,
  ) => Promise<HoloDaemonCompileHookOutput> | HoloDaemonCompileHookOutput;
}

export interface HoloDaemonHandle {
  readonly pipePath: string;
  readonly server: Server;
  getStats(): HoloDaemonStats;
  close(): Promise<void>;
}

interface ResidentCasEntry {
  readonly casKey: string;
  readonly toolchain: HoloDaemonToolchain;
  readonly targetTriple: string;
  readonly abiVersion: number;
  readonly schemaHash: string;
  readonly artifactBytes: Uint8Array;
  readonly contentSha256: string;
  readonly arenaFrame: Uint8Array;
  readonly createdAt: string;
}

interface MutableSessionState {
  warm: boolean;
  compiles: number;
  hits: number;
  misses: number;
  lastUsedAt: string | null;
  lastCasKey: string | null;
}

// ============================================================================
// 4. Deterministic CAS Key & Zero-AST Lowering Fallback
// ============================================================================

function computeResidentCasKey(
  params: HoloDaemonCompileParams,
  compilerVersion: string,
  targetTriple: string,
): string {
  const sortedFlags = [...(params.flags ?? [])].sort();
  const sortedDepDigests = [...(params.depDigests ?? [])].sort();
  const sourceDigest = sha256Hex(params.source);
  const canonicalPayload = JSON.stringify({
    v: 3,
    toolchain: params.toolchain,
    compilerVersion,
    targetTriple,
    flags: sortedFlags,
    sourceDigest,
    depDigests: sortedDepDigests,
    schemaHash: params.schemaHash ?? '0x0',
  });
  return sha256Hex(canonicalPayload);
}

function defaultZeroAstCompile(params: HoloDaemonCompileParams): Uint8Array {
  const lines = params.source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
  const ir = [`HOLO_IR_V1:${params.toolchain}:${params.unitId}`, ...lines].join('\n');
  return TEXT_ENCODER.encode(ir);
}

function tryUnlinkPosixSocket(pipePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    unlinkSync(pipePath);
  } catch {
    // Ignore ENOENT or already-removed socket path.
  }
}

// ============================================================================
// 5. Resident Named-Pipe Daemon Server
// ============================================================================

/**
 * Starts a resident `holo-compiler` NDJSON-over-pipe daemon holding:
 *   - Persistent in-memory `.b8p` CAS table
 *   - Hit/miss telemetry counters
 *   - Warm session registry across `cxx`, `rust`, `zig`, `wasi`, and `ts`
 */
export async function startHoloDaemon(opts: HoloDaemonOptions = {}): Promise<HoloDaemonHandle> {
  const pipePath = opts.pipePath ?? defaultHoloPipePath(opts.instanceId);
  const defaultCompilerVersion = opts.compilerVersion ?? HOLO_DAEMON_COMPILER_VERSION;
  const maxCasEntries = Math.max(1, opts.maxCasEntries ?? 4096);

  const startedAtMs = performance.now();
  const casTable = new Map<string, ResidentCasEntry>();
  const activeSockets = new Set<Socket>();

  const sessions: Record<HoloDaemonToolchain, MutableSessionState> = {
    cxx: { warm: false, compiles: 0, hits: 0, misses: 0, lastUsedAt: null, lastCasKey: null },
    rust: { warm: false, compiles: 0, hits: 0, misses: 0, lastUsedAt: null, lastCasKey: null },
    zig: { warm: false, compiles: 0, hits: 0, misses: 0, lastUsedAt: null, lastCasKey: null },
    wasi: { warm: false, compiles: 0, hits: 0, misses: 0, lastUsedAt: null, lastCasKey: null },
    ts: { warm: false, compiles: 0, hits: 0, misses: 0, lastUsedAt: null, lastCasKey: null },
  };

  let totalRequests = 0;
  let totalCompiles = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let flushes = 0;
  let closePromise: Promise<void> | null = null;

  function buildStats(): HoloDaemonStats {
    const snapshotSessions: Record<HoloDaemonToolchain, HoloToolchainSessionStats> = {
      cxx: { toolchain: 'cxx', ...sessions.cxx },
      rust: { toolchain: 'rust', ...sessions.rust },
      zig: { toolchain: 'zig', ...sessions.zig },
      wasi: { toolchain: 'wasi', ...sessions.wasi },
      ts: { toolchain: 'ts', ...sessions.ts },
    };
    return {
      pipePath,
      pid: process.pid,
      uptimeMs: Math.max(0, Number((performance.now() - startedAtMs).toFixed(3))),
      casEntries: casTable.size,
      totalRequests,
      totalCompiles,
      cacheHits,
      cacheMisses,
      hitRate: totalCompiles === 0 ? 0 : Number((cacheHits / totalCompiles).toFixed(4)),
      flushes,
      sessions: snapshotSessions,
    };
  }

  async function handleCompile(rawParams: Readonly<Record<string, unknown>>): Promise<HoloDaemonCompileResult> {
    const startMs = performance.now();
    const unitId = typeof rawParams.unitId === 'string' && rawParams.unitId.trim().length > 0
      ? rawParams.unitId.trim()
      : null;
    if (!unitId) {
      throw new Error('compile requires non-empty string param "unitId"');
    }

    if (!isValidToolchain(rawParams.toolchain)) {
      throw new Error(
        `compile requires valid "toolchain" (${HOLO_DAEMON_TOOLCHAINS.join(', ')})`,
      );
    }
    const toolchain = rawParams.toolchain;

    if (typeof rawParams.source !== 'string') {
      throw new Error('compile requires string param "source"');
    }

    const flags = Array.isArray(rawParams.flags)
      ? rawParams.flags.filter((item): item is string => typeof item === 'string')
      : [];
    const depDigests = Array.isArray(rawParams.depDigests)
      ? rawParams.depDigests.filter((item): item is string => typeof item === 'string')
      : [];
    const targetTriple =
      typeof rawParams.targetTriple === 'string' && rawParams.targetTriple.length > 0
        ? rawParams.targetTriple
        : DEFAULT_TARGETS[toolchain];
    const compilerVersion =
      typeof rawParams.compilerVersion === 'string' && rawParams.compilerVersion.length > 0
        ? rawParams.compilerVersion
        : defaultCompilerVersion;
    const schemaHash =
      typeof rawParams.schemaHash === 'string' && rawParams.schemaHash.length > 0
        ? rawParams.schemaHash
        : '0x0';
    const abiVersion =
      typeof rawParams.abiVersion === 'number' && Number.isInteger(rawParams.abiVersion) && rawParams.abiVersion > 0
        ? rawParams.abiVersion
        : 3;
    const includeArenaFrame = rawParams.includeArenaFrame === true;

    const params: HoloDaemonCompileParams = {
      unitId,
      toolchain,
      source: rawParams.source,
      flags,
      targetTriple,
      schemaHash,
      abiVersion,
      depDigests,
      compilerVersion,
      includeArenaFrame,
    };

    const casKey = computeResidentCasKey(params, compilerVersion, targetTriple);
    const session = sessions[toolchain];
    const nowIso = new Date().toISOString();

    totalCompiles += 1;
    session.compiles += 1;
    session.lastUsedAt = nowIso;
    session.lastCasKey = casKey;

    const cached = casTable.get(casKey);
    if (cached) {
      cacheHits += 1;
      session.hits += 1;
      session.warm = true;

      const hitFrame = includeArenaFrame
        ? encodeHoloArenaFrame({
            toolchain,
            abiVersion: cached.abiVersion,
            flags: HOLO_ARENA_FLAGS.CACHE_HIT,
            schemaHash: cached.schemaHash,
            casKey,
            payload: cached.artifactBytes,
          })
        : cached.arenaFrame;

      const elapsedMs = Number((performance.now() - startMs).toFixed(4));
      return {
        unitId,
        toolchain,
        targetTriple: cached.targetTriple,
        casKey,
        cacheHit: true,
        elapsedMs,
        artifactByteLength: cached.artifactBytes.byteLength,
        contentSha256: cached.contentSha256,
        consumerDebugBytes: 0,
        sessionWarm: session.warm,
        arenaFrameBytes: hitFrame.byteLength,
        ...(includeArenaFrame ? { arenaFrameBase64: Buffer.from(hitFrame).toString('base64') } : {}),
      };
    }

    cacheMisses += 1;
    session.misses += 1;

    const artifactBytes = opts.compileHook
      ? (await opts.compileHook(params, casKey)).artifactBytes
      : defaultZeroAstCompile(params);
    const contentSha256 = sha256Hex(artifactBytes);
    const arenaFrame = encodeHoloArenaFrame({
      toolchain,
      abiVersion,
      flags: HOLO_ARENA_FLAGS.NONE,
      schemaHash,
      casKey,
      payload: artifactBytes,
    });

    if (casTable.size >= maxCasEntries) {
      const oldestKey = casTable.keys().next().value;
      if (oldestKey !== undefined) {
        casTable.delete(oldestKey);
      }
    }

    casTable.set(casKey, {
      casKey,
      toolchain,
      targetTriple,
      abiVersion,
      schemaHash,
      artifactBytes,
      contentSha256,
      arenaFrame,
      createdAt: nowIso,
    });
    session.warm = true;

    const elapsedMs = Number((performance.now() - startMs).toFixed(4));
    return {
      unitId,
      toolchain,
      targetTriple,
      casKey,
      cacheHit: false,
      elapsedMs,
      artifactByteLength: artifactBytes.byteLength,
      contentSha256,
      consumerDebugBytes: 0,
      sessionWarm: session.warm,
      arenaFrameBytes: arenaFrame.byteLength,
      ...(includeArenaFrame ? { arenaFrameBase64: Buffer.from(arenaFrame).toString('base64') } : {}),
    };
  }

  function handleFlushCas(rawParams?: Readonly<Record<string, unknown>>): HoloDaemonFlushResult {
    flushes += 1;
    const filterToolchain = rawParams?.toolchain;
    let clearedEntries = 0;

    if (filterToolchain !== undefined) {
      if (!isValidToolchain(filterToolchain)) {
        throw new Error(
          `flush-cas invalid "toolchain" (${HOLO_DAEMON_TOOLCHAINS.join(', ')})`,
        );
      }
      for (const [key, entry] of casTable.entries()) {
        if (entry.toolchain === filterToolchain) {
          casTable.delete(key);
          clearedEntries += 1;
        }
      }
    } else {
      clearedEntries = casTable.size;
      casTable.clear();
    }

    return {
      clearedEntries,
      remainingEntries: casTable.size,
    };
  }

  async function closeServer(): Promise<void> {
    if (closePromise) {
      return closePromise;
    }
    closePromise = new Promise<void>((resolve) => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      server.close(() => {
        tryUnlinkPosixSocket(pipePath);
        resolve();
      });
    });
    return closePromise;
  }

  async function dispatchLine(socket: Socket, rawLine: string): Promise<void> {
    let reqId = 'unknown';
    try {
      const parsed = JSON.parse(rawLine) as Partial<HoloDaemonRequestEnvelope>;
      if (typeof parsed.id === 'string' && parsed.id.length > 0) {
        reqId = parsed.id;
      }
      if (typeof parsed.method !== 'string') {
        throw new Error('Missing RPC "method"');
      }

      totalRequests += 1;
      const params =
        parsed.params && typeof parsed.params === 'object'
          ? (parsed.params as Readonly<Record<string, unknown>>)
          : {};

      let result: unknown;
      let shouldShutdown = false;

      switch (parsed.method) {
        case 'ping': {
          const pingResult: HoloDaemonPingResult = {
            pong: true,
            pid: process.pid,
            pipePath,
            uptimeMs: Math.max(0, Number((performance.now() - startedAtMs).toFixed(3))),
            protocol: 'ndjson-pipe-v1',
            abiMagic: B8G_ABI_MAGIC_V3,
            toolchains: HOLO_DAEMON_TOOLCHAINS,
          };
          result = pingResult;
          break;
        }
        case 'compile': {
          result = await handleCompile(params);
          break;
        }
        case 'stats': {
          result = buildStats();
          break;
        }
        case 'flush-cas': {
          result = handleFlushCas(params);
          break;
        }
        case 'shutdown': {
          const shutdownResult: HoloDaemonShutdownResult = {
            shuttingDown: true,
            pipePath,
          };
          result = shutdownResult;
          shouldShutdown = true;
          break;
        }
        default: {
          throw new Error(`Unknown RPC method: ${String(parsed.method)}`);
        }
      }

      const response: HoloDaemonResponseEnvelope = {
        id: reqId,
        ok: true,
        result,
      };
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(response)}\n`, () => {
          if (shouldShutdown) {
            void closeServer();
          }
        });
      } else if (shouldShutdown) {
        void closeServer();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const response: HoloDaemonResponseEnvelope = {
        id: reqId,
        ok: false,
        error: {
          code: 'HOLO_DAEMON_ERROR',
          message,
        },
      };
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
    }
  }

  const server = createServer((socket) => {
    activeSockets.add(socket);
    socket.setEncoding('utf8');
    let buffered = '';

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newlineIdx = buffered.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffered.slice(0, newlineIdx).trim();
        buffered = buffered.slice(newlineIdx + 1);
        if (line.length > 0) {
          void dispatchLine(socket, line);
        }
        newlineIdx = buffered.indexOf('\n');
      }
    });

    socket.on('close', () => {
      activeSockets.delete(socket);
    });

    socket.on('error', () => {
      activeSockets.delete(socket);
    });
  });

  tryUnlinkPosixSocket(pipePath);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipePath);
  });

  return {
    pipePath,
    server,
    getStats: buildStats,
    close: closeServer,
  };
}

// ============================================================================
// 6. Lightweight Async Named-Pipe Client
// ============================================================================

export interface HoloDaemonClientOptions {
  readonly pipePath?: string;
  readonly instanceId?: string;
  readonly timeoutMs?: number;
}

/**
 * Lightweight async NDJSON-over-pipe client for talking to a resident `holo-compiler` daemon.
 * Opens a fresh pipe connection per request with strict timeout and clean socket teardown.
 */
export class HoloDaemonClient {
  readonly pipePath: string;
  readonly timeoutMs: number;

  constructor(pipePathOrOpts?: string | HoloDaemonClientOptions) {
    if (typeof pipePathOrOpts === 'string') {
      this.pipePath = pipePathOrOpts;
      this.timeoutMs = 5000;
    } else {
      this.pipePath = pipePathOrOpts?.pipePath ?? defaultHoloPipePath(pipePathOrOpts?.instanceId);
      this.timeoutMs = pipePathOrOpts?.timeoutMs ?? 5000;
    }
  }

  request<T = unknown>(
    method: HoloDaemonMethod,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const id = randomUUID();
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let buffered = '';
      const socket = createConnection(this.pipePath);
      socket.setEncoding('utf8');

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
        if (!socket.destroyed) {
          socket.end();
          socket.destroy();
        }
      };

      const finishResolve = (value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        finishReject(
          new Error(`HoloDaemonClient timeout after ${timeoutMs}ms calling "${method}" on ${this.pipePath}`),
        );
      }, timeoutMs);

      socket.once('connect', () => {
        socket.write(payload);
      });

      socket.on('data', (chunk: string) => {
        buffered += chunk;
        let newlineIdx = buffered.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffered.slice(0, newlineIdx).trim();
          buffered = buffered.slice(newlineIdx + 1);
          if (line.length > 0) {
            try {
              const envelope = JSON.parse(line) as HoloDaemonResponseEnvelope;
              if (envelope.id !== id) {
                continue;
              }
              if (envelope.ok) {
                finishResolve(envelope.result as T);
              } else {
                finishReject(
                  new Error(
                    envelope.error
                      ? `${envelope.error.code}: ${envelope.error.message}`
                      : `RPC "${method}" failed`,
                  ),
                );
              }
              return;
            } catch (err) {
              finishReject(
                new Error(
                  `Invalid NDJSON response from holo daemon: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
              return;
            }
          }
          newlineIdx = buffered.indexOf('\n');
        }
      });

      socket.once('error', (err) => {
        finishReject(err);
      });

      socket.once('end', () => {
        if (!settled) {
          finishReject(new Error(`Holo daemon closed pipe before replying to "${method}"`));
        }
      });
    });
  }

  ping(): Promise<HoloDaemonPingResult> {
    return this.request<HoloDaemonPingResult>('ping');
  }

  compile(params: HoloDaemonCompileParams): Promise<HoloDaemonCompileResult> {
    return this.request<HoloDaemonCompileResult>(
      'compile',
      params as unknown as Readonly<Record<string, unknown>>,
    );
  }

  stats(): Promise<HoloDaemonStats> {
    return this.request<HoloDaemonStats>('stats');
  }

  flushCas(params?: { readonly toolchain?: HoloDaemonToolchain }): Promise<HoloDaemonFlushResult> {
    return this.request<HoloDaemonFlushResult>(
      'flush-cas',
      params as Readonly<Record<string, unknown>> | undefined,
    );
  }

  shutdown(): Promise<HoloDaemonShutdownResult> {
    return this.request<HoloDaemonShutdownResult>('shutdown');
  }
}
