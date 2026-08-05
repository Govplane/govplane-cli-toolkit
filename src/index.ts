/**
 * Public API of `@govplane/cli-toolkit` — the Govplane CLI Toolkit.
 *
 * `commands` is the contract with the basic CLI: `@govplane/cli` imports this
 * module by name at startup and merges the exported commands into its registry.
 */
export { commands } from './commands/registry.js';
export { toolkitVersion } from './core/environment.js';
export { activateCommand } from './commands/activate.js';
export { licenseCommand } from './commands/license.js';

export { run, main, type ToolkitRunOptions } from './toolkit.js';

export {
  requireActivation, reportActivation, activationSummary,
} from './activation/guard.js';
export {
  resolveActivation, anchorFirstUse, isContinuousIntegration, statePath,
  GRACE_DAYS, type ToolkitState,
} from './activation/grace.js';
export {
  loadLicense, storeLicense, removeLicense, verifyLicense, licensePath, isFreePlan,
  LICENSE_ENV, LICENSE_FILE_ENV, LICENSE_FILE,
} from './activation/license.js';
export { resolvePublicKey, knownKeyIds } from './activation/keys.js';
export {
  startDeviceActivation, pollForLicense, openBrowser,
  type DeviceStart, type PollOutcome, type StartOutcome, type DeviceFlowDeps,
} from './activation/deviceFlow.js';
export {
  ACCOUNT_URL, activationRequired, graceNotice, graceReminder, NOTICE_THRESHOLD_DAYS,
} from './activation/messages.js';
export type {
  License, LicenseResult, LicenseSource, LicenseProblem, ActivationState, ActivationStatus,
} from './activation/types.js';

export {
  resolveApiUrl, postJson, DEFAULT_API_URL, API_URL_ENV, type FetchLike,
} from './http/client.js';
export { readToolkitVersion } from './core/environment.js';
