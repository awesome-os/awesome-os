import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSectiumCasPnpmEnv,
  interceptPnpmEnvUse,
} from '../../packages/@awesome-os/bin-shim/src/shims/pnpm-shim.mts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const NODE_SHIM = path.join(WORKSPACE_ROOT, 'bin', 'node.ps1');

describe('sectium-node-hook & control-plane polyglot CAS env governance', () => {
  it('1. transparently resolves electron, nwjs, nw, puppeteer, and puppeteer-core via .\\bin\\node.ps1 and stamps .b8g-cas', () => {
    const evalCode = [
      "const e = await import('electron');",
      "const nw = await import('nwjs');",
      "const nw2 = await import('nw');",
      "const pup = await import('puppeteer');",
      "const pupCore = await import('puppeteer-core');",
      "console.log(JSON.stringify({",
      "  electronHasBrowserWindow: typeof e.BrowserWindow === 'function',",
      "  nwFacade: nw.__sectiumCompat?.facade,",
      "  nwAliasFacade: nw2.__sectiumCompat?.facade,",
      "  pupFacade: pup.__sectiumCompat?.facade,",
      "  pupCoreExec: pupCore.executablePath(),",
      "  dupBytes: pup.__sectiumCompat?.duplicatedBytes,",
      "}));",
    ].join(' ');

    const res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', NODE_SHIM, '--input-type=module', '-e', evalCode],
      { cwd: WORKSPACE_ROOT, encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );

    assert.equal(res.status, 0, `node shim failed: ${res.stderr}\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim()) as {
      electronHasBrowserWindow: boolean;
      nwFacade: string;
      nwAliasFacade: string;
      pupFacade: string;
      pupCoreExec: string;
      dupBytes: number;
    };

    assert.equal(parsed.electronHasBrowserWindow, true);
    assert.equal(parsed.nwFacade, 'nwjs');
    assert.equal(parsed.nwAliasFacade, 'nwjs');
    assert.equal(parsed.pupFacade, 'puppeteer');
    assert.match(parsed.pupCoreExec, /sectium\.exe|chrome\.exe/i);
    assert.equal(parsed.dupBytes, 0);

    const casDir = path.join(WORKSPACE_ROOT, '.b8g-cas', 'runtime-compat');
    assert.equal(fs.existsSync(path.join(casDir, 'electron.cas.json')), true);
    assert.equal(fs.existsSync(path.join(casDir, 'nwjs.cas.json')), true);
    assert.equal(fs.existsSync(path.join(casDir, 'puppeteer.cas.json')), true);
    assert.equal(fs.existsSync(path.join(casDir, 'puppeteer-core.cas.json')), true);
  });

  it('2. control-plane env governs pnpm, Deno, Bun, Python/uv/pip, JVM/WASI, and zero-duplicate browser flags', () => {
    const env = buildSectiumCasPnpmEnv({});
    assert.match(env.PNPM_HOME ?? '', /\.b8g-cas[\\/]pnpm-home$/);
    assert.match(env.NPM_CONFIG_STORE_DIR ?? '', /\.b8g-cas[\\/]pnpm-store$/);
    assert.match(env.NPM_CONFIG_CACHE ?? '', /\.b8g-cas[\\/]pnpm-cache$/);
    assert.equal(env.PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS, 'false');
    assert.equal(env.NPM_CONFIG_PREFER_OFFLINE, 'true');
    assert.match(env.DENO_DIR ?? '', /\.b8g-cas[\\/]deno-dir$/);
    assert.equal(env.DENO_NO_UPDATE_CHECK, '1');
    assert.match(env.BUN_INSTALL ?? '', /\.b8g-cas[\\/]bun-home$/);
    assert.match(env.UV_CACHE_DIR ?? '', /\.b8g-cas[\\/]uv-cache$/);
    assert.match(env.UV_PYTHON_INSTALL_DIR ?? '', /\.b8g-cas[\\/]python-home$/);
    assert.match(env.PIP_CACHE_DIR ?? '', /\.b8g-cas[\\/]pip-cache$/);
    assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
    assert.match(env.SECTIUM_JVM_WASM ?? '', /sectium-jvm\.wasm$/);
    assert.equal(env.ELECTRON_SKIP_BINARY_DOWNLOAD, '1');
    assert.equal(env.PUPPETEER_SKIP_DOWNLOAD, '1');
    assert.equal(env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD, '1');
    assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
    assert.equal(env.NWJS_SKIP_DOWNLOAD, '1');
    assert.match(env.PUPPETEER_EXECUTABLE_PATH ?? '', /sectium\.exe$/i);
  });

  it('3. pnpm env use --global <any-version> links our newest Control-Plane Node via CAS into localhost', () => {
    const env = buildSectiumCasPnpmEnv({});
    const res = interceptPnpmEnvUse(['env', 'use', '--global', '26'], env);
    assert.ok(res, 'expected pnpm env use to be intercepted');
    assert.equal(res.intercepted, true);
    assert.equal(res.requestedVersion, '26');
    assert.equal(res.activeNodeVersion, process.version);
    assert.equal(res.deviceTarget, 'localhost');
    assert.equal(fs.existsSync(res.linkedAt), true);
  });
});
