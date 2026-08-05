import type { RuntimeBundle, RuntimePolicy, RuntimeRule } from '@govplane/cli';
import type { DraftDocument } from '../drafts/types.js';

/**
 * Compilation of a draft into a runtime bundle.
 *
 * Deterministic by construction: the same draft and the same scope always
 * produce the same canonical bytes, and therefore the same checksum. That is
 * what makes a build reproducible and a checksum meaningful.
 */

export const DEFAULT_ENV = 'prod';

export interface CompileInput {
  draft: DraftDocument;
  generatedAt: string;
  bundleVersion: number;
  env?: string | undefined;
  orgId?: string | undefined;
  projectId?: string | undefined;
}

/**
 * Rule status as the runtime reads it.
 *
 * The runtime engine only evaluates a rule whose status is exactly `"active"`,
 * so a compiled rule that omits it would silently never fire. Compilation
 * therefore always writes the field, defaulting to `active` — the intent behind
 * a draft rule that never mentions status.
 */
const compileRule = (rule: RuntimeRule): RuntimeRule => ({
  ...rule,
  status: rule.status === 'disabled' ? 'disabled' : 'active',
});

const comparePolicies = (left: RuntimePolicy, right: RuntimePolicy): number => (
  String(left.policyKey).localeCompare(String(right.policyKey))
);

const compareRules = (left: RuntimeRule, right: RuntimeRule): number => {
  const leftPriority = typeof left.priority === 'number' ? left.priority : 0;
  const rightPriority = typeof right.priority === 'number' ? right.priority : 0;
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  return String(left.id).localeCompare(String(right.id));
};

/**
 * Maps a draft policy to its runtime shape.
 *
 * Only runtime-relevant fields survive. Authoring metadata a draft may carry —
 * a friendly name, a description, the target `analyze` discovered — is dropped,
 * because it would otherwise land inside the signed canonical payload without
 * ever being read by the runtime.
 */
const compilePolicy = (policy: RuntimePolicy): RuntimePolicy => ({
  policyKey: policy.policyKey,
  activeVersion: policy.activeVersion,
  defaults: policy.defaults,
  rules: [...(policy.rules ?? [])].map(compileRule).sort(compareRules),
});

/**
 * Compiles a runtime bundle from a draft.
 *
 * `orgId` and `projectId` are omitted entirely when not supplied, rather than
 * written as empty strings: the canonical projection then leaves them out too,
 * which is what the local-first profile expects.
 */
export const compileBundle = (input: CompileInput): RuntimeBundle => {
  const policies = [...input.draft.policies].map(compilePolicy).sort(comparePolicies);

  return {
    schemaVersion: 1,
    ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    env: input.env ?? input.draft.env ?? DEFAULT_ENV,
    generatedAt: input.generatedAt,
    bundleVersion: input.bundleVersion,
    policies,
  } as RuntimeBundle;
};

export interface BundleStats {
  policies: number;
  rules: number;
}

export const bundleStats = (bundle: RuntimeBundle): BundleStats => ({
  policies: bundle.policies.length,
  rules: bundle.policies.reduce((total, policy) => total + policy.rules.length, 0),
});
