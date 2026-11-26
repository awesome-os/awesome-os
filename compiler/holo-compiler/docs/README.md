# Holo Compiler & Package Manager Documentation (`docs/`)

> **Central user documentation for the Awesome-OS Holo Stack: `repository://` (immutable `v11` source of truth) × `project://` (0-byte holographic worktrees & installations) × `B8G_ABI_MAGIC_V3` (`0x33564742`).**

---

## Guides

1. **[Quickstart](./quickstart.md)** — Install the Holo Stack, configure `HOLO_CAS_DIR`, and run your first `repository://` + `project://` workflow.
2. **[`repository://` & `project://` Protocol Guide](./repository-and-project-uris.md)** — Exact URI grammar, stock `git` compatibility (`git-remote-repository`), and `holo-project` ephemeral vs. persistent projections.
3. **[`v11` Universal Object Store & `holo-ffi`](./v11-cas-and-holo-ffi.md)** — How `v11/files/00..ff/<sha512>` unifies Git blobs/trees, packages, OCI layers, Releases, and native `.dll`/`.so`/`.dylib`/`.wasm` FFI loading.
4. **[`holo-*` Projections Reference](./projections-reference.md)** — All 12 canonical runtime projections (`holo-compiler`, `holo-pm`, `holo-ffi`, `holo-wasi-host`, `holo-node`, `holo-deno`, `holo-py`, `holo-go`, `holo-dart`, `holo-rust`, `holo-cpp`, `holo-jvm`) and legacy `ghost-*` aliases.
5. **[Selfhost Toolchain Matrix (`toolchains/selfhost-matrix.json`)](../toolchains/selfhost-matrix.json)** — Canonical `v11` CAS hardlink matrix for `nativeCore` (`libholo_codegen`, `stealify-ssa`, `sub-tu-splicer`, `holo-project`, `git-remote-repository`, `holo-jq`) and `projectedToolchains` (`llvm-zig`, `cargo-rust`, `go-lang`, `dart`, `node-v8`, `uv-py`, `coreutils`, `wasi-host`).

---

## Old Command → Unified Holo Command

| Old Command | Unified Holo Command |
| :--- | :--- |
| `git clone https://github.com/awesome-os/<repo>.git` | `git clone repository://github.com/awesome-os/<repo>@main` |
| `npm install` / `pnpm install` / `b8g-pm install` | `holo-pm resolve repository://github.com/awesome-os/<repo>@main` |
| `b8g-build <target>` / `zig cc ...` | `holo-compiler build <target>` |
| `node <entry>` / `ghost-node <entry>` | `holo-project run project://holo-node/<entry>` |
| `python <entry>` / `holo-py <entry>` | `holo-project run project://holo-py/<entry>` |
| `go build ./...` | `holo-project run project://holo-go/go -- build ./...` |
| `cargo build` / `ghost-rust build` | `holo-project run project://holo-rust/cargo -- build` |
| `dart compile exe <entry>` | `holo-project run project://holo-dart/dart -- compile exe <entry>` |
| `wasmtime <module.wasm>` | `holo-project run project://holo-wasi-host/wasi-host -- <module.wasm>` |

---

## Bootstrap Provider

- **[`awesome-os/holo-pm`](https://github.com/awesome-os/holo-pm)** — Unified `repository://` + `v11` CAS package manager and bootstrap provider (`repository://github.com/awesome-os/holo-pm@main`) referencing all Holo core components and upstream hard-forks.
