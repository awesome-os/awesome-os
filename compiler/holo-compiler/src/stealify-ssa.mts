/**
 * @file intersections/holo-compiler/stealify-ssa.mts
 * @description Go-inspired zero-LLVM SSA compiler pipeline for typed StealifyLang/TypeScript
 * pure arithmetic kernels -> WebAssembly 1.0 binary -> CAS v11 (`v11/files/00..ff/<sha512>`).
 *
 * Pipeline:
 *   1. `parseTypedFunction(source)`     — single-pass tokenizer + recursive-descent parser
 *   2. `runEscapeAndSsaPasses(ast)`     — stack vs. arena escape analysis + SSA IR lowering + constant folding + DCE
 *   3. `emitWasmModule(ssaFn)`          — minimal WebAssembly binary emitter (`i32` / `f64`)
 *   4. `compileStealifyToCasV11(...)`   — end-to-end compile + `CasV11Store` persistence (`B8G_ABI_MAGIC_V3`)
 *
 * Strictly `erasableSyntaxOnly: true`, zero external dependencies, Node 22+ built-ins only.
 */

import { CasV11Store } from './cas-v11-store.mts';

export const B8G_ABI_MAGIC_V3_HEX = '0x33564742' as const;

// ============================================================================
// 1. AST & IR Types
// ============================================================================

export type WasmValType = 'i32' | 'f64';
export type BinaryOp = '+' | '-' | '*' | '/';
export type UnaryOp = '+' | '-';
export type EscapeClass = 'stack' | 'arena';

export type ExprNode =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'ident'; readonly name: string }
  | { readonly kind: 'unary'; readonly op: UnaryOp; readonly operand: ExprNode }
  | { readonly kind: 'binary'; readonly op: BinaryOp; readonly left: ExprNode; readonly right: ExprNode };

export interface ParamNode {
  readonly name: string;
  readonly type: WasmValType;
}

export interface ConstBindingNode {
  readonly kind: 'const';
  readonly name: string;
  readonly type: WasmValType;
  readonly init: ExprNode;
}

export interface ParsedFunctionAst {
  readonly name: string;
  readonly exported: boolean;
  readonly params: readonly ParamNode[];
  readonly returnType: WasmValType;
  readonly bindings: readonly ConstBindingNode[];
  readonly returnExpr: ExprNode;
}

export type SsaOp =
  | { readonly id: number; readonly op: 'param'; readonly paramIndex: number; readonly name: string; readonly type: WasmValType }
  | { readonly id: number; readonly op: 'const'; readonly value: number; readonly type: WasmValType }
  | { readonly id: number; readonly op: 'neg'; readonly operand: number; readonly type: WasmValType }
  | { readonly id: number; readonly op: 'add' | 'sub' | 'mul' | 'div'; readonly lhs: number; readonly rhs: number; readonly type: WasmValType }
  | { readonly id: number; readonly op: 'ret'; readonly value: number; readonly type: WasmValType };

export interface EscapeSummaryEntry {
  readonly name: string;
  readonly kind: 'param' | 'local' | 'return';
  readonly type: WasmValType;
  readonly escapeClass: EscapeClass;
  readonly reason: string;
}

export interface SsaFunction {
  readonly name: string;
  readonly params: readonly ParamNode[];
  readonly returnType: WasmValType;
  readonly escapeClass: EscapeClass;
  readonly heapEscapes: number;
  readonly escapeReport: readonly EscapeSummaryEntry[];
  readonly foldedConstants: number;
  readonly ops: readonly SsaOp[];
}

export interface StealifyCasCompileResult {
  readonly name: string;
  readonly ssaOps: readonly SsaOp[];
  readonly escapeClass: EscapeClass;
  readonly heapEscapes: number;
  readonly foldedConstants: number;
  readonly wasmBytes: Uint8Array;
  readonly sha512: string;
  readonly blobPath: string;
  readonly deduplicated: boolean;
  readonly abiMagic: typeof B8G_ABI_MAGIC_V3_HEX;
}

// ============================================================================
// 2. Tokenizer & Recursive-Descent Parser (`parseTypedFunction`)
// ============================================================================

type TokenKind =
  | 'ident'
  | 'number'
  | '('
  | ')'
  | '{'
  | '}'
  | ','
  | ':'
  | ';'
  | '='
  | '+'
  | '-'
  | '*'
  | '/'
  | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly pos: number;
}

