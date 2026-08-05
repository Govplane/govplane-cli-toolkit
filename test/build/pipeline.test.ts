import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { canonicalPayload, computeChecksum, isCliError } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  bundleStats, compileBundle, DEFAULT_ENV,
} from '../../src/build/compile.js';
import {
  readBuildConfig, resolveBundleVersion, resolveOutputPath, resolveWritePath,
} from '../../src/build/output.js';
import { checkBuildReadiness } from '../../src/build/readiness.js';
import { resolveSigning, signBundle } from '../../src/build/signing.js';
import type { DraftDocument } from '../../src/drafts/types.js';
import { createSandbox, NOW, type Sandbox } from '../helpers/harness.js';

const HEX_SECRET = 'a'.repeat(64);

const draft = (policies: unknown[] = []): DraftDocument => ({
  schemaVersion: '1.0',
  policies: policies as DraftDocument['policies'],
});

const policy = (policyKey: string, rules: unknown[] = []): unknown => ({
  policyKey,
  activeVersion: 1,
  defaults: { effect: 'allow' },
  rules,
});

const rule = (id: string, priority: number, extra: Record<string, unknown> = {}): unknown => ({
  id,
  priority,
  target: { service: 'auth', resource: 'login', action: 'authenticate' },
  effect: { type: 'deny' },
  ...extra,
});

