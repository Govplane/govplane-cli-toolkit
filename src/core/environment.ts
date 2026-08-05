import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_VERSION = '0.0.0';

/**
 * Reads the toolkit version from its own package manifest.
 *
 * Also re-exported as `toolkitVersion`, which is how the CLI reports the
 * installed kit version after discovering this package.
 */
export const readToolkitVersion = (): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // `src/core` in development, `dist/core` once compiled.
    const manifest = JSON.parse(
      readFileSync(join(here, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
};

/** The installed toolkit version, read once at module load. */
export const toolkitVersion = readToolkitVersion();