const SINGLE_CHAR_TOKENS = new Set<string>([
  '(', ')', '{', '}', ',', ':', ';', '=', '+', '-', '*', '/',
]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }

    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      if (i >= n) {
        throw new SyntaxError('Unterminated block comment');
      }
      i += 2;
      continue;
    }

    // Single-character punctuation / operators
    if (SINGLE_CHAR_TOKENS.has(ch)) {
      tokens.push({ kind: ch as TokenKind, text: ch, pos: i });
      i += 1;
      continue;
    }

    // Number literal (integer or decimal)
    if ((ch >= '0' && ch <= '9') || (ch === '.' && source[i + 1] !== undefined && source[i + 1]! >= '0' && source[i + 1]! <= '9')) {
      const start = i;
      let hasDot = false;
      while (i < n) {
        const c = source[i]!;
        if (c >= '0' && c <= '9') {
          i += 1;
        } else if (c === '.' && !hasDot) {
          hasDot = true;
          i += 1;
        } else {
          break;
        }
      }
      tokens.push({ kind: 'number', text: source.slice(start, i), pos: start });
      continue;
    }

    // Identifier / keyword
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      const start = i;
      i += 1;
      while (i < n) {
        const c = source[i]!;
        if (
          (c >= 'a' && c <= 'z') ||
          (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') ||
          c === '_' ||
          c === '$'
        ) {
          i += 1;
        } else {
          break;
        }
      }
      tokens.push({ kind: 'ident', text: source.slice(start, i), pos: start });
      continue;
    }

    throw new SyntaxError(`Unexpected character "${ch}" at offset ${i}`);
  }

  tokens.push({ kind: 'eof', text: '', pos: n });
  return tokens;
}

function mapTypeName(typeName: string, pos: number): WasmValType {
  if (typeName === 'i32') {
    return 'i32';
  }
  if (typeName === 'number' || typeName === 'f64') {
    return 'f64';
  }
  throw new SyntaxError(`Unsupported value type "${typeName}" at offset ${pos}; expected number, f64, or i32`);
}

