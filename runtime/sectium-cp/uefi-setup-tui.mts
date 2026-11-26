/**
 * @file sections/sectium-cloud-control-plane/uefi-setup-tui.mts
 * @description Low-Resolution UEFI / Proxmox Setup Utility for `sectium-cloud-control-plane`.
 *
 * Designed to run identically on:
 *   - 80x25 serial console (`ttyS0` / IPMI / SSH)
 *   - 640x480 low-res Proxmox noVNC / UEFI GOP framebuffer
 *   - Kitty-Ink TUI (`channel: 'command'`)
 *
 * Lets operators configure a Sectium Host Device (Proxmox node/VMID, low-res display mode,
 * WoL warm-RAM resume epoch, transport pipe/mTLS endpoint, rolling-release channel, and
 * `mainEntry` bootstrap) with zero GUI dependency.
 *
 * Strictly `erasableSyntaxOnly: true` & zero external dependencies.
 */

export type UefiDisplayMode = 'lores-80x25' | 'lores-640x480' | 'kitty-ink' | 'sectium-canvas';

export interface ProxmoxUefiConfig {
  readonly nodeName: string;
  readonly vmid: number;
  readonly bridge: string;
  readonly displayMode: UefiDisplayMode;
  readonly vfioGpuPassthrough: boolean;
  readonly transportEndpoint: string;
  readonly releaseChannel: 'rolling' | 'canary' | 'stable';
  readonly warmRamResume: boolean;
  readonly mainEntryId: string;
}

export interface UefiMenuActionResult {
  readonly config: ProxmoxUefiConfig;
  readonly message: string;
  readonly bootRequested: boolean;
}

export const DEFAULT_PROXMOX_UEFI_CONFIG: ProxmoxUefiConfig = {
  nodeName: 'pve-sectium-01',
  vmid: 8001,
  bridge: 'vmbr0',
  displayMode: 'lores-640x480',
  vfioGpuPassthrough: false,
  transportEndpoint: '\\\\.\\pipe\\sectium-dev',
  releaseChannel: 'rolling',
  warmRamResume: true,
  mainEntryId: 'sectium-canvas',
};

const DISPLAY_MODES: readonly UefiDisplayMode[] = [
  'lores-80x25',
  'lores-640x480',
  'kitty-ink',
  'sectium-canvas',
];

const CHANNELS: readonly ('rolling' | 'canary' | 'stable')[] = ['rolling', 'canary', 'stable'];

function padLine(text: string, width: number): string {
  const inner = width - 4;
  const clipped = text.length > inner ? text.slice(0, inner) : text.padEnd(inner, ' ');
  return `| ${clipped} |`;
}

/**
 * Renders a classic 80x25 UEFI / Proxmox BIOS-style configuration screen in plain
 * ASCII/ANSI so it works over serial `ttyS0`, Proxmox noVNC 640x480, and SSH.
 */
export function renderUefiSetupScreen(
  cfg: ProxmoxUefiConfig,
  opts: { readonly width?: number; readonly ansi?: boolean; readonly statusLine?: string } = {},
): string {
  const width = Math.max(60, Math.min(80, opts.width ?? 78));
  const border = `+${'-'.repeat(width - 2)}+`;
  const lines = [
    border,
    padLine('SECTIUM CLOUD CONTROL PLANE — UEFI / PROXMOX SETUP (B8G_ABI_MAGIC_V3)', width),
    border,
    padLine(`[1] Proxmox Node / VMID   : ${cfg.nodeName} (VMID ${cfg.vmid}, ${cfg.bridge})`, width),
    padLine(`[2] Display Mode (Lo-Res) : ${cfg.displayMode}`, width),
    padLine(`[3] VFIO GPU Passthrough  : ${cfg.vfioGpuPassthrough ? 'ENABLED' : 'DISABLED (Safe Lo-Res)'}`, width),
    padLine(`[4] Control Pipe / mTLS   : ${cfg.transportEndpoint}`, width),
    padLine(`[5] Rolling Channel       : ${cfg.releaseChannel}`, width),
    padLine(`[6] Warm-RAM .b8p Resume  : ${cfg.warmRamResume ? 'ENABLED (O(1) Resume)' : 'COLD INIT'}`, width),
    padLine(`[7] Bootstrap mainEntry   : ${cfg.mainEntryId}`, width),
    border,
    padLine('[B] Save & Boot Detached Sectium Host Device   [R] Reset Defaults', width),
    padLine(`Status: ${opts.statusLine ?? 'Ready (Opaque Remote Peer Mode)'}`, width),
    border,
  ];
  const raw = lines.join('\n');
  if (opts.ansi) {
    return `\x1b[38;2;56;189;248m${raw}\x1b[0m`;
  }
  return raw;
}

