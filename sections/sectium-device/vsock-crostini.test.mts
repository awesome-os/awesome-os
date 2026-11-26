import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildQemuVsockArgs,
  decodeVsockFrame,
  DEFAULT_CROSTINI_GUEST_CID,
  DEFAULT_SECTIUM_VSOCK_PORT,
  encodeVsockFrame,
  parseVsockUri,
  VMADDR_CID_HOST,
} from './vsock-crostini.mts';

describe('AF_VSOCK Zero-TCP Crostini Bridge (B8G016-compliant)', () => {
  it('parses host and guest vsock://<cid>:<port> endpoints cleanly', () => {
    const host = parseVsockUri(`vsock://${VMADDR_CID_HOST}:${DEFAULT_SECTIUM_VSOCK_PORT}`);
    assert.equal(host.role, 'host');
    assert.equal(host.cid, 2);

    const guest = parseVsockUri(`vsock://${DEFAULT_CROSTINI_GUEST_CID}:9942`);
    assert.equal(guest.role, 'guest');
    assert.equal(guest.cid, 3);
  });

  it('round-trips 64-byte B8G_ABI_MAGIC_V3 vsock frames and emits QEMU vhost-vsock-pci args', () => {
    const msg = new TextEncoder().encode('{"op":"ping"}\n');
    const encoded = encodeVsockFrame({
      channel: 'command',
      seq: 42n,
      srcCid: VMADDR_CID_HOST,
      dstCid: DEFAULT_CROSTINI_GUEST_CID,
      payload: msg,
    });
    assert.equal(encoded.byteLength, 64 + msg.byteLength);

    const decoded = decodeVsockFrame(encoded);
    assert.equal(decoded.channel, 'command');
    assert.equal(decoded.seq, 42n);
    assert.equal(decoded.srcCid, 2);
    assert.equal(decoded.dstCid, 3);
    assert.equal(new TextDecoder().decode(decoded.payload), '{"op":"ping"}\n');

    assert.deepEqual(buildQemuVsockArgs(3), ['-device', 'vhost-vsock-pci,guest-cid=3']);
    assert.throws(() => buildQemuVsockArgs(2), /must be >= 3/);
  });
});
