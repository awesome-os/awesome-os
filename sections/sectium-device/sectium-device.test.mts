/**
 * @file sections/sectium-device/sectium-device.test.mts
 * @description Verification suite for the Sectium Power-Button & Network-Device Boundary.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectOrPowerOnSectium } from '../../intersections/sectium-browser/cli.mts';
import {
  buildSanitizedPowerOnEnv,
  SectiumDeviceClient,
} from './device-client.mts';
import {
  SectiumDeviceHost,
  type SectiumOpenedWindowRecord,
} from './device-host.mts';
import {
  getSectiumDevicePipePath,
  SectiumDeviceOfflineError,
} from './protocol.mts';

function makeTestPipePath(suffix: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\sectium-dev-test-${process.pid}-${suffix}`
    : `/tmp/sectium-dev-test-${process.pid}-${suffix}.sock`;
}

describe('Sectium Power-Button & Network-Device Boundary', () => {
  it('resolves platform default pipe path and honors explicit override', () => {
    const defaultPath = getSectiumDevicePipePath();
    if (process.platform === 'win32') {
      assert.equal(defaultPath, '\\\\.\\pipe\\sectium-dev');
    } else {
      assert.equal(defaultPath, '/tmp/sectium-dev.sock');
    }
    const custom = makeTestPipePath('override');
    assert.equal(getSectiumDevicePipePath(custom), custom);
  });

  it('throws explicit DEVICE_OFFLINE when pipe is down', async () => {
    const pipePath = makeTestPipePath('offline');
    const client = new SectiumDeviceClient({ pipePath, timeoutMs: 500 });

    await assert.rejects(
      () => client.ping(),
      (err: unknown) => {
        assert.ok(err instanceof SectiumDeviceOfflineError);
        assert.equal(err.code, 'DEVICE_OFFLINE');
        assert.equal(err.pipePath, pipePath);
        return true;
      },
    );
  });

  it('performs live host + client roundtrip (ping, status, openWindow) and returns DEVICE_OFFLINE after stop()', async () => {
    const pipePath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\sectium-dev-test-${process.pid}`
        : `/tmp/sectium-dev-test-${process.pid}.sock`;

    const opened: SectiumOpenedWindowRecord[] = [];
    const host = new SectiumDeviceHost({
      pipePath,
      version: '2.4.0-test',
      onOpenWindow: (rec) => {
        opened.push(rec);
      },
    });
    const client = new SectiumDeviceClient({ pipePath, timeoutMs: 1000 });

    await host.start();
    assert.equal(host.isListening, true);

    try {
      const pong = await client.ping();
      assert.equal(pong.ok, true);
      assert.equal(pong.pong, true);
      assert.equal(typeof pong.uptimeMs, 'number');
      assert.ok(pong.uptimeMs >= 0);

      const statusBefore = await client.status();
      assert.equal(statusBefore.ok, true);
      assert.equal(statusBefore.version, '2.4.0-test');
      assert.equal(statusBefore.pid, process.pid);
      assert.equal(statusBefore.pipePath, pipePath);
      assert.equal(statusBefore.windowsOpened, 0);

      const win = await client.openWindow('https://sectium.local/dashboard', {
        appMode: true,
      });
      assert.equal(win.ok, true);
      assert.equal(win.windowId, 'win-1');
      assert.equal(win.url, 'https://sectium.local/dashboard');
      assert.equal(win.appMode, true);
      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.url, 'https://sectium.local/dashboard');

      const statusAfter = await client.status();
      assert.equal(statusAfter.windowsOpened, 1);
    } finally {
      await host.stop();
    }

    assert.equal(host.isListening, false);

    // After host.stop(), client must immediately report DEVICE_OFFLINE again
    await assert.rejects(
      () => client.status(),
      (err: unknown) => {
        assert.ok(err instanceof SectiumDeviceOfflineError);
        assert.equal(err.code, 'DEVICE_OFFLINE');
        assert.equal(err.pipePath, pipePath);
        return true;
      },
    );
  });

  it('buildSanitizedPowerOnEnv() strips caller noise and forces Google API vars to "no"', () => {
    const noisyEnv: NodeJS.ProcessEnv = {
      PATH: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      HOME: '/home/tester',
      // Caller-leaking noise that MUST be stripped:
      VSCODE_IPC_HOOK: '\\\\.\\pipe\\vscode-leak',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect=9229',
      npm_lifecycle_event: 'test',
      PNPM_HOME: 'C:\\pnpm',
      AGY_ACCOUNT: 'work',
      B8G_CALLER_SECRET: 'super-secret-token',
      // Must be overridden to "no":
      GOOGLE_API_KEY: 'leaked-api-key',
      GOOGLE_DEFAULT_CLIENT_ID: 'leaked-client-id',
      GOOGLE_DEFAULT_CLIENT_SECRET: 'leaked-client-secret',
    };

    const sanitized = buildSanitizedPowerOnEnv(noisyEnv);

    // OS essentials preserved
    assert.equal(sanitized.PATH, 'C:\\Windows\\System32');
    assert.equal(sanitized.SYSTEMROOT, 'C:\\Windows');
    assert.equal(sanitized.TEMP, 'C:\\Temp');
    assert.equal(sanitized.HOME, '/home/tester');

    // Google API keys hard-disabled
    assert.equal(sanitized.GOOGLE_API_KEY, 'no');
    assert.equal(sanitized.GOOGLE_DEFAULT_CLIENT_ID, 'no');
    assert.equal(sanitized.GOOGLE_DEFAULT_CLIENT_SECRET, 'no');

    // Caller noise stripped
    assert.equal(sanitized.VSCODE_IPC_HOOK, undefined);
    assert.equal(sanitized.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(sanitized.NODE_OPTIONS, undefined);
    assert.equal(sanitized.npm_lifecycle_event, undefined);
    assert.equal(sanitized.PNPM_HOME, undefined);
    assert.equal(sanitized.AGY_ACCOUNT, undefined);
    assert.equal(sanitized.B8G_CALLER_SECRET, undefined);
  });

  it('connectOrPowerOnSectium() connects to a live SectiumDeviceHost over the named pipe without powering on a new process', async () => {
    const pipePath = makeTestPipePath('connect');
    const host = new SectiumDeviceHost({ pipePath });
    await host.start();

    try {
      const result = await connectOrPowerOnSectium({
        url: 'example.com',
        appMode: true,
        pipePath,
        timeoutMs: 1000,
      });

      assert.equal(result.mode, 'connected');
      assert.equal(result.pipePath, pipePath);
      assert.equal(result.url, 'https://example.com');
      assert.equal(result.windowId, 'win-1');
      assert.equal(host.windowsOpened, 1);
    } finally {
      await host.stop();
    }
  });

  it('operates headless Command Channel with multiple interchangeable CLI/agent clients and zero Display Channel', async () => {
    const pipePath = makeTestPipePath('headless-cmd');
    const host = new SectiumDeviceHost({ pipePath });
    const client = new SectiumDeviceClient({ pipePath, timeoutMs: 1000 });
    await host.start();

    try {
      const cmdA = await client.attachChannel('command', 'cli-ttyS0');
      const cmdB = await client.attachChannel('command', 'agent-ssh-mtls');

      assert.equal(cmdA.ok, true);
      assert.equal(cmdA.attachment.channel, 'command');
      assert.equal(cmdB.ok, true);
      assert.equal(cmdB.replacedAttachmentId, undefined);

      const listed = await client.listChannels();
      assert.equal(listed.channels.command.length, 2);
      assert.equal(listed.channels.display.length, 0);

      const status = await client.status();
      assert.deepEqual(status.channels, { command: 2, display: 0 });

      const detached = await client.detachChannel('command', {
        attachmentId: cmdA.attachment.attachmentId,
      });
      assert.equal(detached.ok, true);
      assert.equal(detached.detached, true);

      const afterDetach = await client.listChannels('command');
      assert.equal(afterDetach.channels.command.length, 1);
      assert.equal(afterDetach.channels.command[0]?.clientId, 'agent-ssh-mtls');
    } finally {
      await host.stop();
    }
  });

  it('hot-swaps Display Channel sinks live without restarting Host Device or disrupting an attached Command Channel', async () => {
    const pipePath = makeTestPipePath('display-hotswap');
    const host = new SectiumDeviceHost({ pipePath });
    const cmdClient = new SectiumDeviceClient({ pipePath, timeoutMs: 1000 });
    const displayClientA = new SectiumDeviceClient({ pipePath, timeoutMs: 1000 });
    const displayClientB = new SectiumDeviceClient({ pipePath, timeoutMs: 1000 });
    await host.start();

    try {
      const cmd = await cmdClient.attachChannel('command', 'sectium-cli-console');
      const dispA = await displayClientA.attachChannel('display', 'gfx-host-1', {
        sink: 'b8g-gfx-host',
      });
      assert.equal(dispA.ok, true);
      assert.equal(dispA.attachment.sink, 'b8g-gfx-host');
      assert.equal(dispA.replacedAttachmentId, undefined);

      // Hot-swap Display Channel to a thin client while Command Channel stays attached
      const dispB = await displayClientB.attachChannel('display', 'thin-client-2', {
        sink: 'b8g-thin-client',
      });
      assert.equal(dispB.ok, true);
      assert.equal(dispB.replacedAttachmentId, dispA.attachment.attachmentId);
      assert.equal(dispB.attachment.sink, 'b8g-thin-client');

      // Command Channel remains intact and Host Device never restarted
      const listed = await cmdClient.listChannels();
      assert.equal(listed.channels.command.length, 1);
      assert.equal(listed.channels.command[0]?.attachmentId, cmd.attachment.attachmentId);
      assert.equal(listed.channels.display.length, 1);
      assert.equal(listed.channels.display[0]?.attachmentId, dispB.attachment.attachmentId);
      assert.equal(listed.channels.display[0]?.sink, 'b8g-thin-client');

      const pong = await cmdClient.ping();
      assert.equal(pong.ok, true);
      assert.equal(pong.pong, true);
    } finally {
      await host.stop();
    }
  });
});
