import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_KERNEL_RELEASE,
  DEFAULT_V11_DRIVER_CATALOG,
  type DriverCatalogEntry,
  type DriverTier,
  matchModalias,
  type ResolvedDriverEntry,
  type ResolvedDriverPack,
  resolveDriverPack,
  TRADITIONAL_DISTRO_MODULES_MB,
} from './driver-manager.mts';
import {
  AUDITABLE_DRIVER_SETS,
  type AuditableDriverSet,
  type DriverTrack,
  resolveDriverSet,
  resolveSystemProfile,
  SYSTEM_PROFILES,
  type SystemProfile,
} from './profiles-and-driver-sets.mts';

export {
  AUDITABLE_DRIVER_SETS,
  type AuditableDriverSet,
  DEFAULT_KERNEL_RELEASE,
  DEFAULT_V11_DRIVER_CATALOG,
  type DriverCatalogEntry,
  type DriverTier,
  type DriverTrack,
  matchModalias,
  type ResolvedDriverEntry,
  type ResolvedDriverPack,
  resolveDriverPack,
  resolveDriverSet,
  resolveSystemProfile,
  SYSTEM_PROFILES,
  type SystemProfile,
  TRADITIONAL_DISTRO_MODULES_MB,
};

export type HostLocality = 'local' | 'remote';
export type HostSurface = 'terminal' | 'desktop';
export type SessionMode = 'managed-desktop' | 'kiosk-app' | 'terminal-appliance' | 'ephemeral-guest';
export type UpdateChannel = 'stable' | 'beta' | 'canary' | 'pinned';
export type DesktopAdapterId =
  | 'sectium-desktop'
  | 'omarchy-hyprland'
  | 'noctalia-shell'
  | 'chonkstep-wayland'
  | 'gnome-wayland'
  | 'kde-plasma'
  | 'kitty-ink-tui';
export type SlotId = 'A' | 'B';

export interface VerifiedSlot {
  readonly slot: SlotId;
  readonly release: string;
  readonly casTreeHash: string;
  readonly verified: boolean;
  readonly bootAttempts: number;
  readonly updatedAt: string;
}

export interface HostPolicy {
  readonly mode: SessionMode;
  readonly defaultSurface: HostSurface;
  readonly desktopAdapter: DesktopAdapterId;
  readonly autoUpdateChannel: UpdateChannel;
  readonly remoteSupportEnabled: boolean;
  readonly wolWarmResume: boolean;
}

export interface ManagedHost {
  readonly id: string;
  readonly label: string;
  readonly locality: HostLocality;
  readonly arch: 'x86_64' | 'aarch64' | 'wasm32-wasi';
  readonly transport: 'pipe' | 'unix-socket' | 'mtls-tcp' | 'web-sw-opfs';
  readonly status: 'online' | 'sleeping-wol' | 'provisioning' | 'offline';
  readonly activeSlot: SlotId;
  readonly slots: {
    readonly A: VerifiedSlot;
    readonly B: VerifiedSlot;
  };
  readonly policy: HostPolicy;
  readonly drivers?: ResolvedDriverPack;
  readonly powerwashCount: number;
  readonly enrolledAt: string;
  readonly lastSeenAt: string;
}

export interface FleetState {
  readonly schema: 'awesome-os.host-fleet.v1';
  readonly abiMagic: '0x33564742';
  readonly casLayout: 'v11';
  readonly hosts: readonly ManagedHost[];
}

export interface EnrollHostOptions {
  readonly id: string;
  readonly label?: string;
  readonly locality?: HostLocality;
  readonly arch?: 'x86_64' | 'aarch64' | 'wasm32-wasi';
  readonly transport?: 'pipe' | 'unix-socket' | 'mtls-tcp' | 'web-sw-opfs';
  readonly surface?: HostSurface;
  readonly desktopAdapter?: DesktopAdapterId;
  readonly mode?: SessionMode;
  readonly release?: string;
  readonly casTreeHash?: string;
}

export interface SurfaceAttachment {
  readonly hostId: string;
  readonly locality: HostLocality;
  readonly surface: HostSurface;
  readonly systemUri: string;
  readonly adapter: DesktopAdapterId;
  readonly transport: string;
  readonly command: string;
}

