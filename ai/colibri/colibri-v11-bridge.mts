/**
 * @file awesome-os/colibri-v11-bridge.mts
 * @description Awesome-OS v11 CAS expert/GGUF shard deduplication bridge &
 * LumiBERT 2.8ms catalog overlay for awesome-os/colibri.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AwesomeModelOverlay {
  id: string;
  name: string;
  family: string;
  latencyMs: number;
  ramMinGb: number;
  ramGoodGb: number;
  diskGb: number;
  ipcPipeWin: string;
  ipcSockPosix: string;
  workspaceUri: string;
  summary: string;
}

export const AWESOME_OS_COLIBRI_MODELS: readonly AwesomeModelOverlay[] = [
  {
    id: 'lumibert-2.8ms',
    name: 'LumiBERT 2.8ms Auto-Repair & Router',
    family: 'lumibert',
    latencyMs: 2.8,
    ramMinGb: 0.25,
    ramGoodGb: 0.5,
    diskGb: 0.18,
    ipcPipeWin: '\\\\.\\pipe\\b8g-colibri',
    ipcSockPosix: '/run/b8g/colibri.sock',
    workspaceUri: 'workspaces://awesome-os/ai-colibri',
    summary: 'Ultra-low-latency 2.8 ms compiler diagnostic auto-repair & MoE/tool router for Awesome-OS.',
  },
];

export function ingestModelShardToV11Cas(
  srcFile: string,
  casRoot: string,
  projectTargets: string[] = [],
): { sha512: string; casBlobPath: string; projected: string[] } {
  const bytes = readFileSync(srcFile);
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  const shardDir = join(casRoot, 'v11', 'files', sha512.slice(0, 2));
  mkdirSync(shardDir, { recursive: true });
  const casBlobPath = join(shardDir, sha512);
  if (!existsSync(casBlobPath)) {
    copyFileSync(srcFile, casBlobPath);
  }

  const projected: string[] = [];
  for (const dst of projectTargets) {
    mkdirSync(dirname(dst), { recursive: true });
    if (!existsSync(dst)) {
      try {
        linkSync(casBlobPath, dst);
      } catch {
        copyFileSync(casBlobPath, dst);
      }
    }
    projected.push(dst);
  }

  return { sha512, casBlobPath, projected };
}
