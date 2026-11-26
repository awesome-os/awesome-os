/**
 * @file sections/sectium-cloud-control-plane/index.mts
 * @description Unified TypeScript binding for `sectium-cloud-control-plane`
 * (`B8G_ABI_MAGIC_V3 = 0x33564742`, ABI v3). Acts as the minimal self-discovery
 * `initramfs` and 1-way WoL detached control plane unifying `SectiumDeviceHost`,
 * `SectiumDeviceClient`, `SectiumDevToolsPlane`, and `createKittyInkWritableStream`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  SectiumDeviceClient,
  buildSanitizedPowerOnEnv,
} from '../sectium-device/device-client.mts';
import { SectiumDeviceHost } from '../sectium-device/device-host.mts';
import {
  B8G_SECTIUM_WEB_COMPONENTS,
  SectiumDevToolsPlane,
  formatB8gSectiumCommandElement,
  formatB8gSectiumDevToolsElement,
  formatB8gSectiumDisplayElement,
  type B8gSectiumDisplaySurface,
  type SectiumDevToolsClientKind,
} from '../sectium-device/devtools-plane.mts';
import {
  createKittyInkWritableStream,
  encodeKittyGraphicsFrame,
  renderB8gElementToAnsi,
  type KittyInkGraphicsMode,
} from '../sectium-device/kitty-ink-sink.mts';
import {
  SectiumDeviceOfflineError,
  getSectiumDevicePipePath,
} from '../sectium-device/protocol.mts';

const execFileAsync = promisify(execFile);

export const B8G_ABI_MAGIC_V3 = 0x33564742 as const;
export const B8G_CP_ABI_VERSION = 3 as const;
export const B8G_ARENA_ALIGN_BYTES = 64 as const;

export const SectiumCpPowerMode = {
  COLD_INIT: 0,
  WARM_RAM_RESUME: 1,
  DETACHED_DAEMON: 2,
} as const;
export type SectiumCpPowerModeValue =
  (typeof SectiumCpPowerMode)[keyof typeof SectiumCpPowerMode];

export const SectiumCpChannelKind = {
  COMMAND: 1,
  DISPLAY: 2,
  DEVTOOLS: 3,
} as const;
export type SectiumCpChannelKindValue =
  (typeof SectiumCpChannelKind)[keyof typeof SectiumCpChannelKind];

export const SectiumCpError = {
  OK: 0,
  ERR_INVALID_ARG: -1,
  ERR_DEVICE_OFFLINE: -2,
  ERR_NO_SNAPSHOT: -3,
  ERR_SLOTS_FULL: -4,
} as const;
export type SectiumCpErrorValue =
  (typeof SectiumCpError)[keyof typeof SectiumCpError];

export type SectiumOpaqueChannel = 'command' | 'display' | 'devtools';

export type SectiumMainEntryKind =
  | 'sectium-es'
  | 'sectium-jvm'
  | 'b8g-runtime'
  | 'sectium-display'
  | (string & {});

export interface SectiumMainEntrySpec {
  id: string;
  kind: SectiumMainEntryKind;
  arenaAlignBytes: 64;
  args?: readonly string[];
}

export interface SectiumBootstrappedMainEntry {
  id: string;
  kind: SectiumMainEntryKind;
  arenaAlignBytes: 64;
  arenaOffset: number;
  aligned: true;
  initramfsDiscovery: true;
  snapshotEpoch: number;
  bootstrappedAt: number;
  args?: string[];
}

export interface SectiumRamCheckpoint {
  epoch: number;
  format: '.b8p';
  arenaAlignBytes: 64;
  bootstrappedEntries: number;
  checkpointedAt: number;
  label?: string;
}

export interface SectiumWakeOptions {
  powerMode?: 'auto' | 'cold-init' | 'warm-ram-resume' | 'detached-daemon';
  resumeEpoch?: number;
  detached?: boolean;
}

export interface SectiumWakeResult {
  online: true;
  detached: boolean;
  warmResumed: boolean;
  powerMode: SectiumCpPowerModeValue;
  snapshotEpoch: number;
  pipePath: string;
  endpoint: string;
  sanitizedEnvKeys: number;
}

export interface SectiumAttachPeerOptions {
  sink?: string;
  surface?: B8gSectiumDisplaySurface;
  clientKind?: SectiumDevToolsClientKind;
}

export interface SectiumOpaquePeerAttachment {
  attachmentId: string;
  channel: SectiumOpaqueChannel;
  peerId: string;
  opaque: true;
  attachedAt: number;
  replacedAttachmentId?: string;
  replacedPeerId?: string;
  element: string;
}

export interface SectiumCloudStatus {
  abiMagic: typeof B8G_ABI_MAGIC_V3;
  abiVersion: typeof B8G_CP_ABI_VERSION;
  endpoint: string;
  pipePath: string;
  online: boolean;
  detached: boolean;
  warmResumed: boolean;
  snapshotEpoch: number;
  arenaAlignBytes: typeof B8G_ARENA_ALIGN_BYTES;
  commandPeers: number;
  displayPeers: number;
  devtoolsPeers: number;
  mainEntries: SectiumBootstrappedMainEntry[];
  lastError: SectiumCpErrorValue;
}

export interface SectiumNativeAbiProbeResult {
  ok: boolean;
  abi_magic: number;
  abi_magic_hex: string;
  abi_version: number;
  offline_rc: number;
  online: number;
  detached: number;
  warm_resumed: number;
  snapshot_epoch: number;
  command_peers: number;
  display_peers: number;
  devtools_peers: number;
  display_slot1: number;
  display_slot2: number;
  replaced_slot_id: number;
  last_error: number;
  probePath: string;
}

export type RollingReleaseChannel = 'rolling' | 'canary' | 'stable';

export interface RollingReleaseManifest {
  planeVersion: string;
  releaseChannel: RollingReleaseChannel;
  abiMagic: number;
  abiVersion: number;
  snapshotEpoch: number;
  bundleSha256: string;
  publishedAt: string;
}

export type StageRollingReleaseInput = Omit<
  RollingReleaseManifest,
  'snapshotEpoch' | 'publishedAt'
> & {
  snapshotEpoch?: number;
  publishedAt?: string;
};

export interface SectiumCloudControlPlaneOptions {
  pipePath?: string;
  endpoint?: string;
  planeId?: string;
  version?: string;
  probePath?: string;
  timeoutMs?: number;
}

export interface SectiumStreamFanOutOptions {
  onCommand?: (renderedAnsi: string) => void | Promise<void>;
  onDisplay?: (rendered: string) => void | Promise<void>;
  graphicsMode?: KittyInkGraphicsMode;
  width?: number;
  height?: number;
}

export interface SectiumStreamFanOutHandle {
  emitMarkup(element: string): void;
  emitDisplayFrame(frame: Uint8Array): void;
  close(): Promise<void>;
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROBE_PATH = join(THIS_DIR, 'dist', 'sectium-cp-probe.exe');

function parseAbiMagic(raw: unknown): { value: number; hex: string } {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const value = raw >>> 0;
    return {
      value,
      hex: `0x${value.toString(16).toUpperCase().padStart(8, '0')}`,
    };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const parsed = Number.parseInt(trimmed, trimmed.startsWith('0x') || trimmed.startsWith('0X') ? 16 : 10);
    if (Number.isFinite(parsed)) {
      const value = parsed >>> 0;
      return {
        value,
        hex: `0x${value.toString(16).toUpperCase().padStart(8, '0')}`,
      };
    }
  }
  return { value: 0, hex: '0x00000000' };
}

/**
 * Unified Sectium Cloud Control Plane (`B8G_ABI_MAGIC_V3`).
 * Acts as the central self-discovery `initramfs` that mounts/restores the
 * 64-byte-aligned `B8G_ARENA_V1` `.b8p` warm-RAM checkpoint, wakes the
 * detached host device over 1-way WoL, bootstraps single-entrypoint targets,
 * and treats every local and remote client as an opaque peer.
 */
