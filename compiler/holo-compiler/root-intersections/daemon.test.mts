/**
 * @file intersections/holo-compiler/daemon.test.mts
 * @description End-to-end verification suite for the resident `holo-compiler` Named-Pipe Daemon
 * and 64-byte-aligned `B8G_ARENA_V1` / `B8G_ABI_MAGIC_V3` binary bridge.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  B8G_ABI_MAGIC_V3,
  B8G_ARENA_V1_VERSION,
  B8G_HOLO_ARENA_ALIGNMENT,
  B8G_HOLO_ARENA_HEADER,
  B8G_HOLO_ARENA_HEADER_BYTES,
  HOLO_ARENA_FLAGS,
  HOLO_DAEMON_TOOLCHAINS,
  HoloDaemonClient,
  decodeHoloArenaFrame,
  defaultHoloPipePath,
  encodeHoloArenaFrame,
  startHoloDaemon,
  type HoloDaemonToolchain,
} from './daemon.mts';

describe('holo-compiler resident named-pipe daemon & B8G_ARENA_V1 bridge', () => {
  it('derives OS-native pipe paths for Windows and POSIX without HTTP loopback', () => {
    const winPath = defaultHoloPipePath('worker-3', 'win32');
    assert.equal(winPath, '\\\\.\\pipe\\b8g-holo-compiler-worker-3');
    assert.ok(!winPath.includes('127.0.0.1'));
    assert.ok(!winPath.includes('http://'));

    const linuxPath = defaultHoloPipePath('worker-3', 'linux');
    assert.equal(linuxPath, '/tmp/b8g-holo-compiler-worker-3.sock');

    const sanitized = defaultHoloPipePath('my weird/id:42', 'win32');
    assert.equal(sanitized, '\\\\.\\pipe\\b8g-holo-compiler-my-weird-id-42');
  });

  it('round-trips 64-byte-aligned B8G_ARENA_V1 / B8G_ABI_MAGIC_V3 frames over SharedArrayBuffer', () => {
    assert.equal(B8G_HOLO_ARENA_HEADER.magic, B8G_ABI_MAGIC_V3);
    assert.equal(B8G_HOLO_ARENA_HEADER.magic, 0x33564742);
    assert.equal(B8G_HOLO_ARENA_HEADER.version, B8G_ARENA_V1_VERSION);
    assert.equal(B8G_HOLO_ARENA_HEADER.headerBytes, B8G_HOLO_ARENA_HEADER_BYTES);
    assert.equal(B8G_HOLO_ARENA_HEADER.alignment, B8G_HOLO_ARENA_ALIGNMENT);

    const payload = new TextEncoder().encode('HOLO_IR_V1:cxx:kernel_entry\nint main() { return 0; }');
    const casKey = 'a'.repeat(64);
    const sab = new SharedArrayBuffer(512);

    const encoded = encodeHoloArenaFrame(
      {
        toolchain: 'cxx',
        abiVersion: 3,
        flags: HOLO_ARENA_FLAGS.CACHE_HIT | HOLO_ARENA_FLAGS.HAS_SIDECAR,
        schemaHash: '0xdeadbeefcafebabe',
        casKey,
        payload,
      },
      sab,
      64,
    );

    assert.equal(encoded.byteLength % 64, 0);
    assert.equal(encoded.byteOffset, 64);

    const decoded = decodeHoloArenaFrame(sab, 64);
    assert.equal(decoded.magic, B8G_ABI_MAGIC_V3);
    assert.equal(decoded.arenaVersion, B8G_ARENA_V1_VERSION);
    assert.equal(decoded.headerBytes, 64);
    assert.equal(decoded.abiVersion, 3);
    assert.equal(decoded.toolchain, 'cxx');
    assert.equal(decoded.casKey, casKey);
    assert.equal(decoded.schemaHash, 0xdeadbeefcafebaben);
    assert.equal(decoded.payloadBytes, payload.byteLength);
    assert.equal(decoded.alignedFrameBytes, encoded.byteLength);
    assert.ok((decoded.flags & HOLO_ARENA_FLAGS.CACHE_HIT) !== 0);
    assert.ok((decoded.flags & HOLO_ARENA_FLAGS.HAS_SIDECAR) !== 0);
    assert.ok((decoded.flags & HOLO_ARENA_FLAGS.ZERO_COPY_SAB) !== 0);
    assert.deepEqual(Array.from(decoded.payload), Array.from(payload));

    // Verify zero-copy view shares the exact SharedArrayBuffer backing store.
    assert.equal(decoded.payload.buffer, sab);
    assert.equal(decoded.payload.byteOffset, 64 + 64);

    // Reject unaligned offset and corrupted magic.
    assert.throws(
      () => encodeHoloArenaFrame({ toolchain: 'ts', casKey, payload }, sab, 16),
      /64-byte aligned/,
    );
    const corrupted = new Uint8Array(encoded);
    corrupted[0] ^= 0xff;
    assert.throws(() => decodeHoloArenaFrame(corrupted), /Invalid B8G_ABI_MAGIC_V3/);
  });

  it('serves ping, cold compile (miss), warm compile (resident hit), stats, flush-cas, and clean shutdown over OS pipe', async () => {
    const instanceId = `test-${process.pid}-${randomUUID().slice(0, 8)}`;
    const pipePath = defaultHoloPipePath(instanceId);
    const daemon = await startHoloDaemon({ pipePath });
    const client = new HoloDaemonClient({ pipePath, timeoutMs: 3000 });

    try {
      // 1. Ping
      const pong = await client.ping();
      assert.equal(pong.pong, true);
      assert.equal(pong.pipePath, pipePath);
      assert.equal(pong.protocol, 'ndjson-pipe-v1');
      assert.equal(pong.abiMagic, B8G_ABI_MAGIC_V3);
      assert.deepEqual(pong.toolchains, HOLO_DAEMON_TOOLCHAINS);

      // 2. Cold compile (CAS miss) across cxx + includeArenaFrame
      const compileReq = {
        unitId: 'vec_add',
        toolchain: 'cxx' as HoloDaemonToolchain,
        source: '// vector add\nint vec_add(int a, int b) { return a + b; }\n',
        flags: ['-O3', '-march=native'],
        schemaHash: '0x123456789abcdef0',
        abiVersion: 3,
        includeArenaFrame: true,
      };

      const cold = await client.compile(compileReq);
      assert.equal(cold.unitId, 'vec_add');
      assert.equal(cold.toolchain, 'cxx');
      assert.equal(cold.cacheHit, false);
      assert.equal(cold.consumerDebugBytes, 0);
      assert.equal(cold.sessionWarm, true);
      assert.equal(cold.casKey.length, 64);
      assert.ok(cold.arenaFrameBytes >= 64 && cold.arenaFrameBytes % 64 === 0);
      assert.ok(typeof cold.arenaFrameBase64 === 'string' && cold.arenaFrameBase64.length > 0);

      // Decode returned B8G_ARENA_V1 frame
      const coldArena = decodeHoloArenaFrame(Buffer.from(cold.arenaFrameBase64, 'base64'));
      assert.equal(coldArena.casKey, cold.casKey);
      assert.equal(coldArena.toolchain, 'cxx');
      assert.equal(coldArena.flags & HOLO_ARENA_FLAGS.CACHE_HIT, 0);

      // 3. Warm compile with reordered flags (order-invariant CAS key -> resident hit!)
      const warm = await client.compile({
        ...compileReq,
        flags: ['-march=native', '-O3'],
      });
      assert.equal(warm.cacheHit, true);
      assert.equal(warm.casKey, cold.casKey);
      assert.equal(warm.contentSha256, cold.contentSha256);
      assert.equal(warm.sessionWarm, true);
      assert.ok(typeof warm.arenaFrameBase64 === 'string');

      const warmArena = decodeHoloArenaFrame(Buffer.from(warm.arenaFrameBase64, 'base64'));
      assert.ok((warmArena.flags & HOLO_ARENA_FLAGS.CACHE_HIT) !== 0);

      // 4. Warm all remaining toolchains (rust, zig, wasi, ts)
      for (const toolchain of ['rust', 'zig', 'wasi', 'ts'] as const) {
        const res = await client.compile({
          unitId: `smoke_${toolchain}`,
          toolchain,
          source: `export const lang = "${toolchain}";`,
        });
        assert.equal(res.cacheHit, false);
        assert.equal(res.sessionWarm, true);
      }

      // 5. Inspect stats
      const stats = await client.stats();
      assert.equal(stats.pipePath, pipePath);
      assert.equal(stats.totalCompiles, 6);
      assert.equal(stats.cacheHits, 1);
      assert.equal(stats.cacheMisses, 5);
      assert.equal(stats.casEntries, 5);
      for (const tc of HOLO_DAEMON_TOOLCHAINS) {
        assert.equal(stats.sessions[tc].warm, true);
      }

      // 6. Selective flush-cas (cxx only), then full flush
      const flushCxx = await client.flushCas({ toolchain: 'cxx' });
      assert.equal(flushCxx.clearedEntries, 1);
      assert.equal(flushCxx.remainingEntries, 4);

      const flushAll = await client.flushCas();
      assert.equal(flushAll.clearedEntries, 4);
      assert.equal(flushAll.remainingEntries, 0);

      // 7. Clean shutdown via RPC
      const shutdownRes = await client.shutdown();
      assert.equal(shutdownRes.shuttingDown, true);
      assert.equal(shutdownRes.pipePath, pipePath);

      // Wait briefly for server close event to settle
      await new Promise<void>((resolve) => {
        if (!daemon.server.listening) {
          resolve();
          return;
        }
        daemon.server.once('close', () => resolve());
      });
      assert.equal(daemon.server.listening, false);

      // Subsequent client requests must fail cleanly (pipe closed)
      await assert.rejects(() => client.ping());
    } finally {
      await daemon.close();
    }
  });

  it('supports custom compileHook, bounded CAS eviction, and structured RPC errors', async () => {
    const instanceId = `test-hook-${process.pid}-${randomUUID().slice(0, 8)}`;
    const pipePath = defaultHoloPipePath(instanceId);
    let hookInvocations = 0;

    const daemon = await startHoloDaemon({
      pipePath,
      maxCasEntries: 2,
      compileHook(params) {
        hookInvocations += 1;
        return {
          artifactBytes: new TextEncoder().encode(`HOOK:${params.toolchain}:${params.unitId}`),
        };
      },
    });
    const client = new HoloDaemonClient(pipePath);

    try {
      const a1 = await client.compile({ unitId: 'a', toolchain: 'zig', source: 'pub fn a() void {}' });
      const a2 = await client.compile({ unitId: 'a', toolchain: 'zig', source: 'pub fn a() void {}' });
      assert.equal(a1.cacheHit, false);
      assert.equal(a2.cacheHit, true);
      assert.equal(hookInvocations, 1);

      await client.compile({ unitId: 'b', toolchain: 'rust', source: 'pub fn b() {}' });
      await client.compile({ unitId: 'c', toolchain: 'wasi', source: 'int c() { return 1; }' });

      const stats = await client.stats();
      assert.equal(stats.casEntries, 2);
      assert.equal(hookInvocations, 3);

      // Invalid compile params return structured RPC error without crashing daemon
      await assert.rejects(
        () =>
          client.request('compile', {
            unitId: 'bad',
            toolchain: 'cobol',
            source: 'IDENTIFICATION DIVISION.',
          }),
        /HOLO_DAEMON_ERROR/,
      );

      // Daemon remains healthy after error
      const pong = await client.ping();
      assert.equal(pong.pong, true);
    } finally {
      await daemon.close();
    }
  });
});
