import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  consolidate, discoveryId, friendlyName, targetIdentity,
} from '../../src/analyze/consolidate.js';
import { classify, loadComparisonBundles, ruleTargets } from '../../src/analyze/compare.js';
import { collectSourceFiles, createExcludeMatcher } from '../../src/analyze/scanner.js';
import {
  knownIdentities, mergeIntoExisting, readExistingDraft, toDraftEntry,
} from '../../src/analyze/draft.js';
import type { CallSite } from '../../src/analyze/detect.js';
import type { ComparedDiscovery } from '../../src/analyze/compare.js';

const call = (overrides: Partial<CallSite> = {}): CallSite => ({
  target: { service: 'auth', resource: 'login', action: 'authenticate' },
  expressions: {},
  availableContext: [],
  confidence: 'high',
  location: { file: 'src/a.ts', line: 1, column: 1 },
  matchedBy: 'binding',
  ...overrides,
});

const compared = (overrides: Partial<ComparedDiscovery> = {}): ComparedDiscovery => ({
  id: 'auth-login-authenticate',
  target: { service: 'auth', resource: 'login', action: 'authenticate' },
  expressions: {},
  availableContext: [],
  confidence: 'high',
  sources: [{ file: 'src/a.ts', line: 1, column: 1 }],
  status: 'missing',
  matchedPolicies: [],
  ...overrides,
});

describe('discoveryId', () => {
  it('drops wildcard components', () => {
    expect(discoveryId({ service: 'api-gateway', resource: '*', action: 'request' }))
      .toBe('api-gateway-request');
  });

  it('slugs punctuation out of a path resource', () => {
    expect(discoveryId({ service: 'api', resource: '/users/:id', action: 'read' }))
      .toBe('api-users-id-read');
  });

  it('splits camelCase', () => {
    expect(discoveryId({ service: 'apiGateway', resource: '*', action: 'request' }))
      .toBe('api-gateway-request');
  });

  it('never returns an empty identifier', () => {
    expect(discoveryId({ service: '*', resource: '*', action: '*' }))
      .toBe('discovered-policy');
  });
});

describe('friendlyName', () => {
  it('title-cases the identifier', () => {
    expect(friendlyName('auth-login-authenticate')).toBe('Auth Login Authenticate');
  });

  it('keeps known acronyms upper-case', () => {
    expect(friendlyName('api-gateway-request')).toBe('API Gateway Request');
  });
});

