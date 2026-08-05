import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { canonicalPayload, computeChecksum, ExitCode, stringifyJson } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  createSandbox, daysAfterNow, NOW, runToolkit, type Sandbox,
} from '../helpers/harness.js';

const HEX_SECRET = 'a'.repeat(64);

const BUNDLE = {
  schemaVersion: 1,
  orgId: 'org_1',
  projectId: 'proj_1',
  env: 'prod',
  generatedAt: NOW,
  bundleVersion: 1,
  policies: [{
    policyKey: 'login-protection',
    activeVersion: 1,
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
};

const TARGET = ['--service', 'auth', '--resource', 'login', '--action', 'authenticate'];

const SUITE = {
  schemaVersion: '1.0',
  name: 'Authentication Policy Suite',
  scenarios: [
    {
      name: 'Allow a first attempt',
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      context: { failedAttempts: 0 },
      expected: { decision: 'allow' },
    },
    {
      name: 'Block repeated attempts',
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      context: { failedAttempts: 6 },
      expected: { decision: 'deny', policyKey: 'login-protection', ruleId: 'deny-after-five' },
    },
  ],
};

describe('govplane simulate', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('evaluates a target and context', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}',
    ], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('decision: deny');
    expect(result.stdout).toContain('reason: rule');
    expect(result.stdout).toContain('Rule: deny-after-five');
  });

  it('reports a decision that came from a policy default', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":1}',
    ], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('decision: allow');
    expect(result.stdout).toContain('No rule matched this target');
    expect(result.stdout).toContain('default effect of "login-protection"');
  });

  it('a deny is a result, not a failure', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":9}',
    ], sandbox);

    expect(result.code).toBe(ExitCode.Success);
  });

  it('accepts a target as JSON', async () => {
    const result = await runToolkit([
      'simulate',
      '--target', '{"service":"auth","resource":"login","action":"authenticate"}',
      '--context-value', 'failedAttempts=6',
    ], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('decision: deny');
  });

  it('reads context from a file', async () => {
    sandbox.writeText('ctx.json', stringifyJson({ failedAttempts: 6 }));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context-file', './ctx.json',
    ], sandbox);

    expect(result.stdout).toContain('decision: deny');
  });

  it('builds context from repeated values', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context-value', 'failedAttempts=6',
    ], sandbox);

    expect(result.stdout).toContain('failedAttempts: 6');
    expect(result.stdout).toContain('decision: deny');
  });

  it('notes context keys no rule reads', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAtempts":6}',
    ], sandbox);

    // A typo produces a decision that looks inexplicable rather than wrong.
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('no rule reads failedAtempts');
    expect(result.stdout).toContain('This bundle reads: failedAttempts');
  });

  it('explains the evaluation with --trace', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--trace', 'full',
    ], sandbox);

    expect(result.stdout).toContain('Evaluation trace:');
    expect(result.stdout).toContain('Rules considered:');
    expect(result.stdout).toContain('login-protection / deny-after-five');
    expect(result.stdout).toContain('Selected:');
  });

  it('treats a bare --trace as a request to explain', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--trace',
    ], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Evaluation trace:');
  });

  it('emits machine-readable output', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--format', 'json',
    ], sandbox);

    const payload = result.json() as {
      input: { documentType: string };
      scenarios: { result: Record<string, unknown>; expectation: { defined: boolean } }[];
      summary: { total: number; failed: number };
    };

    expect(payload.input.documentType).toBe('bundle');
    expect(payload.scenarios[0]?.result).toMatchObject({ decision: 'deny', reason: 'rule' });
    expect(payload.scenarios[0]?.expectation.defined).toBe(false);
    expect(payload.summary).toMatchObject({ total: 1, failed: 0 });
  });

  it('says nothing on success in quiet mode', async () => {
    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--quiet',
    ], sandbox);

    expect(result.stdout).toBe('');
    expect(result.code).toBe(ExitCode.Success);
  });
});

