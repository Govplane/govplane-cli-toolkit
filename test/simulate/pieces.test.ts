import { describe, expect, it } from '@jest/globals';
import { isCliError, type RuntimeBundle } from '@govplane/cli';
import {
  buildContext, formatContext, parseContextValue, redactContext, referencedContextKeys,
  REDACTED, unusedContextKeys,
} from '../../src/simulate/context.js';
import {
  checkExpectation, readExpectation, readScenario, readSuite, readTarget,
} from '../../src/simulate/scenarios.js';
import { createSimulator } from '../../src/simulate/engine.js';

const bundle = (): RuntimeBundle => ({
  schemaVersion: 1,
  orgId: 'org_1',
  projectId: 'proj_1',
  env: 'prod',
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
});

describe('parseContextValue', () => {
  it.each([
    ['failedAttempts=8', 'failedAttempts', 8],
    ['rate=8.5', 'rate', 8.5],
    ['enabled=true', 'enabled', true],
    ['enabled=false', 'enabled', false],
    ['missing=null', 'missing', null],
    ['country=ES', 'country', 'ES'],
  ])('infers %s', (entry, key, value) => {
    expect(parseContextValue(entry)).toEqual([key, value]);
  });

  it.each([
    ['postcode:string=28001', 'postcode', '28001'],
    ['count:number=3', 'count', 3],
    ['flag:boolean=true', 'flag', true],
    ['nothing:null=whatever', 'nothing', null],
  ])('honours the stated type in %s', (entry, key, value) => {
    expect(parseContextValue(entry)).toEqual([key, value]);
  });

  it('keeps a value containing an equals sign intact', () => {
    expect(parseContextValue('token=a=b=c')).toEqual(['token', 'a=b=c']);
  });

  it('rejects malformed pairs', () => {
    expect(() => parseContextValue('nope')).toThrow('must be key=value');
    expect(() => parseContextValue('=8')).toThrow('needs a key');
    expect(() => parseContextValue('a:number=x')).toThrow('is not a number');
    expect(() => parseContextValue('a:boolean=yes')).toThrow('is not a boolean');
    expect(() => parseContextValue('a:date=today')).toThrow('Unsupported context value type');
  });
});

describe('buildContext', () => {
  it('reads inline JSON', () => {
    expect(buildContext({ inline: '{"a":1}', values: [], cwd: '/tmp' })).toEqual({ a: 1 });
  });

  it('reads repeated values', () => {
    expect(buildContext({ values: ['a=1', 'b=two'], cwd: '/tmp' }))
      .toEqual({ a: 1, b: 'two' });
  });

  it('returns nothing when no context was given', () => {
    expect(buildContext({ values: [], cwd: '/tmp' })).toBeUndefined();
  });

  it('refuses to merge two ways of supplying context', () => {
    expect(() => buildContext({ inline: '{}', values: ['a=1'], cwd: '/tmp' }))
      .toThrow('supplied more than one way');
  });

  it('rejects inline context that is not an object', () => {
    expect(() => buildContext({ inline: '[1,2]', values: [], cwd: '/tmp' }))
      .toThrow('must be a JSON object');
    expect(() => buildContext({ inline: '{ broken', values: [], cwd: '/tmp' }))
      .toThrow('not valid JSON');
  });
});

describe('context keys', () => {
  it('lists the keys a bundle reads', () => {
    expect(referencedContextKeys(bundle())).toEqual(['failedAttempts']);
  });

  it('flags a key no rule reads', () => {
    expect(unusedContextKeys({ failedAtempts: 6 }, ['failedAttempts']))
      .toEqual(['failedAtempts']);
  });

  it('says nothing when every key is read', () => {
    expect(unusedContextKeys({ failedAttempts: 6 }, ['failedAttempts'])).toEqual([]);
  });

  it('says nothing when the bundle reads no context at all', () => {
    expect(unusedContextKeys({ anything: 1 }, [])).toEqual([]);
  });
});

describe('redaction', () => {
  it('masks the configured fields', () => {
    expect(redactContext({ email: 'a@b.c', plan: 'pro' }, ['email']))
      .toEqual({ email: REDACTED, plan: 'pro' });
  });

  it('matches field names case-insensitively', () => {
    expect(redactContext({ Email: 'a@b.c' }, ['email'])).toEqual({ Email: REDACTED });
  });

  it('leaves the context untouched when nothing is configured', () => {
    const context = { email: 'a@b.c' };
    expect(redactContext(context, [])).toBe(context);
  });

  it('never alters the value used for evaluation', () => {
    const context = { email: 'a@b.c' };
    redactContext(context, ['email']);
    expect(context.email).toBe('a@b.c');
  });

  it('formats context for display, redacted', () => {
    expect(formatContext({ email: 'a@b.c', n: 2 }, ['email']))
      .toEqual([`  email: ${REDACTED}`, '  n: 2']);
    expect(formatContext({}, [])).toEqual(['  (none)']);
  });
});

