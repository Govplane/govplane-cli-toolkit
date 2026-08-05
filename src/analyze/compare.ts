import {
  CliError, ExitCode, parseJson, readTextFile, validateBundle,
  type RuntimeBundle, type RuntimePolicy, type RuntimeRule, type ValidationIssue,
} from '@govplane/cli';
import { existsSync } from 'node:fs';
import type { TargetComponent } from './detect.js';
import type { Discovery } from './consolidate.js';

/**
 * Bundle comparison.
 *
 * Discovered targets are checked against the policies that already exist, so
 * `analyze` reports what is genuinely missing rather than proposing a duplicate
 * of a policy the project already has.
 */

export type CoverageStatus = 'covered' | 'partially-covered' | 'missing' | 'ambiguous';

export interface LoadedBundle {
  path: string;
  bundle: RuntimeBundle;
}

export interface BundleValidationFailure {
  path: string;
  errors: ValidationIssue[];
}

interface RuleTarget {
  policyKey: string;
  ruleId: string;
  bundlePath: string;
  target: Record<TargetComponent, string>;
}

const COMPONENTS: TargetComponent[] = ['service', 'resource', 'action'];

/**
 * Loads and validates the bundles supplied for comparison.
 *
 * Every bundle must pass the same structural validation the remote path
 * enforces when it materialises a bundle. A bundle that fails it cannot be
 * compared against meaningfully, so the spec requires stopping before
 * comparison rather than reporting coverage derived from a broken document.
 */
export const loadComparisonBundles = (paths: string[]): {
  bundles: LoadedBundle[];
  failures: BundleValidationFailure[];
} => {
  const bundles: LoadedBundle[] = [];
  const failures: BundleValidationFailure[] = [];

  paths.forEach((path) => {
    if (!existsSync(path)) {
      throw new CliError(`Bundle not found: ${path}`, {
        code: 'BUNDLE_FILE_NOT_FOUND',
        exitCode: ExitCode.FileError,
        details: ['', 'Bundle paths given with --bundle are resolved from the working folder.'],
      });
    }

    const parsed = parseJson(readTextFile(path));
    if (!parsed.ok) {
      failures.push({
        path,
        errors: [{ code: 'INVALID_JSON', path: '$', message: parsed.message }],
      });
      return;
    }

    // The default profile requires orgId, projectId and env, which is exactly
    // the parity contract the spec sets out for comparison inputs.
    const validation = validateBundle(parsed.value);
    if (validation.issues.errors.length > 0) {
      failures.push({ path, errors: validation.issues.errors });
      return;
    }

    bundles.push({ path, bundle: parsed.value as RuntimeBundle });
  });

  return { bundles, failures };
};

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() !== '' ? value : undefined
);

/**
 * Flattens every rule target in every bundle, in the deterministic order the
 * remote compiler uses: policies by `policyKey` ascending, rules by `priority`
 * descending then `id` ascending.
 */
export const ruleTargets = (bundles: LoadedBundle[]): RuleTarget[] => {
  const targets: RuleTarget[] = [];

  bundles.forEach(({ path, bundle }) => {
    const policies = Array.isArray(bundle.policies) ? [...bundle.policies] : [];

    policies
      .sort((left, right) => String(left.policyKey).localeCompare(String(right.policyKey)))
      .forEach((policy: RuntimePolicy) => {
        const rules = Array.isArray(policy.rules) ? [...policy.rules] : [];

        rules
          .sort((left, right) => {
            const leftPriority = typeof left.priority === 'number' ? left.priority : 0;
            const rightPriority = typeof right.priority === 'number' ? right.priority : 0;
            if (leftPriority !== rightPriority) {
              return rightPriority - leftPriority;
            }
            return String(left.id).localeCompare(String(right.id));
          })
          .forEach((rule: RuntimeRule) => {
            const target = rule.target as unknown as Record<string, unknown> | undefined;
            if (target === undefined) {
              return;
            }
            const service = asString(target.service);
            const resource = asString(target.resource);
            const action = asString(target.action);
            if (service === undefined || resource === undefined || action === undefined) {
              return;
            }
            targets.push({
              policyKey: String(policy.policyKey),
              ruleId: String(rule.id),
              bundlePath: path,
              target: { service, resource, action },
            });
          });
      });
  });

  return targets;
};

/**
 * Whether one component matches.
 *
 * `*` matches anything on either side. On the bundle side it is a deliberate
 * wildcard. On the discovery side it means the analyzer could not resolve the
 * value, and claiming a mismatch would be asserting knowledge it does not have.
 */
const componentMatches = (ruleValue: string, discovered: string): boolean => (
  ruleValue === discovered || ruleValue === '*' || discovered === '*'
);

const matchCount = (
  rule: RuleTarget,
  target: Record<TargetComponent, string>,
): number => COMPONENTS.filter(
  (component) => componentMatches(rule.target[component], target[component]),
).length;

export interface Coverage {
  status: CoverageStatus;
  /** Policies that already govern this target, or part of it. */
  matchedPolicies: string[];
}

/**
 * Classifies one discovered target against the existing rule targets.
 *
 * - **covered** — exactly one policy has a rule for this target.
 * - **ambiguous** — more than one policy does, so which should own it is a
 *   decision for the developer rather than the analyzer.
 * - **partially-covered** — a policy governs the same service and part of the
 *   rest, so a new policy would probably overlap it.
 * - **missing** — nothing governs it.
 */
export const classify = (
  target: Record<TargetComponent, string>,
  targets: RuleTarget[],
): Coverage => {
  const full = targets.filter((rule) => matchCount(rule, target) === COMPONENTS.length);

  if (full.length > 0) {
    const policies = [...new Set(full.map((rule) => rule.policyKey))].sort();
    return {
      status: policies.length > 1 ? 'ambiguous' : 'covered',
      matchedPolicies: policies,
    };
  }

  // A rule in another service says nothing about this one, so a partial match
  // must at least agree on the service.
  const partial = targets.filter((rule) => (
    componentMatches(rule.target.service, target.service) && matchCount(rule, target) >= 2
  ));

  if (partial.length > 0) {
    return {
      status: 'partially-covered',
      matchedPolicies: [...new Set(partial.map((rule) => rule.policyKey))].sort(),
    };
  }

  return { status: 'missing', matchedPolicies: [] };
};

export interface ComparedDiscovery extends Discovery {
  status: CoverageStatus;
  matchedPolicies: string[];
}

export const compareDiscoveries = (
  discoveries: Discovery[],
  bundles: LoadedBundle[],
): ComparedDiscovery[] => {
  // With no bundles to compare against there is nothing to be covered by, and
  // every discovery is reported as missing.
  const targets = ruleTargets(bundles);

  return discoveries.map((discovery) => {
    const coverage = classify(discovery.target, targets);
    return { ...discovery, status: coverage.status, matchedPolicies: coverage.matchedPolicies };
  });
};
