import { readFileSync } from 'node:fs';
import { ExitCode, stringifyJson } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import { createSandbox, runToolkit, type Sandbox } from '../helpers/harness.js';

const MIDDLEWARE = [
  "import { createPolicyEngine } from '@govplane/runtime-sdk';",
  '',
  'const gp = createPolicyEngine({ getBundle });',
  '',
  'export const guard = async (req, res, next) => {',
  '  const decision = await gp.evaluate({',
  '    target: {',
  '      service: "api-gateway",',
  '      resource: req.route?.path || "*",',
  '      action: "request"',
  '    },',
  '    context: { method: req.method, path: req.path }',
  '  });',
  '  return decision;',
  '};',
].join('\n');

const LOGIN = [
  "import { createPolicyEngine } from '@govplane/runtime-sdk';",
  'const gp = createPolicyEngine({ getBundle });',
  '',
  'export const login = async (attempt) => gp.evaluate({',
  '  target: { service: "auth", resource: "login", action: "authenticate" },',
  '  context: { failedAttempts: attempt.count }',
  '});',
].join('\n');

const BUNDLE = {
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
};

interface DraftFile {
  schemaVersion: string;
  generatedAt: string;
  drafts: {
    id: string;
    status: string;
    confidence: string;
    target: { service: string; resource: string; action: string };
    resourceExpression?: { dynamic: boolean; source: string; fallback: string };
    availableContext: { key: string; source?: string; type?: string }[];
    suggestedPolicy: { policyKey: string; friendlyName: string; rules: unknown[] };
    sources: { file: string; line: number; column: number }[];
  }[];
}

const readDraft = (sandbox: Sandbox): DraftFile => JSON.parse(
  readFileSync(`${sandbox.project}/policy-drafts.json`, 'utf8'),
) as DraftFile;