describe('govplane simulate against drafts', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('simulates a complete draft', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      env: 'prod',
      policies: BUNDLE.policies,
    }));

    const result = await runToolkit([
      'simulate', '--draft', './policy-drafts.json', ...TARGET,
      '--context', '{"failedAttempts":6}', '--format', 'json',
    ], sandbox);

    const payload = result.json() as { input: { documentType: string } };
    expect(payload.input.documentType).toBe('draft');
    expect(result.code).toBe(ExitCode.Success);
  });

  it('refuses a draft that cannot be evaluated', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      policies: [{ policyKey: 'api-gateway-request', rules: [] }],
    }));

    const result = await runToolkit(
      ['simulate', '--draft', './policy-drafts.json', ...TARGET],
      sandbox,
    );

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('cannot be simulated');
    expect(result.stderr).toContain('defaults');
  });

  it('prefers a bundle when both exist', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      policies: BUNDLE.policies,
    }));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--format', 'json',
    ], sandbox);

    expect((result.json() as { input: { documentType: string } }).input.documentType)
      .toBe('bundle');
  });

  it('refuses to take a bundle and a draft at once', async () => {
    const result = await runToolkit([
      'simulate', '--bundle', './b.json', '--draft', './d.json', ...TARGET,
    ], sandbox);

    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('cannot be used together');
  });
});

describe('govplane simulate suites', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));
    sandbox.writeText('simulations/auth.json', stringifyJson(SUITE));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('runs every scenario and reports a summary', async () => {
    const result = await runToolkit(['simulate', '--suite', './simulations/auth.json'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Allow a first attempt');
    expect(result.stdout).toContain('Block repeated attempts');
    expect(result.stdout).toContain('Scenarios: 2');
    expect(result.stdout).toContain('Passed: 2');
    expect(result.stdout).toContain('Failed: 0');
  });

  it('fails the run when an expectation is not met', async () => {
    sandbox.writeText('simulations/wrong.json', stringifyJson({
      schemaVersion: '1.0',
      name: 'Wrong expectations',
      scenarios: [{
        name: 'Expects allow when denied',
        target: { service: 'auth', resource: 'login', action: 'authenticate' },
        context: { failedAttempts: 9 },
        expected: { decision: 'allow' },
      }],
    }));

    const result = await runToolkit(['simulate', '--suite', './simulations/wrong.json'], sandbox);

    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('Scenario failed: Expects allow when denied');
    expect(result.stderr).toContain('Expected decision: allow');
    expect(result.stderr).toContain('Actual   decision: deny');
  });

  it('reports failures even in quiet mode', async () => {
    sandbox.writeText('simulations/wrong.json', stringifyJson({
      schemaVersion: '1.0',
      scenarios: [{
        name: 'Wrong',
        target: { service: 'auth', resource: 'login', action: 'authenticate' },
        context: { failedAttempts: 9 },
        expected: { decision: 'allow' },
      }],
    }));

    const result = await runToolkit([
      'simulate', '--suite', './simulations/wrong.json', '--quiet',
    ], sandbox);

    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Scenario failed');
  });

  it('runs a single scenario file', async () => {
    sandbox.writeText('simulations/one.json', stringifyJson({
      schemaVersion: '1.0',
      name: 'Block repeated attempts',
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      context: { failedAttempts: 6 },
      expected: { decision: 'deny' },
    }));

    const result = await runToolkit([
      'simulate', '--scenario', './simulations/one.json', '--format', 'json',
    ], sandbox);

    const payload = result.json() as { summary: { total: number; asserted: number } };
    expect(payload.summary).toMatchObject({ total: 1, asserted: 1 });
    expect(result.code).toBe(ExitCode.Success);
  });

  it('reports a scenario file that is missing or malformed', async () => {
    const missing = await runToolkit(['simulate', '--scenario', './absent.json'], sandbox);
    expect(missing.code).toBe(ExitCode.FileError);

    sandbox.writeText('simulations/broken.json', '{ broken');
    const broken = await runToolkit(
      ['simulate', '--scenario', './simulations/broken.json'],
      sandbox,
    );
    expect(broken.code).toBe(ExitCode.Compatibility);
  });

  it('writes a report', async () => {
    const result = await runToolkit([
      'simulate', '--suite', './simulations/auth.json', '--report', '--format', 'json',
    ], sandbox);

    const payload = result.json() as { reportPath: string };
    expect(existsSync(payload.reportPath)).toBe(true);

    const report = JSON.parse(readFileSync(payload.reportPath, 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({
      runtimeEngine: '@govplane/runtime-sdk',
      summary: { total: 2, passed: 2, failed: 0 },
    });
  });

  it('redacts configured fields from output and reports', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({
      simulate: { redactContextFields: ['email'] },
    }));
    sandbox.writeText('simulations/pii.json', stringifyJson({
      schemaVersion: '1.0',
      name: 'Carries an email',
      target: { service: 'auth', resource: 'login', action: 'authenticate' },
      context: { failedAttempts: 6, email: 'someone@example.com' },
    }));

    const result = await runToolkit([
      'simulate', '--scenario', './simulations/pii.json', '--report-ignored', '--quiet',
    ], sandbox);

    // The unknown option is rejected; run it properly instead.
    expect(result.code).toBe(ExitCode.InvalidArguments);

    const proper = await runToolkit([
      'simulate', '--scenario', './simulations/pii.json', '--report',
    ], sandbox);

    expect(proper.stdout).not.toContain('someone@example.com');
    expect(proper.stdout).toContain('[REDACTED]');
  });
});

