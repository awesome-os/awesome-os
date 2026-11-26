/**
 * @file holo-ffi.mts
 * @description Standalone zero-dependency Awesome-OS Holo-FFI (`v11` CAS loader + hardlink projector + `B8G_ABI_MAGIC_V3` gate).
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const B8G_ABI_MAGIC_V3 = 0x33564742;

export type HoloFFIType = 'void' | 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64' | 'ptr' | 'str';

export interface HoloFFISymbolDef {
  readonly args?: readonly HoloFFIType[];
  readonly returns: HoloFFIType;
}

export interface HoloFFIOptions<T extends Record<string, HoloFFISymbolDef>> {
  readonly lib?: string;
  readonly sha512: string;
  readonly downloadUrl?: string;
  readonly casRoot?: string;
  readonly symbols: T;
  readonly abiMagicSymbol?: string;
  readonly fetcher?: (url: string) => Promise<Uint8Array>;
  readonly nativeInvoker?: (
    projectedPath: string,
    symbolName: string,
    def: HoloFFISymbolDef,
    args: readonly unknown[],
  ) => unknown;
}

export interface HoloFFIHandle<T extends Record<string, HoloFFISymbolDef>> {
  readonly spec: string;
  readonly casLayout: 'v11';
  readonly sha512: string;
  readonly blobPath: string;
  readonly projectedPath: string;
  readonly casHit: boolean;
  readonly hardlinked: boolean;
  readonly abiMagicVerified: boolean;
  readonly disposed: boolean;
  readonly symbols: { [K in keyof T]: (...args: unknown[]) => unknown };
  dispose(): void;
}

export function sha512Hex(data: Uint8Array): string {
  return createHash('sha512').update(data).digest('hex');
}

export function platformLibFilename(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (/\.(dll|so|dylib|wasm)$/i.test(name)) return name;
  if (platform === 'win32') return `${name}.dll`;
  if (platform === 'darwin') return `lib${name}.dylib`;
  return `lib${name}.so`;
}

export function v11BlobPath(casRoot: string, sha512: string, executable = true): string {
  const hex = sha512.toLowerCase();
  return path.join(casRoot, 'v11', 'files', hex.slice(0, 2), `${hex}${executable ? '-exec' : ''}`);
}

export async function holoFFI<T extends Record<string, HoloFFISymbolDef>>(
  spec: string,
  opts: HoloFFIOptions<T>,
): Promise<HoloFFIHandle<T>> {
  const sha512 = opts.sha512.trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sha512)) {
    throw new Error(`holo-ffi: valid 128-char SHA-512 required for "${spec}"`);
  }

  const casRoot = opts.casRoot || path.join(os.homedir(), '.b8g', 'cas');
  const blobPath = v11BlobPath(casRoot, sha512, true);
  let casHit = fs.existsSync(blobPath);

  if (!casHit) {
    if (!opts.downloadUrl) {
      throw new Error(`holo-ffi: blob ${sha512.slice(0, 16)}... missing from v11 CAS and no downloadUrl provided`);
    }
    const bytes = opts.fetcher
      ? await opts.fetcher(opts.downloadUrl)
      : new Uint8Array(await (await fetch(opts.downloadUrl)).arrayBuffer());
    const actual = sha512Hex(bytes);
    if (actual !== sha512) {
      throw new Error(`holo-ffi: SHA-512 integrity mismatch for "${spec}"`);
    }
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    fs.writeFileSync(blobPath, bytes);
  }

  const linksDir = path.join(casRoot, 'v11', 'links');
  fs.mkdirSync(linksDir, { recursive: true });
  const filename = platformLibFilename(opts.lib || 'holo-lib');
  const projectedPath = path.join(linksDir, `${sha512.slice(0, 16)}-${path.basename(filename)}`);
  if (!fs.existsSync(projectedPath)) {
    fs.linkSync(blobPath, projectedPath);
  }

  let wasmExports: WebAssembly.Exports | null = null;
  if (projectedPath.endsWith('.wasm')) {
    const instantiated = await WebAssembly.instantiate(fs.readFileSync(projectedPath));
    wasmExports = instantiated.instance.exports;
  }

  let disposed = false;
  const boundSymbols = {} as { [K in keyof T]: (...args: unknown[]) => unknown };
  for (const [symName, def] of Object.entries(opts.symbols)) {
    boundSymbols[symName as keyof T] = (...args: unknown[]) => {
      if (disposed) throw new Error(`holo-ffi: handle for "${spec}" is already disposed`);
      if (wasmExports) {
        const fn = wasmExports[symName];
        if (typeof fn !== 'function') throw new Error(`holo-ffi: WASM export "${symName}" not found`);
        return (fn as (...a: unknown[]) => unknown)(...args);
      }
      if (opts.nativeInvoker) return opts.nativeInvoker(projectedPath, symName, def, args);
      return { symbol: symName, projectedPath, sha512, args };
    };
  }

  let abiMagicVerified = false;
  if (opts.abiMagicSymbol) {
    const magic = Number(boundSymbols[opts.abiMagicSymbol as keyof T]()) >>> 0;
    if (magic !== B8G_ABI_MAGIC_V3) {
      throw new Error(`holo-ffi: ABI magic mismatch on "${spec}": expected 0x${B8G_ABI_MAGIC_V3.toString(16)}, got 0x${magic.toString(16)}`);
    }
    abiMagicVerified = true;
  }

  return {
    spec,
    casLayout: 'v11',
    sha512,
    blobPath,
    projectedPath,
    casHit,
    hardlinked: fs.statSync(blobPath).ino === fs.statSync(projectedPath).ino,
    abiMagicVerified,
    get disposed() {
      return disposed;
    },
    symbols: boundSymbols,
    dispose() {
      disposed = true;
    },
  };
}