/**
 * Pure state-transition handler for single-key UEFI console commands (`1`–`7`, `B`, `R`).
 */
export function applyUefiSetupKey(
  cfg: ProxmoxUefiConfig,
  key: string,
  value?: string,
): UefiMenuActionResult {
  const k = key.trim().toUpperCase();
  if (k === '1' && value) {
    return { config: { ...cfg, nodeName: value.trim() }, message: `Updated Proxmox node -> ${value.trim()}`, bootRequested: false };
  }
  if (k === '2') {
    const idx = DISPLAY_MODES.indexOf(cfg.displayMode);
    const next = DISPLAY_MODES[(idx + 1) % DISPLAY_MODES.length];
    return { config: { ...cfg, displayMode: next }, message: `Display mode -> ${next}`, bootRequested: false };
  }
  if (k === '3') {
    const next = !cfg.vfioGpuPassthrough;
    return { config: { ...cfg, vfioGpuPassthrough: next }, message: `VFIO GPU Passthrough -> ${next ? 'ENABLED' : 'DISABLED'}`, bootRequested: false };
  }
  if (k === '4' && value) {
    return { config: { ...cfg, transportEndpoint: value.trim() }, message: `Transport endpoint -> ${value.trim()}`, bootRequested: false };
  }
  if (k === '5') {
    const idx = CHANNELS.indexOf(cfg.releaseChannel);
    const next = CHANNELS[(idx + 1) % CHANNELS.length];
    return { config: { ...cfg, releaseChannel: next }, message: `Release channel -> ${next}`, bootRequested: false };
  }
  if (k === '6') {
    const next = !cfg.warmRamResume;
    return { config: { ...cfg, warmRamResume: next }, message: `Warm-RAM .b8p Resume -> ${next ? 'ENABLED' : 'COLD INIT'}`, bootRequested: false };
  }
  if (k === '7' && value) {
    return { config: { ...cfg, mainEntryId: value.trim() }, message: `mainEntry -> ${value.trim()}`, bootRequested: false };
  }
  if (k === 'R') {
    return { config: { ...DEFAULT_PROXMOX_UEFI_CONFIG }, message: 'Reset to safe Lo-Res defaults', bootRequested: false };
  }
  if (k === 'B') {
    return { config: cfg, message: `Booting detached Sectium Host Device (${cfg.displayMode})...`, bootRequested: true };
  }
  return { config: cfg, message: `Unknown UEFI setup key: ${key}`, bootRequested: false };
}

/**
 * Emits declarative HTML5 `<b8g-sectium-uefi-setup data-*>` element so the exact same
 * UEFI/Proxmox setup state renders identically in Sectium DOM, Kitty-Ink TUI, or serial console.
 */
export function formatB8gUefiSetupElement(cfg: ProxmoxUefiConfig): string {
  return `<b8g-sectium-uefi-setup data-node="${cfg.nodeName}" data-vmid="${cfg.vmid}" data-display-mode="${cfg.displayMode}" data-vfio="${cfg.vfioGpuPassthrough}" data-channel="${cfg.releaseChannel}" data-warm-ram="${cfg.warmRamResume}" data-main-entry="${cfg.mainEntryId}"></b8g-sectium-uefi-setup>`;
}