export class SectiumCloudControlPlane {
  readonly #endpoint: string;
  readonly #pipePath: string;
  readonly #probePath: string;
  readonly #host: SectiumDeviceHost;
  readonly #client: SectiumDeviceClient;
  readonly #devtools: SectiumDevToolsPlane;

  readonly #commandPeers = new Map<string, SectiumOpaquePeerAttachment>();
  readonly #displayPeers = new Map<string, SectiumOpaquePeerAttachment>();
  readonly #devtoolsPeers = new Map<string, SectiumOpaquePeerAttachment>();
  readonly #mainEntries = new Map<string, SectiumBootstrappedMainEntry>();
  readonly #checkpoints: SectiumRamCheckpoint[] = [];
  readonly #markupSubscribers = new Set<(markup: string) => void>();

  #online = false;
  #detached = false;
  #warmResumed = false;
  #snapshotEpoch = 0;
  #lastError: SectiumCpErrorValue = SectiumCpError.OK;
  #devtoolsSeq = 0;
  #arenaCursor = 0;
  #rollingManifest: RollingReleaseManifest;
  #previousManifest: RollingReleaseManifest | null = null;

  constructor(options: SectiumCloudControlPlaneOptions = {}) {
    this.#pipePath = getSectiumDevicePipePath(options.pipePath);
    this.#endpoint = options.endpoint?.trim() || 'sectium://control-plane.local:9443';
    this.#probePath = options.probePath?.trim() || DEFAULT_PROBE_PATH;
    const initialVersion = options.version ?? `3.0.0-abi${B8G_CP_ABI_VERSION}`;

    this.#host = new SectiumDeviceHost({
      pipePath: this.#pipePath,
      version: initialVersion,
    });
    this.#client = new SectiumDeviceClient({
      pipePath: this.#pipePath,
      timeoutMs: options.timeoutMs ?? 1500,
    });
    this.#devtools = new SectiumDevToolsPlane({
      planeId: options.planeId ?? 'sectium-cloud-devtools',
      deviceClient: this.#client,
    });
    this.#rollingManifest = {
      planeVersion: initialVersion,
      releaseChannel: 'rolling',
      abiMagic: B8G_ABI_MAGIC_V3,
      abiVersion: B8G_CP_ABI_VERSION,
      snapshotEpoch: 0,
      bundleSha256: '0'.repeat(64),
      publishedAt: new Date().toISOString(),
    };
  }

  get pipePath(): string {
    return this.#pipePath;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  get host(): SectiumDeviceHost {
    return this.#host;
  }

  get client(): SectiumDeviceClient {
    return this.#client;
  }

  get devtools(): SectiumDevToolsPlane {
    return this.#devtools;
  }

  get isOnline(): boolean {
    return this.#online && this.#host.isListening;
  }

  get snapshotEpoch(): number {
    return this.#snapshotEpoch;
  }

  get warmResumed(): boolean {
    return this.#warmResumed;
  }

  get detached(): boolean {
    return this.#detached;
  }

  /**
   * 1-way Wake-on-LAN (WoL) wake for the detached Sectium Host Device.
   * Performs a cold init on the 1st wake (`snapshotEpoch === 0`), and a
   * millisecond `.b8p` warm-RAM snapshot resume on the 2nd+ wake whenever
   * `snapshotEpoch > 0`.
   */
  async wakeDetached(opts: SectiumWakeOptions = {}): Promise<SectiumWakeResult> {
    const requestedMode = opts.powerMode ?? 'auto';
    const targetEpoch = opts.resumeEpoch ?? this.#snapshotEpoch;
    const isWarmResume =
      requestedMode === 'warm-ram-resume' ||
      (requestedMode === 'auto' && targetEpoch > 0);

    if (requestedMode === 'warm-ram-resume' && targetEpoch <= 0) {
      this.#lastError = SectiumCpError.ERR_NO_SNAPSHOT;
      throw new Error('Cannot perform warm RAM resume without an existing .b8p snapshot epoch');
    }

    const sanitizedEnv = buildSanitizedPowerOnEnv();
    await this.#host.start();

    this.#online = true;
    this.#detached = opts.detached ?? true;
    this.#warmResumed = isWarmResume;
    if (isWarmResume && targetEpoch > this.#snapshotEpoch) {
      this.#snapshotEpoch = targetEpoch;
    }
    this.#lastError = SectiumCpError.OK;

    const powerMode: SectiumCpPowerModeValue = isWarmResume
      ? SectiumCpPowerMode.WARM_RAM_RESUME
      : requestedMode === 'detached-daemon'
        ? SectiumCpPowerMode.DETACHED_DAEMON
        : SectiumCpPowerMode.COLD_INIT;

    this.#broadcastMarkup(formatB8gSectiumCommandElement(this.#pipePath));

    return {
      online: true,
      detached: this.#detached,
      warmResumed: this.#warmResumed,
      powerMode,
      snapshotEpoch: this.#snapshotEpoch,
      pipePath: this.#pipePath,
      endpoint: this.#endpoint,
      sanitizedEnvKeys: Object.keys(sanitizedEnv).length,
    };
  }

  /**
   * Increments and records a 64-byte-aligned `.b8p` warm-RAM snapshot epoch
   * for millisecond warm resume across power-off cycles.
   */
  checkpointRamEpoch(opts?: { label?: string }): SectiumRamCheckpoint {
    if (!this.isOnline) {
      this.#lastError = SectiumCpError.ERR_DEVICE_OFFLINE;
      throw new SectiumDeviceOfflineError(
        this.#pipePath,
        'cannot checkpoint RAM epoch while device is offline',
        'DEVICE_OFFLINE',
      );
    }

    this.#snapshotEpoch += 1;
    this.#rollingManifest = {
      ...this.#rollingManifest,
      snapshotEpoch: this.#snapshotEpoch,
    };
    const checkpoint: SectiumRamCheckpoint = {
      epoch: this.#snapshotEpoch,
      format: '.b8p',
      arenaAlignBytes: B8G_ARENA_ALIGN_BYTES,
      bootstrappedEntries: this.#mainEntries.size,
      checkpointedAt: Date.now(),
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
    };
    this.#checkpoints.push(checkpoint);
    this.#lastError = SectiumCpError.OK;
    return { ...checkpoint };
  }

  /**
   * Stops the live device transport while preserving `snapshotEpoch` and
   * `.b8p` warm-RAM discovery state for millisecond warm resume.
   */
  async powerOff(): Promise<SectiumCloudStatus> {
    this.#devtools.closeEventStreams();
    await this.#host.stop();
    this.#commandPeers.clear();
    this.#displayPeers.clear();
    this.#devtoolsPeers.clear();
    this.#online = false;
    this.#warmResumed = false;
    this.#lastError = SectiumCpError.OK;
    return this.getStatus();
  }

  /**
   * Central discovery `initramfs` bootstrapper: mounts/allocates a
   * 64-byte-aligned `B8G_ARENA_V1` RAM slice and registers a `lo`-style
   * single-entrypoint target (`sectium-es`, `sectium-jvm`, `b8g-runtime`,
   * `sectium-display`) with merged RAM alignment.
   */
  bootstrapMainEntry(entry: SectiumMainEntrySpec): SectiumBootstrappedMainEntry {
    if (!this.isOnline) {
      this.#lastError = SectiumCpError.ERR_DEVICE_OFFLINE;
      throw new SectiumDeviceOfflineError(
        this.#pipePath,
        'cannot bootstrap mainEntry while control plane is offline',
        'DEVICE_OFFLINE',
      );
    }

    const id = entry.id.trim();
    if (id.length === 0) {
      this.#lastError = SectiumCpError.ERR_INVALID_ARG;
      throw new RangeError('bootstrapMainEntry requires a non-empty "id"');
    }
    if (entry.arenaAlignBytes !== B8G_ARENA_ALIGN_BYTES) {
      this.#lastError = SectiumCpError.ERR_INVALID_ARG;
      throw new RangeError(
        `B8G_ARENA_V1 requires 64-byte RAM alignment (got ${String(entry.arenaAlignBytes)})`,
      );
    }

    const align = B8G_ARENA_ALIGN_BYTES;
    const alignedOffset = Math.ceil(this.#arenaCursor / align) * align;
    // Reserve a 4 KiB (64 * 64) aligned descriptor page per mainEntry in the merged arena
    this.#arenaCursor = alignedOffset + align * 64;

    const record: SectiumBootstrappedMainEntry = {
      id,
      kind: entry.kind,
      arenaAlignBytes: align,
      arenaOffset: alignedOffset,
      aligned: true,
      initramfsDiscovery: true,
      snapshotEpoch: this.#snapshotEpoch,
      bootstrappedAt: Date.now(),
      ...(entry.args !== undefined ? { args: [...entry.args] } : {}),
    };
    this.#mainEntries.set(id, record);
    this.#lastError = SectiumCpError.OK;
    return {
      ...record,
      ...(record.args !== undefined ? { args: [...record.args] } : {}),
    };
  }

  /**
   * Attaches any local or remote client as an opaque peer over `'command'`,
   * `'display'`, or `'devtools'`. Performs an atomic hot-swap on `'display'`
   * while leaving `'command'` and `'devtools'` peers untouched.
   */
  async attachOpaquePeer(
    channel: SectiumOpaqueChannel,
    peerId: string,
    opts: SectiumAttachPeerOptions = {},
  ): Promise<SectiumOpaquePeerAttachment> {
    const normalizedPeerId = peerId.trim();
    if (normalizedPeerId.length === 0) {
      this.#lastError = SectiumCpError.ERR_INVALID_ARG;
      throw new RangeError('attachOpaquePeer requires a non-empty "peerId"');
    }

    if (!this.isOnline) {
      this.#lastError = SectiumCpError.ERR_DEVICE_OFFLINE;
      // Delegate to client ping so the exact protocol SectiumDeviceOfflineError is thrown
      await this.#client.ping();
    }

    if (channel === 'command') {
      const res = await this.#client.attachChannel('command', normalizedPeerId, {
        sink: opts.sink ?? 'opaque-command-peer',
        replaceExisting: false,
      });
      const element = formatB8gSectiumCommandElement(this.#pipePath);
      const attachment: SectiumOpaquePeerAttachment = {
        attachmentId: res.attachment.attachmentId,
        channel: 'command',
        peerId: normalizedPeerId,
        opaque: true,
        attachedAt: res.attachment.attachedAt,
        element,
      };
      this.#commandPeers.set(attachment.attachmentId, attachment);
      this.#broadcastMarkup(element);
      this.#lastError = SectiumCpError.OK;
      return { ...attachment };
    }

    if (channel === 'display') {
      const previous = this.#displayPeers.values().next().value;
      const res = await this.#client.attachChannel('display', normalizedPeerId, {
        sink: opts.sink ?? 'opaque-display-peer',
        replaceExisting: true,
      });
      this.#displayPeers.clear();
      const element = formatB8gSectiumDisplayElement(
        this.#pipePath,
        opts.surface ?? 'kitty',
      );
      const attachment: SectiumOpaquePeerAttachment = {
        attachmentId: res.attachment.attachmentId,
        channel: 'display',
        peerId: normalizedPeerId,
        opaque: true,
        attachedAt: res.attachment.attachedAt,
        ...(res.replacedAttachmentId !== undefined
          ? { replacedAttachmentId: res.replacedAttachmentId }
          : {}),
        ...(previous !== undefined ? { replacedPeerId: previous.peerId } : {}),
        element,
      };
      this.#displayPeers.set(attachment.attachmentId, attachment);
      this.#broadcastMarkup(element);
      this.#lastError = SectiumCpError.OK;
      return { ...attachment };
    }

    // channel === 'devtools'
    await this.#client.ping();
    const binding = this.#devtools.attachDevToolsClient(
      normalizedPeerId,
      opts.clientKind ?? 'agent',
    );
    const attachmentId = `devtools-${++this.#devtoolsSeq}`;
    const element = formatB8gSectiumDevToolsElement({
      crossTab: true,
      planeId: this.#devtools.planeId,
      tabCount: this.#devtools.listTabs().length,
      clientCount: this.#devtools.listDevToolsClients().length,
    });
    const attachment: SectiumOpaquePeerAttachment = {
      attachmentId,
      channel: 'devtools',
      peerId: normalizedPeerId,
      opaque: true,
      attachedAt: binding.attachedAt,
      element,
    };
    this.#devtoolsPeers.set(attachmentId, attachment);
    this.#broadcastMarkup(element);
    this.#lastError = SectiumCpError.OK;
    return { ...attachment };
  }

  /**
   * Detaches an opaque peer by peerId or attachmentId.
   */
  async detachOpaquePeer(
    channel: SectiumOpaqueChannel,
    peerIdOrAttachmentId: string,
  ): Promise<boolean> {
    const map =
      channel === 'command'
        ? this.#commandPeers
        : channel === 'display'
          ? this.#displayPeers
          : this.#devtoolsPeers;

    let target: SectiumOpaquePeerAttachment | undefined;
    for (const entry of map.values()) {
      if (
        entry.attachmentId === peerIdOrAttachmentId ||
        entry.peerId === peerIdOrAttachmentId
      ) {
        target = entry;
        break;
      }
    }
    if (!target) {
      return false;
    }

    if (channel === 'command' || channel === 'display') {
      if (this.isOnline) {
        await this.#client.detachChannel(channel, {
          attachmentId: target.attachmentId,
        });
      }
    } else {
      this.#devtools.detachDevToolsClient(target.peerId);
    }

    map.delete(target.attachmentId);
    return true;
  }

  /**
   * Creates a standard WHATWG Web Streams `.tee()` fan-out pipeline routing
   * `<b8g-*>` HTML5 `data-*` command/devtools elements and display image frames
   * through `createKittyInkWritableStream`.
   */
  createB8gStreamFanOut(
    opts: SectiumStreamFanOutOptions = {},
  ): SectiumStreamFanOutHandle {
    let controllerRef: ReadableStreamDefaultController<string | Uint8Array> | null = null;
    let closed = false;

    const source = new ReadableStream<string | Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
      },
      cancel: () => {
        closed = true;
      },
    });

    const [commandBranch, displayBranch] = source.tee();

    const commandSink = createKittyInkWritableStream(
      async (rendered) => {
        if (opts.onCommand) {
          await opts.onCommand(rendered);
        }
      },
      { channel: 'command' },
    );

    const displaySink = createKittyInkWritableStream(
      async (rendered) => {
        if (opts.onDisplay) {
          await opts.onDisplay(rendered);
        }
      },
      {
        channel: 'display',
        graphicsMode: opts.graphicsMode ?? 'kitty',
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
      },
    );

    const commandFilter = new TransformStream<string | Uint8Array, string | Uint8Array>({
      transform(chunk, controller) {
        if (typeof chunk === 'string') {
          controller.enqueue(chunk);
        }
      },
    });

    const displayFilter = new TransformStream<string | Uint8Array, string | Uint8Array>({
      transform(chunk, controller) {
        if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        }
      },
    });

    const commandDone = commandBranch.pipeThrough(commandFilter).pipeTo(commandSink);
    const displayDone = displayBranch.pipeThrough(displayFilter).pipeTo(displaySink);

    const subscriber = (markup: string) => {
      if (!closed && controllerRef) {
        controllerRef.enqueue(markup);
      }
    };
    this.#markupSubscribers.add(subscriber);

    return {
      emitMarkup: (element: string) => {
        if (!closed && controllerRef) {
          controllerRef.enqueue(element);
        }
      },
      emitDisplayFrame: (frame: Uint8Array) => {
        if (!closed && controllerRef) {
          controllerRef.enqueue(frame);
        }
      },
      close: async () => {
        this.#markupSubscribers.delete(subscriber);
        if (!closed && controllerRef) {
          closed = true;
          controllerRef.close();
        }
        await Promise.all([commandDone, displayDone]);
      },
    };
  }

  /**
   * Returns the active rolling-release plane manifest.
   */
  getRollingReleaseManifest(): RollingReleaseManifest {
    return {
      ...this.#rollingManifest,
      snapshotEpoch: this.#snapshotEpoch,
    };
  }

  /**
   * Stages a rolling-release plane update after validating `abiMagic === B8G_ABI_MAGIC_V3`
   * and `abiVersion >= 3`. Bumps `snapshotEpoch` and retains the previous manifest
   * for O(1) rollback via `rollbackRollingRelease()`.
   */
  stageRollingRelease(next: StageRollingReleaseInput): RollingReleaseManifest {
    if (next.abiMagic !== B8G_ABI_MAGIC_V3) {
      this.#lastError = SectiumCpError.ERR_INVALID_ARG;
      throw new RangeError(
        `Rolling release abiMagic mismatch: expected 0x${B8G_ABI_MAGIC_V3.toString(16).toUpperCase()}, got 0x${(next.abiMagic >>> 0).toString(16).toUpperCase()}`,
      );
    }
    if (!Number.isInteger(next.abiVersion) || next.abiVersion < B8G_CP_ABI_VERSION) {
      this.#lastError = SectiumCpError.ERR_INVALID_ARG;
      throw new RangeError(
        `Rolling release requires abiVersion >= ${B8G_CP_ABI_VERSION} (got ${String(next.abiVersion)})`,
      );
    }
    if (
      next.releaseChannel !== 'rolling' &&
      next.releaseChannel !== 'canary' &&
      next.releaseChannel !== 'stable'
    ) {
      this.#lastError = SectiumCpError.ERR_INVALID_ARG;
      throw new RangeError(
        `Invalid releaseChannel "${String(next.releaseChannel)}"`,
      );
    }
    if (next.planeVersion.trim().length === 0 || next.bundleSha256.trim().length === 0) {
      this.#lastError = SectiumCpError.ERR_INVALID_ARG;
      throw new RangeError(
        'stageRollingRelease requires non-empty planeVersion and bundleSha256',
      );
    }

    this.#previousManifest = {
      ...this.#rollingManifest,
      snapshotEpoch: this.#snapshotEpoch,
    };

    const nextEpoch =
      next.snapshotEpoch !== undefined && next.snapshotEpoch > this.#snapshotEpoch
        ? next.snapshotEpoch
        : this.#snapshotEpoch + 1;
    this.#snapshotEpoch = nextEpoch;

    this.#rollingManifest = {
      planeVersion: next.planeVersion.trim(),
      releaseChannel: next.releaseChannel,
      abiMagic: next.abiMagic,
      abiVersion: next.abiVersion,
      snapshotEpoch: this.#snapshotEpoch,
      bundleSha256: next.bundleSha256.trim(),
      publishedAt: next.publishedAt ?? new Date().toISOString(),
    };
    this.#lastError = SectiumCpError.OK;
    return { ...this.#rollingManifest };
  }

  /**
   * Performs an O(1) rollback to the immediately preceding rolling-release
   * manifest and restores its `.b8p` `snapshotEpoch`.
   */
  rollbackRollingRelease(): RollingReleaseManifest {
    if (!this.#previousManifest) {
      this.#lastError = SectiumCpError.ERR_NO_SNAPSHOT;
      throw new Error('No previous rolling release manifest available for rollback');
    }
    const restored = { ...this.#previousManifest };
    this.#rollingManifest = restored;
    this.#snapshotEpoch = restored.snapshotEpoch;
    this.#previousManifest = null;
    this.#lastError = SectiumCpError.OK;
    return { ...restored };
  }

  /**
   * Returns a flat, serializable status snapshot aligned with `SectiumCpStatus`.
   */
  getStatus(): SectiumCloudStatus {
    return {
      abiMagic: B8G_ABI_MAGIC_V3,
      abiVersion: B8G_CP_ABI_VERSION,
      endpoint: this.#endpoint,
      pipePath: this.#pipePath,
      online: this.isOnline,
      detached: this.#detached,
      warmResumed: this.#warmResumed,
      snapshotEpoch: this.#snapshotEpoch,
      arenaAlignBytes: B8G_ARENA_ALIGN_BYTES,
      commandPeers: this.#commandPeers.size,
      displayPeers: this.#displayPeers.size,
      devtoolsPeers: this.#devtoolsPeers.size,
      mainEntries: Array.from(this.#mainEntries.values(), (entry) => ({
        ...entry,
        ...(entry.args !== undefined ? { args: [...entry.args] } : {}),
      })),
      lastError: this.#lastError,
    };
  }

  /**
   * Executes the native C11 `dist/sectium-cp-probe.exe` binary (`shell: false`)
   * and validates `abi_magic === B8G_ABI_MAGIC_V3` (`0x33564742`).
   */
  async verifyNativeAbiProbe(
    probePathOverride?: string,
  ): Promise<SectiumNativeAbiProbeResult> {
    const targetPath = probePathOverride?.trim() || this.#probePath;
    const { stdout } = await execFileAsync(targetPath, [], {
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8',
    });

    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    const raw = JSON.parse(line) as Record<string, unknown>;
    const magic = parseAbiMagic(raw.abi_magic);

    if (magic.value !== B8G_ABI_MAGIC_V3) {
      throw new Error(
        `Native ABI magic mismatch: expected 0x${B8G_ABI_MAGIC_V3.toString(16).toUpperCase()}, got ${magic.hex}`,
      );
    }

    const result: SectiumNativeAbiProbeResult = {
      ok: raw.ok === true,
      abi_magic: magic.value,
      abi_magic_hex: magic.hex,
      abi_version: Number(raw.abi_version ?? 0),
      offline_rc: Number(raw.offline_rc ?? 0),
      online: Number(raw.online ?? 0),
      detached: Number(raw.detached ?? 0),
      warm_resumed: Number(raw.warm_resumed ?? 0),
      snapshot_epoch: Number(raw.snapshot_epoch ?? 0),
      command_peers: Number(raw.command_peers ?? 0),
      display_peers: Number(raw.display_peers ?? 0),
      devtools_peers: Number(raw.devtools_peers ?? 0),
      display_slot1: Number(raw.display_slot1 ?? 0),
      display_slot2: Number(raw.display_slot2 ?? 0),
      replaced_slot_id: Number(raw.replaced_slot_id ?? 0),
      last_error: Number(raw.last_error ?? 0),
      probePath: targetPath,
    };

    if (!result.ok || result.abi_version !== B8G_CP_ABI_VERSION) {
      throw new Error(
        `Native ABI probe reported failure: ok=${String(result.ok)}, abi_version=${result.abi_version}`,
      );
    }

    return result;
  }

  #broadcastMarkup(markup: string): void {
    for (const subscriber of this.#markupSubscribers) {
      subscriber(markup);
    }
  }
}