class TypedFunctionParser {
  private readonly tokens: readonly Token[];
  private cursor: number;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
    this.cursor = 0;
  }

  private peek(): Token {
    return this.tokens[this.cursor]!;
  }

  private advance(): Token {
    const tok = this.tokens[this.cursor]!;
    if (tok.kind !== 'eof') {
      this.cursor += 1;
    }
    return tok;
  }

  private expect(kind: TokenKind, message?: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new SyntaxError(
        message ?? `Expected "${kind}" but found "${tok.text || tok.kind}" at offset ${tok.pos}`,
      );
    }
    return this.advance();
  }

  private matchKeyword(keyword: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'ident' && tok.text === keyword) {
      this.advance();
      return true;
    }
    return false;
  }

  parseFunction(): ParsedFunctionAst {
    const exported = this.matchKeyword('export');

    if (!this.matchKeyword('function')) {
      const tok = this.peek();
      throw new SyntaxError(`Expected "function" keyword at offset ${tok.pos}, found "${tok.text || tok.kind}"`);
    }

    const nameTok = this.expect('ident', 'Expected function name');
    this.expect('(');

    const rawParams: Array<{ name: string; explicitType: WasmValType | null }> = [];
    if (this.peek().kind !== ')') {
      while (true) {
        const paramNameTok = this.expect('ident', 'Expected parameter name');
        let explicitType: WasmValType | null = null;
        if (this.peek().kind === ':') {
          this.advance();
          const typeTok = this.expect('ident', 'Expected parameter type');
          explicitType = mapTypeName(typeTok.text, typeTok.pos);
        }
        rawParams.push({ name: paramNameTok.text, explicitType });

        if (this.peek().kind === ',') {
          this.advance();
          if (this.peek().kind === ')') {
            break;
          }
        } else {
          break;
        }
      }
    }
    this.expect(')');

    let returnType: WasmValType | null = null;
    if (this.peek().kind === ':') {
      this.advance();
      const retTypeTok = this.expect('ident', 'Expected return type');
      returnType = mapTypeName(retTypeTok.text, retTypeTok.pos);
    }

    const inferredType: WasmValType =
      returnType ??
      rawParams.find((p) => p.explicitType !== null)?.explicitType ??
      'f64';

    const params: ParamNode[] = rawParams.map((p) => {
      const resolved = p.explicitType ?? inferredType;
      if (resolved !== inferredType) {
        throw new SyntaxError(
          `Mixed numeric types in function "${nameTok.text}": parameter "${p.name}" is ${resolved} but function uses ${inferredType}`,
        );
      }
      return { name: p.name, type: resolved };
    });

    const knownIdentifiers = new Set<string>(params.map((p) => p.name));

    this.expect('{');
    const bindings: ConstBindingNode[] = [];
    let returnExpr: ExprNode | null = null;

    while (this.peek().kind !== '}' && this.peek().kind !== 'eof') {
      if (this.matchKeyword('const')) {
        if (returnExpr !== null) {
          throw new SyntaxError(`Unreachable const declaration after return at offset ${this.peek().pos}`);
        }
        const varTok = this.expect('ident', 'Expected local variable name');
        if (knownIdentifiers.has(varTok.text)) {
          throw new SyntaxError(`Duplicate identifier "${varTok.text}" at offset ${varTok.pos}`);
        }
        let localType: WasmValType = inferredType;
        if (this.peek().kind === ':') {
          this.advance();
          const typeTok = this.expect('ident', 'Expected local variable type');
          localType = mapTypeName(typeTok.text, typeTok.pos);
          if (localType !== inferredType) {
            throw new SyntaxError(
              `Local "${varTok.text}" type ${localType} does not match function type ${inferredType}`,
            );
          }
        }
        this.expect('=');
        const init = this.parseAddExpr(knownIdentifiers);
        if (this.peek().kind === ';') {
          this.advance();
        }
        knownIdentifiers.add(varTok.text);
        bindings.push({
          kind: 'const',
          name: varTok.text,
          type: localType,
          init,
        });
        continue;
      }

      if (this.matchKeyword('return')) {
        if (returnExpr !== null) {
          throw new SyntaxError(`Multiple return statements are not supported at offset ${this.peek().pos}`);
        }
        returnExpr = this.parseAddExpr(knownIdentifiers);
        if (this.peek().kind === ';') {
          this.advance();
        }
        continue;
      }

      const tok = this.peek();
      throw new SyntaxError(`Unexpected statement token "${tok.text || tok.kind}" at offset ${tok.pos}`);
    }

    this.expect('}');
    if (this.peek().kind !== 'eof') {
      const tok = this.peek();
      throw new SyntaxError(`Unexpected trailing token "${tok.text}" at offset ${tok.pos}`);
    }

    if (returnExpr === null) {
      throw new SyntaxError(`Function "${nameTok.text}" must end with a return statement`);
    }

    return Object.freeze({
      name: nameTok.text,
      exported,
      params: Object.freeze(params),
      returnType: inferredType,
      bindings: Object.freeze(bindings),
      returnExpr,
    });
  }

  private parseAddExpr(knownIdentifiers: ReadonlySet<string>): ExprNode {
    let left = this.parseMulExpr(knownIdentifiers);
    while (this.peek().kind === '+' || this.peek().kind === '-') {
      const op = this.advance().kind as '+' | '-';
      const right = this.parseMulExpr(knownIdentifiers);
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMulExpr(knownIdentifiers: ReadonlySet<string>): ExprNode {
    let left = this.parseUnaryExpr(knownIdentifiers);
    while (this.peek().kind === '*' || this.peek().kind === '/') {
      const op = this.advance().kind as '*' | '/';
      const right = this.parseUnaryExpr(knownIdentifiers);
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnaryExpr(knownIdentifiers: ReadonlySet<string>): ExprNode {
    if (this.peek().kind === '+' || this.peek().kind === '-') {
      const op = this.advance().kind as UnaryOp;
      const operand = this.parseUnaryExpr(knownIdentifiers);
      return { kind: 'unary', op, operand };
    }
    return this.parsePrimaryExpr(knownIdentifiers);
  }

  private parsePrimaryExpr(knownIdentifiers: ReadonlySet<string>): ExprNode {
    const tok = this.peek();
    if (tok.kind === 'number') {
      this.advance();
      const value = Number(tok.text);
      if (!Number.isFinite(value)) {
        throw new SyntaxError(`Invalid numeric literal "${tok.text}" at offset ${tok.pos}`);
      }
      return { kind: 'number', value };
    }

    if (tok.kind === 'ident') {
      this.advance();
      if (!knownIdentifiers.has(tok.text)) {
        throw new ReferenceError(`Unknown identifier "${tok.text}" at offset ${tok.pos}`);
      }
      return { kind: 'ident', name: tok.text };
    }

    if (tok.kind === '(') {
      this.advance();
      const inner = this.parseAddExpr(knownIdentifiers);
      this.expect(')');
      return inner;
    }

    throw new SyntaxError(`Expected expression at offset ${tok.pos}, found "${tok.text || tok.kind}"`);
  }
}

/**
 * Parses a typed pure StealifyLang / TypeScript arithmetic function:
 * `export function <name>(<params: number|f64|i32>): number|f64|i32 { [const x = <expr>;]* return <expr>; }`
 */
export function parseTypedFunction(source: string): ParsedFunctionAst {
  const tokens = tokenize(source);
  const parser = new TypedFunctionParser(tokens);
  return parser.parseFunction();
}

// ============================================================================
// 3. Escape Analysis, SSA IR Lowering & Constant Folding (`runEscapeAndSsaPasses`)
// ============================================================================

function normalizeValueForType(value: number, type: WasmValType): number {
  if (type === 'i32') {
    return value | 0;
  }
  return value;
}

function foldBinaryConstant(op: BinaryOp, left: number, right: number, type: WasmValType): number | null {
  if (op === '+') {
    return normalizeValueForType(left + right, type);
  }
  if (op === '-') {
    return normalizeValueForType(left - right, type);
  }
  if (op === '*') {
    return type === 'i32' ? Math.imul(left | 0, right | 0) : left * right;
  }
  if (op === '/') {
    if (right === 0) {
      return null;
    }
    return type === 'i32' ? Math.trunc((left | 0) / (right | 0)) | 0 : left / right;
  }
  return null;
}

function binaryOpToSsaOp(op: BinaryOp): 'add' | 'sub' | 'mul' | 'div' {
  switch (op) {
    case '+':
      return 'add';
    case '-':
      return 'sub';
    case '*':
      return 'mul';
    case '/':
      return 'div';
  }
}

/**
 * Runs Go-inspired stack vs. arena escape analysis, lowers the AST into flat
 * Single Static Assignment (SSA) IR, performs constant folding, and prunes
 * unreachable dead SSA nodes.
 */
export function runEscapeAndSsaPasses(ast: ParsedFunctionAst): SsaFunction {
  // Pass 1: Escape Analysis (scalar value-type kernels never escape to heap/arena)
  const escapeReport: EscapeSummaryEntry[] = [];
  let heapEscapes = 0;

  for (const param of ast.params) {
    escapeReport.push({
      name: param.name,
      kind: 'param',
      type: param.type,
      escapeClass: 'stack',
      reason: `value-type (${param.type}) parameter stays on WASM operand stack / local slot`,
    });
  }

  for (const binding of ast.bindings) {
    escapeReport.push({
      name: binding.name,
      kind: 'local',
      type: binding.type,
      escapeClass: 'stack',
      reason: `immutable value-type (${binding.type}) local does not escape function frame`,
    });
  }

  escapeReport.push({
    name: '$return',
    kind: 'return',
    type: ast.returnType,
    escapeClass: 'stack',
    reason: `scalar (${ast.returnType}) return value passed directly in register/stack`,
  });

  const escapeClass: EscapeClass = heapEscapes === 0 ? 'stack' : 'arena';

  // Pass 2: SSA Lowering + Constant Folding
  const rawOps: SsaOp[] = [];
  const constValues = new Map<number, number>();
  const env = new Map<string, number>();
  let nextId = 0;
  let foldedConstants = 0;

  const emit = (op: SsaOp): number => {
    rawOps.push(op);
    return op.id;
  };

  for (let idx = 0; idx < ast.params.length; idx += 1) {
    const param = ast.params[idx]!;
    const id = nextId++;
    emit({
      id,
      op: 'param',
      paramIndex: idx,
      name: param.name,
      type: param.type,
    });
    env.set(param.name, id);
  }

  const lowerExpr = (expr: ExprNode): number => {
    if (expr.kind === 'number') {
      const id = nextId++;
      const val = normalizeValueForType(expr.value, ast.returnType);
      emit({ id, op: 'const', value: val, type: ast.returnType });
      constValues.set(id, val);
      return id;
    }

    if (expr.kind === 'ident') {
      const boundId = env.get(expr.name);
      if (boundId === undefined) {
        throw new ReferenceError(`Unbound SSA identifier "${expr.name}"`);
      }
      return boundId;
    }

    if (expr.kind === 'unary') {
      const operandId = lowerExpr(expr.operand);
      if (expr.op === '+') {
        return operandId;
      }
      const knownVal = constValues.get(operandId);
      if (knownVal !== undefined) {
        const folded = normalizeValueForType(-knownVal, ast.returnType);
        const id = nextId++;
        emit({ id, op: 'const', value: folded, type: ast.returnType });
        constValues.set(id, folded);
        foldedConstants += 1;
        return id;
      }
      const id = nextId++;
      emit({ id, op: 'neg', operand: operandId, type: ast.returnType });
      return id;
    }

    // Binary expression
    const lhsId = lowerExpr(expr.left);
    const rhsId = lowerExpr(expr.right);
    const lhsConst = constValues.get(lhsId);
    const rhsConst = constValues.get(rhsId);

    if (lhsConst !== undefined && rhsConst !== undefined) {
      const folded = foldBinaryConstant(expr.op, lhsConst, rhsConst, ast.returnType);
      if (folded !== null) {
        const id = nextId++;
        emit({ id, op: 'const', value: folded, type: ast.returnType });
        constValues.set(id, folded);
        foldedConstants += 1;
        return id;
      }
    }

    const id = nextId++;
    emit({
      id,
      op: binaryOpToSsaOp(expr.op),
      lhs: lhsId,
      rhs: rhsId,
      type: ast.returnType,
    });
    return id;
  };

  for (const binding of ast.bindings) {
    const valueId = lowerExpr(binding.init);
    env.set(binding.name, valueId);
  }

  const returnValId = lowerExpr(ast.returnExpr);
  const retOpId = nextId++;
  emit({
    id: retOpId,
    op: 'ret',
    value: returnValId,
    type: ast.returnType,
  });

  // Pass 3: Dead Code Elimination (keep all params + ops reachable from `ret`)
  const opById = new Map<number, SsaOp>();
  for (const op of rawOps) {
    opById.set(op.id, op);
  }

  const liveIds = new Set<number>();
  for (const op of rawOps) {
    if (op.op === 'param') {
      liveIds.add(op.id);
    }
  }

  const stack: number[] = [retOpId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (liveIds.has(cur)) {
      continue;
    }
    liveIds.add(cur);
    const op = opById.get(cur);
    if (!op) {
      continue;
    }
    if (op.op === 'ret') {
      stack.push(op.value);
    } else if (op.op === 'neg') {
      stack.push(op.operand);
    } else if (op.op === 'add' || op.op === 'sub' || op.op === 'mul' || op.op === 'div') {
      stack.push(op.lhs, op.rhs);
    }
  }

  const prunedOps = rawOps.filter((op) => liveIds.has(op.id));

  return Object.freeze({
    name: ast.name,
    params: ast.params,
    returnType: ast.returnType,
    escapeClass,
    heapEscapes,
    escapeReport: Object.freeze(escapeReport),
    foldedConstants,
    ops: Object.freeze(prunedOps),
  });
}

// ============================================================================
// 4. Minimal WebAssembly 1.0 Binary Emitter (`emitWasmModule`)
// ============================================================================

const WASM_MAGIC_AND_VERSION = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] as const;

const WASM_SECTION_TYPE = 0x01;
const WASM_SECTION_FUNCTION = 0x03;
const WASM_SECTION_EXPORT = 0x07;
const WASM_SECTION_CODE = 0x0a;

const WASM_VALTYPE_I32 = 0x7f;
const WASM_VALTYPE_F64 = 0x7c;

const WASM_OP_LOCAL_GET = 0x20;
const WASM_OP_LOCAL_TEE = 0x22;
const WASM_OP_I32_CONST = 0x41;
const WASM_OP_F64_CONST = 0x44;

const WASM_OP_I32_ADD = 0x6a;
const WASM_OP_I32_SUB = 0x6b;
const WASM_OP_I32_MUL = 0x6c;
const WASM_OP_I32_DIV_S = 0x6d;

const WASM_OP_F64_NEG = 0x9a;
const WASM_OP_F64_ADD = 0xa0;
const WASM_OP_F64_SUB = 0xa1;
const WASM_OP_F64_MUL = 0xa2;
const WASM_OP_F64_DIV = 0xa3;

const WASM_OP_END = 0x0b;

const TEXT_ENCODER = new TextEncoder();

function valTypeToByte(type: WasmValType): number {
  return type === 'i32' ? WASM_VALTYPE_I32 : WASM_VALTYPE_F64;
}

function encodeU32Leb128(value: number): number[] {
  let v = value >>> 0;
  const out: number[] = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v !== 0);
  return out;
}

function encodeS32Leb128(value: number): number[] {
  let v = value | 0;
  const out: number[] = [];
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    const signBitSet = (byte & 0x40) !== 0;
    if ((v === 0 && !signBitSet) || (v === -1 && signBitSet)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

function encodeF64LittleEndian(value: number): number[] {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, value, true);
  const bytes = new Uint8Array(buf);
  return [
    bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!,
    bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!,
  ];
}

function encodeName(name: string): number[] {
  const utf8 = TEXT_ENCODER.encode(name);
  return [...encodeU32Leb128(utf8.length), ...utf8];
}

function encodeSection(sectionId: number, payload: readonly number[]): number[] {
  return [sectionId, ...encodeU32Leb128(payload.length), ...payload];
}

/**
 * Emits a valid, minimal WebAssembly 1.0 binary (`Uint8Array`) containing
 * Type, Function, Export, and Code sections that executes directly in V8/WASI.
 */
export function emitWasmModule(ssaFn: SsaFunction): Uint8Array {
  const valTypeByte = valTypeToByte(ssaFn.returnType);

  // Build lookup table & use counts for DAG-safe local spilling
  const opById = new Map<number, SsaOp>();
  const useCount = new Map<number, number>();
  let retOp: Extract<SsaOp, { op: 'ret' }> | null = null;

  const bumpUse = (id: number): void => {
    useCount.set(id, (useCount.get(id) ?? 0) + 1);
  };

  for (const op of ssaFn.ops) {
    opById.set(op.id, op);
    if (op.op === 'ret') {
      retOp = op;
      bumpUse(op.value);
    } else if (op.op === 'neg') {
      bumpUse(op.operand);
    } else if (op.op === 'add' || op.op === 'sub' || op.op === 'mul' || op.op === 'div') {
      bumpUse(op.lhs);
      bumpUse(op.rhs);
    }
  }

  if (retOp === null) {
    throw new Error(`SSA function "${ssaFn.name}" has no return operation`);
  }

  // Assign WASM locals for any computed SSA value used more than once
  const localSlotBySsaId = new Map<number, number>();
  let nextLocalSlot = ssaFn.params.length;
  for (const op of ssaFn.ops) {
    if (op.op !== 'param' && op.op !== 'const' && op.op !== 'ret') {
      if ((useCount.get(op.id) ?? 0) > 1) {
        localSlotBySsaId.set(op.id, nextLocalSlot);
        nextLocalSlot += 1;
      }
    }
  }
  const extraLocalCount = nextLocalSlot - ssaFn.params.length;

  // Emit WASM stack instructions
  const codeBytes: number[] = [];
  const materializedLocals = new Set<number>();

  const emitValue = (ssaId: number): void => {
    const op = opById.get(ssaId);
    if (!op) {
      throw new Error(`Missing SSA value v${ssaId} during WASM emission`);
    }

    if (op.op === 'param') {
      codeBytes.push(WASM_OP_LOCAL_GET, ...encodeU32Leb128(op.paramIndex));
      return;
    }

    if (op.op === 'const') {
      if (op.type === 'i32') {
        codeBytes.push(WASM_OP_I32_CONST, ...encodeS32Leb128(op.value));
      } else {
        codeBytes.push(WASM_OP_F64_CONST, ...encodeF64LittleEndian(op.value));
      }
      return;
    }

    const assignedLocal = localSlotBySsaId.get(op.id);
    if (assignedLocal !== undefined && materializedLocals.has(op.id)) {
      codeBytes.push(WASM_OP_LOCAL_GET, ...encodeU32Leb128(assignedLocal));
      return;
    }

    if (op.op === 'neg') {
      if (op.type === 'i32') {
        codeBytes.push(WASM_OP_I32_CONST, ...encodeS32Leb128(0));
        emitValue(op.operand);
        codeBytes.push(WASM_OP_I32_SUB);
      } else {
        emitValue(op.operand);
        codeBytes.push(WASM_OP_F64_NEG);
      }
    } else if (op.op === 'add' || op.op === 'sub' || op.op === 'mul' || op.op === 'div') {
      emitValue(op.lhs);
      emitValue(op.rhs);
      if (op.type === 'i32') {
        if (op.op === 'add') codeBytes.push(WASM_OP_I32_ADD);
        else if (op.op === 'sub') codeBytes.push(WASM_OP_I32_SUB);
        else if (op.op === 'mul') codeBytes.push(WASM_OP_I32_MUL);
        else codeBytes.push(WASM_OP_I32_DIV_S);
      } else {
        if (op.op === 'add') codeBytes.push(WASM_OP_F64_ADD);
        else if (op.op === 'sub') codeBytes.push(WASM_OP_F64_SUB);
        else if (op.op === 'mul') codeBytes.push(WASM_OP_F64_MUL);
        else codeBytes.push(WASM_OP_F64_DIV);
      }
    } else {
      throw new Error(`Unexpected SSA op "${op.op}" in expression position`);
    }

    if (assignedLocal !== undefined) {
      codeBytes.push(WASM_OP_LOCAL_TEE, ...encodeU32Leb128(assignedLocal));
      materializedLocals.add(op.id);
    }
  };

  emitValue(retOp.value);
  codeBytes.push(WASM_OP_END);

  // Section 1: Type section (1 function signature)
  const typeSectionPayload: number[] = [
    0x01, // 1 type
    0x60, // func
    ...encodeU32Leb128(ssaFn.params.length),
    ...ssaFn.params.map((p) => valTypeToByte(p.type)),
    0x01, // 1 return value
    valTypeByte,
  ];

  // Section 3: Function section (1 function -> type index 0)
  const funcSectionPayload: number[] = [0x01, 0x00];

  // Section 7: Export section (1 exported function -> func index 0)
  const exportSectionPayload: number[] = [
    0x01, // 1 export
    ...encodeName(ssaFn.name),
    0x00, // export kind: func
    0x00, // func index 0
  ];

  // Section 10: Code section (1 function body)
  const localDecls: number[] =
    extraLocalCount > 0
      ? [0x01, ...encodeU32Leb128(extraLocalCount), valTypeByte]
      : [0x00];
  const funcBody: number[] = [...localDecls, ...codeBytes];
  const codeSectionPayload: number[] = [
    0x01, // 1 function body
    ...encodeU32Leb128(funcBody.length),
    ...funcBody,
  ];

  const moduleBytes: number[] = [
    ...WASM_MAGIC_AND_VERSION,
    ...encodeSection(WASM_SECTION_TYPE, typeSectionPayload),
    ...encodeSection(WASM_SECTION_FUNCTION, funcSectionPayload),
    ...encodeSection(WASM_SECTION_EXPORT, exportSectionPayload),
    ...encodeSection(WASM_SECTION_CODE, codeSectionPayload),
  ];

  return new Uint8Array(moduleBytes);
}

// ============================================================================
// 5. End-to-End Pipeline -> CAS v11 (`compileStealifyToCasV11`)
// ============================================================================

/**
 * Compiles a typed StealifyLang/TypeScript function through:
 *   Parse -> Escape Analysis + SSA + Constant Folding -> Emit WASM -> `CasV11Store`
 * and persists the raw WebAssembly binary under `<storeRoot>/files/00..ff/<sha512>`.
 */
export function compileStealifyToCasV11(
  source: string,
  casStore: CasV11Store,
): StealifyCasCompileResult {
  const ast = parseTypedFunction(source);
  const ssaFn = runEscapeAndSsaPasses(ast);
  const wasmBytes = emitWasmModule(ssaFn);

  const stored = casStore.putBlob(wasmBytes, {
    kind: 'object',
    executable: false,
    meta: {
      name: ssaFn.name,
      abiMagic: B8G_ABI_MAGIC_V3_HEX,
      escapeClass: ssaFn.escapeClass,
      heapEscapes: ssaFn.heapEscapes,
      returnType: ssaFn.returnType,
      paramCount: ssaFn.params.length,
      ssaOpCount: ssaFn.ops.length,
      foldedConstants: ssaFn.foldedConstants,
    },
  });

  return Object.freeze({
    name: ssaFn.name,
    ssaOps: ssaFn.ops,
    escapeClass: ssaFn.escapeClass,
    heapEscapes: ssaFn.heapEscapes,
    foldedConstants: ssaFn.foldedConstants,
    wasmBytes,
    sha512: stored.sha512,
    blobPath: stored.path,
    deduplicated: stored.deduplicated,
    abiMagic: B8G_ABI_MAGIC_V3_HEX,
  });
}
