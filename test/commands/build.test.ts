import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const DRAFT = {
  schemaVersion: '1.0',
  env: 'prod',
  policies: [
    {
      policyKey: 'login-protection',
      activeVersion: 1,
      defaults: { effect: 'allow' },
      rules: [{
        id: 'deny-after-five-failures',
        status: 'active',
        priority: 100,
        target: { service: 'auth', resource: 'login', action: 'authenticate' },
        when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
        effect: { type: 'deny' },
      }],
    },
  ],
};

const readBundle = (sandbox: Sandbox, name = 'policy-bundle.json'): RuntimeBundle => (
  JSON.parse(readFileSync(join(sandbox.project, name), 'utf8')) as RuntimeBundle
);

describe('govplane build', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-drafts.json', stringifyJson(DRAFT));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('compiles a draft into a runtime bundle', async () => {
    const result = await runToolkit(['build'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Build completed successfully');

    const bundle = readBundle(sandbox);
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      env: 'prod',
      bundleVersion: 1,
    });
    expect(bundle.policies).toHaveLength(1);
  });

  it('produces a bundle the CLI validator accepts', async () => {
    await runToolkit(['build', '--org-id', 'org_1', '--project-id', 'proj_1', '--quiet'], sandbox);

    const { issues } = validateBundle(readBundle(sandbox));
    expect(issues.errors).toEqual([]);
  });

  it('embeds a checksum that matches the canonical payload', async () => {
    await runToolkit(['build', '--quiet'], sandbox);

    const bundle = readBundle(sandbox);
    expect(bundle.checksum).toBe(computeChecksum(bundle));
  });

  it('writes an explicit status on every rule', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      ...DRAFT,
      policies: [{
        ...DRAFT.policies[0],
        rules: [{ ...DRAFT.policies[0]?.rules[0], status: undefined }],
      }],
    }));

    await runToolkit(['build', '--quiet'], sandbox);
    expect(readBundle(sandbox).policies[0]?.rules[0]?.status).toBe('active');
  });

  it('is reproducible: unchanged policies keep the same checksum', async () => {
    await runToolkit(['build', '--quiet'], sandbox);
    const first = readBundle(sandbox).checksum;

    await runToolkit(['build', '--quiet'], sandbox, { now: daysAfterNow(5) });
    const rebuilt = readdirSync(sandbox.project)
      .filter((name) => name.startsWith('policy-bundle.') && name !== 'policy-bundle.json');

    expect(rebuilt).toHaveLength(1);
    expect(readBundle(sandbox, rebuilt[0] as string).checksum).toBe(first);
  });

  it('never overwrites an existing bundle', async () => {
    await runToolkit(['build', '--quiet'], sandbox);
    const original = readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8');

    const result = await runToolkit(['build', '--format', 'json'], sandbox, {
      now: daysAfterNow(1),
    });
    const payload = result.json() as { output: { bundlePath: string; requestedPath: string } };

    expect(payload.output.bundlePath).not.toBe(payload.output.requestedPath);
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8')).toBe(original);
  });

  it('increments the revision counter on every build', async () => {
    // The control plane numbers each materialisation `currentVersion + 1`;
    // local builds have to climb the same way, not stall at 2.
    const versions: number[] = [];

    for (let build = 0; build < 4; build += 1) {
      const result = await runToolkit(['build', '--format', 'json'], sandbox, {
        now: daysAfterNow(build),
      });
      versions.push((result.json() as { output: { bundleVersion: number } }).output.bundleVersion);
    }

    expect(versions).toEqual([1, 2, 3, 4]);
  });

  it('keeps the first bundle at version 1 while later revisions climb', async () => {
    await runToolkit(['build', '--quiet'], sandbox);
    expect(readBundle(sandbox).bundleVersion).toBe(1);

    const second = await runToolkit(['build', '--format', 'json'], sandbox, {
      now: daysAfterNow(1),
    });
    const payload = second.json() as { output: { bundlePath: string; bundleVersion: number } };

    expect(payload.output.bundleVersion).toBe(2);
    // The original file is untouched, so it still reads as version 1.
    expect(readBundle(sandbox).bundleVersion).toBe(1);
    expect(JSON.parse(readFileSync(payload.output.bundlePath, 'utf8')).bundleVersion).toBe(2);
  });

  it('counts each environment separately', async () => {
    const versionFor = async (env: string, day: number): Promise<number> => {
      const result = await runToolkit(['build', '--env', env, '--format', 'json'], sandbox, {
        now: daysAfterNow(day),
      });
      return (result.json() as { output: { bundleVersion: number } }).output.bundleVersion;
    };

    expect(await versionFor('prod', 0)).toBe(1);
    expect(await versionFor('prod', 1)).toBe(2);
    // A different environment is a different bundle, so it starts its own run.
    expect(await versionFor('staging', 2)).toBe(1);
    expect(await versionFor('staging', 3)).toBe(2);
    expect(await versionFor('prod', 4)).toBe(3);
  });

  it('does not change the checksum when only the version moves', async () => {
    const first = await runToolkit(['build', '--format', 'json'], sandbox);
    const second = await runToolkit(['build', '--format', 'json'], sandbox, {
      now: daysAfterNow(1),
    });

    const read = (result: typeof first) => result.json() as {
      output: { checksum: string; bundleVersion: number };
    };

    expect(read(second).output.bundleVersion).toBe(read(first).output.bundleVersion + 1);
    expect(read(second).output.checksum).toBe(read(first).output.checksum);
  });

  it('takes the environment from the flag, the draft, then prod', async () => {
    const explicit = await runToolkit(['build', '--env', 'staging', '--format', 'json'], sandbox);
    expect((explicit.json() as { output: { env: string } }).output.env).toBe('staging');

    sandbox.writeText('policy-drafts.json', stringifyJson({ ...DRAFT, env: undefined }));
    const fallback = await runToolkit(['build', '--format', 'json'], sandbox, {
      now: daysAfterNow(1),
    });
    expect((fallback.json() as { output: { env: string } }).output.env).toBe('prod');
  });

  it('records the scope when it is supplied', async () => {
    await runToolkit([
      'build', '--org-id', 'org_1', '--project-id', 'proj_1', '--quiet',
    ], sandbox);

    expect(readBundle(sandbox)).toMatchObject({ orgId: 'org_1', projectId: 'proj_1' });
  });

  it('warns, but does not fail, when the scope is absent', async () => {
    const result = await runToolkit(['build'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('MISSING_SCOPE_FIELDS');
    expect(result.stdout).toContain('Isolated Mode');
  });

  it('reports warnings as data in JSON output', async () => {
    const result = await runToolkit(['build', '--format', 'json'], sandbox);
    const payload = result.json() as { warnings: { code: string }[] };

    expect(payload.warnings.map((warning) => warning.code)).toContain('MISSING_SCOPE_FIELDS');
  });

  it('treats warnings as requiring attention in strict mode', async () => {
    const result = await runToolkit(['build', '--strict'], sandbox);

    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('Strict mode');
    // The bundle is still written: the build succeeded, the warnings are advisory.
    expect(existsSync(join(sandbox.project, 'policy-bundle.json'))).toBe(true);
  });

  it('says nothing on success in quiet mode', async () => {
    const result = await runToolkit(['build', '--quiet'], sandbox);
    expect(result.stdout).toBe('');
    expect(result.code).toBe(ExitCode.Success);
  });

  it('writes where --output points', async () => {
    await runToolkit(['build', '--output', './dist/bundle.json', '--quiet'], sandbox);
    expect(existsSync(join(sandbox.project, 'dist/bundle.json'))).toBe(true);
  });

  it('uses the configured output directory', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({
      bundle: { path: 'policy-bundle.json' },
      build: { outputDirectory: 'dist' },
    }));

    await runToolkit(['build', '--quiet'], sandbox);
    expect(existsSync(join(sandbox.project, 'dist/policy-bundle.json'))).toBe(true);
  });

  it('builds from an analyze draft once it has been completed', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      drafts: [{
        id: 'api-gateway-request',
        target: { service: 'api-gateway', resource: '*', action: 'request' },
        suggestedPolicy: {
          policyKey: 'api-gateway-request',
          defaults: { effect: 'allow' },
          rules: [{
            id: 'deny-admin',
            priority: 10,
            target: { service: 'api-gateway', resource: '*', action: 'request' },
            effect: { type: 'deny' },
          }],
        },
      }],
    }));

    const result = await runToolkit(['build', '--quiet'], sandbox);
    expect(result.code).toBe(ExitCode.Success);
    expect(readBundle(sandbox).policies[0]?.policyKey).toBe('api-gateway-request');
  });
});

