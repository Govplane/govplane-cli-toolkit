import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  atomicWriteFile, CliError, ExitCode, parseJson, readTextFile, stringifyJson,
} from '@govplane/cli';
import { friendlyName, targetIdentity } from './consolidate.js';
import type { ComparedDiscovery } from './compare.js';
import type { TargetComponent } from './detect.js';

/**
 * The draft document `analyze` produces.
 *
 * The shape follows the spec: a `drafts[]` array of discoveries, each carrying
 * what was found in the code and a **policy shell** with no rules. The analyzer
 * never invents rules, effects, conditions or priorities — the developer adds
 * those, and `build` compiles the result.
 */

export const ANALYZE_DRAFT_SCHEMA_VERSION = '1.0';

export interface AnalyzeDraftEntry {
  id: string;
  status: string;
  confidence: string;
  target: Record<TargetComponent, string>;
  availableContext: { key: string; source?: string; type?: string }[];
  suggestedPolicy: {
    policyKey: string;
    friendlyName: string;
    target: Record<TargetComponent, string>;
    rules: never[];
  };
  sources: { file: string; line: number; column: number }[];
  serviceExpression?: unknown;
  resourceExpression?: unknown;
  actionExpression?: unknown;
  matchedPolicies?: string[];
}

export interface AnalyzeDraftDocument {
  schemaVersion: string;
  generatedAt: string;
  drafts: AnalyzeDraftEntry[];
}

const COMPONENTS: TargetComponent[] = ['service', 'resource', 'action'];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const toDraftEntry = (discovery: ComparedDiscovery): AnalyzeDraftEntry => {
  const expressions: Record<string, unknown> = {};
  COMPONENTS.forEach((component) => {
    const expression = discovery.expressions[component];
    if (expression !== undefined) {
      expressions[`${component}Expression`] = expression;
    }
  });

  return {
    id: discovery.id,
    status: discovery.status,
    confidence: discovery.confidence,
    target: discovery.target,
    ...expressions,
    availableContext: discovery.availableContext,
    suggestedPolicy: {
      policyKey: discovery.id,
      friendlyName: friendlyName(discovery.id),
      target: discovery.target,
      // Deliberately empty. Discovering where policy is evaluated is not the
      // same as knowing what it should decide, and guessing would put rules
      // nobody wrote into a governance artifact.
      rules: [],
    },
    ...(discovery.matchedPolicies.length > 0
      ? { matchedPolicies: discovery.matchedPolicies }
      : {}),
    sources: discovery.sources.map((location) => ({
      file: location.file,
      line: location.line,
      column: location.column,
    })),
  };
};

export const buildDraftDocument = (
  discoveries: ComparedDiscovery[],
  generatedAt: string,
): AnalyzeDraftDocument => ({
  schemaVersion: ANALYZE_DRAFT_SCHEMA_VERSION,
  generatedAt,
  drafts: discoveries.map(toDraftEntry),
});

export type ExistingShape = 'analyze' | 'build-ready' | 'unrecognised';

export interface ExistingDraft {
  path: string;
  shape: ExistingShape;
  document: Record<string, unknown>;
  /** Whether a developer has already put work into this file. */
  hasAuthoredContent: boolean;
}

const countRules = (policies: unknown[]): number => policies.reduce<number>(
  (total, policy) => total
    + (isRecord(policy) && Array.isArray(policy.rules) ? policy.rules.length : 0),
  0,
);

export const readExistingDraft = (path: string): ExistingDraft | null => {
  if (!existsSync(path)) {
    return null;
  }

  const parsed = parseJson(readTextFile(path));
  if (!parsed.ok || !isRecord(parsed.value)) {
    return {
      path,
      shape: 'unrecognised',
      document: {},
      hasAuthoredContent: true,
    };
  }

  const document = parsed.value;

  if (Array.isArray(document.policies)) {
    return {
      path,
      shape: 'build-ready',
      document,
      // A build-ready draft only exists because someone ran `policies` on it.
      hasAuthoredContent: true,
    };
  }

  if (Array.isArray(document.drafts)) {
    return {
      path,
      shape: 'analyze',
      document,
      hasAuthoredContent: countRules(
        document.drafts.map((entry) => (isRecord(entry) ? entry.suggestedPolicy : null)),
      ) > 0,
    };
  }

  return {
    path, shape: 'unrecognised', document, hasAuthoredContent: true,
  };
};

