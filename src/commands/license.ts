import {
  CliError, ExitCode, formatOption, helpOption, quietOption, verboseOption,
  type CommandContext, type CommandDefinition, type ExitCodeValue, type Reporter,
} from '@govplane/cli';
import { resolveActivation } from '../activation/grace.js';
import { licensePath, loadLicense, removeLicense } from '../activation/license.js';
import { maskEmail } from '../activation/mask.js';
import { ACCOUNT_URL } from '../activation/messages.js';
import type { ActivationStatus, LicenseSource } from '../activation/types.js';

const SUBCOMMANDS = ['verify', 'remove'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const SOURCE_LABEL: Record<LicenseSource, string> = {
  environment: 'GOVPLANE_LICENSE environment variable',
  'environment-file': 'GOVPLANE_LICENSE_FILE environment variable',
  file: 'local licence file',
};

/**
 * Structured view of the activation status.
 *
 * `signature.value` is deliberately absent: the licence is personal data plus a
 * credential-shaped blob, and no output path is allowed to print it.
 */
const toJson = (status: ActivationStatus, path: string): Record<string, unknown> => {
  if (status.license === null) {
    return {
      state: status.state,
      daysRemaining: status.daysRemaining,
      licensePath: path,
      ...(status.problem === undefined
        ? {}
        : { problem: status.problem, problemReason: status.problemReason }),
    };
  }

  const { license } = status;
  return {
    state: status.state,
    licenseId: license.licenseId,
    email: license.subject.email,
    plan: license.plan,
    issuedAt: license.issuedAt,
    ...(license.renewAfter === undefined ? {} : { renewAfter: license.renewAfter }),
    terms: license.terms,
    marketingConsent: license.marketingConsent,
    signature: {
      algorithm: license.signature.algorithm,
      keyId: license.signature.keyId,
      valid: true,
    },
    renewalDue: status.renewalDue,
    source: status.source,
  };
};

const printStatus = (reporter: Reporter, status: ActivationStatus, path: string): void => {
  reporter.line(reporter.heading('Govplane Licence'));
  reporter.line();

  if (status.license === null) {
    reporter.line('Status:');
    reporter.line(status.state === 'grace_expired'
      ? '  Not activated — the 30-day grace period has ended'
      : `  Not activated — ${status.daysRemaining} days remaining`);

    if (status.problem !== undefined) {
      reporter.line();
      reporter.line('Problem:');
      reporter.line(`  ${status.problemReason ?? status.problem}`);
    }

    reporter.line();
    reporter.line('Expected licence file:');
    reporter.line(`  ${path}`);
    reporter.line();
    reporter.line('Activation is free and needs only an email address:');
    reporter.line('  govplane activate');
    return;
  }

  const { license } = status;
  reporter.line('Status:');
  reporter.line('  Activated');
  reporter.line();
  reporter.line('Email:');
  reporter.line(`  ${maskEmail(license.subject.email)}`);
  reporter.line();
  reporter.line('Licence ID:');
  reporter.line(`  ${license.licenseId}`);
  reporter.line();
  reporter.line('Plan:');
  reporter.line(`  ${license.plan}`);
  reporter.line();
  reporter.line('Issued at:');
  reporter.line(`  ${license.issuedAt}`);
  reporter.line();
  reporter.line('Terms accepted:');
  reporter.line(`  ${license.terms.version} (${license.terms.acceptedAt})`);
  reporter.line();
  reporter.line('Product news:');
  reporter.line(`  ${license.marketingConsent ? 'subscribed' : 'not subscribed'}`);
  reporter.line();
  reporter.line('Signature:');
  reporter.line(`  Valid (${license.signature.algorithm}, ${license.signature.keyId})`);
  reporter.line();
  reporter.line('Source:');
  reporter.line(`  ${status.source === null ? 'unknown' : SOURCE_LABEL[status.source]}`);

  if (status.renewalDue) {
    reporter.line();
    reporter.line('Renewal:');
    reporter.line('  Due — re-run "govplane activate" when convenient.');
  }

  reporter.line();
  reporter.line('Manage your account, preferences and data:');
  reporter.line(`  ${ACCOUNT_URL}`);
};

const showStatus = (context: CommandContext): ExitCodeValue => {
  const status = resolveActivation({ now: context.now, env: context.env, readOnly: true });
  const path = licensePath(context.env);

  if (context.reporter.format === 'json') {
    context.reporter.json(toJson(status, path));
  } else {
    printStatus(context.reporter, status, path);
  }

  return status.license === null ? ExitCode.Failure : ExitCode.Success;
};

const verify = (context: CommandContext): ExitCodeValue => {
  const result = loadLicense(context.env);
  const { reporter } = context;

  if (result.ok) {
    if (reporter.format === 'json') {
      reporter.json({
        valid: true,
        licenseId: result.license.licenseId,
        keyId: result.license.signature.keyId,
        source: result.source,
      });
    } else {
      reporter.line(`${reporter.success('✓')} Licence signature is valid`);
      reporter.line();
      reporter.line(`  Licence ID:  ${result.license.licenseId}`);
      reporter.line(`  Key ID:      ${result.license.signature.keyId}`);
    }
    return ExitCode.Success;
  }

  if (reporter.format === 'json') {
    reporter.json({ valid: false, problem: result.problem, reason: result.reason });
    return ExitCode.Failure;
  }

  throw new CliError('The licence could not be verified.', {
    code: result.problem,
    exitCode: ExitCode.Failure,
    details: ['', result.reason, '', 'Activate with:', '  govplane activate'],
  });
};

const remove = (context: CommandContext): ExitCodeValue => {
  const { reporter } = context;
  const path = licensePath(context.env);
  const removed = removeLicense(context.env);

  if (reporter.format === 'json') {
    reporter.json({ removed, licensePath: path });
    return ExitCode.Success;
  }

  reporter.line(removed
    ? `Licence removed: ${path}`
    : 'No licence was installed on this machine.');
  reporter.line();
  reporter.line('This removed the local copy only. To delete your account or change your');
  reporter.line('communication preferences:');
  reporter.line(`  ${ACCOUNT_URL}`);
  return ExitCode.Success;
};

const run = (context: CommandContext): ExitCodeValue => {
  const subcommand = context.positionals[0];

  if (subcommand === undefined) {
    return showStatus(context);
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new CliError(`Unknown license subcommand: ${subcommand}`, {
      code: 'UNKNOWN_SUBCOMMAND',
      exitCode: ExitCode.InvalidArguments,
      details: ['', `Available subcommands: ${SUBCOMMANDS.join(', ')}`],
    });
  }

  const handlers: Record<Subcommand, (input: CommandContext) => ExitCodeValue> = {
    verify,
    remove,
  };

  return handlers[subcommand as Subcommand](context);
};

export const licenseCommand: CommandDefinition = {
  name: 'license',
  summary: 'Show or manage the Govplane licence',
  usage: 'govplane license [verify | remove] [options]',
  description: 'Show the activation status of this machine, re-verify the licence signature, '
    + 'or remove the local licence.',
  requiresToolkit: false,
  group: 'activation',
  subcommands: [
    { name: 'verify', summary: 'Re-verify the licence signature locally' },
    { name: 'remove', summary: 'Delete the local licence file' },
  ],
  options: [formatOption, quietOption, verboseOption, helpOption],
  examples: [
    'govplane license',
    'govplane license verify',
    'govplane license remove',
  ],
  run,
};
