import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode, stringifyJson } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import type { DraftDocument } from '../../src/drafts/types.js';
import {
  createSandbox, daysAfterNow, NOW, runToolkit, type Sandbox,
} from '../helpers/harness.js';

const RULE = {
  id: 'deny-after-five-failures',
  status: 'active',
  priority: 100,
  target: { service: 'auth', resource: 'login', action: 'authenticate' },
  when: { op: 'gte', path: 'ctx.failedAttempts', value: 5 },
  effect: { type: 'deny' },
};

const readDraft = (sandbox: Sandbox, name = 'policy-drafts.json'): DraftDocument => (
  JSON.parse(readFileSync(join(sandbox.project, name), 'utf8')) as DraftDocument
);

describe('govplane policies', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const seed = async (): Promise<void> => {
    await runToolkit(['policies', 'create-file', '--env', 'prod', '--quiet'], sandbox);
  };

  describe('create-file', () => {
    it('creates a valid empty draft', async () => {
      const result = await runToolkit(['policies', 'create-file', '--env', 'prod'], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox)).toMatchObject({
        schemaVersion: '1.0',
        env: 'prod',
        policies: [],
      });
    });

    it('refuses to overwrite an existing draft', async () => {
      await seed();
      const result = await runToolkit(['policies', 'create-file'], sandbox);

      expect(result.code).toBe(ExitCode.Conflict);
      expect(result.stderr).toContain('already exists');
      expect(result.stderr).toContain('--force');
    });

    it('replaces an existing draft when forced', async () => {
      await seed();
      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'allow', '--quiet',
      ], sandbox);

      const result = await runToolkit(['policies', 'create-file', '--force', '--quiet'], sandbox);
      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies).toEqual([]);
    });

    it('writes to a path given with --draft', async () => {
      const result = await runToolkit([
        'policies', 'create-file', '--draft', './governance/drafts.json', '--quiet',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(existsSync(join(sandbox.project, 'governance/drafts.json'))).toBe(true);
    });
  });

  describe('add-policy', () => {
    beforeEach(seed);

    it('adds a policy', async () => {
      const result = await runToolkit([
        'policies', 'add-policy',
        '--policy-key', 'login-protection',
        '--defaults-effect', 'allow',
        '--friendly-name', 'Login Protection',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(result.stdout).toContain('Policy added: login-protection');
      expect(readDraft(sandbox).policies[0]).toMatchObject({
        policyKey: 'login-protection',
        activeVersion: 1,
        friendlyName: 'Login Protection',
        defaults: { effect: 'allow' },
        rules: [],
      });
    });

    it('rejects a duplicate key', async () => {
      const argv = ['policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'allow'];
      await runToolkit([...argv, '--quiet'], sandbox);

      const result = await runToolkit(argv, sandbox);
      expect(result.code).toBe(ExitCode.Conflict);
      expect(result.stderr).toContain('already exists');
    });

    it('requires the payload an effect needs', async () => {
      const killSwitch = await runToolkit([
        'policies', 'add-policy', '--policy-key', 'k', '--defaults-effect', 'kill_switch',
      ], sandbox);
      expect(killSwitch.code).toBe(ExitCode.Compatibility);
      expect(killSwitch.stderr).toContain('--kill-switch-service is required');

      const custom = await runToolkit([
        'policies', 'add-policy', '--policy-key', 'c', '--defaults-effect', 'custom',
      ], sandbox);
      expect(custom.stderr).toContain('--custom-effect is required');
    });

    it('builds a throttle default from its parts', async () => {
      const result = await runToolkit([
        'policies', 'add-policy',
        '--policy-key', 'api-throttle',
        '--defaults-effect', 'throttle',
        '--throttle-limit', '60',
        '--throttle-window-seconds', '60',
        '--throttle-key', 'ip',
        '--quiet',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies[0]?.defaults).toEqual({
        effect: 'throttle',
        throttle: { limit: 60, windowSeconds: 60, key: 'ip' },
      });
    });

    it('builds a kill_switch default with its reason', async () => {
      await runToolkit([
        'policies', 'add-policy',
        '--policy-key', 'payments-kill',
        '--defaults-effect', 'kill_switch',
        '--kill-switch-service', 'payments',
        '--kill-switch-reason', 'incident response',
        '--quiet',
      ], sandbox);

      expect(readDraft(sandbox).policies[0]?.defaults).toEqual({
        effect: 'kill_switch',
        killSwitch: { service: 'payments', reason: 'incident response' },
      });
    });

    it('accepts a whole policy as JSON', async () => {
      const result = await runToolkit([
        'policies', 'add-policy',
        '--policy-json', JSON.stringify({
          policyKey: 'from-json',
          activeVersion: 3,
          defaults: { effect: 'deny' },
        }),
        '--quiet',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies[0]).toMatchObject({
        policyKey: 'from-json',
        activeVersion: 3,
      });
    });

    it('requires the options it cannot infer', async () => {
      const noKey = await runToolkit([
        'policies', 'add-policy', '--defaults-effect', 'allow',
      ], sandbox);
      expect(noKey.code).toBe(ExitCode.InvalidArguments);
      expect(noKey.stderr).toContain('--policy-key is required');

      const noEffect = await runToolkit(['policies', 'add-policy', '--policy-key', 'a'], sandbox);
      expect(noEffect.code).toBe(ExitCode.InvalidArguments);
      expect(noEffect.stderr).toContain('--defaults-effect is required');
    });

    it('rejects an unsupported effect at parse time', async () => {
      const result = await runToolkit([
        'policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'quarantine',
      ], sandbox);

      expect(result.code).toBe(ExitCode.InvalidArguments);
      expect(result.stderr).toContain('Invalid value for --defaults-effect');
    });
  });

  describe('completing an analyze draft', () => {
    // `analyze` writes policies with no `defaults` on purpose — it never invents
    // an effect. Completing that draft one policy at a time must be possible:
    // validating the whole document on every edit would block the first repair
    // because the second policy is still incomplete, and the draft could never
    // be finished with the tool meant to finish it.
    beforeEach(() => {
      sandbox.writeText('policy-drafts.json', stringifyJson({
        schemaVersion: '1.0',
        drafts: [
          {
            id: 'api-gateway-request',
            target: { service: 'api-gateway', resource: '*', action: 'request' },
            suggestedPolicy: { policyKey: 'api-gateway-request', rules: [] },
          },
          {
            id: 'payments-refund-execute',
            target: { service: 'payments', resource: 'refund', action: 'execute' },
            suggestedPolicy: { policyKey: 'payments-refund-execute', rules: [] },
          },
        ],
      }));
    });

    it('supplies the missing effect one policy at a time', async () => {
      const first = await runToolkit([
        'policies', 'update-policy', '--policy-key', 'api-gateway-request',
        '--defaults-effect', 'allow', '--quiet',
      ], sandbox);
      expect(first.code).toBe(ExitCode.Success);

      const second = await runToolkit([
        'policies', 'update-policy', '--policy-key', 'payments-refund-execute',
        '--defaults-effect', 'deny', '--quiet',
      ], sandbox);
      expect(second.code).toBe(ExitCode.Success);

      const done = await runToolkit(['policies', 'validate'], sandbox);
      expect(done.code).toBe(ExitCode.Success);
    });

    it('still refuses an edit that introduces a new problem', async () => {
      const result = await runToolkit([
        'policies', 'add-rule', '--policy-key', 'api-gateway-request',
        '--rule-json', stringifyJson({
          id: 'bad-condition',
          priority: 10,
          target: { service: 'api-gateway', resource: '*', action: 'request' },
          when: { op: 'approximately', path: 'ctx.n', value: 1 },
          effect: { type: 'deny' },
        }),
      ], sandbox);

      expect(result.code).toBe(ExitCode.Compatibility);
      expect(result.stderr).toContain('would not be valid');
      // Only the problem this edit introduced is reported, not the pre-existing
      // missing defaults.
      expect(result.stderr).not.toContain('payments-refund-execute');
    });
  });

  describe('update-policy', () => {
    beforeEach(async () => {
      await seed();
      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'login-protection',
        '--defaults-effect', 'allow', '--quiet',
      ], sandbox);
    });

    it('changes the default effect', async () => {
      const result = await runToolkit([
        'policies', 'update-policy', '--policy-key', 'login-protection',
        '--defaults-effect', 'deny',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies[0]?.defaults).toEqual({ effect: 'deny' });
    });

    it('changes the active version', async () => {
      await runToolkit([
        'policies', 'update-policy', '--policy-key', 'login-protection',
        '--active-version', '4', '--quiet',
      ], sandbox);

      expect(readDraft(sandbox).policies[0]?.activeVersion).toBe(4);
    });

    it('keeps the rules a policy already has', async () => {
      await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE), '--quiet',
      ], sandbox);

      await runToolkit([
        'policies', 'update-policy', '--policy-key', 'login-protection',
        '--defaults-effect', 'deny', '--quiet',
      ], sandbox);

      expect(readDraft(sandbox).policies[0]?.rules).toHaveLength(1);
    });

    it('reports a policy that does not exist', async () => {
      const result = await runToolkit([
        'policies', 'update-policy', '--policy-key', 'missing', '--defaults-effect', 'deny',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stderr).toContain('Policy not found');
    });

    it('asks for something to change', async () => {
      const result = await runToolkit([
        'policies', 'update-policy', '--policy-key', 'login-protection',
      ], sandbox);

      expect(result.code).toBe(ExitCode.InvalidArguments);
      expect(result.stderr).toContain('Nothing to update');
    });

    it('rejects a nonsensical active version', async () => {
      const result = await runToolkit([
        'policies', 'update-policy', '--policy-key', 'login-protection',
        '--active-version', 'latest',
      ], sandbox);

      expect(result.code).toBe(ExitCode.InvalidArguments);
    });
  });

  describe('remove-policy', () => {
    beforeEach(async () => {
      await seed();
      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'login-protection',
        '--defaults-effect', 'allow', '--quiet',
      ], sandbox);
    });

    it('removes a policy that has no rules', async () => {
      const result = await runToolkit([
        'policies', 'remove-policy', '--policy-key', 'login-protection',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies).toEqual([]);
    });

    it('will not silently discard rules', async () => {
      await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE), '--quiet',
      ], sandbox);

      const result = await runToolkit([
        'policies', 'remove-policy', '--policy-key', 'login-protection',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Conflict);
      expect(result.stderr).toContain('still has 1 rule');
      expect(readDraft(sandbox).policies).toHaveLength(1);
    });

    it('removes a policy with rules when forced', async () => {
      await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE), '--quiet',
      ], sandbox);

      const result = await runToolkit([
        'policies', 'remove-policy', '--policy-key', 'login-protection', '--force', '--quiet',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies).toEqual([]);
    });

    it('reports a policy that does not exist', async () => {
      const result = await runToolkit([
        'policies', 'remove-policy', '--policy-key', 'missing',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Failure);
    });
  });

  describe('add-rule and update-rule', () => {
    beforeEach(async () => {
      await seed();
      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'login-protection',
        '--defaults-effect', 'allow', '--quiet',
      ], sandbox);
    });

    it('adds a rule from a file', async () => {
      sandbox.writeText('rules/deny-retries.json', stringifyJson(RULE));

      const result = await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-file', './rules/deny-retries.json',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies[0]?.rules[0]).toMatchObject({ id: RULE.id });
    });

    it('adds a rule from inline JSON', async () => {
      const result = await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE), '--quiet',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies[0]?.rules).toHaveLength(1);
    });

    it('rejects a duplicate rule id', async () => {
      const argv = [
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE),
      ];
      await runToolkit([...argv, '--quiet'], sandbox);

      const result = await runToolkit(argv, sandbox);
      expect(result.code).toBe(ExitCode.Conflict);
      expect(result.stderr).toContain('already exists');
    });

    it('rejects an incomplete rule', async () => {
      const result = await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify({ id: 'r', priority: 1 }),
      ], sandbox);

      expect(result.code).toBe(ExitCode.Compatibility);
      expect(result.stderr).toContain('target.service');
    });

    it('rejects a rule for a policy that does not exist', async () => {
      const result = await runToolkit([
        'policies', 'add-rule', '--policy-key', 'missing',
        '--rule-json', JSON.stringify(RULE),
      ], sandbox);

      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stderr).toContain('Policy not found');
    });

    it('replaces a rule', async () => {
      await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE), '--quiet',
      ], sandbox);

      const result = await runToolkit([
        'policies', 'update-rule', '--policy-key', 'login-protection',
        '--rule-id', RULE.id,
        '--rule-json', JSON.stringify({ ...RULE, priority: 50 }),
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies[0]?.rules[0]?.priority).toBe(50);
    });

    it('will not rename a rule through an update', async () => {
      await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE), '--quiet',
      ], sandbox);

      const result = await runToolkit([
        'policies', 'update-rule', '--policy-key', 'login-protection',
        '--rule-id', RULE.id,
        '--rule-json', JSON.stringify({ ...RULE, id: 'renamed' }),
      ], sandbox);

      expect(result.code).toBe(ExitCode.Compatibility);
      expect(result.stderr).toContain('was being updated');
    });

    it('reports a rule that does not exist', async () => {
      const result = await runToolkit([
        'policies', 'update-rule', '--policy-key', 'login-protection',
        '--rule-id', 'absent', '--rule-json', JSON.stringify({ ...RULE, id: 'absent' }),
      ], sandbox);

      expect(result.code).toBe(ExitCode.Failure);
      expect(result.stderr).toContain('Rule not found');
    });

    it('requires a rule payload', async () => {
      const result = await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
      ], sandbox);

      expect(result.code).toBe(ExitCode.InvalidArguments);
      expect(result.stderr).toContain('--rule-file');
    });

    it('reports malformed inline JSON', async () => {
      const result = await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection', '--rule-json', '{ broken',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Compatibility);
      expect(result.stderr).toContain('not valid JSON');
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await seed();
      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'login-protection',
        '--defaults-effect', 'allow', '--quiet',
      ], sandbox);
      await runToolkit([
        'policies', 'add-rule', '--policy-key', 'login-protection',
        '--rule-json', JSON.stringify(RULE), '--quiet',
      ], sandbox);
    });

    it('shows a table of policies', async () => {
      const result = await runToolkit(['policies', 'list'], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(result.stdout).toContain('KEY');
      expect(result.stdout).toContain('login-protection');
      expect(result.stdout).toContain('allow');
    });

    it('shows the rules with --verbose', async () => {
      const result = await runToolkit(['policies', 'list', '--verbose'], sandbox);
      expect(result.stdout).toContain(RULE.id);
      expect(result.stdout).toContain('auth / login / authenticate');
    });

    it('emits machine-readable output', async () => {
      const result = await runToolkit(['policies', 'list', '--format', 'json'], sandbox);
      const payload = result.json() as { policies: unknown[] };

      expect(payload).toMatchObject({ success: true, shape: 'build-ready', env: 'prod' });
      expect(payload.policies[0]).toEqual({
        policyKey: 'login-protection',
        activeVersion: 1,
        defaultsEffect: 'allow',
        rules: 1,
      });
    });

    it('guides the user when a draft is empty', async () => {
      await runToolkit(['policies', 'create-file', '--force', '--quiet'], sandbox);
      const result = await runToolkit(['policies', 'list'], sandbox);

      expect(result.stdout).toContain('no policies yet');
      expect(result.stdout).toContain('add-policy');
    });

    it('lists an analyze document in build-ready form', async () => {
      sandbox.writeText('policy-drafts.json', stringifyJson({
        schemaVersion: '1.0',
        drafts: [{
          id: 'api-gateway-request',
          target: { service: 'api-gateway', resource: '*', action: 'request' },
          suggestedPolicy: { policyKey: 'api-gateway-request', rules: [] },
        }],
      }));

      const result = await runToolkit(['policies', 'list'], sandbox);
      expect(result.stdout).toContain('analyze document');
      expect(result.stdout).toContain('api-gateway-request');
    });
  });

  describe('validate', () => {
    beforeEach(seed);

    it('accepts a valid draft', async () => {
      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'allow', '--quiet',
      ], sandbox);

      const result = await runToolkit(['policies', 'validate'], sandbox);
      expect(result.code).toBe(ExitCode.Success);
      expect(result.stdout).toContain('Draft file is valid.');
    });

    it('reports errors with their paths and codes', async () => {
      sandbox.writeText('policy-drafts.json', stringifyJson({
        schemaVersion: '1.0',
        policies: [{ policyKey: 'a', defaults: { effect: 'nope' }, rules: [] }],
      }));

      const result = await runToolkit(['policies', 'validate'], sandbox);
      expect(result.code).toBe(ExitCode.Compatibility);
      expect(result.stderr).toContain('policies[0].defaults.effect');
      expect(result.stderr).toContain('INVALID_DEFAULT_EFFECT');
    });

    it('treats warnings as errors in strict mode', async () => {
      sandbox.writeText('policy-drafts.json', stringifyJson({
        schemaVersion: '1.0',
        drafts: [{
          target: { service: 'api', resource: '*', action: 'request' },
          suggestedPolicy: { policyKey: 'x', rules: [] },
        }],
      }));

      const normal = await runToolkit(['policies', 'validate'], sandbox);
      expect(normal.code).toBe(ExitCode.Success);

      const strict = await runToolkit(['policies', 'validate', '--strict'], sandbox);
      expect(strict.code).toBe(ExitCode.Compatibility);
    });

    it('emits machine-readable results', async () => {
      const result = await runToolkit(['policies', 'validate', '--format', 'json'], sandbox);
      expect(result.json()).toMatchObject({ success: true, stats: { policies: 0, rules: 0 } });
    });

    it('does not modify the file', async () => {
      const before = readFileSync(join(sandbox.project, 'policy-drafts.json'), 'utf8');
      await runToolkit(['policies', 'validate', '--quiet'], sandbox);
      expect(readFileSync(join(sandbox.project, 'policy-drafts.json'), 'utf8')).toBe(before);
    });
  });

  describe('draft file selection and versioning', () => {
    it('writes a new version instead of overwriting', async () => {
      await seed();
      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'allow', '--quiet',
      ], sandbox);

      const result = await runToolkit([
        'policies', 'add-policy', '--policy-key', 'b', '--defaults-effect', 'deny',
        '--versioned', '--quiet',
      ], sandbox);

      expect(result.code).toBe(ExitCode.Success);
      expect(readDraft(sandbox).policies).toHaveLength(1);
      expect(readDraft(sandbox, 'policy-drafts.v2.json').policies).toHaveLength(2);
    });

    it('takes versioning from the project configuration', async () => {
      sandbox.writeText('govplane.config.json', stringifyJson({
        policies: { versioning: { enabled: true } },
      }));
      await seed();

      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'allow', '--quiet',
      ], sandbox);

      expect(existsSync(join(sandbox.project, 'policy-drafts.v2.json'))).toBe(true);
    });

    it('lets --no-versioned override the configuration', async () => {
      sandbox.writeText('govplane.config.json', stringifyJson({
        policies: { versioning: { enabled: true } },
      }));
      await seed();

      await runToolkit([
        'policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'allow',
        '--no-versioned', '--quiet',
      ], sandbox);

      expect(existsSync(join(sandbox.project, 'policy-drafts.v2.json'))).toBe(false);
      expect(readDraft(sandbox).policies).toHaveLength(1);
    });

    it('uses the draft path from the project configuration', async () => {
      sandbox.writeText('govplane.config.json', stringifyJson({
        draft: { path: 'governance/drafts.json' },
      }));

      await runToolkit(['policies', 'create-file', '--quiet'], sandbox);
      expect(existsSync(join(sandbox.project, 'governance/drafts.json'))).toBe(true);
    });

    it('reports a missing draft file', async () => {
      const result = await runToolkit(['policies', 'list'], sandbox);

      expect(result.code).toBe(ExitCode.FileError);
      expect(result.stderr).toContain('Draft file not found');
      expect(result.stderr).toContain('create-file');
    });
  });

  describe('command surface', () => {
    it('requires a subcommand', async () => {
      const result = await runToolkit(['policies'], sandbox);

      expect(result.code).toBe(ExitCode.InvalidArguments);
      expect(result.stderr).toContain('A subcommand is required');
      expect(result.stderr).toContain('create-file');
    });

    it('rejects an unknown subcommand', async () => {
      const result = await runToolkit(['policies', 'delete-everything'], sandbox);

      expect(result.code).toBe(ExitCode.InvalidArguments);
      expect(result.stderr).toContain('Unknown policies subcommand');
    });

    it('documents itself', async () => {
      const result = await runToolkit(['help', 'policies'], sandbox);

      expect(result.stdout).toContain('govplane policies <subcommand>');
      expect(result.stdout).toContain('add-policy');
      expect(result.stdout).toContain('--rule-file');
    });

    it('says nothing on success in quiet mode', async () => {
      const result = await runToolkit(['policies', 'create-file', '--quiet'], sandbox);
      expect(result.stdout).toBe('');
    });
  });
});