describe('consolidate', () => {
  it('merges calls that share a target', () => {
    const result = consolidate([
      call({ location: { file: 'src/b.ts', line: 9, column: 3 } }),
      call({ location: { file: 'src/a.ts', line: 2, column: 1 } }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.sources).toEqual([
      { file: 'src/a.ts', line: 2, column: 1 },
      { file: 'src/b.ts', line: 9, column: 3 },
    ]);
  });

  it('keeps different targets apart', () => {
    const result = consolidate([
      call(),
      call({ target: { service: 'payments', resource: 'refund', action: 'execute' } }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('aggregates context keys from every call site', () => {
    const result = consolidate([
      call({ availableContext: [{ key: 'plan' }] }),
      call({ availableContext: [{ key: 'attempts', type: 'number' }, { key: 'plan' }] }),
    ]);

    expect(result[0]?.availableContext).toEqual([
      { key: 'attempts', type: 'number' },
      { key: 'plan' },
    ]);
  });

  it('prefers the reading that resolved more', () => {
    const result = consolidate([call({ confidence: 'low' }), call({ confidence: 'high' })]);
    expect(result[0]?.confidence).toBe('high');
  });

  it('produces the same output whatever order the calls arrive in', () => {
    const a = call({ target: { service: 'z', resource: 'r', action: 'a' } });
    const b = call({ target: { service: 'a', resource: 'r', action: 'a' } });
    expect(JSON.stringify(consolidate([a, b])))
      .toBe(JSON.stringify(consolidate([b, a])));
  });

  it('disambiguates two targets that slug to the same identifier', () => {
    const result = consolidate([
      call({ target: { service: 'api', resource: '/users/:id', action: 'read' } }),
      call({ target: { service: 'api', resource: '/users/{id}', action: 'read' } }),
    ]);

    expect(result.map((entry) => entry.id))
      .toEqual(['api-users-id-read', 'api-users-id-read-2']);
  });
});

describe('classify', () => {
  const targets = ruleTargets([{
    path: 'b.json',
    bundle: {
      schemaVersion: 1,
      orgId: 'o',
      projectId: 'p',
      env: 'prod',
      policies: [
        {
          policyKey: 'login-protection',
          activeVersion: 1,
          rules: [{
            id: 'r1',
            priority: 10,
            target: { service: 'auth', resource: 'login', action: 'authenticate' },
            effect: { type: 'deny' },
          }],
        },
        {
          policyKey: 'api-guard',
          activeVersion: 1,
          rules: [{
            id: 'r2',
            priority: 5,
            target: { service: 'api', resource: '*', action: 'request' },
            effect: { type: 'allow' },
          }],
        },
      ],
    },
  }] as never);

  it('reports an exact match as covered', () => {
    expect(classify({ service: 'auth', resource: 'login', action: 'authenticate' }, targets))
      .toEqual({ status: 'covered', matchedPolicies: ['login-protection'] });
  });

  it('treats a wildcard in the bundle as covering the specific target', () => {
    expect(classify({ service: 'api', resource: '/health', action: 'request' }, targets))
      .toMatchObject({ status: 'covered', matchedPolicies: ['api-guard'] });
  });

  it('reports an unmatched action in a known service as partially covered', () => {
    expect(classify({ service: 'auth', resource: 'login', action: 'logout' }, targets))
      .toMatchObject({ status: 'partially-covered', matchedPolicies: ['login-protection'] });
  });

  it('reports an unknown service as missing', () => {
    expect(classify({ service: 'payments', resource: 'refund', action: 'execute' }, targets))
      .toEqual({ status: 'missing', matchedPolicies: [] });
  });

  it('reports a target two policies both claim as ambiguous', () => {
    const overlapping = ruleTargets([{
      path: 'b.json',
      bundle: {
        schemaVersion: 1,
        orgId: 'o',
        projectId: 'p',
        env: 'prod',
        policies: [
          {
            policyKey: 'first',
            activeVersion: 1,
            rules: [{
              id: 'r1',
              priority: 1,
              target: { service: 'auth', resource: '*', action: 'authenticate' },
              effect: { type: 'deny' },
            }],
          },
          {
            policyKey: 'second',
            activeVersion: 1,
            rules: [{
              id: 'r2',
              priority: 1,
              target: { service: 'auth', resource: 'login', action: '*' },
              effect: { type: 'allow' },
            }],
          },
        ],
      },
    }] as never);

    expect(classify({ service: 'auth', resource: 'login', action: 'authenticate' }, overlapping))
      .toEqual({ status: 'ambiguous', matchedPolicies: ['first', 'second'] });
  });

  it('reports everything as missing when there is nothing to compare against', () => {
    expect(classify({ service: 'auth', resource: 'login', action: 'authenticate' }, []))
      .toEqual({ status: 'missing', matchedPolicies: [] });
  });
});

describe('ruleTargets', () => {
  const bundleWith = (policies: unknown[]) => ([{
    path: 'b.json',
    bundle: {
      schemaVersion: 1, orgId: 'o', projectId: 'p', env: 'prod', policies,
    },
  }] as never);

  it('orders policies and rules the way the remote compiler does', () => {
    // The spec requires matching to use the same deterministic ordering as
    // remote bundle compilation: policies by policyKey ascending, rules by
    // priority descending then id ascending.
    const targets = ruleTargets(bundleWith([
      {
        policyKey: 'zebra',
        rules: [
          {
            id: 'b', priority: 5, target: { service: 's', resource: 'r', action: 'a' }, effect: {},
          },
          {
            id: 'a', priority: 5, target: { service: 's', resource: 'r', action: 'a' }, effect: {},
          },
          {
            id: 'c', priority: 9, target: { service: 's', resource: 'r', action: 'a' }, effect: {},
          },
        ],
      },
      {
        policyKey: 'alpha',
        rules: [{
          id: 'z', priority: 1, target: { service: 's', resource: 'r', action: 'a' }, effect: {},
        }],
      },
    ]));

    expect(targets.map((entry) => `${entry.policyKey}/${entry.ruleId}`))
      .toEqual(['alpha/z', 'zebra/c', 'zebra/a', 'zebra/b']);
  });

  it('treats a missing priority as zero rather than failing', () => {
    const targets = ruleTargets(bundleWith([{
      policyKey: 'p',
      rules: [
        { id: 'no-priority', target: { service: 's', resource: 'r', action: 'a' }, effect: {} },
        {
          id: 'has-priority',
          priority: 3,
          target: { service: 's', resource: 'r', action: 'a' },
          effect: {},
        },
      ],
    }]));

    expect(targets.map((entry) => entry.ruleId)).toEqual(['has-priority', 'no-priority']);
  });

  it('skips rules with no usable target', () => {
    const targets = ruleTargets(bundleWith([{
      policyKey: 'p',
      rules: [
        { id: 'no-target', priority: 1, effect: {} },
        { id: 'partial', priority: 1, target: { service: 's' }, effect: {} },
        {
          id: 'blank',
          priority: 1,
          target: { service: '', resource: 'r', action: 'a' },
          effect: {},
        },
        {
          id: 'good', priority: 1, target: { service: 's', resource: 'r', action: 'a' }, effect: {},
        },
      ],
    }]));

    expect(targets.map((entry) => entry.ruleId)).toEqual(['good']);
  });

  it('tolerates a policy with no rules array', () => {
    expect(ruleTargets(bundleWith([{ policyKey: 'p' }]))).toEqual([]);
  });

  it('records which bundle each rule came from', () => {
    const targets = ruleTargets(bundleWith([{
      policyKey: 'p',
      rules: [{
        id: 'r', priority: 1, target: { service: 's', resource: 'r', action: 'a' }, effect: {},
      }],
    }]));

    expect(targets[0]?.bundlePath).toBe('b.json');
  });
});

describe('createExcludeMatcher', () => {
  it('matches a bare name against any path segment', () => {
    const excluded = createExcludeMatcher(['node_modules']);
    expect(excluded('node_modules/pkg/index.js')).toBe(true);
    expect(excluded('src/node_modules/x.js')).toBe(true);
    expect(excluded('src/app.js')).toBe(false);
  });

  it('matches a glob against the basename', () => {
    const excluded = createExcludeMatcher(['*.test.ts']);
    expect(excluded('src/app.test.ts')).toBe(true);
    expect(excluded('src/app.ts')).toBe(false);
  });

  it('matches a path glob across segments', () => {
    const excluded = createExcludeMatcher(['src/**/fixtures/*']);
    expect(excluded('src/a/b/fixtures/one.ts')).toBe(true);
    expect(excluded('src/a/b/real/one.ts')).toBe(false);
  });
});

describe('collectSourceFiles', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `govplane-scan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'src', 'b.ts'), '');
    writeFileSync(join(root, 'src', 'a.js'), '');
    writeFileSync(join(root, 'src', 'notes.md'), '');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(root, 'dist', 'bundle.js'), '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns source files in a stable order, skipping dependencies and output', () => {
    const { files } = collectSourceFiles(root);
    expect(files.map((file) => file.slice(root.length + 1)))
      .toEqual([join('src', 'a.js'), join('src', 'b.ts')]);
  });

  it('honours extra exclusions', () => {
    const { files } = collectSourceFiles(root, { exclude: ['*.js'] });
    expect(files.map((file) => file.slice(root.length + 1))).toEqual([join('src', 'b.ts')]);
  });

  it('accepts a single file as the root', () => {
    const { files } = collectSourceFiles(join(root, 'src', 'a.js'));
    expect(files).toHaveLength(1);
  });

  it('returns nothing for a path that does not exist', () => {
    expect(collectSourceFiles(join(root, 'missing')).files).toEqual([]);
  });
});

describe('draft documents', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `govplane-draft-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a policy shell with no rules', () => {
    const entry = toDraftEntry(compared());
    expect(entry.suggestedPolicy.rules).toEqual([]);
    expect(entry.suggestedPolicy.policyKey).toBe('auth-login-authenticate');
  });

  it('emits a per-component expression field', () => {
    const entry = toDraftEntry(compared({
      expressions: {
        resource: { dynamic: true, source: 'req.path || "*"', fallback: '*' },
      },
    }));

    expect(entry.resourceExpression)
      .toEqual({ dynamic: true, source: 'req.path || "*"', fallback: '*' });
    expect(entry.serviceExpression).toBeUndefined();
  });

  it('recognises an analyze-shaped file', () => {
    const path = join(root, 'policy-drafts.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', drafts: [] }));
    expect(readExistingDraft(path)).toMatchObject({ shape: 'analyze' });
  });

  it('recognises a build-ready file as carrying authored work', () => {
    const path = join(root, 'policy-drafts.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', policies: [] }));
    expect(readExistingDraft(path)).toMatchObject({
      shape: 'build-ready',
      hasAuthoredContent: true,
    });
  });

  it('returns null when there is no file', () => {
    expect(readExistingDraft(join(root, 'nothing.json'))).toBeNull();
  });

  it('reads known identities from both shapes', () => {
    const analyze = {
      path: 'x',
      shape: 'analyze' as const,
      hasAuthoredContent: false,
      document: {
        drafts: [{ target: { service: 'auth', resource: 'login', action: 'authenticate' } }],
      },
    };
    // Compared through the shared encoder: what matters is that the two agree,
    // not what the separator happens to be.
    expect(knownIdentities(analyze)).toEqual(new Set([
      targetIdentity({ service: 'auth', resource: 'login', action: 'authenticate' }),
    ]));

    const buildReady = {
      path: 'x',
      shape: 'build-ready' as const,
      hasAuthoredContent: true,
      document: {
        policies: [{
          policyKey: 'p',
          discoveredTarget: { service: 'api', resource: '*', action: 'request' },
          rules: [{ target: { service: 'auth', resource: 'login', action: 'authenticate' } }],
        }],
      },
    };
    expect(knownIdentities(buildReady))
      .toEqual(new Set([
        targetIdentity({ service: 'api', resource: '*', action: 'request' }),
        targetIdentity({ service: 'auth', resource: 'login', action: 'authenticate' }),
      ]));
  });

  it('adds only unknown targets when merging', () => {
    const existing = {
      path: 'x',
      shape: 'analyze' as const,
      hasAuthoredContent: false,
      document: {
        drafts: [{ target: { service: 'auth', resource: 'login', action: 'authenticate' } }],
      },
    };

    const result = mergeIntoExisting(existing, [
      compared(),
      compared({
        id: 'payments-refund-execute',
        target: { service: 'payments', resource: 'refund', action: 'execute' },
      }),
    ], '2026-08-02T00:00:00.000Z');

    expect(result.added.map((entry) => entry.id)).toEqual(['payments-refund-execute']);
    expect(result.skipped.map((entry) => entry.id)).toEqual(['auth-login-authenticate']);
    expect((result.document.drafts as unknown[])).toHaveLength(2);
  });

  it('appends build-ready policies when the existing draft is build-ready', () => {
    const existing = {
      path: 'x',
      shape: 'build-ready' as const,
      hasAuthoredContent: true,
      document: { policies: [{ policyKey: 'existing', rules: [] }] },
    };

    const result = mergeIntoExisting(existing, [compared()], '2026-08-02T00:00:00.000Z');
    const policies = result.document.policies as Record<string, unknown>[];

    expect(policies).toHaveLength(2);
    expect(policies[1]).toMatchObject({
      policyKey: 'auth-login-authenticate',
      activeVersion: 1,
      rules: [],
    });
    // The existing entry is untouched.
    expect(policies[0]).toEqual({ policyKey: 'existing', rules: [] });
  });

  it('refuses to merge into a file it cannot understand', () => {
    const existing = {
      path: 'x',
      shape: 'unrecognised' as const,
      hasAuthoredContent: true,
      document: {},
    };
    expect(() => mergeIntoExisting(existing, [compared()], 'now'))
      .toThrow('could not be read');
  });
});

