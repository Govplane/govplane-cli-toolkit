import { statSync } from 'node:fs';
import { join } from 'node:path';
import { stringifyJson } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  licensePath, loadLicense, removeLicense, storeLicense, verifyLicense, isFreePlan,
} from '../../src/activation/license.js';
import { knownKeyIds, resolvePublicKey } from '../../src/activation/keys.js';
import {
  createSandbox, licenseBody, type Sandbox,
} from '../helpers/harness.js';

describe('verifyLicense', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('accepts a correctly signed licence', () => {
    const license = sandbox.signer.sign(licenseBody());
    const result = verifyLicense(license, { env: sandbox.env });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.subject?.email).toBe('dev@example.com');
      expect(isFreePlan(result.license)).toBe(true);
    }
  });

  // Giving an email address is optional, so the service issues licences with no subject
  // at all. The signature covers the canonical bytes, so this only verifies if the
  // reconstruction omits the key exactly as the signer did — which is the whole risk in
  // making the field optional.
  it('accepts a correctly signed licence with no subject', () => {
    const license = sandbox.signer.sign(licenseBody({ anonymous: true }));
    const result = verifyLicense(license, { env: sandbox.env });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.subject).toBeUndefined();
      expect('subject' in result.license).toBe(false);
      expect(isFreePlan(result.license)).toBe(true);
    }
  });

  it('rejects an anonymous licence whose subject was added after signing', () => {
    const license = sandbox.signer.sign(licenseBody({ anonymous: true }));
    const tampered = { ...license, subject: { email: 'attacker@example.com' } };

    const result = verifyLicense(tampered, { env: sandbox.env });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_SIGNATURE_INVALID');
    }
  });

  it('rejects a licence whose subject was stripped after signing', () => {
    const license = sandbox.signer.sign(licenseBody());
    const { subject, ...stripped } = license as unknown as Record<string, unknown>;

    const result = verifyLicense(stripped, { env: sandbox.env });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_SIGNATURE_INVALID');
    }
  });

  it('rejects a licence whose contents were edited after signing', () => {
    const license = sandbox.signer.sign(licenseBody());
    const tampered = { ...license, subject: { email: 'someone-else@example.com' } };

    const result = verifyLicense(tampered, { env: sandbox.env });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_SIGNATURE_INVALID');
    }
  });

  it('rejects a licence signed by a different key', () => {
    const other = createSandbox();
    try {
      const license = other.signer.sign(licenseBody());
      const result = verifyLicense(license, { env: sandbox.env });
      expect(result.ok).toBe(false);
    } finally {
      other.cleanup();
    }
  });

  it.each([
    ['not an object', 'nope'],
    ['a wrong schema version', { ...licenseBody(), schemaVersion: 2 }],
    ['no licence id', { ...licenseBody(), licenseId: '' }],
    // An absent subject is valid (anonymous activation); a subject that is present but
    // empty is not. It is a truncated document rather than a deliberate one, and the two
    // must not be conflated.
    ['an empty subject', { ...licenseBody(), subject: {} }],
    ['a blank email', { ...licenseBody(), subject: { email: '   ' } }],
    ['no plan', { ...licenseBody(), plan: '' }],
    ['no issue date', { ...licenseBody(), issuedAt: '' }],
    ['no terms', { ...licenseBody(), terms: { version: '1' } }],
    ['a non-boolean consent flag', { ...licenseBody(), marketingConsent: 'no' }],
  ])('rejects a licence with %s', (_label, document) => {
    const result = verifyLicense(document, { env: sandbox.env });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_INVALID_SCHEMA');
    }
  });

  it('rejects incomplete signature metadata', () => {
    const result = verifyLicense(
      { ...licenseBody(), signature: { algorithm: 'Ed25519' } },
      { env: sandbox.env },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_INVALID_SCHEMA');
    }
  });

  it('refuses a licence carrying an expiry this version cannot honour', () => {
    const license = sandbox.signer.sign(licenseBody());
    const result = verifyLicense(
      { ...license, expiresAt: '2027-01-01T00:00:00.000Z' },
      { env: sandbox.env },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_INVALID_SCHEMA');
      expect(result.reason).toContain('expiry');
    }
  });

  it('asks the user to update when the signing key is unknown', () => {
    // No public-key override: the licence names a key this build never ships.
    const license = sandbox.signer.sign(licenseBody(), 'license-key-99');
    const result = verifyLicense(license, { env: { GOVPLANE_HOME: sandbox.home } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_UNKNOWN_KEY');
      expect(result.reason).toContain('npm install --global @govplane/cli-toolkit@latest');
    }
  });
});

