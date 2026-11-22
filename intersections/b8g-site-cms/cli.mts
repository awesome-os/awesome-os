/**
 * @file cli.mts
 * @description CLI & Detached Daemon launcher for B8G Multi-Site Sovereign CMS (`:7499`).
 * Usage:
 *   b8g-site-cms [start] [--port 7499] [--daemon]
 *   b8g-site-cms status [--port 7499]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSiteCmsServer } from './server.mts';

function parseArgs(argv: string[]): { cmd: string; port: number; daemon: boolean } {
  let cmd = 'start';
  let port = 7499;
  let daemon = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === 'status' || a === 'start') {
      cmd = a;
    } else if (a === '--daemon' || a === '-d') {
      daemon = true;
    } else if (a === '--port' && argv[i + 1]) {
      port = Number(argv[++i]) || 7499;
    }
  }
  return { cmd, port, daemon };
}

async function isAlreadyRunning(port: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(700),
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { cmd, port, daemon } = parseArgs(process.argv.slice(2));
  const running = await isAlreadyRunning(port);

  if (cmd === 'status') {
    if (!running) {
      console.log(`b8g-site-cms: OFFLINE on port ${port}`);
      process.exit(1);
    }
    console.log(JSON.stringify(running, null, 2));
    return;
  }

  if (running) {
    console.log(
      `b8g-site-cms already ONLINE at http://127.0.0.1:${port}/ (PID ${running.pid}, sites: ${running.sites}, pages: ${running.pages})`,
    );
    return;
  }

  if (daemon) {
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [selfPath, 'start', '--port', String(port)], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const health = await isAlreadyRunning(port);
      if (health) {
        console.log(`b8g-site-cms daemon ONLINE at http://127.0.0.1:${port}/ (PID ${health.pid})`);
        return;
      }
    }
    console.log(`b8g-site-cms daemon spawned on port ${port}`);
    return;
  }

  const handle = await startSiteCmsServer({ port });
  console.log(`b8g-site-cms listening at ${handle.url}/ (PID ${process.pid})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
