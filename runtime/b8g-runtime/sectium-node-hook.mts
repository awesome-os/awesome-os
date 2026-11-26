/**
 * @file sections/b8g-runtime/sectium-node-hook.mts
 * @description Universal zero-`node_modules` Node.js `module.registerHooks()` resolver.
 * Automatically redirects imports/requires of:
 *   - `electron`, `electron/main`, `electron/common` -> `intersections/b8g-electron/index.mts`
 *   - `nw`, `nw.gui`, `nwjs`                         -> `sections/b8g-runtime/nw-compat.mts`
 *   - `puppeteer`, `puppeteer-core`                  -> `sections/b8g-runtime/puppeteer-compat.mts`
 *   - `bun`                                          -> `sections/bun-neon/bun-global.mts`
 *   - `bun:sqlite`                                   -> `sections/bun-neon/bun-sqlite.mts`
 *   - `bun:test`                                     -> `sections/bun-neon/bun-test.mts`
 *   - `bun:ffi`                                      -> `sections/bun-neon/bun-ffi.mts`
 *
 * Eliminates 750+ MB of duplicated Electron/NW.js/Puppeteer Chromium downloads per project
 * by binding every import directly to our ONE shared sovereign Sectium Host Device.
 *
 * Opt out if ever needed via `SECTIUM_NODE_HOOK=0`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const CAS_COMPAT_DIR = path.join(WORKSPACE_ROOT, '.b8g-cas', 'runtime-compat');

const REDIRECT_FILES: Record<string, string> = {
  electron: path.join(WORKSPACE_ROOT, 'intersections', 'b8g-electron', 'index.mts'),
  'electron/main': path.join(WORKSPACE_ROOT, 'intersections', 'b8g-electron', 'index.mts'),
  'electron/common': path.join(WORKSPACE_ROOT, 'intersections', 'b8g-electron', 'index.mts'),
  nw: path.join(__dirname, 'nw-compat.mts'),
  'nw.gui': path.join(__dirname, 'nw-compat.mts'),
  nwjs: path.join(__dirname, 'nw-compat.mts'),
  puppeteer: path.join(__dirname, 'puppeteer-compat.mts'),
  'puppeteer-core': path.join(__dirname, 'puppeteer-compat.mts'),
  bun: path.join(WORKSPACE_ROOT, 'sections', 'bun-neon', 'bun-global.mts'),
  'bun:sqlite': path.join(WORKSPACE_ROOT, 'sections', 'bun-neon', 'bun-sqlite.mts'),
  'bun:test': path.join(WORKSPACE_ROOT, 'sections', 'bun-neon', 'bun-test.mts'),
  'bun:ffi': path.join(WORKSPACE_ROOT, 'sections', 'bun-neon', 'bun-ffi.mts'),
};

function ensureInstalledInCas(specifier: string, sourceFile: string): string {
  try {
    const safeName = specifier.replace(/[^a-zA-Z0-9._-]/g, '_');
    const markerPath = path.join(CAS_COMPAT_DIR, `${safeName}.cas.json`);
    if (!fs.existsSync(markerPath) && fs.existsSync(sourceFile)) {
      fs.mkdirSync(CAS_COMPAT_DIR, { recursive: true });
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ specifier, sourceFile, sha256, installedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    }
  } catch {
    // Non-fatal in read-only sandboxes
  }
  return pathToFileURL(sourceFile).href;
}

export function installSectiumNodeCompatHooks(): void {
  if (process.env.SECTIUM_NODE_HOOK === '0') return;
  if (typeof module.registerHooks !== 'function') return;

  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const targetFile = REDIRECT_FILES[specifier];
      if (targetFile) {
        return {
          url: ensureInstalledInCas(specifier, targetFile),
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
}

installSectiumNodeCompatHooks();