describe('loadLicense', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('reports a missing licence without treating it as an error condition', () => {
    const result = loadLicense(sandbox.env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_NOT_FOUND');
    }
  });

  it('reads the installed licence file', () => {
    const installed = sandbox.installLicense({ email: 'file@example.com' });
    const result = loadLicense(sandbox.env);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.licenseId).toBe(installed.licenseId);
      expect(result.source).toBe('file');
    }
  });

  it('prefers an inline licence from the environment', () => {
    sandbox.installLicense({ email: 'file@example.com' });
    const inline = sandbox.signer.sign(licenseBody({ email: 'ci@example.com' }));

    const result = loadLicense({ ...sandbox.env, GOVPLANE_LICENSE: JSON.stringify(inline) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.subject?.email).toBe('ci@example.com');
      expect(result.source).toBe('environment');
    }
  });

  it('reads a licence from a path in the environment', () => {
    const license = sandbox.signer.sign(licenseBody({ email: 'ci-file@example.com' }));
    const path = sandbox.writeLicenseFile('ci.license', license);

    const result = loadLicense({ ...sandbox.env, GOVPLANE_LICENSE_FILE: path });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('environment-file');
    }
  });

  it('reports a missing file named by the environment', () => {
    const result = loadLicense({
      ...sandbox.env,
      GOVPLANE_LICENSE_FILE: join(sandbox.project, 'absent.license'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_NOT_FOUND');
      expect(result.source).toBe('environment-file');
    }
  });

  it('reports malformed JSON', () => {
    sandbox.writeText('../home/license.json', '{ broken');
    const result = loadLicense(sandbox.env);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_INVALID_JSON');
    }
  });

  it('reports malformed inline JSON', () => {
    const result = loadLicense({ ...sandbox.env, GOVPLANE_LICENSE: '{ broken' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe('LICENSE_INVALID_JSON');
    }
  });
});

describe('storeLicense and removeLicense', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('writes the licence readable only by its owner', () => {
    const license = sandbox.signer.sign(licenseBody());
    const path = storeLicense(license, sandbox.env);

    expect(path).toBe(licensePath(sandbox.env));
     
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('round-trips through the filesystem', () => {
    const license = sandbox.signer.sign(licenseBody({ email: 'round@example.com' }));
    storeLicense(license, sandbox.env);

    const result = loadLicense(sandbox.env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.subject?.email).toBe('round@example.com');
    }
  });

  it('reports whether anything was removed', () => {
    expect(removeLicense(sandbox.env)).toBe(false);
    sandbox.installLicense();
    expect(removeLicense(sandbox.env)).toBe(true);
    expect(removeLicense(sandbox.env)).toBe(false);
  });

  it('serialises licences the same way the CLI serialises documents', () => {
    const license = sandbox.signer.sign(licenseBody());
    expect(stringifyJson(license).endsWith('\n')).toBe(true);
  });
});

describe('key resolution', () => {
  it('ships a key for every id it claims to know', () => {
    knownKeyIds().forEach((keyId) => {
      const lookup = resolvePublicKey(keyId, {});
      expect(lookup.unknownKeyId).toBe(false);
      expect(lookup.key).toContain('BEGIN PUBLIC KEY');
    });
  });

  it('flags an unknown key id', () => {
    expect(resolvePublicKey('nope', {})).toEqual({ key: null, unknownKeyId: true });
  });

  it('lets the environment override the shipped keys', () => {
    const lookup = resolvePublicKey('anything', { GOVPLANE_LICENSE_PUBLIC_KEY: 'inline-key' });
    expect(lookup).toEqual({ key: 'inline-key', unknownKeyId: false });
  });
});