describe('govplane build failures', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('reports a missing draft', async () => {
    const result = await runToolkit(['build'], sandbox);

    expect(result.code).toBe(ExitCode.FileError);
    expect(result.stderr).toContain('Draft file not found');
  });

  it('stops before compiling an incomplete draft', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      policies: [{ policyKey: 'a', rules: [{ id: 'r' }] }],
    }));

    const result = await runToolkit(['build'], sandbox);

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('Draft validation failed');
    expect(result.stderr).toContain('policies[0].defaults');
    expect(existsSync(join(sandbox.project, 'policy-bundle.json'))).toBe(false);
  });

  it('refuses to build an empty draft', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({ schemaVersion: '1.0', policies: [] }));

    const result = await runToolkit(['build'], sandbox);
    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('contains no policies');
  });

  it('reports a malformed draft', async () => {
    sandbox.writeText('policy-drafts.json', '{ broken');

    const result = await runToolkit(['build'], sandbox);
    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('not valid JSON');
  });
});

describe('govplane build --signed', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-drafts.json', stringifyJson(DRAFT));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('embeds an HMAC signature', async () => {
    const result = await runToolkit([
      'build', '--signed', '--hmac-secret-env', 'BUILD_SECRET', '--format', 'json',
    ], sandbox, { env: { BUILD_SECRET: HEX_SECRET } });

    const payload = result.json() as { output: { signed: boolean; signatureAlgorithm: string } };
    expect(payload.output.signed).toBe(true);
    expect(payload.output.signatureAlgorithm).toBe('HMAC_SHA256');

    expect(readBundle(sandbox).signature).toMatchObject({
      algorithm: 'HMAC_SHA256',
      keyId: 'local-key-01',
    });
  });

  it('produces an ECDSA signature the CLI verifies', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    sandbox.writeText(
      'keys/signing-private.pem',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );

    await runToolkit([
      'build', '--signed',
      '--signing-algorithm', 'ECDSA_SHA_256',
      '--ecdsa-private-key', './keys/signing-private.pem',
      '--signing-key-id', 'local-ec-01',
      '--quiet',
    ], sandbox);

    const inspection = inspectSignature({
      bundle: readBundle(sandbox),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });

    expect(inspection.status).toBe('valid');
    expect(inspection.keyId).toBe('local-ec-01');
  });

  it('does not claim the bundle is unsigned once it has been signed', async () => {
    const result = await runToolkit([
      'build', '--signed', '--hmac-secret-env', 'BUILD_SECRET', '--format', 'json',
    ], sandbox, { env: { BUILD_SECRET: HEX_SECRET } });

    const payload = result.json() as { warnings: { code: string }[] };
    expect(payload.warnings.map((warning) => warning.code)).not.toContain('UNSIGNED_BUNDLE');
  });

  it('never prints the secret', async () => {
    const result = await runToolkit([
      'build', '--signed', '--hmac-secret-env', 'BUILD_SECRET', '--verbose',
    ], sandbox, { env: { BUILD_SECRET: HEX_SECRET } });

    expect(result.stdout).not.toContain(HEX_SECRET);
    expect(result.stderr).not.toContain(HEX_SECRET);
    expect(readFileSync(join(sandbox.project, 'policy-bundle.json'), 'utf8'))
      .not.toContain(HEX_SECRET);
  });

  it('fails the build when signing cannot proceed', async () => {
    const result = await runToolkit([
      'build', '--signed', '--hmac-secret-env', 'ABSENT_SECRET',
    ], sandbox);

    expect(result.code).toBe(ExitCode.InternalError);
    expect(result.stderr).toContain('key source ABSENT_SECRET');
    expect(existsSync(join(sandbox.project, 'policy-bundle.json'))).toBe(false);
  });

  it('signs when the configuration asks for it', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({
      build: { signed: true, signing: { algorithm: 'HMAC_SHA256', hmacSecretEnv: 'BUILD_SECRET' } },
    }));

    const result = await runToolkit(['build', '--format', 'json'], sandbox, {
      env: { BUILD_SECRET: HEX_SECRET },
    });

    expect((result.json() as { output: { signed: boolean } }).output.signed).toBe(true);
  });
});

