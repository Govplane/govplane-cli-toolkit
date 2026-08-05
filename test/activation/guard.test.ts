import {
  ExitCode, isCliError, Reporter, fixedClock,
  type CommandContext, type CommandDefinition, type ExitCodeValue,
} from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import { activationSummary, requireActivation } from '../../src/activation/guard.js';
import { commands } from '../../src/commands/registry.js';
import {
  createSandbox, daysAfterNow, memoryStream, NOW, runToolkit, type Sandbox,
} from '../helpers/harness.js';

interface GuardRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Drives the guard the way a gated command will: build a context, call
 * `requireActivation`, and record what the user would see.
 */
interface GuardOptions {
  now?: string;
  quiet?: boolean;
  format?: 'text' | 'json';
  env?: NodeJS.ProcessEnv;
}

const guard = (sandbox: Sandbox, options: GuardOptions = {}): GuardRun => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const reporter = new Reporter({
    stdout,
    stderr,
    format: options.format ?? 'text',
    quiet: options.quiet ?? false,
  });

  const context: CommandContext = {
    positionals: [],
    options: {},
    cwd: sandbox.project,
    env: { ...sandbox.env, ...options.env },
    reporter,
    now: fixedClock(options.now ?? NOW),
    commands,
    toolkit: { installed: true, version: '1.0.0' },
  };

  let code: ExitCodeValue = ExitCode.Success;
  try {
    requireActivation(context, 'build');
  } catch (error) {
    if (!isCliError(error)) {
      throw error;
    }
    code = error.exitCode;
    stderr.write(`${error.message}\n`);
    error.details.forEach((line) => stderr.write(`${line}\n`));
  }

  return { code, stdout: stdout.text(), stderr: stderr.text() };
};

describe('requireActivation', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('says nothing when the machine is activated', () => {
    sandbox.installLicense();
    const result = guard(sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('shows a one-line reminder early in the grace period', () => {
    sandbox.setFirstUse(NOW);
    const result = guard(sandbox, { now: daysAfterNow(3) });

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Activation required in 27 days');
    expect(result.stdout).toContain('govplane activate');
    expect(result.stdout.split('\n').filter((line) => line !== '')).toHaveLength(1);
  });

  it('shows a block once the grace period is nearly over', () => {
    sandbox.setFirstUse(NOW);
    const result = guard(sandbox, { now: daysAfterNow(25) });

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Activation required in 5 days.');
    expect(result.stdout).toContain('Activation is free and needs only an email address.');
  });

  it('stops the command once the grace period has run out', () => {
    sandbox.setFirstUse(NOW);
    const result = guard(sandbox, { now: daysAfterNow(31) });

    expect(result.code).toBe(ExitCode.ToolkitUnavailable);
    expect(result.stderr).toContain('The build command requires activation.');
    expect(result.stderr).toContain('govplane activate');
  });

  it('reassures the user that nothing in production stopped working', () => {
    sandbox.setFirstUse(NOW);
    const result = guard(sandbox, { now: daysAfterNow(31) });

    expect(result.stderr).toContain('Your policies keep working');
    expect(result.stderr).toContain('govplane validate');
    expect(result.stderr).toContain('never require activation');
  });

  it('explains an unusable licence when it blocks', () => {
    const license = sandbox.installLicense();
    sandbox.writeText('../home/license.json', JSON.stringify({ ...license, plan: 'enterprise' }));
    sandbox.setFirstUse(NOW);

    const result = guard(sandbox, { now: daysAfterNow(31) });
    expect(result.stderr).toContain('could not be used');
  });

  it('stays silent in quiet mode', () => {
    sandbox.setFirstUse(NOW);
    const result = guard(sandbox, { now: daysAfterNow(3), quiet: true });

    expect(result.stdout).toBe('');
  });

  it('never writes prose into structured output', () => {
    sandbox.setFirstUse(NOW);
    const result = guard(sandbox, { now: daysAfterNow(25), format: 'json' });

    expect(result.stdout).toBe('');
  });

  it('reminds on every run in CI, from the first day', () => {
    sandbox.setFirstUse(NOW);
    const result = guard(sandbox, { now: NOW, env: { CI: 'true' } });

    expect(result.stdout).toContain('Activation required in 30 days.');
    expect(result.stdout).toContain('govplane activate');
  });

  it('nudges about a due renewal without blocking', () => {
    sandbox.installLicense({ renewAfter: daysAfterNow(-1) });
    const result = guard(sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('due for renewal');
  });
});

describe('activationSummary', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('describes the grace state for structured output', async () => {
    sandbox.setFirstUse(NOW);
    // Exercised through the license command, which reports the same shape.
    const result = await runToolkit(['license', '--format', 'json'], sandbox, {
      now: daysAfterNow(10),
    });

    expect(result.json()).toMatchObject({ state: 'grace', daysRemaining: 20 });
  });

  it('summarises an activated machine', () => {
    sandbox.installLicense();
    const summary = activationSummary({
      state: 'activated',
      daysRemaining: 30,
      daysElapsed: 0,
      license: null,
      source: 'file',
      renewalDue: false,
    });

    expect(summary).toEqual({ state: 'activated', daysRemaining: 30 });
  });

  it('carries the problem code when a licence could not be used', () => {
    const summary = activationSummary({
      state: 'grace',
      daysRemaining: 12,
      daysElapsed: 18,
      license: null,
      source: 'file',
      problem: 'LICENSE_SIGNATURE_INVALID',
      problemReason: 'edited',
      renewalDue: false,
    });

    expect(summary).toMatchObject({ problem: 'LICENSE_SIGNATURE_INVALID' });
  });
});

describe('gated commands', () => {
  it('contributes every CLI Toolkit command', () => {
    // Every command calls requireActivation() before doing any work.
    const contributed = commands.map((command: CommandDefinition) => command.name);
    expect(contributed)
      .toEqual(['activate', 'license', 'policies', 'build', 'sign', 'simulate', 'analyze']);
  });

  it('marks every CLI Toolkit command so it replaces the CLI placeholder', () => {
    const gated = commands.filter((command: CommandDefinition) => command.requiresToolkit);
    expect(gated.map((command: CommandDefinition) => command.name))
      .toEqual(['policies', 'build', 'sign', 'simulate', 'analyze']);
  });
});
