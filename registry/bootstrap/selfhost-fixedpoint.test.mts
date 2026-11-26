import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { B8G_ABI_MAGIC_V3, runSelfHostFixedPointProof } from './selfhost-fixedpoint.mts';

describe('CAS Q-Self Stage 0 -> Stage 1 -> Stage 2 Self-Hosting Fixed Point', () => {
  it('verifies wasi-host + holo-pm seeds in index/holo-compiler-lockfile.json and proves sha512(Stage 1) === sha512(Stage 2)', async () => {
    const proof = await runSelfHostFixedPointProof();
    assert.equal(proof.schema, 'awesome-os-cas-q-self-proof-v1');
    assert.equal(proof.abiMagic, '0x33564742');
    assert.equal(proof.casLayout, 'v11');
    assert.equal(proof.wasiHostSeedFound, true);
    assert.equal(proof.holoPmSeedFound, true);
    assert.equal(proof.stage1.abiMagic, B8G_ABI_MAGIC_V3);
    assert.equal(proof.stage2.abiMagic, B8G_ABI_MAGIC_V3);
    assert.equal(proof.stage1.evalCheck, 42);
    assert.equal(proof.stage2.evalCheck, 42);
    assert.equal(proof.stage1.sha512, proof.stage2.sha512);
    assert.equal(proof.stage2.deduplicated, true);
    assert.equal(proof.fixedPointReached, true);
  });
});
