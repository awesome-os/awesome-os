# Awesome-OS Holo `v11` Global Auditable Registry

`awesome-os/holo-v11` is the canonical **Global Auditable Holo `v11` Registry** (`B8G_ABI_MAGIC_V3 = 0x33564742`) for the Awesome-OS ecosystem.

Every `repository://` and `project://` URI resolves to an immutable SHA-512 digest recorded in [`index/holo-compiler-lockfile.json`](index/holo-compiler-lockfile.json) and indexed in [`index/cas-v11-global-manifest.json`](index/cas-v11-global-manifest.json). Because the entire global CAS index lives directly in Git, researchers, CI pipelines, and security auditors can inspect, diff, and reproduce any historical state using standard Git primitives:

- `git log -- index/holo-compiler-lockfile.json` — chronological audit trail of every release digest transition
- `git diff <revA>..<revB> -- index/holo-compiler-lockfile.json` — exact SHA-512 supply-chain diff between two points in time
- `git checkout <commit>` — deterministic point-in-time registry reproduction

---

## Repository Structure

| Path | Purpose |
| :--- | :--- |
| [`index/holo-compiler-lockfile.json`](index/holo-compiler-lockfile.json) | Canonical `v11` SHA-512 lockfile mapping `repository://` and `project://` assets to `v11/files/00..ff/<sha512>` CAS paths |
| [`index/cas-v11-global-manifest.json`](index/cas-v11-global-manifest.json) | Global `v11` CAS manifest with aggregate metrics, target metadata, and executable flags |
| [`pins/holo-overrides.mts`](pins/holo-overrides.mts) | Statically-linked TypeScript entrypoint uniting `rust`, `go`, and `npm` ecosystem overrides with the `v11` lockfile |
| [`bootstrap/selfhost-fixedpoint.mts`](bootstrap/selfhost-fixedpoint.mts) | Stage 0 → Stage 1 → Stage 2 `CAS Q-Self` cryptographic fixed-point verifier (`sha512(Stage 1) === sha512(Stage 2)`) |
| [`scripts/warm-global-cas.mts`](scripts/warm-global-cas.mts) | 12-way parallel stream-hasher that refreshes `dist/cas-v11-global-manifest.json` and `dist/holo-compiler-lockfile.json` from `awesome-os/*` releases |
| [`.github/workflows/sync-holo-v11-registry.yml`](.github/workflows/sync-holo-v11-registry.yml) | Scheduled 6-hourly (`0 */6 * * *`) + manual sync workflow committing to `main` only when `index/holo-compiler-lockfile.json` changes (zero empty commits, zero redundant text releases) |

---

## Verification

Run the zero-dependency Node 22+ test suite and fixed-point proof directly from TypeScript source:

```bash
node --test pins/holo-overrides.test.mts bootstrap/selfhost-fixedpoint.test.mts
node pins/holo-overrides.mts
node bootstrap/selfhost-fixedpoint.mts
```

---

## License

[MIT](LICENSE)
