import { createHmac, createSign, createPrivateKey } from 'node:crypto';
import { basename, resolve } from 'node:path';
import {
  canonicalPayload, CliError, ExitCode, readTextFile, type RuntimeBundle,
} from '@govplane/cli';

/**
 * Local bundle signing.
 *
 * Two rules govern everything here:
 *
 *   1. The signed bytes are the canonical payload — the same preimage the
 *      checksum covers — so a verifier that can check one can check the other.
 *   2. No secret, private key, or fragment of either ever reaches an output
 *      stream. Errors name the *source* of a key, never its contents.
 */

export const SIGNING_ALGORITHMS = ['HMAC_SHA256', 'ECDSA_SHA_256'] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

export const DEFAULT_KEY_ID = 'local-key-01';

/** A 256-bit secret, as 64 hexadecimal characters. */
const HEX_SECRET = /^[0-9a-fA-F]{64}$/;

export interface SigningInput {
  algorithm: SigningAlgorithm;
  keyId: string;
  /** Where the key came from, for error messages. Never the key itself. */
  keySource: string;
  hmacSecret?: string | undefined;
  ecdsaPrivateKeyPath?: string | undefined;
}

export interface BundleSignature {
  algorithm: SigningAlgorithm;
  keyId: string;
  value: string;
}

const signingFailed = (message: string, details?: string[]): CliError => new CliError(
  message,
  { code: 'SIGNING_FAILED', exitCode: ExitCode.InternalError, details },
);

const signHmac = (payload: Buffer, input: SigningInput): string => {
  const secret = input.hmacSecret;

  if (secret === undefined || secret.trim() === '') {
    throw signingFailed(`Signing failed for key source ${input.keySource}.`, [
      '',
      'Reason: no secret was provided.',
    ]);
  }

  const trimmed = secret.trim();
  if (!HEX_SECRET.test(trimmed)) {
    // The length is safe to report; the value is not. A secret of the right
    // length that simply is not hex is a different mistake from a short one,
    // and saying "invalid hex length" for it would send the reader hunting for
    // a length problem that does not exist.
    const reason = trimmed.length === 64
      ? 'the secret is 64 characters but is not hexadecimal'
      : `invalid hex length (expected 64 hexadecimal characters, got ${trimmed.length})`;

    throw signingFailed(`Signing failed for key source ${input.keySource}.`, [
      '',
      `Reason: ${reason}.`,
    ]);
  }

  return createHmac('sha256', Buffer.from(trimmed, 'hex'))
    .update(payload)
    .digest('hex');
};

const signEcdsa = (payload: Buffer, input: SigningInput): string => {
  const path = input.ecdsaPrivateKeyPath;
  if (path === undefined || path.trim() === '') {
    throw signingFailed(`Signing failed for key source ${input.keySource}.`, [
      '',
      'Reason: no private key path was provided.',
    ]);
  }

  let pem: string;
  try {
    pem = readTextFile(path);
  } catch {
    throw signingFailed(`Signing failed for key source ${input.keySource}.`, [
      '',
      'Reason: the private key file could not be read.',
    ]);
  }

  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    // Deliberately not forwarding the underlying error: OpenSSL messages can
    // quote parts of the key material they failed to parse.
    throw signingFailed(`Signing failed for key source ${input.keySource}.`, [
      '',
      'Reason: the private key could not be parsed. An unencrypted PEM key is expected.',
    ]);
  }

  if (key.asymmetricKeyType !== 'ec') {
    throw signingFailed(`Signing failed for key source ${input.keySource}.`, [
      '',
      `Reason: ECDSA_SHA_256 needs an EC private key, but this key is ${key.asymmetricKeyType ?? 'of an unknown type'}.`,
    ]);
  }

  try {
    const signer = createSign('sha256');
    signer.update(payload);
    signer.end();
    return signer.sign(key).toString('base64');
  } catch {
    throw signingFailed(`Signing failed for key source ${input.keySource}.`, [
      '',
      'Reason: the signature could not be produced.',
    ]);
  }
};

/** Signs the canonical payload of a bundle. */
export const signBundle = (bundle: RuntimeBundle, input: SigningInput): BundleSignature => {
  const payload = canonicalPayload(bundle);

  const value = input.algorithm === 'HMAC_SHA256'
    ? signHmac(payload, input)
    : signEcdsa(payload, input);

  return { algorithm: input.algorithm, keyId: input.keyId, value };
};

export interface SigningConfig {
  algorithm?: string;
  keyId?: string;
  hmacSecretEnv?: string;
  ecdsaPrivateKeyPath?: string;
}

export interface SigningFlags {
  algorithm?: string | undefined;
  keyId?: string | undefined;
  hmacSecret?: string | undefined;
  hmacSecretEnv?: string | undefined;
  ecdsaPrivateKey?: string | undefined;
}

