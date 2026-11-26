/**
 * @file intersections/holo-compiler/effect-system.mts
 * @description Unified cross-language Algebraic Effect & Capability System for `holo-compiler`.
 *
 * Bridges `cxx`, `rust`, `zig`, `wasi`, and `ts` compilation units under StealifyLang's
 * 7-tuple `ExecutionContext = (B, D, L, T, κ, Λ, Ω)` with:
 *   1. Canonical 64-bit-compatible `EffectBit` bitmask (`uint64_t effect_mask` 1:1 ABI).
 *   2. Deterministic 7-tuple `ExecutionContext` -> allowed `EffectMask` derivation.
 *   3. Multi-language effect annotation parser (`@holo-effect`, `#[holo::effect(...)]`,
 *      `@HoloEffect(...)`) + implicit primitive effect inference.
 *   4. Call-graph fixed-point effect propagation, algebraic handler discharge
 *      (`with_handler(...)` / `EffectHandlerBinding`), and `<E>` effect polymorphism.
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies.
 */

import type { ExecutionContext } from '../../packages/@awesome-os/stealify-schema/src/index.mts';
import type { ToolchainKind } from '../../b8g-build/src/index.mts';

// ============================================================================
// 1. Canonical Effect Bitmask (1:1 with C11 `uint64_t effect_mask`)
// ============================================================================

export type EffectToolchainKind = ToolchainKind | 'ts';

export const EffectBit = Object.freeze({
  PURE: 0,
  ALLOC: 1 << 0,
  IO_FS: 1 << 1,
  IO_NET: 1 << 2,
  ARENA_SAB: 1 << 3,
  UNSAFE_FFI: 1 << 4,
  ASYNC: 1 << 5,
  GPU_WGPU: 1 << 6,
  PROCESS_SPAWN: 1 << 7,
} as const);

export type EffectBitKey = keyof typeof EffectBit;
export type EffectMask = number;

export type EffectName =
  | 'pure'
  | 'alloc'
  | 'io_fs'
  | 'io_net'
  | 'arena_sab'
  | 'unsafe_ffi'
  | 'async'
  | 'gpu_wgpu'
  | 'process_spawn';

export const ALL_EFFECTS_MASK: EffectMask =
  EffectBit.ALLOC |
  EffectBit.IO_FS |
  EffectBit.IO_NET |
  EffectBit.ARENA_SAB |
  EffectBit.UNSAFE_FFI |
  EffectBit.ASYNC |
  EffectBit.GPU_WGPU |
  EffectBit.PROCESS_SPAWN;

interface EffectBitDescriptor {
  readonly bit: EffectMask;
  readonly name: Exclude<EffectName, 'pure'>;
}

const ORDERED_EFFECT_BITS: readonly EffectBitDescriptor[] = Object.freeze([
  Object.freeze({ bit: EffectBit.ALLOC, name: 'alloc' }),
  Object.freeze({ bit: EffectBit.IO_FS, name: 'io_fs' }),
  Object.freeze({ bit: EffectBit.IO_NET, name: 'io_net' }),
  Object.freeze({ bit: EffectBit.ARENA_SAB, name: 'arena_sab' }),
  Object.freeze({ bit: EffectBit.UNSAFE_FFI, name: 'unsafe_ffi' }),
  Object.freeze({ bit: EffectBit.ASYNC, name: 'async' }),
  Object.freeze({ bit: EffectBit.GPU_WGPU, name: 'gpu_wgpu' }),
  Object.freeze({ bit: EffectBit.PROCESS_SPAWN, name: 'process_spawn' }),
]);

const EFFECT_NAME_ALIASES: Readonly<Record<string, EffectMask>> = Object.freeze({
  pure: EffectBit.PURE,
  alloc: EffectBit.ALLOC,
  heap: EffectBit.ALLOC,
  io_fs: EffectBit.IO_FS,
  'io-fs': EffectBit.IO_FS,
  fs: EffectBit.IO_FS,
  io_net: EffectBit.IO_NET,
  'io-net': EffectBit.IO_NET,
  net: EffectBit.IO_NET,
  arena_sab: EffectBit.ARENA_SAB,
  'arena-sab': EffectBit.ARENA_SAB,
  sab: EffectBit.ARENA_SAB,
  arena: EffectBit.ARENA_SAB,
  unsafe_ffi: EffectBit.UNSAFE_FFI,
  'unsafe-ffi': EffectBit.UNSAFE_FFI,
  unsafe: EffectBit.UNSAFE_FFI,
  ffi: EffectBit.UNSAFE_FFI,
  async: EffectBit.ASYNC,
  gpu_wgpu: EffectBit.GPU_WGPU,
  'gpu-wgpu': EffectBit.GPU_WGPU,
  wgpu: EffectBit.GPU_WGPU,
  gpu: EffectBit.GPU_WGPU,
  process_spawn: EffectBit.PROCESS_SPAWN,
  'process-spawn': EffectBit.PROCESS_SPAWN,
  spawn: EffectBit.PROCESS_SPAWN,
  process: EffectBit.PROCESS_SPAWN,
});

/**
 * Converts an `EffectMask` bitmask into its canonical ordered list of effect names.
 * Returns `['pure']` when `mask === 0`.
 */
