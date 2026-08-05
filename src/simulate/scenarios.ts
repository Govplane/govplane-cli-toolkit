import { CliError, ExitCode } from '@govplane/cli';

/**
 * Scenarios and suites.
 *
 * A scenario is one policy evaluation: a target, a context, and optionally what
 * the developer expects to happen. A suite is a list of them.
 */

export interface Target {
  service: string;
  resource: string;
  action: string;
}

export interface Expectation {
  decision?: string;
  policyKey?: string;
  ruleId?: string;
  reason?: string;
  value?: string;
}

export interface Scenario {
  name: string;
  description?: string;
  target: Target;
  context: Record<string, unknown>;
  expected?: Expectation;
}

export interface Suite {
  name: string;
  scenarios: Scenario[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);

const invalid = (message: string, details?: string[]): CliError => new CliError(message, {
  code: 'INVALID_SCENARIO',
  exitCode: ExitCode.Compatibility,
  details,
});

export const readTarget = (value: unknown, where: string): Target => {
  if (!isRecord(value)) {
    throw invalid(`${where}: target is required.`);
  }

  const missing = (['service', 'resource', 'action'] as const)
    .filter((field) => !isNonEmptyString(value[field]));

  if (missing.length > 0) {
    throw invalid(`${where}: the target is incomplete.`, [
      '',
      `Missing: ${missing.join(', ')}`,
      '',
      'A target needs all three of service, resource and action.',
    ]);
  }

  return {
    service: value.service as string,
    resource: value.resource as string,
    action: value.action as string,
  };
};

/**
 * Reads an expectation, accepting the legacy spellings some scenarios use.
 *
 * `effect` and `ruleKey` predate `decision` and `ruleId`. Accepting them costs
 * two lines and saves rewriting scenario files that already work.
 */
export const readExpectation = (value: unknown, where: string): Expectation | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalid(`${where}: expected must be an object.`);
  }

  const decision = value.decision ?? value.effect;
  const ruleId = value.ruleId ?? value.ruleKey;

  const expectation: Expectation = {
    ...(isNonEmptyString(decision) ? { decision } : {}),
    ...(isNonEmptyString(value.policyKey) ? { policyKey: value.policyKey } : {}),
    ...(isNonEmptyString(ruleId) ? { ruleId } : {}),
    ...(isNonEmptyString(value.reason) ? { reason: value.reason } : {}),
    ...(isNonEmptyString(value.value) ? { value: value.value } : {}),
  };

  if (Object.keys(expectation).length === 0) {
    throw invalid(`${where}: expected is present but declares no assertions.`, [
      '',
      'Supported assertions: decision, policyKey, ruleId, reason, value.',
    ]);
  }

  return expectation;
};

export const readScenario = (value: unknown, where: string, fallbackName: string): Scenario => {
  if (!isRecord(value)) {
    throw invalid(`${where}: a scenario must be an object.`);
  }

  const context = value.context === undefined ? {} : value.context;
  if (!isRecord(context)) {
    throw invalid(`${where}: context must be an object.`);
  }

  const expected = readExpectation(value.expected, where);

  return {
    name: isNonEmptyString(value.name) ? value.name : fallbackName,
    ...(isNonEmptyString(value.description) ? { description: value.description } : {}),
    target: readTarget(value.target, where),
    context,
    ...(expected === undefined ? {} : { expected }),
  };
};

export const readSuite = (value: unknown, path: string): Suite => {
  if (!isRecord(value)) {
    throw invalid(`${path}: a suite must be a JSON object.`);
  }

  const { scenarios } = value;
  if (!Array.isArray(scenarios)) {
    throw invalid(`${path}: a suite must contain a "scenarios" array.`);
  }

  if (scenarios.length === 0) {
    throw invalid(`${path}: the suite contains no scenarios.`);
  }

  return {
    name: isNonEmptyString(value.name) ? value.name : 'Simulation suite',
    scenarios: scenarios.map(
      (scenario, index) => readScenario(scenario, `${path} scenario ${index + 1}`, `Scenario ${index + 1}`),
    ),
  };
};

export interface ExpectationResult {
  passed: boolean;
  mismatches: { field: string; expected: string; actual: string }[];
}

/**
 * Compares a decision against what a scenario expected.
 *
 * Only declared fields are checked: a scenario that asserts a decision says
 * nothing about which rule produced it, and should not start failing because a
 * rule was renamed.
 */
export const checkExpectation = (
  expectation: Expectation | undefined,
  decision: Record<string, unknown>,
): ExpectationResult => {
  if (expectation === undefined) {
    return { passed: true, mismatches: [] };
  }

  const mismatches: ExpectationResult['mismatches'] = [];
  const compare = (field: keyof Expectation): void => {
    const expected = expectation[field];
    if (expected === undefined) {
      return;
    }
    const actual = decision[field];
    if (actual !== expected) {
      mismatches.push({
        field,
        expected,
        actual: actual === undefined ? '(not set)' : String(actual),
      });
    }
  };

  (['decision', 'reason', 'policyKey', 'ruleId', 'value'] as const).forEach(compare);

  return { passed: mismatches.length === 0, mismatches };
};
