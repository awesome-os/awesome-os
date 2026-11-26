/**
 * @file sections/sectium-device/devtools-plane.mts
 * @description DevTools Backend & Cross-Tab IDE Plane built on top of the
 * Sectium Host Device `channel: 'command'` control plane. Keeps the Display
 * Channel (`channel: 'display'`) 100% pure art while giving VS Code,
 * Antigravity, AI agents, and CLI tools full cross-tab visibility and typed
 * event streams.
 */
import type { SectiumDeviceClient } from './device-client.mts';
import type { SectiumChannelAttachment } from './protocol.mts';
import {
  UniversalCompilerDebugHub,
  type CdpRequest,
  type CdpResponse,
} from './universal-compiler-debug.mts';

export type SectiumDevToolsClientKind =
  | 'vscode'
  | 'antigravity'
  | 'agent'
  | 'cli';

const VALID_CLIENT_KINDS = new Set<SectiumDevToolsClientKind>([
  'vscode',
  'antigravity',
  'agent',
  'cli',
]);

export interface SectiumTabInput {
  tabId: string;
  url: string;
  title: string;
  origin: string;
  active?: boolean;
  selection?: string;
  focusedElement?: string;
  metadata?: Record<string, unknown>;
}

export interface SectiumTabContext {
  tabId: string;
  url: string;
  title: string;
  origin: string;
  active: boolean;
  selection?: string;
  focusedElement?: string;
  metadata: Record<string, unknown>;
  registeredAt: number;
  updatedAt: number;
}

export interface SectiumTabContextPatch {
  url?: string;
  title?: string;
  origin?: string;
  active?: boolean;
  selection?: string;
  focusedElement?: string;
  metadata?: Record<string, unknown>;
}

export interface SectiumDevToolsClientOptions {
  cdpEndpoint?: string;
  capabilities?: readonly string[];
}

export interface SectiumDevToolsClientBinding {
  clientId: string;
  kind: SectiumDevToolsClientKind;
  channel: 'command';
  attachedAt: number;
  cdpEndpoint?: string;
  capabilities?: string[];
}

export interface SectiumCrossTabContextSnapshot {
  channel: 'command';
  planeId: string;
  attachedCommandChannel: SectiumChannelAttachment | null;
  generatedAt: number;
  tabCount: number;
  activeTabId: string | null;
  origins: string[];
  tabs: SectiumTabContext[];
  devtoolsClients: SectiumDevToolsClientBinding[];
}

export type SectiumDevToolsEvent =
  | {
      type: 'tab-registered';
      channel: 'command';
      timestamp: number;
      tab: SectiumTabContext;
    }
  | {
      type: 'tab-unregistered';
      channel: 'command';
      timestamp: number;
      tabId: string;
      tab: SectiumTabContext;
    }
  | {
      type: 'tab-context-updated';
      channel: 'command';
      timestamp: number;
      tabId: string;
      patch: SectiumTabContextPatch;
      tab: SectiumTabContext;
    }
  | {
      type: 'devtools-attached';
      channel: 'command';
      timestamp: number;
      client: SectiumDevToolsClientBinding;
    }
  | {
      type: 'devtools-detached';
      channel: 'command';
      timestamp: number;
      clientId: string;
      client: SectiumDevToolsClientBinding;
    };

export type SectiumDevToolsEventListener = (
  event: SectiumDevToolsEvent,
) => void;

export interface SectiumDevToolsPlaneOptions {
  planeId?: string;
  deviceClient?: SectiumDeviceClient;
}

export const B8G_SECTIUM_WEB_COMPONENTS = {
  command: 'b8g-sectium-command',
  display: 'b8g-sectium-display',
  devtools: 'b8g-sectium-devtools',
} as const;

export type B8gSectiumDisplaySurface = 'canvas' | 'gpu' | 'kitty' | 'ansi';

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatDataAttrs(attrs: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const attrName = key.startsWith('data-') ? key : `data-${key}`;
    parts.push(`${attrName}="${escapeHtmlAttr(String(value))}"`);
  }
  return parts.join(' ');
}

/**
 * Formats a strictly HTML5 `data-*` `<b8g-sectium-command>` element representing
 * the serial-console / DevTools control stream.
 */
