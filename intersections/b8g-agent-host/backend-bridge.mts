/**
 * @file backend-bridge.mts
 * @description Pluggable Agent Execution Bridge for B8G Persistent Agent Host.
 * Supports:
 *   1. `antigravity-sdk` — Official `google-antigravity` Python SDK (`Agent(LocalAgentConfig(...))`)
 *      streaming thoughts, tool calls, and tokens cleanly into the persistent session log.
 *   2. `b8g-llm-studio` — Local sovereign OpenAI-compatible SSE stream (`http://127.0.0.1:7497/v1/chat/completions`).
 *   3. `echo-local` — Deterministic local echo backend for zero-dependency health & unit tests.
 */

import { spawn } from 'node:child_process';
import type { AgentBackendKind, AgentSessionRecord, AgentSessionStore } from './session-store.mts';

export interface BackendCapabilities {
  readonly antigravitySdkReady: boolean;
  readonly llmStudioUrl: string;
  readonly llmStudioOnline: boolean;
}

const PYTHON_ANTIGRAVITY_RUNNER = `
import asyncio, json, os, sys
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

async def main():
    prompt = os.environ.get("B8G_AGENT_PROMPT", "")
    project_root = os.environ.get("B8G_AGENT_PROJECT", os.getcwd())
    os.chdir(project_root)
    cfg = LocalAgentConfig(
        system_instructions=f"You are the persistent Awesome-OS Antigravity Host agent working in {project_root}.",
        capabilities=CapabilitiesConfig(),
    )
    async with Agent(cfg) as agent:
        response = await agent.chat(prompt)
        async def pump_thoughts():
            if hasattr(response, "thoughts"):
                async for t in response.thoughts:
                    print(json.dumps({"type": "thought", "text": str(t)}), flush=True)
        async def pump_tools():
            if hasattr(response, "tool_calls"):
                async for c in response.tool_calls:
                    print(json.dumps({"type": "tool_call", "tool": getattr(c, "name", "tool"), "args": getattr(c, "args", {})}), flush=True)
        async def pump_tokens():
            async for tok in response:
                print(json.dumps({"type": "token", "text": str(tok)}), flush=True)
        await asyncio.gather(pump_thoughts(), pump_tools(), pump_tokens())

if __name__ == "__main__":
    asyncio.run(main())
`.trim();

export async function probeBackends(llmStudioUrl = 'http://127.0.0.1:7497'): Promise<BackendCapabilities> {
  let llmStudioOnline = false;
  try {
    const res = await fetch(`${llmStudioUrl}/v1/models`, { signal: AbortSignal.timeout(800) });
    llmStudioOnline = res.ok;
  } catch {
    llmStudioOnline = false;
  }

  const antigravitySdkReady = await new Promise<boolean>((resolve) => {
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(pyCmd, ['-c', 'import google.antigravity; print("OK")'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && out.includes('OK')));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(false);
    }, 1500);
  });

  return { antigravitySdkReady, llmStudioUrl, llmStudioOnline };
}

