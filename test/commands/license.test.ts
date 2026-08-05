import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode, toolkitCommands } from '@govplane/cli';
import {
  afterEach, beforeEach, describe, expect, it,
} from '@jest/globals';
import {
  createSandbox, daysAfterNow, licenseBody, NOW, runToolkit, type Sandbox,
} from '../helpers/harness.js';
import { commands } from '../../src/commands/registry.js';

describe('govplane license', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('reports an activated machine', async () => {
    sandbox.installLicense({ email: 'dev@example.com' });
    const result = await runToolkit(['license'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Activated');
    expect(result.stdout).toContain('dev@*******');
    expect(result.stdout).not.toContain('dev@example.com');
    expect(result.stdout).toContain('Valid (Ed25519, test-license-key)');
    expect(result.stdout).toContain('https://govplane.com/account');
  });

  it('never prints the signature value', async () => {
    const license = sandbox.installLicense();
    const result = await runToolkit(['license'], sandbox);

    expect(result.stdout).not.toContain(license.signature.value);
  });

  it('reports the grace state when nothing is activated', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['license'], sandbox, { now: daysAfterNow(4) });

    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain('Not activated — 26 days remaining');
    expect(result.stdout).toContain('govplane activate');
  });

  it('reports an exhausted grace period', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['license'], sandbox, { now: daysAfterNow(40) });

    expect(result.stdout).toContain('grace period has ended');
  });

  it('explains a licence that cannot be used', async () => {
    const license = sandbox.installLicense();
    sandbox.writeText('../home/license.json', JSON.stringify({ ...license, plan: 'enterprise' }));

    const result = await runToolkit(['license'], sandbox);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain('Problem:');
  });

  it('shows where the licence came from', async () => {
    const license = sandbox.signer.sign(licenseBody({ email: 'ci@example.com' }));
    const result = await runToolkit(['license'], sandbox, {
      env: { GOVPLANE_LICENSE: JSON.stringify(license) },
    });

    expect(result.stdout).toContain('GOVPLANE_LICENSE environment variable');
  });

  it('reports a due renewal without failing', async () => {
    sandbox.installLicense({ renewAfter: daysAfterNow(-1) });
    const result = await runToolkit(['license'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Due —');
  });

  it('emits machine-readable status', async () => {
    sandbox.installLicense();
    const result = await runToolkit(['license', '--format', 'json'], sandbox);
    const payload = result.json() as Record<string, unknown>;

    expect(payload.state).toBe('activated');
    // Deliberately unmasked: JSON is read by scripts, and the address is already in
    // license.json on the same machine. Only human-readable output masks it.
    expect(payload.email).toBe('dev@example.com');
    expect(payload.signature).toEqual({
      algorithm: 'Ed25519',
      keyId: 'test-license-key',
      valid: true,
    });
    expect(JSON.stringify(payload)).not.toContain('value');
  });

  it('emits the grace state as data, not prose', async () => {
    sandbox.setFirstUse(NOW);
    const result = await runToolkit(['license', '--format', 'json'], sandbox, {
      now: daysAfterNow(10),
    });

    expect(result.json()).toMatchObject({ state: 'grace', daysRemaining: 20 });
  });

  it('does not create the grace anchor just to report status', async () => {
    await runToolkit(['license'], sandbox);
    expect(existsSync(join(sandbox.home, 'state.json'))).toBe(false);
  });

  it('rejects an unknown subcommand', async () => {
    const result = await runToolkit(['license', 'renew'], sandbox);
    expect(result.code).toBe(ExitCode.InvalidArguments);
    expect(result.stderr).toContain('Unknown license subcommand');
  });
});

