import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeChecksum, ExitCode, inspectSignature, stringifyJson, validateBundle,
  type RuntimeBundle,
} from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  createSandbox, daysAfterNow, NOW, runToolkit, type Sandbox,
} from '../helpers/harness.js';

const HEX_SECRET = 'a'.repeat(64);

const unsignedBundle = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  orgId: 'org_1',
  projectId: 'proj_1',
  env: 'prod',
  generatedAt: NOW,
  bundleVersion: 3,
  policies: [{
    policyKey: 'login-protection',
    activeVersion: 1,
    defaults: { effect: 'allow' },
    rules: [{
      id: 'deny-after-five-failures',
      status: 'active',
      priority: 100,
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      effect: { type: 'deny' },
    }],
  }],
  ...overrides,
});

const readBundle = (sandbox: Sandbox, name = 'policy-bundle.json'): RuntimeBundle => (
  JSON.parse(readFileSync(join(sandbox.project, name), 'utf8')) as RuntimeBundle
);

const HMAC = ['--signing-algorithm', 'HMAC_SHA256', '--hmac-secret-env', 'SIGN_SECRET'];
const withSecret = { env: { SIGN_SECRET: HEX_SECRET } };

describe('govplane sign', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-bundle.json', stringifyJson(unsignedBundle()));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('signs a bundle in place', async () => {
    const result = await runToolkit(['sign', ...HMAC], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Bundle signed successfully');
    expect(result.stdout).toContain('(in-place)');

    expect(readBundle(sandbox).signature).toMatchObject({
      algorithm: 'HMAC_SHA256',
      keyId: 'SIGN_SECRET',
    });
  });

  it('produces the same signature as build --signed', async () => {
    // "Same engine as build" is a design principle, not a coincidence: the two
    // commands must agree byte for byte on the same input.
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      env: 'prod',
      policies: unsignedBundle().policies,
    }));

    await runToolkit([
      'build', '--org-id', 'org_1', '--project-id', 'proj_1',
      '--signed', '--hmac-secret-env', 'SIGN_SECRET',
      '--signing-key-id', 'SIGN_SECRET',
      '--output', './built.json', '--quiet',
    ], sandbox, withSecret);

    await runToolkit([
      'sign', '--bundle', './policy-bundle.json', ...HMAC, '--output', './signed.json', '--quiet',
    ], sandbox, withSecret);

    const built = readBundle(sandbox, 'built.json');
    const signed = readBundle(sandbox, 'signed.json');

    expect(signed.checksum).toBe(built.checksum);
    expect(signed.signature?.value).toBe(built.signature?.value);
  });

  it('writes the signature as the last field', async () => {
    await runToolkit(['sign', ...HMAC, '--quiet'], sandbox, withSecret);

    const keys = Object.keys(JSON.parse(
      readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8'),
    ) as Record<string, unknown>);

    expect(keys[keys.length - 1]).toBe('signature');
  });

  it('recomputes the checksum before signing', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(
      unsignedBundle({ checksum: 'sha256:staleandwrong' }),
    ));

    await runToolkit(['sign', ...HMAC, '--quiet'], sandbox, withSecret);

    const signed = readBundle(sandbox);
    expect(signed.checksum).not.toBe('sha256:staleandwrong');
    expect(signed.checksum).toBe(computeChecksum(signed));
  });

  it('adds a checksum to a bundle that had none', async () => {
    const bundle = unsignedBundle();
    delete bundle.checksum;
    sandbox.writeText('policy-bundle.json', stringifyJson(bundle));

    await runToolkit(['sign', ...HMAC, '--quiet'], sandbox, withSecret);
    expect(readBundle(sandbox).checksum).toBeDefined();
  });

  it('leaves the bundle acceptable to the CLI validator', async () => {
    await runToolkit(['sign', ...HMAC, '--quiet'], sandbox, withSecret);

    const { issues } = validateBundle(readBundle(sandbox));
    expect(issues.errors).toEqual([]);
  });

  it('signs to a new path without touching the input', async () => {
    const before = readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8');

    const result = await runToolkit([
      'sign', ...HMAC, '--output', './dist/signed.json',
    ], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Written:');
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8')).toBe(before);
    expect(readBundle(sandbox, 'dist/signed.json').signature).toBeDefined();
  });

  it('emits machine-readable output', async () => {
    const result = await runToolkit(['sign', ...HMAC, '--format', 'json'], sandbox, withSecret);
    const payload = result.json() as { output: Record<string, unknown> };

    expect(payload.output).toMatchObject({
      inPlace: true,
      schemaVersion: 1,
      env: 'prod',
      bundleVersion: 3,
      signatureAlgorithm: 'HMAC_SHA256',
      signatureKeyId: 'SIGN_SECRET',
    });
    expect(payload.output.etag).toBe(`"${String(payload.output.checksum).slice(7)}"`);
  });

  it('says nothing on success in quiet mode', async () => {
    const result = await runToolkit(['sign', ...HMAC, '--quiet'], sandbox, withSecret);
    expect(result.stdout).toBe('');
    expect(result.code).toBe(ExitCode.Success);
  });

  it('reads the bundle path from the configuration', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({ bundle: { path: 'dist/b.json' } }));
    sandbox.writeText('dist/b.json', stringifyJson(unsignedBundle()));

    const result = await runToolkit(['sign', ...HMAC, '--quiet'], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.Success);
    expect(readBundle(sandbox, 'dist/b.json').signature).toBeDefined();
  });

  it('reads signing settings from the sign section of the configuration', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({
      sign: { signing: { algorithm: 'HMAC_SHA256', hmacSecretEnv: 'SIGN_SECRET' } },
    }));

    const result = await runToolkit(['sign', '--quiet'], sandbox, withSecret);
    expect(result.code).toBe(ExitCode.Success);
    expect(readBundle(sandbox).signature?.keyId).toBe('SIGN_SECRET');
  });
});