export async function dispatchAgentTurn(
  store: AgentSessionStore,
  session: AgentSessionRecord,
  prompt: string,
  options: { llmStudioUrl?: string; backendOverride?: AgentBackendKind } = {},
): Promise<void> {
  const backend = options.backendOverride || session.backend;
  const llmStudioUrl = options.llmStudioUrl || 'http://127.0.0.1:7497';

  store.setStatus(session.id, 'streaming');
  store.appendEvent(session.id, 'user', { text: prompt, meta: { backend } });

  try {
    if (backend === 'echo-local') {
      store.appendEvent(session.id, 'thought', { text: `Processing turn in ${session.projectRoot}` });
      const reply = `[b8g-agent-host online] Received: ${prompt}`;
      for (const word of reply.split(' ')) {
        store.appendEvent(session.id, 'token', { text: `${word} ` });
      }
      store.appendEvent(session.id, 'assistant_done', { text: reply, meta: { backend } });
      return;
    }

    if (backend === 'b8g-llm-studio') {
      await runLlmStudioTurn(store, session, prompt, llmStudioUrl);
      return;
    }

    // Default: 'antigravity-sdk' with graceful fallback to local LLM Studio if SDK is not installed yet.
    const ok = await runAntigravitySdkTurn(store, session, prompt);
    if (!ok) {
      store.appendEvent(session.id, 'system', {
        text: 'Official `google-antigravity` Python SDK not detected in active Python env (`pip install google-antigravity`). Attempting local Sovereign LLM Studio (:7497) fallback...',
      });
      await runLlmStudioTurn(store, session, prompt, llmStudioUrl);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.appendEvent(session.id, 'error', { text: msg });
  } finally {
    store.setStatus(session.id, 'idle');
  }
}

async function runAntigravitySdkTurn(
  store: AgentSessionStore,
  session: AgentSessionRecord,
  prompt: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(pyCmd, ['-c', PYTHON_ANTIGRAVITY_RUNNER], {
      cwd: session.projectRoot,
      env: {
        ...process.env,
        B8G_AGENT_PROMPT: prompt,
        B8G_AGENT_PROJECT: session.projectRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let accText = '';
    let stderrText = '';
    let buf = '';

    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; text?: string; tool?: string; args?: Record<string, unknown> };
          if (ev.type === 'thought' && ev.text) {
            store.appendEvent(session.id, 'thought', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            store.appendEvent(session.id, 'tool_call', { tool: ev.tool || 'tool', args: ev.args || {} });
          } else if (ev.type === 'token' && ev.text) {
            accText += ev.text;
            store.appendEvent(session.id, 'token', { text: ev.text });
          }
        } catch {
          accText += line;
          store.appendEvent(session.id, 'token', { text: line });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrText += String(chunk);
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code === 0) {
        store.appendEvent(session.id, 'assistant_done', {
          text: accText,
          meta: { backend: 'antigravity-sdk' },
        });
        resolve(true);
        return;
      }
      if (stderrText.includes('ModuleNotFoundError') || stderrText.includes('No module named')) {
        resolve(false);
        return;
      }
      store.appendEvent(session.id, 'error', {
        text: `Antigravity SDK exited (${code}): ${stderrText.trim() || 'unknown error'}`,
      });
      resolve(true);
    });
  });
}

async function runLlmStudioTurn(
  store: AgentSessionStore,
  session: AgentSessionRecord,
  prompt: string,
  llmStudioUrl: string,
): Promise<void> {
  const history = store
    .getEvents(session.id)
    .filter((e) => e.type === 'user' || e.type === 'assistant_done')
    .slice(-12)
    .map((e) => ({
      role: e.type === 'user' ? 'user' : 'assistant',
      content: e.text || '',
    }));

  if (history.length === 0 || history[history.length - 1]?.content !== prompt) {
    history.push({ role: 'user', content: prompt });
  }

  let res: Response;
  try {
    res = await fetch(`${llmStudioUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: session.model && session.model !== 'auto' ? session.model : 'b8g-sovereign-local',
        messages: history,
        stream: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    const offlineReply =
      `Persistent Agent Host is ONLINE (PID ${process.pid}) and saved your message to ${session.id}, ` +
      `but neither \`google-antigravity\` SDK nor local LLM Studio (${llmStudioUrl}) is active yet. ` +
      `Start LLM Studio (\`.\\bin\\b8g-llm-studio\`) or install \`pip install google-antigravity\` to stream live completions.`;
    store.appendEvent(session.id, 'token', { text: offlineReply });
    store.appendEvent(session.id, 'assistant_done', { text: offlineReply, meta: { backend: 'offline-notice' } });
    return;
  }

  if (!res.ok || !res.body) {
    throw new Error(`LLM Studio returned HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    const frames = sseBuf.split(/\r?\n\r?\n/);
    sseBuf = frames.pop() || '';
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
          };
          const tok = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
          if (tok) {
            fullText += tok;
            store.appendEvent(session.id, 'token', { text: tok });
          }
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }
  }

  store.appendEvent(session.id, 'assistant_done', {
    text: fullText,
    meta: { backend: 'b8g-llm-studio' },
  });
}
