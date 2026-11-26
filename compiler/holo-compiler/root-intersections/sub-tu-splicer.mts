/**
 * @file intersections/holo-compiler/sub-tu-splicer.mts
 * @description Polyglot Sub-TU Code-Block Incremental Splicer for `holo-compiler`.
 *
 * Brings Blaze-style function/item-level incremental compilation & hot-splicing
 * to all 5 `holo-compiler` toolchains (`cxx`, `rust`, `zig`, `wasi`, `ts`):
 *   1. `splitModuleItems`  — zero-AST single-pass item splitter with exact UTF-8
 *      byte spans, 1-based line spans, `itemHash` (full content SHA-256), and
 *      `sigHash` (ABI/signature-only SHA-256 so body-only edits don't invalidate callers).
 *   2. `SubTuCasIndex`     — in-memory + optional crash-safe `.b8p`-backed CAS
 *      keyed by `(toolchain, targetTriple, itemName, itemHash)`.
 *   3. `computeSplicePlan` — classifies `unchanged`, `bodyOnlyDirty`,
 *      `signatureDirty`, `added`, and `removed` items with dependent-invalidation analysis.
 *   4. `spliceModule`      — compiles ONLY dirty/added/uncached items, reuses
 *      cached `.b8p` chunks for unchanged items, and splices a bit-exact deterministic
 *      module artifact with timing & hit-rate telemetry.
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ============================================================================
// 1. Core Types & Constants
// ============================================================================

export type SubTuToolchain = 'cxx' | 'rust' | 'zig' | 'wasi' | 'ts';

export type SubTuItemKind = 'preamble' | 'function' | 'struct' | 'class' | 'other';

export type SubTuDirtyReason =
  | 'unchanged-cold'
  | 'body-only-dirty'
  | 'signature-dirty'
  | 'added';

export const DEFAULT_SUB_TU_TARGETS: Readonly<Record<SubTuToolchain, string>> = Object.freeze({
  cxx: 'x86_64-windows-gnu',
  rust: 'x86_64-pc-windows-msvc',
  zig: 'x86_64-windows-gnu',
  wasi: 'wasm32-wasi',
  ts: 'es2024-node22',
});

export const B8G_SPLICE_MAGIC = 'B8GSPL01';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export interface SubTuItem {
  readonly toolchain: SubTuToolchain;
  readonly kind: SubTuItemKind;
  readonly name: string;
  readonly source: string;
  readonly signature: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly itemHash: string;
  readonly sigHash: string;
}

export interface SubTuCasKey {
  readonly toolchain: SubTuToolchain;
  readonly targetTriple: string;
  readonly itemName: string;
  readonly itemHash: string;
}

export interface SubTuChunkMetadata {
  readonly casKey: string;
  readonly toolchain: SubTuToolchain;
  readonly targetTriple: string;
  readonly itemName: string;
  readonly itemHash: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly createdAt: string;
  readonly kind?: SubTuItemKind;
  readonly sigHash?: string;
}

export interface SubTuCachedChunk {
  readonly casKey: string;
  readonly bytes: Uint8Array;
  readonly metadata: SubTuChunkMetadata;
}

export interface SubTuCasIndexOptions {
  readonly casDir?: string;
  readonly defaultTargetTriple?: string;
}

export interface SubTuCasStats {
  readonly hits: number;
  readonly misses: number;
  readonly puts: number;
  readonly memoryEntries: number;
  readonly diskEnabled: boolean;
  readonly casDir: string | null;
}

export interface SplicePlanOptions {
  readonly targetTriple?: string;
}

export interface SplicePlan {
  readonly toolchain: SubTuToolchain;
  readonly targetTriple: string;
  readonly casIndex: SubTuCasIndex;
  readonly orderedItems: readonly SubTuItem[];
  readonly unchanged: readonly SubTuItem[];
  readonly bodyOnlyDirty: readonly SubTuItem[];
  readonly signatureDirty: readonly SubTuItem[];
  readonly added: readonly SubTuItem[];
  readonly removed: readonly SubTuItem[];
  readonly invalidatesDependents: boolean;
  readonly canHotSplice: boolean;
}

export interface SubTuCompileContext {
  readonly toolchain: SubTuToolchain;
  readonly targetTriple: string;
  readonly reason: SubTuDirtyReason;
  readonly casKey: string;
}

export type CompileItemFn = (
  item: SubTuItem,
  context: SubTuCompileContext,
) => Uint8Array | Promise<Uint8Array>;

export interface SplicedChunkEntry {
  readonly name: string;
  readonly kind: SubTuItemKind;
  readonly itemHash: string;
  readonly sigHash: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly fromCache: boolean;
}

export interface SpliceResult {
  readonly toolchain: SubTuToolchain;
  readonly targetTriple: string;
  readonly artifactBytes: Uint8Array;
  readonly artifactSha256: string;
  readonly chunks: readonly SplicedChunkEntry[];
  readonly compiledItems: readonly string[];
  readonly reusedItems: readonly string[];
  readonly removedItems: readonly string[];
  readonly totalItems: number;
  readonly compiledCount: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheHitRate: number;
  readonly hotSpliced: boolean;
  readonly invalidatesDependents: boolean;
  readonly compileMs: number;
  readonly spliceMs: number;
  readonly totalMs: number;
}

export interface DecodedSplicedModule {
  readonly version: 1;
  readonly toolchain: SubTuToolchain;
  readonly targetTriple: string;
  readonly chunks: ReadonlyArray<{
    readonly name: string;
    readonly kind: SubTuItemKind;
    readonly itemHash: string;
    readonly sigHash: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly payload: Uint8Array;
  }>;
}

// ============================================================================
// 2. Hashing & UTF-8 Offset Utilities
// ============================================================================

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function computeSubTuCasKey(key: SubTuCasKey): string {
  return sha256Hex(
    JSON.stringify({
      v: 1,
      toolchain: key.toolchain,
      targetTriple: key.targetTriple,
      itemName: key.itemName,
      itemHash: key.itemHash,
    }),
  );
}

function utf8ByteLengthAt(source: string, index: number): { bytes: number; step: number } {
  const code = source.charCodeAt(index);
  if (code < 0x80) return { bytes: 1, step: 1 };
  if (code < 0x800) return { bytes: 2, step: 1 };
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
    const next = source.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      return { bytes: 4, step: 2 };
    }
  }
  return { bytes: 3, step: 1 };
}

function buildOffsetTables(source: string): {
  readonly byteAt: Uint32Array;
  readonly lineAt: Uint32Array;
} {
  const len = source.length;
  const byteAt = new Uint32Array(len + 1);
  const lineAt = new Uint32Array(len + 1);
  let bytePos = 0;
  let line = 1;

  for (let i = 0; i < len; ) {
    byteAt[i] = bytePos;
    lineAt[i] = line;
    const ch = source.charCodeAt(i);
    if (ch === 10 /* \n */) {
      line += 1;
      bytePos += 1;
      i += 1;
      continue;
    }
    const { bytes, step } = utf8ByteLengthAt(source, i);
    if (step === 2) {
      byteAt[i + 1] = bytePos;
      lineAt[i + 1] = line;
    }
    bytePos += bytes;
    i += step;
  }

  byteAt[len] = bytePos;
  lineAt[len] = line;
  return { byteAt, lineAt };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripCommentsForSignature(text: string, isWat: boolean): string {
  if (isWat) {
    return text
      .replace(/\(;[\s\S]*?;\)/g, ' ')
      .replace(/;;[^\r\n]*/g, ' ');
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ');
}

// ============================================================================
// 3. Zero-AST Single-Pass Item / Function Splitter
// ============================================================================

interface RawSegment {
  readonly start: number;
  readonly end: number;
  readonly kind: SubTuItemKind;
  readonly name: string;
  readonly signature: string;
}

function isWhitespaceChar(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/**
 * Advances past comments and string/char literals starting at `pos` for
 * C-family / Rust / Zig / TypeScript syntax. Returns the new index if a
 * literal or comment was consumed, or `-1` if `source[pos]` is normal code.
 */
function skipCommentOrLiteral(
  source: string,
  pos: number,
  toolchain: SubTuToolchain,
): number {
  const len = source.length;
  const ch = source.charCodeAt(pos);
  const next = pos + 1 < len ? source.charCodeAt(pos + 1) : 0;

  // Line comment: //
  if (ch === 47 /* / */ && next === 47 /* / */) {
    let i = pos + 2;
    while (i < len && source.charCodeAt(i) !== 10 /* \n */) {
      i += 1;
    }
    return i;
  }

  // Block comment: /* ... */ (supports nesting in Rust)
  if (ch === 47 /* / */ && next === 42 /* * */) {
    let i = pos + 2;
    let depth = 1;
    while (i < len && depth > 0) {
      if (
        toolchain === 'rust' &&
        source.charCodeAt(i) === 47 &&
        i + 1 < len &&
        source.charCodeAt(i + 1) === 42
      ) {
        depth += 1;
        i += 2;
        continue;
      }
      if (
        source.charCodeAt(i) === 42 &&
        i + 1 < len &&
        source.charCodeAt(i + 1) === 47
      ) {
        depth -= 1;
        i += 2;
        continue;
      }
      i += 1;
    }
    return i;
  }

  // Zig multiline string literal: \\...
  if (toolchain === 'zig' && ch === 92 /* \ */ && next === 92 /* \ */) {
    let i = pos + 2;
    while (i < len && source.charCodeAt(i) !== 10 /* \n */) {
      i += 1;
    }
    return i;
  }

  // Rust raw string: r"..." or r#"..."#
  if (toolchain === 'rust' && ch === 114 /* r */ && (next === 34 || next === 35)) {
    let hashes = 0;
    let i = pos + 1;
    while (i < len && source.charCodeAt(i) === 35 /* # */) {
      hashes += 1;
      i += 1;
    }
    if (i < len && source.charCodeAt(i) === 34 /* " */) {
      i += 1;
      while (i < len) {
        if (source.charCodeAt(i) === 34 /* " */) {
          let matched = 0;
          while (
            matched < hashes &&
            i + 1 + matched < len &&
            source.charCodeAt(i + 1 + matched) === 35
          ) {
            matched += 1;
          }
          if (matched === hashes) {
            return i + 1 + hashes;
          }
        }
        i += 1;
      }
      return len;
    }
  }

  // Double-quoted string
  if (ch === 34 /* " */) {
    let i = pos + 1;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92 /* \ */) {
        i += 2;
        continue;
      }
      if (c === 34 /* " */) {
        return i + 1;
      }
      i += 1;
    }
    return len;
  }

  // Template literal in TypeScript
  if (toolchain === 'ts' && ch === 96 /* ` */) {
    let i = pos + 1;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92 /* \ */) {
        i += 2;
        continue;
      }
      if (c === 96 /* ` */) {
        return i + 1;
      }
      i += 1;
    }
    return len;
  }

  // Single-quoted string or char literal (guarding Rust lifetimes like 'a / 'static)
  if (ch === 39 /* ' */) {
    if (toolchain === 'rust') {
      if (pos + 1 < len && source.charCodeAt(pos + 1) === 92 /* \ */) {
        let i = pos + 2;
        while (i < len && source.charCodeAt(i) !== 39) {
          if (source.charCodeAt(i) === 92) {
            i += 2;
            continue;
          }
          i += 1;
        }
        return i < len ? i + 1 : len;
      }
      if (pos + 2 < len && source.charCodeAt(pos + 2) === 39 /* ' */) {
        return pos + 3;
      }
      // Rust lifetime token, not a char literal
      return -1;
    }

    let i = pos + 1;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92 /* \ */) {
        i += 2;
        continue;
      }
      if (c === 39 /* ' */) {
        return i + 1;
      }
      i += 1;
    }
    return len;
  }

  return -1;
}

