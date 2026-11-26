/**
 * Zero-dependency TypeScript JVM `.class` binary assembler (JVMS §4.1).
 *
 * Emits valid `0xCAFEBABE` class files (major version 49 / Java 5.0, no
 * StackMapTable required) compatible with both `sectium-jvm` (Tier-0 + Tier-2
 * AOT) and standard JVMs.
 */

export const JVM_CLASS_MAGIC = 0xcafebabe;
export const JVM_DEFAULT_MAJOR_VERSION = 49;
export const JVM_DEFAULT_MINOR_VERSION = 0;

export const JVM_ACCESS_FLAGS = {
  ACC_PUBLIC: 0x0001,
  ACC_STATIC: 0x0008,
  ACC_SUPER: 0x0020,
} as const;

export const JVM_OPCODES = {
  nop: 0x00,
  aconst_null: 0x01,
  iconst_m1: 0x02,
  iconst_0: 0x03,
  iconst_1: 0x04,
  iconst_2: 0x05,
  iconst_3: 0x06,
  iconst_4: 0x07,
  iconst_5: 0x08,
  lconst_0: 0x09,
  lconst_1: 0x0a,
  bipush: 0x10,
  sipush: 0x11,
  ldc: 0x12,
  ldc_w: 0x13,
  iload: 0x15,
  lload: 0x16,
  aload: 0x19,
  iload_0: 0x1a,
  iload_1: 0x1b,
  iload_2: 0x1c,
  iload_3: 0x1d,
  aload_0: 0x2a,
  aload_1: 0x2b,
  aload_2: 0x2c,
  aload_3: 0x2d,
  iaload: 0x2e,
  baload: 0x33,
  istore: 0x36,
  lstore: 0x37,
  astore: 0x3a,
  istore_0: 0x3b,
  istore_1: 0x3c,
  istore_2: 0x3d,
  istore_3: 0x3e,
  astore_0: 0x4b,
  astore_1: 0x4c,
  astore_2: 0x4d,
  astore_3: 0x4e,
  iastore: 0x4f,
  bastore: 0x54,
  pop: 0x57,
  dup: 0x59,
  swap: 0x5f,
  iadd: 0x60,
  ladd: 0x61,
  isub: 0x64,
  lsub: 0x65,
  imul: 0x68,
  lmul: 0x69,
  idiv: 0x6c,
  irem: 0x70,
  ineg: 0x74,
  ishl: 0x78,
  ishr: 0x7a,
  iushr: 0x7c,
  iand: 0x7e,
  ior: 0x80,
  ixor: 0x82,
  iinc: 0x84,
  ifeq: 0x99,
  ifne: 0x9a,
  iflt: 0x9b,
  ifge: 0x9c,
  ifgt: 0x9d,
  ifle: 0x9e,
  if_icmpeq: 0x9f,
  if_icmpne: 0xa0,
  if_icmplt: 0xa1,
  if_icmpge: 0xa2,
  if_icmpgt: 0xa3,
  if_icmple: 0xa4,
  goto: 0xa7,
  ireturn: 0xac,
  lreturn: 0xad,
  return: 0xb1,
  getstatic: 0xb2,
  invokevirtual: 0xb6,
  invokestatic: 0xb8,
  newarray: 0xbc,
  arraylength: 0xbe,
} as const;

export const JVM_ARRAY_TYPE = {
  T_BYTE: 8,
  T_INT: 10,
} as const;

const CP_TAG = {
  Utf8: 1,
  Integer: 3,
  Class: 7,
  String: 8,
  Fieldref: 9,
  Methodref: 10,
  NameAndType: 12,
} as const;

const utf8Encoder = new TextEncoder();

class ByteWriter {
  private readonly chunks: number[];

  constructor() {
    this.chunks = [];
  }

  u1(v: number): void {
    this.chunks.push(v & 0xff);
  }

  u2(v: number): void {
    this.chunks.push((v >>> 8) & 0xff, v & 0xff);
  }

  u4(v: number): void {
    this.chunks.push(
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    );
  }

