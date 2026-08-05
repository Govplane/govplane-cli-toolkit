import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  atomicWriteFile, CliError, ExitCode, parseJson, readTextFile, stringifyJson,
  type ProjectConfig,
} from '@govplane/cli';
import { resolve } from 'node:path';
import {
  DRAFT_SCHEMA_VERSION, type DraftDocument, type DraftPolicy, type DraftShape, type LoadedDraft,
} from './types.js';

export const DEFAULT_DRAFT_FILE = 'policy-drafts.json';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);

/**
 * Resolves which draft file to work on:
 *
 *   1. `--draft <path>` (relative paths resolve from the working folder)
 *   2. `draft.path` in `govplane.config.json`
 *   3. `policy-drafts.json` in the working folder
 */
export const resolveDraftFile = (
  workingFolder: string,
  config: ProjectConfig,
  explicit?: string,
): string => {
  if (explicit !== undefined) {
    return resolve(workingFolder, explicit);
  }
  return resolve(workingFolder, config.draft?.path ?? DEFAULT_DRAFT_FILE);
};

/** An empty, valid, build-ready draft document. */
export const emptyDraft = (generatedAt: string, env?: string): DraftDocument => ({
  schemaVersion: DRAFT_SCHEMA_VERSION,
  generatedAt,
  ...(env === undefined ? {} : { env }),
  policies: [],
});

/**
 * Deterministic ordering, applied on every write.
 *
 * Policies ascend by key and rules descend by priority, then ascend by id —
 * the same order the control plane compiles bundles in. Keeping drafts in that
 * order means a diff shows what actually changed rather than where entries
 * happened to land.
 */
export const sortDraft = (document: DraftDocument): DraftDocument => ({
  ...document,
  policies: [...document.policies]
    .sort((left, right) => String(left.policyKey).localeCompare(String(right.policyKey)))
    .map((policy) => ({
      ...policy,
      rules: [...(policy.rules ?? [])].sort((left, right) => {
        const leftPriority = typeof left.priority === 'number' ? left.priority : 0;
        const rightPriority = typeof right.priority === 'number' ? right.priority : 0;
        if (leftPriority !== rightPriority) {
          return rightPriority - leftPriority;
        }
        return String(left.id).localeCompare(String(right.id));
      }),
    })),
});

/**
 * Converts an analyze-generated draft entry into a build-ready policy.
 *
 * `analyze` discovers targets and suggests a policy shell; it never invents
 * rules or effects. The conversion therefore carries across what was found and
 * leaves `defaults` unset when analyze did not supply one, so that
 * `policies validate` reports an incomplete policy rather than inventing an
 * effect the developer never chose.
 */
const fromAnalyzeEntry = (entry: unknown, index: number): DraftPolicy => {
  const draft = isRecord(entry) ? entry : {};
  const suggested = isRecord(draft.suggestedPolicy) ? draft.suggestedPolicy : {};
  const target = isRecord(draft.target) ? draft.target : {};

  const policyKey = isNonEmptyString(suggested.policyKey)
    ? suggested.policyKey
    : (isNonEmptyString(draft.id) ? draft.id : `discovered-policy-${index + 1}`);

  const rules = Array.isArray(suggested.rules) ? suggested.rules : [];
  const hasTarget = isNonEmptyString(target.service)
    && isNonEmptyString(target.resource)
    && isNonEmptyString(target.action);

  return {
    policyKey,
    activeVersion: typeof suggested.activeVersion === 'number' ? suggested.activeVersion : 1,
    ...(isNonEmptyString(suggested.friendlyName)
      ? { friendlyName: suggested.friendlyName }
      : {}),
    ...(isRecord(suggested.defaults)
      ? { defaults: suggested.defaults as unknown as DraftPolicy['defaults'] }
      : {}),
    // The discovered target is kept rather than dropped: it is the one thing
    // analyze actually learned from the codebase, and a developer writing the
    // first rule should not have to go and find it again. Runtime bundles do
    // not carry it — `build` reads targets from rules — so it stays advisory.
    ...(hasTarget ? { discoveredTarget: target } : {}),
    rules: rules as DraftPolicy['rules'],
  } as DraftPolicy;
};

export interface NormalisedDraft {
  document: DraftDocument;
  shape: DraftShape;
}

/**
 * Accepts either draft shape and returns the build-ready one.
 *
 * Analyze writes `drafts[]`; the authoring workflow persists `policies[]`. Both
 * are legitimate inputs, and normalising here means every subcommand only has
 * to understand one shape.
 */
