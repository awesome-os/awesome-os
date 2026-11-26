/**
 * @file sections/sectium-device/device-host.mts
 * @description Network-device host listening on a named pipe (Win32) or Unix
 * domain socket (POSIX) and serving NDJSON requests (`ping`, `status`,
 * `open_window`).
 */
import { unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import {
  getSectiumDevicePipePath,
  type SectiumChannelAttachment,
  type SectiumChannelKind,
  type SectiumDeviceRequest,
  type SectiumDeviceResponse,
} from './protocol.mts';

export interface SectiumOpenedWindowRecord {
  windowId: string;
  url: string;
  appMode?: boolean;
  openedAt: number;
}

export type SectiumOpenWindowHandler = (
  record: SectiumOpenedWindowRecord,
) => void | Promise<void>;

export interface SectiumDeviceHostOptions {
  pipePath?: string;
  version?: string;
  onOpenWindow?: SectiumOpenWindowHandler;
}

export class SectiumDeviceHost {
  readonly #pipePath: string;
  readonly #version: string;
  readonly #onOpenWindow?: SectiumOpenWindowHandler;
  readonly #sockets = new Set<Socket>();
  readonly #openedWindows: SectiumOpenedWindowRecord[] = [];
  readonly #commandChannels = new Map<string, SectiumChannelAttachment>();
  readonly #displayChannels = new Map<string, SectiumChannelAttachment>();
  #channelSeq = 0;
  #server: Server | null = null;
  #startedAt = 0;

  constructor(options: SectiumDeviceHostOptions = {}) {
    this.#pipePath = getSectiumDevicePipePath(options.pipePath);
    this.#version = options.version ?? '1.0.0';
    this.#onOpenWindow = options.onOpenWindow;
  }

  get pipePath(): string {
    return this.#pipePath;
  }

  get isListening(): boolean {
    return Boolean(this.#server?.listening);
  }

  get windowsOpened(): number {
    return this.#openedWindows.length;
  }

  get openedWindows(): readonly SectiumOpenedWindowRecord[] {
    return this.#openedWindows;
  }

  async start(): Promise<void> {
    if (this.#server?.listening) {
      return;
    }

    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.#pipePath);
      } catch {
        // Socket path did not exist
      }
    }

    const server = createServer((socket) => {
      this.#handleConnection(socket);
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        this.#server = null;
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        this.#startedAt = Date.now();
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.#pipePath);
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) {
      return;
    }
    this.#server = null;

    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.#pipePath);
      } catch {
        // Already removed
      }
    }
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding('utf8');

    let buffer = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          void this.#processLine(socket, line);
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      this.#sockets.delete(socket);
    });

    socket.on('error', () => {
      this.#sockets.delete(socket);
    });
  }

  async #processLine(socket: Socket, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#writeResponse(socket, {
        ok: false,
        error: 'Malformed JSON request',
        code: 'INVALID_JSON',
      });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { op?: unknown }).op !== 'string') {
      this.#writeResponse(socket, {
        ok: false,
        error: 'Request must be a JSON object with a string "op" field',
        code: 'INVALID_REQUEST',
      });
      return;
    }

    const req = parsed as SectiumDeviceRequest;
    const response = await this.#dispatch(req);
    this.#writeResponse(socket, response);
  }

  async #dispatch(req: SectiumDeviceRequest): Promise<SectiumDeviceResponse> {
    const idField = req.id !== undefined ? { id: req.id } : {};

    switch (req.op) {
      case 'ping': {
        return {
          ...idField,
          ok: true,
          pong: true,
          uptimeMs: Math.max(0, Date.now() - this.#startedAt),
        };
      }

      case 'status': {
        return {
          ...idField,
          ok: true,
          version: this.#version,
          pid: process.pid,
          pipePath: this.#pipePath,
          windowsOpened: this.#openedWindows.length,
          channels: {
            command: this.#commandChannels.size,
            display: this.#displayChannels.size,
          },
        };
      }

      case 'attach_channel': {
        if (req.channel !== 'command' && req.channel !== 'display') {
          return {
            ...idField,
            ok: false,
            error: 'attach_channel requires channel to be "command" or "display"',
            code: 'INVALID_CHANNEL',
          };
        }
        if (typeof req.clientId !== 'string' || req.clientId.trim().length === 0) {
          return {
            ...idField,
            ok: false,
            error: 'attach_channel requires a non-empty string "clientId"',
            code: 'INVALID_CLIENT_ID',
          };
        }

        const registry = this.#getChannelMap(req.channel);
        const shouldReplace =
          req.replaceExisting ?? (req.channel === 'display');
        let replacedAttachmentId: string | undefined;

        if (shouldReplace && registry.size > 0) {
          const firstKey = registry.keys().next().value;
          if (typeof firstKey === 'string') {
            replacedAttachmentId = firstKey;
          }
          registry.clear();
        }

        const attachmentId = `${req.channel}-${++this.#channelSeq}`;
        const attachment: SectiumChannelAttachment = {
          attachmentId,
          channel: req.channel,
          clientId: req.clientId.trim(),
          ...(req.sink !== undefined ? { sink: req.sink } : {}),
          attachedAt: Date.now(),
        };
        registry.set(attachmentId, attachment);

        return {
          ...idField,
          ok: true,
          attachment,
          ...(replacedAttachmentId !== undefined ? { replacedAttachmentId } : {}),
        };
      }

      case 'detach_channel': {
        if (req.channel !== 'command' && req.channel !== 'display') {
          return {
            ...idField,
            ok: false,
            error: 'detach_channel requires channel to be "command" or "display"',
            code: 'INVALID_CHANNEL',
          };
        }

        const registry = this.#getChannelMap(req.channel);
        let removedId: string | undefined;

        if (req.attachmentId && registry.has(req.attachmentId)) {
          registry.delete(req.attachmentId);
          removedId = req.attachmentId;
        } else if (req.clientId) {
          for (const [id, entry] of registry.entries()) {
            if (entry.clientId === req.clientId) {
              registry.delete(id);
              removedId = id;
              break;
            }
          }
        }

        return {
          ...idField,
          ok: true,
          detached: removedId !== undefined,
          channel: req.channel,
          ...(removedId !== undefined ? { attachmentId: removedId } : {}),
        };
      }

      case 'list_channels': {
        const command =
          !req.channel || req.channel === 'command'
            ? Array.from(this.#commandChannels.values())
            : [];
        const display =
          !req.channel || req.channel === 'display'
            ? Array.from(this.#displayChannels.values())
            : [];
        return {
          ...idField,
          ok: true,
          channels: { command, display },
        };
      }

      case 'open_window': {
        if (typeof req.url !== 'string' || req.url.trim().length === 0) {
          return {
            ...idField,
            ok: false,
            error: 'open_window requires a non-empty string "url"',
            code: 'INVALID_URL',
          };
        }

        const windowId = `win-${this.#openedWindows.length + 1}`;
        const record: SectiumOpenedWindowRecord = {
          windowId,
          url: req.url,
          ...(req.appMode !== undefined ? { appMode: req.appMode } : {}),
          openedAt: Date.now(),
        };

        try {
          if (this.#onOpenWindow) {
            await this.#onOpenWindow(record);
          }
        } catch (err) {
          return {
            ...idField,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: 'OPEN_WINDOW_FAILED',
          };
        }

        this.#openedWindows.push(record);
        return {
          ...idField,
          ok: true,
          windowId,
          url: record.url,
          ...(record.appMode !== undefined ? { appMode: record.appMode } : {}),
        };
      }

      default: {
        return {
          ...idField,
          ok: false,
          error: `Unknown op: ${String((req as { op?: unknown }).op)}`,
          code: 'UNKNOWN_OP',
        };
      }
    }
  }

  #getChannelMap(channel: SectiumChannelKind): Map<string, SectiumChannelAttachment> {
    return channel === 'command' ? this.#commandChannels : this.#displayChannels;
  }

  #writeResponse(socket: Socket, response: SectiumDeviceResponse): void {
    if (!socket.destroyed && socket.writable) {
      socket.write(`${JSON.stringify(response)}\n`);
    }
  }
}
