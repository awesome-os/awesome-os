# `repository://` & `project://` Protocol Guide

Awesome-OS splits distribution and execution into **two orthogonal URI schemes** backed by one `v11` Universal Object Store:

| Scheme | Role | Lifecycle |
| :--- | :--- | :--- |
| **`repository://`** | Immutable **Source of Truth** (`v11` CAS blobs, Merkle trees, commits, binaries, OCI layers, `.b8p` models) | Content-addressed, read-only (`0444`/`0555`), deduplicated |
| **`project://`** | **Virtual Worktree & Installation** (0-byte hardlink projection into a runtime) | `mode=ephemeral` (auto-purged) or `mode=persistent` (installed app/workspace) |

---

## 1. `repository://` Grammar

```text
repository://<host>/<org>/<repo>@<commit-sha|tag|branch>[#<subpath>][?hook=<name>&target=<5os>]
```

- **Zero `package.json` required:** Works identically for C/C++, Rust, Go, Dart, Zig, Python, TypeScript, WASI, and `.b8p` models.
- **Security invariants:** Strictly rejects `..` path traversal and `127.0.0.1` / `localhost` loopback HTTP (`B8G016`).
- **Hermetic Git hooks (`holo-forge.json`):** Gated by 7-Tuple `EffectBit` (`FS_READ | CAS_WRITE | WASI_EXEC`, zero `NET_REMOTE`) inside `holo-wasi-host-b8g.wasm` (`2.6 KB`).
- **1:1 Legacy Git compatibility:** Vanilla `git` clients can always use `https://github.com/awesome-os/<repo>.git` or `https://git.awesome-os.com/awesome-os/<repo>.git`.

---

## 2. `project://` Grammar

```text
project://<runtime>/<entry>[?from=repository://...&mode=ephemeral|persistent&target=<5os>]
```

- `<runtime>` accepts shorthand (`node`, `go`, `py`, `dart`, `rust`, `cpp`, `jvm`, `deno`, `ffi`), canonical `holo-*` names (`holo-go`, `holo-node`), or legacy aliases (`ghost-py`, `ghostFFI`).
- `holo-project` hardlinks the requested `v11` blobs in **`< 1 ms`**, executes the runtime entrypoint, and purges ephemeral directories cleanly on exit.
