# `browser/firefox` — Sovereign Firefox on Holo `v11` CAS

> **Firefox (Gecko / Stylo / WebRender / Fission / RLBox)** — Zero-telemetry enterprise build & native C11 launcher sharing **`24/24`** deduplicated Holo `v11` CAS libraries (`B8G_ABI_MAGIC_V3 = 0x33564742`).

## Files

| File | Role |
| :--- | :--- |
| [`mozconfig.holo-v11`](mozconfig.holo-v11) | Mozilla build configuration binding shared Holo `v11` system libraries (`--with-system-*`), `--enable-rlbox-wasm-sandboxing`, and stripping telemetry, crashreporter, and updater |
| [`firefox-v11-profile.json`](firefox-v11-profile.json) | Structured `24/24` shared `v11` library manifest, enterprise zero-telemetry `policies.json` block, and Gecko / Stylo / WebRender / Fission / RLBox flags |
| [`firefox_launcher.c`](firefox_launcher.c) | Thin native C11 launcher (`B8G_ABI_MAGIC_V3 = 0x33564742`) validating `v11/files/<aa>/<sha512>` CAS paths with `--self-test`, `--dry-run`, and `--version` |
| [`hydrate.mts`](hydrate.mts) | Zero-dep erasable-TS Holo `v11` hydrator, Keep-Last-5 pin resolver, and `24/24` dependency verifier |
| [`cli.mts`](cli.mts) | CLI supporting `--dry-run`, `--version`, `--mozconfig`, and `--verify-deps` |
| [`index.mts`](index.mts) | Public TypeScript module exports |
| [`firefox-cas.test.mts`](firefox-cas.test.mts) | Unit & C11 compiler verification suite |

## Verification

```powershell
# Run TypeScript & C11 native launcher tests
.\bin\node.ps1 --test browser/firefox/firefox-cas.test.mts

# Inspect build mozconfig & verify 24/24 shared v11 dependencies
.\bin\node.ps1 browser/firefox/cli.mts --mozconfig
.\bin\node.ps1 browser/firefox/cli.mts --verify-deps
.\bin\node.ps1 browser/firefox/cli.mts --dry-run
```