/**
 * Finds the index of the first `{` at paren/bracket depth 0 inside `chunk`,
 * skipping comments and string literals. Returns `-1` if none.
 */
function findBodyOpenBrace(chunk: string, toolchain: SubTuToolchain): number {
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < chunk.length; ) {
    const skipped = skipCommentOrLiteral(chunk, i, toolchain);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const ch = chunk.charCodeAt(i);
    if (ch === 40 /* ( */) parenDepth += 1;
    else if (ch === 41 /* ) */ && parenDepth > 0) parenDepth -= 1;
    else if (ch === 91 /* [ */) bracketDepth += 1;
    else if (ch === 93 /* ] */ && bracketDepth > 0) bracketDepth -= 1;
    else if (ch === 123 /* { */ && parenDepth === 0 && bracketDepth === 0) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function classifyBraceSegment(
  toolchain: SubTuToolchain,
  chunk: string,
  indexHint: number,
): { readonly kind: SubTuItemKind; readonly name: string; readonly signature: string } {
  const cleanedFull = normalizeWhitespace(stripCommentsForSignature(chunk, false));
  const bodyBrace = findBodyOpenBrace(chunk, toolchain);
  const headerRaw = bodyBrace >= 0 ? chunk.slice(0, bodyBrace) : chunk;
  const header = normalizeWhitespace(stripCommentsForSignature(headerRaw, false));

  // Preamble / imports check first
  if (
    (toolchain === 'cxx' || toolchain === 'wasi') &&
    (/^(?:#\s*(?:include|define|pragma|undef|ifdef|ifndef|if|endif|else|elif)\b|using\s+)/.test(header))
  ) {
    return { kind: 'preamble', name: '__preamble__', signature: cleanedFull };
  }
  if (
    toolchain === 'rust' &&
    (/^(?:#!\[|use\s+|extern\s+crate\s+|mod\s+[A-Za-z_][A-Za-z0-9_]*\s*;)/.test(cleanedFull))
  ) {
    return { kind: 'preamble', name: '__preamble__', signature: cleanedFull };
  }
  if (
    toolchain === 'zig' &&
    (/^(?:pub\s+)?const\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*@(?:import|cImport)\s*\(/.test(cleanedFull))
  ) {
    return { kind: 'preamble', name: '__preamble__', signature: cleanedFull };
  }
  if (
    toolchain === 'ts' &&
    (/^import\s+/.test(cleanedFull) || /^export\s+\*\s+from\s+/.test(cleanedFull))
  ) {
    return { kind: 'preamble', name: '__preamble__', signature: cleanedFull };
  }

  // Toolchain-specific item classification
  if (toolchain === 'rust') {
    const withoutAttrs = header.replace(/(?:#\[[^\]]*\]\s*)+/g, '').trim();
    const fnMatch = /^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      withoutAttrs,
    );
    if (fnMatch && fnMatch[1]) {
      return { kind: 'function', name: fnMatch[1], signature: header };
    }
    const structMatch = /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      withoutAttrs,
    );
    if (structMatch && structMatch[1]) {
      return { kind: 'struct', name: structMatch[1], signature: cleanedFull };
    }
    const implMatch = /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_:<>,\s]*?)(?:\s+for\s+([A-Za-z_][A-Za-z0-9_:<>,\s]*?))?$/.exec(
      withoutAttrs,
    );
    if (implMatch) {
      const target = (implMatch[2] ?? implMatch[1] ?? `impl_${indexHint}`).trim().replace(/\s+/g, '');
      return { kind: 'struct', name: `impl:${target}`, signature: cleanedFull };
    }
  }

  if (toolchain === 'zig') {
    const fnMatch = /^(?:pub\s+)?(?:export\s+|extern(?:\s+"[^"]*")?\s+|inline\s+|noinline\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      header,
    );
    if (fnMatch && fnMatch[1]) {
      return { kind: 'function', name: fnMatch[1], signature: header };
    }
    const testMatch = /^test\s+"([^"]+)"/.exec(header);
    if (testMatch && testMatch[1]) {
      return { kind: 'function', name: `test:${testMatch[1]}`, signature: header };
    }
    const typeMatch = /^(?:pub\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:packed\s+|extern\s+)?(?:struct|enum|union)\b/.exec(
      header,
    );
    if (typeMatch && typeMatch[1]) {
      return { kind: 'struct', name: typeMatch[1], signature: cleanedFull };
    }
    const constMatch = /^(?:pub\s+)?(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(header);
    if (constMatch && constMatch[1]) {
      return { kind: 'other', name: constMatch[1], signature: cleanedFull };
    }
  }

  if (toolchain === 'ts') {
    const fnMatch = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
      header,
    );
    if (fnMatch && fnMatch[1]) {
      return { kind: 'function', name: fnMatch[1], signature: header };
    }
    const arrowMatch = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=>/.exec(
      header,
    );
    if (arrowMatch && arrowMatch[1]) {
      return { kind: 'function', name: arrowMatch[1], signature: header };
    }
    const classMatch = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
      header,
    );
    if (classMatch && classMatch[1]) {
      return { kind: 'class', name: classMatch[1], signature: cleanedFull };
    }
    const ifaceMatch = /^(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
      header,
    );
    if (ifaceMatch && ifaceMatch[1]) {
      return { kind: 'struct', name: ifaceMatch[1], signature: cleanedFull };
    }
    const varMatch = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
      cleanedFull,
    );
    if (varMatch && varMatch[1]) {
      return { kind: 'other', name: varMatch[1], signature: cleanedFull };
    }
  }

  if (toolchain === 'cxx' || toolchain === 'wasi') {
    const withoutAttrs = header
      .replace(/^template\s*<[^>]*>\s*/, '')
      .replace(/(?:__attribute__\s*\(\((?:[^()]*|\([^()]*\))*\)\)|__declspec\s*\([^)]*\)|\[\[[^\]]*\]\])\s*/g, '')
      .trim();
    const classMatch = /^(?:class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      withoutAttrs,
    );
    if (classMatch && classMatch[1] && bodyBrace >= 0) {
      return { kind: 'class', name: classMatch[1], signature: cleanedFull };
    }
    const structMatch = /^(?:typedef\s+)?(?:struct|union|enum(?:\s+class)?)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      withoutAttrs,
    );
    if (structMatch && structMatch[1] && bodyBrace >= 0) {
      return { kind: 'struct', name: structMatch[1], signature: cleanedFull };
    }
    if (bodyBrace >= 0 && withoutAttrs.includes('(')) {
      const beforeParen = withoutAttrs.slice(0, withoutAttrs.indexOf('(')).trim();
      const nameMatch = /([A-Za-z_~][A-Za-z0-9_:~]*)\s*$/.exec(beforeParen);
      if (nameMatch && nameMatch[1]) {
        return { kind: 'function', name: nameMatch[1], signature: header };
      }
    }
    const typedefMatch = /^typedef\s+[\s\S]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(cleanedFull);
    if (typedefMatch && typedefMatch[1]) {
      return { kind: 'struct', name: typedefMatch[1], signature: cleanedFull };
    }
  }

  return { kind: 'other', name: `item_${indexHint}`, signature: cleanedFull };
}

