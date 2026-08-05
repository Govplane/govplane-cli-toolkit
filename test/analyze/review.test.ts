import { describe, expect, it } from '@jest/globals';
import { Reporter } from '@govplane/cli';
import { createPrompter, type Prompter } from '../../src/analyze/prompt.js';
import { reviewDiscoveries } from '../../src/analyze/review.js';
import { draftGitState } from '../../src/analyze/draft.js';
import type { ComparedDiscovery } from '../../src/analyze/compare.js';
import { memoryStream } from '../helpers/harness.js';

const discovery = (id: string, service: string): ComparedDiscovery => ({
  id,
  target: { service, resource: 'login', action: 'authenticate' },
  expressions: {},
  availableContext: [{ key: `${service}Key`, source: `req.${service}` }],
  confidence: 'high',
  sources: [{ file: `src/${service}.ts`, line: 1, column: 1 }],
  status: 'missing',
  matchedPolicies: [],
});

/** A prompter driven by a fixed script, with no stream involved. */
const scripted = (answers: string[]): Prompter => {
  let index = 0;
  return {
    interactive: true,
    async ask(_question: string, _choices: string[], fallback: string) {
      const answer = answers[index];
      index += 1;
      return answer === undefined || answer === '' ? fallback : answer;
    },
    async askLine() {
      const answer = answers[index];
      index += 1;
      return answer ?? '';
    },
    close() {
      // Nothing to close.
    },
  };
};

const reporter = (): Reporter => new Reporter({
  stdout: memoryStream(),
  stderr: memoryStream(),
});

describe('reviewDiscoveries', () => {
  it('merges one draft into another, keeping both sets of evidence', async () => {
    const first = discovery('auth-login', 'auth');
    const second = discovery('web-login', 'web');

    const outcome = await reviewDiscoveries(
      [first, second],
      scripted(['accept', 'merge', 'auth-login']),
      reporter(),
    );

    expect(outcome.accepted.map((entry) => entry.id)).toEqual(['auth-login']);
    expect(outcome.merged).toEqual([{ from: 'web-login', into: 'auth-login' }]);
    expect(first.sources.map((location) => location.file))
      .toEqual(['src/auth.ts', 'src/web.ts']);
    expect(first.availableContext.map((field) => field.key))
      .toEqual(['authKey', 'webKey']);
  });

  it('keeps a draft when there is nothing to merge it into yet', async () => {
    const outcome = await reviewDiscoveries(
      [discovery('auth-login', 'auth')],
      scripted(['merge', 'accept']),
      reporter(),
    );

    expect(outcome.accepted.map((entry) => entry.id)).toEqual(['auth-login']);
    expect(outcome.merged).toEqual([]);
  });

  it('keeps a draft when the merge destination does not exist', async () => {
    const outcome = await reviewDiscoveries(
      [discovery('auth-login', 'auth'), discovery('web-login', 'web')],
      scripted(['accept', 'merge', 'nonexistent', 'accept']),
      reporter(),
    );

    expect(outcome.accepted.map((entry) => entry.id)).toEqual(['auth-login', 'web-login']);
    expect(outcome.merged).toEqual([]);
  });

  it('ignores an empty rename rather than blanking the policy key', async () => {
    const outcome = await reviewDiscoveries(
      [discovery('auth-login', 'auth')],
      scripted(['rename', '', 'accept']),
      reporter(),
    );

    expect(outcome.accepted[0]?.id).toBe('auth-login');
    expect(outcome.renamed).toEqual([]);
  });

  it('reports when a draft has no context to review', async () => {
    const bare = { ...discovery('auth-login', 'auth'), availableContext: [] };
    const stdout = memoryStream();
    const surface = new Reporter({ stdout, stderr: memoryStream() });

    await reviewDiscoveries([bare], scripted(['context', 'accept']), surface);

    expect(stdout.text()).toContain('No context fields were passed');
  });

  it('lists the existing policies that already govern a target', async () => {
    const covered = {
      ...discovery('auth-login', 'auth'),
      status: 'covered' as const,
      matchedPolicies: ['login-protection'],
    };
    const stdout = memoryStream();
    const surface = new Reporter({ stdout, stderr: memoryStream() });

    await reviewDiscoveries([covered], scripted(['accept']), surface);

    expect(stdout.text()).toContain('Existing:   login-protection');
  });

  it('summarises the extra source locations rather than listing them all', async () => {
    const many = {
      ...discovery('auth-login', 'auth'),
      sources: Array.from({ length: 6 }, (_unused, index) => ({
        file: `src/file-${index}.ts`,
        line: index + 1,
        column: 1,
      })),
    };
    const stdout = memoryStream();
    const surface = new Reporter({ stdout, stderr: memoryStream() });

    await reviewDiscoveries([many], scripted(['accept']), surface);

    expect(stdout.text()).toContain('and 3 more');
  });
});

describe('createPrompter', () => {
  it('never asks when there is no input', async () => {
    const prompter = createPrompter({ reporter: reporter() });

    expect(prompter.interactive).toBe(false);
    expect(await prompter.ask('q', ['a', 'b'], 'b')).toBe('b');
    expect(await prompter.askLine('q')).toBe('');
    prompter.close();
  });

  it('never asks when prompting is disabled', () => {
    const stdin = Object.assign(
      { isTTY: true },
      { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: '' }) }) },
    ) as never;

    expect(createPrompter({ stdin, reporter: reporter(), disabled: true }).interactive)
      .toBe(false);
  });
});

describe('draftGitState', () => {
  it('reports unknown rather than guessing when git cannot answer', () => {
    // A path with no repository above it, so `git status` fails.
    expect(draftGitState('/policy-drafts.json')).toBe('unknown');
  });
});