export const normaliseDraft = (value: unknown, generatedAt: string): NormalisedDraft => {
  if (!isRecord(value)) {
    throw new CliError('The draft file must contain a JSON object.', {
      code: 'INVALID_DRAFT_SCHEMA',
      exitCode: ExitCode.Compatibility,
    });
  }

  const schemaVersion = typeof value.schemaVersion === 'number'
    || typeof value.schemaVersion === 'string'
    ? value.schemaVersion
    : DRAFT_SCHEMA_VERSION;

  const base: DraftDocument = {
    schemaVersion,
    generatedAt: isNonEmptyString(value.generatedAt) ? value.generatedAt : generatedAt,
    ...(isNonEmptyString(value.env) ? { env: value.env } : {}),
    policies: [],
  };

  if (Array.isArray(value.policies)) {
    return {
      document: { ...base, policies: value.policies as DraftPolicy[] },
      shape: 'build-ready',
    };
  }

  if (Array.isArray(value.drafts)) {
    return {
      document: { ...base, policies: value.drafts.map(fromAnalyzeEntry) },
      shape: 'analyze',
    };
  }

  throw new CliError('The draft file must contain a "policies" or "drafts" array.', {
    code: 'INVALID_DRAFT_SCHEMA',
    exitCode: ExitCode.Compatibility,
    details: [
      '',
      'A build-ready draft looks like:',
      '  { "schemaVersion": "1.0", "policies": [] }',
    ],
  });
};

/**
 * Reads a draft file exactly as written, without normalising it.
 *
 * `policies validate` reports on the file the developer actually has, so an
 * analyze document is judged by the analyze rules — the same verdict
 * `govplane validate --type draft` gives it. Normalising first would make the
 * two commands disagree about the same file.
 */
export const readDraftFile = (path: string): unknown => {
  if (!existsSync(path)) {
    throw new CliError(`Draft file not found: ${path}`, {
      code: 'DRAFT_FILE_NOT_FOUND',
      exitCode: ExitCode.FileError,
      details: ['', 'Create one with:', '  govplane policies create-file'],
    });
  }

  const parsed = parseJson(readTextFile(path));
  if (!parsed.ok) {
    throw new CliError(`The draft file is not valid JSON: ${path}`, {
      code: 'INVALID_DRAFT_SCHEMA',
      exitCode: ExitCode.Compatibility,
      details: ['', parsed.message],
    });
  }

  return parsed.value;
};

/** Reads and normalises a draft file into build-ready shape. */
export const loadDraft = (path: string, generatedAt: string): LoadedDraft => {
  if (!existsSync(path)) {
    throw new CliError(`Draft file not found: ${path}`, {
      code: 'DRAFT_FILE_NOT_FOUND',
      exitCode: ExitCode.FileError,
      details: [
        '',
        'Create one with:',
        '  govplane policies create-file',
      ],
    });
  }

  const parsed = parseJson(readTextFile(path));
  if (!parsed.ok) {
    throw new CliError(`The draft file is not valid JSON: ${path}`, {
      code: 'INVALID_DRAFT_SCHEMA',
      exitCode: ExitCode.Compatibility,
      details: ['', parsed.message],
    });
  }

  const { document, shape } = normaliseDraft(parsed.value, generatedAt);
  return { document, path, shape };
};

const VERSION_SUFFIX = /\.v(\d+)\.json$/;

/**
 * Next semantic-suffix filename for a draft file.
 *
 * `policy-drafts.json` → `policy-drafts.v2.json` → `policy-drafts.v3.json`.
 * The unsuffixed file counts as v1, and the highest existing suffix wins, so a
 * gap in the sequence never causes an earlier file to be overwritten.
 */
export const nextVersionedPath = (path: string): string => {
  const directory = dirname(path);
  const name = basename(path);
  const stem = name.replace(VERSION_SUFFIX, '.json').replace(/\.json$/, '');

  if (!existsSync(path) && !existsSync(join(directory, `${stem}.json`))) {
    return join(directory, `${stem}.json`);
  }

  let highest = 1;
  try {
    readdirSync(directory).forEach((entry) => {
      if (!entry.startsWith(`${stem}.v`)) {
        return;
      }
      const match = VERSION_SUFFIX.exec(entry);
      if (match !== null) {
        highest = Math.max(highest, Number.parseInt(match[1] as string, 10));
      }
    });
  } catch {
    // An unreadable directory surfaces on write, with a better message.
  }

  return join(directory, `${stem}.v${highest + 1}.json`);
};

export interface WriteDraftOptions {
  /** Write to the next semantic-suffix file instead of overwriting. */
  versioned?: boolean;
}

export interface WrittenDraft {
  path: string;
  versioned: boolean;
}

/**
 * Persists a draft deterministically and atomically.
 *
 * A failed write must never corrupt a draft a developer has been editing, so
 * content goes to a temporary file, is fsynced, and is then renamed into place.
 */
export const writeDraft = (
  path: string,
  document: DraftDocument,
  options: WriteDraftOptions = {},
): WrittenDraft => {
  const versioned = options.versioned === true;
  const target = versioned ? nextVersionedPath(path) : path;

  try {
    atomicWriteFile(target, stringifyJson(sortDraft(document)));
  } catch (error) {
    throw new CliError(`The draft file could not be written: ${target}`, {
      code: 'DRAFT_WRITE_FAILED',
      exitCode: ExitCode.WriteError,
      cause: error,
    });
  }

  return { path: target, versioned };
};

/** Whether draft versioning is on, from configuration and flag overrides. */
export const resolveVersioning = (
  config: ProjectConfig,
  flags: { versioned?: boolean },
): boolean => flags.versioned ?? config.policies?.versioning?.enabled ?? false;

export const findPolicy = (
  document: DraftDocument,
  policyKey: string,
): DraftPolicy | undefined => document.policies.find((policy) => policy.policyKey === policyKey);
