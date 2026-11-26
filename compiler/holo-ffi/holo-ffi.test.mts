import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { B8G_ABI_MAGIC_V3, holoFFI, sha512Hex } from './holo-ffi.mts';

describe('awesome-os/holo-ffi (standalone v11 CAS FFI loader)', () => {
  it('hydrates into v11/files, projects 0-byte hardlink into v11/links, and verifies B8G_ABI_MAGIC_V3', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-ffi-standalone-'));
    try {
      const payload = new TextEncoder().encode('MZ-HOLO-FFI-V11-TEST');
      const digest = sha512Hex(payload);

      const h1 = await holoFFI('awesome-os/libuv@v1.53.0', {
        lib: 'libuv.dll',
        sha512: digest,
        downloadUrl: 'https://example.invalid/libuv.dll',
        casRoot: tmp,
        fetcher: async () => payload,
        symbols: { b8g_abi_magic: { returns: 'u32' } },
        abiMagicSymbol: 'b8g_abi_magic',
        nativeInvoker: () => B8G_ABI_MAGIC_V3,
      });

      assert.equal(h1.casLayout, 'v11');
      assert.equal(h1.casHit, false);
      assert.equal(h1.hardlinked, true);
      assert.equal(h1.abiMagicVerified, true);

      const h2 = await holoFFI('awesome-os/libuv@v1.53.0', {
        lib: 'libuv.dll',
        sha512: digest,
        casRoot: tmp,
        symbols: { b8g_abi_magic: { returns: 'u32' } },
        nativeInvoker: () => B8G_ABI_MAGIC_V3,
      });
      assert.equal(h2.casHit, true);

      h1.dispose();
      assert.throws(() => h1.symbols.b8g_abi_magic(), /already disposed/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects ABI magic mismatch', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-ffi-bad-'));
    try {
      const payload = new TextEncoder().encode('BAD-ABI');
      await assert.rejects(
        () =>
          holoFFI('awesome-os/bad@v0', {
            lib: 'bad.dll',
            sha512: sha512Hex(payload),
            downloadUrl: 'https://example.invalid/bad.dll',
            casRoot: tmp,
            fetcher: async () => payload,
            symbols: { b8g_abi_magic: { returns: 'u32' } },
            abiMagicSymbol: 'b8g_abi_magic',
            nativeInvoker: () => 0xdeadbeef,
          }),
        /ABI magic mismatch/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
