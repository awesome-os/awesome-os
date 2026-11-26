#!/usr/bin/env node
/**
 * @file browser/firefox/cli.mts
 * @description Zero-dependency CLI for AwesomeOS Firefox on Holo v11 CAS:
 *   - Supports --dry-run, --version, --mozconfig, --verify-deps, --help
 *   - Hydrates and launches debloated Firefox with enterprise zero-telemetry policy
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  B8G_ABI_MAGIC_V3,
  ensureFirefoxBinary,
  fetchHoloIndex,
  getCasCacheDir,
  getFirefoxAssetKey,
  getFirefoxExecutableRelPath,
  loadFirefoxProfile,
  loadMozconfig,
  tryResolveFirefoxEntry,
  verifySharedV11Deps,
} from './hydrate.mts';

export const FIREFOX_CLI_VERSION = '0.1.0';

export const DEFAULT_FIREFOX_FLAGS: readonly string[] = ['-no-remote'];

export interface ParsedCliArgs {
  dryRun: boolean;
  showVersion: boolean;
  showHelp: boolean;
  showMozconfig: boolean;
  verifyDeps: boolean;
  forwardArgs: string[];
}

export interface LaunchPlan {
  version: string;
  abiMagic: string;
  casLayout: string;
  cacheDir: string;
  defaultFlags: string[];
  sharedLibsCount: number;
  telemetryDisabled: boolean;
  rlboxWasmSandboxing: boolean;
  firefox: {
    assetKey: string;
    status: 'resolved' | 'pending-ingest';
    digest: string | null;
    bytes: number | null;
    browserVersion: string | null;
    executablePath: string | null;
  };
  forwardArgs: string[];
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const forwardArgs: string[] = [];
  let dryRun = false;
  let showVersion = false;
  let showHelp = false;
  let showMozconfig = false;
  let verifyDeps = false;
  let passthrough = false;

  for (const arg of argv) {
    if (!passthrough && arg === '--') {
      passthrough = true;
      forwardArgs.push(arg);
      continue;
    }
    if (!passthrough && arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!passthrough && (arg === '--version' || arg === '-v')) {
      showVersion = true;
      continue;
    }
    if (!passthrough && (arg === '--help' || arg === '-h')) {
      showHelp = true;
      continue;
    }
    if (!passthrough && arg === '--mozconfig') {
      showMozconfig = true;
      continue;
    }
    if (!passthrough && arg === '--verify-deps') {
      verifyDeps = true;
      continue;
    }
    forwardArgs.push(arg);
  }

  return {
    dryRun,
    showVersion,
    showHelp,
    showMozconfig,
    verifyDeps,
    forwardArgs,
  };
}

export async function buildLaunchPlan(parsed: ParsedCliArgs): Promise<LaunchPlan> {
  const profile = loadFirefoxProfile();
  const idx = await fetchHoloIndex();
  const cacheDir = getCasCacheDir();
  const assetKey = getFirefoxAssetKey();
  const entry = await tryResolveFirefoxEntry(assetKey, idx);
  const digest = entry ? (entry.sha512 ?? entry.sha256 ?? null) : null;
  const executablePath = digest
    ? join(cacheDir, 'firefox', digest, getFirefoxExecutableRelPath())
    : null;

  return {
    version: FIREFOX_CLI_VERSION,
    abiMagic: B8G_ABI_MAGIC_V3,
    casLayout: 'v11',
    cacheDir,
    defaultFlags: [...DEFAULT_FIREFOX_FLAGS],
    sharedLibsCount: profile.sharedLibraries.length,
    telemetryDisabled: profile.policies.DisableTelemetry,
    rlboxWasmSandboxing: profile.engineFlags.rlbox.wasmSandboxing,
    firefox: {
      assetKey,
      status: entry ? 'resolved' : 'pending-ingest',
      digest,
      bytes: entry ? (entry.bytes ?? entry.size ?? null) : null,
      browserVersion: entry?.version ?? null,
      executablePath,
    },
    forwardArgs: parsed.forwardArgs,
  };
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);

  if (parsed.showVersion) {
    console.log(
      `@awesome-os/firefox ${FIREFOX_CLI_VERSION} (${process.platform}/${process.arch} | magic=${B8G_ABI_MAGIC_V3} | firefox=${getFirefoxAssetKey()})`,
    );
    return;
  }

  if (parsed.showHelp) {
    console.log(
      [
        `firefox ${FIREFOX_CLI_VERSION} — Debloated Firefox (Gecko/WebRender/Fission/RLBox) on Holo v11 CAS`,
        '',
        'Usage: node browser/firefox/cli.mts [options] [urls/flags...]',
        '',
        'Options:',
        '  --dry-run      Resolve CAS entry and print launch plan JSON without launching',
        '  --mozconfig    Print canonical mozconfig.holo-v11 build configuration',
        '  --verify-deps  Verify 24/24 shared v11 libraries, mozconfig flags, and zero-telemetry policies',
        '  -v, --version  Print version, ABI magic, and platform CAS asset key',
        '  -h, --help     Show this help message',
      ].join('\n'),
    );
    return;
  }

  if (parsed.showMozconfig) {
    process.stdout.write(loadMozconfig());
    return;
  }

  if (parsed.verifyDeps) {
    const result = verifySharedV11Deps();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.dryRun) {
    const plan = await buildLaunchPlan(parsed);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const firefox = await ensureFirefoxBinary();
  const child = spawn(firefox.executablePath, [...DEFAULT_FIREFOX_FLAGS, ...parsed.forwardArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      B8G_CAS_DIR: getCasCacheDir(),
      MOZ_ENABLE_WAYLAND: '1',
      MOZ_DISABLE_TELEMETRY: '1',
    },
  });
  child.unref();
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  await runCli();
}
