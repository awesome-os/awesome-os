#!/usr/bin/env node
/**
 * holo-device-launch.mts — Native Virtual Device Monitor Launcher
 *
 * Boots any Awesome-OS desktop / v11-tree app inside a dedicated, frameless,
 * extension-free Virtual Device Monitor window (own isolated profile, zero browser
 * tabs, zero URL bar) so local desktop runs share the exact same runtime and boundary
 * as the browser virtual device.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DeviceLaunchOptions {
  appId: string;
  targetUrl: string;
  width?: number;
  height?: number;
  fullscreen?: boolean;
  dryRun?: boolean;
}

export function resolveDeviceHostBinary(): { bin: string; kind: 'sectium' | 'edge-app' | 'chrome-app' } | null {
  const candidates: Array<{ bin: string; kind: 'sectium' | 'edge-app' | 'chrome-app' }> = [
    { bin: 'D:\\Sectium\\sectium.exe', kind: 'sectium' },
    { bin: path.join(os.homedir(), 'Sectium', 'sectium.exe'), kind: 'sectium' },
    { bin: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', kind: 'edge-app' },
    { bin: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', kind: 'edge-app' },
    { bin: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', kind: 'chrome-app' },
    { bin: '/usr/bin/chromium', kind: 'chrome-app' },
    { bin: '/usr/bin/google-chrome', kind: 'chrome-app' },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.bin)) return c;
  }
  return null;
}

export function launchVirtualDevice(opts: DeviceLaunchOptions): { bin: string; args: string[]; profileDir: string; launched: boolean } {
  const host = resolveDeviceHostBinary();
  if (!host) {
    throw new Error('holo-device: no Sectium or Chromium/Edge app-mode host binary found');
  }
  const safeId = opts.appId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const profileDir = path.join(os.homedir(), '.b8g', 'devices', safeId);
  fs.mkdirSync(profileDir, { recursive: true });

  const w = opts.width || 1440;
  const h = opts.height || 900;
  const args = [
    `--app=${opts.targetUrl}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${w},${h}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-sync',
    '--disable-features=Translate,TranslateUI,OptimizationGuideModelDownloading',
    '--enable-unsafe-webgpu',
    ...(opts.fullscreen ? ['--start-fullscreen'] : []),
  ];

  if (!opts.dryRun) {
    const child = spawn(host.bin, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();
  }

  return { bin: host.bin, args, profileDir, launched: !opts.dryRun };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).toLowerCase()
) {
  const args = process.argv.slice(2);
  const appId = args[0];
  const targetUrl = args[1];
  if (!appId || !targetUrl || appId === '--help') {
    console.log('Usage: holo-device <app-id> <url-or-file-uri> [--fullscreen] [--dry-run]');
    process.exit(0);
  }
  const res = launchVirtualDevice({
    appId,
    targetUrl,
    fullscreen: args.includes('--fullscreen'),
    dryRun: args.includes('--dry-run'),
  });
  console.log(`[holo-device] Powered on Virtual Device Monitor "${appId}"`);
  console.log(`  Host:    ${res.bin} (--app frameless mode, 0 extensions)`);
  console.log(`  Profile: ${res.profileDir}`);
  console.log(`  Target:  ${targetUrl}`);
}