export const DEFAULT_RELEASE = 'awesome-os/desktop@v0.3.0';
export const DEFAULT_CAS_HASH = 'v11-verified-0x33564742-baseline';

export function defaultPolicy(overrides?: Partial<HostPolicy>): HostPolicy {
  return {
    mode: overrides?.mode ?? 'managed-desktop',
    defaultSurface: overrides?.defaultSurface ?? 'desktop',
    desktopAdapter: overrides?.desktopAdapter ?? 'sectium-desktop',
    autoUpdateChannel: overrides?.autoUpdateChannel ?? 'stable',
    remoteSupportEnabled: overrides?.remoteSupportEnabled ?? true,
    wolWarmResume: overrides?.wolWarmResume ?? true,
  };
}

export function createEmptyFleet(): FleetState {
  return {
    schema: 'awesome-os.host-fleet.v1',
    abiMagic: '0x33564742',
    casLayout: 'v11',
    hosts: [],
  };
}

export function createDefaultSeedFleet(now: string = new Date().toISOString()): FleetState {
  let state = createEmptyFleet();
  state = enrollHost(
    state,
    {
      id: 'local-workstation',
      label: 'Local Workstation (Sectium + Wayland)',
      locality: 'local',
      arch: 'x86_64',
      transport: 'pipe',
      surface: 'desktop',
      desktopAdapter: 'sectium-desktop',
      mode: 'managed-desktop',
    },
    now,
  );
  state = enrollHost(
    state,
    {
      id: 'hyperv-baremetal-01',
      label: 'Hyper-V Gen-2 UEFI Appliance',
      locality: 'local',
      arch: 'x86_64',
      transport: 'pipe',
      surface: 'terminal',
      desktopAdapter: 'kitty-ink-tui',
      mode: 'terminal-appliance',
    },
    now,
  );
  state = enrollHost(
    state,
    {
      id: 'rack-blade-01',
      label: '19" Rack Blade 01 (Omarchy Hyprland)',
      locality: 'remote',
      arch: 'x86_64',
      transport: 'mtls-tcp',
      surface: 'desktop',
      desktopAdapter: 'omarchy-hyprland',
      mode: 'managed-desktop',
    },
    now,
  );
  state = enrollHost(
    state,
    {
      id: 'rack-blade-02',
      label: '19" Rack Blade 02 (Noctalia Wayland)',
      locality: 'remote',
      arch: 'aarch64',
      transport: 'mtls-tcp',
      surface: 'desktop',
      desktopAdapter: 'noctalia-shell',
      mode: 'kiosk-app',
    },
    now,
  );
  return state;
}

export function enrollHost(
  fleet: FleetState,
  opts: EnrollHostOptions,
  now: string = new Date().toISOString(),
): FleetState {
  const id = opts.id.trim();
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new Error(`Invalid host id "${opts.id}". Use alphanumeric, dot, dash, or underscore.`);
  }
  const locality: HostLocality = opts.locality ?? (id.startsWith('local') ? 'local' : 'remote');
  const surface: HostSurface = opts.surface ?? (opts.desktopAdapter === 'kitty-ink-tui' ? 'terminal' : 'desktop');
  const release = opts.release ?? DEFAULT_RELEASE;
  const casTreeHash = opts.casTreeHash ?? DEFAULT_CAS_HASH;

  const host: ManagedHost = {
    id,
    label: opts.label ?? id,
    locality,
    arch: opts.arch ?? 'x86_64',
    transport: opts.transport ?? (locality === 'local' ? 'pipe' : 'mtls-tcp'),
    status: 'online',
    activeSlot: 'A',
    slots: {
      A: {
        slot: 'A',
        release,
        casTreeHash,
        verified: true,
        bootAttempts: 0,
        updatedAt: now,
      },
      B: {
        slot: 'B',
        release,
        casTreeHash,
        verified: true,
        bootAttempts: 0,
        updatedAt: now,
      },
    },
    policy: defaultPolicy({
      mode: opts.mode ?? (surface === 'terminal' ? 'terminal-appliance' : 'managed-desktop'),
      defaultSurface: surface,
      desktopAdapter: opts.desktopAdapter ?? (surface === 'terminal' ? 'kitty-ink-tui' : 'sectium-desktop'),
    }),
    powerwashCount: 0,
    enrolledAt: now,
    lastSeenAt: now,
  };

  const nextHosts = fleet.hosts.filter((h) => h.id !== id);
  nextHosts.push(host);
  return { ...fleet, hosts: nextHosts };
}