/**
 * Single-pass zero-AST splitter for C/C++, Rust, Zig, TypeScript, and C-WASI.
 */
function splitBraceLanguage(toolchain: SubTuToolchain, source: string): RawSegment[] {
  const len = source.length;
  const rawSegments: RawSegment[] = [];
  let i = 0;

  while (i < len) {
    // Skip leading whitespace and standalone comments between top-level items
    while (i < len) {
      if (isWhitespaceChar(source.charCodeAt(i))) {
        i += 1;
        continue;
      }
      const ch = source.charCodeAt(i);
      const next = i + 1 < len ? source.charCodeAt(i + 1) : 0;
      if (ch === 47 && (next === 47 || next === 42)) {
        const afterComment = skipCommentOrLiteral(source, i, toolchain);
        if (afterComment > i) {
          i = afterComment;
          continue;
        }
      }
      break;
    }

    if (i >= len) break;

    const segStart = i;

    // C/C++ preprocessor directive (#include, #define, #pragma, etc.)
    if ((toolchain === 'cxx' || toolchain === 'wasi') && source.charCodeAt(i) === 35 /* # */) {
      while (i < len) {
        if (source.charCodeAt(i) === 10 /* \n */) {
          // Check backslash line continuation
          const prevIdx = i > 0 && source.charCodeAt(i - 1) === 13 ? i - 2 : i - 1;
          if (prevIdx >= segStart && source.charCodeAt(prevIdx) === 92 /* \ */) {
            i += 1;
            continue;
          }
          break;
        }
        i += 1;
      }
      const chunk = source.slice(segStart, i);
      const cls = classifyBraceSegment(toolchain, chunk, rawSegments.length);
      rawSegments.push({
        start: segStart,
        end: i,
        kind: cls.kind,
        name: cls.name,
        signature: cls.signature,
      });
      continue;
    }

    // General top-level declaration scanner
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let sawBraceBlock = false;
    const isTsImportStart =
      toolchain === 'ts' && source.startsWith('import', segStart) &&
      (segStart + 6 >= len || !/[A-Za-z0-9_$]/.test(source.charAt(segStart + 6)));

    while (i < len) {
      const skipped = skipCommentOrLiteral(source, i, toolchain);
      if (skipped !== -1) {
        i = skipped;
        // Handle ASI-terminated TypeScript `import ... from '...'` without semicolon
        if (isTsImportStart && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
          const sliceSoFar = source.slice(segStart, i);
          if (/\bfrom\s*['"][^'"]+['"]$/.test(sliceSoFar) || /^import\s*['"][^'"]+['"]$/.test(sliceSoFar)) {
            let j = i;
            while (j < len && (source.charCodeAt(j) === 32 || source.charCodeAt(j) === 9)) {
              j += 1;
            }
            if (j < len && source.charCodeAt(j) === 59 /* ; */) {
              i = j + 1;
            }
            break;
          }
        }
        continue;
      }

      const ch = source.charCodeAt(i);
      if (ch === 40 /* ( */) {
        parenDepth += 1;
        i += 1;
        continue;
      }
      if (ch === 41 /* ) */) {
        if (parenDepth > 0) parenDepth -= 1;
        i += 1;
        continue;
      }
      if (ch === 91 /* [ */) {
        bracketDepth += 1;
        i += 1;
        continue;
      }
      if (ch === 93 /* ] */) {
        if (bracketDepth > 0) bracketDepth -= 1;
        i += 1;
        continue;
      }
      if (ch === 123 /* { */) {
        braceDepth += 1;
        sawBraceBlock = true;
        i += 1;
        continue;
      }
      if (ch === 125 /* } */) {
        if (braceDepth > 0) braceDepth -= 1;
        i += 1;
        if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && sawBraceBlock) {
          // For TS `import { a, b } from 'mod'`, `{ ... }` is not the end of the import.
          if (isTsImportStart) {
            sawBraceBlock = false;
            continue;
          }
          // Consume optional trailing `;` (e.g., C++ `struct Foo { ... };`, Zig `const S = struct { ... };`, TS arrow `const f = () => { ... };`)
          let j = i;
          while (j < len && (source.charCodeAt(j) === 32 || source.charCodeAt(j) === 9)) {
            j += 1;
          }
          if (j < len && source.charCodeAt(j) === 59 /* ; */) {
            i = j + 1;
          }
          break;
        }
        continue;
      }
      if (ch === 59 /* ; */ && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        i += 1;
        break;
      }

      i += 1;
    }

    const segEnd = i;
    const chunk = source.slice(segStart, segEnd);
    const cls = classifyBraceSegment(toolchain, chunk, rawSegments.length);
    rawSegments.push({
      start: segStart,
      end: segEnd,
      kind: cls.kind,
      name: cls.name,
      signature: cls.signature,
    });
  }

  return rawSegments;
}

