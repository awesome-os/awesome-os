/**
 * @file os/crostini/cas-v11-block-and-sysroot.mts
 * @description
 *   1. `HoloCasBlockDevice` (`popovicu/g2disk` pattern, zero Go/cgo/gRPC):
 *      Chunks virtual A/B OS disk images into deduplicated 64 KiB SHA-512 `v11` CAS blocks
 *      and speaks Linux NBD (`NBD_REQUEST_MAGIC = 0x25609513`, `NBD_SIMPLE_REPLY_MAGIC = 0x67446698`)
 *      so `/dev/nbd0` or `/dev/ublkb0` mounts multi-GB `v11` CAS slots lazily on demand.
 *   2. `buildRootlessCrostiniPlan` (`popovicu/alpine-linux-self-setup` pattern):
 *      Declarative JSON -> SHA-512 `v11` CAS rootless `unshare` Linux container hydrator.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import { createHash } from 'node:crypto';

export const HOLO_CAS_BLOCK_SIZE = 65536; // 64 KiB block granularity
export const NBD_REQUEST_MAGIC = 0x25609513;
export const NBD_SIMPLE_REPLY_MAGIC = 0x67446698;
export const NBD_CMD_READ = 0;

export interface CasBlockManifestEntry {
  readonly blockIndex: number;
  readonly zero: boolean;
  readonly sha512?: string;
}

export interface CasVirtualDiskManifest {
  readonly schema: 'awesomeos.cas-v11-block-disk.v1';
  readonly slot: 'slot-a' | 'slot-b';
  readonly totalBytes: number;
  readonly blockSize: number;
  readonly sparseZeroBlocks: number;
  readonly physicalCasBlocks: number;
  readonly blocks: readonly CasBlockManifestEntry[];
}

export class HoloCasBlockDevice {
  readonly blockSize: number;
  readonly totalBytes: number;
  private readonly store = new Map<string, Uint8Array>();
  private readonly blockIndexMap = new Map<number, string>();
  private sparseCount = 0;

  constructor(totalBytes: number, blockSize: number = HOLO_CAS_BLOCK_SIZE) {
    if (totalBytes <= 0 || totalBytes % blockSize !== 0) {
      throw new Error(`HoloCasBlockDevice: totalBytes (${totalBytes}) must be a positive multiple of ${blockSize}`);
    }
    this.totalBytes = totalBytes;
    this.blockSize = blockSize;
  }

  ingestImage(image: Uint8Array, slot: 'slot-a' | 'slot-b' = 'slot-a'): CasVirtualDiskManifest {
    if (image.byteLength !== this.totalBytes) {
      throw new Error(`HoloCasBlockDevice: image length ${image.byteLength} != ${this.totalBytes}`);
    }
    const numBlocks = this.totalBytes / this.blockSize;
    const entries: CasBlockManifestEntry[] = [];
    this.sparseCount = 0;

    for (let i = 0; i < numBlocks; i++) {
      const slice = image.subarray(i * this.blockSize, (i + 1) * this.blockSize);
      let allZero = true;
      for (let j = 0; j < slice.byteLength; j++) {
        if (slice[j] !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) {
        this.sparseCount++;
        entries.push({ blockIndex: i, zero: true });
      } else {
        const sha512 = createHash('sha512').update(slice).digest('hex');
        if (!this.store.has(sha512)) {
          this.store.set(sha512, new Uint8Array(slice));
        }
        this.blockIndexMap.set(i, sha512);
        entries.push({ blockIndex: i, zero: false, sha512 });
      }
    }

    return {
      schema: 'awesomeos.cas-v11-block-disk.v1',
      slot,
      totalBytes: this.totalBytes,
      blockSize: this.blockSize,
      sparseZeroBlocks: this.sparseCount,
      physicalCasBlocks: this.store.size,
      blocks: entries,
    };
  }

  readRange(offset: number, length: number): Uint8Array {
    if (offset < 0 || length < 0 || offset + length > this.totalBytes) {
      throw new Error('HoloCasBlockDevice: read out of bounds');
    }
    const out = new Uint8Array(length);
    let pos = 0;
    while (pos < length) {
      const abs = offset + pos;
      const blkIdx = Math.floor(abs / this.blockSize);
      const blkOff = abs % this.blockSize;
      const take = Math.min(length - pos, this.blockSize - blkOff);
      const hash = this.blockIndexMap.get(blkIdx);
      if (hash) {
        const blk = this.store.get(hash)!;
        out.set(blk.subarray(blkOff, blkOff + take), pos);
      }
      pos += take;
    }
    return out;
  }

  /** Handles a standard 28-byte Linux kernel NBD_CMD_READ wire request and returns the NBD reply packet. */
  handleNbdReadPacket(reqPacket: Uint8Array): Uint8Array {
    if (reqPacket.byteLength < 28) {
      throw new Error('HoloCasBlockDevice: truncated 28-byte NBD request');
    }
    const rv = new DataView(reqPacket.buffer, reqPacket.byteOffset, reqPacket.byteLength);
    const magic = rv.getUint32(0, false);
    if (magic !== NBD_REQUEST_MAGIC) {
      throw new Error(`HoloCasBlockDevice: invalid NBD_REQUEST_MAGIC 0x${magic.toString(16)}`);
    }
    const cmdType = rv.getUint16(6, false);
    const handle = rv.getBigUint64(8, false);
    const offset = Number(rv.getBigUint64(16, false));
    const length = rv.getUint32(24, false);

    if (cmdType !== NBD_CMD_READ) {
      const errReply = new Uint8Array(16);
      const ev = new DataView(errReply.buffer);
      ev.setUint32(0, NBD_SIMPLE_REPLY_MAGIC, false);
      ev.setUint32(4, 1, false); // EPERM (read-only immutable slot!)
      ev.setBigUint64(8, handle, false);
      return errReply;
    }

    const data = this.readRange(offset, length);
    const reply = new Uint8Array(16 + data.byteLength);
    const dv = new DataView(reply.buffer);
    dv.setUint32(0, NBD_SIMPLE_REPLY_MAGIC, false);
    dv.setUint32(4, 0, false); // OK
    dv.setBigUint64(8, handle, false);
    reply.set(data, 16);
    return reply;
  }
}

export interface CrostiniSysrootSpec {
  readonly name: string;
  readonly arch: 'x86_64' | 'aarch64' | 'riscv64';
  readonly packages: readonly string[];
  readonly casRoot?: string;
}

export interface CrostiniSysrootPlan {
  readonly containerName: string;
  readonly rootfsDir: string;
  readonly unshareCmd: readonly string[];
  readonly apkMirrors: readonly string[];
  readonly packages: readonly string[];
}

export function buildRootlessCrostiniPlan(spec: CrostiniSysrootSpec): CrostiniSysrootPlan {
  const casRoot = spec.casRoot || '/var/lib/b8g/cas';
  const safeName = spec.name.replace(/[^a-zA-Z0-9_-]/g, '-');
  const rootfsDir = `${casRoot}/v11/crostini/${safeName}-${spec.arch}`;
  return {
    containerName: safeName,
    rootfsDir,
    apkMirrors: [`https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/${spec.arch}`],
    packages: ['alpine-baselayout', 'busybox', 'musl', ...spec.packages],
    unshareCmd: [
      'unshare',
      '--user',
      '--map-root-user',
      '--mount',
      '--pid',
      '--fork',
      '--uts',
      'chroot',
      rootfsDir,
      '/bin/sh',
      '-l',
    ],
  };
}