  bytes(data: Uint8Array | readonly number[]): void {
    for (let i = 0; i < data.length; i++) {
      this.chunks.push(data[i] & 0xff);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export class ConstantPoolBuilder {
  private readonly entries: Uint8Array[];
  private readonly indexByKey: Map<string, number>;

  constructor() {
    this.entries = [];
    this.indexByKey = new Map<string, number>();
  }

  get count(): number {
    return this.entries.length;
  }

  private addEntry(key: string, encoded: Uint8Array): number {
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    this.entries.push(encoded);
    const idx = this.entries.length; // 1-based JVM constant pool index
    this.indexByKey.set(key, idx);
    return idx;
  }

  addUtf8(value: string): number {
    const key = `utf8:${value}`;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const raw = utf8Encoder.encode(value);
    const w = new ByteWriter();
    w.u1(CP_TAG.Utf8);
    w.u2(raw.length);
    w.bytes(raw);
    return this.addEntry(key, w.toUint8Array());
  }

  addInteger(value: number): number {
    const i32 = value | 0;
    const key = `int:${i32}`;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const w = new ByteWriter();
    w.u1(CP_TAG.Integer);
    w.u4(i32 >>> 0);
    return this.addEntry(key, w.toUint8Array());
  }

  addClass(internalName: string): number {
    const nameIndex = this.addUtf8(internalName);
    const key = `class:${nameIndex}`;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const w = new ByteWriter();
    w.u1(CP_TAG.Class);
    w.u2(nameIndex);
    return this.addEntry(key, w.toUint8Array());
  }

  addString(value: string): number {
    const utf8Index = this.addUtf8(value);
    const key = `string:${utf8Index}`;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const w = new ByteWriter();
    w.u1(CP_TAG.String);
    w.u2(utf8Index);
    return this.addEntry(key, w.toUint8Array());
  }

  addNameAndType(name: string, descriptor: string): number {
    const nameIndex = this.addUtf8(name);
    const descIndex = this.addUtf8(descriptor);
    const key = `nat:${nameIndex}:${descIndex}`;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const w = new ByteWriter();
    w.u1(CP_TAG.NameAndType);
    w.u2(nameIndex);
    w.u2(descIndex);
    return this.addEntry(key, w.toUint8Array());
  }

  addFieldref(className: string, fieldName: string, descriptor: string): number {
    const classIndex = this.addClass(className);
    const natIndex = this.addNameAndType(fieldName, descriptor);
    const key = `field:${classIndex}:${natIndex}`;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const w = new ByteWriter();
    w.u1(CP_TAG.Fieldref);
    w.u2(classIndex);
    w.u2(natIndex);
    return this.addEntry(key, w.toUint8Array());
  }

  addMethodref(className: string, methodName: string, descriptor: string): number {
    const classIndex = this.addClass(className);
    const natIndex = this.addNameAndType(methodName, descriptor);
    const key = `method:${classIndex}:${natIndex}`;
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const w = new ByteWriter();
    w.u1(CP_TAG.Methodref);
    w.u2(classIndex);
    w.u2(natIndex);
    return this.addEntry(key, w.toUint8Array());
  }

  serialize(): Uint8Array {
    const w = new ByteWriter();
    w.u2(this.entries.length + 1);
    for (let i = 0; i < this.entries.length; i++) {
      w.bytes(this.entries[i]);
    }
    return w.toUint8Array();
  }
}

interface BranchPatch {
  readonly branchPc: number;
  readonly patchOffset: number;
  readonly targetLabel: string;
}

export class BytecodeBuilder {
  private readonly code: number[];
  private readonly labels: Map<string, number>;
  private readonly patches: BranchPatch[];

  constructor() {
    this.code = [];
    this.labels = new Map<string, number>();
    this.patches = [];
  }

  get pc(): number {
    return this.code.length;
  }

  mark(label: string): this {
    this.labels.set(label, this.code.length);
    return this;
  }

  op(opcode: number): this {
    this.code.push(opcode & 0xff);
    return this;
  }

  opU1(opcode: number, arg: number): this {
    this.code.push(opcode & 0xff, arg & 0xff);
    return this;
  }

  opU2(opcode: number, arg: number): this {
    this.code.push(opcode & 0xff, (arg >>> 8) & 0xff, arg & 0xff);
    return this;
  }

  opIinc(localIndex: number, delta: number): this {
    this.code.push(JVM_OPCODES.iinc, localIndex & 0xff, delta & 0xff);
    return this;
  }

  branch(opcode: number, targetLabel: string): this {
    const branchPc = this.code.length;
    this.code.push(opcode & 0xff);
    const patchOffset = this.code.length;
    this.code.push(0, 0);
    this.patches.push({ branchPc, patchOffset, targetLabel });
    return this;
  }

  pushInt(value: number, cp?: ConstantPoolBuilder): this {
    const i32 = value | 0;
    if (i32 >= -1 && i32 <= 5) {
      return this.op(JVM_OPCODES.iconst_0 + i32);
    }
    if (i32 >= -128 && i32 <= 127) {
      return this.opU1(JVM_OPCODES.bipush, i32);
    }
    if (i32 >= -32768 && i32 <= 32767) {
      return this.opU2(JVM_OPCODES.sipush, i32 & 0xffff);
    }
    if (!cp) {
      throw new RangeError(`pushInt(${i32}) outside 16-bit range requires ConstantPoolBuilder`);
    }
    const idx = cp.addInteger(i32);
    return idx <= 0xff
      ? this.opU1(JVM_OPCODES.ldc, idx)
      : this.opU2(JVM_OPCODES.ldc_w, idx);
  }

  build(): Uint8Array {
    const out = Uint8Array.from(this.code);
    for (let i = 0; i < this.patches.length; i++) {
      const p = this.patches[i];
      const targetPc = this.labels.get(p.targetLabel);
      if (targetPc === undefined) {
        throw new Error(`Unresolved JVM branch label: ${p.targetLabel}`);
      }
      const rel = targetPc - p.branchPc;
      if (rel < -32768 || rel > 32767) {
        throw new RangeError(`Branch offset ${rel} out of signed 16-bit range for label ${p.targetLabel}`);
      }
      out[p.patchOffset] = (rel >>> 8) & 0xff;
      out[p.patchOffset + 1] = rel & 0xff;
    }
    return out;
  }
}

export interface MethodSpec {
  readonly name: string;
  readonly descriptor: string;
  readonly accessFlags?: number;
  readonly maxStack: number;
  readonly maxLocals: number;
  readonly code: Uint8Array | readonly number[];
}

export interface ClassFileSpec {
  readonly className: string;
  readonly superClassName?: string;
  readonly accessFlags?: number;
  readonly majorVersion?: number;
  readonly minorVersion?: number;
  readonly constantPool?: ConstantPoolBuilder;
  readonly methods: readonly MethodSpec[] | ((cp: ConstantPoolBuilder) => readonly MethodSpec[]);
}

/**
 * Assemble a complete, spec-compliant JVM `.class` binary (`0xCAFEBABE`).
 */
export function emitMinimalClassFile(spec: ClassFileSpec): Uint8Array {
  const cp = spec.constantPool ?? new ConstantPoolBuilder();
  const methods = typeof spec.methods === 'function' ? spec.methods(cp) : spec.methods;

  const thisClassIndex = cp.addClass(spec.className);
  const superClassIndex = cp.addClass(spec.superClassName ?? 'java/lang/Object');
  const codeAttrNameIndex = cp.addUtf8('Code');

  const resolvedMethods = methods.map((m) => ({
    accessFlags: m.accessFlags ?? (JVM_ACCESS_FLAGS.ACC_PUBLIC | JVM_ACCESS_FLAGS.ACC_STATIC),
    nameIndex: cp.addUtf8(m.name),
    descriptorIndex: cp.addUtf8(m.descriptor),
    maxStack: m.maxStack,
    maxLocals: m.maxLocals,
    code: m.code instanceof Uint8Array ? m.code : Uint8Array.from(m.code),
  }));

  const w = new ByteWriter();
  w.u4(JVM_CLASS_MAGIC);
  w.u2(spec.minorVersion ?? JVM_DEFAULT_MINOR_VERSION);
  w.u2(spec.majorVersion ?? JVM_DEFAULT_MAJOR_VERSION);
  w.bytes(cp.serialize());
  w.u2(spec.accessFlags ?? (JVM_ACCESS_FLAGS.ACC_PUBLIC | JVM_ACCESS_FLAGS.ACC_SUPER));
  w.u2(thisClassIndex);
  w.u2(superClassIndex);
  w.u2(0); // interfaces_count
  w.u2(0); // fields_count
  w.u2(resolvedMethods.length);

  for (let i = 0; i < resolvedMethods.length; i++) {
    const m = resolvedMethods[i];
    w.u2(m.accessFlags);
    w.u2(m.nameIndex);
    w.u2(m.descriptorIndex);
    w.u2(1); // attributes_count (Code)
    w.u2(codeAttrNameIndex);
    w.u4(12 + m.code.length);
    w.u2(m.maxStack);
    w.u2(m.maxLocals);
    w.u4(m.code.length);
    w.bytes(m.code);
    w.u2(0); // exception_table_length
    w.u2(0); // code attributes_count
  }

  w.u2(0); // class attributes_count
  return w.toUint8Array();
}

/**
 * Emit a standalone `Fib.class` that computes recursive `fib(n)` and prints
 * the result via `System.out.println(int)`.
 */
export function emitFibClass(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`emitFibClass(n) requires a non-negative integer, got ${n}`);
  }

  return emitMinimalClassFile({
    className: 'Fib',
    methods: (cp) => {
      const fibRef = cp.addMethodref('Fib', 'fib', '(I)I');
      const systemOutRef = cp.addFieldref('java/lang/System', 'out', 'Ljava/io/PrintStream;');
      const printlnIntRef = cp.addMethodref('java/io/PrintStream', 'println', '(I)V');

      const fibCode = new BytecodeBuilder()
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.iconst_1)
        .branch(JVM_OPCODES.if_icmpgt, 'recurse')
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.ireturn)
        .mark('recurse')
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.iconst_1)
        .op(JVM_OPCODES.isub)
        .opU2(JVM_OPCODES.invokestatic, fibRef)
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.iconst_2)
        .op(JVM_OPCODES.isub)
        .opU2(JVM_OPCODES.invokestatic, fibRef)
        .op(JVM_OPCODES.iadd)
        .op(JVM_OPCODES.ireturn)
        .build();