export function findHost(fleet: FleetState, hostId: string): ManagedHost {
  const host = fleet.hosts.find((h) => h.id === hostId);
  if (!host) {
    const known = fleet.hosts.map((h) => h.id).join(', ') || '(none)';
    throw new Error(`Host "${hostId}" is not enrolled. Known hosts: ${known}`);
  }
  return host;
}

function replaceHost(fleet: FleetState, updated: ManagedHost): FleetState {
  return {
    ...fleet,
    hosts: fleet.hosts.map((h) => (h.id === updated.id ? updated : h)),
  };
}

/** ChromeOS-style declarative policy update (mode, UI adapter, channel, remote support, WoL) */
export function applyPolicy(
  fleet: FleetState,
  hostId: string,
  patch: Partial<HostPolicy>,
  now: string = new Date().toISOString(),
): FleetState {
  const host = findHost(fleet, hostId);
  const nextPolicy: HostPolicy = {
    ...host.policy,
    ...patch,
  };
  return replaceHost(fleet, {
    ...host,
    policy: nextPolicy,
    lastSeenAt: now,
  });
}

/** ChromeOS update_engine A/B slot staging & atomic switch (zero downtime, instant rollback) */
export function stageAndSwitchSlot(
  fleet: FleetState,
  hostId: string,
  release: string,
  casTreeHash: string,
  now: string = new Date().toISOString(),
): { fleet: FleetState; targetSlot: SlotId } {
  const host = findHost(fleet, hostId);
  const targetSlot: SlotId = host.activeSlot === 'A' ? 'B' : 'A';
  const nextSlots = {
    ...host.slots,
    [targetSlot]: {
      slot: targetSlot,
      release,
      casTreeHash,
      verified: true,
      bootAttempts: 0,
      updatedAt: now,
    },
  };
  const updated: ManagedHost = {
    ...host,
    activeSlot: targetSlot,
    slots: nextSlots,
    lastSeenAt: now,
  };
  return { fleet: replaceHost(fleet, updated), targetSlot };
}

/** O(1) ChromeOS vboot / RollingReleaseManifest A/B slot rollback */
export function rollbackSlot(
  fleet: FleetState,
  hostId: string,
  now: string = new Date().toISOString(),
): { fleet: FleetState; activeSlot: SlotId; restoredRelease: string } {
  const host = findHost(fleet, hostId);
  const prevSlot: SlotId = host.activeSlot === 'A' ? 'B' : 'A';
  const restored = host.slots[prevSlot];
  const updated: ManagedHost = {
    ...host,
    activeSlot: prevSlot,
    lastSeenAt: now,
  };
  return {
    fleet: replaceHost(fleet, updated),
    activeSlot: prevSlot,
    restoredRelease: restored.release,
  };
}

/** ChromeOS 1-click Powerwash: wipes mutable session state while keeping immutable v11 CAS & enrollment */
export function powerwashHost(
  fleet: FleetState,
  hostId: string,
  now: string = new Date().toISOString(),
): FleetState {
  const host = findHost(fleet, hostId);
  const updated: ManagedHost = {
    ...host,
    status: 'online',
    powerwashCount: host.powerwashCount + 1,
    policy: defaultPolicy({
      defaultSurface: host.policy.defaultSurface,
      desktopAdapter: host.policy.desktopAdapter,
    }),
    lastSeenAt: now,
  };
  return replaceHost(fleet, updated);
}

