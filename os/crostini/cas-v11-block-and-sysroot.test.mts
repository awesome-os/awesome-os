import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRootlessCrostiniPlan,
  HoloCasBlockDevice,
  NBD_CMD_READ,
  NBD_REQUEST_MAGIC,
  NBD_SIMPLE_REPLY_MAGIC,
} from './cas-v11-block-and-sysroot.mts';

describe('CAS v11 Lazy Block Disk (g2disk pattern) & Rootless Crostini (alpine-self-setup pattern)', () => {
  it('deduplicates sparse & identical blocks into SHA-512 v11 CAS and serves Linux NBD_CMD_READ packets', () => {
    const blkSize = 4096;
    const raw = new Uint8Array(blkSize * 4);
    // Block 0 & Block 2 have identical payload -> deduplicated to 1 physical CAS block!
    // Block 1 & Block 3 are all zeros -> 2 sparse zero blocks (0 bytes stored)!
    raw.set([0x42, 0x38, 0x47, 0x33], 0);
    raw.set([0x42, 0x38, 0x47, 0x33], blkSize * 2);

    const dev = new HoloCasBlockDevice(raw.byteLength, blkSize);
    const manifest = dev.ingestImage(raw, 'slot-a');
    assert.equal(manifest.sparseZeroBlocks, 2);
    assert.equal(manifest.physicalCasBlocks, 1);

    // Construct a 28-byte Linux kernel NBD_CMD_READ request for Block 2
    const req = new Uint8Array(28);
    const rv = new DataView(req.buffer);
    rv.setUint32(0, NBD_REQUEST_MAGIC, false);
    rv.setUint16(6, NBD_CMD_READ, false);
    rv.setBigUint64(8, 0x12345678n, false);
    rv.setBigUint64(16, BigInt(blkSize * 2), false);
    rv.setUint32(24, 4, false);

    const reply = dev.handleNbdReadPacket(req);
    const dv = new DataView(reply.buffer);
    assert.equal(dv.getUint32(0, false), NBD_SIMPLE_REPLY_MAGIC);
    assert.equal(dv.getUint32(4, false), 0);
    assert.equal(dv.getBigUint64(8, false), 0x12345678n);
    assert.deepEqual(Array.from(reply.subarray(16)), [0x42, 0x38, 0x47, 0x33]);
  });

  it('builds rootless unshare Crostini container plans without Docker or root', () => {
    const plan = buildRootlessCrostiniPlan({
      name: 'dev-rust',
      arch: 'x86_64',
      packages: ['clang', 'git', 'ripgrep'],
    });
    assert.ok(plan.rootfsDir.endsWith('/v11/crostini/dev-rust-x86_64'));
    assert.equal(plan.unshareCmd[0], 'unshare');
    assert.ok(plan.unshareCmd.includes('--map-root-user'));
    assert.ok(plan.packages.includes('clang'));
  });
});