export function effectMaskToNames(mask: EffectMask): readonly EffectName[] {
  const normalized = (mask >>> 0) & ALL_EFFECTS_MASK;
  if (normalized === EffectBit.PURE) {
    return Object.freeze(['pure']);
  }
  const names: EffectName[] = [];
  for (const entry of ORDERED_EFFECT_BITS) {
    if ((normalized & entry.bit) !== 0) {
      names.push(entry.name);
    }
  }
  return Object.freeze(names);
}

/**
 * Converts a list of effect names (canonical or supported aliases, case-insensitive)
 * into a single `EffectMask` bitmask. Throws `RangeError` on unrecognized names.
 */
export function namesToEffectMask(names: readonly string[]): EffectMask {
  let mask: EffectMask = EffectBit.PURE;
  for (const raw of names) {
    const key = raw.trim().toLowerCase();
    if (key.length === 0) {
      continue;
    }
    const bit = EFFECT_NAME_ALIASES[key];
    if (bit === undefined) {
      throw new RangeError(`Unknown holo effect name: "${raw}"`);
    }
    mask |= bit;
  }
  return mask;
}

/**
 * Projects an `EffectMask` into an unsigned 64-bit `bigint` matching the native
 * C11 `uint64_t effect_mask` ABI field.
 */
export function effectMaskToU64(mask: EffectMask): bigint {
  return BigInt.asUintN(64, BigInt((mask >>> 0) & ALL_EFFECTS_MASK));
}

/**
 * Reconstructs an `EffectMask` from a native C11 `uint64_t effect_mask` value.
 */
export function u64ToEffectMask(value: bigint): EffectMask {
  return Number(BigInt.asUintN(64, value) & BigInt(ALL_EFFECTS_MASK));
}

// ============================================================================
// 2. StealifyLang 7-Tuple ExecutionContext -> Allowed EffectMask
// ============================================================================

const SCOPE_TO_EFFECTS: Readonly<Record<string, EffectMask>> = Object.freeze({
  'effect.alloc': EffectBit.ALLOC,
  alloc: EffectBit.ALLOC,
  'effect.io_fs': EffectBit.IO_FS,
  'io.fs': EffectBit.IO_FS,
  'fs.read': EffectBit.IO_FS,
  'fs.write': EffectBit.IO_FS,
  'fs.*': EffectBit.IO_FS,
  'effect.io_net': EffectBit.IO_NET,
  'io.net': EffectBit.IO_NET,
  'net.fetch': EffectBit.IO_NET,
  'net.http': EffectBit.IO_NET,
  'net.*': EffectBit.IO_NET,
  'effect.arena_sab': EffectBit.ARENA_SAB,
  'arena.sab': EffectBit.ARENA_SAB,
  'sab.shared': EffectBit.ARENA_SAB,
  'effect.unsafe_ffi': EffectBit.UNSAFE_FFI,
  'ffi.unsafe': EffectBit.UNSAFE_FFI,
  'unsafe.ffi': EffectBit.UNSAFE_FFI,
  'kernel.ffi': EffectBit.UNSAFE_FFI,
  'effect.async': EffectBit.ASYNC,
  async: EffectBit.ASYNC,
  'effect.gpu_wgpu': EffectBit.GPU_WGPU,
  'gpu.wgpu': EffectBit.GPU_WGPU,
  'gpu.compute': EffectBit.GPU_WGPU,
  'gpu.*': EffectBit.GPU_WGPU,
  'effect.process_spawn': EffectBit.PROCESS_SPAWN,
  'process.spawn': EffectBit.PROCESS_SPAWN,
  'proc.spawn': EffectBit.PROCESS_SPAWN,
  'process.*': EffectBit.PROCESS_SPAWN,
  'holo.compile': EffectBit.ALLOC | EffectBit.ARENA_SAB | EffectBit.ASYNC,
});

function boundaryBaseEffects(boundary: ExecutionContext['boundary']): EffectMask {
  switch (boundary) {
    case 'wasi':
      return EffectBit.ALLOC | EffectBit.ASYNC;
    case 'in-process':
      return EffectBit.ALLOC | EffectBit.ASYNC;
    case 'microvm':
      return EffectBit.ALLOC | EffectBit.ARENA_SAB | EffectBit.ASYNC;
    case 'host-win32':
    case 'host-posix':
      return EffectBit.ALLOC | EffectBit.ARENA_SAB | EffectBit.ASYNC;
    case 'bare-metal':
      return EffectBit.ALLOC | EffectBit.ARENA_SAB | EffectBit.UNSAFE_FFI;
  }
}

function boundaryCeilingEffects(boundary: ExecutionContext['boundary']): EffectMask {
  switch (boundary) {
    case 'wasi':
      // WASI microkernel modules structurally cannot invoke host dlopen/FFI or spawn OS processes.
      return ALL_EFFECTS_MASK & ~(EffectBit.UNSAFE_FFI | EffectBit.PROCESS_SPAWN);
    case 'bare-metal':
      return ALL_EFFECTS_MASK & ~EffectBit.PROCESS_SPAWN;
    case 'in-process':
    case 'microvm':
    case 'host-win32':
    case 'host-posix':
      return ALL_EFFECTS_MASK;
  }
}

