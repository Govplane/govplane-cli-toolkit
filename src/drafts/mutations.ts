import {
  CliError, ExitCode, EFFECT_TYPES, validateDraft,
} from '@govplane/cli';
import { findPolicy } from './store.js';
import type { DraftDocument, DraftPolicy, DraftRule } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);

const conflict = (message: string, code: string, details?: string[]): CliError => new CliError(
  message,
  { code, exitCode: ExitCode.Conflict, details },
);

const notFound = (message: string, code: string, details?: string[]): CliError => new CliError(
  message,
  { code, exitCode: ExitCode.Failure, details },
);

const invalid = (message: string, code: string, details?: string[]): CliError => new CliError(
  message,
  { code, exitCode: ExitCode.Compatibility, details },
);

/**
 * Builds a `defaults` block from the command line.
 *
 * Each effect carries its own required payload, and an effect supplied without
 * it is rejected here rather than written and discovered later by `build`.
 */
export interface DefaultsInput {
  effect: string;
  killSwitchService?: string | undefined;
  killSwitchReason?: string | undefined;
  throttleLimit?: string | undefined;
  throttleWindowSeconds?: string | undefined;
  throttleKey?: string | undefined;
  customEffect?: string | undefined;
}

const readNumber = (value: string | undefined, label: string): number => {
  if (value === undefined) {
    throw invalid(`${label} is required.`, 'INVALID_DEFAULT_EFFECT');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw invalid(`${label} must be a number.`, 'INVALID_DEFAULT_EFFECT');
  }
  return parsed;
};

export const buildDefaults = (input: DefaultsInput): DraftPolicy['defaults'] => {
  if (!(EFFECT_TYPES as readonly string[]).includes(input.effect)) {
    throw invalid(
      `Unsupported defaults effect: ${input.effect}`,
      'INVALID_DEFAULT_EFFECT',
      ['', `Supported effects: ${EFFECT_TYPES.join(', ')}`],
    );
  }

  if (input.effect === 'kill_switch') {
    if (!isNonEmptyString(input.killSwitchService)) {
      throw invalid(
        '--kill-switch-service is required when the defaults effect is kill_switch.',
        'MISSING_KILL_SWITCH_SERVICE',
      );
    }
    return {
      effect: 'kill_switch',
      killSwitch: {
        service: input.killSwitchService,
        ...(isNonEmptyString(input.killSwitchReason)
          ? { reason: input.killSwitchReason }
          : {}),
      },
    };
  }

  if (input.effect === 'throttle') {
    if (!isNonEmptyString(input.throttleKey)) {
      throw invalid(
        '--throttle-key is required when the defaults effect is throttle.',
        'INVALID_THROTTLE_DEFAULT',
      );
    }
    return {
      effect: 'throttle',
      throttle: {
        limit: readNumber(input.throttleLimit, '--throttle-limit'),
        windowSeconds: readNumber(input.throttleWindowSeconds, '--throttle-window-seconds'),
        key: input.throttleKey,
      },
    };
  }

  if (input.effect === 'custom') {
    if (!isNonEmptyString(input.customEffect)) {
      throw invalid(
        '--custom-effect is required when the defaults effect is custom.',
        'INVALID_CUSTOM_DEFAULT',
      );
    }
    return { effect: 'custom', customEffect: input.customEffect };
  }

  return { effect: input.effect };
};

export interface AddPolicyInput {
  policyKey: string;
  defaults: DraftPolicy['defaults'];
  activeVersion?: number;
  friendlyName?: string | undefined;
  description?: string | undefined;
}

export const addPolicy = (
  document: DraftDocument,
  input: AddPolicyInput,
): DraftDocument => {
  if (findPolicy(document, input.policyKey) !== undefined) {
    throw conflict(
      `A policy with this key already exists: ${input.policyKey}`,
      'DUPLICATE_POLICY_KEY',
      ['', 'Update it instead with:', `  govplane policies update-policy --policy-key ${input.policyKey}`],
    );
  }

  const policy: DraftPolicy = {
    policyKey: input.policyKey,
    activeVersion: input.activeVersion ?? 1,
    ...(input.friendlyName === undefined ? {} : { friendlyName: input.friendlyName }),
    ...(input.description === undefined ? {} : { description: input.description }),
    defaults: input.defaults,
    rules: [],
  };

  return { ...document, policies: [...document.policies, policy] };
};