export function formatB8gSectiumCommandElement(pipePath: string): string {
  const attrs = formatDataAttrs({
    'data-pipe': pipePath,
    'data-channel': 'command',
  });
  return `<${B8G_SECTIUM_WEB_COMPONENTS.command} ${attrs}></${B8G_SECTIUM_WEB_COMPONENTS.command}>`;
}

/**
 * Formats a strictly HTML5 `data-*` `<b8g-sectium-display>` element representing
 * a hot-swappable visual sink.
 */
export function formatB8gSectiumDisplayElement(
  pipePath: string,
  surface: B8gSectiumDisplaySurface = 'canvas',
): string {
  const attrs = formatDataAttrs({
    'data-pipe': pipePath,
    'data-channel': 'display',
    'data-surface': surface,
  });
  return `<${B8G_SECTIUM_WEB_COMPONENTS.display} ${attrs}></${B8G_SECTIUM_WEB_COMPONENTS.display}>`;
}

/**
 * Formats a strictly HTML5 `data-*` `<b8g-sectium-devtools>` element representing
 * the cross-tab IDE / VS Code / Antigravity / agent plane.
 */
export function formatB8gSectiumDevToolsElement(opts?: {
  crossTab?: boolean;
  planeId?: string;
  tabCount?: number;
  clientCount?: number;
  activeTabId?: string | null;
}): string {
  const attrs = formatDataAttrs({
    'data-channel': 'command',
    'data-cross-tab': opts?.crossTab ?? true,
    'data-plane-id': opts?.planeId,
    'data-tab-count': opts?.tabCount,
    'data-client-count': opts?.clientCount,
    'data-active-tab-id': opts?.activeTabId ?? undefined,
  });
  return `<${B8G_SECTIUM_WEB_COMPONENTS.devtools} ${attrs}></${B8G_SECTIUM_WEB_COMPONENTS.devtools}>`;
}

function cloneTab(tab: SectiumTabContext): SectiumTabContext {
  return {
    ...tab,
    metadata: { ...tab.metadata },
  };
}

function cloneClient(
  client: SectiumDevToolsClientBinding,
): SectiumDevToolsClientBinding {
  return {
    ...client,
    ...(client.capabilities !== undefined
      ? { capabilities: [...client.capabilities] }
      : {}),
  };
}

/**
 * DevTools Backend & Cross-Tab IDE Plane attached exclusively to the
 * `channel: 'command'` control plane so `channel: 'display'` remains pure art.
 */
export class SectiumDevToolsPlane {
  readonly channel = 'command' as const;
  readonly #planeId: string;
  readonly #deviceClient?: SectiumDeviceClient;
  readonly #tabs = new Map<string, SectiumTabContext>();
  readonly #clients = new Map<string, SectiumDevToolsClientBinding>();
  readonly #listeners = new Set<SectiumDevToolsEventListener>();
  readonly #activeStreamClosers = new Set<() => void>();
  #channelAttachment: SectiumChannelAttachment | null = null;

  constructor(options: SectiumDevToolsPlaneOptions = {}) {
    this.#planeId = options.planeId?.trim() || 'sectium-devtools-plane';
    this.#deviceClient = options.deviceClient;
  }

  get planeId(): string {
    return this.#planeId;
  }

  get channelAttachment(): SectiumChannelAttachment | null {
    return this.#channelAttachment ? { ...this.#channelAttachment } : null;
  }

