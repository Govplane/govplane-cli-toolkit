import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteFile, canonicalDocument, inspectSignature, parseJson, readTextFile,
  resolveGovplaneHome, stringifyJson,
} from '@govplane/cli';
import { resolvePublicKey } from './keys.js';
import {
  FREE_PLAN, LICENSE_SCHEMA_VERSION,
  type License, type LicenseResult, type LicenseSource,
} from './types.js';

export const LICENSE_FILE = 'license.json';
export const LICENSE_ENV = 'GOVPLANE_LICENSE';
export const LICENSE_FILE_ENV = 'GOVPLANE_LICENSE_FILE';

/** Owner-only permissions: the licence carries the user's email address. */
const LICENSE_MODE = 0o600;

export const licensePath = (env?: NodeJS.ProcessEnv): string => (
  join(resolveGovplaneHome(env), LICENSE_FILE)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);

/** Structural check, run before any signature work. */
const readLicenseShape = (value: unknown): { license: License } | { reason: string } => {
  if (!isRecord(value)) {
    return { reason: 'A licence must be a JSON object.' };
  }
  if (value.schemaVersion !== LICENSE_SCHEMA_VERSION) {
    return { reason: `Unsupported licence schemaVersion: ${String(value.schemaVersion)}` };
  }
  if (!isNonEmptyString(value.licenseId)) {
    return { reason: 'licenseId is required.' };
  }

  // An email address is optional, so a licence may carry no subject at all. What is not
  // allowed is a subject that is present but says nothing: `{}` or a blank address are
  // malformed rather than anonymous, and accepting them would let a truncated licence
  // pass as a deliberate one.
  //
  // Built here rather than at the return so the narrowing survives — and so the shape
  // handed to the canonicaliser is decided in exactly one place.
  const {subject} = value;
  let subjectField: { subject?: { email: string } } = {};
  if (subject !== undefined) {
    if (!isRecord(subject) || !isNonEmptyString(subject.email)) {
      return { reason: 'subject, when present, must carry a non-empty email.' };
    }
    subjectField = { subject: { email: subject.email } };
  }

  if (!isNonEmptyString(value.plan)) {
    return { reason: 'plan is required.' };
  }
  if (!isNonEmptyString(value.issuedAt)) {
    return { reason: 'issuedAt is required.' };
  }

  const {terms} = value;
  if (!isRecord(terms) || !isNonEmptyString(terms.version)
    || !isNonEmptyString(terms.acceptedAt)) {
    return { reason: 'terms.version and terms.acceptedAt are required.' };
  }

  if (typeof value.marketingConsent !== 'boolean') {
    return { reason: 'marketingConsent must be a boolean.' };
  }

  const {signature} = value;
  if (!isRecord(signature) || !isNonEmptyString(signature.algorithm)
    || !isNonEmptyString(signature.keyId) || !isNonEmptyString(signature.value)) {
    return { reason: 'signature.algorithm, signature.keyId and signature.value are required.' };
  }

  // A field this build does not understand means the licence was issued for a
  // newer toolkit. Refusing it is safer than ignoring terms we cannot enforce.
  if (value.expiresAt !== undefined) {
    return { reason: 'This licence carries an expiry, which this version does not support.' };
  }

  return {
    license: {
      schemaVersion: LICENSE_SCHEMA_VERSION,
      licenseId: value.licenseId,
      // Spread, exactly like `renewAfter` below: an absent subject must produce an absent
      // key, because this reconstruction — not the received document — is what gets
      // canonicalised and checked against the signature.
      ...subjectField,
      plan: value.plan,
      issuedAt: value.issuedAt,
      ...(isNonEmptyString(value.renewAfter) ? { renewAfter: value.renewAfter } : {}),
      terms: { version: terms.version, acceptedAt: terms.acceptedAt },
      marketingConsent: value.marketingConsent,
      signature: {
        algorithm: signature.algorithm,
        keyId: signature.keyId,
        value: signature.value,
      },
    },
  };
};

export interface VerifyLicenseOptions {
  env?: NodeJS.ProcessEnv;
  source?: LicenseSource;
  path?: string | null;
}