export interface ResolveSigningOptions {
  /**
   * Which configuration block the settings came from, so error messages point
   * at the right key.
   */
  section?: 'build' | 'sign';
  /**
   * How to fill `keyId` when neither the flag nor the configuration supplies
   * one.
   *
   * `default` uses a constant, which suits `build`: the key is chosen up front
   * and named in configuration. `source` derives it from where the key came
   * from — the environment variable for HMAC, the key filename for ECDSA —
   * which suits `sign`, where the identifier is more useful as provenance than
   * as a fixed label.
   */
  keyIdFrom?: 'default' | 'source';
  /** Whether an algorithm must be stated explicitly rather than defaulted. */
  requireAlgorithm?: boolean;
}

/**
 * Resolves signing material from flags, configuration and the environment.
 *
 * Secret precedence is `--hmac-secret`, then `--hmac-secret-env`, then the
 * configured environment variable. The direct flag is supported because the
 * specification calls for it, but it puts a secret in the process arguments and
 * the shell history, so the documentation steers people to the env forms.
 */
export const resolveSigning = (
  flags: SigningFlags,
  config: SigningConfig,
  env: NodeJS.ProcessEnv,
  workingFolder: string,
  options: ResolveSigningOptions = {},
): SigningInput => {
  const section = options.section ?? 'build';
  const stated = flags.algorithm ?? config.algorithm;

  if (stated === undefined && options.requireAlgorithm === true) {
    throw new CliError('No signing algorithm was specified.', {
      code: 'SIGNING_ALGORITHM_MISSING',
      exitCode: ExitCode.InvalidArguments,
      details: [
        '',
        `Supply one with --signing-algorithm <${SIGNING_ALGORITHMS.join('|')}>,`,
        `or set ${section}.signing.algorithm in govplane.config.json.`,
      ],
    });
  }

  const algorithm = (stated ?? 'HMAC_SHA256') as SigningAlgorithm;

  if (!(SIGNING_ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new CliError(`Unsupported signing algorithm: ${algorithm}`, {
      code: 'SIGNING_FAILED',
      exitCode: ExitCode.InternalError,
      details: ['', `Supported algorithms: ${SIGNING_ALGORITHMS.join(', ')}`],
    });
  }

  const statedKeyId = flags.keyId ?? config.keyId;
  const deriveKeyId = options.keyIdFrom === 'source';

  if (algorithm === 'HMAC_SHA256') {
    if (flags.hmacSecret !== undefined) {
      if (statedKeyId === undefined && deriveKeyId) {
        // A secret passed inline has no name worth recording, and inventing one
        // would put a false provenance claim inside the signature.
        throw new CliError('A key identifier is required when the secret is passed inline.', {
          code: 'SIGNING_KEY_ID_REQUIRED',
          exitCode: ExitCode.InvalidArguments,
          details: [
            '',
            'Supply one with --signing-key-id <value>, or pass the secret through',
            'an environment variable with --hmac-secret-env <VAR>, whose name is',
            'then recorded as the key identifier.',
          ],
        });
      }
      return {
        algorithm,
        keyId: statedKeyId ?? DEFAULT_KEY_ID,
        keySource: '--hmac-secret',
        hmacSecret: flags.hmacSecret,
      };
    }

    const variable = flags.hmacSecretEnv ?? config.hmacSecretEnv;
    if (variable === undefined) {
      throw signingFailed('Signing failed: no HMAC secret was configured.', [
        '',
        `Supply one with --hmac-secret-env <VAR>, or set ${section}.signing.hmacSecretEnv`,
        'in govplane.config.json.',
      ]);
    }

    const secret = env[variable];
    if (secret === undefined || secret === '') {
      throw signingFailed(`Signing failed for key source ${variable}.`, [
        '',
        'Reason: the environment variable is not set.',
      ]);
    }

    return {
      algorithm,
      keyId: statedKeyId ?? (deriveKeyId ? variable : DEFAULT_KEY_ID),
      keySource: variable,
      hmacSecret: secret,
    };
  }

  const configured = flags.ecdsaPrivateKey ?? config.ecdsaPrivateKeyPath;
  if (configured === undefined) {
    throw signingFailed('Signing failed: no ECDSA private key was configured.', [
      '',
      'Supply one with --ecdsa-private-key <path>, or set',
      `${section}.signing.ecdsaPrivateKeyPath in govplane.config.json.`,
    ]);
  }

  const path = resolve(workingFolder, configured);
  return {
    algorithm,
    keyId: statedKeyId ?? (deriveKeyId ? basename(path) : DEFAULT_KEY_ID),
    keySource: path,
    ecdsaPrivateKeyPath: path,
  };
};