  /**
   * Attaches this DevTools plane onto a live Sectium Host Device's
   * `channel: 'command'` control channel without touching `channel: 'display'`.
   */
  async attachToCommandChannel(
    deviceClient?: SectiumDeviceClient,
  ): Promise<SectiumChannelAttachment> {
    const client = deviceClient ?? this.#deviceClient;
    if (!client) {
      throw new Error(
        'SectiumDevToolsPlane.attachToCommandChannel requires a SectiumDeviceClient',
      );
    }
    const res = await client.attachChannel('command', this.#planeId, {
      sink: 'devtools-plane',
    });
    this.#channelAttachment = res.attachment;
    return { ...res.attachment };
  }

  /**
   * Detaches this DevTools plane from the live Sectium Host Device's
   * `channel: 'command'` control channel.
   */
  async detachFromCommandChannel(
    deviceClient?: SectiumDeviceClient,
  ): Promise<boolean> {
    const attachment = this.#channelAttachment;
    if (!attachment) {
      return false;
    }
    const client = deviceClient ?? this.#deviceClient;
    if (!client) {
      throw new Error(
        'SectiumDevToolsPlane.detachFromCommandChannel requires a SectiumDeviceClient',
      );
    }
    const res = await client.detachChannel('command', {
      attachmentId: attachment.attachmentId,
    });
    this.#channelAttachment = null;
    return res.detached;
  }

  registerTab(input: SectiumTabInput): SectiumTabContext {
    const tabId = input.tabId.trim();
    if (tabId.length === 0) {
      throw new Error('registerTab requires a non-empty "tabId"');
    }
    if (input.url.trim().length === 0) {
      throw new Error('registerTab requires a non-empty "url"');
    }
    if (input.origin.trim().length === 0) {
      throw new Error('registerTab requires a non-empty "origin"');
    }

    const now = Date.now();
    const isActive = input.active === true;
    if (isActive) {
      this.#clearActiveTab();
    }

    const record: SectiumTabContext = {
      tabId,
      url: input.url,
      title: input.title,
      origin: input.origin,
      active: isActive,
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
      ...(input.focusedElement !== undefined
        ? { focusedElement: input.focusedElement }
        : {}),
      metadata: input.metadata ? { ...input.metadata } : {},
      registeredAt: now,
      updatedAt: now,
    };

    this.#tabs.set(tabId, record);

    const snapshot = cloneTab(record);
    this.#emit({
      type: 'tab-registered',
      channel: 'command',
      timestamp: now,
      tab: snapshot,
    });
    return cloneTab(record);
  }

  unregisterTab(tabId: string): boolean {
    const existing = this.#tabs.get(tabId);
    if (!existing) {
      return false;
    }
    this.#tabs.delete(tabId);
    this.#emit({
      type: 'tab-unregistered',
      channel: 'command',
      timestamp: Date.now(),
      tabId,
      tab: cloneTab(existing),
    });
    return true;
  }

  listTabs(): SectiumTabContext[] {
    return Array.from(this.#tabs.values(), (tab) => cloneTab(tab));
  }

  updateTabContext(
    tabId: string,
    patch: SectiumTabContextPatch,
  ): SectiumTabContext {
    const existing = this.#tabs.get(tabId);
    if (!existing) {
      throw new Error(`Tab "${tabId}" is not registered`);
    }

    if (patch.active === true) {
      this.#clearActiveTab();
    }

    const now = Date.now();
    const updated: SectiumTabContext = {
      ...existing,
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.origin !== undefined ? { origin: patch.origin } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.selection !== undefined ? { selection: patch.selection } : {}),
      ...(patch.focusedElement !== undefined
        ? { focusedElement: patch.focusedElement }
        : {}),
      metadata:
        patch.metadata !== undefined
          ? { ...existing.metadata, ...patch.metadata }
          : { ...existing.metadata },
      updatedAt: now,
    };

    this.#tabs.set(tabId, updated);

    const patchCopy: SectiumTabContextPatch = {
      ...patch,
      ...(patch.metadata !== undefined
        ? { metadata: { ...patch.metadata } }
        : {}),
    };

    this.#emit({
      type: 'tab-context-updated',
      channel: 'command',
      timestamp: now,
      tabId,
      patch: patchCopy,
      tab: cloneTab(updated),
    });
    return cloneTab(updated);
  }

  attachDevToolsClient(
    clientId: string,
    kind: SectiumDevToolsClientKind,
    options: SectiumDevToolsClientOptions = {},
  ): SectiumDevToolsClientBinding {
    const normalizedId = clientId.trim();
    if (normalizedId.length === 0) {
      throw new Error('attachDevToolsClient requires a non-empty "clientId"');
    }
    if (!VALID_CLIENT_KINDS.has(kind)) {
      throw new Error(
        `Invalid DevTools client kind "${String(kind)}"; expected vscode, antigravity, agent, or cli`,
      );
    }

    const now = Date.now();
    const binding: SectiumDevToolsClientBinding = {
      clientId: normalizedId,
      kind,
      channel: 'command',
      attachedAt: now,
      ...(options.cdpEndpoint !== undefined
        ? { cdpEndpoint: options.cdpEndpoint }
        : {}),
      ...(options.capabilities !== undefined
        ? { capabilities: [...options.capabilities] }
        : {}),
    };

    this.#clients.set(normalizedId, binding);

    this.#emit({
      type: 'devtools-attached',
      channel: 'command',
      timestamp: now,
      client: cloneClient(binding),
    });
    return cloneClient(binding);
  }

  detachDevToolsClient(clientId: string): boolean {
    const existing = this.#clients.get(clientId);
    if (!existing) {
      return false;
    }
    this.#clients.delete(clientId);
    this.#emit({
      type: 'devtools-detached',
      channel: 'command',
      timestamp: Date.now(),
      clientId,
      client: cloneClient(existing),
    });
    return true;
  }

  listDevToolsClients(): SectiumDevToolsClientBinding[] {
    return Array.from(this.#clients.values(), (client) => cloneClient(client));
  }

  getCrossTabContext(): SectiumCrossTabContextSnapshot {
    const tabs = this.listTabs();
    const devtoolsClients = this.listDevToolsClients();
    const activeTab = tabs.find((tab) => tab.active) ?? null;
    const origins = Array.from(new Set(tabs.map((tab) => tab.origin)));

    return {
      channel: 'command',
      planeId: this.#planeId,
      attachedCommandChannel: this.channelAttachment,
      generatedAt: Date.now(),
      tabCount: tabs.length,
      activeTabId: activeTab ? activeTab.tabId : null,
      origins,
      tabs,
      devtoolsClients,
    };
  }

  onEvent(cb: SectiumDevToolsEventListener): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /**
   * Exposes a standard WHATWG `ReadableStream<SectiumDevToolsEvent>` supporting
   * native `.tee()`, `TransformStream`, and `WritableStream` fan-out so VS Code,
   * Antigravity, DevTools, and agents consume cross-tab events over Web Streams.
   */
  createEventStream(): ReadableStream<SectiumDevToolsEvent> {
    let unsubscribe: (() => void) | null = null;
    let closeHandle: (() => void) | null = null;
    let closed = false;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (closeHandle) {
        this.#activeStreamClosers.delete(closeHandle);
        closeHandle = null;
      }
    };

    return new ReadableStream<SectiumDevToolsEvent>({
      start: (controller) => {
        closeHandle = () => {
          if (closed) return;
          closed = true;
          cleanup();
          try {
            controller.close();
          } catch {
            // Stream already closed or errored
          }
        };
        this.#activeStreamClosers.add(closeHandle);

        unsubscribe = this.onEvent((event) => {
          if (closed) return;
          try {
            controller.enqueue(event);
          } catch {
            closed = true;
            cleanup();
          }
        });
      },
      cancel: () => {
        closed = true;
        cleanup();
      },
    });
  }

  /**
   * Closes all active `createEventStream()` readers cleanly.
   */
  closeEventStreams(): void {
    for (const close of Array.from(this.#activeStreamClosers)) {
      close();
    }
  }

  /**
   * Serializes this plane's current state as a strictly HTML5 `data-*`
   * `<b8g-sectium-devtools>` Streaming Web Component element.
   */
  toHtml5Element(): string {
    const snapshot = this.getCrossTabContext();
    return formatB8gSectiumDevToolsElement({
      crossTab: true,
      planeId: snapshot.planeId,
      tabCount: snapshot.tabCount,
      clientCount: snapshot.devtoolsClients.length,
      activeTabId: snapshot.activeTabId,
    });
  }

  readonly #compilerDebug = new UniversalCompilerDebugHub();

  /**
   * Returns the Universal Compiler Feedback (`HoloCompiler.*`) & Polyglot Debug
   * (`HoloDebug.*` + CDP `Debugger.*`/`Runtime.*`) hub bound to `channel: 'command'`.
   */
  get compilerDebug(): UniversalCompilerDebugHub {
    return this.#compilerDebug;
  }

  /**
   * Dispatches a standard CDP or `HoloCompiler.*` / `HoloDebug.*` JSON-RPC command.
   */
  dispatchCdp(req: CdpRequest): CdpResponse {
    return this.#compilerDebug.handleCdpCommand(req);
  }

  #clearActiveTab(): void {
    for (const [id, tab] of this.#tabs.entries()) {
      if (tab.active) {
        this.#tabs.set(id, { ...tab, active: false });
      }
    }
  }

  #emit(event: SectiumDevToolsEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
