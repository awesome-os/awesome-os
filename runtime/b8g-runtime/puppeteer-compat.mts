/**
 * @file sections/b8g-runtime/puppeteer-compat.mts
 * @description Zero-download `puppeteer` / `puppeteer-core` compatibility facade backed by
 * our ONE shared sovereign Sectium binary (`D:\Sectium\sectium.exe`) + `sections/sectium-device/`
 * — eliminates 300 MB duplicate Chromium downloads per project.
 *
 * @remarks **IMPLEMENTATION LEVEL: `facade-stub` (Zero-Tricks Disclosure)**
 * Full Chrome DevTools Protocol (CDP) pipe transport (`--remote-debugging-pipe` /
 * `Target.createTarget` / `Page.navigate` / `Runtime.evaluate`) is **NOT** wired yet.
 * - `executablePath()`, `launch()` process spawning, `browser.close()`, and `connect()`
 *   device-pipe `ping()` are real.
 * - `SectiumPuppeteerPage` (`goto()`, `title()`, `close()`), `browser.newPage()`, and
 *   `browser.version()` are lightweight in-memory facade stubs that do NOT drive a real
 *   browser tab over CDP. Inspect `__sectiumCompat.implementationLevel` before relying on
 *   DOM/network automation.
 *
 * Strictly `erasableSyntaxOnly: true` & `shell: false`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveSharedChromeBinary } from '../../intersections/b8g-electron/index.mts';
import {
  SectiumDeviceClient,
  buildSanitizedPowerOnEnv,
} from '../sectium-device/device-client.mts';
import { getSectiumDevicePipePath } from '../sectium-device/protocol.mts';

export type SectiumCompatImplementationLevel = 'facade-stub' | 'native';

export interface PuppeteerLaunchOptions {
  readonly headless?: boolean | 'new' | 'shell';
  readonly executablePath?: string;
  readonly args?: readonly string[];
  readonly userDataDir?: string;
}

/**
 * Lightweight in-memory Puppeteer `Page` facade stub.
 *
 * @remarks **FACADE STUB (`implementationLevel: 'facade-stub'`):**
 * Not yet connected to Chromium CDP (`--remote-debugging-pipe`). Methods update
 * local in-memory state only and do NOT perform real browser navigation, DOM
 * queries, or tab teardown.
 */
export class SectiumPuppeteerPage {
  readonly implementationLevel: SectiumCompatImplementationLevel = 'facade-stub';
  private currentUrl = 'about:blank';
  private readonly devicePipe: string;

  constructor(devicePipe: string) {
    this.devicePipe = devicePipe;
  }

  url(): string {
    return this.currentUrl;
  }

  /**
   * @remarks **FACADE STUB:** Records `targetUrl` in memory and returns a synthetic
   * `{ status: 200, url }` without performing real HTTP/CDP `Page.navigate`.
   */
  async goto(targetUrl: string): Promise<{ status: number; url: string }> {
    this.currentUrl = targetUrl;
    return { status: 200, url: targetUrl };
  }

  /**
   * @remarks **FACADE STUB:** Returns a synthetic string derived from `currentUrl`
   * without querying `document.title` over CDP.
   */
  async title(): Promise<string> {
    return `Sectium Page (${this.currentUrl})`;
  }

  /**
   * @remarks **FACADE STUB:** No-op logical close; does not send CDP `Target.closeTarget`.
   */
  async close(): Promise<void> {
    // Facade stub: no CDP target attached yet
  }

  getDevicePipe(): string {
    return this.devicePipe;
  }
}

/**
 * Lightweight Puppeteer `Browser` facade wrapping a spawned Sectium process or
 * device-pipe reference.
 *
 * @remarks **FACADE STUB (`implementationLevel: 'facade-stub'`):**
 * `close()` terminates the spawned OS process when present, but `newPage()` and
 * `version()` are in-memory stubs until full CDP pipe transport is wired.
 */
export class SectiumPuppeteerBrowser {
  readonly implementationLevel: SectiumCompatImplementationLevel = 'facade-stub';
  readonly cdpWired = false as const;
  readonly executablePath: string;
  readonly devicePipe: string;
  private readonly proc?: ChildProcess;
  private readonly pages: SectiumPuppeteerPage[] = [];

  constructor(executablePath: string, devicePipe: string, proc?: ChildProcess) {
    this.executablePath = executablePath;
    this.devicePipe = devicePipe;
    this.proc = proc;
  }

  /**
   * @remarks **FACADE STUB:** Instantiates an in-memory `SectiumPuppeteerPage`
   * without sending CDP `Target.createTarget` or `open_window` IPC.
   */
  async newPage(): Promise<SectiumPuppeteerPage> {
    const page = new SectiumPuppeteerPage(this.devicePipe);
    this.pages.push(page);
    return page;
  }

  async pagesList(): Promise<SectiumPuppeteerPage[]> {
    return [...this.pages];
  }

  /**
   * @remarks **FACADE STUB:** Returns a static version banner rather than querying
   * CDP `Browser.getVersion`.
   */
  async version(): Promise<string> {
    return 'Sectium/160.0.8177.0 (facade-stub; CDP transport not yet wired)';
  }

  async close(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
  }
}

export function executablePath(): string {
  return resolveSharedChromeBinary();
}

/**
 * Spawns the shared Sectium binary with a sanitized environment.
 *
 * @remarks **PARTIAL / FACADE STUB:** Process spawn and teardown are real, but no
 * `--remote-debugging-pipe` CDP transport is attached to the returned browser handle yet.
 */
export async function launch(opts: PuppeteerLaunchOptions = {}): Promise<SectiumPuppeteerBrowser> {
  const bin = opts.executablePath ?? resolveSharedChromeBinary();
  const pipe = getSectiumDevicePipePath();
  const headless = opts.headless !== false;
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--no-first-run',
    '--disable-features=Translate',
    ...(opts.userDataDir ? [`--user-data-dir=${opts.userDataDir}`] : []),
    ...(opts.args ?? []),
    'about:blank',
  ];
  const proc = spawn(bin, args, {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    env: buildSanitizedPowerOnEnv(process.env),
  });
  return new SectiumPuppeteerBrowser(bin, pipe, proc);
}

/**
 * Verifies connectivity to a live `SectiumDeviceHost` pipe via `ping()` and returns a
 * `SectiumPuppeteerBrowser` handle.
 *
 * @remarks **PARTIAL / FACADE STUB:** Device-pipe `ping()` is real, but page-level
 * CDP commands on the returned browser remain facade stubs until CDP transport is wired.
 */
export async function connect(opts: { readonly pipePath?: string } = {}): Promise<SectiumPuppeteerBrowser> {
  const pipe = getSectiumDevicePipePath(opts.pipePath);
  const client = new SectiumDeviceClient({ pipePath: pipe });
  await client.ping();
  return new SectiumPuppeteerBrowser(resolveSharedChromeBinary(), pipe);
}

export const __sectiumCompat = {
  facade: 'puppeteer',
  implementationLevel: 'facade-stub' as const,
  cdpWired: false as const,
  backingBinary: resolveSharedChromeBinary(),
  devicePipe: getSectiumDevicePipePath(),
  duplicatedBytes: 0,
};

export default {
  executablePath,
  launch,
  connect,
  __sectiumCompat,
};