// ============================================================================
// 4. WAT (WebAssembly Text Format) Single-Pass Splitter for `wasi`
// ============================================================================

function skipWatCommentOrString(source: string, pos: number): number {
  const len = source.length;
  const ch = source.charCodeAt(pos);
  const next = pos + 1 < len ? source.charCodeAt(pos + 1) : 0;

  if (ch === 59 /* ; */ && next === 59 /* ; */) {
    let i = pos + 2;
    while (i < len && source.charCodeAt(i) !== 10) i += 1;
    return i;
  }

  if (ch === 40 /* ( */ && next === 59 /* ; */) {
    let i = pos + 2;
    let depth = 1;
    while (i < len && depth > 0) {
      if (source.charCodeAt(i) === 40 && i + 1 < len && source.charCodeAt(i + 1) === 59) {
        depth += 1;
        i += 2;
        continue;
      }
      if (source.charCodeAt(i) === 59 && i + 1 < len && source.charCodeAt(i + 1) === 41) {
        depth -= 1;
        i += 2;
        continue;
      }
      i += 1;
    }
    return i;
  }

  if (ch === 34 /* " */) {
    let i = pos + 1;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92 /* \ */) {
        i += 2;
        continue;
      }
      if (c === 34 /* " */) return i + 1;
      i += 1;
    }
    return len;
  }

  return -1;
}