describe('govplane build --report', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-drafts.json', stringifyJson(DRAFT));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('writes a report to the default location', async () => {
    const result = await runToolkit(['build', '--report', '--format', 'json'], sandbox);
    const payload = result.json() as { reportPath: string };

    expect(payload.reportPath).toContain(join('.govplane', 'reports'));
    expect(existsSync(payload.reportPath)).toBe(true);

    const report = JSON.parse(readFileSync(payload.reportPath, 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({
      builtAt: NOW,
      validation: { errors: 0 },
      signing: { signed: false },
      stats: { policies: 1, rules: 1 },
    });
  });

  it('writes a report where --report-path points', async () => {
    await runToolkit(['build', '--report-path', './reports/build.json', '--quiet'], sandbox);
    expect(existsSync(join(sandbox.project, 'reports/build.json'))).toBe(true);
  });

  it('records the signing status without the key material', async () => {
    await runToolkit([
      'build', '--signed', '--hmac-secret-env', 'BUILD_SECRET',
      '--report-path', './r.json', '--quiet',
    ], sandbox, { env: { BUILD_SECRET: HEX_SECRET } });

    const report = readFileSync(join(sandbox.project, 'r.json'), 'utf8');
    expect(report).toContain('HMAC_SHA256');
    expect(report).not.toContain(HEX_SECRET);
  });
});

describe('govplane build activation gating', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.writeText('policy-drafts.json', stringifyJson(DRAFT));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('builds during the grace period', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['build'], sandbox, { now: daysAfterNow(3) });

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Activation required in 27 days');
  });

  it('writes nothing once the grace period has ended', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['build'], sandbox, { now: daysAfterNow(31) });

    expect(result.code).toBe(ExitCode.ToolkitUnavailable);
    expect(existsSync(join(sandbox.project, 'policy-bundle.json'))).toBe(false);
  });
});
