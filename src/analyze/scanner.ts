import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Source discovery.
 *
 * Walks the `--source` tree and returns the files worth parsing, in a stable
 * order. Order matters: the spec requires repeated runs over the same source to
 * produce the same draft, and sorted input is the cheapest way to guarantee it.
 */

export const SOURCE_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
];

/**
 * Directories skipped by default.
 *
 * Dependencies and build output contain `evaluate()` calls that belong to
 * somebody else's code, and reporting them as this project's policy surface
 * would be actively misleading.
 */
export const DEFAULT_EXCLUDED = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.output', '.cache', '.turbo', '.parcel-cache',
  'vendor', '__pycache__', '.venv', '.govplane',
];

/** Files above this size are skipped: they are bundles or generated data, not source. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** A directory tree deeper than this is a symlink cycle or a mistake. */
const MAX_DEPTH = 24;

/**
 * Compiles one exclude pattern into a matcher.
 *
 * Supports `*` (within a path segment) and `**` (across segments). A bare name
 * such as `fixtures` matches any path segment, which is what a user means when
 * they write it.
 */
const compilePattern = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, ' ')
    .replace(/\*/gu, '[^/]*')
    .replace(/ /gu, '.*');
  return new RegExp(`^${escaped}$`, 'u');
};

export type ExcludeMatcher = (relativePath: string) => boolean;

export const createExcludeMatcher = (patterns: string[]): ExcludeMatcher => {
  const plain = new Set(patterns.filter(
    (pattern) => !pattern.includes('*') && !pattern.includes('/'),
  ));
  const compiled = patterns
    .filter((pattern) => pattern.includes('*') || pattern.includes('/'))
    .map(compilePattern);

  return (relativePath: string): boolean => {
    const posix = relativePath.split(sep).join('/');
    const segments = posix.split('/');

    if (segments.some((segment) => plain.has(segment))) {
      return true;
    }
    return compiled.some((expression) => (
      expression.test(posix) || expression.test(segments[segments.length - 1] as string)
    ));
  };
};

export interface ScanOptions {
  /** Additional exclude patterns, on top of `DEFAULT_EXCLUDED`. */
  exclude?: string[];
  /** Replaces the default exclusions entirely. Used by tests. */
  excludeDefaults?: boolean;
}

export interface ScanResult {
  /** Absolute paths, sorted, so analysis is reproducible. */
  files: string[];
  /** Files skipped for being too large to be hand-written source. */
  skipped: string[];
}

const hasSourceExtension = (name: string): boolean => (
  SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension))
);

/**
 * Collects the source files under `root`.
 *
 * Symlinked directories are not followed. A tree can link to its own parent,
 * and an analyzer that walks forever is worse than one that misses a file.
 */
export const collectSourceFiles = (root: string, options: ScanOptions = {}): ScanResult => {
  const excluded = createExcludeMatcher([
    ...(options.excludeDefaults === false ? [] : DEFAULT_EXCLUDED),
    ...(options.exclude ?? []),
  ]);

  const files: string[] = [];
  const skipped: string[] = [];

  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped, not fatal: a source tree may
      // legitimately contain something this process cannot open.
      return;
    }

    entries
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach((entry) => {
        const full = join(directory, entry.name);
        const relativePath = relative(root, full);

        if (excluded(relativePath)) {
          return;
        }
        if (entry.isSymbolicLink()) {
          return;
        }
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          return;
        }
        if (!entry.isFile() || !hasSourceExtension(entry.name)) {
          return;
        }

        try {
          if (statSync(full).size > MAX_FILE_BYTES) {
            skipped.push(full);
            return;
          }
        } catch {
          return;
        }

        files.push(full);
      });
  };

  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return { files, skipped };
  }

  if (rootStat.isFile()) {
    if (hasSourceExtension(root)) {
      files.push(root);
    }
    return { files, skipped };
  }

  walk(root, 0);

  return { files: files.sort((left, right) => left.localeCompare(right)), skipped };
};
