/**
 * @file session-store.mts
 * @description Persistent, reload-proof, multi-client Agent Session Store for B8G Agent Host.
 * Every session and its append-only event stream are persisted under `.b8g-cas/agent-host/`
 * so reloading VS Code, switching UIs (Hyperscaler Desktop, Sectium Browser, CLI), or even
 * restarting the daemon never loses conversation state or active stream history.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type AgentBackendKind = 'antigravity-sdk' | 'b8g-llm-studio' | 'echo-local';

export type AgentEventType =
  | 'system'
  | 'user'
  | 'thought'
  | 'token'
  | 'tool_call'
  | 'assistant_done'
  | 'error'
  | 'heartbeat';

export interface AgentStreamEvent {
  readonly seq: number;
  readonly ts: string;
  readonly sessionId: string;
  readonly type: AgentEventType;
  readonly text?: string;
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

export interface AgentSessionRecord {
  readonly id: string;
  title: string;
  projectRoot: string;
  backend: AgentBackendKind;
  model: string;
  status: 'idle' | 'streaming';
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
}

export type SessionSubscriber = (ev: AgentStreamEvent) => void;

export interface CreateSessionInput {
  title?: string;
  projectRoot?: string;
  backend?: AgentBackendKind;
  model?: string;
}

export class AgentSessionStore {
  readonly dataDir: string;
  readonly sessionsFile: string;
  readonly logsDir: string;
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly events = new Map<string, AgentStreamEvent[]>();
  private readonly subscribers = new Map<string, Set<SessionSubscriber>>();

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.sessionsFile = path.join(this.dataDir, 'sessions.json');
    this.logsDir = path.join(this.dataDir, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.sessionsFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8')) as AgentSessionRecord[];
      if (!Array.isArray(raw)) return;
      for (const rec of raw) {
        if (!rec || typeof rec.id !== 'string') continue;
        // On fresh daemon startup, reset transient 'streaming' flag to 'idle'.
        const normalized: AgentSessionRecord = {
          ...rec,
          status: 'idle',
        };
        this.sessions.set(rec.id, normalized);
        this.events.set(rec.id, this.readEventLog(rec.id));
      }
    } catch {
      // Corrupt metadata file: keep empty map instead of crashing daemon.
    }
  }

  private saveSessionsIndex(): void {
    const list = Array.from(this.sessions.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    const tmp = `${this.sessionsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, this.sessionsFile);
  }

  private logFilePath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.logsDir, `${safeId}.jsonl`);
  }

  private readEventLog(sessionId: string): AgentStreamEvent[] {
    const p = this.logFilePath(sessionId);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const out: AgentStreamEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AgentStreamEvent);
      } catch {
        // Ignore partial trailing line from an abrupt OS power loss.
      }
    }
    return out;
  }

  listSessions(): AgentSessionRecord[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  getSession(sessionId: string): AgentSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  activeSubscriberCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }

  createSession(input: CreateSessionInput = {}): AgentSessionRecord {
    const now = new Date().toISOString();
    const id = `ag-${crypto.randomBytes(6).toString('hex')}`;
    const record: AgentSessionRecord = {
      id,
      title: (input.title || '').trim() || `Session ${id.slice(-4)}`,
      projectRoot: (input.projectRoot || '').trim() || process.cwd(),
      backend: input.backend || 'antigravity-sdk',
      model: (input.model || '').trim() || 'auto',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    };
    this.sessions.set(id, record);
    this.events.set(id, []);
    this.saveSessionsIndex();
    this.appendEvent(id, 'system', {
      text: `Persistent session ${id} online for ${record.projectRoot} (backend: ${record.backend}). Safe to reload VS Code or switch UIs.`,
    });
    return record;
  }

  ensureDefaultSession(projectRoot: string): AgentSessionRecord {
    const existing = this.listSessions();
    if (existing.length > 0) return existing[0]!;
    return this.createSession({
      title: 'Awesome-OS Main Session',
      projectRoot,
      backend: 'antigravity-sdk',
    });
  }

  deleteSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.sessions.delete(sessionId);
    this.events.delete(sessionId);
    this.subscribers.delete(sessionId);
    const p = this.logFilePath(sessionId);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    this.saveSessionsIndex();
    return true;
  }

  setStatus(sessionId: string, status: 'idle' | 'streaming'): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
    this.saveSessionsIndex();
  }

  updateConfig(
    sessionId: string,
    patch: { backend?: AgentBackendKind; model?: string; title?: string; projectRoot?: string },
  ): AgentSessionRecord | undefined {
    const rec = this.sessions.get(sessionId);
    if (!rec) return undefined;
    if (patch.backend) rec.backend = patch.backend;
    if (patch.model) rec.model = patch.model;
    if (patch.title) rec.title = patch.title;
    if (patch.projectRoot) rec.projectRoot = patch.projectRoot;
    rec.updatedAt = new Date().toISOString();
    this.saveSessionsIndex();
    return rec;
  }

  getEvents(sessionId: string, sinceSeq = 0): AgentStreamEvent[] {
    const list = this.events.get(sessionId) || [];
    if (sinceSeq <= 0) return [...list];
    return list.filter((e) => e.seq > sinceSeq);
  }

  appendEvent(
    sessionId: string,
    type: AgentEventType,
    payload: { text?: string; tool?: string; args?: Record<string, unknown>; meta?: Record<string, unknown> } = {},
  ): AgentStreamEvent {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const seq = rec.lastSeq + 1;
    const ev: AgentStreamEvent = {
      seq,
      ts: new Date().toISOString(),
      sessionId,
      type,
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.tool !== undefined ? { tool: payload.tool } : {}),
      ...(payload.args !== undefined ? { args: payload.args } : {}),
      ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
    };
    rec.lastSeq = seq;
    rec.updatedAt = ev.ts;
    let list = this.events.get(sessionId);
    if (!list) {
      list = [];
      this.events.set(sessionId, list);
    }
    list.push(ev);
    fs.appendFileSync(this.logFilePath(sessionId), `${JSON.stringify(ev)}\n`, 'utf8');
    this.saveSessionsIndex();

    const subs = this.subscribers.get(sessionId);
    if (subs) {
      for (const fn of subs) {
        try {
          fn(ev);
        } catch {
          // Isolate broken client socket from other live UI subscribers.
        }
      }
    }
    return ev;
  }

  subscribe(sessionId: string, sinceSeq: number, listener: SessionSubscriber): () => void {
    const replay = this.getEvents(sessionId, sinceSeq);
    for (const ev of replay) {
      listener(ev);
    }
    let subs = this.subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(sessionId, subs);
    }
    subs.add(listener);
    return () => {
      const set = this.subscribers.get(sessionId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(sessionId);
    };
  }
}
