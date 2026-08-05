import { CliError, ExitCode, type CommandContext } from '@govplane/cli';
import { isContinuousIntegration, resolveActivation } from './grace.js';
import {
  activationRequired, graceNotice, graceReminder, NOTICE_THRESHOLD_DAYS, renewalNudge,
  unusableLicense,
} from './messages.js';
import type { ActivationStatus } from './types.js';

/**
 * Prints the activation reminder at the appropriate volume.
 *
 * Reminders are suppressed by `--quiet` and never appear in JSON output, where
 * the status travels as a field on the payload instead of as prose.
 */
export const reportActivation = (
  context: CommandContext,
  status: ActivationStatus,
): void => {
  const { reporter } = context;
  if (reporter.quiet || reporter.format !== 'text') {
    return;
  }

  if (status.state === 'activated') {
    if (status.renewalDue) {
      reporter.line(reporter.muted(renewalNudge()));
      reporter.line();
    }
    return;
  }

  if (status.problem !== undefined) {
    reporter.errorLines(unusableLicense(status));
    reporter.error('');
  }

  // In CI the notice is shown from day zero. A pipeline that only learns about
  // activation when it starts failing on day 31 is a bad surprise; one that has
  // been told every run is not.
  if (isContinuousIntegration(context.env)
    || status.daysRemaining <= NOTICE_THRESHOLD_DAYS) {
    reporter.lines(graceNotice(status));
    reporter.line();
    return;
  }

  reporter.line(reporter.muted(graceReminder(status)));
  reporter.line();
};

/**
 * Gate applied by every CLI Toolkit command.
 *
 * Resolves the activation state, reports it at the right volume, and stops the
 * command only when the grace period has run out. Defined once so that every
 * gated command behaves identically.
 *
 * Returns the status so callers can attach it to structured output.
 */
export const requireActivation = (
  context: CommandContext,
  commandName: string,
): ActivationStatus => {
  const status = resolveActivation({ now: context.now, env: context.env });

  if (status.state === 'grace_expired') {
    throw new CliError(`The ${commandName} command requires activation.`, {
      code: 'ACTIVATION_REQUIRED',
      exitCode: ExitCode.ToolkitUnavailable,
      details: [
        ...(status.problem === undefined ? [] : ['', ...unusableLicense(status)]),
        ...activationRequired(commandName),
      ],
    });
  }

  reportActivation(context, status);
  return status;
};

/** The `activation` field attached to structured command output. */
export const activationSummary = (status: ActivationStatus): Record<string, unknown> => ({
  state: status.state,
  daysRemaining: status.daysRemaining,
  ...(status.problem === undefined ? {} : { problem: status.problem }),
});