/**
 * Derives the exact allowed `EffectMask` from StealifyLang's 7-tuple `ExecutionContext`
 * (`boundary`, `display`, `lifetime`, `transport`, `capability.scopes`, `locality`, `persona`).
 */
export function executionContextToAllowedEffects(ctx: ExecutionContext): EffectMask {
  let allowed: EffectMask = boundaryBaseEffects(ctx.boundary);

  // Transport grants
  switch (ctx.transport) {
    case 'arena-sab':
      allowed |= EffectBit.ARENA_SAB;
      break;
    case 'os-pipe':
    case 'cdp-pipe':
      allowed |= EffectBit.ASYNC;
      break;
    case 'external-http':
      allowed |= EffectBit.IO_NET | EffectBit.ASYNC;
      break;
  }

  // Interactive foreground display enables WebGPU presentation on non-WASI boundaries
  if (ctx.display === 'interactive-fg' && ctx.boundary !== 'wasi') {
    allowed |= EffectBit.GPU_WGPU;
  }

  // Capability scopes (least-privilege explicit grants)
  for (const rawScope of ctx.capability.scopes) {
    const scope = rawScope.trim().toLowerCase();
    if (scope === '*') {
      allowed |= ALL_EFFECTS_MASK;
      continue;
    }
    const granted = SCOPE_TO_EFFECTS[scope];
    if (granted !== undefined) {
      allowed |= granted;
    }
  }

  // Enforce hard boundary ceilings
  allowed &= boundaryCeilingEffects(ctx.boundary);

  // Data sovereignty invariant: private data pinned to local-arena cannot exfiltrate over IO_NET
  if (ctx.capability.privateData === true && ctx.locality === 'local-arena') {
    allowed &= ~EffectBit.IO_NET;
  }

  return allowed & ALL_EFFECTS_MASK;
}

// ============================================================================
// 3. Cross-Language Effect Annotation Parser & Implicit Primitive Inference
// ============================================================================

export interface EffectAnnotation {
  readonly line: number;
  readonly raw: string;
  readonly effects: EffectMask;
  readonly explicitPure: boolean;
  readonly polymorphicVars: readonly string[];
}

export interface InferredEffectHit {
  readonly line: number;
  readonly effect: EffectMask;
  readonly effectName: Exclude<EffectName, 'pure'>;
  readonly primitive: string;
  readonly snippet: string;
}

export interface ExtractedEffects {
  readonly toolchain: EffectToolchainKind;
  readonly hasExplicitDeclaration: boolean;
  readonly explicitPure: boolean;
  readonly declaredMask: EffectMask;
  readonly inferredMask: EffectMask;
  readonly effectiveMask: EffectMask;
  readonly polymorphicVars: readonly string[];
  readonly inlineHandledMask: EffectMask;
  readonly annotations: readonly EffectAnnotation[];
  readonly inferredHits: readonly InferredEffectHit[];
  readonly unknownAnnotations: readonly string[];
}

interface PrimitiveRule {
  readonly effect: EffectMask;
  readonly effectName: Exclude<EffectName, 'pure'>;
  readonly primitive: string;
  readonly toolchains: readonly EffectToolchainKind[];
  readonly pattern: RegExp;
}

const ALL_TOOLCHAINS: readonly EffectToolchainKind[] = Object.freeze([
  'cxx',
  'rust',
  'zig',
  'wasi',
  'ts',
]);

