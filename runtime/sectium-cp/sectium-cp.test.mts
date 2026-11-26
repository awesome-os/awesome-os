/**
 * @file sections/sectium-cloud-control-plane/sectium-cp.test.mts
 * @description Verification suite for `sectium-cloud-control-plane` covering:
 *  1. Native C11 `dist/sectium-cp-probe.exe` execution & `B8G_ABI_MAGIC_V3` check
 *  2. All 3 compiled C-ABI shared/WASI libraries (`sectium_cp.dll`, `libsectium_cp.so`, `sectium_cp.wasm`)
 *  3. `SectiumCloudControlPlane` TypeScript lifecycle: offline `DEVICE_OFFLINE`,
 *     1-way WoL cold init, `initramfs` 64-byte-aligned `bootstrapMainEntry()`,
 *     `.b8p` RAM checkpoint, `powerOff()`, warm RAM resume, opaque peer
 *     `command`/`devtools`/`display` hot-swap, and `<b8g-*>` Web Stream fan-out.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  B8G_ABI_MAGIC_V3,
  B8G_ARENA_ALIGN_BYTES,
  B8G_CP_ABI_VERSION,
  SectiumCloudControlPlane,
  SectiumCpError,
  SectiumDeviceOfflineError,
} from './index.mts';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(THIS_DIR, 'dist');
const MAX_BINARY_BYTES = 100 * 1024;

function uniquePipePath(tag: string): string {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sectium-cp-${tag}-${nonce}`;
  }
  return `/tmp/sectium-cp-${tag}-${nonce}.sock`;
}

describe('sectium-cloud-control-plane (B8G_ABI_MAGIC_V3)', () => {
  it('1. executes native C-ABI sectium-cp-probe.exe and validates ABI v3, warm resume, and DISPLAY hot-swap', async () => {
    const cp = new SectiumCloudControlPlane({
      pipePath: uniquePipePath('probe'),
    });

    const probe = await cp.verifyNativeAbiProbe();
    assert.equal(probe.ok, true);
    assert.equal(probe.abi_magic, B8G_ABI_MAGIC_V3);
    assert.equal(probe.abi_magic, 0x33564742);
    assert.equal(probe.abi_version, B8G_CP_ABI_VERSION);
    assert.equal(probe.offline_rc, SectiumCpError.ERR_DEVICE_OFFLINE);
    assert.equal(probe.online, 1);
    assert.equal(probe.warm_resumed, 1);
    assert.equal(probe.snapshot_epoch, 1);
    assert.equal(probe.command_peers, 1);
    assert.equal(probe.display_peers, 1);
    assert.equal(probe.devtools_peers, 1);
    assert.equal(probe.replaced_slot_id, probe.display_slot1);
    assert.notEqual(probe.display_slot2, probe.display_slot1);
    assert.equal(probe.last_error, SectiumCpError.OK);
  });

  it('2. verifies all 3 compiled C-ABI libraries exist with valid magic bytes and size < 100 KB', () => {
    const dllPath = join(DIST_DIR, 'sectium_cp.dll');
    const soPath = join(DIST_DIR, 'libsectium_cp.so');
    const wasmPath = join(DIST_DIR, 'sectium_cp.wasm');

    const dllStat = statSync(dllPath);
    const soStat = statSync(soPath);
    const wasmStat = statSync(wasmPath);

    assert.ok(dllStat.size > 0 && dllStat.size < MAX_BINARY_BYTES, `sectium_cp.dll size ${dllStat.size} must be < 100 KB`);
    assert.ok(soStat.size > 0 && soStat.size < MAX_BINARY_BYTES, `libsectium_cp.so size ${soStat.size} must be < 100 KB`);
    assert.ok(wasmStat.size > 0 && wasmStat.size < MAX_BINARY_BYTES, `sectium_cp.wasm size ${wasmStat.size} must be < 100 KB`);

    const dllHeader = readFileSync(dllPath).subarray(0, 2);
    assert.deepEqual(Array.from(dllHeader), [0x4d, 0x5a], 'sectium_cp.dll must start with PE MZ magic');

    const soHeader = readFileSync(soPath).subarray(0, 4);
    assert.deepEqual(Array.from(soHeader), [0x7f, 0x45, 0x4c, 0x46], 'libsectium_cp.so must start with ELF magic 7f 45 4c 46');

    const wasmHeader = readFileSync(wasmPath).subarray(0, 4);
    assert.deepEqual(Array.from(wasmHeader), [0x00, 0x61, 0x73, 0x6d], 'sectium_cp.wasm must start with WASM magic 00 61 73 6d');
  });

  it('3. verifies full TS lifecycle: offline -> WoL cold init -> initramfs mainEntry -> checkpoint -> powerOff -> warm RAM resume -> opaque peers -> <b8g-*> Web Stream fan-out', async () => {
    const cp = new SectiumCloudControlPlane({
      pipePath: uniquePipePath('lifecycle'),
      endpoint: 'sectium://control-plane.test:9443',
    });

    try {
      // 3a. Offline state must throw typed DEVICE_OFFLINE
      assert.equal(cp.getStatus().online, false);
      await assert.rejects(
        () => cp.attachOpaquePeer('command', 'peer-before-wake'),
        (err: unknown) =>
          err instanceof SectiumDeviceOfflineError && err.code === 'DEVICE_OFFLINE',
      );

      // 3b. 1st wake: cold init
      const coldWake = await cp.wakeDetached();
      assert.equal(coldWake.online, true);
      assert.equal(coldWake.detached, true);
      assert.equal(coldWake.warmResumed, false);
      assert.equal(coldWake.snapshotEpoch, 0);

      // 3c. Central discovery initramfs: bootstrap 64-byte-aligned B8G_ARENA_V1 mainEntry targets
      const jvmEntry = cp.bootstrapMainEntry({
        id: 'sectium-jvm',
        kind: 'sectium-jvm',
        arenaAlignBytes: 64,
        args: ['--wasi-kotlin'],
      });
      const esEntry = cp.bootstrapMainEntry({
        id: 'sectium-es',
        kind: 'sectium-es',
        arenaAlignBytes: 64,
      });
      assert.equal(jvmEntry.arenaAlignBytes, B8G_ARENA_ALIGN_BYTES);
      assert.equal(jvmEntry.arenaOffset % 64, 0);
      assert.equal(jvmEntry.initramfsDiscovery, true);
      assert.equal(esEntry.arenaOffset % 64, 0);
      assert.ok(esEntry.arenaOffset > jvmEntry.arenaOffset);

      // 3d. Checkpoint .b8p warm-RAM epoch
      const ckpt = cp.checkpointRamEpoch({ label: 'post-initramfs' });
      assert.equal(ckpt.epoch, 1);
      assert.equal(ckpt.format, '.b8p');
      assert.equal(ckpt.arenaAlignBytes, 64);
      assert.equal(ckpt.bootstrappedEntries, 2);

      // 3e. Power off must stop transport while preserving snapshotEpoch
      const offStatus = await cp.powerOff();
      assert.equal(offStatus.online, false);
      assert.equal(offStatus.snapshotEpoch, 1);
      await assert.rejects(
        () => cp.client.ping(),
        (err: unknown) =>
          err instanceof SectiumDeviceOfflineError && err.code === 'DEVICE_OFFLINE',
      );

      // 3f. 2nd wake: warm RAM resume from preserved .b8p snapshot epoch
      const warmWake = await cp.wakeDetached();
      assert.equal(warmWake.online, true);
      assert.equal(warmWake.warmResumed, true);
      assert.equal(warmWake.snapshotEpoch, 1);

      // 3g. Wire <b8g-*> Web Stream .tee() fan-out into Kitty-Ink ANSI/Graphics sinks
      const ansiOutputs: string[] = [];
      const displayOutputs: string[] = [];
      const fanOut = cp.createB8gStreamFanOut({
        onCommand: (ansi) => {
          ansiOutputs.push(ansi);
        },
        onDisplay: (frame) => {
          displayOutputs.push(frame);
        },
        graphicsMode: 'kitty',
        width: 2,
        height: 2,
      });

      // 3h. Opaque peers: command + devtools + display #1 -> atomic display #2 hot-swap
      const cmdPeer = await cp.attachOpaquePeer('command', 'remote-ssh-agent');
      const devPeer = await cp.attachOpaquePeer('devtools', 'antigravity-ide', {
        clientKind: 'antigravity',
      });
      const dispPeer1 = await cp.attachOpaquePeer('display', 'kitty-tui-1', {
        surface: 'kitty',
      });
      const dispPeer2 = await cp.attachOpaquePeer('display', 'b8g-gfx-host-2', {
        surface: 'gpu',
      });

      assert.equal(cmdPeer.opaque, true);
      assert.equal(devPeer.opaque, true);
      assert.equal(dispPeer1.replacedAttachmentId, undefined);
      assert.equal(dispPeer2.replacedAttachmentId, dispPeer1.attachmentId);
      assert.equal(dispPeer2.replacedPeerId, 'kitty-tui-1');

      const liveStatus = cp.getStatus();
      assert.equal(liveStatus.abiMagic, B8G_ABI_MAGIC_V3);
      assert.equal(liveStatus.abiVersion, B8G_CP_ABI_VERSION);
      assert.equal(liveStatus.online, true);
      assert.equal(liveStatus.warmResumed, true);
      assert.equal(liveStatus.snapshotEpoch, 1);
      assert.equal(liveStatus.commandPeers, 1);
      assert.equal(liveStatus.devtoolsPeers, 1);
      assert.equal(liveStatus.displayPeers, 1);
      assert.equal(liveStatus.mainEntries.length, 2);

      // Emit a 2x2 RGBA display frame through the Kitty Graphics Protocol sink
      const rgba2x2 = new Uint8Array([
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 255, 255, 255, 255,
      ]);
      fanOut.emitDisplayFrame(rgba2x2);
      await fanOut.close();

      assert.ok(ansiOutputs.length >= 4, `expected >= 4 rendered <b8g-*> ANSI panels, got ${ansiOutputs.length}`);
      assert.ok(ansiOutputs.some((out) => out.includes('b8g-sectium-command')));
      assert.ok(ansiOutputs.some((out) => out.includes('b8g-sectium-devtools')));
      assert.ok(ansiOutputs.some((out) => out.includes('b8g-sectium-display')));
      assert.equal(displayOutputs.length, 1);
      assert.ok(displayOutputs[0].startsWith('\x1b_Ga=T,f=32,s=2,v=2,m=0;'));
    } finally {
      await cp.powerOff();
    }
  });

  it('4. verifies Rolling-Release Plane Metadata staging (ABI v3 guard) and O(1) rollback', () => {
    const cp = new SectiumCloudControlPlane({
      pipePath: uniquePipePath('rolling'),
      version: '3.1.0-rolling.1',
    });

    const initial = cp.getRollingReleaseManifest();
    assert.equal(initial.planeVersion, '3.1.0-rolling.1');
    assert.equal(initial.releaseChannel, 'rolling');
    assert.equal(initial.abiMagic, B8G_ABI_MAGIC_V3);
    assert.equal(initial.abiVersion, B8G_CP_ABI_VERSION);
    assert.equal(initial.snapshotEpoch, 0);

    // Reject invalid abiMagic or abiVersion < 3
    assert.throws(
      () =>
        cp.stageRollingRelease({
          planeVersion: '3.1.0-bad-magic',
          releaseChannel: 'canary',
          abiMagic: 0xdeadbeef,
          abiVersion: 3,
          bundleSha256: 'a'.repeat(64),
        }),
      /abiMagic mismatch/,
    );
    assert.throws(
      () =>
        cp.stageRollingRelease({
          planeVersion: '2.9.0-legacy',
          releaseChannel: 'stable',
          abiMagic: B8G_ABI_MAGIC_V3,
          abiVersion: 2,
          bundleSha256: 'b'.repeat(64),
        }),
      /abiVersion >= 3/,
    );

    // Stage valid rolling release -> bumps snapshotEpoch
    const staged = cp.stageRollingRelease({
      planeVersion: '3.2.0-rolling.42',
      releaseChannel: 'canary',
      abiMagic: B8G_ABI_MAGIC_V3,
      abiVersion: 3,
      bundleSha256: 'c'.repeat(64),
      publishedAt: '2026-11-22T16:00:00Z',
    });
    assert.equal(staged.planeVersion, '3.2.0-rolling.42');
    assert.equal(staged.releaseChannel, 'canary');
    assert.equal(staged.snapshotEpoch, 1);
    assert.equal(cp.snapshotEpoch, 1);
    assert.equal(cp.getRollingReleaseManifest().planeVersion, '3.2.0-rolling.42');

    // O(1) rollback restores prior manifest and snapshotEpoch
    const rolledBack = cp.rollbackRollingRelease();
    assert.equal(rolledBack.planeVersion, '3.1.0-rolling.1');
    assert.equal(rolledBack.releaseChannel, 'rolling');
    assert.equal(rolledBack.snapshotEpoch, 0);
    assert.equal(cp.snapshotEpoch, 0);
    assert.equal(cp.getRollingReleaseManifest().planeVersion, '3.1.0-rolling.1');

    // Second rollback with no previous snapshot throws
    assert.throws(() => cp.rollbackRollingRelease(), /No previous rolling release/);
  });
});
