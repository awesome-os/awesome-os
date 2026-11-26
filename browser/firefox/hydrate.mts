/**
 * @file browser/firefox/hydrate.mts
 * @description Zero-dependency erasable-TS Holo v11 hydrator and shared library
 *   verifier for Firefox (Gecko / Stylo / WebRender / Fission / RLBox).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const B8G_ABI_MAGIC_V3 = '0x33564742';

export const HOLO_INDEX_URL =
  process.env.B8G_HOLO_INDEX_URL ??
  'https://raw.githubusercontent.com/awesome-os/holo-v11/main/registry/index/cas-v11-global-manifest.json';

export const HOLO_CAS_BASE_URL =
  process.env.B8G_HOLO_CAS_URL ??
  'https://github.com/awesome-os/holo-v11/releases/download/v11-latest';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE_PATH = resolve(HERE, 'firefox-v11-profile.json');
export const MOZCONFIG_PATH = resolve(HERE, 'mozconfig.holo-v11');

export interface FirefoxSharedLibEntry {
  id: string;
  version: string;
  sharedLib: string;
  mozconfigFlag: string;
  casTier: 'v11';
  status: 'v11-shared';
  sharedByCount: number;
}

export interface FirefoxV11Profile {
  schema: string;
  abiMagic: string;
  casLayout: string;
  runtime: {
    id: string;
    name: string;
    totalLibs: number;
    coveredInV11: number;
    coveragePercent: number;
  };
  sharedLibraries: FirefoxSharedLibEntry[];
  policies: {
    DisableTelemetry: boolean;
    DisableFirefoxStudies: boolean;
    DisablePocket: boolean;
    DisableAppUpdate: boolean;
    DisableSystemAddonUpdate: boolean;
    DisableFirefoxAccounts: boolean;
    DisableFeedbackCommands: boolean;
    DontCheckDefaultBrowser: boolean;
    OfferToSaveLogins: boolean;
    UserMessaging: Record<string, boolean>;
    FirefoxHome: Record<string, boolean>;
    FirefoxSuggest: Record<string, boolean>;
    Preferences: Record<string, { Value: boolean | number | string; Status: string }>;
  };
  engineFlags: {
    gecko: Record<string, boolean | string>;
    stylo: Record<string, boolean | string>;
    webrender: Record<string, boolean | string>;
    fission: Record<string, boolean | number | string>;
    rlbox: {
      enabled: boolean;
      wasmSandboxing: boolean;
      mozconfigFlag: string;
      sandboxedModules: string[];
    };
  };
}

export interface HoloCasHistoryItem {
  sha512?: string;
  sha256?: string;
  bytes: number;
  version?: string;
  retired_at?: string;
}

export interface HoloCasEntry {
  filename: string;
  sha512?: string;
  sha256?: string;
  bytes?: number;
  size?: number;
  version?: string;
  download_url?: string;
  downloadUrl?: string;
  blobPath?: string;
  history?: HoloCasHistoryItem[];
}

export interface HoloIndex {
  schema: string;
  cas_base_url?: string;
  updated_at?: string;
  generatedAt?: string;
  total_entries?: number;
  totalAssets?: number;
  entries: Record<string, HoloCasEntry> | HoloCasEntry[];
}

export interface HydratedFirefoxResult {
  entry: HoloCasEntry;
  installDir: string;
  executablePath: string;
  cacheHit: boolean;
}

export interface VerifyDepsResult {
  ok: boolean;
  abiMagic: string;
  casLayout: string;
  totalLibs: number;
  coveredInV11: number;
  coveragePercent: number;
  missingMozconfigFlags: string[];
  telemetryStripped: boolean;
  rlboxWasmSandboxing: boolean;
  policiesZeroTelemetry: boolean;
  libraries: Array<{ id: string; version: string; sharedLib: string; mozconfigFlag: string; status: string }>;
}

let cachedIndex: HoloIndex | null = null;

export function loadFirefoxProfile(profilePath: string = PROFILE_PATH): FirefoxV11Profile {
  return JSON.parse(readFileSync(profilePath, 'utf8')) as FirefoxV11Profile;
}

export function loadMozconfig(mozconfigPath: string = MOZCONFIG_PATH): string {
  return readFileSync(mozconfigPath, 'utf8');
}

export function getCasCacheDir(overrideDir?: string): string {
  const dir = overrideDir ?? process.env.B8G_CAS_DIR ?? join(homedir(), '.b8g', 'cas');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveV11BlobPath(casDir: string, sha512Hex: string): string {
  const norm = sha512Hex.trim().toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(norm)) {
    throw new Error(`Invalid SHA-512 digest for v11 CAS: ${sha512Hex}`);
  }
  return join(casDir, 'v11', 'files', norm.slice(0, 2), norm);
}

export function getFirefoxAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'firefox-win64.tar.zst';
  if (platform === 'darwin') return 'firefox-macos-arm64.tar.zst';
  return arch === 'arm64' ? 'firefox-linux-arm64.tar.zst' : 'firefox-linux-x64.tar.zst';
}

export function getFirefoxExecutableRelPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'firefox.exe';
  if (platform === 'darwin') return join('Firefox.app', 'Contents', 'MacOS', 'firefox');
  return 'firefox';
}

export async function fetchHoloIndex(
  forceRefresh = false,
  fetchImpl: typeof fetch = fetch,
): Promise<HoloIndex> {
  const envIndexPath = process.env.B8G_CAS_INDEX_PATH;
  if (envIndexPath && existsSync(envIndexPath)) {
    const parsed = JSON.parse(readFileSync(envIndexPath, 'utf8')) as HoloIndex;
    cachedIndex = parsed;
    return parsed;
  }
  if (cachedIndex && !forceRefresh) {
    return cachedIndex;
  }
  const cacheFile = join(getCasCacheDir(), 'index.json');
  try {
    const res = await fetchImpl(HOLO_INDEX_URL, {
      headers: { 'User-Agent': 'awesome-os-firefox/0.1.0' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${HOLO_INDEX_URL}`);
    }
    const json = (await res.json()) as HoloIndex;
    try {
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
      renameSync(tmp, cacheFile);
    } catch {
      // Non-fatal if cache write races
    }
    cachedIndex = json;
    return json;
  } catch (err) {
    if (existsSync(cacheFile)) {
      cachedIndex = JSON.parse(readFileSync(cacheFile, 'utf8')) as HoloIndex;
      return cachedIndex;
    }
    throw err;
  }
}

export function applyKeepLast5Pin(entry: HoloCasEntry, pinnedDigest?: string): HoloCasEntry {
  const digest = pinnedDigest?.trim().toLowerCase();
  const current = (entry.sha512 ?? entry.sha256 ?? '').toLowerCase();
  if (!digest || digest === current) {
    return entry;
  }
  const hist = entry.history?.find(
    (h) => (h.sha512 ?? h.sha256 ?? '').toLowerCase() === digest,
  );
  if (hist) {
    const nextDigest = hist.sha512 ?? hist.sha256 ?? digest;
    return {
      ...entry,
      ...(hist.sha512 ? { sha512: hist.sha512 } : { sha256: hist.sha256 }),
      bytes: hist.bytes,
      version: hist.version ?? entry.version,
      download_url: `${HOLO_CAS_BASE_URL}/${nextDigest}`,
    };
  }
  return entry;
}

export async function tryResolveFirefoxEntry(
  assetKey = getFirefoxAssetKey(),
  index?: HoloIndex,
): Promise<HoloCasEntry | null> {
  const idx = index ?? (await fetchHoloIndex());
  const entry = Array.isArray(idx.entries)
    ? idx.entries.find((item) => item.filename === assetKey)
    : idx.entries[assetKey];
  if (!entry) {
    return null;
  }
  const pin = process.env.FIREFOX_HOLO_SHA512 ?? process.env.FIREFOX_HOLO_SHA256;
  return applyKeepLast5Pin(entry, pin);
}

export async function resolveFirefoxEntry(
  assetKey = getFirefoxAssetKey(),
  index?: HoloIndex,
): Promise<HoloCasEntry> {
  const idx = index ?? (await fetchHoloIndex());
  const entry = await tryResolveFirefoxEntry(assetKey, idx);
  if (!entry) {
    const count = Array.isArray(idx.entries) ? idx.entries.length : Object.keys(idx.entries).length;
    throw new Error(`Firefox asset "${assetKey}" not found in holo-v11 index (${count} entries).`);
  }
  return entry;
}

export function verifySharedV11Deps(
  profile: FirefoxV11Profile = loadFirefoxProfile(),
  mozconfig: string = loadMozconfig(),
): VerifyDepsResult {
  const missingMozconfigFlags: string[] = [];
  for (const lib of profile.sharedLibraries) {
    if (lib.mozconfigFlag.startsWith('--') && !mozconfig.includes(lib.mozconfigFlag)) {
      missingMozconfigFlags.push(lib.mozconfigFlag);
    }
  }

  const rlboxFlag = profile.engineFlags.rlbox.mozconfigFlag;
  const rlboxWasmSandboxing =
    profile.engineFlags.rlbox.enabled &&
    profile.engineFlags.rlbox.wasmSandboxing &&
    mozconfig.includes(rlboxFlag);
  if (!mozconfig.includes(rlboxFlag)) {
    missingMozconfigFlags.push(rlboxFlag);
  }

  const telemetryStripped =
    mozconfig.includes('--disable-crashreporter') &&
    mozconfig.includes('--disable-updater') &&
    mozconfig.includes('MOZ_TELEMETRY_REPORTING=');

  const policiesZeroTelemetry =
    profile.policies.DisableTelemetry === true &&
    profile.policies.DisableFirefoxStudies === true &&
    profile.policies.DisablePocket === true &&
    profile.policies.DisableAppUpdate === true &&
    profile.policies.DisableSystemAddonUpdate === true;

  const allCovered =
    profile.sharedLibraries.length === 24 &&
    profile.runtime.totalLibs === 24 &&
    profile.runtime.coveredInV11 === 24 &&
    profile.sharedLibraries.every((lib) => lib.casTier === 'v11' && lib.status === 'v11-shared');

  const ok =
    profile.abiMagic === B8G_ABI_MAGIC_V3 &&
    profile.casLayout === 'v11' &&
    allCovered &&
    missingMozconfigFlags.length === 0 &&
    telemetryStripped &&
    rlboxWasmSandboxing &&
    policiesZeroTelemetry;

  return {
    ok,
    abiMagic: profile.abiMagic,
    casLayout: profile.casLayout,
    totalLibs: profile.sharedLibraries.length,
    coveredInV11: profile.sharedLibraries.filter((lib) => lib.status === 'v11-shared').length,
    coveragePercent: profile.runtime.coveragePercent,
    missingMozconfigFlags,
    telemetryStripped,
    rlboxWasmSandboxing,
    policiesZeroTelemetry,
    libraries: profile.sharedLibraries.map((lib) => ({
      id: lib.id,
      version: lib.version,
      sharedLib: lib.sharedLib,
      mozconfigFlag: lib.mozconfigFlag,
      status: lib.status,
    })),
  };
}

function locateExtractedExecutable(
  installDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const candidates =
    platform === 'win32'
      ? [join(installDir, 'firefox.exe'), join(installDir, 'firefox', 'firefox.exe')]
      : platform === 'darwin'
        ? [join(installDir, 'Firefox.app', 'Contents', 'MacOS', 'firefox')]
        : [join(installDir, 'firefox'), join(installDir, 'firefox', 'firefox-bin')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function ensureFirefoxBinary(
  assetKey = getFirefoxAssetKey(),
): Promise<HydratedFirefoxResult> {
  const entry = await resolveFirefoxEntry(assetKey);
  const digest = entry.sha512 ?? entry.sha256;
  if (!digest) {
    throw new Error(`Firefox CAS entry "${assetKey}" is missing sha512/sha256 digest.`);
  }

  const cacheDir = getCasCacheDir();
  const installDir = join(cacheDir, 'firefox', digest);
  const existing = locateExtractedExecutable(installDir);
  if (existing) {
    return { entry, installDir, executablePath: existing, cacheHit: true };
  }

  const archivePath =
    entry.sha512 && /^[a-f0-9]{128}$/i.test(entry.sha512)
      ? resolveV11BlobPath(cacheDir, entry.sha512)
      : join(cacheDir, `${digest}.tar.zst`);

  if (!existsSync(archivePath)) {
    const url = entry.download_url ?? entry.downloadUrl ?? `${HOLO_CAS_BASE_URL}/${digest}`;
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'awesome-os-firefox/0.1.0' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} hydrating ${entry.filename} from ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const algo = entry.sha512 ? 'sha512' : 'sha256';
    const actual = createHash(algo).update(buf).digest('hex');
    if (actual !== digest.toLowerCase()) {
      throw new Error(`${algo.toUpperCase()} mismatch for ${entry.filename}: expected ${digest}, got ${actual}`);
    }
    mkdirSync(dirname(archivePath), { recursive: true });
    const tmp = `${archivePath}.${process.pid}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, archivePath);
  }

  mkdirSync(installDir, { recursive: true });
  execFileSync('tar', ['--zstd', '-xf', archivePath, '-C', installDir], { stdio: 'inherit' });

  const executablePath = locateExtractedExecutable(installDir);
  if (!executablePath) {
    throw new Error(
      `Extracted Firefox archive missing expected binary: ${join(installDir, getFirefoxExecutableRelPath())}`,
    );
  }
  return { entry, installDir, executablePath, cacheHit: false };
}
