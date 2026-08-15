import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it, jest,
} from '@jest/globals';
import {
  createSandbox, licenseBody, runToolkit, type Sandbox,
} from '../helpers/harness.js';

const originalFetch = globalThis.fetch;

/**
 * Scripts the activation service.
 *
 * The command talks to the service through global `fetch`, so replacing it here
 * exercises the real code path — including the licence verification the command
 * performs on whatever the service returns.
 */
const stubService = (responses: unknown[]): { calls: string[] } => {
  const calls: string[] = [];
  let index = 0;

  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: unknown) => {
    calls.push(String(url));
    const body = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { ok: true, status: 200, json: async () => body };
  });

  return { calls };
};

const deviceStart = {
  status: 200,
  deviceCode: 'device-code',
  userCode: 'GOVP-7K2Q-8XPD',
  verificationUri: 'https://govplane.com/activate',
  verificationUriComplete: 'https://govplane.com/activate?code=GOVP-7K2Q-8XPD',
  // Zero-length interval keeps the test instant; the sleep is real but 1ms.
  interval: 0.001,
  expiresIn: 600,
};

describe('govplane activate', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  it('completes activation and stores a verified licence', async () => {
    const license = sandbox.signer.sign(licenseBody({ email: 'dev@example.com' }));
    stubService([deviceStart, { status: 'activated', license }]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('GOVP-7K2Q-8XPD');
    expect(result.stdout).toContain('Activated for dev@*******');
    expect(result.stdout).not.toContain('dev@example.com');
    expect(result.stdout).toContain('This machine will not contact Govplane again.');
    expect(existsSync(join(sandbox.home, 'license.json'))).toBe(true);
  });

  it('completes activation when the licence carries no email', async () => {
    const license = sandbox.signer.sign(licenseBody({ anonymous: true }));
    stubService([deviceStart, { status: 'activated', license }]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    // No subject to report, so the line stops at the outcome.
    expect(result.stdout).toContain('✓ Activated');
    expect(result.stdout).not.toContain('Activated for');
    expect(result.stdout).not.toContain('*******');
    expect(result.stdout).toContain('This machine will not contact Govplane again.');
    expect(existsSync(join(sandbox.home, 'license.json'))).toBe(true);
  });

  it('stores the licence readable only by its owner', async () => {
    const license = sandbox.signer.sign(licenseBody());
    stubService([deviceStart, { status: 'activated', license }]);

    await runToolkit(['activate', '--no-browser'], sandbox);

     
    expect(statSync(join(sandbox.home, 'license.json')).mode & 0o777).toBe(0o600);
  });

  it('never prints the signature value', async () => {
    const license = sandbox.signer.sign(licenseBody());
    stubService([deviceStart, { status: 'activated', license }]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);
    expect(result.stdout).not.toContain(license.signature.value);
    expect(result.stderr).not.toContain(license.signature.value);
  });

  it('records a declined marketing preference as a valid licence', async () => {
    const license = sandbox.signer.sign(licenseBody({ marketingConsent: false }));
    stubService([deviceStart, { status: 'activated', license }]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Product news:  not subscribed');
  });

  it('records an accepted marketing preference', async () => {
    const license = sandbox.signer.sign(licenseBody({ marketingConsent: true }));
    stubService([deviceStart, { status: 'activated', license }]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);
    expect(result.stdout).toContain('Product news:  subscribed');
  });

  it('waits through pending responses', async () => {
    const license = sandbox.signer.sign(licenseBody());
    const service = stubService([
      deviceStart,
      { status: 'pending' },
      { status: 'pending' },
      { status: 'activated', license },
    ]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);
    expect(result.code).toBe(ExitCode.Success);
    expect(service.calls).toHaveLength(4);
    expect(service.calls[0]).toContain('/v1/activation/device/start');
    expect(service.calls[1]).toContain('/v1/activation/device/poll');
  });

  it('reports a declined activation', async () => {
    stubService([deviceStart, { status: 'denied' }]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('Activation was declined.');
  });

  it('reports an expired activation', async () => {
    stubService([deviceStart, { status: 'expired' }]);

    const result = await runToolkit(['activate', '--no-browser'], sandbox);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('expired');
  });

  it('points an offline machine at the air-gapped path', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    const result = await runToolkit(['activate', '--no-browser'], sandbox);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('govplane activate --license');
  });

  it('rejects a licence the service could not have signed', async () => {
    const other = createSandbox();
    try {
      const foreign = other.signer.sign(licenseBody());
      stubService([deviceStart, { status: 'activated', license: foreign }]);

      const result = await runToolkit(['activate', '--no-browser'], sandbox);
      expect(result.code).toBe(ExitCode.Compatibility);
      expect(result.stderr).toContain('could not be verified');
      expect(existsSync(join(sandbox.home, 'license.json'))).toBe(false);
    } finally {
      other.cleanup();
    }
  });

  it('does not contact the service when already activated', async () => {
    sandbox.installLicense({ email: 'existing@example.com' });
    const service = stubService([deviceStart]);

    const result = await runToolkit(['activate'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('already activated for existing@*******');
    expect(service.calls).toHaveLength(0);
  });

  it('activates again when forced', async () => {
    sandbox.installLicense({ email: 'old@example.com' });
    const replacement = sandbox.signer.sign(licenseBody({
      email: 'new@example.com',
      licenseId: 'lic_test_0002',
    }));
    stubService([deviceStart, { status: 'activated', license: replacement }]);

    const result = await runToolkit(['activate', '--force', '--no-browser'], sandbox);
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('new@*******');
  });

  it('emits machine-readable output', async () => {
    const license = sandbox.signer.sign(licenseBody());
    stubService([deviceStart, { status: 'activated', license }]);

    const result = await runToolkit(['activate', '--no-browser', '--format', 'json'], sandbox);
    const payload = result.json() as Record<string, unknown>;

    expect(payload.success).toBe(true);
    // Deliberately unmasked: JSON is read by scripts. Only human-readable output masks it.
    expect(payload.email).toBe('dev@example.com');
    expect(payload.signature).toBeUndefined();
  });
});

describe('govplane activate --license', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  it('imports a licence without any network access', async () => {
    const service = stubService([deviceStart]);
    const license = sandbox.signer.sign(licenseBody({ email: 'airgap@example.com' }));
    sandbox.writeLicenseFile('govplane.license', license);

    const result = await runToolkit(['activate', '--license', './govplane.license'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('airgap@*******');
    expect(service.calls).toHaveLength(0);
    expect(existsSync(join(sandbox.home, 'license.json'))).toBe(true);
  });

  it('reports a missing file', async () => {
    const result = await runToolkit(['activate', '--license', './absent.license'], sandbox);
    expect(result.code).toBe(ExitCode.FileError);
  });

  it('reports a malformed file', async () => {
    sandbox.writeText('broken.license', '{ not json');
    const result = await runToolkit(['activate', '--license', './broken.license'], sandbox);

    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('not valid JSON');
  });

  it('refuses an unsigned licence', async () => {
    sandbox.writeLicenseFile('unsigned.license', licenseBody());
    const result = await runToolkit(['activate', '--license', './unsigned.license'], sandbox);

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(existsSync(join(sandbox.home, 'license.json'))).toBe(false);
  });
});