export interface ControlPlanePackageEnvOptions {
  readonly workspaceRoot?: string;
  readonly sectiumExePath?: string;
}

/**
 * Canonical Control-Plane-owned package & runtime environment for `pnpm` / `pnx` / `node`.
 * Keeps `PNPM_HOME`, store, and cache strictly inside `.b8g-cas/`, disables pnpm self-downloading
 * rogue Node/Electron/Chromium binaries, and binds all browser automation tools to shared Sectium.
 */
export function buildControlPlanePackageEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  opts: ControlPlanePackageEnvOptions = {},
): NodeJS.ProcessEnv {
  const workspaceRoot = opts.workspaceRoot ?? join(THIS_DIR, '..', '..');
  const casRoot = join(workspaceRoot, '.b8g-cas');
  const pnpmHome = join(casRoot, 'pnpm-home');
  const pnpmStore = join(casRoot, 'pnpm-store');
  const pnpmCache = join(casRoot, 'pnpm-cache');
  const denoDir = join(casRoot, 'deno-dir');
  const bunHome = join(casRoot, 'bun-home');
  const bunCache = join(casRoot, 'bun-cache');
  const uvCache = join(casRoot, 'uv-cache');
  const pythonHome = join(casRoot, 'python-home');
  const pipCache = join(casRoot, 'pip-cache');
  const sectiumCandidates = [
    opts.sectiumExePath,
    baseEnv.SECTIUM_PATH,
    'D:\\Sectium\\sectium.exe',
    'E:\\b8g-chromium-real\\src\\out\\B8gRelease\\sectium.exe',
  ].filter(Boolean) as string[];
  const sectiumExe = sectiumCandidates.find((c) => existsSync(c)) ?? 'D:\\Sectium\\sectium.exe';

  return {
    ...baseEnv,
    SECTIUM_CONTROL_PLANE_CAS_ROOT: casRoot,
    // Node & pnpm CAS governance
    PNPM_HOME: baseEnv.PNPM_HOME ?? pnpmHome,
    NPM_CONFIG_STORE_DIR: baseEnv.NPM_CONFIG_STORE_DIR ?? pnpmStore,
    NPM_CONFIG_CACHE: baseEnv.NPM_CONFIG_CACHE ?? pnpmCache,
    NPM_CONFIG_PREFER_OFFLINE: baseEnv.NPM_CONFIG_PREFER_OFFLINE ?? 'true',
    PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS: baseEnv.PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS ?? 'false',
    // Deno & Bun CAS governance
    DENO_DIR: baseEnv.DENO_DIR ?? denoDir,
    DENO_NO_UPDATE_CHECK: baseEnv.DENO_NO_UPDATE_CHECK ?? '1',
    BUN_INSTALL: baseEnv.BUN_INSTALL ?? bunHome,
    BUN_INSTALL_CACHE_DIR: baseEnv.BUN_INSTALL_CACHE_DIR ?? bunCache,
    // Python / uv / pip CAS governance
    UV_CACHE_DIR: baseEnv.UV_CACHE_DIR ?? uvCache,
    UV_PYTHON_INSTALL_DIR: baseEnv.UV_PYTHON_INSTALL_DIR ?? pythonHome,
    PIP_CACHE_DIR: baseEnv.PIP_CACHE_DIR ?? pipCache,
    PYTHONDONTWRITEBYTECODE: baseEnv.PYTHONDONTWRITEBYTECODE ?? '1',
    // Polyglot Sectium engines (ES, JVM/Kotlin/WASI)
    SECTIUM_ES_BIN: baseEnv.SECTIUM_ES_BIN ?? join(workspaceRoot, 'sections', 'b8g-es', 'dist', 'sectium-es.exe'),
    SECTIUM_JVM_BIN: baseEnv.SECTIUM_JVM_BIN ?? join(workspaceRoot, 'sections', 'b8g-jvm', 'dist', 'sectium-jvm.exe'),
    SECTIUM_JVM_WASM: baseEnv.SECTIUM_JVM_WASM ?? join(workspaceRoot, 'sections', 'b8g-jvm', 'dist', 'sectium-jvm.wasm'),
    // Suppress duplicate 200-350 MB browser downloads
    ELECTRON_SKIP_BINARY_DOWNLOAD: baseEnv.ELECTRON_SKIP_BINARY_DOWNLOAD ?? '1',
    PUPPETEER_SKIP_DOWNLOAD: baseEnv.PUPPETEER_SKIP_DOWNLOAD ?? '1',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: baseEnv.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD ?? '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: baseEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? '1',
    NWJS_SKIP_DOWNLOAD: baseEnv.NWJS_SKIP_DOWNLOAD ?? '1',
    PUPPETEER_EXECUTABLE_PATH: baseEnv.PUPPETEER_EXECUTABLE_PATH ?? sectiumExe,
    CHROME_BIN: baseEnv.CHROME_BIN ?? sectiumExe,
  };
}

export {
  B8G_SECTIUM_WEB_COMPONENTS,
  SectiumDeviceClient,
  SectiumDeviceHost,
  SectiumDeviceOfflineError,
  SectiumDevToolsPlane,
  buildSanitizedPowerOnEnv,
  createKittyInkWritableStream,
  encodeKittyGraphicsFrame,
  formatB8gSectiumCommandElement,
  formatB8gSectiumDevToolsElement,
  formatB8gSectiumDisplayElement,
  renderB8gElementToAnsi,
};
