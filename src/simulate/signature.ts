import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import {
  canonicalPayload, inspectSignature, readSignatureMetadata, readTextFile,
  type ProjectConfig, type RuntimeBundle,
} from '@govplane/cli';
import type { SigningConfig } from '../build/signing.js';

/**
 * Signature verification for simulation.
 *
 * Mirrors the SDK client: verification happens only when a signing
 * configuration is pinned. Without one it is skipped, because a developer
 * simulating a locally built bundle has nothing to verify against and should
 * not be blocked.
 */

export type SignatureStatus = 'valid' | 'invalid' | 'missing' | 'skipped' | 'unverifiable';

export interface SignatureCheck {
  status: SignatureStatus;
  algorithm?: string;
  keyId?: string;
  reason?: string;
}

export interface VerificationMaterial {
  /** Whether a signing configuration was pinned at all. */
  pinned: boolean;
  hmacSecret?: string | undefined;
  publicKey?: string | undefined;
}

const PUBLIC_KEY_ENV = 'GOVPLANE_PUBLIC_KEY';
const PUBLIC_KEY_PATH_ENV = 'GOVPLANE_PUBLIC_KEY_PATH';

/**
 * Collects whatever verification material the project has pinned.
 *
 * HMAC uses the same shared secret that signed the bundle; ECDSA uses a public
 * key. Neither is required to simulate — only to verify.
 */
export const resolveVerificationMaterial = (
  config: ProjectConfig,
  signing: SigningConfig,
  env: NodeJS.ProcessEnv,
  workingFolder: string,
): VerificationMaterial => {
  const secretVariable = signing.hmacSecretEnv;
  const hmacSecret = secretVariable === undefined ? undefined : env[secretVariable];

  const configuredKey = config.signature?.publicKeyPath;
  const inlineKey = env[PUBLIC_KEY_ENV];
  const keyPath = env[PUBLIC_KEY_PATH_ENV];

  let publicKey: string | undefined;
  if (configuredKey !== undefined) {
    publicKey = readTextFile(resolve(workingFolder, configuredKey));
  } else if (inlineKey !== undefined && inlineKey.trim() !== '') {
    publicKey = inlineKey;
  } else if (keyPath !== undefined && keyPath.trim() !== '') {
    publicKey = readTextFile(resolve(workingFolder, keyPath));
  }

  return {
    pinned: hmacSecret !== undefined || publicKey !== undefined,
    ...(hmacSecret === undefined ? {} : { hmacSecret }),
    ...(publicKey === undefined ? {} : { publicKey }),
  };
};

const verifyHmac = (
  bundle: RuntimeBundle,
  signatureValue: string,
  secret: string,
): boolean => {
  const expected = createHmac('sha256', Buffer.from(secret.trim(), 'hex'))
    .update(canonicalPayload(bundle))
    .digest('hex');

  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(signatureValue, 'utf8');

  // Length is compared first because timingSafeEqual throws on a mismatch; the
  // comparison itself stays constant-time.
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Verifies a bundle signature, when there is something to verify it against.
 *
 * Returns a status rather than throwing: the caller decides whether an invalid
 * signature stops the simulation, and the user can override that.
 */
export const checkSignature = (
  bundle: RuntimeBundle,
  material: VerificationMaterial,
): SignatureCheck => {
  const metadata = readSignatureMetadata(bundle);

  if (!material.pinned) {
    return { status: 'skipped', reason: 'No signing configuration is pinned.' };
  }

  if (metadata === null) {
    return {
      status: 'missing',
      reason: 'A signing configuration is pinned, but the bundle carries no signature.',
    };
  }

  if (metadata.algorithm === 'HMAC_SHA256') {
    if (material.hmacSecret === undefined) {
      return {
        status: 'unverifiable',
        algorithm: metadata.algorithm,
        keyId: metadata.keyId,
        reason: 'The bundle is HMAC-signed, but no shared secret is configured.',
      };
    }
    return {
      status: verifyHmac(bundle, metadata.value, material.hmacSecret) ? 'valid' : 'invalid',
      algorithm: metadata.algorithm,
      keyId: metadata.keyId,
    };
  }

  if (material.publicKey === undefined) {
    return {
      status: 'unverifiable',
      algorithm: metadata.algorithm,
      keyId: metadata.keyId,
      reason: `The bundle is ${metadata.algorithm}-signed, but no public key is configured.`,
    };
  }

  const inspection = inspectSignature({ bundle, publicKey: material.publicKey });
  return {
    status: inspection.status === 'valid' ? 'valid' : 'invalid',
    algorithm: metadata.algorithm,
    keyId: metadata.keyId,
    ...(inspection.reason === undefined ? {} : { reason: inspection.reason }),
  };
};
