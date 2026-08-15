import { existsSync, readFileSync } from 'node:fs';
import { fixedClock } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  anchorFirstUse, GRACE_DAYS, isContinuousIntegration, resolveActivation, statePath,
} from '../../src/activation/grace.js';
import {
  createSandbox, daysAfterNow, NOW, type Sandbox,
} from '../helpers/harness.js';

describe('anchorFirstUse', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('records the first use', () => {
    const anchor = anchorFirstUse(fixedClock(NOW), sandbox.env);

    expect(anchor.toISOString()).toBe(NOW);
    expect(existsSync(statePath(sandbox.env))).toBe(true);
    expect(readFileSync(statePath(sandbox.env), 'utf8')).toContain(NOW);
  });

  it('never moves the anchor once it exists', () => {
    anchorFirstUse(fixedClock(NOW), sandbox.env);
    const later = anchorFirstUse(fixedClock(daysAfterNow(10)), sandbox.env);

    expect(later.toISOString()).toBe(NOW);
  });

  it('ignores a corrupted state file rather than failing', () => {
    sandbox.writeText('../home/state.json', '{ broken');
    const anchor = anchorFirstUse(fixedClock(daysAfterNow(3)), sandbox.env);

    expect(anchor.toISOString()).toBe(daysAfterNow(3));
  });

  it('ignores a state file with an unusable timestamp', () => {
    sandbox.writeText('../home/state.json', '{"toolkitFirstUsedAt":"not-a-date"}');
    const anchor = anchorFirstUse(fixedClock(daysAfterNow(4)), sandbox.env);

    expect(anchor.toISOString()).toBe(daysAfterNow(4));
  });
});

describe('resolveActivation', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('reports an activated machine', () => {
    sandbox.installLicense();
    const status = resolveActivation({ now: fixedClock(NOW), env: sandbox.env });

    expect(status.state).toBe('activated');
    expect(status.license?.subject?.email).toBe('dev@example.com');
    expect(status.renewalDue).toBe(false);
  });

  it('starts the grace period on first use', () => {
    const status = resolveActivation({ now: fixedClock(NOW), env: sandbox.env });

    expect(status.state).toBe('grace');
    expect(status.daysRemaining).toBe(GRACE_DAYS);
    expect(status.license).toBeNull();
  });

  it.each([
    [0, GRACE_DAYS],
    [1, 29],
    [23, 7],
    [24, 6],
    [29, 1],
    [30, 0],
    [45, 0],
  ])('reports the days remaining after %i days', (elapsed, remaining) => {
    sandbox.setFirstUse(NOW);
    const status = resolveActivation({
      now: fixedClock(daysAfterNow(elapsed)),
      env: sandbox.env,
    });

    expect(status.daysRemaining).toBe(remaining);
    expect(status.state).toBe(remaining > 0 ? 'grace' : 'grace_expired');
  });

  it('does not shorten the grace period when the clock moves backwards', () => {
    sandbox.setFirstUse(daysAfterNow(5));
    const status = resolveActivation({ now: fixedClock(NOW), env: sandbox.env });

    expect(status.daysElapsed).toBe(0);
    expect(status.state).toBe('grace');
  });

  it('reports an unusable licence alongside the grace state', () => {
    const license = sandbox.installLicense();
    sandbox.writeText(
      '../home/license.json',
      JSON.stringify({ ...license, marketingConsent: true }),
    );

    const status = resolveActivation({ now: fixedClock(NOW), env: sandbox.env });
    expect(status.state).toBe('grace');
    expect(status.problem).toBe('LICENSE_SIGNATURE_INVALID');
    expect(status.problemReason).toBeDefined();
  });

  it('does not report a missing licence as a problem', () => {
    const status = resolveActivation({ now: fixedClock(NOW), env: sandbox.env });
    expect(status.problem).toBeUndefined();
  });

  it('flags a licence that is due for renewal', () => {
    sandbox.installLicense({ renewAfter: daysAfterNow(-1) });
    const status = resolveActivation({ now: fixedClock(NOW), env: sandbox.env });

    expect(status.state).toBe('activated');
    expect(status.renewalDue).toBe(true);
  });

  it('does not flag renewal before it is due', () => {
    sandbox.installLicense({ renewAfter: daysAfterNow(365) });
    expect(resolveActivation({ now: fixedClock(NOW), env: sandbox.env }).renewalDue).toBe(false);
  });

  it('does not create the anchor when only reporting status', () => {
    resolveActivation({ now: fixedClock(NOW), env: sandbox.env, readOnly: true });
    expect(existsSync(statePath(sandbox.env))).toBe(false);
  });
});

describe('isContinuousIntegration', () => {
  it.each([
    [{ CI: 'true' }, true],
    [{ CI: '1' }, true],
    [{ CI: 'yes' }, true],
    [{ CI: 'false' }, false],
    [{ CI: '0' }, false],
    [{ CI: '' }, false],
    [{}, false],
  ])('reads %j as %s', (env, expected) => {
    expect(isContinuousIntegration(env)).toBe(expected);
  });
});
