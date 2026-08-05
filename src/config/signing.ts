import { existsSync } from 'node:fs';
import { parseJson, readTextFile } from '@govplane/cli';
import type { SigningConfig } from '../build/signing.js';

/**
 * Signing configuration, read from the section that owns it.
 *
 * `build` and `sign` keep independent blocks — `build.signing` and
 * `sign.signing` — so a project can, for instance, build unsigned in
 * development and sign with a different key in a release pipeline.
 */
export type SigningSection = 'build' | 'sign';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() !== '' ? value : undefined
);

export const readSigningConfig = (
  configPath: string | null,
  section: SigningSection,
): SigningConfig => {
  if (configPath === null || !existsSync(configPath)) {
    return {};
  }

  const parsed = parseJson(readTextFile(configPath));
  if (!parsed.ok || !isRecord(parsed.value)) {
    return {};
  }

  const block = parsed.value[section];
  if (!isRecord(block) || !isRecord(block.signing)) {
    return {};
  }

  const { signing } = block;
  return {
    ...(readString(signing.algorithm) === undefined
      ? {}
      : { algorithm: readString(signing.algorithm) }),
    ...(readString(signing.keyId) === undefined
      ? {}
      : { keyId: readString(signing.keyId) }),
    ...(readString(signing.hmacSecretEnv) === undefined
      ? {}
      : { hmacSecretEnv: readString(signing.hmacSecretEnv) }),
    ...(readString(signing.ecdsaPrivateKeyPath) === undefined
      ? {}
      : { ecdsaPrivateKeyPath: readString(signing.ecdsaPrivateKeyPath) }),
  };
};

/**
 * The signing configuration to *verify* against.
 *
 * Verification is not signing: it does not care which step produced the
 * signature, only how the project signs at all. A project that builds signed
 * and never runs `sign` still has key material pinned — reading `sign.signing`
 * alone would find nothing there and skip verification silently, which is the
 * one outcome a verifier must never produce quietly.
 *
 * `sign.signing` wins where both define a field: in a split pipeline it
 * describes the key the artifact was last signed with.
 */
export const readVerificationConfig = (configPath: string | null): SigningConfig => ({
  ...readSigningConfig(configPath, 'build'),
  ...readSigningConfig(configPath, 'sign'),
});
