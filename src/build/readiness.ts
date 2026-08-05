import { EFFECT_TYPES, type ValidationIssue } from '@govplane/cli';
import type { DraftDocument } from '../drafts/types.js';

/**
 * Build readiness.
 *
 * `policies validate` answers "is this draft well formed?". This answers a
 * stricter question: "is there enough here to compile a runtime bundle?" A
 * draft can legitimately be half-finished — that is what analyze produces — but
 * building one would emit a bundle whose rules do nothing.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);

const KNOWN_EFFECTS = new Set<string>(EFFECT_TYPES);

const issue = (code: string, path: string, message: string): ValidationIssue => ({
  code, path, message,
});

const checkDefaults = (defaults: unknown, path: string): ValidationIssue[] => {
  if (!isRecord(defaults)) {
    return [issue(
      'INVALID_DEFAULT_EFFECT',
      `${path}.defaults`,
      'defaults is required: a policy needs an effect for when no rule matches.',
    )];
  }

  const { effect } = defaults;
  if (!isNonEmptyString(effect) || !KNOWN_EFFECTS.has(effect)) {
    return [issue(
      'INVALID_DEFAULT_EFFECT',
      `${path}.defaults.effect`,
      `defaults.effect must be one of: ${EFFECT_TYPES.join(', ')}.`,
    )];
  }

  if (effect === 'kill_switch') {
    const { killSwitch } = defaults;
    if (!isRecord(killSwitch) || !isNonEmptyString(killSwitch.service)) {
      return [issue(
        'MISSING_KILL_SWITCH_SERVICE',
        `${path}.defaults.killSwitch.service`,
        'defaults.killSwitch.service is required when the default effect is kill_switch.',
      )];
    }
  }

  if (effect === 'throttle') {
    const { throttle } = defaults;
    if (!isRecord(throttle)
      || typeof throttle.limit !== 'number'
      || typeof throttle.windowSeconds !== 'number'
      || !isNonEmptyString(throttle.key)) {
      return [issue(
        'INVALID_THROTTLE_DEFAULT',
        `${path}.defaults.throttle`,
        'defaults.throttle requires numeric limit and windowSeconds, plus a key.',
      )];
    }
  }

  if (effect === 'custom' && !isNonEmptyString(defaults.customEffect)) {
    return [issue(
      'INVALID_CUSTOM_DEFAULT',
      `${path}.defaults.customEffect`,
      'defaults.customEffect is required when the default effect is custom.',
    )];
  }

  return [];
};

const checkRule = (rule: unknown, path: string): ValidationIssue[] => {
  if (!isRecord(rule)) {
    return [issue('INVALID_RULE', path, 'A rule must be an object.')];
  }

  const problems: ValidationIssue[] = [];

  if (!isNonEmptyString(rule.id)) {
    problems.push(issue('MISSING_RULE_ID', `${path}.id`, 'id is required.'));
  }

  if (typeof rule.priority !== 'number' || Number.isNaN(rule.priority)) {
    problems.push(issue(
      'INVALID_RULE_PRIORITY',
      `${path}.priority`,
      'priority is required and must be a number: it decides which rule wins.',
    ));
  }

  // status is optional in a draft and defaulted to "active" at compile time,
  // but a value that is neither active nor disabled is a mistake worth
  // catching, because the runtime would silently skip the rule.
  if (rule.status !== undefined && rule.status !== 'active' && rule.status !== 'disabled') {
    problems.push(issue(
      'INVALID_RULE_STATUS',
      `${path}.status`,
      'status must be "active" or "disabled".',
    ));
  }

  const { target } = rule;
  if (!isRecord(target)) {
    problems.push(issue('INVALID_RULE_TARGET', `${path}.target`, 'target is required.'));
  } else {
    (['service', 'resource', 'action'] as const).forEach((field) => {
      if (!isNonEmptyString(target[field])) {
        problems.push(issue(
          'INVALID_RULE_TARGET',
          `${path}.target.${field}`,
          `target.${field} is required.`,
        ));
      }
    });
  }

  const { effect } = rule;
  if (!isRecord(effect) || !isNonEmptyString(effect.type)) {
    problems.push(issue(
      'INVALID_RULE_EFFECT',
      `${path}.effect`,
      'effect is required and must include a type.',
    ));
  } else if (effect.type === 'custom' && !isNonEmptyString(effect.value)) {
    problems.push(issue(
      'INVALID_RULE_EFFECT',
      `${path}.effect.value`,
      'A custom effect requires a non-empty value.',
    ));
  }

  return problems;
};

/**
 * Reports every reason a draft cannot be compiled.
 *
 * All problems are collected rather than thrown one at a time, so a developer
 * fixes a draft in one pass instead of rebuilding after each error.
 */
export const checkBuildReadiness = (draft: DraftDocument): ValidationIssue[] => {
  const problems: ValidationIssue[] = [];
  const seenKeys = new Set<string>();

  draft.policies.forEach((policy, index) => {
    const path = `$.policies[${index}]`;

    if (!isNonEmptyString(policy.policyKey)) {
      problems.push(issue('MISSING_POLICY_KEY', `${path}.policyKey`, 'policyKey is required.'));
    } else if (seenKeys.has(policy.policyKey)) {
      problems.push(issue(
        'DUPLICATE_POLICY_KEY',
        `${path}.policyKey`,
        `Duplicate policy key: "${policy.policyKey}"`,
      ));
    } else {
      seenKeys.add(policy.policyKey);
    }

    if (typeof policy.activeVersion !== 'number') {
      problems.push(issue(
        'INVALID_ACTIVE_VERSION',
        `${path}.activeVersion`,
        'activeVersion is required and must be a number.',
      ));
    }

    problems.push(...checkDefaults(policy.defaults, path));

    if (!Array.isArray(policy.rules)) {
      problems.push(issue('RULES_NOT_ARRAY', `${path}.rules`, 'rules must be an array.'));
      return;
    }

    const seenRuleIds = new Set<string>();
    policy.rules.forEach((rule, ruleIndex) => {
      const rulePath = `${path}.rules[${ruleIndex}]`;
      problems.push(...checkRule(rule, rulePath));

      if (isRecord(rule) && isNonEmptyString(rule.id)) {
        if (seenRuleIds.has(rule.id)) {
          problems.push(issue(
            'DUPLICATE_RULE_ID',
            `${rulePath}.id`,
            `Duplicate rule id: "${rule.id}"`,
          ));
        }
        seenRuleIds.add(rule.id);
      }
    });
  });

  return problems;
};
