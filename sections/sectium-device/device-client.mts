/**
 * @file sections/sectium-device/device-client.mts
 * @description Network-device client treating Sectium strictly as an external
 * network-connected device over named pipe / Unix socket, plus a power-on
 * environment sanitizer that strips all caller-leaking state.
 */
import { createConnection } from 'node:net';
import {
  getSectiumDevicePipePath,
  SectiumDeviceOfflineError,
  type SectiumAttachChannelResponse,
  type SectiumChannelKind,
  type SectiumDetachChannelResponse,
  type SectiumDeviceRequest,
  type SectiumDeviceResponse,
  type SectiumListChannelsResponse,
  type SectiumOpenWindowResponse,
  type SectiumPingResponse,
  type SectiumStatusResponse,
} from './protocol.mts';

export interface SectiumDeviceClientOptions {
  pipePath?: string;
  timeoutMs?: number;
}

const OFFLINE_ERROR_CODES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EACCES',
]);

/**
 * Explicit allowlist of OS-essential environment variables required for a
 * decoupled browser binary to power on cleanly without inheriting any caller
 * IDE, shell, Node/npm/pnpm, or agent session state.
 */
const OS_ESSENTIAL_ENV_KEYS = new Set([
  // Windows essentials
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMPUTERNAME',
  'COMSPEC',
  'DRIVERDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  // POSIX essentials
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'USER',
  'WAYLAND_DISPLAY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
]);

/**
 * Builds a sanitized environment for powering on the Sectium device process.
 * Strips all caller-leaking variables (IDE hooks, Node/npm/pnpm/agent vars,
 * caller tokens) and explicitly disables Google API key prompts.
 */
export function buildSanitizedPowerOnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) {
      continue;
    }
    if (OS_ESSENTIAL_ENV_KEYS.has(key.toUpperCase())) {
      sanitized[key] = value;
    }
  }

  sanitized.GOOGLE_API_KEY = 'no';
  sanitized.GOOGLE_DEFAULT_CLIENT_ID = 'no';
  sanitized.GOOGLE_DEFAULT_CLIENT_SECRET = 'no';

  return sanitized;
}

export class SectiumDeviceClient {
  readonly #pipePath: string;
  readonly #timeoutMs: number;
  #seq = 0;

  constructor(options: SectiumDeviceClientOptions = {}) {
    this.#pipePath = getSectiumDevicePipePath(options.pipePath);
    this.#timeoutMs = options.timeoutMs ?? 1500;
  }

  get pipePath(): string {
    return this.#pipePath;
  }

  async ping(): Promise<SectiumPingResponse> {
    const res = await this.#request({ op: 'ping' });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res as SectiumPingResponse;
  }

  async status(): Promise<SectiumStatusResponse> {
    const res = await this.#request({ op: 'status' });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res as SectiumStatusResponse;
  }

  async openWindow(
    url: string,
    opts?: { appMode?: boolean },
  ): Promise<SectiumOpenWindowResponse> {
    const res = await this.#request({
      op: 'open_window',
      url,
      ...(opts?.appMode !== undefined ? { appMode: opts.appMode } : {}),
    });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res as SectiumOpenWindowResponse;
  }

  async attachChannel(
    channel: SectiumChannelKind,
    clientId: string,
    opts?: { sink?: string; replaceExisting?: boolean },
  ): Promise<SectiumAttachChannelResponse> {
    const res = await this.#request({
      op: 'attach_channel',
      channel,
      clientId,
      ...(opts?.sink !== undefined ? { sink: opts.sink } : {}),
      ...(opts?.replaceExisting !== undefined
        ? { replaceExisting: opts.replaceExisting }
        : {}),
    });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res as SectiumAttachChannelResponse;
  }

  async detachChannel(
    channel: SectiumChannelKind,
    target: { attachmentId?: string; clientId?: string },
  ): Promise<SectiumDetachChannelResponse> {
    const res = await this.#request({
      op: 'detach_channel',
      channel,
      ...(target.attachmentId !== undefined
        ? { attachmentId: target.attachmentId }
        : {}),
      ...(target.clientId !== undefined ? { clientId: target.clientId } : {}),
    });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res as SectiumDetachChannelResponse;
  }

  async listChannels(
    channel?: SectiumChannelKind,
  ): Promise<SectiumListChannelsResponse> {
    const res = await this.#request({
      op: 'list_channels',
      ...(channel !== undefined ? { channel } : {}),
    });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res as SectiumListChannelsResponse;
  }

  #request(req: SectiumDeviceRequest): Promise<SectiumDeviceResponse> {
    const id = `req-${++this.#seq}`;
    const payload: SectiumDeviceRequest = { ...req, id };

    return new Promise<SectiumDeviceResponse>((resolve, reject) => {
      let settled = false;
      let buffer = '';

      const socket = createConnection(this.#pipePath);
      socket.setEncoding('utf8');

      const timer = setTimeout(() => {
        finishError(
          new SectiumDeviceOfflineError(
            this.#pipePath,
            `timed out after ${this.#timeoutMs}ms`,
            'ETIMEDOUT',
          ),
        );
      }, this.#timeoutMs);
      timer.unref?.();

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
        if (!socket.destroyed) {
          socket.destroy();
        }
      };

      const finishOk = (res: SectiumDeviceResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      };

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });

      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) {
          return;
        }
        const line = buffer.slice(0, newlineIdx).trim();
        try {
          const parsed = JSON.parse(line) as SectiumDeviceResponse;
          finishOk(parsed);
        } catch (err) {
          finishError(
            new Error(
              `Invalid NDJSON response from Sectium device at ${this.#pipePath}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        }
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code && OFFLINE_ERROR_CODES.has(err.code)) {
          finishError(
            new SectiumDeviceOfflineError(this.#pipePath, err.message, err.code),
          );
          return;
        }
        finishError(err);
      });

      socket.on('end', () => {
        if (!settled) {
          finishError(
            new SectiumDeviceOfflineError(
              this.#pipePath,
              'connection closed before response',
              'ECONNRESET',
            ),
          );
        }
      });
    });
  }
}