describe('govplane analyze', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('src/middleware.js', MIDDLEWARE);
    sandbox.writeText('src/login.js', LOGIN);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('discovers evaluation points and writes a draft', async () => {
    const result = await runToolkit(['analyze', '--source', '.'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Govplane Analysis');
    expect(result.stdout).toContain('api-gateway-request');
    expect(result.stdout).toContain('auth-login-authenticate');

    const draft = readDraft(sandbox);
    expect(draft.drafts).toHaveLength(2);
    expect(draft.schemaVersion).toBe('1.0');
  });

  it('never invents rules', async () => {
    await runToolkit(['analyze', '--source', '.'], sandbox);

    readDraft(sandbox).drafts.forEach((entry) => {
      expect(entry.suggestedPolicy.rules).toEqual([]);
    });
  });

  it('preserves a dynamic expression alongside its fallback', async () => {
    await runToolkit(['analyze', '--source', '.'], sandbox);

    const entry = readDraft(sandbox).drafts.find((draft) => draft.id === 'api-gateway-request');
    expect(entry?.target.resource).toBe('*');
    expect(entry?.resourceExpression).toEqual({
      dynamic: true,
      source: 'req.route?.path || "*"',
      fallback: '*',
    });
    expect(entry?.confidence).toBe('medium');
  });

  it('records context fields and where they came from', async () => {
    await runToolkit(['analyze', '--source', '.'], sandbox);

    const entry = readDraft(sandbox).drafts.find((draft) => draft.id === 'api-gateway-request');
    expect(entry?.availableContext).toEqual([
      { key: 'method', source: 'req.method' },
      { key: 'path', source: 'req.path' },
    ]);
  });

  it('records source locations relative to the scanned root', async () => {
    await runToolkit(['analyze', '--source', '.'], sandbox);

    const entry = readDraft(sandbox).drafts.find((draft) => draft.id === 'auth-login-authenticate');
    expect(entry?.sources).toEqual([{ file: 'src/login.js', line: 4, column: 41 }]);
  });

  it('produces an identical draft on a second run', async () => {
    await runToolkit(['analyze', '--source', '.'], sandbox);
    const first = readFileSync(`${sandbox.project}/policy-drafts.json`, 'utf8');

    await runToolkit(['analyze', '--source', '.', '--force'], sandbox);
    const second = readFileSync(`${sandbox.project}/policy-drafts.json`, 'utf8');

    expect(second).toBe(first);
  });

  it('reports nothing found without pretending otherwise', async () => {
    const empty = createSandbox();
    empty.installLicense();
    empty.writeText('src/app.js', 'export const add = (a, b) => a + b;');

    const result = await runToolkit(['analyze', '--source', '.'], empty);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('No Govplane evaluation points were found');
    empty.cleanup();
  });

  it('skips dependencies and build output', async () => {
    sandbox.writeText('node_modules/pkg/index.js', LOGIN.replace('auth', 'vendor'));
    sandbox.writeText('dist/bundle.js', LOGIN.replace('auth', 'compiled'));

    await runToolkit(['analyze', '--source', '.'], sandbox);

    const ids = readDraft(sandbox).drafts.map((entry) => entry.id);
    expect(ids).not.toContain('vendor-login-authenticate');
    expect(ids).not.toContain('compiled-login-authenticate');
  });

  it('honours exclusions from configuration', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({
      analyze: { exclude: ['*.js'] },
    }));

    const result = await runToolkit(['analyze', '--source', '.'], sandbox);
    expect(result.stdout).toContain('No Govplane evaluation points were found');
  });

  it('separates the source path from the working folder', async () => {
    sandbox.writeText('governance/.keep', '');
    const result = await runToolkit(
      ['analyze', '--source', '.', '--working-folder', './governance'],
      sandbox,
    );

    expect(result.code).toBe(ExitCode.Success);
    const draft = JSON.parse(
      readFileSync(`${sandbox.project}/governance/policy-drafts.json`, 'utf8'),
    ) as DraftFile;
    expect(draft.drafts).toHaveLength(2);
  });

  it('takes the source path from configuration when no flag is given', async () => {
    sandbox.writeText('govplane.config.json', stringifyJson({
      analyze: { source: './src' },
    }));

    const result = await runToolkit(['analyze'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    // Paths are relative to the configured root, not the working folder, so the
    // `src/` prefix is gone.
    const entry = readDraft(sandbox).drafts.find((draft) => draft.id === 'auth-login-authenticate');
    expect(entry?.sources[0]?.file).toBe('login.js');
  });

  it('names both resolved paths under --verbose', async () => {
    const result = await runToolkit(['analyze', '--source', '.', '--verbose'], sandbox);

    expect(result.stdout).toContain('Source path:');
    expect(result.stdout).toContain('Working folder:');
    expect(result.stdout).toContain('Files scanned: 2');
  });

  it('says nothing on success with --quiet, and still writes', async () => {
    const result = await runToolkit(['analyze', '--source', '.', '--quiet'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe('');
    expect(readDraft(sandbox).drafts).toHaveLength(2);
  });

  it('reports a call it recognised but could not read', async () => {
    sandbox.writeText('src/dynamic.js', [
      "import { createPolicyEngine } from '@govplane/runtime-sdk';",
      'const gp = createPolicyEngine({ getBundle });',
      'export const check = (request) => gp.evaluate(request);',
    ].join('\n'));

    const result = await runToolkit(['analyze', '--source', '.'], sandbox);

    expect(result.stdout).toContain('1 evaluation call could not be read');
    expect(result.stdout).toContain('src/dynamic.js:3');
  });

  it('reports a partially covered target distinctly from a missing one', async () => {
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));
    sandbox.writeText('src/logout.js', [
      'gp.evaluate({',
      '  target: { service: "auth", resource: "login", action: "logout" }',
      '});',
    ].join('\n'));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--bundle', 'policy-bundle.json'],
      sandbox,
    );

    expect(result.stdout).toContain('partially-covered');
    const entry = readDraft(sandbox).drafts.find((draft) => draft.id === 'auth-login-logout');
    expect(entry?.status).toBe('partially-covered');
  });

  it('keeps going when a file cannot be tokenized cleanly', async () => {
    sandbox.writeText('src/broken.js', 'const a = "unterminated\nconst b = 2;');

    const result = await runToolkit(['analyze', '--source', '.', '--verbose'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Partially parsed: src/broken.js');
    // The healthy files were still analysed.
    expect(readDraft(sandbox).drafts).toHaveLength(2);
  });

  it('writes where --output-draft says', async () => {
    await runToolkit(['analyze', '--source', '.', '--output-draft', './out/found.json'], sandbox);

    const draft = JSON.parse(
      readFileSync(`${sandbox.project}/out/found.json`, 'utf8'),
    ) as DraftFile;
    expect(draft.drafts).toHaveLength(2);
  });
});

describe('govplane analyze bundle comparison', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('src/middleware.js', MIDDLEWARE);
    sandbox.writeText('src/login.js', LOGIN);
    sandbox.writeText('policy-bundle.json', stringifyJson(BUNDLE));
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('marks a target an existing policy already governs as covered', async () => {
    await runToolkit(
      ['analyze', '--source', '.', '--bundle', 'policy-bundle.json'],
      sandbox,
    );

    const draft = readDraft(sandbox);
    const login = draft.drafts.find((entry) => entry.id === 'auth-login-authenticate');
    const gateway = draft.drafts.find((entry) => entry.id === 'api-gateway-request');

    expect(login?.status).toBe('covered');
    expect(gateway?.status).toBe('missing');
  });

  it('resolves a relative --bundle from the working folder', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '-w', '.', '--bundle', 'policy-bundle.json'],
      sandbox,
    );
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Compared against:');
  });

  it('stops before analysing when a bundle fails parity validation', async () => {
    sandbox.writeText('broken.json', stringifyJson({
      schemaVersion: 1, env: 'prod', policies: [],
    }));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--bundle', 'broken.json'],
      sandbox,
    );

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('MISSING_SCOPE_FIELDS');
    expect(result.stderr).toContain('Nothing was analysed');
  });

  it('fails when a bundle does not exist', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '--bundle', 'absent.json'],
      sandbox,
    );

    expect(result.code).toBe(ExitCode.FileError);
    expect(result.stderr).toContain('Bundle not found');
  });
});