const PRIMITIVE_RULES: readonly PrimitiveRule[] = Object.freeze([
  // ALLOC
  {
    effect: EffectBit.ALLOC,
    effectName: 'alloc',
    primitive: 'c_heap_alloc',
    toolchains: ['cxx', 'wasi'],
    pattern: /\b(?:malloc|calloc|realloc)\s*\(/,
  },
  {
    effect: EffectBit.ALLOC,
    effectName: 'alloc',
    primitive: 'rust_heap_alloc',
    toolchains: ['rust', 'wasi'],
    pattern: /\b(?:Box::new|Vec::new|String::from|String::new|std::alloc::)\b|\bvec!\s*[\[(]/,
  },
  {
    effect: EffectBit.ALLOC,
    effectName: 'alloc',
    primitive: 'zig_heap_alloc',
    toolchains: ['zig', 'wasi'],
    pattern: /\b(?:allocator\.alloc|allocator\.create|std\.heap\.|ArrayList)\b/,
  },
  {
    effect: EffectBit.ALLOC,
    effectName: 'alloc',
    primitive: 'ts_buffer_alloc',
    toolchains: ['ts'],
    pattern: /\b(?:new\s+ArrayBuffer|Buffer\.alloc)\s*\(/,
  },

  // IO_FS
  {
    effect: EffectBit.IO_FS,
    effectName: 'io_fs',
    primitive: 'c_fs_io',
    toolchains: ['cxx', 'wasi'],
    pattern: /\b(?:fopen|openat|__wasi_path_open)\s*\(|\bstd::(?:ifstream|ofstream|filesystem)\b/,
  },
  {
    effect: EffectBit.IO_FS,
    effectName: 'io_fs',
    primitive: 'rust_fs_io',
    toolchains: ['rust', 'wasi'],
    pattern: /\b(?:std::fs::|File::open|File::create|OpenOptions::new)\b/,
  },
  {
    effect: EffectBit.IO_FS,
    effectName: 'io_fs',
    primitive: 'zig_fs_io',
    toolchains: ['zig', 'wasi'],
    pattern: /\b(?:std\.fs\.|openFileAbsolute|createFileAbsolute)\b|\bcwd\(\)\.openFile\b/,
  },
  {
    effect: EffectBit.IO_FS,
    effectName: 'io_fs',
    primitive: 'ts_fs_io',
    toolchains: ['ts'],
    pattern: /\bfs\.[A-Za-z_]|['"]node:fs(?:\/promises)?['"]|\b(?:readFileSync|writeFileSync|Deno\.readFile|Bun\.file)\b/,
  },

  // IO_NET
  {
    effect: EffectBit.IO_NET,
    effectName: 'io_net',
    primitive: 'c_net_io',
    toolchains: ['cxx', 'wasi'],
    pattern: /\b(?:socket|connect|getaddrinfo|curl_easy_init)\s*\(/,
  },
  {
    effect: EffectBit.IO_NET,
    effectName: 'io_net',
    primitive: 'rust_net_io',
    toolchains: ['rust', 'wasi'],
    pattern: /\b(?:std::net::|TcpStream::|UdpSocket::|reqwest::)\b/,
  },
  {
    effect: EffectBit.IO_NET,
    effectName: 'io_net',
    primitive: 'zig_net_io',
    toolchains: ['zig', 'wasi'],
    pattern: /\b(?:std\.net\.|std\.http\.)\b/,
  },
  {
    effect: EffectBit.IO_NET,
    effectName: 'io_net',
    primitive: 'ts_net_io',
    toolchains: ['ts'],
    pattern: /\bfetch\s*\(|\bnew\s+WebSocket\s*\(|['"]node:(?:http|https|net)['"]/,
  },

  // ARENA_SAB
  {
    effect: EffectBit.ARENA_SAB,
    effectName: 'arena_sab',
    primitive: 'arena_sab_memory',
    toolchains: ALL_TOOLCHAINS,
    pattern: /\b(?:SharedArrayBuffer|B8G_ARENA_V1|ArenaSab|shm_open|CreateFileMapping|MapViewOfFile)\b|\bAtomics\.(?:load|store|wait|notify|add|compareExchange)\b/,
  },

  // UNSAFE_FFI
  {
    effect: EffectBit.UNSAFE_FFI,
    effectName: 'unsafe_ffi',
    primitive: 'dlopen_ffi',
    toolchains: ALL_TOOLCHAINS,
    pattern: /\b(?:dlopen|dlsym|LoadLibrary[AW]?|GetProcAddress)\s*\(/,
  },
  {
    effect: EffectBit.UNSAFE_FFI,
    effectName: 'unsafe_ffi',
    primitive: 'c_inline_asm',
    toolchains: ['cxx', 'wasi'],
    pattern: /\b(?:__asm__|asm\s+volatile)\b/,
  },
  {
    effect: EffectBit.UNSAFE_FFI,
    effectName: 'unsafe_ffi',
    primitive: 'rust_unsafe_block',
    toolchains: ['rust', 'wasi'],
    pattern: /\bunsafe\s*\{|\bunsafe\s+fn\b|\bextern\s+"C"\b/,
  },
  {
    effect: EffectBit.UNSAFE_FFI,
    effectName: 'unsafe_ffi',
    primitive: 'zig_unsafe_ptr',
    toolchains: ['zig', 'wasi'],
    pattern: /@(?:ptrFromInt|ptrCast)\s*\(|\bextern\s+fn\b|\basm\s+volatile\b/,
  },

  // ASYNC
  {
    effect: EffectBit.ASYNC,
    effectName: 'async',
    primitive: 'c_async',
    toolchains: ['cxx', 'wasi'],
    pattern: /\b(?:co_await|co_yield|std::async|pthread_create)\b/,
  },
  {
    effect: EffectBit.ASYNC,
    effectName: 'async',
    primitive: 'rust_async',
    toolchains: ['rust', 'wasi'],
    pattern: /\basync\s+fn\b|\.await\b|\btokio::spawn\b/,
  },
  {
    effect: EffectBit.ASYNC,
    effectName: 'async',
    primitive: 'zig_async',
    toolchains: ['zig', 'wasi'],
    pattern: /\basync\s+[A-Za-z_]|\bawait\s+[A-Za-z_]|\bsuspend\s*\{/,
  },
  {
    effect: EffectBit.ASYNC,
    effectName: 'async',
    primitive: 'ts_async',
    toolchains: ['ts'],
    pattern: /\basync\s+(?:function\b|\()|\bawait\s+|\bnew\s+Promise\s*\(/,
  },

  // GPU_WGPU
  {
    effect: EffectBit.GPU_WGPU,
    effectName: 'gpu_wgpu',
    primitive: 'wgpu_dispatch',
    toolchains: ALL_TOOLCHAINS,
    pattern: /\b(?:wgpu::|wgpu\.|wgpuCreateInstance|wgpuDeviceCreateComputePipeline|navigator\.gpu|requestAdapter|createComputePipeline|GPUDevice)\b/,
  },

  // PROCESS_SPAWN
  {
    effect: EffectBit.PROCESS_SPAWN,
    effectName: 'process_spawn',
    primitive: 'c_process_spawn',
    toolchains: ['cxx', 'wasi'],
    pattern: /\b(?:fork|execve|posix_spawn|system|CreateProcess[AW]?)\s*\(/,
  },
  {
    effect: EffectBit.PROCESS_SPAWN,
    effectName: 'process_spawn',
    primitive: 'rust_process_spawn',
    toolchains: ['rust', 'wasi'],
    pattern: /\b(?:std::process::Command|Command::new)\b/,
  },
  {
    effect: EffectBit.PROCESS_SPAWN,
    effectName: 'process_spawn',
    primitive: 'zig_process_spawn',
    toolchains: ['zig', 'wasi'],
    pattern: /\b(?:std\.process\.Child|ChildProcess)\b/,
  },
  {
    effect: EffectBit.PROCESS_SPAWN,
    effectName: 'process_spawn',
    primitive: 'ts_process_spawn',
    toolchains: ['ts'],
    pattern: /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(|['"]node:child_process['"]/,
  },
]);

const ANNOTATION_PATTERNS: readonly RegExp[] = Object.freeze([
  // Line comment or JSDoc: // @holo-effect: io_fs, async  |  /// @holo-effect(io_fs)  |  * @holo-effect: pure
  /(?:\/\/\/?|^\s*\*)\s*@holo-effect\s*(?::\s*([^*\r\n]+?)|\(\s*([^)]+?)\s*\))\s*$/,
  // Block comment: /* @holo-effect: pure */  |  /* @holo-effect(alloc, async) */
  /\/\*\s*@holo-effect\s*(?::\s*([^*]+?)|\(\s*([^)]+?)\s*\))\s*\*\//,
  // Rust attribute: #[holo::effect(arena_sab, <E>)]
  /#\[\s*holo::effect\s*\(\s*([^)]+?)\s*\)\s*\]/,
  // TypeScript decorator: @HoloEffect('io_fs', 'async')
  /@HoloEffect\s*\(\s*([^)]+?)\s*\)/,
]);

const INLINE_HANDLER_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:with_handler|withHandler)\s*\(\s*([^)]+?)\s*\)/g,
  /(?:\/\/\/?|\/\*)\s*@holo-handle\s*(?::\s*([^*\r\n]+?)|\(\s*([^)]+?)\s*\))\s*(?:\*\/)?/g,
]);

function stripCommentsForInference(source: string): string[] {
  // Replace /* ... */ block comments while preserving line count
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  return withoutBlock.split(/\r?\n/).map((line) => {
    const idx = line.indexOf('//');
    return idx >= 0 ? line.slice(0, idx) : line;
  });
}

function parseEffectTokenList(rawList: string): {
  readonly mask: EffectMask;
  readonly explicitPure: boolean;
  readonly polymorphicVars: readonly string[];
  readonly unknown: readonly string[];
} {
  let mask: EffectMask = EffectBit.PURE;
  let explicitPure = false;
  const polyVars: string[] = [];
  const unknown: string[] = [];

  const tokens = rawList
    .split(',')
    .map((t) => t.trim().replace(/^['"`]|['"`]$/g, '').trim())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    // Polymorphic effect variable: <E>, <Eff>, or EffectBit.<NAME>
    const polyMatch = /^<([A-Za-z_][A-Za-z0-9_]*)>$/.exec(token);
    if (polyMatch && polyMatch[1]) {
      polyVars.push(polyMatch[1]);
      continue;
    }

    const strippedPrefix = token.replace(/^EffectBit\./i, '');
    const normalized = strippedPrefix.toLowerCase();
    if (normalized === 'pure') {
      explicitPure = true;
      continue;
    }

    const bit = EFFECT_NAME_ALIASES[normalized];
    if (bit !== undefined) {
      mask |= bit;
    } else {
      unknown.push(token);
    }
  }

  return {
    mask,
    explicitPure,
    polymorphicVars: polyVars,
    unknown,
  };
}

/**
 * Parses explicit effect annotations across `cxx`, `rust`, `zig`, `wasi`, and `ts`
 * AND infers implicit effects from source-level primitives.
 */
export function extractDeclaredEffects(
  toolchain: EffectToolchainKind,
  source: string,
): ExtractedEffects {
  const rawLines = source.split(/\r?\n/);
  const annotations: EffectAnnotation[] = [];
  const unknownAnnotations: string[] = [];
  const polyVarSet = new Set<string>();

  let declaredMask: EffectMask = EffectBit.PURE;
  let explicitPure = false;
  let inlineHandledMask: EffectMask = EffectBit.PURE;

  // 1. Parse explicit annotations and inline handlers
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!;
    for (const pattern of ANNOTATION_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const rawList = (match[1] ?? match[2] ?? '').trim();
        const parsed = parseEffectTokenList(rawList);
        declaredMask |= parsed.mask;
        if (parsed.explicitPure) {
          explicitPure = true;
        }
        for (const v of parsed.polymorphicVars) {
          polyVarSet.add(v);
        }
        for (const u of parsed.unknown) {
          unknownAnnotations.push(u);
        }
        annotations.push(
          Object.freeze({
            line: i + 1,
            raw: match[0].trim(),
            effects: parsed.mask,
            explicitPure: parsed.explicitPure,
            polymorphicVars: Object.freeze([...parsed.polymorphicVars]),
          }),
        );
        break;
      }
    }

    for (const handlerPattern of INLINE_HANDLER_PATTERNS) {
      handlerPattern.lastIndex = 0;
      let hMatch: RegExpExecArray | null = handlerPattern.exec(line);
      while (hMatch !== null) {
        const rawList = (hMatch[1] ?? hMatch[2] ?? '').trim();
        const parsed = parseEffectTokenList(rawList);
        inlineHandledMask |= parsed.mask;
        hMatch = handlerPattern.exec(line);
      }
    }
  }

  // 2. Infer implicit effects from stripped (non-comment) source lines
  const codeLines = stripCommentsForInference(source);
  const inferredHits: InferredEffectHit[] = [];
  let inferredMask: EffectMask = EffectBit.PURE;

  for (let i = 0; i < codeLines.length; i += 1) {
    const codeLine = codeLines[i]!;
    if (codeLine.trim().length === 0) {
      continue;
    }
    for (const rule of PRIMITIVE_RULES) {
      if (!rule.toolchains.includes(toolchain)) {
        continue;
      }
      if (rule.pattern.test(codeLine)) {
        inferredMask |= rule.effect;
        inferredHits.push(
          Object.freeze({
            line: i + 1,
            effect: rule.effect,
            effectName: rule.effectName,
            primitive: rule.primitive,
            snippet: codeLine.trim(),
          }),
        );
      }
    }
  }

  const effectiveMask = (declaredMask | inferredMask) & ~inlineHandledMask;

  return Object.freeze({
    toolchain,
    hasExplicitDeclaration: annotations.length > 0,
    explicitPure: explicitPure && declaredMask === EffectBit.PURE,
    declaredMask,
    inferredMask,
    effectiveMask,
    polymorphicVars: Object.freeze([...polyVarSet]),
    inlineHandledMask,
    annotations: Object.freeze(annotations),
    inferredHits: Object.freeze(inferredHits),
    unknownAnnotations: Object.freeze(unknownAnnotations),
  });
}

// ============================================================================
// 4. Call-Graph Propagation, Handler Discharge & Effect Polymorphism Checker
// ============================================================================

export interface EffectModuleUnit {
  readonly unitId: string;
  readonly toolchain: EffectToolchainKind;
  readonly source: string;
  /** Unit IDs directly invoked by this unit. */
  readonly calls?: readonly string[];
  /** Concrete effect instantiations for polymorphic callees (`calleeUnitId -> EffectMask`). */
  readonly polymorphicBindings?: Readonly<Record<string, EffectMask>>;
}

export interface EffectHandlerBinding {
  /** Caller unit installing the handler (or `'*'` for module-wide handler). */
  readonly callerUnitId: string;
  /** Optional callee unit intercepted by this handler; omit to handle all callees of `callerUnitId`. */
  readonly calleeUnitId?: string;
  /** Bitmask of effects discharged by this handler. */
  readonly handles: EffectMask;
  /** Optional residual effects introduced by the handler itself (default: `EffectBit.PURE`). */
  readonly residualEffects?: EffectMask;
}

export type EffectDiagnosticCode =
  | 'HOLO_EFF_UNDECLARED'
  | 'HOLO_EFF_FORBIDDEN_BY_CONTEXT'
  | 'HOLO_EFF_UNKNOWN_ANNOTATION';

export interface EffectDiagnostic {
  readonly code: EffectDiagnosticCode;
  readonly unitId: string;
  readonly undeclaredEffects: readonly EffectName[];
  readonly forbiddenByContext: readonly EffectName[];
  readonly undeclaredMask: EffectMask;
  readonly forbiddenMask: EffectMask;
  readonly remediation: string;
}

export interface UnitEffectSummary {
  readonly unitId: string;
  readonly toolchain: EffectToolchainKind;
  readonly declaredMask: EffectMask;
  readonly inferredMask: EffectMask;
  readonly propagatedMask: EffectMask;
  readonly dischargedMask: EffectMask;
  readonly effectiveMask: EffectMask;
  readonly effectiveEffects: readonly EffectName[];
  readonly polymorphicVars: readonly string[];
  readonly isPure: boolean;
}

export interface ModuleEffectCheckResult {
  readonly ok: boolean;
  readonly allowedMask: EffectMask;
  readonly allowedEffects: readonly EffectName[];
  readonly unitSummaries: Readonly<Record<string, UnitEffectSummary>>;
  readonly diagnostics: readonly EffectDiagnostic[];
}

function formatAnnotationSuggestion(
  toolchain: EffectToolchainKind,
  effects: readonly EffectName[],
): string {
  const list = effects.join(', ');
  if (toolchain === 'rust') {
    return `#[holo::effect(${list})]`;
  }
  return `// @holo-effect: ${list}`;
}

function formatContextRemediation(
  ctx: ExecutionContext,
  forbiddenMask: EffectMask,
): string {
  const hints: string[] = [];
  if ((forbiddenMask & EffectBit.IO_FS) !== 0) {
    hints.push('add capability scope "io.fs" (or discharge via with_handler(IO_FS))');
  }
  if ((forbiddenMask & EffectBit.IO_NET) !== 0) {
    if (ctx.capability.privateData === true && ctx.locality === 'local-arena') {
      hints.push('privateData on local-arena forbids IO_NET; remove network access or relax locality/privateData');
    } else {
      hints.push('set transport="external-http" or add capability scope "io.net"');
    }
  }
  if ((forbiddenMask & EffectBit.ARENA_SAB) !== 0) {
    hints.push('set transport="arena-sab" or add capability scope "arena.sab"');
  }
  if ((forbiddenMask & EffectBit.UNSAFE_FFI) !== 0) {
    if (ctx.boundary === 'wasi') {
      hints.push('boundary="wasi" structurally forbids UNSAFE_FFI; switch boundary or remove unsafe/FFI');
    } else {
      hints.push('add capability scope "ffi.unsafe"');
    }
  }
  if ((forbiddenMask & EffectBit.GPU_WGPU) !== 0) {
    hints.push('set display="interactive-fg" or add capability scope "gpu.wgpu"');
  }
  if ((forbiddenMask & EffectBit.PROCESS_SPAWN) !== 0) {
    if (ctx.boundary === 'wasi' || ctx.boundary === 'bare-metal') {
      hints.push(`boundary="${ctx.boundary}" structurally forbids PROCESS_SPAWN`);
    } else {
      hints.push('add capability scope "process.spawn"');
    }
  }
  if ((forbiddenMask & EffectBit.ASYNC) !== 0) {
    hints.push('add capability scope "async"');
  }
  if ((forbiddenMask & EffectBit.ALLOC) !== 0) {
    hints.push('add capability scope "alloc"');
  }
  return hints.join('; ');
}

function resolveHandlersForEdge(
  handlers: readonly EffectHandlerBinding[],
  callerUnitId: string,
  calleeUnitId: string,
): { readonly handled: EffectMask; readonly residual: EffectMask } {
  let handled: EffectMask = EffectBit.PURE;
  let residual: EffectMask = EffectBit.PURE;
  for (const h of handlers) {
    const callerMatches = h.callerUnitId === callerUnitId || h.callerUnitId === '*';
    const calleeMatches = h.calleeUnitId === undefined || h.calleeUnitId === calleeUnitId;
    if (callerMatches && calleeMatches) {
      handled |= h.handles;
      residual |= h.residualEffects ?? EffectBit.PURE;
    }
  }
  return { handled, residual };
}

function resolveSelfHandlers(
  handlers: readonly EffectHandlerBinding[],
  unitId: string,
): { readonly handled: EffectMask; readonly residual: EffectMask } {
  let handled: EffectMask = EffectBit.PURE;
  let residual: EffectMask = EffectBit.PURE;
  for (const h of handlers) {
    const callerMatches = h.callerUnitId === unitId || h.callerUnitId === '*';
    const selfCallee = h.calleeUnitId === undefined || h.calleeUnitId === unitId;
    if (callerMatches && selfCallee) {
      handled |= h.handles;
      residual |= h.residualEffects ?? EffectBit.PURE;
    }
  }
  return { handled, residual };
}

/**
 * Performs whole-module algebraic effect checking across polyglot compilation units:
 *   1. Extracts explicit declarations & implicit primitive effects per unit.
 *   2. Propagates effects across the call graph to a fixed point, applying handler
 *      discharge (`EffectHandlerBinding` + inline `with_handler(...)`) and instantiating
 *      polymorphic `<E>` effect variables via `polymorphicBindings`.
 *   3. Verifies every unit's required effects are declared and permitted by the 7-tuple
 *      `ExecutionContext`, returning structured diagnostics with actionable remediations.
 */
export function checkModuleEffects(
  units: readonly EffectModuleUnit[],
  allowedContext: ExecutionContext,
  handlers: readonly EffectHandlerBinding[] = [],
): ModuleEffectCheckResult {
  const allowedMask = executionContextToAllowedEffects(allowedContext);
  const extractedById = new Map<string, ExtractedEffects>();
  const unitById = new Map<string, EffectModuleUnit>();

  for (const unit of units) {
    unitById.set(unit.unitId, unit);
    extractedById.set(unit.unitId, extractDeclaredEffects(unit.toolchain, unit.source));
  }

  // Fixed-point call-graph propagation
  const propagatedById = new Map<string, EffectMask>();
  const dischargedById = new Map<string, EffectMask>();
  const requiredById = new Map<string, EffectMask>();

  for (const unit of units) {
    const ext = extractedById.get(unit.unitId)!;
    const selfH = resolveSelfHandlers(handlers, unit.unitId);
    const totalSelfHandled = ext.inlineHandledMask | selfH.handled;
    const ownDischarged = ext.inferredMask & totalSelfHandled;
    const ownRequired = (ext.inferredMask & ~totalSelfHandled) | selfH.residual;
    propagatedById.set(unit.unitId, EffectBit.PURE);
    dischargedById.set(unit.unitId, ownDischarged);
    requiredById.set(unit.unitId, ownRequired);
  }

  const maxIterations = units.length + 2;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    let changed = false;

    for (const unit of units) {
      const ext = extractedById.get(unit.unitId)!;
      const selfH = resolveSelfHandlers(handlers, unit.unitId);
      const totalSelfHandled = ext.inlineHandledMask | selfH.handled;

      let propagated: EffectMask = EffectBit.PURE;
      let discharged: EffectMask = ext.inferredMask & totalSelfHandled;

      for (const calleeId of unit.calls ?? []) {
        const calleeExt = extractedById.get(calleeId);
        if (!calleeExt) {
          continue;
        }
        const calleeReq = requiredById.get(calleeId) ?? EffectBit.PURE;
        let calleeOut: EffectMask = calleeExt.declaredMask | calleeReq;

        // Effect polymorphism instantiation: if callee declares `<E>`, bind caller's polymorphic effect
        if (calleeExt.polymorphicVars.length > 0) {
          const boundMask = unit.polymorphicBindings?.[calleeId] ?? EffectBit.PURE;
          calleeOut |= boundMask;
        }

        const edgeH = resolveHandlersForEdge(handlers, unit.unitId, calleeId);
        const edgeHandledMask = ext.inlineHandledMask | edgeH.handled;
        discharged |= calleeOut & edgeHandledMask;
        const surviving = (calleeOut & ~edgeHandledMask) | edgeH.residual;
        propagated |= surviving;
      }

      const nextRequired = ((ext.inferredMask | propagated) & ~totalSelfHandled) | selfH.residual;
      const prevRequired = requiredById.get(unit.unitId) ?? EffectBit.PURE;
      const prevPropagated = propagatedById.get(unit.unitId) ?? EffectBit.PURE;
      const prevDischarged = dischargedById.get(unit.unitId) ?? EffectBit.PURE;

      if (
        nextRequired !== prevRequired ||
        propagated !== prevPropagated ||
        discharged !== prevDischarged
      ) {
        requiredById.set(unit.unitId, nextRequired);
        propagatedById.set(unit.unitId, propagated);
        dischargedById.set(unit.unitId, discharged);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  // Emit unit summaries and structured diagnostics
  const unitSummaries: Record<string, UnitEffectSummary> = {};
  const diagnostics: EffectDiagnostic[] = [];

  for (const unit of units) {
    const ext = extractedById.get(unit.unitId)!;
    const propagatedMask = propagatedById.get(unit.unitId) ?? EffectBit.PURE;
    const dischargedMask = dischargedById.get(unit.unitId) ?? EffectBit.PURE;
    const requiredMask = requiredById.get(unit.unitId) ?? EffectBit.PURE;
    const effectiveMask = ext.declaredMask | requiredMask;

    unitSummaries[unit.unitId] = Object.freeze({
      unitId: unit.unitId,
      toolchain: unit.toolchain,
      declaredMask: ext.declaredMask,
      inferredMask: ext.inferredMask,
      propagatedMask,
      dischargedMask,
      effectiveMask,
      effectiveEffects: effectMaskToNames(effectiveMask),
      polymorphicVars: ext.polymorphicVars,
      isPure: effectiveMask === EffectBit.PURE,
    });

    // 1. Unknown effect annotation diagnostic
    if (ext.unknownAnnotations.length > 0) {
      diagnostics.push(
        Object.freeze({
          code: 'HOLO_EFF_UNKNOWN_ANNOTATION',
          unitId: unit.unitId,
          undeclaredEffects: Object.freeze([]),
          forbiddenByContext: Object.freeze([]),
          undeclaredMask: EffectBit.PURE,
          forbiddenMask: EffectBit.PURE,
          remediation: `Replace unknown effect annotation(s) [${ext.unknownAnnotations.join(', ')}] with canonical EffectBit names: pure, alloc, io_fs, io_net, arena_sab, unsafe_ffi, async, gpu_wgpu, process_spawn, or polymorphic <E>.`,
        }),
      );
    }

    // 2. Undeclared effects check
    const undeclaredMask = requiredMask & ~ext.declaredMask;
    if (undeclaredMask !== EffectBit.PURE) {
      const undeclaredEffects = effectMaskToNames(undeclaredMask);
      diagnostics.push(
        Object.freeze({
          code: 'HOLO_EFF_UNDECLARED',
          unitId: unit.unitId,
          undeclaredEffects,
          forbiddenByContext: Object.freeze([]),
          undeclaredMask,
          forbiddenMask: EffectBit.PURE,
          remediation: `Declare required effect(s) via \`${formatAnnotationSuggestion(unit.toolchain, undeclaredEffects)}\` or discharge them with an algebraic effect handler.`,
        }),
      );
    }

    // 3. Context capability gate check
    const forbiddenMask = effectiveMask & ~allowedMask;
    if (forbiddenMask !== EffectBit.PURE) {
      const forbiddenByContext = effectMaskToNames(forbiddenMask);
      diagnostics.push(
        Object.freeze({
          code: 'HOLO_EFF_FORBIDDEN_BY_CONTEXT',
          unitId: unit.unitId,
          undeclaredEffects: Object.freeze([]),
          forbiddenByContext,
          undeclaredMask: EffectBit.PURE,
          forbiddenMask,
          remediation: `Effect(s) [${forbiddenByContext.join(', ')}] exceed ExecutionContext authority: ${formatContextRemediation(allowedContext, forbiddenMask)}.`,
        }),
      );
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    allowedMask,
    allowedEffects: effectMaskToNames(allowedMask),
    unitSummaries: Object.freeze(unitSummaries),
    diagnostics: Object.freeze(diagnostics),
  });
}