export type GitState = 'clean' | 'modified' | 'unknown';

/**
 * Whether the draft file has uncommitted changes.
 *
 * The spec asks for a warning when the existing draft carries uncommitted work,
 * because overwriting it would destroy something with no other copy. Projects
 * that are not in a repository, or have no git available, report `unknown` and
 * are simply not warned on this basis.
 */
export const draftGitState = (path: string): GitState => {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--', path], {
      cwd: dirname(path),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return output.trim() === '' ? 'clean' : 'modified';
  } catch {
    return 'unknown';
  }
};

/** Every target identity an existing document already knows about. */
export const knownIdentities = (existing: ExistingDraft): Set<string> => {
  const identities = new Set<string>();

  const add = (value: unknown): void => {
    if (!isRecord(value)) {
      return;
    }
    const parts = COMPONENTS.map((component) => value[component]);
    if (!parts.every((part) => typeof part === 'string' && part !== '')) {
      return;
    }
    // Encoded by the same function that encodes a discovery, so the two can
    // never disagree about what makes two targets the same target.
    identities.add(targetIdentity({
      service: parts[0] as string,
      resource: parts[1] as string,
      action: parts[2] as string,
    }));
  };

  if (existing.shape === 'analyze' && Array.isArray(existing.document.drafts)) {
    existing.document.drafts.forEach((entry) => {
      if (isRecord(entry)) {
        add(entry.target);
      }
    });
  }

  if (existing.shape === 'build-ready' && Array.isArray(existing.document.policies)) {
    existing.document.policies.forEach((policy) => {
      if (!isRecord(policy)) {
        return;
      }
      add(policy.discoveredTarget);
      if (Array.isArray(policy.rules)) {
        policy.rules.forEach((rule) => {
          if (isRecord(rule)) {
            add(rule.target);
          }
        });
      }
    });
  }

  return identities;
};

export interface MergeResult {
  document: Record<string, unknown>;
  added: ComparedDiscovery[];
  /** Discoveries the existing document already accounted for. */
  skipped: ComparedDiscovery[];
}

/**
 * Adds new discoveries to an existing draft without touching what is there.
 *
 * Merging appends only targets the document does not already know about, and
 * never rewrites an entry a developer may have edited. The result keeps the
 * shape it had: appending analyze entries to a document someone has been
 * authoring with `govplane policies` would leave a file in two shapes at once.
 */
export const mergeIntoExisting = (
  existing: ExistingDraft,
  discoveries: ComparedDiscovery[],
  generatedAt: string,
): MergeResult => {
  const known = knownIdentities(existing);
  const added = discoveries.filter(
    (discovery) => !known.has(targetIdentity(discovery.target)),
  );
  const skipped = discoveries.filter(
    (discovery) => known.has(targetIdentity(discovery.target)),
  );

  if (existing.shape === 'unrecognised') {
    throw new CliError(`The existing draft file could not be read: ${existing.path}`, {
      code: 'INVALID_DRAFT_SCHEMA',
      exitCode: ExitCode.Compatibility,
      details: [
        '',
        'Merging needs a draft file this command can understand.',
        'Fix the file, or overwrite it with --force.',
      ],
    });
  }

  if (existing.shape === 'build-ready') {
    const policies = Array.isArray(existing.document.policies)
      ? existing.document.policies
      : [];
    const appended = added.map((discovery) => ({
      policyKey: discovery.id,
      activeVersion: 1,
      friendlyName: friendlyName(discovery.id),
      discoveredTarget: discovery.target,
      rules: [],
    }));

    return {
      document: { ...existing.document, generatedAt, policies: [...policies, ...appended] },
      added,
      skipped,
    };
  }

  const drafts = Array.isArray(existing.document.drafts) ? existing.document.drafts : [];
  return {
    document: {
      ...existing.document,
      generatedAt,
      drafts: [...drafts, ...added.map(toDraftEntry)],
    },
    added,
    skipped,
  };
};

export const writeDraft = (path: string, document: unknown): void => {
  try {
    atomicWriteFile(path, stringifyJson(document));
  } catch (error) {
    throw new CliError(`The draft file could not be written: ${path}`, {
      code: 'DRAFT_WRITE_FAILED',
      exitCode: ExitCode.WriteError,
      cause: error,
    });
  }
};
