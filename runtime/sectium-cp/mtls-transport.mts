/**
 * @file sections/sectium-cloud-control-plane/mtls-transport.mts
 * @description Zero-dependency Ed25519 mutual-authentication (mTLS-style) peer
 * identity and challenge-response handshake verifier for opaque remote peers
 * connecting to `SectiumCloudControlPlane`.
 *
 * Uses `node:crypto` exclusively and adheres to `erasableSyntaxOnly: true`.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export const SectiumAuthErrorCode = {
  ERR_UNAUTHORIZED_PEER: 'ERR_UNAUTHORIZED_PEER',
  ERR_INVALID_SIGNATURE: 'ERR_INVALID_SIGNATURE',
  ERR_EXPIRED_CHALLENGE: 'ERR_EXPIRED_CHALLENGE',
} as const;

export type SectiumAuthErrorCodeValue =
  (typeof SectiumAuthErrorCode)[keyof typeof SectiumAuthErrorCode];

export interface SectiumPeerIdentity {
  peerId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprintSha256: string;
}

export interface SectiumPeerChallenge {
  peerId: string;
  nonce: string;
  timestamp: number;
}

export interface SectiumHandshakePayload {
  peerId: string;
  publicKeyPem: string;
  challenge: SectiumPeerChallenge;
  signature: string;
}

export type SectiumHandshakeResult =
  | {
      ok: true;
      peerId: string;
      fingerprintSha256: string;
    }
  | {
      ok: false;
      errorCode: SectiumAuthErrorCodeValue;
    };

export interface SectiumPeerAuthenticatorOptions {
  /** Maximum age of a challenge in milliseconds before `ERR_EXPIRED_CHALLENGE`. Default: 30_000 ms. */
  challengeTtlMs?: number;
  /** Maximum tolerated future clock skew in milliseconds. Default: 5_000 ms. */
  maxClockSkewMs?: number;
  /** Optional clock provider for deterministic testing. */
  now?: () => number;
}

const CHALLENGE_DOMAIN_PREFIX = 'sectium-mtls-ed25519-v1';
const NONCE_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Computes the canonical lowercase SHA-256 hex fingerprint of an Ed25519 SPKI
 * public key PEM.
 */
