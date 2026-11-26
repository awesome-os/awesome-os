/**
 * @file sections/b8g-runtime/nw-compat.mts
 * @description Zero-bloat NW.js (`nw`, `nw.gui`, `nwjs`) compatibility facade backed by
 * shared `Sectium` (`D:\Sectium\sectium.exe`) via `b8g-electron` — 0 MB duplicated NW.js binary.
 *
 * @remarks **IMPLEMENTATION LEVEL: `facade-stub` (Zero-Tricks Disclosure)**
 * This module provides only a minimal NW.js surface (`Window.open`, `Window.get`, `App`, `Shell`):
 * - `Window.get()` instantiates a fresh `NwWindow` rather than returning an active singleton window.
 * - `App.manifest` is a static placeholder object rather than loading the caller's `package.json`.
 * - Full NW.js APIs (`Menu`, `MenuItem`, `Tray`, `Clipboard`, `Screen`, `Shortcut`, window events,
 *   `eval()`, `capturePage()`, `showDevTools()`) are NOT implemented yet.
 *
 * Strictly `erasableSyntaxOnly: true`.
 */
import { app, BrowserWindow, shell, resolveSharedChromeBinary } from '../../intersections/b8g-electron/index.mts';

export type SectiumCompatImplementationLevel = 'facade-stub' | 'native';

export interface NwWindowOptions {
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
  readonly show?: boolean;
}

/**
 * Minimal NW.js `Window` facade delegating window creation/closing to `b8g-electron`'s
 * `BrowserWindow`.
 *
 * @remarks **FACADE STUB (`implementationLevel: 'facade-stub'`):**
 * Exposes only `inner` and `close()`; NW.js lifecycle events, `eval()`, `capturePage()`,
 * `showDevTools()`, and menu bindings are not implemented yet.
 */
export class NwWindow {
  readonly implementationLevel: SectiumCompatImplementationLevel = 'facade-stub';
  readonly inner: BrowserWindow;

  constructor(opts: NwWindowOptions = {}) {
    this.inner = new BrowserWindow({
      width: opts.width ?? 1280,
      height: opts.height ?? 800,
      title: opts.title ?? 'Sectium NW.js Window',
      show: opts.show ?? true,
    });
  }

  close(): void {
    this.inner.close();
  }
}

export const Window = {
  implementationLevel: 'facade-stub' as const,
  /**
   * Opens a `b8g-electron` `BrowserWindow` and calls `loadURL(url)`.
   * @remarks **FACADE STUB:** Ignores advanced NW.js `Window.open` options (`new_instance`,
   * `inject_js_start`, `frame`, `transparent`, etc.).
   */
  open(url: string, opts: NwWindowOptions = {}, cb?: (win: NwWindow) => void): NwWindow {
    const win = new NwWindow(opts);
    if (url) {
      void win.inner.loadURL(url);
    }
    if (cb) cb(win);
    return win;
  },
  /**
   * @remarks **FACADE STUB:** Constructs a new `NwWindow` instance rather than returning
   * the currently focused/owning NW.js window singleton.
   */
  get(): NwWindow {
    return new NwWindow();
  },
};

export const App = {
  implementationLevel: 'facade-stub' as const,
  argv: process.argv.slice(2),
  fullArgv: process.argv,
  /**
   * @remarks **FACADE STUB:** Static placeholder manifest; does not read the caller's
   * `package.json` on disk.
   */
  manifest: { name: 'sectium-nw-app', main: 'index.html' },
  quit(): void {
    app.quit();
  },
};

export const Shell = {
  implementationLevel: 'facade-stub' as const,
  openExternal(uri: string): Promise<void> {
    return shell.openExternal(uri);
  },
};

export const __sectiumCompat = {
  facade: 'nwjs',
  implementationLevel: 'facade-stub' as const,
  backingBinary: resolveSharedChromeBinary(),
  duplicatedBytes: 0,
};

export default {
  Window,
  App,
  Shell,
  __sectiumCompat,
};