describe('govplane analyze --check', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('src/middleware.js', MIDDLEWARE);
    sandbox.writeText('src/login.js', LOGIN);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('exits non-zero when uncovered drafts exist', async () => {
    const result = await runToolkit(['analyze', '--source', '.', '--check'], sandbox);

    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain('Found 2 uncovered policy drafts');
    expect(result.stdout).toContain('api-gateway / * / request');
    expect(result.stdout).toContain('src/middleware.js:6');
  });

  it('writes nothing in check mode', async () => {
    await runToolkit(['analyze', '--source', '.', '--check'], sandbox);
    expect(() => readDraft(sandbox)).toThrow();
  });

  it('exits zero when everything is covered', async () => {
    const covering = {
      ...BUNDLE,
      policies: [
        BUNDLE.policies[0],
        {
          policyKey: 'gateway',
          activeVersion: 1,
          defaults: { effect: 'allow' },
          rules: [{
            id: 'allow-all',
            status: 'active',
            priority: 1,
            target: { service: 'api-gateway', resource: '*', action: 'request' },
            effect: { type: 'allow' },
          }],
        },
      ],
    };
    sandbox.writeText('policy-bundle.json', stringifyJson(covering));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--check', '--bundle', 'policy-bundle.json'],
      sandbox,
    );

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('covered');
  });

  it('reports bundle validation failures first, and still fails', async () => {
    sandbox.writeText('broken.json', stringifyJson({ schemaVersion: 2, policies: [] }));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--check', '--bundle', 'broken.json'],
      sandbox,
    );

    expect(result.code).toBe(ExitCode.Compatibility);
    expect(result.stderr).toContain('INVALID_SCHEMA_VERSION');
  });

  it('emits machine-readable output with --format json', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '--check', '--format', 'json'],
      sandbox,
    );

    const payload = result.json() as {
      success: boolean; uncovered: number; drafts: { id: string }[];
    };
    expect(payload.success).toBe(false);
    expect(payload.uncovered).toBe(2);
    expect(payload.drafts.map((entry) => entry.id).sort())
      .toEqual(['api-gateway-request', 'auth-login-authenticate']);
  });
});

describe('govplane analyze and existing drafts', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('src/login.js', LOGIN);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('refuses to overwrite a draft without being told how', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0', policies: [],
    }));

    const result = await runToolkit(['analyze', '--source', '.'], sandbox);

    expect(result.code).toBe(ExitCode.Conflict);
    expect(result.stderr).toContain('A draft file already exists');
    expect(result.stderr).toContain('--merge');
    expect(result.stderr).toContain('--force');
    expect(result.stderr).toContain('DRAFT_EXISTS');
  });

  it('leaves the existing draft untouched when it refuses', async () => {
    const original = stringifyJson({ schemaVersion: '1.0', policies: [] });
    sandbox.writeText('policy-drafts.json', original);

    await runToolkit(['analyze', '--source', '.'], sandbox);

    expect(readFileSync(`${sandbox.project}/policy-drafts.json`, 'utf8')).toBe(original);
  });

  it('replaces the draft with --force', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0', policies: [{ policyKey: 'old', activeVersion: 1, rules: [] }],
    }));

    const result = await runToolkit(['analyze', '--source', '.', '--force'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(readDraft(sandbox).drafts).toHaveLength(1);
  });

  it('adds to an authored draft with --merge, keeping the authored work', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      policies: [{
        policyKey: 'hand-written',
        activeVersion: 1,
        defaults: { effect: 'deny' },
        rules: [{
          id: 'r1',
          priority: 10,
          target: { service: 'billing', resource: 'invoice', action: 'read' },
          effect: { type: 'allow' },
        }],
      }],
    }));

    const result = await runToolkit(['analyze', '--source', '.', '--merge'], sandbox);
    expect(result.code).toBe(ExitCode.Success);

    const draft = JSON.parse(
      readFileSync(`${sandbox.project}/policy-drafts.json`, 'utf8'),
    ) as { policies: Record<string, unknown>[] };

    expect(draft.policies).toHaveLength(2);
    expect(draft.policies[0]).toMatchObject({
      policyKey: 'hand-written',
      defaults: { effect: 'deny' },
    });
    expect(draft.policies[1]).toMatchObject({
      policyKey: 'auth-login-authenticate',
      rules: [],
    });
  });

  it('does not re-add a target the draft already knows about', async () => {
    await runToolkit(['analyze', '--source', '.'], sandbox);
    const result = await runToolkit(['analyze', '--source', '.', '--merge'], sandbox);

    expect(result.stdout).toContain('0 added, 1 already present');
    expect(readDraft(sandbox).drafts).toHaveLength(1);
  });

  it('asks what to do about an existing draft when a terminal is there', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      policies: [{ policyKey: 'hand-written', activeVersion: 1, rules: [] }],
    }));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['accept', 'merge'] },
    );

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('A draft file already exists');

    const draft = JSON.parse(
      readFileSync(`${sandbox.project}/policy-drafts.json`, 'utf8'),
    ) as { policies: { policyKey: string }[] };
    expect(draft.policies.map((entry) => entry.policyKey))
      .toEqual(['hand-written', 'auth-login-authenticate']);
  });

  it('replaces the draft when the reviewer chooses overwrite', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      policies: [{ policyKey: 'hand-written', activeVersion: 1, rules: [] }],
    }));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['accept', 'overwrite'] },
    );

    expect(result.code).toBe(ExitCode.Success);
    expect(readDraft(sandbox).drafts.map((entry) => entry.id))
      .toEqual(['auth-login-authenticate']);
  });

  it('warns that an edited draft would lose work', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({
      schemaVersion: '1.0',
      policies: [{
        policyKey: 'hand-written',
        activeVersion: 1,
        rules: [{ id: 'r1', priority: 1, effect: { type: 'deny' } }],
      }],
    }));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['accept', 'merge'] },
    );

    expect(result.stdout).toContain('edited since discovery');
  });

  it('rejects --force and --merge together', async () => {
    sandbox.writeText('policy-drafts.json', stringifyJson({ schemaVersion: '1.0', drafts: [] }));

    const result = await runToolkit(
      ['analyze', '--source', '.', '--force', '--merge'],
      sandbox,
    );

    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('opposite things');
  });
});