      const mainCode = new BytecodeBuilder()
        .opU2(JVM_OPCODES.getstatic, systemOutRef)
        .pushInt(n, cp)
        .opU2(JVM_OPCODES.invokestatic, fibRef)
        .opU2(JVM_OPCODES.invokevirtual, printlnIntRef)
        .op(JVM_OPCODES.return)
        .build();

      return [
        {
          name: 'fib',
          descriptor: '(I)I',
          maxStack: 4,
          maxLocals: 1,
          code: fibCode,
        },
        {
          name: 'main',
          descriptor: '([Ljava/lang/String;)V',
          maxStack: 2,
          maxLocals: 1,
          code: mainCode,
        },
      ];
    },
  });
}

/**
 * Emit a standalone `ArraySum.class` that allocates `new int[16]`, fills
 * `arr[i] = i * 3`, sums all elements, and prints `360` via
 * `System.out.println(int)`.
 */
export function emitArraySumClass(): Uint8Array {
  return emitMinimalClassFile({
    className: 'ArraySum',
    methods: (cp) => {
      const systemOutRef = cp.addFieldref('java/lang/System', 'out', 'Ljava/io/PrintStream;');
      const printlnIntRef = cp.addMethodref('java/io/PrintStream', 'println', '(I)V');

      const mainCode = new BytecodeBuilder()
        // int[] arr = new int[16];  (local 1)
        .opU1(JVM_OPCODES.bipush, 16)
        .opU1(JVM_OPCODES.newarray, JVM_ARRAY_TYPE.T_INT)
        .op(JVM_OPCODES.astore_1)
        // int i = 0;  (local 2)
        .op(JVM_OPCODES.iconst_0)
        .op(JVM_OPCODES.istore_2)
        // while (i < arr.length) { arr[i] = i * 3; i++; }
        .mark('fill_loop')
        .op(JVM_OPCODES.iload_2)
        .op(JVM_OPCODES.aload_1)
        .op(JVM_OPCODES.arraylength)
        .branch(JVM_OPCODES.if_icmpge, 'fill_done')
        .op(JVM_OPCODES.aload_1)
        .op(JVM_OPCODES.iload_2)
        .op(JVM_OPCODES.iload_2)
        .op(JVM_OPCODES.iconst_3)
        .op(JVM_OPCODES.imul)
        .op(JVM_OPCODES.iastore)
        .opIinc(2, 1)
        .branch(JVM_OPCODES.goto, 'fill_loop')
        .mark('fill_done')
        // int sum = 0; i = 0;  (local 3 = sum)
        .op(JVM_OPCODES.iconst_0)
        .op(JVM_OPCODES.istore_3)
        .op(JVM_OPCODES.iconst_0)
        .op(JVM_OPCODES.istore_2)
        // while (i < arr.length) { sum += arr[i]; i++; }
        .mark('sum_loop')
        .op(JVM_OPCODES.iload_2)
        .op(JVM_OPCODES.aload_1)
        .op(JVM_OPCODES.arraylength)
        .branch(JVM_OPCODES.if_icmpge, 'sum_done')
        .op(JVM_OPCODES.iload_3)
        .op(JVM_OPCODES.aload_1)
        .op(JVM_OPCODES.iload_2)
        .op(JVM_OPCODES.iaload)
        .op(JVM_OPCODES.iadd)
        .op(JVM_OPCODES.istore_3)
        .opIinc(2, 1)
        .branch(JVM_OPCODES.goto, 'sum_loop')
        .mark('sum_done')
        // System.out.println(sum);
        .opU2(JVM_OPCODES.getstatic, systemOutRef)
        .op(JVM_OPCODES.iload_3)
        .opU2(JVM_OPCODES.invokevirtual, printlnIntRef)
        .op(JVM_OPCODES.return)
        .build();

      return [
        {
          name: 'main',
          descriptor: '([Ljava/lang/String;)V',
          maxStack: 4,
          maxLocals: 4,
          code: mainCode,
        },
      ];
    },
  });
}