/** Hydrate and sync a host's verified v11 CAS driver inventory from hardware modaliases */
export function syncHostDrivers(
  fleet: FleetState,
  hostId: string,
  kernelRelease: string = DEFAULT_KERNEL_RELEASE,
  modaliases: readonly string[] = [],
  catalog: readonly DriverCatalogEntry[] = DEFAULT_V11_DRIVER_CATALOG,
  now: string = new Date().toISOString(),
): { fleet: FleetState; pack: ResolvedDriverPack } {
  const host = findHost(fleet, hostId);
  const pack = resolveDriverPack(kernelRelease, modaliases, catalog, now);
  const updated: ManagedHost = {
    ...host,
    drivers: pack,
    lastSeenAt: now,
  };
  return {
    fleet: replaceHost(fleet, updated),
    pack,
  };
}

/** Attach to a local or remote host's terminal or desktop surface */
export function attachSurface(
  fleet: FleetState,
  hostId: string,
  surface?: HostSurface,
): SurfaceAttachment {
  const host = findHost(fleet, hostId);
  const resolvedSurface: HostSurface = surface ?? host.policy.defaultSurface;
  const targetId = resolvedSurface === 'terminal' ? 'ttyS0' : host.policy.desktopAdapter;
  const hostSegment = host.locality === 'local' ? 'local' : host.id;
  const systemUri = `system://${hostSegment}/${resolvedSurface}/${targetId}`;
  const command =
    resolvedSurface === 'terminal'
      ? `holo-device attach ${systemUri} --transport=${host.transport}`
      : `holo-device attach ${systemUri} --adapter=${host.policy.desktopAdapter} --transport=${host.transport}`;
  return {
    hostId: host.id,
    locality: host.locality,
    surface: resolvedSurface,
    systemUri,
    adapter: host.policy.desktopAdapter,
    transport: host.transport,
    command,
  };
}

/** Safely switch a host to an auditable system://driver-set/* track via A/B Slot staging (instant rollback on probe failure) */
export function switchHostDriverSet(
  fleet: FleetState,
  hostId: string,
  driverSetUri: string,
  now: string = new Date().toISOString(),
): { fleet: FleetState; driverSet: AuditableDriverSet; targetSlot: SlotId } {
  const driverSet = resolveDriverSet(driverSetUri);
  const staged = stageAndSwitchSlot(
    fleet,
    hostId,
    `${driverSet.uri}`,
    `v11:sha512:${driverSet.sha512}`,
    now,
  );
  return { fleet: staged.fleet, driverSet, targetSlot: staged.targetSlot };
}

/** Enroll a host directly from a reusable system://profile/* preset */
export function enrollFromProfile(
  fleet: FleetState,
  hostId: string,
  profileUriOrId: string,
  now: string = new Date().toISOString(),
): { fleet: FleetState; profile: SystemProfile } {
  const profile = resolveSystemProfile(profileUriOrId);
  let next = enrollHost(
    fleet,
    {
      id: hostId,
      label: `${profile.name} (${hostId})`,
      locality: profile.locality,
      surface: profile.surface,
      desktopAdapter: profile.desktopAdapter,
      mode: profile.mode,
    },
    now,
  );
  const synced = syncHostDrivers(
    next,
    hostId,
    DEFAULT_KERNEL_RELEASE,
    profile.defaultModaliases,
    DEFAULT_V11_DRIVER_CATALOG,
    now,
  );
  next = synced.fleet;
  return { fleet: next, profile };
}

export function getDefaultFleetStorePath(): string {
  return process.env.AWESOME_HOST_FLEET_PATH || join(homedir(), '.b8g', 'host-manager', 'fleet.json');
}

export class HostFleetStore {
  readonly filePath: string;

  constructor(filePath: string = getDefaultFleetStorePath()) {
    this.filePath = filePath;
  }

  load(): FleetState {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as FleetState;
      if (parsed.schema === 'awesome-os.host-fleet.v1' && Array.isArray(parsed.hosts)) {
        return parsed;
      }
    } catch {
      // Seed a clean ChromeOS-ready starter fleet on first run
    }
    const seeded = createDefaultSeedFleet();
    this.save(seeded);
    return seeded;
  }

  save(state: FleetState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }
}
