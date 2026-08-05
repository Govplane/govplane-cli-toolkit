import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliError, stringifyJson } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  emptyDraft, loadDraft, nextVersionedPath, normaliseDraft, resolveDraftFile, resolveVersioning,
  sortDraft, writeDraft,
} from '../../src/drafts/store.js';
import { draftStats, type DraftDocument } from '../../src/drafts/types.js';
import { createSandbox, NOW, type Sandbox } from '../helpers/harness.js';

const policy = (policyKey: string, rules: unknown[] = []): unknown => ({
  policyKey,
  activeVersion: 1,
  defaults: { effect: 'allow' },
  rules,
});

const rule = (id: string, priority: number): unknown => ({
  id,
  status: 'active',
  priority,
  target: { service: 'auth', resource: 'login', action: 'authenticate' },
  effect: { type: 'deny' },
});

describe('resolveDraftFile', () => {
  it('prefers an explicit path', () => {
    expect(resolveDraftFile('/project', {}, './drafts/custom.json'))
      .toBe('/project/drafts/custom.json');
  });

  it('falls back to the configured path', () => {
    expect(resolveDraftFile('/project', { draft: { path: 'policies/drafts.json' } }))
      .toBe('/project/policies/drafts.json');
  });

  it('falls back to the default filename', () => {
    expect(resolveDraftFile('/project', {})).toBe('/project/policy-drafts.json');
  });
});

describe('normaliseDraft', () => {
  it('accepts a build-ready document unchanged', () => {
    const result = normaliseDraft(
      { schemaVersion: '1.0', env: 'prod', policies: [policy('a')] },
      NOW,
    );

    expect(result.shape).toBe('build-ready');
    expect(result.document.policies).toHaveLength(1);
    expect(result.document.env).toBe('prod');
  });

  it('converts an analyze document into build-ready shape', () => {
    const result = normaliseDraft({
      schemaVersion: '1.0',
      drafts: [{
        id: 'api-gateway-request',
        target: { service: 'api-gateway', resource: '*', action: 'request' },
        suggestedPolicy: {
          policyKey: 'api-gateway-request',
          friendlyName: 'API Gateway Request',
          rules: [],
        },
      }],
    }, NOW);

    expect(result.shape).toBe('analyze');
    const [converted] = result.document.policies;
    expect(converted?.policyKey).toBe('api-gateway-request');
    expect(converted?.friendlyName).toBe('API Gateway Request');
    expect(converted?.rules).toEqual([]);
  });

  it('keeps the target analyze discovered', () => {
    const result = normaliseDraft({
      schemaVersion: '1.0',
      drafts: [{
        id: 'x',
        target: { service: 'api', resource: 'orders', action: 'read' },
      }],
    }, NOW);

    expect(result.document.policies[0]).toMatchObject({
      discoveredTarget: { service: 'api', resource: 'orders', action: 'read' },
    });
  });

  it('does not invent a default effect analyze never supplied', () => {
    const result = normaliseDraft({ schemaVersion: '1.0', drafts: [{ id: 'x' }] }, NOW);
    expect(result.document.policies[0]?.defaults).toBeUndefined();
  });

  it('names an unnamed analyze entry predictably', () => {
    const result = normaliseDraft({ schemaVersion: '1.0', drafts: [{}, {}] }, NOW);
    expect(result.document.policies.map((entry) => entry.policyKey))
      .toEqual(['discovered-policy-1', 'discovered-policy-2']);
  });

  it('stamps generatedAt when the document has none', () => {
    const result = normaliseDraft({ schemaVersion: '1.0', policies: [] }, NOW);
    expect(result.document.generatedAt).toBe(NOW);
  });

  it('rejects a document that is neither shape', () => {
    expect(() => normaliseDraft({ schemaVersion: '1.0' }, NOW)).toThrow('"policies" or "drafts"');
    expect(() => normaliseDraft('nope', NOW)).toThrow('must contain a JSON object');
  });
});