describe('compileBundle', () => {
  const compile = (input: Partial<Parameters<typeof compileBundle>[0]> = {}) => compileBundle({
    draft: draft([policy('a')]),
    generatedAt: NOW,
    bundleVersion: 1,
    ...input,
  });

  it('produces a schema-1 bundle', () => {
    expect(compile()).toMatchObject({ schemaVersion: 1, env: DEFAULT_ENV, bundleVersion: 1 });
  });

  it('defaults the environment to prod, then to the draft, then to the flag', () => {
    expect(compile().env).toBe('prod');
    expect(compile({ draft: { ...draft([policy('a')]), env: 'dev' } }).env).toBe('dev');
    expect(compile({ draft: { ...draft([policy('a')]), env: 'dev' }, env: 'staging' }).env)
      .toBe('staging');
  });

  it('omits scope entirely when it is not supplied', () => {
    const bundle = compile();
    expect('orgId' in bundle).toBe(false);
    expect('projectId' in bundle).toBe(false);
  });

  it('includes scope when it is supplied', () => {
    expect(compile({ orgId: 'org_1', projectId: 'proj_1' }))
      .toMatchObject({ orgId: 'org_1', projectId: 'proj_1' });
  });

  it('always writes an explicit rule status', () => {
    // The runtime engine evaluates a rule only when status === "active", so a
    // compiled rule without one would silently never fire.
    const bundle = compile({ draft: draft([policy('a', [rule('r1', 10)])]) });
    expect(bundle.policies[0]?.rules[0]?.status).toBe('active');
  });

  it('preserves a disabled status', () => {
    const bundle = compile({
      draft: draft([policy('a', [rule('r1', 10, { status: 'disabled' })])]),
    });
    expect(bundle.policies[0]?.rules[0]?.status).toBe('disabled');
  });

  it('orders policies by key and rules by priority then id', () => {
    const bundle = compile({
      draft: draft([
        policy('zeta', [rule('b', 10), rule('a', 10), rule('c', 90)]),
        policy('alpha'),
      ]),
    });

    expect(bundle.policies.map((entry) => entry.policyKey)).toEqual(['alpha', 'zeta']);
    expect(bundle.policies[1]?.rules.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('drops authoring metadata the runtime never reads', () => {
    const bundle = compile({
      draft: draft([{
        ...(policy('a') as Record<string, unknown>),
        friendlyName: 'A',
        description: 'notes',
        discoveredTarget: { service: 's', resource: 'r', action: 'a' },
      }]),
    });

    const compiled = bundle.policies[0] as unknown as Record<string, unknown>;
    expect(Object.keys(compiled)).toEqual(['policyKey', 'activeVersion', 'defaults', 'rules']);
  });

  it('is deterministic: the same draft always yields the same checksum', () => {
    const first = compile({ bundleVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z' });
    const second = compile({ bundleVersion: 9, generatedAt: '2030-06-06T12:00:00.000Z' });

    // bundleVersion and generatedAt are outside the canonical projection, so a
    // rebuild of unchanged policies keeps the same checksum.
    expect(computeChecksum(first)).toBe(computeChecksum(second));
  });

  it('changes the checksum when a policy changes', () => {
    const before = compile({ draft: draft([policy('a')]) });
    const after = compile({ draft: draft([policy('a', [rule('r1', 1)])]) });

    expect(computeChecksum(before)).not.toBe(computeChecksum(after));
  });

  it('counts policies and rules', () => {
    const bundle = compile({
      draft: draft([policy('a', [rule('r1', 1), rule('r2', 2)]), policy('b')]),
    });
    expect(bundleStats(bundle)).toEqual({ policies: 2, rules: 2 });
  });
});

describe('checkBuildReadiness', () => {
  const codes = (document: DraftDocument): string[] => (
    checkBuildReadiness(document).map((issue) => issue.code)
  );

  it('accepts a complete draft', () => {
    expect(checkBuildReadiness(draft([policy('a', [rule('r1', 10)])]))).toEqual([]);
  });

  it('requires the fields the runtime needs', () => {
    const found = codes(draft([{ policyKey: 'a', rules: [{ id: 'r' }] }]));

    expect(found).toEqual(expect.arrayContaining([
      'INVALID_ACTIVE_VERSION',
      'INVALID_DEFAULT_EFFECT',
      'INVALID_RULE_PRIORITY',
      'INVALID_RULE_TARGET',
      'INVALID_RULE_EFFECT',
    ]));
  });

  it('requires the payload each default effect needs', () => {
    const build = (defaults: unknown) => codes(draft([
      { policyKey: 'a', activeVersion: 1, defaults, rules: [] },
    ]));

    expect(build({ effect: 'kill_switch' })).toContain('MISSING_KILL_SWITCH_SERVICE');
    expect(build({ effect: 'throttle', throttle: { limit: 1 } }))
      .toContain('INVALID_THROTTLE_DEFAULT');
    expect(build({ effect: 'custom' })).toContain('INVALID_CUSTOM_DEFAULT');
    expect(build({ effect: 'nope' })).toContain('INVALID_DEFAULT_EFFECT');
  });

  it('accepts a rule with no status, which compiles to active', () => {
    expect(codes(draft([policy('a', [rule('r1', 1)])]))).toEqual([]);
  });

  it('rejects a status the runtime would silently skip', () => {
    expect(codes(draft([policy('a', [rule('r1', 1, { status: 'paused' })])])))
      .toContain('INVALID_RULE_STATUS');
  });

  it('reports duplicates', () => {
    expect(codes(draft([policy('a'), policy('a')]))).toContain('DUPLICATE_POLICY_KEY');
    expect(codes(draft([policy('a', [rule('r', 1), rule('r', 2)])])))
      .toContain('DUPLICATE_RULE_ID');
  });

  it('requires a custom rule effect to carry its value', () => {
    expect(codes(draft([policy('a', [rule('r', 1, { effect: { type: 'custom' } })])])))
      .toContain('INVALID_RULE_EFFECT');
  });

  it('collects every problem rather than stopping at the first', () => {
    expect(checkBuildReadiness(draft([{ policyKey: '' }, { policyKey: '' }])).length)
      .toBeGreaterThan(2);
  });
});

describe('output resolution', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('prefers an explicit output path', () => {
    expect(resolveOutputPath('/project', {}, {}, './dist/bundle.json'))
      .toBe('/project/dist/bundle.json');
  });

  it('falls back to the configured bundle path', () => {
    expect(resolveOutputPath('/project', { bundle: { path: 'out/b.json' } }, {}))
      .toBe('/project/out/b.json');
  });

  it('places the bundle in the configured output directory', () => {
    const resolved = resolveOutputPath(
      '/project',
      { bundle: { path: 'policy-bundle.json' } },
      { outputDirectory: 'dist' },
    );
    expect(resolved).toBe('/project/dist/policy-bundle.json');
  });

  it('falls back to the default filename', () => {
    expect(resolveOutputPath('/project', {}, {})).toBe('/project/policy-bundle.json');
  });

  it('writes straight to the requested path when nothing is there', () => {
    const path = join(sandbox.project, 'policy-bundle.json');
    expect(resolveWritePath(path, new Date(NOW)))
      .toEqual({ requestedPath: path, path, timestamped: false });
  });

  it('never overwrites an existing bundle', () => {
    const path = sandbox.writeText('policy-bundle.json', '{}');
    const resolved = resolveWritePath(path, new Date(NOW));

    expect(resolved.timestamped).toBe(true);
    expect(resolved.requestedPath).toBe(path);
    expect(resolved.path).toContain('policy-bundle.2026-07-29T12-00-00-000Z.json');
  });

  const PROD = { orgId: 'org_1', projectId: 'proj_1', env: 'prod' };

  const writeBundleFile = (name: string, body: Record<string, unknown>): string => (
    sandbox.writeText(name, JSON.stringify({ ...PROD, ...body }))
  );

  it('starts the revision counter at 1', () => {
    expect(resolveBundleVersion(join(sandbox.project, 'absent.json'), PROD)).toBe(1);
  });

  it('continues the revision counter from an existing bundle', () => {
    const path = writeBundleFile('policy-bundle.json', { bundleVersion: 6 });
    expect(resolveBundleVersion(path, PROD)).toBe(7);
  });

  it('continues from the newest timestamped sibling, not the requested path', () => {
    // Build never overwrites, so after the first build the requested path holds
    // v1 forever and the newest revision is a timestamped file. Reading only the
    // requested path would hand out version 2 on every subsequent build.
    const path = writeBundleFile('policy-bundle.json', { bundleVersion: 1 });
    writeBundleFile('policy-bundle.2026-07-30T10-00-00-000Z.json', { bundleVersion: 2 });
    writeBundleFile('policy-bundle.2026-07-30T11-00-00-000Z.json', { bundleVersion: 3 });

    expect(resolveBundleVersion(path, PROD)).toBe(4);
  });

  it('takes the highest version, whatever order the files are in', () => {
    const path = writeBundleFile('policy-bundle.json', { bundleVersion: 9 });
    writeBundleFile('policy-bundle.2026-07-30T10-00-00-000Z.json', { bundleVersion: 4 });

    expect(resolveBundleVersion(path, PROD)).toBe(10);
  });

  it('keeps a separate counter per scope, as the control plane does', () => {
    const path = writeBundleFile('policy-bundle.json', { bundleVersion: 5 });
    writeBundleFile('policy-bundle.2026-07-30T10-00-00-000Z.json', { bundleVersion: 6 });

    // A different environment is a different bundle, so its counter starts over.
    expect(resolveBundleVersion(path, { ...PROD, env: 'staging' })).toBe(1);
    expect(resolveBundleVersion(path, { ...PROD, orgId: 'org_2' })).toBe(1);
    expect(resolveBundleVersion(path, { ...PROD, projectId: 'proj_2' })).toBe(1);
    expect(resolveBundleVersion(path, PROD)).toBe(7);
  });

  it('counts unscoped local-first bundles as their own sequence', () => {
    const local = { env: 'prod' };
    const path = sandbox.writeText(
      'policy-bundle.json',
      JSON.stringify({ env: 'prod', bundleVersion: 3 }),
    );

    expect(resolveBundleVersion(path, local)).toBe(4);
    expect(resolveBundleVersion(path, PROD)).toBe(1);
  });

  it('ignores neighbours it cannot use', () => {
    const path = writeBundleFile('policy-bundle.json', { bundleVersion: 2 });
    sandbox.writeText('policy-bundle.2026-07-30T10-00-00-000Z.json', '{ broken');
    sandbox.writeText('policy-bundle.2026-07-30T11-00-00-000Z.json', '{}');
    writeBundleFile('policy-bundle.2026-07-30T12-00-00-000Z.json', { bundleVersion: 'seven' });

    expect(resolveBundleVersion(path, PROD)).toBe(3);
  });

  it('does not count unrelated bundles in the same directory', () => {
    const path = writeBundleFile('policy-bundle.json', { bundleVersion: 1 });
    writeBundleFile('other-bundle.json', { bundleVersion: 99 });

    expect(resolveBundleVersion(path, PROD)).toBe(2);
  });

  it('starts at 1 when nothing usable exists', () => {
    expect(resolveBundleVersion(sandbox.writeText('a.json', '{ broken'), PROD)).toBe(1);
    expect(resolveBundleVersion(sandbox.writeText('b.json', '{}'), PROD)).toBe(1);
  });

  it('reads the build block from the project configuration', () => {
    const path = sandbox.writeText('govplane.config.json', JSON.stringify({
      build: {
        env: 'staging',
        outputDirectory: 'dist',
        signed: true,
        validateParity: false,
        scope: { orgId: 'org_1', projectId: null },
        signing: { algorithm: 'HMAC_SHA256', hmacSecretEnv: 'SECRET' },
      },
    }));

    expect(readBuildConfig(path)).toMatchObject({
      env: 'staging',
      outputDirectory: 'dist',
      signed: true,
      validateParity: false,
      scope: { orgId: 'org_1' },
      signing: { algorithm: 'HMAC_SHA256', hmacSecretEnv: 'SECRET' },
    });
  });

  it('tolerates a configuration with no build block', () => {
    expect(readBuildConfig(null)).toEqual({});
    expect(readBuildConfig(sandbox.writeText('a.json', '{}'))).toEqual({});
    expect(readBuildConfig(sandbox.writeText('b.json', '{ broken'))).toEqual({});
  });
});

describe('signing', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const bundle = () => compileBundle({
    draft: draft([policy('a', [rule('r1', 10)])]),
    generatedAt: NOW,
    bundleVersion: 1,
  });

  it('signs the same bytes the checksum covers', () => {
    const compiled = bundle();
    const signature = signBundle(compiled, {
      algorithm: 'HMAC_SHA256',
      keyId: 'k',
      keySource: 'TEST',
      hmacSecret: HEX_SECRET,
    });

    const expected = createHmac('sha256', Buffer.from(HEX_SECRET, 'hex'))
      .update(canonicalPayload(compiled))
      .digest('hex');

    expect(signature.value).toBe(expected);
    expect(signature).toMatchObject({ algorithm: 'HMAC_SHA256', keyId: 'k' });
  });

  it('produces an ECDSA signature the standard verifier accepts', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keyPath = sandbox.writeText(
      'signing-private.pem',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );

    const compiled = bundle();
    const signature = signBundle(compiled, {
      algorithm: 'ECDSA_SHA_256',
      keyId: 'ec',
      keySource: keyPath,
      ecdsaPrivateKeyPath: keyPath,
    });

    const verifier = createVerify('sha256');
    verifier.update(canonicalPayload(compiled));
    verifier.end();

    expect(verifier.verify(publicKey, Buffer.from(signature.value, 'base64'))).toBe(true);
  });

  it('rejects a secret of the wrong length without echoing it', () => {
    const secret = 'deadbeef';
    try {
      signBundle(bundle(), {
        algorithm: 'HMAC_SHA256', keyId: 'k', keySource: 'GOVPLANE_HMAC_SECRET', hmacSecret: secret,
      });
      throw new Error('expected a failure');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      if (isCliError(error)) {
        const text = [error.message, ...error.details].join('\n');
        expect(text).toContain('GOVPLANE_HMAC_SECRET');
        expect(text).toContain('invalid hex length');
        expect(text).not.toContain(secret);
      }
    }
  });

  it('distinguishes a non-hex secret from a short one', () => {
    const reasonFor = (secret: string): string => {
      try {
        signBundle(bundle(), {
          algorithm: 'HMAC_SHA256', keyId: 'k', keySource: 'TEST', hmacSecret: secret,
        });
        return '';
      } catch (error) {
        return isCliError(error) ? error.details.join('\n') : '';
      }
    };

    expect(reasonFor('z'.repeat(64))).toContain('is not hexadecimal');
    expect(reasonFor('ab')).toContain('invalid hex length');
  });

  it('reports a private key it cannot use, without quoting it', () => {
    const keyPath = sandbox.writeText('not-a-key.pem', '-----BEGIN PRIVATE KEY-----\nnope\n');

    try {
      signBundle(bundle(), {
        algorithm: 'ECDSA_SHA_256', keyId: 'k', keySource: keyPath, ecdsaPrivateKeyPath: keyPath,
      });
      throw new Error('expected a failure');
    } catch (error) {
      if (isCliError(error)) {
        const text = [error.message, ...error.details].join('\n');
        expect(text).toContain('could not be parsed');
        expect(text).not.toContain('nope');
      }
    }
  });

  it('rejects a key of the wrong type for the algorithm', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = sandbox.writeText(
      'ed25519.pem',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );

    try {
      signBundle(bundle(), {
        algorithm: 'ECDSA_SHA_256', keyId: 'k', keySource: keyPath, ecdsaPrivateKeyPath: keyPath,
      });
      throw new Error('expected a failure');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      if (isCliError(error)) {
        expect(error.details.join('\n')).toContain('needs an EC private key');
      }
    }
  });
});

describe('resolveSigning', () => {
  it('prefers the direct secret flag', () => {
    const resolved = resolveSigning(
      { hmacSecret: HEX_SECRET },
      { hmacSecretEnv: 'FROM_CONFIG' },
      { FROM_CONFIG: 'ignored' },
      '/project',
    );

    expect(resolved).toMatchObject({ keySource: '--hmac-secret', hmacSecret: HEX_SECRET });
  });

  it('reads the secret from the named environment variable', () => {
    const resolved = resolveSigning(
      { hmacSecretEnv: 'FROM_FLAG' },
      {},
      { FROM_FLAG: HEX_SECRET },
      '/project',
    );

    expect(resolved).toMatchObject({ keySource: 'FROM_FLAG', hmacSecret: HEX_SECRET });
  });

  it('falls back to the configured environment variable', () => {
    const resolved = resolveSigning(
      {},
      { hmacSecretEnv: 'FROM_CONFIG' },
      { FROM_CONFIG: HEX_SECRET },
      '/project',
    );

    expect(resolved.keySource).toBe('FROM_CONFIG');
  });

  it('reports an unset environment variable by name', () => {
    expect(() => resolveSigning({ hmacSecretEnv: 'ABSENT' }, {}, {}, '/project'))
      .toThrow('key source ABSENT');
  });

  it('explains how to configure a missing secret', () => {
    expect(() => resolveSigning({}, {}, {}, '/project')).toThrow('no HMAC secret was configured');
  });

  it('resolves the ECDSA key path against the working folder', () => {
    const resolved = resolveSigning(
      { algorithm: 'ECDSA_SHA_256', ecdsaPrivateKey: './keys/k.pem' },
      {},
      {},
      '/project',
    );

    expect(resolved.ecdsaPrivateKeyPath).toBe('/project/keys/k.pem');
  });

  it('explains how to configure a missing ECDSA key', () => {
    expect(() => resolveSigning({ algorithm: 'ECDSA_SHA_256' }, {}, {}, '/project'))
      .toThrow('no ECDSA private key was configured');
  });

  it('rejects an unsupported algorithm', () => {
    expect(() => resolveSigning({ algorithm: 'RSA' }, {}, {}, '/project'))
      .toThrow('Unsupported signing algorithm');
  });

  it('defaults the key id', () => {
    expect(resolveSigning({ hmacSecret: HEX_SECRET }, {}, {}, '/project').keyId)
      .toBe('local-key-01');
  });
});