describe('govplane license verify', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('accepts a valid licence', async () => {
    sandbox.installLicense();
    const result = await runToolkit(['license', 'verify'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('signature is valid');
  });

  it('rejects an edited licence', async () => {
    const license = sandbox.installLicense();
    sandbox.writeText(
      '../home/license.json',
      JSON.stringify({ ...license, subject: { email: 'attacker@example.com' } }),
    );

    const result = await runToolkit(['license', 'verify'], sandbox);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('may have been edited');
  });

  it('reports a missing licence', async () => {
    const result = await runToolkit(['license', 'verify'], sandbox);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('No licence is installed');
  });

  it('emits a machine-readable verdict', async () => {
    sandbox.installLicense();
    const result = await runToolkit(['license', 'verify', '--format', 'json'], sandbox);

    expect(result.json()).toMatchObject({ valid: true, keyId: 'test-license-key' });
  });

  it('emits a machine-readable failure', async () => {
    const result = await runToolkit(['license', 'verify', '--format', 'json'], sandbox);
    const payload = result.json() as Record<string, unknown>;

    expect(payload.valid).toBe(false);
    expect(payload.problem).toBe('LICENSE_NOT_FOUND');
    expect(result.code).toBe(ExitCode.Failure);
  });

  it('works with no network access', async () => {
    sandbox.installLicense();
    const result = await runToolkit(['license', 'verify'], sandbox, {
      env: { GOVPLANE_API_URL: 'http://127.0.0.1:1' },
    });

    expect(result.code).toBe(ExitCode.Success);
  });
});

describe('govplane license remove', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('deletes the local licence and explains what it did not do', async () => {
    sandbox.installLicense();
    const result = await runToolkit(['license', 'remove'], sandbox);

    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('Licence removed');
    expect(result.stdout).toContain('removed the local copy only');
    expect(result.stdout).toContain('https://govplane.com/account');
    expect(existsSync(join(sandbox.home, 'license.json'))).toBe(false);
  });

  it('is safe to run when nothing is installed', async () => {
    const result = await runToolkit(['license', 'remove'], sandbox);
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain('No licence was installed');
  });

  it('emits a machine-readable result', async () => {
    sandbox.installLicense();
    const result = await runToolkit(['license', 'remove', '--format', 'json'], sandbox);

    expect(result.json()).toMatchObject({ removed: true });
  });
});

describe('command surface', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('lists the activation commands in help', async () => {
    const result = await runToolkit(['help'], sandbox);

    expect(result.stdout).toContain('Activation:');
    expect(result.stdout).toContain('activate');
    expect(result.stdout).toContain('license');
  });

  it('documents activate', async () => {
    const result = await runToolkit(['help', 'activate'], sandbox);

    expect(result.stdout).toContain('govplane activate [options]');
    expect(result.stdout).toContain('--no-browser');
    expect(result.stdout).toContain('--license <path>');
  });

  it('documents license, including its subcommands', async () => {
    const result = await runToolkit(['help', 'license'], sandbox);

    expect(result.stdout).toContain('verify');
    expect(result.stdout).toContain('remove');
  });

  it('keeps the basic CLI commands available and ungated', async () => {
    sandbox.setFirstUse(NOW);

    const version = await runToolkit(['version'], sandbox, { now: daysAfterNow(400) });
    expect(version.code).toBe(ExitCode.Success);

    const help = await runToolkit(['help'], sandbox, { now: daysAfterNow(400) });
    expect(help.code).toBe(ExitCode.Success);

    const workingFolder = await runToolkit(['working-folder'], sandbox, {
      now: daysAfterNow(400),
    });
    expect(workingFolder.code).toBe(ExitCode.Success);
  });

  it('leaves no CLI Toolkit command standing on the CLI placeholder', async () => {
    // The CLI declares a placeholder for every kit command and exits 7 when the
    // toolkit does not provide it. Now that all of them are implemented, a new
    // placeholder added to the CLI without a toolkit command would strand it —
    // this is what catches that.
    const declared = toolkitCommands.map((command) => command.name).sort();
    const provided = commands.map((command) => command.name).sort();

    expect(declared.filter((name) => !provided.includes(name))).toEqual([]);
  });
});
