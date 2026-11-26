# `holo-*` Projections Reference

Every runtime in Awesome-OS is a **0-byte holographic hardlink projection** of the unified `v11` CAS (`B8G_ABI_MAGIC_V3 = 0x33564742`):

| Canonical Projection | Source Repository (`repository://`) | Legacy Alias(es) | Role |
| :--- | :--- | :--- | :--- |
| **`holo-compiler`** | `repository://github.com/awesome-os/holo-compiler@main` | `b8g-build` | 5-toolchain compiler, `libholo_codegen`, Sub-TU splicing, StealifyLang SSA |
| **`holo-pm`** | `repository://github.com/awesome-os/holo-pm@main` | `b8g-pm` | Universal `repository://` + `v11` CAS package manager (`libholo-pm`) |
| **`holo-ffi`** | `repository://github.com/awesome-os/b8g-ghost@main` | `ghostFFI`, `ghost-ffi` | `v11` CAS FFI loader with `v11/links/` hardlink projection |
| **`holo-wasi-host`** | `repository://github.com/awesome-os/wasi-host@main` | `wasi-host` | `2.6 KB` WASI sandbox + 7-Tuple hook executor |
| **`holo-node`** | `repository://github.com/awesome-os/node@main` | `ghost-node` | Shared-V8 (`dup_v8 = 0 B`) Node.js projection |
| **`holo-deno`** | `repository://github.com/awesome-os/lo@main` | — | Deno / URL-import V8 projection |
| **`holo-py`** | `repository://github.com/awesome-os/uv@main` | `ghost-py` | `libuvpy` + debloated Python LLM wheel projection |
| **`holo-go`** | `repository://github.com/awesome-os/go-lang@main` | — | `go-lang` + `b8g-gocacheprog` + 6-daemon `multicall` |
| **`holo-dart`** | `repository://github.com/awesome-os/dart@main` | — | Dart AOT & WasmGC `v11` projection |
| **`holo-rust`** | `repository://github.com/awesome-os/cargo@main` | `ghost-rust` | `awesome-os/cargo` (`libcargo`) `v11` crate projection |
| **`holo-cpp`** | `repository://github.com/awesome-os/ghost-cpp@main` | `ghost-cpp` | Native C/C++ + Zig cross-compile `v11` projection |
| **`holo-jvm`** | `repository://github.com/awesome-os/sectium-jvm@main` | `ghost-jvm` | `sectium-jvm` Kotlin + WASI + Tier-2 AOT projection |
