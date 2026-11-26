# `v11` Universal Object Store & `holo-ffi`

## 1. `v11` in Git Terms

The unified `v11` store (`HOLO_CAS_DIR/v11`) is a **SHA-512 Universal Git Object Store** whose blobs are stored raw (zero zlib wrapper) so the OS can hardlink (`os.Link`) and `mmap` them directly:

| Git Concept | `v11` Equivalent |
| :--- | :--- |
| `.git/objects/xx/<sha1>` (`blob`) | `v11/files/<sha512[:2]>/<sha512>` (`-exec` = mode `100755`) |
| `.git/objects/xx/<sha1>` (`tree`) | Sorted `GitForgeTreeManifest` JSON stored in `v11/files/<xx>/<treeSha512>` |
| `.git/objects/xx/<sha1>` (`commit`) | `holo-compiler-lockfile.json` / `RollingReleaseManifest.json` binding `sourceTreeSha512` + `artifactTreeSha512` |
| `.git/index` | `v11/index.db` (SQLite WAL) + `v11/go-actions/` (`b8g-gocacheprog`) |
| `git worktree` | 0-byte hardlink projection via `project://` (`0.37 ms`) |

---

## 2. `holo-ffi` (Zero-Hash Native & WASM FFI)

`holo-ffi` upgrades `ghostFFI` to load `.dll` / `.so` / `.dylib` / `.wasm` directly out of `v11`:

1. Resolves `repository://github.com/awesome-os/<repo>@<tag>` from `holo-compiler-lockfile.json` (no manual hash copy-pasting).
2. Projects a **0-byte hardlink** into `v11/links/<sha512[:16]>-<name>.{dll,so,dylib,wasm}` so Windows `LoadLibraryW` and macOS `dlopen` see the expected file extension.
3. Optionally verifies `B8G_ABI_MAGIC_V3` (`0x33564742`) via `abiMagicSymbol` before any call crosses the FFI boundary.
4. Executes `.wasm` modules directly via `WebAssembly.instantiate` with zero native addon required.

---

## 3. `*-package` Is Pure Metadata (2-Lane Semantic Splitting)

Awesome-OS never assumes an npm package *is* JavaScript, a Cargo crate *is* Rust, or a wheel *is* Python. Manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pubspec.yaml`) are treated strictly as **metadata**, while `holo-pm` (`src/semantic-lane-splitter.mts`) splits every file by its true artifact type over ONE `v11` CAS:

- **Text / Source Lane (`repository/<lang>/...`):** 0-byte hardlinks for instant grep/BM25/LSP indexing, auto-routing cross-language bindings (`.ts` inside a `cargo` crate → `repository/npm/cargo/<pkg>/`, `.py` inside PyO3 → `repository/pypi/cargo/<pkg>/`).
- **Binary Lane (`assets/<target>-<abi>/<pkg>/`):** Separates `.node` (`napi`), `.pyd` (`abi3`/`cpython`), `.dll`/`.so`/`.dylib` (`b8g-v3`), and `.wasm` (`wasi`) with **prebuilt-first `v11` lookup** — eliminating `node-gyp` / `pip` / native rebuilds whenever an ABI-compatible blob already exists.