function isWatSource(source: string): boolean {
  let i = 0;
  while (i < source.length) {
    if (isWhitespaceChar(source.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const skipped = skipWatCommentOrString(source, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    return source.charCodeAt(i) === 40 /* ( */;
  }
  return false;
}

function extractWatFuncSignature(funcExpr: string): { readonly name: string; readonly signature: string } {
  // Scan direct child S-expressions and leading tokens of `(func ...)`
  // Signature includes: `func`, optional `$name`, and any `(export ...)`, `(type ...)`, `(param ...)`, `(result ...)` clauses.
  const len = funcExpr.length;
  let i = 1; // skip '('
  while (i < len && isWhitespaceChar(funcExpr.charCodeAt(i))) i += 1;
  // skip 'func'
  while (i < len && !isWhitespaceChar(funcExpr.charCodeAt(i)) && funcExpr.charCodeAt(i) !== 40 && funcExpr.charCodeAt(i) !== 41) {
    i += 1;
  }

  let name = '';
  const sigParts: string[] = ['func'];

  while (i < len) {
    while (i < len && isWhitespaceChar(funcExpr.charCodeAt(i))) i += 1;
    if (i >= len || funcExpr.charCodeAt(i) === 41 /* ) */) break;

    const skipped = skipWatCommentOrString(funcExpr, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    if (funcExpr.charCodeAt(i) === 36 /* $ */ && name.length === 0) {
      const start = i;
      while (i < len && !isWhitespaceChar(funcExpr.charCodeAt(i)) && funcExpr.charCodeAt(i) !== 40 && funcExpr.charCodeAt(i) !== 41) {
        i += 1;
      }
      name = funcExpr.slice(start, i);
      sigParts.push(name);
      continue;
    }

    if (funcExpr.charCodeAt(i) === 40 /* ( */) {
      const childStart = i;
      let depth = 0;
      while (i < len) {
        const s = skipWatCommentOrString(funcExpr, i);
        if (s !== -1) {
          i = s;
          continue;
        }
        const c = funcExpr.charCodeAt(i);
        if (c === 40) depth += 1;
        else if (c === 41) {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
      const child = funcExpr.slice(childStart, i);
      const childNorm = normalizeWhitespace(stripCommentsForSignature(child, true));
      if (/^\(\s*(?:export|type|param|result)\b/.test(childNorm)) {
        sigParts.push(childNorm);
        if (name.length === 0) {
          const expMatch = /^\(\s*export\s+"([^"]+)"\s*\)$/.exec(childNorm);
          if (expMatch && expMatch[1]) {
            name = expMatch[1];
          }
        }
        continue;
      }
      // First non-signature S-expression starts the body (e.g. `(local ...)` or `(i32.add ...)`)
      break;
    }

    // Flat instruction starts the body
    break;
  }

  return {
    name: name.replace(/^\$/, ''),
    signature: sigParts.join(' '),
  };
}

function splitWatModule(source: string): RawSegment[] {
  const len = source.length;
  let i = 0;

  // Skip leading whitespace / comments to find top-level S-expression
  while (i < len) {
    if (isWhitespaceChar(source.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const s = skipWatCommentOrString(source, i);
    if (s !== -1) {
      i = s;
      continue;
    }
    break;
  }

  // Unwrap outer `(module ...)` if present
  let scanEnd = len;
  if (i < len && source.charCodeAt(i) === 40 /* ( */) {
    const rest = source.slice(i + 1).trimStart();
    if (/^module(?:\s|\(|$)/.test(rest)) {
      const moduleIdx = source.indexOf('module', i + 1);
      i = moduleIdx + 'module'.length;
      // Optionally skip module name `$mod`
      while (i < len && isWhitespaceChar(source.charCodeAt(i))) i += 1;
      if (i < len && source.charCodeAt(i) === 36 /* $ */) {
        while (i < len && !isWhitespaceChar(source.charCodeAt(i)) && source.charCodeAt(i) !== 40 && source.charCodeAt(i) !== 41) {
          i += 1;
        }
      }
      // Find closing ')' of `(module ...)`
      let lastParen = len - 1;
      while (lastParen > i && source.charCodeAt(lastParen) !== 41) {
        lastParen -= 1;
      }
      if (lastParen > i) {
        scanEnd = lastParen;
      }
    }
  }

  const segments: RawSegment[] = [];
  while (i < scanEnd) {
    while (i < scanEnd) {
      if (isWhitespaceChar(source.charCodeAt(i))) {
        i += 1;
        continue;
      }
      const s = skipWatCommentOrString(source, i);
      if (s !== -1) {
        i = s;
        continue;
      }
      break;
    }
    if (i >= scanEnd) break;
    if (source.charCodeAt(i) !== 40 /* ( */) {
      i += 1;
      continue;
    }

    const segStart = i;
    let depth = 0;
    while (i < scanEnd) {
      const s = skipWatCommentOrString(source, i);
      if (s !== -1) {
        i = s;
        continue;
      }
      const c = source.charCodeAt(i);
      if (c === 40) depth += 1;
      else if (c === 41) {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }

    const segEnd = i;
    const chunk = source.slice(segStart, segEnd);
    const cleaned = normalizeWhitespace(stripCommentsForSignature(chunk, true));
    const headMatch = /^\(\s*([a-z]+)/.exec(cleaned);
    const head = headMatch?.[1] ?? 'other';

    if (head === 'func') {
      const { name, signature } = extractWatFuncSignature(chunk);
      segments.push({
        start: segStart,
        end: segEnd,
        kind: 'function',
        name: name || `func_${segments.length}`,
        signature,
      });
    } else if (head === 'type') {
      const typeNameMatch = /^\(\s*type\s+\$([A-Za-z0-9_.-]+)/.exec(cleaned);
      segments.push({
        start: segStart,
        end: segEnd,
        kind: 'struct',
        name: typeNameMatch?.[1] ?? `type_${segments.length}`,
        signature: cleaned,
      });
    } else if (
      head === 'import' ||
      head === 'memory' ||
      head === 'table' ||
      head === 'global' ||
      head === 'export' ||
      head === 'data' ||
      head === 'elem'
    ) {
      segments.push({
        start: segStart,
        end: segEnd,
        kind: 'preamble',
        name: '__preamble__',
        signature: cleaned,
      });
    } else {
      segments.push({
        start: segStart,
        end: segEnd,
        kind: 'other',
        name: `${head}_${segments.length}`,
        signature: cleaned,
      });
    }
  }

  return segments;
}

/**
 * Zero-AST single-pass module splitter for all 5 `holo-compiler` toolchains
 * (`cxx`, `rust`, `zig`, `wasi`, `ts`).
 *
 * Extracts top-level preambles/imports, structs/classes, and functions with:
 * - exact UTF-8 byte spans (`startByte`, `endByte`)
 * - 1-based inclusive line spans (`startLine`, `endLine`)
 * - full content SHA-256 (`itemHash`)
 * - signature-only SHA-256 (`sigHash`, invariant across function body-only edits)
 */
export function splitModuleItems(
  toolchain: SubTuToolchain,
  source: string,
): readonly SubTuItem[] {
  const { byteAt, lineAt } = buildOffsetTables(source);

  const rawSegments =
    toolchain === 'wasi' && isWatSource(source)
      ? splitWatModule(source)
      : splitBraceLanguage(toolchain, source);

  // Coalesce contiguous preamble segments into a single preamble block
  const coalesced: RawSegment[] = [];
  for (const seg of rawSegments) {
    const prev = coalesced.length > 0 ? coalesced[coalesced.length - 1] : undefined;
    if (seg.kind === 'preamble' && prev && prev.kind === 'preamble') {
      const mergedSource = source.slice(prev.start, seg.end);
      coalesced[coalesced.length - 1] = {
        start: prev.start,
        end: seg.end,
        kind: 'preamble',
        name: '__preamble__',
        signature: normalizeWhitespace(
          stripCommentsForSignature(mergedSource, toolchain === 'wasi' && isWatSource(source)),
        ),
      };
    } else {
      coalesced.push(seg);
    }
  }

  // Disambiguate duplicate names (e.g., C++ overloads or split preambles)
  const nameCounts = new Map<string, number>();
  const items: SubTuItem[] = [];

  for (const seg of coalesced) {
    const seen = nameCounts.get(seg.name) ?? 0;
    nameCounts.set(seg.name, seen + 1);
    const uniqueName = seen === 0 ? seg.name : `${seg.name}#${seen}`;

    const itemSource = source.slice(seg.start, seg.end);
    const startByte = byteAt[seg.start]!;
    const endByte = byteAt[seg.end]!;
    const startLine = lineAt[seg.start]!;
    const endLineIdx = seg.end > seg.start ? seg.end - 1 : seg.end;
    const endLine = lineAt[endLineIdx]!;

    const itemHash = sha256Hex(itemSource);
    const sigHash = sha256Hex(`${toolchain}:${seg.kind}:${uniqueName}:${seg.signature}`);

    items.push(
      Object.freeze({
        toolchain,
        kind: seg.kind,
        name: uniqueName,
        source: itemSource,
        signature: seg.signature,
        startOffset: seg.start,
        endOffset: seg.end,
        startByte,
        endByte,
        startLine,
        endLine,
        itemHash,
        sigHash,
      }),
    );
  }

  return Object.freeze(items);
}

// ============================================================================
// 5. Sub-TU Content-Addressed Storage Index (In-Memory + Optional .b8p Disk)
// ============================================================================

/**
 * Content-addressed Sub-TU chunk index keyed by
 * `(toolchain, targetTriple, itemName, itemHash)`.
 *
 * Always maintains a fast in-memory `Map` and optionally persists crash-safe
 * atomic `.b8p` chunk blobs to `casDir` on disk.
 */
export class SubTuCasIndex {
  readonly casDir: string | null;
  readonly defaultTargetTriple: string | undefined;
  private readonly memory: Map<string, SubTuCachedChunk>;
  private hitsCount: number;
  private missesCount: number;
  private putsCount: number;

  constructor(options?: SubTuCasIndexOptions) {
    this.casDir = options?.casDir ? resolve(options.casDir) : null;
    this.defaultTargetTriple = options?.defaultTargetTriple;
    this.memory = new Map<string, SubTuCachedChunk>();
    this.hitsCount = 0;
    this.missesCount = 0;
    this.putsCount = 0;

    if (this.casDir !== null) {
      mkdirSync(join(this.casDir, 'blobs'), { recursive: true });
      mkdirSync(join(this.casDir, 'meta'), { recursive: true });
    }
  }

  private blobPath(casKey: string): string {
    return join(this.casDir!, 'blobs', casKey.slice(0, 2), `${casKey}.b8p`);
  }

  private metaPath(casKey: string): string {
    return join(this.casDir!, 'meta', casKey.slice(0, 2), `${casKey}.json`);
  }

  private atomicWrite(targetPath: string, data: Uint8Array | string): void {
    const dir = dirname(targetPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpPath, data);
      renameSync(tmpPath, targetPath);
    } catch (err) {
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup error
        }
      }
      throw err;
    }
  }

  keyOf(key: SubTuCasKey): string {
    return computeSubTuCasKey(key);
  }

  has(key: SubTuCasKey): boolean {
    const casKey = computeSubTuCasKey(key);
    if (this.memory.has(casKey)) {
      return true;
    }
    if (this.casDir !== null) {
      return existsSync(this.blobPath(casKey));
    }
    return false;
  }

  get(key: SubTuCasKey): SubTuCachedChunk | null {
    const casKey = computeSubTuCasKey(key);
    const inMem = this.memory.get(casKey);
    if (inMem !== undefined) {
      this.hitsCount += 1;
      return inMem;
    }

    if (this.casDir !== null) {
      const bPath = this.blobPath(casKey);
      if (existsSync(bPath)) {
        const rawBuf = readFileSync(bPath);
        const bytes = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
        const mPath = this.metaPath(casKey);
        let metadata: SubTuChunkMetadata;
        if (existsSync(mPath)) {
          metadata = JSON.parse(readFileSync(mPath, 'utf8')) as SubTuChunkMetadata;
        } else {
          metadata = {
            casKey,
            toolchain: key.toolchain,
            targetTriple: key.targetTriple,
            itemName: key.itemName,
            itemHash: key.itemHash,
            byteLength: bytes.byteLength,
            contentSha256: sha256Hex(bytes),
            createdAt: new Date().toISOString(),
          };
        }
        const entry: SubTuCachedChunk = Object.freeze({ casKey, bytes, metadata });
        this.memory.set(casKey, entry);
        this.hitsCount += 1;
        return entry;
      }
    }

    this.missesCount += 1;
    return null;
  }

  put(
    key: SubTuCasKey,
    data: Uint8Array,
    extra?: { readonly kind?: SubTuItemKind; readonly sigHash?: string },
  ): SubTuCachedChunk {
    const casKey = computeSubTuCasKey(key);
    const bytes = new Uint8Array(data);
    const metadata: SubTuChunkMetadata = Object.freeze({
      casKey,
      toolchain: key.toolchain,
      targetTriple: key.targetTriple,
      itemName: key.itemName,
      itemHash: key.itemHash,
      byteLength: bytes.byteLength,
      contentSha256: sha256Hex(bytes),
      createdAt: new Date().toISOString(),
      kind: extra?.kind,
      sigHash: extra?.sigHash,
    });

    if (this.casDir !== null) {
      this.atomicWrite(this.blobPath(casKey), bytes);
      this.atomicWrite(this.metaPath(casKey), JSON.stringify(metadata, null, 2));
    }

    const entry: SubTuCachedChunk = Object.freeze({ casKey, bytes, metadata });
    this.memory.set(casKey, entry);
    this.putsCount += 1;
    return entry;
  }

  delete(key: SubTuCasKey): boolean {
    const casKey = computeSubTuCasKey(key);
    let deleted = this.memory.delete(casKey);
    if (this.casDir !== null) {
      for (const path of [this.blobPath(casKey), this.metaPath(casKey)]) {
        if (existsSync(path)) {
          unlinkSync(path);
          deleted = true;
        }
      }
    }
    return deleted;
  }

  clearMemory(): void {
    this.memory.clear();
  }

  stats(): SubTuCasStats {
    return Object.freeze({
      hits: this.hitsCount,
      misses: this.missesCount,
      puts: this.putsCount,
      memoryEntries: this.memory.size,
      diskEnabled: this.casDir !== null,
      casDir: this.casDir,
    });
  }
}

// ============================================================================
// 6. Incremental Splice Planning
// ============================================================================

/**
 * Computes an exact incremental splice plan between `prevItems` and `nextItems`.
 *
 * - `unchanged`: identical `itemHash` and `sigHash` (reused from `.b8p` CAS if cached).
 * - `bodyOnlyDirty`: identical `sigHash`, changed `itemHash` (can hot-splice without
 *   invalidating callers or downstream modules).
 * - `signatureDirty`: changed `sigHash` (invalidates downstream dependents).
 * - `added`: new item not present in `prevItems`.
 * - `removed`: item present in `prevItems` but absent from `nextItems`.
 */
export function computeSplicePlan(
  prevItems: readonly SubTuItem[],
  nextItems: readonly SubTuItem[],
  casIndex: SubTuCasIndex,
  options?: SplicePlanOptions,
): SplicePlan {
  const toolchain: SubTuToolchain =
    nextItems[0]?.toolchain ?? prevItems[0]?.toolchain ?? 'cxx';
  const targetTriple =
    options?.targetTriple ??
    casIndex.defaultTargetTriple ??
    DEFAULT_SUB_TU_TARGETS[toolchain];

  const prevByName = new Map<string, SubTuItem>();
  for (const item of prevItems) {
    prevByName.set(item.name, item);
  }

  const nextByName = new Map<string, SubTuItem>();
  for (const item of nextItems) {
    nextByName.set(item.name, item);
  }

  const unchanged: SubTuItem[] = [];
  const bodyOnlyDirty: SubTuItem[] = [];
  const signatureDirty: SubTuItem[] = [];
  const added: SubTuItem[] = [];
  const removed: SubTuItem[] = [];

  for (const nextItem of nextItems) {
    const prevItem = prevByName.get(nextItem.name);
    if (!prevItem) {
      added.push(nextItem);
    } else if (prevItem.itemHash === nextItem.itemHash && prevItem.sigHash === nextItem.sigHash) {
      unchanged.push(nextItem);
    } else if (prevItem.sigHash === nextItem.sigHash) {
      bodyOnlyDirty.push(nextItem);
    } else {
      signatureDirty.push(nextItem);
    }
  }

  for (const prevItem of prevItems) {
    if (!nextByName.has(prevItem.name)) {
      removed.push(prevItem);
    }
  }

  // Dependents are invalidated if any existing signature changed, any item was removed,
  // or a new preamble/type/struct was introduced.
  const addedImpactsSurface = added.some(
    (item) => item.kind === 'preamble' || item.kind === 'struct' || item.kind === 'class',
  );
  const invalidatesDependents =
    signatureDirty.length > 0 || removed.length > 0 || addedImpactsSurface;
  const canHotSplice = !invalidatesDependents;

  return Object.freeze({
    toolchain,
    targetTriple,
    casIndex,
    orderedItems: Object.freeze([...nextItems]),
    unchanged: Object.freeze(unchanged),
    bodyOnlyDirty: Object.freeze(bodyOnlyDirty),
    signatureDirty: Object.freeze(signatureDirty),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    invalidatesDependents,
    canHotSplice,
  });
}

// ============================================================================
// 7. Module Splicing & Deterministic Binary Envelope
// ============================================================================

interface SpliceManifestJson {
  readonly version: 1;
  readonly toolchain: SubTuToolchain;
  readonly targetTriple: string;
  readonly chunks: ReadonlyArray<{
    readonly name: string;
    readonly kind: SubTuItemKind;
    readonly itemHash: string;
    readonly sigHash: string;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly startLine: number;
    readonly endLine: number;
  }>;
}

function encodeSplicedArtifact(
  toolchain: SubTuToolchain,
  targetTriple: string,
  orderedPayloads: ReadonlyArray<{
    readonly item: SubTuItem;
    readonly payload: Uint8Array;
    readonly fromCache: boolean;
  }>,
): { readonly artifactBytes: Uint8Array; readonly chunks: readonly SplicedChunkEntry[] } {
  let payloadTotalBytes = 0;
  const manifestChunks: Array<{
    readonly name: string;
    readonly kind: SubTuItemKind;
    readonly itemHash: string;
    readonly sigHash: string;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly startLine: number;
    readonly endLine: number;
  }> = [];
  const chunks: SplicedChunkEntry[] = [];

  for (const entry of orderedPayloads) {
    const byteOffset = payloadTotalBytes;
    const byteLength = entry.payload.byteLength;
    payloadTotalBytes += byteLength;

    manifestChunks.push({
      name: entry.item.name,
      kind: entry.item.kind,
      itemHash: entry.item.itemHash,
      sigHash: entry.item.sigHash,
      byteOffset,
      byteLength,
      startLine: entry.item.startLine,
      endLine: entry.item.endLine,
    });

    chunks.push(
      Object.freeze({
        name: entry.item.name,
        kind: entry.item.kind,
        itemHash: entry.item.itemHash,
        sigHash: entry.item.sigHash,
        byteOffset,
        byteLength,
        startLine: entry.item.startLine,
        endLine: entry.item.endLine,
        fromCache: entry.fromCache,
      }),
    );
  }

  const manifest: SpliceManifestJson = {
    version: 1,
    toolchain,
    targetTriple,
    chunks: manifestChunks,
  };
  const manifestBytes = TEXT_ENCODER.encode(JSON.stringify(manifest));
  const magicBytes = TEXT_ENCODER.encode(B8G_SPLICE_MAGIC);

  // Envelope: [8B magic][4B manifestByteLength u32 LE][manifest JSON][concatenated payloads]
  const totalBytes = magicBytes.byteLength + 4 + manifestBytes.byteLength + payloadTotalBytes;
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out.set(magicBytes, 0);
  view.setUint32(8, manifestBytes.byteLength, true);
  out.set(manifestBytes, 12);

  let cursor = 12 + manifestBytes.byteLength;
  for (const entry of orderedPayloads) {
    out.set(entry.payload, cursor);
    cursor += entry.payload.byteLength;
  }

  return {
    artifactBytes: out,
    chunks: Object.freeze(chunks),
  };
}

/**
 * Decodes a spliced module binary envelope back into its manifest and per-item
 * payload slices for round-trip verification and downstream linking.
 */
export function decodeSplicedModule(bytes: Uint8Array): DecodedSplicedModule {
  if (bytes.byteLength < 12) {
    throw new Error(`Invalid spliced module: expected at least 12 bytes, got ${bytes.byteLength}`);
  }
  const magic = TEXT_DECODER.decode(bytes.subarray(0, 8));
  if (magic !== B8G_SPLICE_MAGIC) {
    throw new Error(`Invalid spliced module magic: expected ${B8G_SPLICE_MAGIC}, got ${magic}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestLen = view.getUint32(8, true);
  const payloadBase = 12 + manifestLen;
  if (payloadBase > bytes.byteLength) {
    throw new Error(
      `Corrupt spliced module: manifest length ${manifestLen} exceeds buffer size ${bytes.byteLength}`,
    );
  }

  const manifest = JSON.parse(
    TEXT_DECODER.decode(bytes.subarray(12, payloadBase)),
  ) as SpliceManifestJson;

  const decodedChunks = manifest.chunks.map((c) => {
    const start = payloadBase + c.byteOffset;
    const end = start + c.byteLength;
    return Object.freeze({
      name: c.name,
      kind: c.kind,
      itemHash: c.itemHash,
      sigHash: c.sigHash,
      startLine: c.startLine,
      endLine: c.endLine,
      payload: bytes.slice(start, end),
    });
  });

  return Object.freeze({
    version: manifest.version,
    toolchain: manifest.toolchain,
    targetTriple: manifest.targetTriple,
    chunks: Object.freeze(decodedChunks),
  });
}

/**
 * Executes a `SplicePlan`:
 * - Reuses cached `.b8p` chunks from `plan.casIndex` for every cached item
 * - Invokes `compileItemFn` ONLY for dirty, added, or cold-uncached items
 * - Splices the resulting chunks in exact source order into a deterministic
 *   `B8GSPL01` module artifact with accurate timing and cache hit-rate metrics.
 */
export async function spliceModule(
  plan: SplicePlan,
  compileItemFn: CompileItemFn,
): Promise<SpliceResult> {
  const totalStart = performance.now();

  const reasonByName = new Map<string, SubTuDirtyReason>();
  for (const item of plan.unchanged) reasonByName.set(item.name, 'unchanged-cold');
  for (const item of plan.bodyOnlyDirty) reasonByName.set(item.name, 'body-only-dirty');
  for (const item of plan.signatureDirty) reasonByName.set(item.name, 'signature-dirty');
  for (const item of plan.added) reasonByName.set(item.name, 'added');

  const compiledItems: string[] = [];
  const reusedItems: string[] = [];
  const orderedPayloads: Array<{
    readonly item: SubTuItem;
    readonly payload: Uint8Array;
    readonly fromCache: boolean;
  }> = [];

  let compileMs = 0;

  for (const item of plan.orderedItems) {
    const key: SubTuCasKey = {
      toolchain: plan.toolchain,
      targetTriple: plan.targetTriple,
      itemName: item.name,
      itemHash: item.itemHash,
    };

    const cached = plan.casIndex.get(key);
    if (cached !== null) {
      reusedItems.push(item.name);
      orderedPayloads.push({ item, payload: cached.bytes, fromCache: true });
      continue;
    }

    const reason = reasonByName.get(item.name) ?? 'added';
    const casKey = plan.casIndex.keyOf(key);
    const itemStart = performance.now();
    const compiledBytes = await compileItemFn(item, {
      toolchain: plan.toolchain,
      targetTriple: plan.targetTriple,
      reason,
      casKey,
    });
    compileMs += performance.now() - itemStart;

    const stored = plan.casIndex.put(key, compiledBytes, {
      kind: item.kind,
      sigHash: item.sigHash,
    });
    compiledItems.push(item.name);
    orderedPayloads.push({ item, payload: stored.bytes, fromCache: false });
  }

  const spliceStart = performance.now();
  const { artifactBytes, chunks } = encodeSplicedArtifact(
    plan.toolchain,
    plan.targetTriple,
    orderedPayloads,
  );
  const artifactSha256 = sha256Hex(artifactBytes);
  const spliceMs = performance.now() - spliceStart;
  const totalMs = performance.now() - totalStart;

  const totalItems = plan.orderedItems.length;
  const cacheHits = reusedItems.length;
  const cacheMisses = compiledItems.length;
  const cacheHitRate = totalItems === 0 ? 1 : cacheHits / totalItems;

  return Object.freeze({
    toolchain: plan.toolchain,
    targetTriple: plan.targetTriple,
    artifactBytes,
    artifactSha256,
    chunks,
    compiledItems: Object.freeze(compiledItems),
    reusedItems: Object.freeze(reusedItems),
    removedItems: Object.freeze(plan.removed.map((item) => item.name)),
    totalItems,
    compiledCount: cacheMisses,
    cacheHits,
    cacheMisses,
    cacheHitRate,
    hotSpliced: plan.canHotSplice,
    invalidatesDependents: plan.invalidatesDependents,
    compileMs,
    spliceMs,
    totalMs,
  });
}
