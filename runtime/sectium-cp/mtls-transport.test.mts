/**
 * @file sections/sectium-cloud-control-plane/mtls-transport.test.mts
 * @description Gate 5 verification suite:
 *  1. Valid Ed25519 peer handshake passes for pinned peer.
 *  2. Untrusted peer fingerprint is rejected with `ERR_UNAUTHORIZED_PEER`.
 *  3. Tampered signature / modified challenge is rejected with `ERR_INVALID_SIGNATURE`
 *     (and expired challenge is rejected with `ERR_EXPIRED_CHALLENGE`).
 *  4. Revoked peer is immediately rejected.
 *  5. 50-cycle rapid soak test on `SectiumCloudControlPlane`
 *     (`wakeDetached -> checkpointRamEpoch -> attachOpaquePeer(command + display) -> powerOff -> warmResume`)
 *     verifying 0 errors, monotonic `snapshotEpoch`, `warmResumed === true`, and total elapsed ms.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { SectiumCloudControlPlane } from './index.mts';
import {
  SectiumAuthErrorCode,
  SectiumPeerAuthenticator,
  generatePeerIdentity,
} from './mtls-transport.mts';

function uniquePipePath(tag: string): string {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sectium-mtls-${tag}-${nonce}`;
  }
  return `/tmp/sectium-mtls-${tag}-${nonce}.sock`;
}

describe('Gate 5: Opaque Remote Peer Ed25519/mTLS Auth & 50-Cycle Warm-Resume Soak', () => {
  it('1. valid Ed25519 peer handshake passes for pinned peer', () => {
    const auth = new SectiumPeerAuthenticator();
    const peer = generatePeerIdentity('remote-peer-alpha');

    assert.equal(peer.peerId, 'remote-peer-alpha');
    assert.ok(peer.publicKeyPem.includes('BEGIN PUBLIC KEY'));
    assert.ok(peer.privateKeyPem.includes('BEGIN PRIVATE KEY'));
    assert.match(peer.fingerprintSha256, /^[0-9a-f]{64}$/);

    auth.trustPeer(peer.fingerprintSha256, peer.peerId);
    assert.equal(auth.isPeerTrusted(peer.fingerprintSha256), true);

    const challenge = auth.createChallenge(peer.peerId);
    assert.equal(challenge.peerId, peer.peerId);
    assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
    assert.equal(typeof challenge.timestamp, 'number');

    const signature = auth.signChallenge(challenge, peer.privateKeyPem);
    const result = auth.verifyHandshake({
      peerId: peer.peerId,
      publicKeyPem: peer.publicKeyPem,
      challenge,
      signature,
    });

    assert.deepEqual(result, {
      ok: true,
      peerId: peer.peerId,
      fingerprintSha256: peer.fingerprintSha256,
    });
  });

  it('2. untrusted peer fingerprint is rejected with ERR_UNAUTHORIZED_PEER', () => {
    const auth = new SectiumPeerAuthenticator();
    const trustedPeer = generatePeerIdentity('trusted-peer');
    const roguePeer = generatePeerIdentity('rogue-peer');

    auth.trustPeer(trustedPeer.fingerprintSha256, trustedPeer.peerId);

    const challenge = auth.createChallenge(roguePeer.peerId);
    const signature = auth.signChallenge(challenge, roguePeer.privateKeyPem);
    const result = auth.verifyHandshake({
      peerId: roguePeer.peerId,
      publicKeyPem: roguePeer.publicKeyPem,
      challenge,
      signature,
    });

    assert.deepEqual(result, {
      ok: false,
      errorCode: SectiumAuthErrorCode.ERR_UNAUTHORIZED_PEER,
    });

    // Impersonating trusted peerId with an untrusted key must also fail
    const impersonationChallenge = auth.createChallenge(trustedPeer.peerId);
    const impersonationSig = auth.signChallenge(impersonationChallenge, roguePeer.privateKeyPem);
    const impersonationResult = auth.verifyHandshake({
      peerId: trustedPeer.peerId,
      publicKeyPem: roguePeer.publicKeyPem,
      challenge: impersonationChallenge,
      signature: impersonationSig,
    });

    assert.deepEqual(impersonationResult, {
      ok: false,
      errorCode: SectiumAuthErrorCode.ERR_UNAUTHORIZED_PEER,
    });
  });

  it('3. tampered signature, modified challenge, and expired challenge are rejected', () => {
    let clock = 1_700_000_000_000;
    const auth = new SectiumPeerAuthenticator({
      challengeTtlMs: 10_000,
      now: () => clock,
    });
    const peer = generatePeerIdentity('remote-peer-beta');
    auth.trustPeer(peer.fingerprintSha256, peer.peerId);

    const challenge = auth.createChallenge(peer.peerId);
    const signature = auth.signChallenge(challenge, peer.privateKeyPem);

    // 3a. Tampered signature bytes -> ERR_INVALID_SIGNATURE
    const sigBuf = Buffer.from(signature, 'base64');
    sigBuf[0] ^= 0xff;
    const tamperedSigResult = auth.verifyHandshake({
      peerId: peer.peerId,
      publicKeyPem: peer.publicKeyPem,
      challenge,
      signature: sigBuf.toString('base64'),
    });
    assert.deepEqual(tamperedSigResult, {
      ok: false,
      errorCode: SectiumAuthErrorCode.ERR_INVALID_SIGNATURE,
    });

    // 3b. Modified challenge nonce -> ERR_INVALID_SIGNATURE
    const modifiedNonce =
      (challenge.nonce.startsWith('0') ? '1' : '0') + challenge.nonce.slice(1);
    const modifiedChallengeResult = auth.verifyHandshake({
      peerId: peer.peerId,
      publicKeyPem: peer.publicKeyPem,
      challenge: { ...challenge, nonce: modifiedNonce },
      signature,
    });
    assert.deepEqual(modifiedChallengeResult, {
      ok: false,
      errorCode: SectiumAuthErrorCode.ERR_INVALID_SIGNATURE,
    });

    // 3c. Expired challenge -> ERR_EXPIRED_CHALLENGE
    clock += 10_001;
    const expiredResult = auth.verifyHandshake({
      peerId: peer.peerId,
      publicKeyPem: peer.publicKeyPem,
      challenge,
      signature,
    });
    assert.deepEqual(expiredResult, {
      ok: false,
      errorCode: SectiumAuthErrorCode.ERR_EXPIRED_CHALLENGE,
    });
  });

  it('4. revoked peer is immediately rejected', () => {
    const auth = new SectiumPeerAuthenticator();
    const peer = generatePeerIdentity('remote-peer-gamma');
    auth.trustPeer(peer.fingerprintSha256, peer.peerId);

    const challenge1 = auth.createChallenge(peer.peerId);
    const sig1 = auth.signChallenge(challenge1, peer.privateKeyPem);
    const beforeRevoke = auth.verifyHandshake({
      peerId: peer.peerId,
      publicKeyPem: peer.publicKeyPem,
      challenge: challenge1,
      signature: sig1,
    });
    assert.equal(beforeRevoke.ok, true);

    assert.equal(auth.revokePeer(peer.fingerprintSha256), true);
    assert.equal(auth.isPeerTrusted(peer.fingerprintSha256), false);

    const challenge2 = auth.createChallenge(peer.peerId);
    const sig2 = auth.signChallenge(challenge2, peer.privateKeyPem);
    const afterRevoke = auth.verifyHandshake({
      peerId: peer.peerId,
      publicKeyPem: peer.publicKeyPem,
      challenge: challenge2,
      signature: sig2,
    });
    assert.deepEqual(afterRevoke, {
      ok: false,
      errorCode: SectiumAuthErrorCode.ERR_UNAUTHORIZED_PEER,
    });
  });

  it('5. 50-cycle rapid soak test on SectiumCloudControlPlane (wakeDetached -> checkpointRamEpoch -> attachOpaquePeer(command+display) -> powerOff -> warmResume)', async () => {
    const CYCLES = 50;
    const cp = new SectiumCloudControlPlane({
      pipePath: uniquePipePath('soak50'),
      endpoint: 'sectium://control-plane.soak:9443',
    });

    const startMs = performance.now();
    let previousEpoch = 0;

    try {
      // Initial cold wake (epoch 0)
      const coldWake = await cp.wakeDetached();
      assert.equal(coldWake.online, true);
      assert.equal(coldWake.warmResumed, false);
      assert.equal(coldWake.snapshotEpoch, 0);

      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        const ckpt = cp.checkpointRamEpoch({ label: `soak-cycle-${cycle}` });
        assert.equal(ckpt.epoch, cycle);
        assert.ok(ckpt.epoch > previousEpoch, `snapshotEpoch must be strictly monotonic at cycle ${cycle}`);
        previousEpoch = ckpt.epoch;

        const cmdPeer = await cp.attachOpaquePeer('command', `soak-cmd-peer-${cycle}`);
        const dispPeer = await cp.attachOpaquePeer('display', `soak-disp-peer-${cycle}`, {
          surface: 'kitty',
        });
        assert.equal(cmdPeer.opaque, true);
        assert.equal(dispPeer.opaque, true);

        const offStatus = await cp.powerOff();
        assert.equal(offStatus.online, false);
        assert.equal(offStatus.snapshotEpoch, cycle);

        const warmWake = await cp.wakeDetached();
        assert.equal(warmWake.online, true);
        assert.equal(warmWake.warmResumed, true);
        assert.equal(warmWake.snapshotEpoch, cycle);
      }

      const elapsedMs = performance.now() - startMs;
      assert.equal(cp.snapshotEpoch, CYCLES);
      assert.equal(cp.warmResumed, true);
      assert.ok(elapsedMs >= 0 && Number.isFinite(elapsedMs));

      console.log(
        `[gate5-soak] ${CYCLES} cycles completed with 0 errors in ${elapsedMs.toFixed(2)} ms (${(elapsedMs / CYCLES).toFixed(2)} ms/cycle), final snapshotEpoch=${cp.snapshotEpoch}`,
      );
    } finally {
      await cp.powerOff();
    }
  });
});
