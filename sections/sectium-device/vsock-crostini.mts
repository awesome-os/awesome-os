/**
 * @file sections/sectium-device/vsock-crostini.mts
 * @description Zero-TCP (`B8G016`-compliant) `AF_VSOCK` Host <-> Holo-Linux Crostini VM Bridge.
 *
 * Inspired by `popovicu/vsock-grpc`, replacing gRPC/HTTP2/Protobuf overhead with flat
 * 64-byte `B8G_ABI_MAGIC_V3` (`0x33564742`) frame headers over `vsock://<cid>:<port>`.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

export const B8G_ABI_MAGIC_V3 = 0x33564742;
export const VSOCK_FRAME_HEADER_BYTES = 64;

export const VMADDR_CID_HYPERVISOR = 0;
export const VMADDR_CID_LOCAL = 1;
export const VMADDR_CID_HOST = 2;
export const DEFAULT_CROSTINI_GUEST_CID = 3;
export const DEFAULT_SECTIUM_VSOCK_PORT = 9942;

export interface VsockEndpoint {
  readonly uri: string;
  readonly cid: number;
  readonly port: number;
  readonly role: 'hypervisor' | 'local' | 'host' | 'guest';
}

export function parseVsockUri(uri: string): VsockEndpoint {
  const m = /^vsock:\/\/(\d+):(\d+)\/?$/.exec(uri.trim());
  if (!m) {
    throw new Error(`vsock-crostini: invalid vsock URI "${uri}" (expected vsock://<cid>:<port>)`);
  }
  const cid = Number(m[1]);
  const port = Number(m[2]);
  if (!Number.isInteger(cid) || cid < 0 || cid > 0xffffffff) {
    throw new Error(`vsock-crostini: CID out of 32-bit range: ${cid}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 0xffffffff) {
    throw new Error(`vsock-crostini: port out of range: ${port}`);
  }
  const role: VsockEndpoint['role'] =
    cid === 0 ? 'hypervisor' : cid === 1 ? 'local' : cid === 2 ? 'host' : 'guest';
  return { uri: `vsock://${cid}:${port}`, cid, port, role };
}

export interface VsockFrame {
  readonly channel: 'command' | 'display';
  readonly seq: bigint;
  readonly srcCid: number;
  readonly dstCid: number;
  readonly payload: Uint8Array;
}

/**
 * Encodes a 64-byte aligned `B8G_ABI_MAGIC_V3` header + NDJSON/binary payload for `AF_VSOCK`.
 */
export function encodeVsockFrame(frame: VsockFrame): Uint8Array {
  const out = new Uint8Array(VSOCK_FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, B8G_ABI_MAGIC_V3, true);
  view.setUint32(4, 3, true); // ABI v3
  view.setUint32(8, frame.channel === 'display' ? 2 : 1, true);
  view.setUint32(12, frame.payload.byteLength, true);
  view.setBigUint64(16, frame.seq, true);
  view.setUint32(24, frame.srcCid >>> 0, true);
  view.setUint32(28, frame.dstCid >>> 0, true);
  out.set(frame.payload, VSOCK_FRAME_HEADER_BYTES);
  return out;
}

export function decodeVsockFrame(raw: Uint8Array): VsockFrame {
  if (raw.byteLength < VSOCK_FRAME_HEADER_BYTES) {
    throw new Error(`vsock-crostini: truncated frame (${raw.byteLength} < 64 bytes)`);
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== B8G_ABI_MAGIC_V3) {
    throw new Error(`vsock-crostini: ABI magic mismatch 0x${magic.toString(16)}`);
  }
  const chanCode = view.getUint32(8, true);
  const len = view.getUint32(12, true);
  if (VSOCK_FRAME_HEADER_BYTES + len > raw.byteLength) {
    throw new Error(`vsock-crostini: payload length overflow (${len})`);
  }
  const seq = view.getBigUint64(16, true);
  const srcCid = view.getUint32(24, true);
  const dstCid = view.getUint32(28, true);
  return {
    channel: chanCode === 2 ? 'display' : 'command',
    seq,
    srcCid,
    dstCid,
    payload: raw.subarray(VSOCK_FRAME_HEADER_BYTES, VSOCK_FRAME_HEADER_BYTES + len),
  };
}

export function buildQemuVsockArgs(guestCid: number = DEFAULT_CROSTINI_GUEST_CID): readonly string[] {
  if (guestCid < 3) {
    throw new Error('vsock-crostini: QEMU guest CID must be >= 3 (0..2 are reserved)');
  }
  return ['-device', `vhost-vsock-pci,guest-cid=${guestCid}`];
}
