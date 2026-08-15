/**
 * Activation model.
 *
 * See `specs/cli-toolkit/cli_toolkit_activation_spec.md`, which this module
 * implements. The licence is a signed document the user holds; it is verified
 * locally and is never exchanged with a server at use time.
 */

export const LICENSE_SCHEMA_VERSION = 1;
export const FREE_PLAN = 'toolkit-free';

export interface LicenseSignature {
  algorithm: string;
  keyId: string;
  value: string;
}

export interface License {
  schemaVersion: number;
  licenseId: string;
  /**
   * Absent when the licence was issued without an email address.
   *
   * Giving one is optional, so a licence may have no subject at all. When there is none
   * the key is missing entirely rather than empty — which matters, because the signature
   * covers the canonical bytes and `{"subject":{}}` is a different document.
   */
  subject?: { email: string };
  plan: string;
  issuedAt: string;
  /** Advisory only — a passed `renewAfter` nudges, it never blocks. */
  renewAfter?: string;
  terms: { version: string; acceptedAt: string };
  marketingConsent: boolean;
  signature: LicenseSignature;
}

/** Where the active licence was read from. */
export type LicenseSource = 'environment' | 'environment-file' | 'file';

export type LicenseProblem =
  | 'LICENSE_NOT_FOUND'
  | 'LICENSE_INVALID_JSON'
  | 'LICENSE_INVALID_SCHEMA'
  | 'LICENSE_SIGNATURE_INVALID'
  | 'LICENSE_UNKNOWN_KEY'
  | 'LICENSE_UNSUPPORTED';

export interface LicenseLoaded {
  ok: true;
  license: License;
  source: LicenseSource;
  path: string | null;
}

export interface LicenseRejected {
  ok: false;
  problem: LicenseProblem;
  reason: string;
  source: LicenseSource | null;
  path: string | null;
}

export type LicenseResult = LicenseLoaded | LicenseRejected;

/**
 * Activation state resolved before every CLI Toolkit command.
 *
 * `invalid` never stands alone: a licence that cannot be used is reported
 * alongside the grace state, so a corrupted file never leaves a user without a
 * path forward.
 */
export type ActivationState = 'activated' | 'grace' | 'grace_expired';

export interface ActivationStatus {
  state: ActivationState;
  /** Days left in the grace period; `0` once it has run out. */
  daysRemaining: number;
  /** Whole days since the toolkit was first used. */
  daysElapsed: number;
  license: License | null;
  source: LicenseSource | null;
  /** Set when a licence was present but could not be used. */
  problem?: LicenseProblem;
  problemReason?: string;
  /** True once `renewAfter` has passed on an otherwise valid licence. */
  renewalDue: boolean;
}
