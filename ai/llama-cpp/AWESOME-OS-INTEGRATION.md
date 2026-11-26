# Awesome-OS Integration for llama.cpp (`awesome-os/llama.cpp`)

- **Unified `v11` CAS Weights & Shards:** Shares GGUF files via zero-copy SHA-512 hardlinks (`cas/v11/files/<aa>/<sha512>`) with `awesome-os/colibri` and `awesome-os/vllm`.
- **Global Max Dependency Pins (`awesome-os/v11-max-lock.json`):** Aligns `vulkan-headers 1.4.369`, `vulkan-loader 1.4.369`, `glslang 16.2.0`, `curl 8.23.0`, `openssl 4.1.0`, `zstd 1.6.0`, `mimalloc 3.7.1`, `openblas 0.3.31`, `cmake 4.2.3`, and `ninja 1.13.2` with `awesome-os/t2linux-baseline`.
- **Workspace Integration:** Pre-wired inside `workspaces://awesome-os/ai-colibri` and selectable in `https://awesome-os.com/install/`.