describe('govplane simulate signature handling', () => {
  let sandbox: Sandbox;

  const signed = (): Record<string, unknown> => {
    const withChecksum = { ...BUNDLE, checksum: computeChecksum(BUNDLE) };
    const value = createHmac('sha256', Buffer.from(HEX_SECRET, 'hex'))
      .update(canonicalPayload(withChecksum))
      .digest('hex');
    return {
      ...withChecksum,
      signature: { algorithm: 'HMAC_SHA256', keyId: 'SIGN_SECRET', value },
    };
  };

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('govplane.config.json', stringifyJson({
      sign: { signing: { algorithm: 'HMAC_SHA256', hmacSecretEnv: 'SIGN_SECRET' } },
    }));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('skips verification when nothing is pinned', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({}));
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--format', 'json',
    ], sandbox);

    expect((result.json() as { signature: { status: string } }).signature.status).toBe('skipped');
    expect(result.code).toBe(ExitCode.Success);
  });

  it('does not ask a draft for a signature it cannot have', async () => {
    // A draft is compiled in memory and is never signed. Applying the pinned
    // key to it would fail every draft simulation in a signing project.
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      env: 'prod',
      policies: BUNDLE.policies,
    }));

    const result = await runToolkit([
      'simulate', '--draft', './policy-drafts.json', ...TARGET,
      '--context', '{"failedAttempts":6}', '--format', 'json',
    ], sandbox, { env: { SIGN_SECRET: HEX_SECRET } });

    expect(result.code).toBe(ExitCode.Success);
    expect((result.json() as { signature: { status: string } }).signature.status)
      .toBe('skipped');
  });

  it('verifies against a key pinned under build, not only under sign', async () => {
    // A project that builds signed and never runs `sign` still has key material
    // pinned. Reading only `sign.signing` would skip verification silently.
    sandbox.writeText('govplane.config.json', stringifyJson({
      build: { signing: { algorithm: 'HMAC_SHA256', hmacSecretEnv: 'SIGN_SECRET' } },
    }));
    sandbox.writeText('policy-bundle.json', stringifyJson(signed()));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--format', 'json',
    ], sandbox, { env: { SIGN_SECRET: HEX_SECRET } });

    expect((result.json() as { signature: { status: string } }).signature.status).toBe('valid');
    expect(result.code).toBe(ExitCode.Success);
  });

  it('verifies a signature against the pinned secret', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(signed()));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}', '--format', 'json',
    ], sandbox, { env: { SIGN_SECRET: HEX_SECRET } });

    expect((result.json() as { signature: { status: string } }).signature.status).toBe('valid');
    expect(result.code).toBe(ExitCode.Success);
  });

  it('refuses to simulate a bundle whose signature does not match', async () => {
    // Signed with one secret, verified against another: the bundle is otherwise
    // valid, so the signature is the only thing wrong with it.
    sandbox.writeText('policy-bundle.json', stringifyJson(signed()));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}',
    ], sandbox, { env: { SIGN_SECRET: 'b'.repeat(64) } });

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('signature is not valid');
    expect(result.stderr).toContain('--skip-signature-verification');
  });

  it('fails when a signature is pinned but the bundle has none', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}',
    ], sandbox, { env: { SIGN_SECRET: HEX_SECRET } });

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('carries no signature');
  });

  it('warns loudly when verification is skipped on request', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(signed()));

    const result = await runToolkit([
      'simulate', ...TARGET, '--context', '{"failedAttempts":6}',
      '--skip-signature-verification',
    ], sandbox, { env: { SIGN_SECRET: 'b'.repeat(64) } });

    // The signature would not verify, but the user accepted that explicitly.
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stderr).toContain('signature verification was skipped');
    expect(result.stderr).toContain('must not be considered trusted');
  });
});