/** Reads a policy supplied as a whole JSON object, e.g. from `--policy-file`. */
export const readPolicyPayload = (value: unknown): AddPolicyInput => {
  if (!isRecord(value)) {
    throw invalid('A policy payload must be a JSON object.', 'INVALID_DRAFT_SCHEMA');
  }
  if (!isNonEmptyString(value.policyKey)) {
    throw invalid('The policy payload must include a policyKey.', 'MISSING_POLICY_KEY');
  }
  if (!isRecord(value.defaults) || !isNonEmptyString(value.defaults.effect)) {
    throw invalid('The policy payload must include defaults.effect.', 'INVALID_DEFAULT_EFFECT');
  }

  return {
    policyKey: value.policyKey,
    defaults: value.defaults as unknown as DraftPolicy['defaults'],
    ...(typeof value.activeVersion === 'number' ? { activeVersion: value.activeVersion } : {}),
    ...(isNonEmptyString(value.friendlyName) ? { friendlyName: value.friendlyName } : {}),
    ...(isNonEmptyString(value.description) ? { description: value.description } : {}),
  };
};

export interface UpdatePolicyInput {
  policyKey: string;
  defaults?: DraftPolicy['defaults'] | undefined;
  activeVersion?: number | undefined;
  friendlyName?: string | undefined;
  description?: string | undefined;
}

export const updatePolicy = (
  document: DraftDocument,
  input: UpdatePolicyInput,
): DraftDocument => {
  const existing = findPolicy(document, input.policyKey);
  if (existing === undefined) {
    throw notFound(`Policy not found: ${input.policyKey}`, 'POLICY_NOT_FOUND', [
      '',
      'List the policies in this draft with:',
      '  govplane policies list',
    ]);
  }

  const hasChange = input.defaults !== undefined
    || input.activeVersion !== undefined
    || input.friendlyName !== undefined
    || input.description !== undefined;

  if (!hasChange) {
    throw new CliError('Nothing to update.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: ExitCode.InvalidArguments,
      details: [
        '',
        'Supply at least one of --defaults-effect, --active-version, --friendly-name',
        'or --description.',
      ],
    });
  }

  // policyKey is the identity of a policy, and renaming one would silently
  // detach it from the bundles and simulations that already reference it.
  const updated: DraftPolicy = {
    ...existing,
    ...(input.activeVersion === undefined ? {} : { activeVersion: input.activeVersion }),
    ...(input.friendlyName === undefined ? {} : { friendlyName: input.friendlyName }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.defaults === undefined ? {} : { defaults: input.defaults }),
  };

  return {
    ...document,
    policies: document.policies.map((policy) => (
      policy.policyKey === input.policyKey ? updated : policy
    )),
  };
};

export const removePolicy = (document: DraftDocument, policyKey: string): DraftDocument => {
  if (findPolicy(document, policyKey) === undefined) {
    throw notFound(`Policy not found: ${policyKey}`, 'POLICY_NOT_FOUND');
  }

  return {
    ...document,
    policies: document.policies.filter((policy) => policy.policyKey !== policyKey),
  };
};

/** Validates a rule payload before it is written into a draft. */
export const readRulePayload = (value: unknown): DraftRule => {
  if (!isRecord(value)) {
    throw invalid('A rule payload must be a JSON object.', 'INVALID_DRAFT_SCHEMA');
  }
  if (!isNonEmptyString(value.id)) {
    throw invalid('The rule payload must include an id.', 'MISSING_RULE_ID');
  }
  if (typeof value.priority !== 'number') {
    throw invalid('The rule payload must include a numeric priority.', 'INVALID_RULE_PRIORITY');
  }

  const {target} = value;
  if (!isRecord(target)
    || !isNonEmptyString(target.service)
    || !isNonEmptyString(target.resource)
    || !isNonEmptyString(target.action)) {
    throw invalid(
      'The rule payload must include target.service, target.resource and target.action.',
      'INVALID_RULE_TARGET',
    );
  }

  if (!isRecord(value.effect) || !isNonEmptyString(value.effect.type)) {
    throw invalid('The rule payload must include an effect with a type.', 'INVALID_RULE_EFFECT');
  }

  return value as unknown as DraftRule;
};

