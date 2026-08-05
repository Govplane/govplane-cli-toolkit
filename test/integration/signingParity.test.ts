import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPayload, computeChecksum, type RuntimeBundle } from '@govplane/cli';
import { verifyBundle, canonicalPayload as sdkCanonicalPayload } from '@govplane/runtime-sdk';
import {
  afterAll, describe, expect, it,
} from '@jest/globals';
import { signBundle } from '../../src/build/signing.js';

/**
 * Signing parity between the CLI and the SDK.
 *
 * The CLI signs a bundle; the SDK verifies it. If the two ever disagree about
 * which bytes a signature covers — by a key order, an encoding, a field in or
 * out of the projection — every signature Govplane issues stops verifying, and
 * it fails in production rather than here.
 *
 * That is not hypothetical. Before the 2.0 SDK there were **three** different
 * answers to "what does a signature cover?" across `gp-worker`, the CLI and the
 * SDK's two verification paths, and nothing caught it because each side only
 * ever tested against itself.
 *
 * This test lives in the toolkit because the toolkit is the one package that
 * legitimately depends on both. It adds no coupling that is not already there:
 * the CLI provides canonicalisation and the SDK provides the runtime engine
 * `simulate` runs on.
 */

const bundle = (): RuntimeBundle => (({
  schemaVersion: 1,
  orgId: 'org_parity',
  projectId: 'proj_parity',
  env: 'prod',
  generatedAt: '2026-08-03T00:00:00.000Z',
  bundleVersion: 4,
  policies: [{
    policyKey: 'login-protection',
    activeVersion: 2,
    defaults: { effect: 'allow' },
    rules: [{
      id: 'deny-after-five',
      status: 'active',
      priority: 100,
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
      effect: { type: 'deny' },
    }],
  }],
}));

/** Values chosen to catch encoding and ordering mistakes. */
const awkward = (): RuntimeBundle => (({
  policies: [{
    rules: [{
      effect: { type: 'deny' },
      target: { action: 'read', service: 'files', resource: '/documentos/ñ/日本' },
      priority: 10,
      id: 'unicode-rule',
      status: 'active',
    }],
    defaults: { effect: 'deny' },
    activeVersion: 1,
    policyKey: 'zeta',
  }],
  env: 'dev',
  projectId: 'proj_ñ',
  orgId: 'org_émoji_🔐',
  schemaVersion: 1,
}));

const HEX_SECRET = 'a7'.repeat(32);
const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PUBLIC_KEY = ecdsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();

// The toolkit signs from a key file, as the command-line flag supplies one.
const keyDir = mkdtempSync(join(tmpdir(), 'govplane-parity-'));
const PRIVATE_KEY_PATH = join(keyDir, 'signing-private.pem');
writeFileSync(
  PRIVATE_KEY_PATH,
  ecdsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

describe('the CLI and the SDK canonicalise identically', () => {
  it.each([
    ['a typical bundle', bundle],
    ['unicode and unsorted keys', awkward],
  ])('%s produces the same bytes in both implementations', (_label, make) => {
    const subject = make();

    // The two implementations are deliberately separate copies — the SDK cannot
    // depend on a CLI. This is what proves the copies still agree.
    expect(sdkCanonicalPayload(subject).toString('utf8'))
      .toBe(canonicalPayload(subject).toString('utf8'));
  });

  it('agrees on a bundle with no scope, as govplane build produces', () => {
    const scopeless = {
      schemaVersion: 1, env: 'prod', policies: [],
    } as unknown as RuntimeBundle;

    // Absent must stay absent rather than becoming null — the trap most likely
    // to differ between two implementations of the same projection.
    expect(sdkCanonicalPayload(scopeless).toString('utf8'))
      .toBe('{"env":"prod","policies":[],"schemaVersion":1}');
    expect(canonicalPayload(scopeless).toString('utf8'))
      .toBe(sdkCanonicalPayload(scopeless).toString('utf8'));
  });

  it('agrees on the checksum, which is derived from those bytes', () => {
    const subject = bundle();
    const viaSdk = verifyBundle(
      { ...subject, checksum: computeChecksum(subject) },
      { origin: 'local', allowUnsigned: true },
    );
    expect(viaSdk.checksum.status).toBe('verified');
  });
});

describe('a bundle the CLI signs, the SDK verifies', () => {
  it('verifies an HMAC signature end to end', () => {
    const subject = bundle();
    const signature = signBundle(subject, {
      algorithm: 'HMAC_SHA256',
      keyId: 'local-key-01',
      keySource: 'TEST_SECRET',
      hmacSecret: HEX_SECRET,
    });

    const verified = verifyBundle(
      { ...subject, signature },
      { origin: 'local', key: { algorithm: 'HMAC_SHA256', secret: HEX_SECRET } },
    );

    expect(verified.signature).toMatchObject({
      status: 'verified',
      algorithm: 'HMAC_SHA256',
      keyId: 'local-key-01',
    });
  });

  it('verifies an ECDSA signature end to end', () => {
    const subject = bundle();
    const signature = signBundle(subject, {
      algorithm: 'ECDSA_SHA_256',
      keyId: 'release-key',
      keySource: 'signing-private.pem',
      ecdsaPrivateKeyPath: PRIVATE_KEY_PATH,
    });

    const verified = verifyBundle(
      { ...subject, signature },
      { origin: 'local', key: { algorithm: 'ECDSA_SHA_256', publicKey: PUBLIC_KEY } },
    );

    expect(verified.signature.status).toBe('verified');
  });

  it('verifies a signature over unicode and unsorted keys', () => {
    const subject = awkward();
    const signature = signBundle(subject, {
      algorithm: 'HMAC_SHA256',
      keyId: 'k',
      keySource: 'TEST_SECRET',
      hmacSecret: HEX_SECRET,
    });

    expect(verifyBundle(
      { ...subject, signature },
      { origin: 'local', key: { algorithm: 'HMAC_SHA256', secret: HEX_SECRET } },
    ).signature.status).toBe('verified');
  });

  it('still rejects a bundle altered after the CLI signed it', () => {
    // Proves the parity above is not simply both sides accepting anything.
    const subject = bundle();
    const signature = signBundle(subject, {
      algorithm: 'HMAC_SHA256',
      keyId: 'k',
      keySource: 'TEST_SECRET',
      hmacSecret: HEX_SECRET,
    });

    const tampered = JSON.parse(JSON.stringify({ ...subject, signature })) as {
      policies: { activeVersion: number }[];
    };
    tampered.policies[0]!.activeVersion = 99;

    expect(() => verifyBundle(tampered, {
      origin: 'local',
      key: { algorithm: 'HMAC_SHA256', secret: HEX_SECRET },
    })).toThrow(/signature is not valid/i);
  });

  it('is unaffected by re-versioning, which sits outside the signed bytes', () => {
    const subject = bundle();
    const signature = signBundle(subject, {
      algorithm: 'HMAC_SHA256',
      keyId: 'k',
      keySource: 'TEST_SECRET',
      hmacSecret: HEX_SECRET,
    });

    // The control plane bumps bundleVersion and generatedAt on every
    // materialisation. Both implementations must agree these are excluded, or
    // re-publishing a bundle would invalidate its signature.
    const republished = {
      ...subject,
      signature,
      bundleVersion: 99,
      generatedAt: '2027-01-01T00:00:00.000Z',
    };

    expect(verifyBundle(republished, {
      origin: 'local',
      key: { algorithm: 'HMAC_SHA256', secret: HEX_SECRET },
    }).signature.status).toBe('verified');
  });
});