/**
 * Validates a licence document and verifies its signature over the canonical
 * bytes of the whole document.
 */
export const verifyLicense = (
  document: unknown,
  options: VerifyLicenseOptions = {},
): LicenseResult => {
  const source = options.source ?? 'file';
  const path = options.path ?? null;

  const shape = readLicenseShape(document);
  if ('reason' in shape) {
    return {
      ok: false, problem: 'LICENSE_INVALID_SCHEMA', reason: shape.reason, source, path,
    };
  }

  const { license } = shape;
  const lookup = resolvePublicKey(license.signature.keyId, options.env);

  if (lookup.unknownKeyId) {
    return {
      ok: false,
      problem: 'LICENSE_UNKNOWN_KEY',
      reason: `This licence was signed with key "${license.signature.keyId}", which this `
        + 'version does not recognise. Update the toolkit with: '
        + 'npm install --global @govplane/cli-toolkit@latest',
      source,
      path,
    };
  }

  if (lookup.key === null) {
    return {
      ok: false,
      problem: 'LICENSE_UNSUPPORTED',
      reason: 'The verification key shipped with this installation could not be read.',
      source,
      path,
    };
  }

  const inspection = inspectSignature({
    bundle: license,
    publicKey: lookup.key,
    canonicalise: canonicalDocument,
  });

  if (inspection.status !== 'valid') {
    return {
      ok: false,
      problem: 'LICENSE_SIGNATURE_INVALID',
      reason: inspection.reason
        ?? 'The licence signature does not match its contents. The file may have been edited.',
      source,
      path,
    };
  }

  return {
    ok: true, license, source, path,
  };
};

const parseLicenseText = (
  text: string,
  source: LicenseSource,
  path: string | null,
  env?: NodeJS.ProcessEnv,
): LicenseResult => {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return {
      ok: false, problem: 'LICENSE_INVALID_JSON', reason: parsed.message, source, path,
    };
  }
  return verifyLicense(parsed.value, { source, path, ...(env === undefined ? {} : { env }) });
};

/**
 * Loads the active licence.
 *
 * Resolution order — environment first, so CI supplies a licence without an
 * interactive step and without writing to the build agent's home directory:
 *
 *   1. `GOVPLANE_LICENSE`       (inline JSON)
 *   2. `GOVPLANE_LICENSE_FILE`  (path)
 *   3. `$GOVPLANE_HOME/license.json`
 */
export const loadLicense = (env: NodeJS.ProcessEnv = process.env): LicenseResult => {
  const inline = env[LICENSE_ENV];
  if (inline !== undefined && inline.trim() !== '') {
    return parseLicenseText(inline, 'environment', null, env);
  }

  const fromFileEnv = env[LICENSE_FILE_ENV];
  if (fromFileEnv !== undefined && fromFileEnv.trim() !== '') {
    if (!existsSync(fromFileEnv)) {
      return {
        ok: false,
        problem: 'LICENSE_NOT_FOUND',
        reason: `${LICENSE_FILE_ENV} points at a file that does not exist: ${fromFileEnv}`,
        source: 'environment-file',
        path: fromFileEnv,
      };
    }
    return parseLicenseText(readTextFile(fromFileEnv), 'environment-file', fromFileEnv, env);
  }

  const path = licensePath(env);
  if (!existsSync(path)) {
    return {
      ok: false,
      problem: 'LICENSE_NOT_FOUND',
      reason: 'No licence is installed on this machine.',
      source: null,
      path,
    };
  }

  return parseLicenseText(readTextFile(path), 'file', path, env);
};

/** Writes a verified licence to the user's Govplane directory. */
export const storeLicense = (license: License, env?: NodeJS.ProcessEnv): string => {
  const path = licensePath(env);
  atomicWriteFile(path, stringifyJson(license));
  chmodSync(path, LICENSE_MODE);
  return path;
};

/** Removes the local licence. Returns `false` when there was nothing to remove. */
export const removeLicense = (env?: NodeJS.ProcessEnv): boolean => {
  const path = licensePath(env);
  if (!existsSync(path)) {
    return false;
  }
  unlinkSync(path);
  return true;
};

export const isFreePlan = (license: License): boolean => license.plan === FREE_PLAN;
