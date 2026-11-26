import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AWESOME_OS_COLIBRI_MODELS, ingestModelShardToV11Cas } from './colibri-v11-bridge.mts';

describe('awesome-os/colibri v11 CAS & LumiBERT bridge', () => {
  it('registers LumiBERT 2.8ms with Host Pipe IPC and workspaces://awesome-os/ai-colibri', () => {
    const lumi = AWESOME_OS_COLIBRI_MODELS.find((m) => m.id === 'lumibert-2.8ms');
    assert.ok(lumi);
    assert.equal(lumi.latencyMs, 2.8);
    assert.equal(lumi.workspaceUri, 'workspaces://awesome-os/ai-colibri');
    assert.equal(lumi.ipcSockPosix, '/run/b8g/colibri.sock');
  });

  it('deduplicates model shards into cas/v11/files/<aa>/<sha512> and hardlinks across engines', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'colibri-v11-'));
    try {
      const src = join(tmp, 'expert-00.gguf');
      writeFileSync(src, 'MOCK_GGUF_EXPERT_SHARD_V11');
      const colibriDst = join(tmp, 'colibri-models', 'expert-00.gguf');
      const llamaDst = join(tmp, 'llama-models', 'expert-00.gguf');
      const res = ingestModelShardToV11Cas(src, join(tmp, 'cas'), [colibriDst, llamaDst]);
      assert.equal(res.sha512.length, 128);
      assert.ok(existsSync(res.casBlobPath));
      assert.equal(readFileSync(colibriDst, 'utf8'), 'MOCK_GGUF_EXPERT_SHARD_V11');
      assert.equal(readFileSync(llamaDst, 'utf8'), 'MOCK_GGUF_EXPERT_SHARD_V11');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
