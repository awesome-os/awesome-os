# b8g-runtime

Unified, scriptable language-runtime host in `sections/b8g-runtime/` that lets `intersections/*` drive both **`sectium-es`** (C11 zero-V8 ECMAScript) and **`sectium-jvm`** (C11 zero-JDK JVM bytecode Tier-0 interpreter + Tier-2 AOT) through one typed TypeScript API, with SHA-256 content-addressed AOT caching and 64-byte-aligned `B8G_ARENA_V1` `SharedArrayBuffer` views.

## Scope: `b8g-runtime` vs `b8g-vm-manager`

| Layer | Location | Responsibility |
| :--- | :--- | :--- |
| **`b8g-runtime`** | `sections/b8g-runtime/` | Lightweight, scriptable **language runtime host**: evaluates ECMAScript via `sectium-es`, assembles `0xCAFEBABE` `.class` binaries in pure TypeScript, runs JVM bytecode in Tier-0, and compiles `.class` files to native executables via `sectium-jvm --emit-c` + `zig cc -O3 -s` with `.b8g-cas/runtime-aot/` caching. |
| **`b8g-vm-manager`** | `intersections/b8g-vm-manager/` | Full **hypervisor & guest VM fleet orchestrator**: manages OS virtual machines, `b8g_guest_agent`, `ivshmem` bridges, VFIO passthrough, Chrome fleet control, and cloud tenant devices. |

Zero namespace, file, or binary collision exists between the two layers.

## Modules

- **`sections/b8g-runtime/class-emitter.mts`**: Zero-dependency TypeScript JVM `.class` binary assembler (`emitMinimalClassFile`, `ConstantPoolBuilder`, `BytecodeBuilder`) emitting spec-compliant `0xCAFEBABE` class files, plus built-in helpers:
  - `emitFibClass(n: number): Uint8Array` — recursive `fib(n)` printed via `System.out.println(int)`
  - `emitArraySumClass(): Uint8Array` — allocates `int[16]`, fills `i * 3`, sums elements, prints `360`
- **`sections/b8g-runtime/index.mts`**: `B8gRuntimeHost` (`erasableSyntaxOnly: true` compliant, `shell: false` process spawning):
  - `evalEs(code)` — runs inline ECMAScript via `sections/b8g-es/dist/sectium-es.exe`
  - `runClassBytes(classBytes)` / `runClassFile(classPath)` — runs `.class` on `sections/b8g-jvm/dist/sectium-jvm.exe` Tier-0
  - `aotCompileClass(classPath, outExePath?)` — transpiles via `sectium-jvm --emit-c` and compiles via `.\bin\zig.cmd cc -O3 -s` with SHA-256 CAS under `.b8g-cas/runtime-aot/` (`< 1 ms` repeat cache hits)
  - `createArenaView(byteLength)` — allocates a 64-byte-aligned `SharedArrayBuffer`-backed `Uint8Array` (`B8G_ARENA_V1` compatible)
  - `getCapabilities()` — reports binary availability, byte sizes, Zig shim status, and CAS directory

## Usage

```ts
import { B8gRuntimeHost, emitArraySumClass, emitFibClass } from './index.mts';

const host = new B8gRuntimeHost();
const es = host.evalEs('console.log(21 * 2);');
const arena = host.createArenaView(4096);
const fibClass = emitFibClass(25);
const arrClass = emitArraySumClass();
```

## Verification

```powershell
.\bin\node.ps1 --test sections/b8g-runtime/b8g-runtime.test.mts
.\bin\b8g-web-doc.ps1 sections/b8g-runtime/README.md
```
