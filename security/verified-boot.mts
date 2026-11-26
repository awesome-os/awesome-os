/**
 * @file security/verified-boot.mts
 * @description AwesomeOS Verified Boot & Omaha-Style Update Signer/Verifier (SHA-512 + Ed25519).
 *
 * Mirrors ChromeOS Verified Boot + Omaha update attestation:
 *   1. Canonicalizes manifest payload (excluding `signature`) into deterministic UTF-8 JSON
 *   2. Computes SHA-512 digest of the canonical payload
 *   3. Signs & verifies with Ed25519 (RFC 8032), exporting raw 32-byte public key hex
 *      compatible with both Node `node:crypto` and Browser WebCrypto `Ed25519`.
 *
 * Strictly `erasableSyntaxOnly: true`, Node 22+ built-ins only.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export interface Ed25519KeyMaterial {
  readonly keyId: string;
  readonly publicKeyHex: string; // 32-byte raw Ed25519 public key (64 hex chars)
  readonly publicKeySpkiDerHex: string;
  readonly privateKeyPkcs8DerHex: string;
}

export interface VerifiedBootSignature {
  readonly scheme: 'ed25519-sha512-v1';
  readonly keyId: string;
  readonly publicKeyHex: string;
  readonly payloadSha512: string;
  readonly signatureHex: string;
  readonly signedAt: string;
}

/** Canonical SPKI DER prefix for a 32-byte raw Ed25519 public key (RFC 8410) */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Deterministic AwesomeOS v11 Ed25519 seed phrase for reproducible CI dev-signing when no HSM key is injected */
const DEV_ROOT_SEED_LABEL = 'awesomeos-verified-boot-dev-root-v11-0x33564742';

/** Canonicalize any JSON value with lexicographically sorted object keys */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalizeJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => k !== 'signature' && obj[k] !== undefined)
    .sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalizeJson(obj[k])).join(',') +
    '}'
  );
}

export function sha512HexUtf8(text: string): string {
  return createHash('sha512').update(text, 'utf8').digest('hex');
}

export function generateEd25519RootKey(keyId = 'awesomeos-root-2026'): Ed25519KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const rawPub = spki.subarray(spki.length - 32);
  return {
    keyId,
    publicKeyHex: Buffer.from(rawPub).toString('hex'),
    publicKeySpkiDerHex: Buffer.from(spki).toString('hex'),
    privateKeyPkcs8DerHex: Buffer.from(pkcs8).toString('hex'),
  };
}

/** Derives a deterministic Ed25519 PKCS#8 key from a 32-byte seed (RFC 8410) */
export function deriveEd25519KeyFromSeed(
  seedHex32: string,
  keyId = 'awesomeos-root-v11',
): Ed25519KeyMaterial {
  const seed = Buffer.from(seedHex32, 'hex');
  if (seed.length !== 32) {
    throw new Error('verified-boot: Ed25519 seed must be 32 bytes (64 hex chars)');
  }
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8 = Buffer.concat([pkcs8Prefix, seed]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  const spki = pub.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(spki.length - 32);
  return {
    keyId,
    publicKeyHex: Buffer.from(rawPub).toString('hex'),
    publicKeySpkiDerHex: Buffer.from(spki).toString('hex'),
    privateKeyPkcs8DerHex: pkcs8.toString('hex'),
  };
}

export function defaultAwesomeOsRootKey(): Ed25519KeyMaterial {
  const envSeed = process.env.AWESOMEOS_ED25519_SEED_HEX;
  const seedHex =
    envSeed && /^[0-9a-fA-F]{64}$/.test(envSeed)
      ? envSeed
      : createHash('sha256').update(DEV_ROOT_SEED_LABEL, 'utf8').digest('hex');
  return deriveEd25519KeyFromSeed(seedHex, 'awesomeos-root-v11');
}

export function signManifestEd25519<T extends Record<string, unknown>>(
  manifest: T,
  key: Ed25519KeyMaterial = defaultAwesomeOsRootKey(),
  signedAt = new Date().toISOString(),
): T & { readonly signature: VerifiedBootSignature } {
  const canonical = canonicalizeJson(manifest);
  const payloadSha512 = sha512HexUtf8(canonical);
  const priv = createPrivateKey({
    key: Buffer.from(key.privateKeyPkcs8DerHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  const sigBuf = sign(null, Buffer.from(canonical, 'utf8'), priv);
  const signature: VerifiedBootSignature = {
    scheme: 'ed25519-sha512-v1',
    keyId: key.keyId,
    publicKeyHex: key.publicKeyHex,
    payloadSha512,
    signatureHex: sigBuf.toString('hex'),
    signedAt,
  };
  return { ...manifest, signature };
}

export function verifyManifestEd25519(
  signedManifest: Record<string, unknown>,
  trustedPublicKeyHex?: string,
): { readonly valid: boolean; readonly reason?: string; readonly payloadSha512: string } {
  const sigObj = signedManifest.signature as VerifiedBootSignature | undefined;
  if (!sigObj || sigObj.scheme !== 'ed25519-sha512-v1') {
    return { valid: false, reason: 'missing or unsupported signature scheme', payloadSha512: '' };
  }
  const pubHex = (trustedPublicKeyHex || sigObj.publicKeyHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubHex)) {
    return { valid: false, reason: 'invalid 32-byte Ed25519 public key hex', payloadSha512: '' };
  }
  if (trustedPublicKeyHex && sigObj.publicKeyHex.toLowerCase() !== pubHex) {
    return { valid: false, reason: 'public key pin mismatch', payloadSha512: '' };
  }

  const canonical = canonicalizeJson(signedManifest);
  const payloadSha512 = sha512HexUtf8(canonical);
  if (payloadSha512 !== sigObj.payloadSha512) {
    return { valid: false, reason: 'canonical SHA-512 digest mismatch', payloadSha512 };
  }

  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubHex, 'hex')]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const ok = verify(
    null,
    Buffer.from(canonical, 'utf8'),
    pub,
    Buffer.from(sigObj.signatureHex, 'hex'),
  );
  return ok
    ? { valid: true, payloadSha512 }
    : { valid: false, reason: 'Ed25519 cryptographic signature verification failed', payloadSha512 };
}