describe('govplane analyze --interactive', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.installLicense();
    sandbox.writeText('src/middleware.js', MIDDLEWARE);
    sandbox.writeText('src/login.js', LOGIN);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('refuses to prompt when there is no terminal', async () => {
    const result = await runToolkit(['analyze', '--source', '.', '--interactive'], sandbox);

    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('needs a terminal');
  });

  it('accepts every draft when the reviewer presses Enter', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['', ''] },
    );

    expect(result.code).toBe(ExitCode.Success);
    expect(readDraft(sandbox).drafts).toHaveLength(2);
  });

  it('leaves an ignored draft out of the file', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['ignore', 'accept'] },
    );

    expect(result.code).toBe(ExitCode.Success);
    const ids = readDraft(sandbox).drafts.map((entry) => entry.id);
    expect(ids).toEqual(['auth-login-authenticate']);
    expect(result.stdout).toContain('Ignored 1 draft');
  });

  it('renames a policy when asked', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['rename', 'gateway-guard', 'accept', 'accept'] },
    );

    expect(result.code).toBe(ExitCode.Success);
    const draft = readDraft(sandbox);
    expect(draft.drafts.map((entry) => entry.id)).toContain('gateway-guard');
    expect(draft.drafts.find((entry) => entry.id === 'gateway-guard')?.suggestedPolicy)
      .toMatchObject({ policyKey: 'gateway-guard', friendlyName: 'Gateway Guard' });
  });

  it('shows the detected context on request', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['context', 'accept', 'accept'] },
    );

    expect(result.stdout).toContain('Context available to this policy');
    expect(result.stdout).toContain('method');
  });

  it('delivers every scripted answer to the question that asked for it', async () => {
    // Four questions, four answers, in order: readline drops lines that arrive
    // while no question is outstanding, so answers supplied faster than a human
    // types must be buffered rather than pushed.
    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['rename', 'first-rename', 'accept', 'ignore'] },
    );

    expect(result.code).toBe(ExitCode.Success);
    expect(readDraft(sandbox).drafts.map((entry) => entry.id)).toEqual(['first-rename']);
  });

  it('falls back to accepting when input ends mid-review', async () => {
    // Ctrl-D half way through must not crash and must not lose the answers
    // already given.
    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['ignore'] },
    );

    expect(result.code).toBe(ExitCode.Success);
    expect(readDraft(sandbox).drafts.map((entry) => entry.id))
      .toEqual(['auth-login-authenticate']);
  });

  it('accepts the remainder when the reviewer quits', async () => {
    const result = await runToolkit(
      ['analyze', '--source', '.', '--interactive'],
      sandbox,
      { answers: ['quit'] },
    );

    expect(result.code).toBe(ExitCode.Success);
    expect(readDraft(sandbox).drafts).toHaveLength(2);
  });
});