describe('sortDraft', () => {
  it('orders policies by key and rules by priority then id', () => {
    const document = {
      schemaVersion: '1.0',
      policies: [
        policy('zeta', [rule('b', 10), rule('a', 10), rule('c', 90)]),
        policy('alpha'),
      ],
    } as unknown as DraftDocument;

    const sorted = sortDraft(document);

    expect(sorted.policies.map((entry) => entry.policyKey)).toEqual(['alpha', 'zeta']);
    expect(sorted.policies[1]?.rules.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input', () => {
    const document = {
      schemaVersion: '1.0',
      policies: [policy('zeta'), policy('alpha')],
    } as unknown as DraftDocument;

    sortDraft(document);
    expect(document.policies[0]?.policyKey).toBe('zeta');
  });
});

describe('draft files on disk', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('round-trips a written draft', () => {
    const path = join(sandbox.project, 'policy-drafts.json');
    const document = emptyDraft(NOW, 'prod');

    const written = writeDraft(path, document);
    expect(written).toEqual({ path, versioned: false });

    const loaded = loadDraft(path, NOW);
    expect(loaded.document.env).toBe('prod');
    expect(loaded.shape).toBe('build-ready');
  });

  it('writes deterministically ordered content', () => {
    const path = join(sandbox.project, 'policy-drafts.json');
    writeDraft(path, {
      schemaVersion: '1.0',
      policies: [policy('zeta'), policy('alpha')],
    } as unknown as DraftDocument);

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as DraftDocument;
    expect(onDisk.policies.map((entry) => entry.policyKey)).toEqual(['alpha', 'zeta']);
  });

  it('reports a missing draft with a way forward', () => {
    try {
      loadDraft(join(sandbox.project, 'absent.json'), NOW);
      throw new Error('expected a failure');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      if (isCliError(error)) {
        expect(error.code).toBe('DRAFT_FILE_NOT_FOUND');
        expect(error.details.join('\n')).toContain('govplane policies create-file');
      }
    }
  });

  it('reports malformed JSON', () => {
    const path = sandbox.writeText('policy-drafts.json', '{ broken');
    expect(() => loadDraft(path, NOW)).toThrow('not valid JSON');
  });

  it('counts policies and rules', () => {
    const document = {
      schemaVersion: '1.0',
      policies: [policy('a', [rule('r1', 1), rule('r2', 2)]), policy('b')],
    } as unknown as DraftDocument;

    expect(draftStats(document)).toEqual({ policies: 2, rules: 2 });
  });
});

describe('draft versioning', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('uses the base filename when nothing exists yet', () => {
    const path = join(sandbox.project, 'policy-drafts.json');
    expect(nextVersionedPath(path)).toBe(path);
  });

  it('advances the suffix as versions accumulate', () => {
    const path = join(sandbox.project, 'policy-drafts.json');
    sandbox.writeText('policy-drafts.json', stringifyJson(emptyDraft(NOW)));
    expect(nextVersionedPath(path)).toBe(join(sandbox.project, 'policy-drafts.v2.json'));

    sandbox.writeText('policy-drafts.v2.json', stringifyJson(emptyDraft(NOW)));
    expect(nextVersionedPath(path)).toBe(join(sandbox.project, 'policy-drafts.v3.json'));
  });

  it('never reuses a suffix when the sequence has gaps', () => {
    const path = join(sandbox.project, 'policy-drafts.json');
    sandbox.writeText('policy-drafts.json', '{}');
    sandbox.writeText('policy-drafts.v7.json', '{}');

    expect(nextVersionedPath(path)).toBe(join(sandbox.project, 'policy-drafts.v8.json'));
  });

  it('leaves the previous version untouched', () => {
    const path = join(sandbox.project, 'policy-drafts.json');
    writeDraft(path, emptyDraft(NOW, 'prod'));

    const next = writeDraft(path, emptyDraft(NOW, 'dev'), { versioned: true });

    expect(next.path).toBe(join(sandbox.project, 'policy-drafts.v2.json'));
    expect(next.versioned).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(loadDraft(path, NOW).document.env).toBe('prod');
    expect(loadDraft(next.path, NOW).document.env).toBe('dev');
  });
});

describe('resolveVersioning', () => {
  it('is off unless asked for', () => {
    expect(resolveVersioning({}, {})).toBe(false);
  });

  it('reads the project configuration', () => {
    expect(resolveVersioning({ policies: { versioning: { enabled: true } } }, {})).toBe(true);
  });

  it('lets the flag override the configuration in both directions', () => {
    const config = { policies: { versioning: { enabled: true } } };
    expect(resolveVersioning(config, { versioned: false })).toBe(false);
    expect(resolveVersioning({}, { versioned: true })).toBe(true);
  });
});