describe('govplane policies activation gating', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('works during the grace period, with a reminder', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['policies', 'create-file'], sandbox, {
      now: daysAfterNow(3),
    });

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Activation required in 27 days');
    expect(existsSync(join(sandbox.project, 'policy-drafts.json'))).toBe(true);
  });

  it('stops once the grace period has ended', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['policies', 'list'], sandbox, { now: daysAfterNow(31) });

    expect(result.code).toBe(ExitCode.ToolkitUnavailable);
    expect(result.stderr).toContain('The policies command requires activation.');
    expect(result.stderr).toContain('Your policies keep working');
  });

  it('does not touch the draft file once the grace period has ended', async () => {
    sandbox.installLicense();
    await runToolkit(['policies', 'create-file', '--quiet'], sandbox);
    const before = readFileSync(join(sandbox.project, 'policy-drafts.json'), 'utf8');

    sandbox.setFirstUse(NOW);
    await runToolkit(['license', 'remove', '--quiet'], sandbox);

    const result = await runToolkit([
      'policies', 'add-policy', '--policy-key', 'a', '--defaults-effect', 'allow',
    ], sandbox, { now: daysAfterNow(31) });

    expect(result.code).toBe(ExitCode.ToolkitUnavailable);
    expect(readFileSync(join(sandbox.project, 'policy-drafts.json'), 'utf8')).toBe(before);
  });
});
