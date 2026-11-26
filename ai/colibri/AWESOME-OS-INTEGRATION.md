# Awesome-OS Integration for Colibri (`awesome-os/colibri`)

This fork aligns **Colibri** (`JustVugg/colibri`) directly with the Awesome-OS 4-layer stack:

1. **Zero-Copy `v11` CAS Expert & GGUF Sharding (`awesome-os/colibri-v11-bridge.mts`):**
   - Stores GGUF weights and Colibri MoE expert shards under `cas/v11/files/<aa>/<sha512>` and projects zero-copy hardlinks into `colibri`, `llama.cpp`, and `vllm` so multi-engine setups never duplicate 20–500 GB model files.
2. **Hermetic `holo-compiler` (`zig cc`) Cross-Compilation:**
   - Compiles `c/colibri.c` and Vulkan/CPU backends natively on Windows 11, Linux x64/ARM64, and macOS ARM64 with zero MSYS2/WSL toolchain drift.
3. **Awesome-OS Models (LumiBERT 2.8ms):**
   - Registers `lumibert-2.8ms` (ultra-fast 2.8 ms error auto-repair & semantic router) alongside Colibri's frontier MoE catalog (`qwen36-35b`, `deepseek-v4-flash`, `glm-5.2`, `kimi-k3`).
4. **Host-Pipe IPC (`B8G016`) + `workspaces://awesome-os/ai-colibri`:**
   - Exposes `\\.\pipe\b8g-colibri` (Windows) / `/run/b8g/colibri.sock` (POSIX) for local OS agents alongside OpenAI/Anthropic HTTP gateways and pre-wires `coli mcp` inside `workspaces://awesome-os/ai-colibri`.
