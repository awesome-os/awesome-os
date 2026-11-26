# Awesome-OS Integration for vLLM (`awesome-os/vllm`)

- **Unified `v11` CAS Shared Layer:** Deduplicates native libraries (`openssl 4.1.0`, `zstd 1.6.0`, `protobuf 7.36.1`, `ffmpeg 9.1`, `libuv 1.51.0`, `ninja 1.13.2`, `cmake 4.2.3`) and model weights across `vllm`, `colibri`, and `llama.cpp`.
- **Max-Pin Python Floors (`awesome-os/v11-max-lock.json`):** Aligns `transformers`, `tokenizers`, `safetensors`, `fastapi`, `starlette >= 1.0.1`, `pydantic >= 2.12.0`, `openai >= 2.25.0`, `anthropic >= 0.71.0`, and `mcp >= 2.2.0` via `awesome-os/uv`.
- **Workspace Integration:** Pre-wired inside `workspaces://awesome-os/ai-colibri` and selectable in `https://awesome-os.com/install/`.
