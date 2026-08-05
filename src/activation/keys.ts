import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Public keys that verify activation licences, indexed by `signature.keyId`.
 *
 * Keys are shipped with the package so verification is entirely local. Several
 * may be valid at once: rotation adds a new key while previously issued licences
 * continue to verify against the old one.
 *
 * `GOVPLANE_LICENSE_PUBLIC_KEY` overrides the set. It exists so the local stub
 * server and the test suite can issue licences with their own key — it is a
 * development affordance, and a user who sets it is only ever trusting a key
 * they chose themselves.
 */
const KEY_DIRECTORY = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // `src/activation` in development, `dist/activation` once compiled.
  return join(here, '..', '..', 'keys');
};

const SHIPPED_KEYS: Record<string, string> = {
  'license-key-01': 'license-key-01.pem',
};

export interface PublicKeyLookup {
  key: string | null;
  /** True when the keyId is not one this build knows about. */
  unknownKeyId: boolean;
}

export const resolvePublicKey = (
  keyId: string,
  env: NodeJS.ProcessEnv = process.env,
): PublicKeyLookup => {
  const override = env.GOVPLANE_LICENSE_PUBLIC_KEY;
  if (override !== undefined && override.trim() !== '') {
    return { key: override, unknownKeyId: false };
  }

  const filename = SHIPPED_KEYS[keyId];
  if (filename === undefined) {
    return { key: null, unknownKeyId: true };
  }

  try {
    return { key: readFileSync(join(KEY_DIRECTORY(), filename), 'utf8'), unknownKeyId: false };
  } catch {
    return { key: null, unknownKeyId: false };
  }
};

export const knownKeyIds = (): string[] => Object.keys(SHIPPED_KEYS);