describe('govplane sign with ECDSA', () => {
  let sandbox: Sandbox;
  let publicKeyPem: string;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-bundle.json', stringifyJson(unsignedBundle()));

    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    sandbox.writeText(
      'keys/release-key.pem',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('produces a signature the CLI verifies', async () => {
    await runToolkit([
      'sign',
      '--signing-algorithm', 'ECDSA_SHA_256',
      '--ecdsa-private-key', './keys/release-key.pem',
      '--quiet',
    ], sandbox);

    const inspection = inspectSignature({
      bundle: readBundle(sandbox),
      publicKey: publicKeyPem,
    });

    expect(inspection.status).toBe('valid');
  });

  it('names the key after the file when no identifier is given', async () => {
    await runToolkit([
      'sign',
      '--signing-algorithm', 'ECDSA_SHA_256',
      '--ecdsa-private-key', './keys/release-key.pem',
      '--quiet',
    ], sandbox);

    expect(readBundle(sandbox).signature?.keyId).toBe('release-key.pem');
  });

  it('prefers an explicit key identifier', async () => {
    await runToolkit([
      'sign',
      '--signing-algorithm', 'ECDSA_SHA_256',
      '--ecdsa-private-key', './keys/release-key.pem',
      '--signing-key-id', 'release-2026-07',
      '--quiet',
    ], sandbox);

    expect(readBundle(sandbox).signature?.keyId).toBe('release-2026-07');
  });
});

describe('govplane sign refusals', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-bundle.json', stringifyJson(unsignedBundle()));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('refuses a bundle that is already signed', async () => {
    await runToolkit(['sign', ...HMAC, '--quiet'], sandbox, withSecret);
    const signed = readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8');

    const result = await runToolkit(['sign', ...HMAC], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('already contains a signature');
    expect(result.stderr).toContain('There is no override');
    // The existing signature is left exactly as it was.
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8')).toBe(signed);
  });

  it('refuses a bundle with a signature field of any shape', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(unsignedBundle({ signature: null })));

    const result = await runToolkit(['sign', ...HMAC], sandbox, withSecret);
    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('BUNDLE_ALREADY_SIGNED');
  });

  it('reports a missing bundle', async () => {
    const result = await runToolkit([
      'sign', '--bundle', './absent.json', ...HMAC,
    ], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.FileError);
    expect(result.stderr).toContain('Bundle file not found');
    expect(result.stderr).toContain('--bundle');
  });

  it('reports a bundle that is not JSON', async () => {
    sandbox.writeText('policy-bundle.json', '{ broken');

    const result = await runToolkit(['sign', ...HMAC], sandbox, withSecret);
    expect(result.code).toBe(ExitCode.FileError);
    expect(result.stderr).toContain('not valid JSON');
  });

  it('validates before signing and writes nothing on failure', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(unsignedBundle({
      policies: [{ policyKey: 'a', activeVersion: 1, defaults: { effect: 'nope' }, rules: [] }],
    })));
    const before = readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8');

    const result = await runToolkit(['sign', ...HMAC], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('Nothing was signed');
    expect(result.stderr).toContain('INVALID_DEFAULT_EFFECT');
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8')).toBe(before);
  });

  it('refuses to overwrite an existing output', async () => {
    sandbox.writeText('dist/taken.json', '{"do":"not touch"}');

    const result = await runToolkit([
      'sign', ...HMAC, '--output', './dist/taken.json',
    ], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.WriteError);
    expect(result.stderr).toContain('already exists');
    expect(result.stderr).toContain('--force-output');
    expect(readFileSync(join(sandbox.project, 'dist/taken.json'), 'utf8'))
      .toBe('{"do":"not touch"}');
  });

  it('overwrites an existing output when forced', async () => {
    sandbox.writeText('dist/taken.json', '{"old":true}');

    const result = await runToolkit([
      'sign', ...HMAC, '--output', './dist/taken.json', '--force-output', '--quiet',
    ], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.Success);
    expect(readBundle(sandbox, 'dist/taken.json').signature).toBeDefined();
  });

  it('requires an algorithm', async () => {
    const result = await runToolkit([
      'sign', '--hmac-secret-env', 'SIGN_SECRET',
    ], sandbox, withSecret);

    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('No signing algorithm was specified');
  });

  it('requires a key identifier when the secret is passed inline', async () => {
    const result = await runToolkit([
      'sign', '--signing-algorithm', 'HMAC_SHA256', '--hmac-secret', HEX_SECRET,
    ], sandbox);

    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('key identifier is required');
  });

  it('accepts an inline secret when a key identifier is given', async () => {
    const result = await runToolkit([
      'sign', '--signing-algorithm', 'HMAC_SHA256',
      '--hmac-secret', HEX_SECRET, '--signing-key-id', 'release-key', '--quiet',
    ], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(readBundle(sandbox).signature?.keyId).toBe('release-key');
  });

  it('fails when the secret is unusable, without writing', async () => {
    const before = readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8');

    const result = await runToolkit(['sign', ...HMAC], sandbox, { env: { SIGN_SECRET: 'short' } });

    expect(result.code).toBe(ExitCode.InternalError);
    expect(result.stderr).toContain('key source SIGN_SECRET');
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8')).toBe(before);
  });

  it('never prints the secret', async () => {
    const result = await runToolkit(['sign', ...HMAC, '--verbose'], sandbox, withSecret);

    expect(result.stdout).not.toContain(HEX_SECRET);
    expect(result.stderr).not.toContain(HEX_SECRET);
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8'))
      .not.toContain(HEX_SECRET);
  });
});

describe('govplane sign activation gating', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.writeText('policy-bundle.json', stringifyJson(unsignedBundle()));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('signs during the grace period', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['sign', ...HMAC], sandbox, {
      ...withSecret,
      now: daysAfterNow(3),
    });

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Activation required in 27 days');
  });

  it('signs nothing once the grace period has ended', async () => {
    sandbox.setFirstUse(NOW);
    const before = readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8');

    const result = await runToolkit(['sign', ...HMAC], sandbox, {
      ...withSecret,
      now: daysAfterNow(31),
    });

    expect(result.code).toBe(ExitCode.ToolkitUnavailable);
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8')).toBe(before);
    expect(existsSync(join(sandbox.project, 'dist'))).toBe(false);
  });
});
