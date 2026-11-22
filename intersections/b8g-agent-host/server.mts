/**
 * @file server.mts
 * @description Persistent HTTP + SSE Multi-Client Agent Host Daemon (`127.0.0.1:7498`).
 * Survives VS Code reloads, browser restarts, and UI switches (Hyperscaler Desktop,
 * Sectium Browser Extension, CLI) with automatic `since=seq` event replay.
 */

import http from 'node:http';
import path from 'node:path';
import { AgentSessionStore, type AgentBackendKind } from './session-store.mts';
import { dispatchAgentTurn, probeBackends } from './backend-bridge.mts';
import { renderAgentHostHtml } from './ui-html.mts';
import { renderSectiumShellHtml } from './sectium-shell-html.mts';

export interface AgentHostServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  defaultProjectRoot?: string;
  llmStudioUrl?: string;
}

export interface AgentHostHandle {
  readonly port: number;
  readonly url: string;
  readonly store: AgentSessionStore;
  close(): Promise<void>;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export async function startAgentHostServer(opts: AgentHostServerOptions = {}): Promise<AgentHostHandle> {
  const host = opts.host || '127.0.0.1';
  const requestedPort = opts.port ?? 7498;
  const defaultProjectRoot = opts.defaultProjectRoot || process.cwd();
  const dataDir = opts.dataDir || path.join(defaultProjectRoot, '.b8g-cas', 'agent-host');
  const llmStudioUrl = opts.llmStudioUrl || 'http://127.0.0.1:7497';

  const store = new AgentSessionStore(dataDir);
  store.ensureDefaultSession(defaultProjectRoot);
  const startedAt = Date.now();
  let actualPort = requestedPort;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }

      const urlObj = new URL(req.url || '/', `http://${host}:${actualPort}`);
      const pathname = urlObj.pathname;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const htmlDoc = renderAgentHostHtml({ port: actualPort, defaultProjectRoot });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(htmlDoc);
        return;
      }

      if (req.method === 'GET' && pathname === '/shell') {
        const htmlDoc = renderSectiumShellHtml({ port: actualPort, defaultProjectRoot });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(htmlDoc);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        const backends = await probeBackends(llmStudioUrl);
        sendJson(res, 200, {
          ok: true,
          service: 'b8g-agent-host',
          pid: process.pid,
          port: actualPort,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          sessions: store.listSessions().length,
          activeClients: store.activeSubscriberCount(),
          dataDir: store.dataDir,
          backends,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/sessions') {
        sendJson(res, 200, { sessions: store.listSessions() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/sessions') {
        const body = await readJsonBody(req);
        const session = store.createSession({
          title: typeof body.title === 'string' ? body.title : undefined,
          projectRoot: typeof body.projectRoot === 'string' ? body.projectRoot : defaultProjectRoot,
          backend: typeof body.backend === 'string' ? (body.backend as AgentBackendKind) : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
        });
        sendJson(res, 201, { session });
        return;
      }

      const matchEvents = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (req.method === 'GET' && matchEvents) {
        const sid = decodeURIComponent(matchEvents[1]!);
        const session = store.getSession(sid);
        if (!session) {
          sendJson(res, 404, { error: `Session not found: ${sid}` });
          return;
        }
        const since = Number(urlObj.searchParams.get('since') || '0') || 0;
        sendJson(res, 200, { session, events: store.getEvents(sid, since) });
        return;
      }

      const matchStream = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
      if (req.method === 'GET' && matchStream) {
        const sid = decodeURIComponent(matchStream[1]!);
        const session = store.getSession(sid);
        if (!session) {
          sendJson(res, 404, { error: `Session not found: ${sid}` });
          return;
        }
        const since = Number(urlObj.searchParams.get('since') || '0') || 0;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        res.write(': connected\n\n');

        const unsubscribe = store.subscribe(sid, since, (ev) => {
          res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
        });
        const hb = setInterval(() => {
          try {
            res.write(': heartbeat\n\n');
          } catch {
            // closed
          }
        }, 15_000);
        req.on('close', () => {
          clearInterval(hb);
          unsubscribe();
        });
        return;
      }

      const matchMsg = pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (req.method === 'POST' && matchMsg) {
        const sid = decodeURIComponent(matchMsg[1]!);
        const session = store.getSession(sid);
        if (!session) {
          sendJson(res, 404, { error: `Session not found: ${sid}` });
          return;
        }
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) {
          sendJson(res, 400, { error: 'Missing non-empty text' });
          return;
        }
        const backendOverride =
          typeof body.backend === 'string' ? (body.backend as AgentBackendKind) : undefined;
        // Fire-and-forget async stream so HTTP returns immediately while all SSE UIs stream live.
        void dispatchAgentTurn(store, session, text, { llmStudioUrl, backendOverride });
        sendJson(res, 202, { accepted: true, sessionId: sid });
        return;
      }

      const matchSession = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'DELETE' && matchSession) {
        const sid = decodeURIComponent(matchSession[1]!);
        const removed = store.deleteSession(sid);
        sendJson(res, removed ? 200 : 404, { deleted: removed, sessionId: sid });
        return;
      }

      sendJson(res, 404, { error: 'Not found', pathname });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') actualPort = addr.port;
      resolve();
    });
  });

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
