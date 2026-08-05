import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  atomicWriteFile, CliError, ExitCode, fileTimestamp, parseJson, readTextFile, stringifyJson,
  type ProjectConfig,
} from '@govplane/cli';

export const DEFAULT_BUNDLE_FILE = 'policy-bundle.json';

export interface BuildConfig {
  env?: string;
  outputDirectory?: string;
  signed?: boolean;
  validateParity?: boolean;
  bundleVersionStrategy?: string;
  scope?: { orgId?: string | null; projectId?: string | null };
  signing?: {
    algorithm?: string;
    keyId?: string;
    hmacSecretEnv?: string;
    ecdsaPrivateKeyPath?: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Reads the `build` block from the project configuration.
 *
 * The CLI's configuration loader normalises only the fields the basic commands
 * use, so the toolkit reads its own section from the raw file.
 */
export const readBuildConfig = (configPath: string | null): BuildConfig => {
  if (configPath === null || !existsSync(configPath)) {
    return {};
  }

  const parsed = parseJson(readTextFile(configPath));
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.build)) {
    return {};
  }

  const {build} = parsed.value;
  const scope = isRecord(build.scope) ? build.scope : {};
  const signing = isRecord(build.signing) ? build.signing : {};

  const readString = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim() !== '' ? value : undefined
  );

  return {
    ...(readString(build.env) === undefined ? {} : { env: readString(build.env) }),
    ...(readString(build.outputDirectory) === undefined
      ? {}
      : { outputDirectory: readString(build.outputDirectory) }),
    ...(typeof build.signed === 'boolean' ? { signed: build.signed } : {}),
    ...(typeof build.validateParity === 'boolean'
      ? { validateParity: build.validateParity }
      : {}),
    ...(readString(build.bundleVersionStrategy) === undefined
      ? {}
      : { bundleVersionStrategy: readString(build.bundleVersionStrategy) }),
    scope: {
      ...(readString(scope.orgId) === undefined
        ? {}
        : { orgId: readString(scope.orgId) as string }),
      ...(readString(scope.projectId) === undefined
        ? {}
        : { projectId: readString(scope.projectId) as string }),
    },
    signing: {
      ...(readString(signing.algorithm) === undefined
        ? {}
        : { algorithm: readString(signing.algorithm) as string }),
      ...(readString(signing.keyId) === undefined
        ? {}
        : { keyId: readString(signing.keyId) as string }),
      ...(readString(signing.hmacSecretEnv) === undefined
        ? {}
        : { hmacSecretEnv: readString(signing.hmacSecretEnv) as string }),
      ...(readString(signing.ecdsaPrivateKeyPath) === undefined
        ? {}
        : { ecdsaPrivateKeyPath: readString(signing.ecdsaPrivateKeyPath) as string }),
    },
  };
};

/**
 * Resolves where the bundle should be written.
 *
 *   1. `--output <path>`
 *   2. `bundle.path` from the configuration, placed inside
 *      `build.outputDirectory` when one is configured
 *   3. `policy-bundle.json` in the working folder
 */
export const resolveOutputPath = (
  workingFolder: string,
  config: ProjectConfig,
  build: BuildConfig,
  explicit?: string,
): string => {
  if (explicit !== undefined) {
    return resolve(workingFolder, explicit);
  }

  const configured = config.bundle?.path ?? DEFAULT_BUNDLE_FILE;
  if (build.outputDirectory === undefined) {
    return resolve(workingFolder, configured);
  }

  return resolve(workingFolder, build.outputDirectory, basename(configured));
};

export interface ResolvedOutput {
  /** Where the bundle was asked to go. */
  requestedPath: string;
  /** Where it will actually be written. */
  path: string;
  /** True when the requested path was taken and a timestamped name was used. */
  timestamped: boolean;
}

/**
 * Never overwrites an existing bundle.
 *
 * A bundle may already be deployed, referenced by a signature, or pinned by a
 * checksum somewhere. Writing beside it and reporting both paths is recoverable;
 * overwriting it is not.
 */