export const addRule = (
  document: DraftDocument,
  policyKey: string,
  rule: DraftRule,
): DraftDocument => {
  const policy = findPolicy(document, policyKey);
  if (policy === undefined) {
    throw notFound(`Policy not found: ${policyKey}`, 'POLICY_NOT_FOUND');
  }

  const rules = policy.rules ?? [];
  if (rules.some((existing) => existing.id === rule.id)) {
    throw conflict(
      `A rule with this id already exists in ${policyKey}: ${rule.id}`,
      'DUPLICATE_RULE_ID',
      ['', 'Update it instead with:', `  govplane policies update-rule --policy-key ${policyKey} --rule-id ${rule.id}`],
    );
  }

  return {
    ...document,
    policies: document.policies.map((entry) => (
      entry.policyKey === policyKey ? { ...entry, rules: [...rules, rule] } : entry
    )),
  };
};

export const updateRule = (
  document: DraftDocument,
  policyKey: string,
  ruleId: string,
  rule: DraftRule,
): DraftDocument => {
  const policy = findPolicy(document, policyKey);
  if (policy === undefined) {
    throw notFound(`Policy not found: ${policyKey}`, 'POLICY_NOT_FOUND');
  }

  const rules = policy.rules ?? [];
  if (!rules.some((existing) => existing.id === ruleId)) {
    throw notFound(
      `Rule not found in ${policyKey}: ${ruleId}`,
      'RULE_NOT_FOUND',
      ['', 'List the rules in this policy with:', '  govplane policies list --verbose'],
    );
  }

  // Rules are addressed by id, so a replacement that renames one would leave
  // the caller thinking they had edited a rule that still exists untouched.
  if (rule.id !== ruleId) {
    throw invalid(
      `The replacement rule has id "${rule.id}", but "${ruleId}" was being updated.`,
      'INVALID_RULE_ID',
      ['', 'Give the replacement the same id, or remove and re-add the rule.'],
    );
  }

  return {
    ...document,
    policies: document.policies.map((entry) => (
      entry.policyKey === policyKey
        ? { ...entry, rules: rules.map((existing) => (existing.id === ruleId ? rule : existing)) }
        : entry
    )),
  };
};

/**
 * Validates a draft before it is written.
 *
 * Mutations are checked against the same rules `policies validate` applies, so
 * a command can never leave a draft in a state its own validator would reject.
 *
 * When `previous` is supplied, only problems the edit **introduced** block it.
 * A draft can be legitimately incomplete before the edit — `analyze` writes
 * policies with no `defaults` precisely because inventing an effect nobody
 * chose is not its job — and refusing every edit until the whole document is
 * finished makes it impossible to finish: repairing the first policy would be
 * blocked by the second still being incomplete.
 *
 * `policies validate` and `build` still report and refuse the whole document,
 * so nothing incomplete reaches a bundle.
 */
export const assertValidDraft = (
  document: DraftDocument,
  previous?: DraftDocument,
): void => {
  const { issues } = validateDraft(document);
  if (issues.errors.length === 0) {
    return;
  }

  const problem = (issue: { path: string; code: string }): string => `${issue.path}|${issue.code}`;
  const existing = previous === undefined
    ? new Set<string>()
    : new Set(validateDraft(previous).issues.errors.map(problem));

  const introduced = issues.errors.filter((issue) => !existing.has(problem(issue)));
  if (introduced.length === 0) {
    return;
  }

  throw new CliError('The resulting draft would not be valid.', {
    code: 'INVALID_DRAFT_SCHEMA',
    exitCode: ExitCode.Compatibility,
    details: [
      '',
      ...introduced.map((issue) => `  ${issue.path}: ${issue.message}`),
    ],
  });
};
