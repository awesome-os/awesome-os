# Sovereign LLM, Embeddings, Unsloth LoRA & Colab Mesh Stack

> **Audience:** Both **End Users** (Hyperscaler Desktop, Sectium Shell, VS Code Workbench) and **Developers** (OpenAI/Ollama API clients, LoRA fine-tuning pipelines, GGUF/llama.cpp tooling, and `window.ai` web apps).  
> **Primary Package:** [`intersections/b8g-llm-studio/`](../intersections/b8g-llm-studio/) (`.\bin\b8g-llm-studio`, default port `127.0.0.1:7497`)  
> **Related Guide:** [`PERSISTENT-HOST-AND-SECTIUM-SHELL-GUIDE.md`](./PERSISTENT-HOST-AND-SECTIUM-SHELL-GUIDE.md)

---

## 1. For End Users — Quick Start (Zero CLI Required)

You can open **Sovereign LLM & LoRA Studio** from any of the three unified Awesome-OS surfaces:

1. **Hyperscaler Desktop (`.\bin\b8g-vm.ps1 ui`):** Click **🧠 LLM & LoRA Studio** on the Desktop, Start Menu, Taskbar, or Left Sidebar.
2. **Sectium Default Shell (`.\bin\sectium-browser`):** Click **🧠 LLM & LoRA Studio** in the Left Sidebar or Bottom Quick Dock.
3. **VS Code / Antigravity Extension:** Open the **Sectium Browser** sidebar (or `Ctrl+Shift+P` → `Sectium: Open UI-in-UI Workbench Tab`) and click **🧠 LLM Studio**.

### What You Can Do in the 5-Tab Studio UI
- **Chat & Models:** Chat with local GGUF / Ollama / llama.cpp models over live SSE streaming, or inspect model metadata.
- **Hub & GGUF:** Search Hugging Face GGUF models, inspect local `.gguf` binary headers (v2/v3 metadata & quantization) without loading gigabytes into RAM, and parse Ollama `Modelfile`s.
- **LoRA & Embeddings:** Run real InfoNCE contrastive LoRA training, slice **Matryoshka** embeddings (`32`–`1024` dims), estimate NF4 VRAM budgets, and configure **Jina-v3** dual-adapter modes (`direct-task-finetune` or `merge-then-stack` $W' = W + \frac{\alpha}{r}BA$).
- **Unsloth Recipes:** Pick from **7 production recipes** (QLoRA Dynamic 2.0, GRPO, DPO, Vision, Long-Context, etc.), validate your dataset against **5 schema validators**, and export runnable scripts.
- **Colab GPU Mesh:** Register a free/Pro Google Colab T4/L4/A100/TPU runtime into your local **`CloudDeviceMesh`** and export a ready-to-run nbformat v4.5 `.ipynb` notebook.

---

## 2. Architecture Overview

```text
  [ Any OpenAI / Ollama Client ]      [ Hyperscaler / Sectium / VS Code UI ]
                │                                       │
                └──────────────► http://127.0.0.1:7497 ◄┘
                                 (b8g-llm-studio/server.mts)
                                           │
        ┌──────────────────┬───────────────┼───────────────┬──────────────────┐
        ▼                  ▼               ▼               ▼                  ▼
  hub-gguf.mts      lora-engine.mts  unsloth-recipes  colab-node-bridge  global-ai-shim
 (GGUF v2/v3,      (InfoNCE LoRA,     (7 recipes +     (CloudDeviceMesh   (Sovereign
  Modelfile,        Matryoshka dims,   5 dataset        + nbformat v4.5    window.ai /
  llama-server)     NF4 VRAM calc)     validators)      .ipynb export)     0 Google DLLs)
```

---

## 3. For Developers — HTTP & Streaming API Reference

`b8g-llm-studio` exposes both **OpenAI-compatible** (`/v1/*`) and **Ollama-compatible** (`/api/*`) endpoints on `http://127.0.0.1:7497`, so any existing SDK (`openai`, `langchain`, `b8g-agent-host`, `curl`) works out of the box.

### 3.1 OpenAI-Compatible Endpoints
| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/v1/models` | Lists available local GGUF, CAS, and sovereign models. |
| `POST` | `/v1/chat/completions` | Chat completions with `stream: true` (SSE `data: {...}`) or non-streaming JSON. |
| `POST` | `/v1/embeddings` | Generates embeddings with optional Matryoshka `dimensions` slicing and task adapter selection. |

### 3.2 Ollama-Compatible Endpoints
| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/tags` | Lists installed local models in Ollama format. |
| `POST` | `/api/chat` | Multi-turn chat completion. |
| `POST` | `/api/generate` | Single-prompt completion. |
| `POST` | `/api/embeddings` | Embedding vector generation. |

### 3.3 Studio Control, LoRA, Unsloth & Colab Endpoints
| Method | Endpoint | Source Module |
| :--- | :--- | :--- |
| `GET` | `/` | [`ui-html.mts`](../intersections/b8g-llm-studio/ui-html.mts) — 5-tab dark-glass UI (`B8G022` tagged `html\`...\``). |
| `POST` | `/api/studio/lora/train` | [`lora-engine.mts`](../intersections/b8g-llm-studio/lora-engine.mts) — Runs InfoNCE LoRA step & updates adapter weights. |
| `POST` | `/api/studio/lora/vram` | [`lora-engine.mts`](../intersections/b8g-llm-studio/lora-engine.mts) — Estimates NF4 / FP16 VRAM footprint. |
| `GET` | `/api/studio/recipes` | [`unsloth-recipes.mts`](../intersections/b8g-llm-studio/unsloth-recipes.mts) — Lists all 7 Unsloth fine-tuning recipes. |
| `POST` | `/api/studio/colab/register` | [`colab-node-bridge.mts`](../intersections/b8g-llm-studio/colab-node-bridge.mts) — Registers a Colab GPU/TPU node in `CloudDeviceMesh` and returns an `.ipynb`. |

---

## 4. Sovereign `window.ai` & Autarkic Browser AI Layer

Instead of relying on closed Google Chrome AI binaries, **Sectium** and **`b8g-electron`** inject the open-source **`SovereignAiHostBridge`** ([`intersections/b8g-electron/global-ai-shim.mts`](../intersections/b8g-electron/global-ai-shim.mts)):

- Zero closed Google DLLs (`closedGoogleDlls: 0`).
- Routes browser `window.ai` / `globalThis.ai` calls directly to your local **`b8g-llm-studio`** (`:7497`) or **`b8g-agent-host`** (`:7498`).
- Pairs with **`B8G Xenon 1B`** (`sections/atlas-kv`) and **`b8g-infer`** (Inference Manager) for local KV-cached inference observability.

---

## 5. Verification & Tests

Run the full 40-test LLM Studio suite anytime via the shimmed Node runner:

```powershell
.\bin\node.ps1 --test intersections/b8g-llm-studio/lora-engine.test.mts intersections/b8g-llm-studio/hub-gguf.test.mts intersections/b8g-llm-studio/unsloth-recipes.test.mts intersections/b8g-llm-studio/colab-node-bridge.test.mts intersections/b8g-llm-studio/server.test.mts
```