describe('scenarios', () => {
  it('reads a complete target', () => {
    expect(readTarget({ service: 'a', resource: 'b', action: 'c' }, 'x'))
      .toEqual({ service: 'a', resource: 'b', action: 'c' });
  });

  it('names the missing parts of a target', () => {
    try {
      readTarget({ service: 'a' }, 'scenario');
      throw new Error('expected a failure');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      if (isCliError(error)) {
        expect(error.details.join('\n')).toContain('resource, action');
      }
    }
  });

  it('accepts the legacy expectation spellings', () => {
    expect(readExpectation({ effect: 'deny', ruleKey: 'r1' }, 'x'))
      .toEqual({ decision: 'deny', ruleId: 'r1' });
  });

  it('rejects an expectation that asserts nothing', () => {
    expect(() => readExpectation({}, 'x')).toThrow('declares no assertions');
  });

  it('defaults a scenario name and context', () => {
    const scenario = readScenario(
      { target: { service: 'a', resource: 'b', action: 'c' } },
      'file',
      'Scenario 1',
    );
    expect(scenario.name).toBe('Scenario 1');
    expect(scenario.context).toEqual({});
  });

  it('reads a suite', () => {
    const suite = readSuite({
      name: 'Auth',
      scenarios: [{ target: { service: 'a', resource: 'b', action: 'c' } }],
    }, 'suite.json');

    expect(suite.name).toBe('Auth');
    expect(suite.scenarios).toHaveLength(1);
  });

  it('rejects an empty or malformed suite', () => {
    expect(() => readSuite({ scenarios: [] }, 'x')).toThrow('contains no scenarios');
    expect(() => readSuite({}, 'x')).toThrow('"scenarios" array');
  });
});

describe('checkExpectation', () => {
  const decision = {
    decision: 'deny', reason: 'rule', policyKey: 'p', ruleId: 'r',
  };

  it('passes when nothing is expected', () => {
    expect(checkExpectation(undefined, decision).passed).toBe(true);
  });

  it('checks only the fields that were declared', () => {
    expect(checkExpectation({ decision: 'deny' }, decision).passed).toBe(true);
  });

  it('reports each mismatch', () => {
    const result = checkExpectation({ decision: 'allow', ruleId: 'other' }, decision);

    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([
      { field: 'decision', expected: 'allow', actual: 'deny' },
      { field: 'ruleId', expected: 'other', actual: 'r' },
    ]);
  });

  it('reports an expected field the decision does not carry', () => {
    const result = checkExpectation({ ruleId: 'r' }, { decision: 'allow', reason: 'default' });
    expect(result.mismatches[0]?.actual).toBe('(not set)');
  });
});

describe('the simulator uses the runtime engine', () => {
  const target = { service: 'auth', resource: 'login', action: 'authenticate' };

  it('returns the engine decision for a matching rule', () => {
    const simulator = createSimulator(bundle());
    const { decision } = simulator.evaluate(target, { failedAttempts: 6 }, 'off');

    expect(decision).toMatchObject({
      decision: 'deny',
      reason: 'rule',
      policyKey: 'login-protection',
      ruleId: 'deny-after-five',
    });
  });

  it('falls back to the policy default when no rule matches', () => {
    const simulator = createSimulator(bundle());
    const { decision } = simulator.evaluate(target, { failedAttempts: 1 }, 'off');

    expect(decision).toMatchObject({ decision: 'allow', reason: 'default' });
  });

  it('does not apply a policy default to a target that policy has no rule for', () => {
    // A policy's default speaks only for the targets it governs, which are the
    // targets its rules name. `login-protection` has nothing to say about a
    // health check, so its allow default does not stand in and the target falls
    // to deny-by-default. Simulation reports that faithfully — surfacing what
    // the runtime will actually decide is the point of the command.
    const simulator = createSimulator(bundle());
    const { decision } = simulator.evaluate(
      { service: 'api', resource: '/health', action: 'request' },
      {},
      'off',
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'default' });
    expect(decision.policyKey).toBeUndefined();
  });

  it('denies by default when no policy offers one', () => {
    const withoutDefaults = bundle();
    delete (withoutDefaults.policies[0] as { defaults?: unknown }).defaults;

    const simulator = createSimulator(withoutDefaults);
    const { decision } = simulator.evaluate(
      { service: 'api', resource: '/health', action: 'request' },
      {},
      'off',
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'default' });
  });

  it('produces a trace that names the winning rule', () => {
    const simulator = createSimulator(bundle());
    const { trace } = simulator.evaluate(target, { failedAttempts: 6 }, 'full');

    expect(trace).toBeDefined();
    expect(trace?.winner).toMatchObject({ ruleId: 'deny-after-five', priority: 100 });
    expect(Array.isArray(trace?.rules)).toBe(true);
  });

  it('produces no trace when tracing is off', () => {
    const simulator = createSimulator(bundle());
    expect(simulator.evaluate(target, {}, 'off').trace).toBeUndefined();
  });

  it('accepts context the bundle reads, without a pinned policy', () => {
    // The runtime's default context policy is a sample allow-list; enforcing it
    // would reject `failedAttempts`, which this bundle's own rule reads.
    const simulator = createSimulator(bundle());
    expect(() => simulator.evaluate(target, { failedAttempts: 6 }, 'off')).not.toThrow();
  });

  it('enforces a pinned context policy', () => {
    const simulator = createSimulator(bundle(), {
      validateContext: true,
      contextPolicy: { allowedKeys: ['plan'], blockLikelyPiiKeys: false },
    });

    expect(() => simulator.evaluate(target, { failedAttempts: 6 }, 'off'))
      .toThrow('could not evaluate');
  });
});