export function computePublicKeyFingerprint(publicKeyPem: string): string {
  const keyObj = createPublicKey(publicKeyPem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Serializes a challenge into the canonical byte payload signed/verified by Ed25519.
 */
function serializeChallengePayload(challenge: SectiumPeerChallenge): Buffer {
  return Buffer.from(
    `${CHALLENGE_DOMAIN_PREFIX}:${challenge.peerId}:${challenge.nonce}:${challenge.timestamp}`,
    'utf8',
  );
}

/**
 * Generates a fresh Ed25519 peer identity (`publicKeyPem`, `privateKeyPem`,
 * and canonical SPKI `fingerprintSha256`) using `node:crypto`.
 */
export function generatePeerIdentity(peerId: string): SectiumPeerIdentity {
  const normalizedPeerId = peerId.trim();
  if (normalizedPeerId.length === 0) {
    throw new RangeError('generatePeerIdentity requires a non-empty "peerId"');
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const fingerprintSha256 = computePublicKeyFingerprint(publicKey);

  return {
    peerId: normalizedPeerId,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    fingerprintSha256,
  };
}

/**
 * Ed25519 pinned-fingerprint challenge-response authenticator for opaque
 * Sectium remote peers.
 */
export class SectiumPeerAuthenticator {
  readonly #trustedPeers = new Map<string, string>();
  readonly #challengeTtlMs: number;
  readonly #maxClockSkewMs: number;
  readonly #now: () => number;

  constructor(options: SectiumPeerAuthenticatorOptions = {}) {
    this.#challengeTtlMs = options.challengeTtlMs ?? 30_000;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Pins a peer's SHA-256 public key fingerprint in the trusted set.
   */
  trustPeer(fingerprintSha256: string, peerId: string): void {
    const normalizedFp = fingerprintSha256.trim().toLowerCase();
    const normalizedPeerId = peerId.trim();
    if (normalizedFp.length === 0) {
      throw new RangeError('trustPeer requires a non-empty "fingerprintSha256"');
    }
    if (normalizedPeerId.length === 0) {
      throw new RangeError('trustPeer requires a non-empty "peerId"');
    }
    this.#trustedPeers.set(normalizedFp, normalizedPeerId);
  }

  /**
   * Immediately revokes a pinned peer fingerprint from the trusted set.
   */
  revokePeer(fingerprintSha256: string): boolean {
    const normalizedFp = fingerprintSha256.trim().toLowerCase();
    return this.#trustedPeers.delete(normalizedFp);
  }

  /**
   * Returns whether a SHA-256 fingerprint is currently pinned.
   */
  isPeerTrusted(fingerprintSha256: string): boolean {
    return this.#trustedPeers.has(fingerprintSha256.trim().toLowerCase());
  }

  /**
   * Creates a 32-byte random hex nonce challenge bound to `peerId` and the current timestamp.
   */
  createChallenge(peerId: string): SectiumPeerChallenge {
    const normalizedPeerId = peerId.trim();
    if (normalizedPeerId.length === 0) {
      throw new RangeError('createChallenge requires a non-empty "peerId"');
    }
    return {
      peerId: normalizedPeerId,
      nonce: randomBytes(32).toString('hex'),
      timestamp: this.#now(),
    };
  }

  /**
   * Signs a challenge using an Ed25519 PKCS#8 private key PEM, returning a base64 signature.
   */
  signChallenge(challenge: SectiumPeerChallenge, privateKeyPem: string): string {
    const payload = serializeChallengePayload(challenge);
    const sig = cryptoSign(null, payload, privateKeyPem);
    return sig.toString('base64');
  }

  /**
   * Verifies that:
   *  1. The peer's SPKI SHA-256 fingerprint is pinned for `peerId` (`ERR_UNAUTHORIZED_PEER`).
   *  2. The challenge timestamp is within the allowed TTL window (`ERR_EXPIRED_CHALLENGE`).
   *  3. The Ed25519 signature over the canonical challenge payload is valid (`ERR_INVALID_SIGNATURE`).
   */
  verifyHandshake(handshake: SectiumHandshakePayload): SectiumHandshakeResult {
    const { peerId, publicKeyPem, challenge, signature } = handshake;

    let fingerprintSha256: string;
    try {
      fingerprintSha256 = computePublicKeyFingerprint(publicKeyPem);
    } catch {
      return { ok: false, errorCode: SectiumAuthErrorCode.ERR_UNAUTHORIZED_PEER };
    }

    const pinnedPeerId = this.#trustedPeers.get(fingerprintSha256);
    if (pinnedPeerId === undefined || pinnedPeerId !== peerId) {
      return { ok: false, errorCode: SectiumAuthErrorCode.ERR_UNAUTHORIZED_PEER };
    }

    if (
      !Number.isFinite(challenge.timestamp) ||
      this.#now() - challenge.timestamp > this.#challengeTtlMs ||
      challenge.timestamp - this.#now() > this.#maxClockSkewMs
    ) {
      return { ok: false, errorCode: SectiumAuthErrorCode.ERR_EXPIRED_CHALLENGE };
    }

    if (
      challenge.peerId !== peerId ||
      !NONCE_HEX_PATTERN.test(challenge.nonce) ||
      typeof signature !== 'string' ||
      signature.length === 0
    ) {
      return { ok: false, errorCode: SectiumAuthErrorCode.ERR_INVALID_SIGNATURE };
    }

    try {
      const payload = serializeChallengePayload(challenge);
      const signatureBytes = Buffer.from(signature, 'base64');
      const valid = cryptoVerify(null, payload, publicKeyPem, signatureBytes);
      if (!valid) {
        return { ok: false, errorCode: SectiumAuthErrorCode.ERR_INVALID_SIGNATURE };
      }
    } catch {
      return { ok: false, errorCode: SectiumAuthErrorCode.ERR_INVALID_SIGNATURE };
    }

    return {
      ok: true,
      peerId,
      fingerprintSha256,
    };
  }
}
