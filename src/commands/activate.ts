import {
  CliError, ExitCode, formatOption, helpOption, parseJson, quietOption, readBoolean, readString,
  readTextFile, verboseOption,
  type CommandContext, type CommandDefinition, type ExitCodeValue, type Reporter,
} from '@govplane/cli';
import { resolve } from 'node:path';
import {
  openBrowser, pollForLicense, startDeviceActivation, type DeviceStart,
} from '../activation/deviceFlow.js';
import { loadLicense, storeLicense, verifyLicense } from '../activation/license.js';
import { maskEmail } from '../activation/mask.js';
import { ACCOUNT_URL } from '../activation/messages.js';
import type { License, LicenseResult } from '../activation/types.js';
import { resolveApiUrl } from '../http/client.js';
import { readToolkitVersion } from '../core/environment.js';

const consentLabel = (license: License): string => (
  license.marketingConsent ? 'subscribed' : 'not subscribed'
);

const reportActivated = (
  reporter: Reporter,
  license: License,
  path: string | null,
): void => {
  if (reporter.format === 'json') {
    reporter.json({
      success: true,
      licenseId: license.licenseId,
      email: license.subject.email,
      plan: license.plan,
      issuedAt: license.issuedAt,
      terms: license.terms,
      marketingConsent: license.marketingConsent,
      ...(path === null ? {} : { licensePath: path }),
    });
    return;
  }

  reporter.line();
  reporter.line(`${reporter.success('✓')} Activated for ${maskEmail(license.subject.email)}`);
  reporter.line();
  if (path !== null) {
    reporter.line(`  Licence:       ${path}`);
  }
  reporter.line(`  Terms:         ${license.terms.version}`);
  reporter.line(`  Product news:  ${consentLabel(license)}`);
  reporter.line();
  reporter.line('This machine will not contact Govplane again.');
};

/** Rejects a licence that arrived but does not verify. */
const rejectLicense = (result: Extract<LicenseResult, { ok: false }>): never => {
  throw new CliError('The licence could not be verified.', {
    code: result.problem,
    exitCode: ExitCode.Compatibility,
    details: ['', result.reason],
  });
};

const importLicenseFile = (context: CommandContext, path: string): ExitCodeValue => {
  const absolute = resolve(context.cwd, path);
  const parsed = parseJson(readTextFile(absolute));

  if (!parsed.ok) {
    throw new CliError(`The licence file is not valid JSON: ${absolute}`, {
      code: 'LICENSE_INVALID_JSON',
      exitCode: ExitCode.Failure,
      details: ['', parsed.message],
    });
  }

  const result = verifyLicense(parsed.value, { env: context.env, path: absolute });
  if (!result.ok) {
    return rejectLicense(result);
  }

  const stored = storeLicense(result.license, context.env);
  reportActivated(context.reporter, result.license, stored);
  return ExitCode.Success;
};

const reportAlreadyActivated = (
  context: CommandContext,
  license: License,
): ExitCodeValue => {
  const { reporter } = context;

  if (reporter.format === 'json') {
    reporter.json({
      success: true,
      alreadyActivated: true,
      licenseId: license.licenseId,
      email: license.subject.email,
    });
    return ExitCode.Success;
  }

  reporter.line(`This machine is already activated for ${maskEmail(license.subject.email)}.`);
  reporter.line();
  reporter.line('Re-run with --force to activate against a different account.');
  return ExitCode.Success;
};

const printPrompt = (
  reporter: Reporter,
  start: DeviceStart,
  browserOpened: boolean,
): void => {
  reporter.line('Activation is free and needs only an email address.');
  reporter.line();
  reporter.line(browserOpened
    ? 'Your browser should open. If it does not, open this page and enter the code:'
    : 'Open this page and enter the code:');
  reporter.line();
  reporter.line(`  ${reporter.accent(start.verificationUri)}`);
  reporter.line();
  reporter.line(`  Code:  ${reporter.heading(start.userCode)}`);
  reporter.line();
  reporter.line(reporter.muted(
    `Waiting for confirmation... (expires in ${Math.round(start.expiresInSeconds / 60)} minutes)`,
  ));
};

const activateOnline = async (context: CommandContext): Promise<ExitCodeValue> => {
  const { reporter } = context;
  const deps = { now: context.now, env: context.env };

  reporter.debug(`Activation service: ${resolveApiUrl(context.env)}`);

  const started = await startDeviceActivation(readToolkitVersion(), deps);
  if (!started.ok) {
    throw new CliError('Activation could not be started.', {
      code: 'ACTIVATION_UNREACHABLE',
      exitCode: ExitCode.Failure,
      details: [
        '',
        started.reason,
        '',
        'If this machine has no internet access, activate on another machine and',
        'import the licence here:',
        '  govplane activate --license ./govplane.license',
      ],
    });
  }

  const { start } = started;
  const target = start.verificationUriComplete ?? start.verificationUri;
  const browserOpened = readBoolean(context.options, 'no-browser')
    ? false
    : openBrowser(target);

  printPrompt(reporter, start, browserOpened);

  const outcome = await pollForLicense(start, deps);

  if (outcome.status === 'denied') {
    throw new CliError('Activation was declined.', {
      code: 'ACTIVATION_DECLINED',
      exitCode: ExitCode.Failure,
      details: ['', 'Run "govplane activate" again if this was not intentional.'],
    });
  }

  if (outcome.status === 'expired') {
    throw new CliError('The activation request expired.', {
      code: 'ACTIVATION_EXPIRED',
      exitCode: ExitCode.Failure,
      details: ['', 'Run "govplane activate" to start again.'],
    });
  }

  if (outcome.status === 'unreachable') {
    throw new CliError('Activation could not be completed.', {
      code: 'ACTIVATION_UNREACHABLE',
      exitCode: ExitCode.Failure,
      details: ['', outcome.reason],
    });
  }

  const result = verifyLicense(outcome.license, { env: context.env });
  if (!result.ok) {
    return rejectLicense(result);
  }

  const stored = storeLicense(result.license, context.env);
  reportActivated(reporter, result.license, stored);
  return ExitCode.Success;
};

const run = async (context: CommandContext): Promise<ExitCodeValue> => {
  const licenseFile = readString(context.options, 'license');
  if (licenseFile !== undefined) {
    return importLicenseFile(context, licenseFile);
  }

  if (!readBoolean(context.options, 'force')) {
    const existing = loadLicense(context.env);
    if (existing.ok) {
      return reportAlreadyActivated(context, existing.license);
    }
  }

  return activateOnline(context);
};

export const activateCommand: CommandDefinition = {
  name: 'activate',
  summary: 'Activate the Govplane CLI Toolkit (free)',
  usage: 'govplane activate [options]',
  description: 'Activate the CLI Toolkit. Activation is free, needs only an email address, '
    + 'and is confirmed in your browser. Once activated, the toolkit works offline.',
  requiresToolkit: false,
  group: 'activation',
  options: [
    { name: 'no-browser', type: 'boolean', description: 'Do not try to open a browser' },
    {
      name: 'license',
      type: 'string',
      placeholder: '<path>',
      description: 'Import a licence file instead of activating online',
    },
    { name: 'force', type: 'boolean', description: 'Activate again even if already activated' },
    formatOption,
    quietOption,
    verboseOption,
    helpOption,
  ],
  examples: [
    'govplane activate',
    'govplane activate --no-browser',
    'govplane activate --license ./govplane.license',
  ],
  run,
};

export const accountUrl = ACCOUNT_URL;
