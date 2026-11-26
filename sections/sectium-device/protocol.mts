/**
 * @file sections/sectium-device/protocol.mts
 * @description Wire protocol and error contract for the Sectium Power-Button &
 * Network-Device Boundary. Sectium is treated strictly as an external
 * network-connected device reachable over a named pipe (Win32) or Unix socket
 * (POSIX) speaking line-delimited JSON (NDJSON).
 */

export const DEFAULT_WIN32_PIPE_PATH = '\\\\.\\pipe\\sectium-dev';
export const DEFAULT_POSIX_SOCKET_PATH = '/tmp/sectium-dev.sock';

export function getSectiumDevicePipePath(override?: string): string {
  const trimmed = override?.trim();
  if (trimmed) {
    return trimmed;
  }
  return process.platform === 'win32'
    ? DEFAULT_WIN32_PIPE_PATH
    : DEFAULT_POSIX_SOCKET_PATH;
}

export type SectiumChannelKind = 'command' | 'display';

export interface SectiumChannelAttachment {
  attachmentId: string;
  channel: SectiumChannelKind;
  clientId: string;
  sink?: string;
  attachedAt: number;
}

export interface SectiumPingRequest {
  id?: string;
  op: 'ping';
}

export interface SectiumStatusRequest {
  id?: string;
  op: 'status';
}

export interface SectiumOpenWindowRequest {
  id?: string;
  op: 'open_window';
  url: string;
  appMode?: boolean;
}

export interface SectiumAttachChannelRequest {
  id?: string;
  op: 'attach_channel';
  channel: SectiumChannelKind;
  clientId: string;
  sink?: string;
  replaceExisting?: boolean;
}

export interface SectiumDetachChannelRequest {
  id?: string;
  op: 'detach_channel';
  channel: SectiumChannelKind;
  attachmentId?: string;
  clientId?: string;
}

export interface SectiumListChannelsRequest {
  id?: string;
  op: 'list_channels';
  channel?: SectiumChannelKind;
}

export type SectiumDeviceRequest =
  | SectiumPingRequest
  | SectiumStatusRequest
  | SectiumOpenWindowRequest
  | SectiumAttachChannelRequest
  | SectiumDetachChannelRequest
  | SectiumListChannelsRequest;

export interface SectiumPingResponse {
  id?: string;
  ok: true;
  pong: true;
  uptimeMs: number;
}

export interface SectiumStatusResponse {
  id?: string;
  ok: true;
  version: string;
  pid: number;
  pipePath: string;
  windowsOpened: number;
  channels: {
    command: number;
    display: number;
  };
}

export interface SectiumOpenWindowResponse {
  id?: string;
  ok: true;
  windowId: string;
  url: string;
  appMode?: boolean;
}

export interface SectiumAttachChannelResponse {
  id?: string;
  ok: true;
  attachment: SectiumChannelAttachment;
  replacedAttachmentId?: string;
}

export interface SectiumDetachChannelResponse {
  id?: string;
  ok: true;
  detached: boolean;
  channel: SectiumChannelKind;
  attachmentId?: string;
}

export interface SectiumListChannelsResponse {
  id?: string;
  ok: true;
  channels: {
    command: SectiumChannelAttachment[];
    display: SectiumChannelAttachment[];
  };
}

export interface SectiumErrorResponse {
  id?: string;
  ok: false;
  error: string;
  code?: string;
}

export type SectiumDeviceResponse =
  | SectiumPingResponse
  | SectiumStatusResponse
  | SectiumOpenWindowResponse
  | SectiumAttachChannelResponse
  | SectiumDetachChannelResponse
  | SectiumListChannelsResponse
  | SectiumErrorResponse;

export class SectiumDeviceOfflineError extends Error {
  readonly code = 'DEVICE_OFFLINE' as const;
  readonly pipePath: string;
  readonly causeCode?: string;

  constructor(pipePath: string, reason?: string, causeCode?: string) {
    const detail = reason ? ` (${reason})` : '';
    super(`Sectium device is offline at ${pipePath}${detail}`);
    this.name = 'SectiumDeviceOfflineError';
    this.pipePath = pipePath;
    this.causeCode = causeCode;
  }
}
