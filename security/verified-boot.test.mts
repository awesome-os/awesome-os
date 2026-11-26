import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultAwesomeOsRootKey,
  generateEd25519RootKey,
  signManifestEd25519,
  verifyManifestEd25519,
} from './verified-boot.mts';

describe('AwesomeOS Verified Boot (SHA-512 + Ed25519)', () => {
  it('signs and verifies v11 update bundles deterministically', () => {
    const key = defaultAwesomeOsRootKey();
    assert.equal(key.publicKeyHex.length, 64);

    const signed = signManifestEd25519(
      {
        schema: 'awesome-os.web-v11-bundle.v1',
        abiMagic: '0x33564742',
        channel: 'stable',
        slot: 'slot-a',
        artifacts: [{ id: 'sectium-cp', sha512: 'a'.repeat(128), bytes: 5695 }],
      },
      key,
      '2026-11-26T10:00:00.000Z',
    );

    const res = verifyManifestEd25519(signed, key.publicKeyHex);
    assert.equal(res.valid, true);
    assert.equal(res.payloadSha512.length, 128);
  });

  it('rejects tampered payloads or wrong Ed25519 root keys', () => {
    const key = generateEd25519RootKey('test-root');
    const otherKey = generateEd25519RootKey('attacker-root');
    const signed = signManifestEd25519({ slot: 'slot-a', version: '7.3.6' }, key);

    assert.equal(verifyManifestEd25519(signed, otherKey.publicKeyHex).valid, false);

    const tampered = { ...signed, slot: 'slot-evil' };
    const bad = verifyManifestEd25519(tampered, key.publicKeyHex);
    assert.equal(bad.valid, false);
    assert.match(bad.reason || '', /SHA-512 digest mismatch/);
  });
});