describe('govplane simulate refusals and gating', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('explains what to do when nothing was asked for', async () => {
    const result = await runToolkit(['simulate'], sandbox);

    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('Nothing to simulate');
    expect(result.stderr).toContain('--service');
    expect(result.stderr).toContain('--suite');
  });

  it('reports an incomplete target', async () => {
    const result = await runToolkit(['simulate', '--service', 'auth'], sandbox);

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('resource, action');
  });

  it('refuses --target alongside the individual flags', async () => {
    const result = await runToolkit(['simulate', '--target', '{}', '--service', 'auth'], sandbox);

    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('cannot be combined');
  });

  it('refuses to simulate an invalid bundle', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson({
      ...BUNDLE,
      policies: [{ policyKey: 'a', activeVersion: 1, defaults: { effect: 'nope' }, rules: [] }],
    }));

    const result = await runToolkit(['simulate', ...TARGET], sandbox);

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('Nothing was simulated');
  });

  it('reports when there is no document to simulate', async () => {
    const empty = createSandbox();
    empty.installLicense();
    try {
      const result = await runToolkit(['simulate', ...TARGET], empty);
      expect(result.code).toBe(ExitCode.FileError);
      expect(result.stderr).toContain('No bundle or draft was found');
    } finally {
      empty.cleanup();
    }
  });

  it('simulates during the grace period', async () => {
    const ungated = createSandbox();
    ungated.writeText('policy-bundle.json', stringifyJson(BUNDLE));
    ungated.setFirstUse(NOW);
    try {
      const result = await runToolkit([
        'simulate', ...TARGET, '--context', '{"failedAttempts":6}',
      ], ungated, { now: daysAfterNow(3) });

      expect(result.code).toBe(ExitCode.Success);
      expect(result.stdout).toContain('Activation required in 27 days');
    } finally {
      ungated.cleanup();
    }
  });

  it('stops once the grace period has ended', async () => {
    const expired = createSandbox();
    expired.writeText('policy-bundle.json', stringifyJson(BUNDLE));
    expired.setFirstUse(NOW);
    try {
      const result = await runToolkit(['simulate', ...TARGET], expired, {
        now: daysAfterNow(31),
      });
      expect(result.code).toBe(ExitCode.ToolkitUnavailable);
    } finally {
      expired.cleanup();
    }
  });
});