export const resolveWritePath = (requestedPath: string, generatedAt: Date): ResolvedOutput => {
  if (!existsSync(requestedPath)) {
    return { requestedPath, path: requestedPath, timestamped: false };
  }

  const name = basename(requestedPath).replace(/\.json$/, '');
  const stamped = `${name}.${fileTimestamp(generatedAt)}.json`;

  return {
    requestedPath,
    path: join(dirname(requestedPath), stamped),
    timestamped: true,
  };
};

export interface BundleScope {
  orgId?: string | undefined;
  projectId?: string | undefined;
  env: string;
}

/**
 * Every bundle previously written for this output path.
 *
 * Build never overwrites, so the family is the requested file plus the
 * timestamped siblings written next to it: `policy-bundle.json` alongside
 * `policy-bundle.2026-07-30T15-22-31Z.json`.
 */
export const bundleFamily = (requestedPath: string): string[] => {
  const directory = dirname(requestedPath);
  const stem = basename(requestedPath).replace(/\.json$/, '');
  const sibling = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\..+)?\\.json$`);

  try {
    return readdirSync(directory)
      .filter((name) => sibling.test(name))
      .map((name) => join(directory, name));
  } catch {
    return existsSync(requestedPath) ? [requestedPath] : [];
  }
};

const sameScope = (bundle: Record<string, unknown>, scope: BundleScope): boolean => {
  const orgId = typeof bundle.orgId === 'string' ? bundle.orgId : undefined;
  const projectId = typeof bundle.projectId === 'string' ? bundle.projectId : undefined;
  return orgId === scope.orgId && projectId === scope.projectId && bundle.env === scope.env;
};

/**
 * Resolves the next `bundleVersion`.
 *
 * A monotonically increasing revision counter per scope, mirroring how the
 * control plane numbers materialised bundles (`currentVersion + 1` for a given
 * org, project and env). Keeping the two in step means a locally built bundle
 * stays comparable to a remotely materialised one.
 *
 * The highest version across the whole output family is used, not the one at
 * the requested path: since build never overwrites, the newest revision is
 * normally a timestamped sibling, and reading only the requested path would
 * hand out the same number on every build after the first.
 */
export const resolveBundleVersion = (requestedPath: string, scope: BundleScope): number => {
  const highest = bundleFamily(requestedPath).reduce((current, path) => {
    try {
      const parsed = parseJson(readTextFile(path));
      if (!parsed.ok || !isRecord(parsed.value) || !sameScope(parsed.value, scope)) {
        return current;
      }
      const version = parsed.value.bundleVersion;
      return typeof version === 'number' && Number.isFinite(version) && version >= 1
        ? Math.max(current, Math.floor(version))
        : current;
    } catch {
      // An unreadable or malformed neighbour is skipped: it should not stop a
      // build, and it cannot be the revision we are continuing from.
      return current;
    }
  }, 0);

  return highest + 1;
};

export const writeBundle = (path: string, bundle: unknown): void => {
  try {
    atomicWriteFile(path, stringifyJson(bundle));
  } catch (error) {
    throw new CliError(`The bundle could not be written: ${path}`, {
      code: 'OUTPUT_WRITE_FAILED',
      exitCode: ExitCode.WriteError,
      cause: error,
    });
  }
};

export interface BuildReport {
  cliVersion: string;
  builtAt: string;
  input: { draftPath: string };
  output: {
    requestedPath: string;
    bundlePath: string;
    schemaVersion: number;
    env: string;
    bundleVersion: number;
    checksum: string;
    etag: string;
  };
  validation: { errors: number; warnings: number };
  signing: { signed: boolean; algorithm?: string; keyId?: string };
  stats: { policies: number; rules: number };
}

export const reportPath = (
  workingFolder: string,
  generatedAt: Date,
  explicit?: string,
): string => (
  explicit === undefined
    ? join(workingFolder, '.govplane', 'reports', `build-${fileTimestamp(generatedAt)}.json`)
    : resolve(workingFolder, explicit)
);

export const writeReport = (path: string, report: BuildReport): void => {
  try {
    atomicWriteFile(path, stringifyJson(report));
  } catch (error) {
    throw new CliError(`The build report could not be written: ${path}`, {
      code: 'REPORT_WRITE_FAILED',
      exitCode: ExitCode.WriteError,
      cause: error,
    });
  }
};
