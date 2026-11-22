/**
 * @file cli.mts
 * @description CLI & Detached Daemon launcher for B8G Persistent Agent Host (`:7498`).
 * Usage:
 *   b8g-agent-host [start] [--port 7498] [--daemon]
 *   b8g-agent-host status [--port 7498]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startAgentHostServer } from './server.mts';

function parseArgs(argv: string[]): { cmd: string; port: number; daemon: boolean } {
  let cmd = 'start';
  let port = 7498;
  let daemon = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === 'status' || a === 'start') {
      cmd = a;
    } else if (a === '--daemon' || a === '-d') {
      daemon = true;
    } else if (a === '--port' && argv[i + 1]) {
      port = Number(argv[++i]) || 7498;
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
      console.log(`b8g-agent-host: OFFLINE on port ${port}`);
      process.exit(1);
    }
    console.log(JSON.stringify(running, null, 2));
    return;
  }

  if (running) {
    console.log(
      `b8g-agent-host already ONLINE at http://127.0.0.1:${port}/ (PID ${running.pid}, sessions: ${running.sessions})`,
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
    // Wait briefly until health responds so callers can immediately connect.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const health = await isAlreadyRunning(port);
      if (health) {
        console.log(`b8g-agent-host daemon ONLINE at http://127.0.0.1:${port}/ (PID ${health.pid})`);
        return;
      }
    }
    console.log(`b8g-agent-host daemon spawned on port ${port}`);
    return;
  }

  const handle = await startAgentHostServer({ port });
  console.log(`b8g-agent-host listening at ${handle.url}/ (PID ${process.pid})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
