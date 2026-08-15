import type { ActivationStatus } from './types.js';

/**
 * Days remaining at which the one-line reminder becomes a short block.
 *
 * Six remaining days is day 24 of a 30-day grace period, which is where the
 * reminder stops being background noise and starts needing attention.
 */
export const NOTICE_THRESHOLD_DAYS = 6;

export const ACCOUNT_URL = 'https://govplane.com/account';

const plural = (count: number, singular: string): string => (
  count === 1 ? `1 ${singular}` : `${count} ${singular}s`
);

/** The single line shown early in the grace period. */
export const graceReminder = (status: ActivationStatus): string => (
  `Activation required in ${plural(status.daysRemaining, 'day')} — `
  + 'free, no email needed: govplane activate'
);

/** The short block shown as the grace period runs out. */
export const graceNotice = (status: ActivationStatus): string[] => [
  `Activation required in ${plural(status.daysRemaining, 'day')}.`,
  '',
  '  Activation is free and takes about 30 seconds.',
  '  An email address is optional.',
  '  Run: govplane activate',
];

/**
 * The message shown when the grace period has run out.
 *
 * The closing paragraph is not optional. Someone hitting this wall needs to know
 * immediately that nothing in production has stopped working.
 */
export const activationRequired = (command: string): string[] => [
  '',
  'Activation is free and takes about 30 seconds. An email address is optional.',
  '',
  '  Run:  govplane activate',
  '',
  'Once activated, the toolkit works offline permanently.',
  '',
  'Your policies keep working: the Govplane SDK, govplane validate and',
  `govplane inspect never require activation, and neither does anything that has`,
  `already been built. Only ${command} and the other toolkit commands are affected.`,
];

/** Explains a licence that exists but cannot be used. */
export const unusableLicense = (status: ActivationStatus): string[] => {
  if (status.problem === undefined) {
    return [];
  }
  return [
    'The licence on this machine could not be used:',
    `  ${status.problemReason ?? status.problem}`,
    '',
    'Run "govplane activate" to replace it, or "govplane license remove" to delete it.',
  ];
};

export const renewalNudge = (): string => (
  'Your licence is due for renewal — re-run "govplane activate" when convenient.'
);