describe('loadComparisonBundles', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `govplane-bundles-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const valid = {
    schemaVersion: 1,
    orgId: 'org_1',
    projectId: 'proj_1',
    env: 'prod',
    policies: [],
  };

  it('loads a bundle that passes parity validation', () => {
    const path = join(root, 'ok.json');
    writeFileSync(path, JSON.stringify(valid));
    const result = loadComparisonBundles([path]);
    expect(result.failures).toEqual([]);
    expect(result.bundles).toHaveLength(1);
  });

  it('requires the scope fields the remote path requires', () => {
    const path = join(root, 'no-scope.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, env: 'prod', policies: [] }));

    const result = loadComparisonBundles([path]);
    expect(result.bundles).toEqual([]);
    expect(result.failures[0]?.errors.map((issue) => issue.code))
      .toContain('MISSING_SCOPE_FIELDS');
  });

  it('rejects an unsupported environment', () => {
    const path = join(root, 'bad-env.json');
    writeFileSync(path, JSON.stringify({ ...valid, env: 'production' }));
    expect(loadComparisonBundles([path]).failures[0]?.errors.map((issue) => issue.code))
      .toContain('INVALID_ENV');
  });

  it('reports malformed JSON as a validation failure', () => {
    const path = join(root, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(loadComparisonBundles([path]).failures[0]?.errors[0]?.code).toBe('INVALID_JSON');
  });

  it('fails loudly when the bundle does not exist', () => {
    expect(() => loadComparisonBundles([join(root, 'missing.json')]))
      .toThrow('Bundle not found');
  });
});
